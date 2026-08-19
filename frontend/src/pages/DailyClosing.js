import React, { useCallback, useEffect, useRef, useState } from "react";
import API from "../utils/api";
import { useAuth } from "../contexts/AuthContext";
import ClosingDesktop from "../components/closing/ClosingDesktop";
import ClosingMobile from "../components/closing/ClosingMobile";

/**
 * Daily cash closing.
 *
 * Splits by VIEWPORT WIDTH, not by native-vs-browser. Head Office opening this
 * on a phone wants the phone layout, and a Branch Manager who happens to be at a
 * desktop wants the table — the deciding factor is the screen, not the wrapper.
 *
 * FETCHING IS ON DEMAND, NOT ON A CLOCK.
 *
 * Nothing here polls the MIS on a schedule. A fetch happens because somebody
 * opened this screen or pressed Submit — the two moments when a stale figure
 * actually costs something. A Cloudflare Worker does the fetching (this server
 * has no route to the MIS at all), so "refresh" means recording that a pull is
 * wanted; the Worker collects it on a short heartbeat and posts the workbook
 * back. Worst case is about a minute.
 *
 * The floor is global and lives on the server: five managers tapping at 21:00
 * is one fetch, not five, and the vendor sees a handful of requests an evening
 * rather than ninety-eight a day.
 */

const MOBILE_Q = "(max-width: 767px)";

function useIsMobile() {
  const [m, setM] = useState(
    () => typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia(MOBILE_Q).matches
      : false
  );
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(MOBILE_Q);
    const on = (e) => setM(e.matches);
    // Safari before 14 has no addEventListener on MediaQueryList, and some of
    // the handsets in the field are old enough to matter.
    if (mq.addEventListener) mq.addEventListener("change", on);
    else mq.addListener(on);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", on);
      else mq.removeListener(on);
    };
  }, []);
  return m;
}

/** Today in IST, as YYYY-MM-DD — the basis the backend files collections under. */
function todayIST() {
  const s = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  return s; // en-CA gives ISO order
}

/**
 * A report that momentarily loses a branch must not blank the screen.
 *
 * The deposit panel unmounts when its branch disappears from the payload, and
 * everything typed into it — the counted cash, a slip amount mid-keystroke, the
 * hold reason — goes with it. That was survivable while the page fetched twice an
 * evening. It is not now: the panel polls every four seconds while a slip is
 * being read, so every one of those is a chance for the MIS report to be a branch
 * short, which `check_expected_branches` exists because it happens.
 *
 * So: if a day that HAD branches comes back with none, keep what we had and say
 * so. A genuinely empty day — a Sunday, a holiday — has nothing to keep and shows
 * empty as before.
 */
function keepBranches(prev, next, date, setNotice) {
  const had = (prev?.branches || []).length;
  const now = (next?.branches || []).length;
  if (prev?.date === date && had > 0 && now === 0) {
    setNotice("The last check came back with no branches at all, so these figures "
              + "are the ones from a moment ago. Press Check for updates.");
    return { ...next, branches: prev.branches, totals: prev.totals };
  }
  return next;
}

