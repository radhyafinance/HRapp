/**
 * Field GPS tracking for the Android app (Capacitor wrapper).
 *
 * Runs ONLY inside the native Android app (no-op in a normal browser) and only
 * while the employee is punched in (open attendance session).
 *
 * The heavy lifting is done natively by the custom "RadhyaTracker" plugin: it
 * wakes every 3 minutes (exact alarm), takes ONE GPS fix, posts it to the
 * existing OsmAnd endpoint (/api/tracker/osmand), and powers GPS back down —
 * so it keeps working with the phone locked or the app closed, and is easy on
 * the battery. This module only decides WHEN to run it (punch-in → start,
 * punch-out → stop) and hands it the employee's identifier.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";
import API from "./api";

const RadhyaTracker = registerPlugin("RadhyaTracker");
const BACKEND = process.env.REACT_APP_BACKEND_URL || "";
const PING_URL = `${BACKEND}/api/tracker/osmand`;
const INTERVAL_MS = 3 * 60 * 1000; // ping every 3 minutes

let identifier = null;      // "RMF0001:secret"
let syncing = false;        // guard against overlapping syncs
let inited = false;

function isNative() {
  try { return Capacitor.isNativePlatform(); } catch { return false; }
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
  if (!isNative() || syncing) return;
  if (!localStorage.getItem("auth_token")) { await stopTracking(); return; }
  syncing = true;
  try {
    const { data } = await API.get("/tracker/my-config");
    identifier = data?.identifier || identifier;
    if (data?.should_track && data?.active && identifier) {
      await startTracking(identifier);
    } else {
      await stopTracking();
    }
  } catch {
    // 400 (no employee linked, e.g. admin) or network error → ensure stopped.
    await stopTracking();
  } finally {
    syncing = false;
  }
}

export async function stopFieldTracking() {
  identifier = null;
  await stopTracking();
}

/** Call once after auth is established. Idempotent; no-op outside the app. */
export function initFieldTracking() {
  if (!isNative() || inited) return;
  inited = true;
  syncFieldTracking();
  // Re-check whenever the app returns to the foreground.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncFieldTracking();
  });
  // Safety net: catches punch-outs done elsewhere, token expiry, etc.
  setInterval(syncFieldTracking, 5 * 60 * 1000);
}
