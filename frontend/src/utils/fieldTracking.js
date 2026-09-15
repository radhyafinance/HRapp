/**
 * Field GPS tracking for the Android app (Capacitor wrapper).
 *
 * Runs ONLY inside the native Android app (no-op in a normal browser) and only
 * while the employee is punched in (open attendance session).
 *
 * The heavy lifting is done natively by the custom "RadhyaTracker" plugin. It
 * holds ONE standing GPS subscription for as long as the service lives and posts
 * each fix to the OsmAnd endpoint (/api/tracker/osmand), so it keeps working
 * with the phone locked or the app closed. This module only decides WHEN to run
 * it (punch-in → start, punch-out → stop), hands it the employee's identifier,
 * and sets the cadence via INTERVAL_MS below.
 *
 * It used to describe an exact alarm firing every 3 minutes. That design is gone:
 * when Android refuses an alarm-driven foreground-service start it throws before
 * the service exists, so the code that booked the next alarm never ran and one
 * refusal ended tracking for the day. There is no chain to break now.
 *
 * A FAILED REQUEST IS NOT AN ANSWER. This module used to call stop() from the
 * catch block, and stop() is not a pause — it clears the native alarm and kills
 * the service. So one weak-signal moment (and this runs on app-resume, which is
 * exactly when the radio is still reattaching) switched tracking off for the
 * rest of the day. Only an authoritative reply may stop tracking; everything
 * else holds the last known decision and re-asserts it.
 */
import { registerPlugin } from "@capacitor/core";
import API from "./api";
import { isNativeApp } from "./clientPlatform";
const RadhyaTracker = registerPlugin("RadhyaTracker");
const BACKEND = process.env.REACT_APP_BACKEND_URL || "";
const PING_URL = `${BACKEND}/api/tracker/osmand`;
// Ping every 120 seconds. This is the ONLY thing that sets the tracking cadence:
// the native side takes it from RadhyaTracker.start() and clamps it to 1-15 min.
//
// ONLY APK v1.6.2+ OBEYS IT. Every earlier build read this value with
// Capacitor's getLong(), which ignores a JS number (it arrives as an Integer,
// not a Long), so those phones stay at their built-in 3 minutes whatever is set
// here. Measured on 2026-09-13: the whole fleet reported every 180-250 s while
// this line said 60. Changing it therefore reaches v1.6.2 phones on the next
// deploy and has no effect at all on older ones.
//
// Note `interval_seconds` on the tracker record and in /tracker/my-config is a
// DECOY — nothing reads it, so changing it per employee does nothing. If you
// ever need per-person intervals, wire it through here.
//
// Battery: 8.6 %/hr median discharge during working hours at 3 minutes
// (2026-08-30 to 09-12, including normal phone use). v1.6.2 also adds GPS
// top-ups. If field staff complain about battery, raise this number.
const INTERVAL_MS = 120 * 1000;
// Persisted so a webview reload (or an app restart) can still re-assert the
// last decision while offline — in memory alone, a reload would leave us unable
// to restart a service the OEM had killed until the network came back.
const ID_KEY = "rmf_tracker_id";
// When the phone must stop tracking, in THIS phone's clock (ms). Kept so an
// offline re-assert still carries the day's 11 pm stop, instead of restarting
// a tracker with no end.
const UNTIL_KEY = "rmf_tracker_until";
const WANT_KEY = "rmf_tracker_want";
const SESSION_KEY = "rmf_tracker_session";
let identifier = null;      // "RMF0001:secret"
let untilPhoneMs = null;    // stop time in this phone's clock, or null
let wantTracking = null;    // in-memory mirror; null = nothing learned yet
let syncing = false;        // guard against overlapping syncs
let pending = false;        // a sync arrived while one was in flight
let generation = 0;         // bumped on teardown to void in-flight syncs
let inited = false;
function isNative() { return isNativeApp(); }
function ls(fn, fallback) {
  try { return fn(); } catch (e) { return fallback; }
}
/**
 * Which login does the stored decision belong to?
 *
 * The identifier is a bearer credential for the unauthenticated /osmand
 * endpoint, and these are plain device-wide keys. On a SHARED field phone,
 * employee A's expired session leaves the state behind; if B then logs in and
 * their first sync fails, re-asserting the stored decision would start tracking
 * under A's identifier — B's movements written into A's attendance record.
 * Binding to the token means a different login can never inherit it.
 */
function sessionTag() {
  return ls(() => (localStorage.getItem("auth_token") || "").slice(-24), "");
}
/** Record the last AUTHORITATIVE answer, so a later failure has something to hold. */
function remember(want, id, until) {
  wantTracking = want;
  untilPhoneMs = until || null;
  ls(() => {
    localStorage.setItem(WANT_KEY, want ? "1" : "0");
    localStorage.setItem(SESSION_KEY, sessionTag());
    if (id) localStorage.setItem(ID_KEY, id);
    if (until) localStorage.setItem(UNTIL_KEY, String(until));
    else localStorage.removeItem(UNTIL_KEY);
  });
}
function recall() {
  const mine = ls(() => localStorage.getItem(SESSION_KEY) === sessionTag(), false);
  if (!mine) return { want: false, id: null };
  // Prefer memory: if setItem ever threw (quota, private mode) the stored copy
  // is missing and reading it alone would silently downgrade "hold the last
  // decision" into "do nothing", which is the bug this module exists to avoid.
  const want = wantTracking !== null
    ? wantTracking
    : ls(() => localStorage.getItem(WANT_KEY) === "1", false);
  const storedUntil = Number(ls(() => localStorage.getItem(UNTIL_KEY), "")) || null;
  return { want, id: identifier || ls(() => localStorage.getItem(ID_KEY), null),
           until: untilPhoneMs || storedUntil };
}
function forget() {
  wantTracking = null;
  ls(() => {
    localStorage.removeItem(WANT_KEY);
    localStorage.removeItem(ID_KEY);
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(UNTIL_KEY);
  });
  untilPhoneMs = null;
}
/**
 * The server's "track until" (11 pm IST, or the punch-out) as a time on THIS
 * phone's clock. Converted with the server's own `server_time`, so a phone whose
 * clock is wrong still stops at the real 11 pm rather than at its own idea of it.
 */