export default function DailyClosing() {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const isAdmin = ["hr_admin", "management"].includes(user?.role);

  const [date, setDate] = useState(todayIST);
  const [data, setData] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  // Seconds spent waiting on the fetcher. Shown, because Cloudflare's cron is
  // best-effort and a wait a person can see is a different experience from one
  // they cannot.
  const [waitedS, setWaitedS] = useState(0);
  // Lives HERE, not in the deposit panel. When the MIS drops a branch from the
  // report the panel unmounts, and a message rendered inside it disappears at
  // exactly the moment it matters most — the submit went through unchecked and
  // nobody was told.
  const [notice, setNotice] = useState("");
  const runRef = useRef(0);
  const mountedRef = useRef(true);
  const dateRef = useRef(null);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const isToday = date === todayIST();
  // The date the screen is CURRENTLY showing. A wait that was started for another
  // day must not write into it: changing the picker mid-wait does not start a new
  // run (history is never auto-pulled), so the run token alone did not stop the
  // old loop — it kept polling the old date and painting its money over the new
  // day for the rest of its 150 seconds. Measured: the picker on 10-Aug showing
  // 18-Aug's Rs 1,82,438.
  dateRef.current = date;

  const load = useCallback(async (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    setError("");
    try {
      const res = await API.get(`/closing/day?date=${date}`);
      setData((prev) => keepBranches(prev, res.data, date, setNotice));
    } catch (e) {
      // A failed poll must not blank a figure that was on screen a second ago —
      // an empty table reads as "nothing was collected", which is a different
      // and much more alarming claim than "we could not reach the server".
      setError(e?.response?.data?.detail || "Could not load the day's collections.");
    } finally {
      setLoading(false);
    }
    if (isAdmin) {
      try {
        const st = await API.get("/closing/status");
        setStatus(st.data);
      } catch { /* the health strip is optional; the figures are not */ }
    }
  }, [date, isAdmin]);

  useEffect(() => { load(); }, [load]);

  /**
   * Ask for a fresh pull and wait for it to land.
   *
   * Resolves to {status} — "fresh" (already recent, nothing to wait for),
   * "delivered" (with the new day payload), "timeout", or "failed". Never
   * throws: a fetch that did not happen must not block a manager who has cash in
   * hand and a bank about to close. The CALLER decides what each outcome means.
   */
  const pullAndWait = useCallback(async () => {
    // Every wait carries a token. Two can be in flight at once — the open-pull
    // and a Submit, or a date change mid-wait — and without this the older loop
    // kept polling the OLD date and writing its answers into the screen for up
    // to 150 seconds. Measured: the picker on 10-Aug showing 18-Aug's money, and
    // a guard message quoting one day's figure against another's.
    const mine = ++runRef.current;
    const startedFor = date;
    const alive = () =>
      runRef.current === mine && mountedRef.current && dateRef.current === startedFor;

    const readDay = async () => {
      try {
        const d = (await API.get(`/closing/day?date=${date}`)).data;
        // Same guard as `load`. This path polls every three seconds during a
        // wait, so it is the likeliest place to catch a report a branch short.
        if (alive()) setData((prev) => keepBranches(prev, d, date, setNotice));
        return d;
      } catch { return null; }
    };

    if (alive()) { setWaitedS(0); setRefreshing(true); setNotice(""); }
    try {
      let before;
      try {
        const r = await API.post(`/closing/request-pull?date=${date}`);
        // ALWAYS RE-READ, including when the server says the figures are already
        // fresh. "Fresh" is global: another manager's pull, or the heartbeat,
        // can have delivered new money that THIS page has never seen. Returning
        // here without reading meant Submit compared its own stale props against
        // themselves and filed a Rs 1,06,000 gap without a word.
        if (!r.data?.queued && r.data?.throttled) {
          // SAY SO. A refused request used to return "fresh", which is what the
          // screen shows when the data is genuinely current — no message, no
          // counter, nothing. Pressing Check for a DIFFERENT day inside the
          // window looked identical to "already up to date" while the request
          // was silently dropped. A 14-Aug re-pull was asked for four times and
          // never once reached the fetcher.
          const wait = Math.ceil((r.data.seconds_until_next || 0) / 60);
          if (alive()) {
            setNotice("Somebody checked less than five minutes ago, so this one "
              + "was not sent"
              + (wait ? ` — try again in about ${wait} minute${wait === 1 ? "" : "s"}` : "")
              + ".");
          }
          return { status: "throttled", day: await readDay() };
        }
        if (!r.data?.queued && r.data?.fresh) {
          return { status: "fresh", day: await readDay() };
        }
        // The baseline comes from the SERVER, not from whatever this component
        // happens to be holding. On first load `data` is null, so comparing
        // against it made the first poll look like a change and returned
        // instantly with the OLD figures — silently.
        before = r.data?.updated_at ?? null;
      } catch (e) {
        if (alive()) setError(e?.response?.data?.detail || "Could not ask for a fresh pull.");
        return { status: "failed", day: await readDay() };
      }

      // Cloudflare's cron is best-effort, not punctual: a firing can be late
      // under load and can occasionally be skipped. So about a minute is the
      // TYPICAL wait, not the bound — which is why the elapsed seconds are shown
      // rather than a spinner, and why this gives up rather than hanging.
      const started = Date.now();
      const until = started + 150 * 1000;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 3000));
        if (!alive()) return { status: "abandoned" };
        setWaitedS(Math.round((Date.now() - started) / 1000));
        const fresh = await readDay();
        if (!fresh) continue;                       // a blip is not a failure
        if (fresh.updated_at && fresh.updated_at !== before) {
          return { status: "delivered", day: fresh };
        }
        if (fresh.last_attempt_failed) {
          if (alive()) {
            setError(fresh.last_attempt_detail
              ? `The MIS fetch failed: ${fresh.last_attempt_detail}`
              : "The MIS fetch failed.");
          }
          return { status: "failed", day: fresh };
        }
      }
      return { status: "timeout", day: await readDay() };
    } finally {
      // Only the newest run owns the shared spinner state. Otherwise the first
      // loop to finish re-enabled the button while another was still waiting,
      // and the visible counter jumped backwards between two baselines.
      if (runRef.current === mine && mountedRef.current) setRefreshing(false);
    }
  }, [date]);

  // Opening the screen asks for a pull. This is one of the two moments the
  // design fetches at — the other is Submit — and it is why there is no clock
  // anywhere in this file.
  useEffect(() => {
    if (!isToday) return;                 // history does not move on its own
    pullAndWait().catch(() => {});
    // Deliberately only on the date changing. Re-running whenever `data`
    // changes would start a new pull every time one landed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, isToday]);

  const onRefresh = async () => {
    setError("");
    await pullAndWait();
    await load(false);
  };

  const props = {
    data, status, loading, refreshing, waitedS, date, isToday,
    onRefresh,
    onDateChange: setDate,
    canRefresh: true,
    // Submit pulls before it records anything. A manager who counted their cash
    // at 21:40 and presses Submit at 21:45 must not file against a figure that
    // moved in between — that difference resurfaces later as a shortfall nobody
    // can explain, which is the whole failure this tool exists to prevent.
    onBeforeSubmit: pullAndWait,
    onNotice: setNotice,
    // Re-reads after a slip, a submission or an approval. Passed down rather
    // than each panel refetching itself, so one action refreshes one screen.
    onChanged: () => load(false),
  };

  return (
    <div className={isMobile ? "px-1" : ""}>
      {error && (
        <div className="mb-3 rounded-lg border border-red-300 bg-red-50 px-4 py-2.5 text-sm text-red-800"
             data-testid="closing-error">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900"
             data-testid="closing-notice">
          {notice}
        </div>
      )}
      {isMobile ? <ClosingMobile {...props} /> : <ClosingDesktop {...props} />}
    </div>
  );
}
