import API from "./api";
/**
 * Punch in / out, retrying when the failure was the network's fault.
 *
 * A punch that fails is expensive: the person is standing there, and a lost
 * punch-out has to be repaired by HR afterwards. But retrying blindly is worse
 * than not retrying, so this only retries what is actually worth retrying.
 *
 *  - 5xx / no response at all  → retry. The request never reached the app, or
 *    the app died before answering (a Cloudflare 520 is this case: the origin
 *    sent nothing the proxy could parse).
 *  - 4xx → do NOT retry. The backend understood the request and rejected it —
 *    no punch-in today, already punched out, no face detected. Repeating it
 *    just makes the person wait for the same answer.
 *
 * The subtle case is a request that DID land while its response was lost. The
 * retry then comes back "Already punched out today", which looks like a failure
 * but means the punch is safely recorded. That is reported as success, because
 * to the person standing there it worked.
 */
const RETRYABLE_ATTEMPTS = 2;          // 3 tries total
const BACKOFF_MS = [800, 2200];
// Matches the backend's duplicate-punch rejections in routes/attendance.py:
// "Already punched in today" / "Already punched out today".
const ALREADY_DONE = /already punched (in|out)/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function punchWithRetry(type, payload, { attempts = RETRYABLE_ATTEMPTS } = {}) {
  const endpoint = type === "in" ? "/attendance/punch-in" : "/attendance/punch-out";
  let lastMessage = "Punch failed";
  for (let attempt = 0; attempt <= attempts; attempt++) {
    try {
      const res = await API.post(endpoint, payload);
      return { success: true, ...res.data, retried: attempt > 0 };
    } catch (e) {
      const status = e.response?.status;
      const detail = e.response?.data?.detail;
      if (status && status >= 400 && status < 500) {
        // Only treat "already done" as success on a RETRY. On the first attempt
        // it means the person genuinely already punched, and telling them it
        // just worked would be a lie.
        if (attempt > 0 && ALREADY_DONE.test(String(detail || ""))) {
          return {
            success: true,
            recovered: true,
            message: type === "in"
              ? "Punched in. (The first attempt did go through — the connection dropped before it could tell you.)"
              : "Punched out. (The first attempt did go through — the connection dropped before it could tell you.)",
          };
        }
        return { success: false, message: detail || "Punch failed" };
      }
      // 5xx, or no response at all. `detail` is usually absent here — the body
      // is the proxy's HTML error page, not our JSON — so don't surface it.
      lastMessage = status
        ? `Server error (${status}). Please try again.`
        : "Could not reach the server. Check your connection and try again.";
      if (attempt < attempts) await sleep(BACKOFF_MS[attempt] ?? 2200);
    }
  }
  return { success: false, message: lastMessage, exhausted: true };
}