function untilOnPhone(data) {
  const until = Date.parse(data?.track_until || "");
  const server = Date.parse(data?.server_time || "");
  if (!Number.isFinite(until) || !Number.isFinite(server)) return null;
  return Date.now() + (until - server);
}
async function startTracking(id, until) {
  // A stop time already past means the phone has stopped itself (11 pm, or the
  // punch-out) — there is nothing to re-assert. Starting anyway would bring the
  // native service up only to shut it down again, and would switch off a session
  // started since then.
  if (until && until <= Date.now()) return;
  try {
    const opts = { identifier: id, url: PING_URL, intervalMs: INTERVAL_MS };
    // v1.6.3+ stops itself this many ms from now; older builds ignore it. A
    // stop time already past is sent as 1 ms, which stops the phone at once.
    if (until) opts.stopInMs = Math.max(1, Math.round(until - Date.now()));
    await RadhyaTracker.start(opts);
  } catch (e) {
    // e.g. location permission denied — the native side surfaces the prompt.
  }
}
async function stopTracking() {
  try { await RadhyaTracker.stop(); } catch { /* ignore */ }
}
/**
 * Reconcile tracking with backend state: track iff the employee is punched in.
 * Safe to call often (login, punch, app-resume, periodic). Re-calling start()
 * is cheap and also re-ensures the native service is alive.
 */
export async function syncFieldTracking() {
  if (!isNative()) return;
  // Coalesce rather than drop. The punch-out reconciliation fires from an axios
  // interceptor and can easily land while a slow periodic sync is still in
  // flight; returning here without a rerun left a punched-out employee tracked
  // until the next 5-minute tick.
  if (syncing) { pending = true; return; }
  if (!ls(() => localStorage.getItem("auth_token"), null)) {
    forget();
    await stopTracking();
    return;
  }
  syncing = true;
  const gen = generation;
  try {
    const { data } = await API.get("/tracker/my-config");
    // Logout (or another teardown) landed while this was in flight. Acting on
    // the stale answer would restart tracking for a user who has gone.
    if (gen !== generation) return;
    identifier = data?.identifier || identifier;
    const want = !!(data?.should_track && data?.active && identifier);
    const until = want ? untilOnPhone(data) : null;
    remember(want, identifier, until);
    if (want) {
      await startTracking(identifier, until);
    } else {
      await stopTracking();
    }
  } catch (err) {
    if (gen === generation) await handleSyncFailure(err);
  } finally {
    syncing = false;
    if (pending) { pending = false; syncFieldTracking(); }
  }
}
/**
 * The request failed. Decide whether that was an ANSWER or just a bad moment.
 *
 * Authoritative (stop): 400 means no employee is linked to this account — an
 * HR/admin login, which is never tracked. 401/403 mean the session is gone.
 * Both are stable facts about this user, and re-checking will not change them.
 *
 * Everything else (hold): offline, DNS failure, timeout, 5xx, the backend
 * restarting mid-deploy. None of these say anything about whether the employee
 * is punched in, and tearing the native schedule down over one of them is what
 * left field officers Stale for hours.
 */
async function handleSyncFailure(err) {
  const status = err?.response?.status;
  if (status === 400 || status === 401 || status === 403) {
    forget();
    await stopTracking();
    return;
  }
  // Re-asserting start() here is deliberate rather than merely doing nothing:
  // it re-arms the native alarm and revives a service an OEM cleaner may have
  // killed, so a phone that spent an hour out of coverage heals on its own.
  const { want, id, until } = recall();
  if (until && until <= Date.now()) {
    // Yesterday's decision, left behind when the phone stopped itself with the
    // app closed. Drop it rather than hold it: the next successful sync decides.
    remember(false, id, null);
    return;
  }
  if (want && id) {
    identifier = id;
    await startTracking(id, until);
  }
}
export async function stopFieldTracking() {
  generation += 1;            // void any sync already in flight
  identifier = null;
  forget();
  await stopTracking();
}
/** Call once after auth is established. Idempotent; no-op outside the app. */
export function initFieldTracking() {
  if (!isNative() || inited) return;
  inited = true;
  syncFieldTracking();
  // Re-check whenever the app returns to the foreground.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    syncFieldTracking();
    // Re-report health too. The webview survives app resumes, so without this
    // the Devices tab only ever shows what was true at the last cold start —
    // a phone whose tracker died at 10am would keep showing "No blockers".
    // Its own 6h signature throttle makes this cheap.
    import("./clientPlatform").then(m => m.reportClientPlatform()).catch(() => {});
  });
  // Safety net: catches punch-outs done elsewhere, token expiry, etc.
  setInterval(syncFieldTracking, 5 * 60 * 1000);
}
