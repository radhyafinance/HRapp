/**
 * Field GPS tracking for the Android app (Capacitor wrapper).
 *
 * Runs ONLY inside the native Android app (no-op in a normal browser) and only
 * while the employee is punched in (open attendance session). It reports the
 * device's location to the existing public OsmAnd endpoint
 * (`/api/tracker/osmand`), the same endpoint the Traccar Client used — so no
 * dashboard/backend changes are needed to view the data.
 *
 * Reliability: the @capacitor-community/background-geolocation plugin keeps a
 * foreground service alive (persistent notification), which is what lets
 * tracking survive a locked screen. On aggressive OEMs (Xiaomi/Oppo/Vivo/etc.)
 * the user must ALSO disable battery optimization and enable Autostart — we
 * nudge them once via openSettings().
 */
import { Capacitor, registerPlugin } from "@capacitor/core";
import API from "./api";

const BackgroundGeolocation = registerPlugin("BackgroundGeolocation");
const BACKEND = process.env.REACT_APP_BACKEND_URL || "";
const NUDGE_KEY = "rmf_bg_nudge_shown";

let watcherId = null;       // active plugin watcher id, or null
let identifier = null;      // "RMF0001:secret"
let syncing = false;        // guard against overlapping syncs
let inited = false;

function isNative() {
  try { return Capacitor.isNativePlatform(); } catch { return false; }
}

/** POST one location fix to the OsmAnd endpoint (public — no auth header). */
async function postPing(loc) {
  if (!identifier || !loc) return;
  const p = new URLSearchParams();
  p.set("id", identifier);
  p.set("lat", String(loc.latitude));
  p.set("lon", String(loc.longitude));
  p.set("timestamp", String(Math.floor(Date.now() / 1000)));
  if (loc.accuracy != null) p.set("accuracy", String(loc.accuracy));
  if (loc.altitude != null) p.set("altitude", String(loc.altitude));
  if (loc.speed != null) p.set("speed", String(loc.speed));
  if (loc.bearing != null) p.set("bearing", String(loc.bearing));
  try {
    await fetch(`${BACKEND}/api/tracker/osmand?${p.toString()}`, { method: "POST" });
  } catch {
    /* Offline — drop this fix; the next one will report once back online. */
  }
}

async function startWatcher() {
  if (watcherId) return;
  watcherId = await BackgroundGeolocation.addWatcher(
    {
      backgroundMessage: "Attendance location is being recorded while you are on duty.",
      backgroundTitle: "Radhya HR — on duty",
      requestPermissions: true,
      stale: false,
      distanceFilter: 25, // report after moving ~25 m (battery-friendly)
    },
    (location, error) => {
      if (error) {
        if (error.code === "NOT_AUTHORIZED") maybeNudgeSettings();
        return;
      }
      postPing(location);
    }
  );
}

async function stopWatcher() {
  if (!watcherId) return;
  const id = watcherId;
  watcherId = null;
  try { await BackgroundGeolocation.removeWatcher({ id }); } catch { /* ignore */ }
}

/** One-time prompt guiding the user to allow "Always" location / disable battery optimization. */
function maybeNudgeSettings() {
  try {
    if (localStorage.getItem(NUDGE_KEY)) return;
    localStorage.setItem(NUDGE_KEY, "1");
    const go = window.confirm(
      "To record attendance location reliably, please set location permission to " +
      "\"Allow all the time\" and turn OFF battery optimization / turn ON Autostart " +
      "for Radhya HR.\n\nOpen settings now?"
    );
    if (go) BackgroundGeolocation.openSettings();
  } catch { /* ignore */ }
}

/**
 * Reconcile tracking with backend state: track iff the employee is punched in.
 * Safe to call often (login, punch, app-resume, periodic).
 */
export async function syncFieldTracking() {
  if (!isNative() || syncing) return;
  if (!localStorage.getItem("auth_token")) { await stopWatcher(); return; }
  syncing = true;
  try {
    const { data } = await API.get("/tracker/my-config");
    identifier = data?.identifier || identifier;
    if (data?.should_track && data?.active && identifier) {
      await startWatcher();
    } else {
      await stopWatcher();
    }
  } catch {
    // 400 (no employee linked, e.g. admin) or network error → ensure stopped.
    await stopWatcher();
  } finally {
    syncing = false;
  }
}

export async function stopFieldTracking() {
  identifier = null;
  await stopWatcher();
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
