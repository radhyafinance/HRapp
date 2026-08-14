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
// Ping every 60 seconds. This is the ONLY thing that sets the tracking cadence:
// the native side takes it from RadhyaTracker.start() and floors it at 60s
// (TrackerService: Math.max(interval, 60_000L), and setMinUpdateIntervalMillis
// at Math.max(60s, intervalMs / 2)), so 60s here is the fastest the fleet can
// go without changing the APK.
//
// Note `interval_seconds` on the tracker record and in /tracker/my-config is a
// DECOY — nothing reads it, so changing it per employee does nothing. If you
// ever need per-person intervals, wire it through here.
//
// Battery: measured 5.2 %/hr median on v1.6.0 at 3 minutes, against 6.7 %/hr on
// the old v1.4.0 alarm build. Tripling the GPS duty cycle will cost more than
// that. If field staff start complaining about battery, raise this number —
// it is a one-line change and it reaches every phone on the next deploy.
const INTERVAL_MS = 60 * 1000;
// Persisted so a webview reload (or an app restart) can still re-assert the
// last decision while offline — in memory alone, a reload would leave us unable
// to restart a service the OEM had killed until the network came back.
const ID_KEY = "rmf_tracker_id";
const WANT_KEY = "rmf_tracker_want";
const SESSION_KEY = "rmf_tracker_session";
let identifier = null;      // "RMF0001:secret"
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
function remember(want, id) {
  wantTracking = want;
  ls(() => {
    localStorage.setItem(WANT_KEY, want ? "1" : "0");
    localStorage.setItem(SESSION_KEY, sessionTag());
    if (id) localStorage.setItem(ID_KEY, id);
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
  return { want, id: identifier || ls(() => localStorage.getItem(ID_KEY), null) };
}
function forget() {
  wantTracking = null;
  ls(() => {
    localStorage.removeItem(WANT_KEY);
    localStorage.removeItem(ID_KEY);
    localStorage.removeItem(SESSION_KEY);
  });
}
async function startTracking(id) {
  try {
    await RadhyaTracker.start({ identifier: id, url: PING_URL, intervalMs: INTERVAL_MS });
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
    remember(want, identifier);
    if (want) {
      await startTracking(identifier);
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
  const { want, id } = recall();
  if (want && id) {
    identifier = id;
    await startTracking(id);
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
