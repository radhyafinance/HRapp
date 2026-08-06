/**
 * Reports whether the logged-in employee is on the Android app or the PWA, so
 * HR can track APK adoption. Runs on every surface (app + web).
 *
 * App VERSION reporting is already wired here: it looks for the version via the
 * @capacitor/app plugin OR a "RadhyaHRApp/<version>" User-Agent marker. Neither
 * exists in the current APK, so no version is reported yet — the moment a future
 * APK adds either mechanism, the version flows through with NO further changes
 * to this web/backend code.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";
import API from "./api";
/**
 * Is this the Android APK (not the PWA)?
 *
 * Uses Capacitor's platform value, which is "web" in ANY browser/PWA and
 * "android"/"ios" only inside the native app. (We deliberately do NOT test for
 * registered plugins — registerPlugin() also registers web stubs, so that would
 * false-positive for PWA users.)
 */
export function isNativeApp() {
  try {
    let plat = "web";
    if (Capacitor && typeof Capacitor.getPlatform === "function") {
      plat = Capacitor.getPlatform();
    } else if (typeof window !== "undefined" && window.Capacitor
               && typeof window.Capacitor.getPlatform === "function") {
      plat = window.Capacitor.getPlatform();
    }
    return plat === "android" || plat === "ios";
  } catch (e) { return false; }
}
// The native GPS plugin. checkPermissions() only exists in the v1.4.0+ APK; in
// the PWA or an older APK the call throws and we report nothing — exactly like
// version reporting, so the web side needs no further change once the APK ships.
const RadhyaTracker = registerPlugin("RadhyaTracker");

/**
 * Best-effort location-permission state, or null if the app can't tell us.
 *
 * Rolled up here so the native side can stay dumb — it just reports Android's
 * raw fine/background states and this maps them to what the tracker cares about:
 *   background granted        -> "always"   (works locked/closed — the goal)
 *   foreground granted only   -> "in_use"   (dies when the screen locks)
 *   foreground denied         -> "denied"
 *   not yet asked             -> "prompt"
 */
async function detectLocationPermission(isApp) {
  if (!isApp) return null;
  try {
    if (!RadhyaTracker || typeof RadhyaTracker.checkPermissions !== "function") return null;
    const p = await RadhyaTracker.checkPermissions();
    if (!p) return null;
    const fine = p.location || p.fine || p.foreground;
    const back = p.background || p.always;
    if (back === "granted") return "always";
    if (fine === "granted") return "in_use";
    if (fine === "denied" || back === "denied") return "denied";
    if (fine === "prompt" || fine === "prompt-with-rationale") return "prompt";
    return "unknown";
  } catch (e) {
    return null;   // old APK / PWA / plugin without the method
  }
}

/**
 * Tracker health, or null if the app can't tell us (PWA, or any APK before
 * v1.5.0 — the method simply doesn't exist there and the call throws).
 *
 * Separate from permission because the two fail independently, and the Devices
 * tab was misleading without it: "Allow all the time" and 90% battery is what a
 * phone shows when an OEM cleaner has been killing the tracker all morning.
 */
async function detectTrackerHealth(isApp) {
  if (!isApp) return null;
  try {
    if (!RadhyaTracker || typeof RadhyaTracker.getHealth !== "function") return null;
    const h = await RadhyaTracker.getHealth();
    if (!h) return null;
    // Report ONLY what the phone actually measured. Coercing an absent field to
    // its healthy value would be worse than saying nothing: the backend stamps
    // tracker_health_at as soon as any field arrives, and the Devices tab then
    // shows a green "No blockers" — an affirmative all-clear for a state that
    // was never checked. Leaving it undefined keeps it out of the payload, and
    // the backend's `is not None` test treats that as "not reported".
    const out = {};
    if (typeof h.batteryOptimised === "boolean") out.battery_optimised = h.batteryOptimised;
    if (typeof h.exactAlarms === "boolean") out.exact_alarms = h.exactAlarms;
    // Only a fault while tracking is supposed to be ON. A service that isn't
    // running because the employee has punched out is working as designed.
    if (typeof h.serviceRunning === "boolean") out.service_dead = !!h.active && !h.serviceRunning;
    // Fixes buffered offline and still waiting to upload.
    //
    // typeof, not Number(): every other field here uses a strict check and this
    // one did not, which made it a live instance of the exact bug the comment
    // above warns about. Number(null), Number(""), Number(false) and Number([])
    // are all 0 and all finite, so a plugin that reported nothing would send
    // queued_pings: 0 — an affirmative "nothing buffered" for a value never
    // measured, which stamps tracker_health_at and puts a green "None, checked
    // just now" on a phone whose blockers were never checked at all.
    if (typeof h.queued === "number" && Number.isFinite(h.queued)) {
      out.queued_pings = h.queued;
    }
    // v1.6.0+. Play Services says the phone cannot currently produce a fix at
    // all (GPS switched off, deep indoors). Separates "not reporting" from
    // "cannot see sky", which look identical in last_ping_at.
    if (typeof h.locationUnavailable === "boolean") {
      out.location_unavailable = h.locationUnavailable;
    }
    // Why the last backstop pass ended the way it did. Whitelisted server-side;
    // sent as-is here so a new build's value reaches the log even if this file
    // has not been updated for it.
    if (typeof h.lastWorkerOutcome === "string" && h.lastWorkerOutcome) {
      out.worker_outcome = h.lastWorkerOutcome.slice(0, 40);
    }
    // Ages, not timestamps. A phone whose clock is wrong is precisely the kind
    // we are trying to diagnose, so sending "12 minutes ago" survives a skewed
    // clock in a way that sending its idea of the wall time does not.
    const ageMin = (t) => {
      const n = Number(t);
      if (!Number.isFinite(n) || n <= 0) return null;      // never happened
      const mins = Math.round((Date.now() - n) / 60000);
      // A future timestamp means the clock stepped backwards. Reporting 0 would
      // manufacture "the alarm fired just now" for one that may never have
      // fired — say nothing instead, which is what the rest of this file does.
      return mins >= 0 ? mins : null;
    };
    const alarm = ageMin(h.lastAlarmAt);
    const worker = ageMin(h.lastWorkerAt);
    // v1.6.0+: the standing subscription's last delivery. THIS is the
    // primary-path signal on that build — lastAlarmAt there is a 15-minute
    // heartbeat that on most handsets never fires at all, so its absence is
    // normal and must not be read as a fault.
    const fix = ageMin(h.lastFixAt);
    if (alarm !== null) out.alarm_age_min = alarm;
    if (worker !== null) out.worker_age_min = worker;
    if (fix !== null) out.fix_age_min = fix;
    return Object.keys(out).length ? out : null;
  } catch (e) {
    return null;
  }
}

function detectBase() {
  const native = isNativeApp();
  const ua = (navigator.userAgent || "");
  let os = "other";
  if (/android/i.test(ua)) os = "android";
  else if (/iphone|ipad|ipod/i.test(ua)) os = "ios";
  else if (/windows/i.test(ua)) os = "windows";
  else if (/mac os/i.test(ua)) os = "mac";
  let standalone = false;
  try {
    standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)
      || window.navigator.standalone === true;
  } catch (e) { /* ignore */ }
  return { platform: native ? "app" : "pwa", os, standalone };
}
/** Best-effort APK version (only present once a future APK provides it). */
async function detectVersion(isApp) {
  if (!isApp) return null;
  // 1) @capacitor/app plugin (if a future APK bundles it)
  try {
    const AppPlugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (AppPlugin && AppPlugin.getInfo) {
      const info = await AppPlugin.getInfo();
      if (info && info.version) return String(info.version).slice(0, 20);
    }
  } catch (e) { /* not available */ }
  // 2) User-Agent marker like "RadhyaHRApp/1.4.0"
  try {
    const m = (navigator.userAgent || "").match(/RadhyaHRApp\/([0-9][0-9.]*)/i);
    if (m) return m[1];
  } catch (e) { /* ignore */ }
  return null;
}
/** Report platform (+ version if known). Reports on any change, else every ~6h. */
export async function reportClientPlatform() {
  try {
    if (!localStorage.getItem("auth_token")) return;
    const base = detectBase();
    const isApp = base.platform === "app";
    const version = await detectVersion(isApp);
    const permission = await detectLocationPermission(isApp);
    const health = await detectTrackerHealth(isApp);
    const info = { ...base };
    if (version) info.version = version;
    if (permission) info.location_permission = permission;
    if (health) Object.assign(info, health);
    // Permission is in the signature so a revocation re-reports on the next call
    // instead of waiting out the 6h throttle. (The APK should call this on resume.)
    // Health joins the signature for the same reason permission did: a tracker
    // that just died should show up on the Devices tab now, not in six hours.
    // The queue depth is deliberately reduced to "buffering or not" here. The
    // exact count changes with every ping, and putting it in the signature
    // would report on each one; the bucket still makes "started buffering" and
    // "finished draining" show up promptly.
    // worker_outcome joins the signature because it is STABLE while things work
    // ("healthy" run after run) and changes the moment they stop — so it costs
    // nothing on a good phone and reports within minutes on a failing one,
    // which is the whole point. location_unavailable is deliberately left OUT:
    // it flips every time someone walks into a building, and putting it here
    // would POST on each one.
    const healthSig = health
      ? `${health.battery_optimised ? 1 : 0}${health.exact_alarms === false ? 1 : 0}${health.service_dead ? 1 : 0}${health.queued_pings > 0 ? 1 : 0}|${health.worker_outcome || ""}`
      : "";
    // The session tag scopes the throttle to the logged-in user. Without it,
    // on a shared field phone the second employee to log in within 6h matches
    // the first one's signature, the POST is skipped, and they show as "never
    // seen" on Adoption with no permission or health of their own.
    const session = (localStorage.getItem("auth_token") || "").slice(-24);
    const sig = `${session}|${base.platform}|${version || ""}|${permission || ""}|${healthSig}`;
    const lastSig = localStorage.getItem("rmf_client_sig");
    const lastT = Number(localStorage.getItem("rmf_client_at") || 0);
    if (lastSig === sig && (Date.now() - lastT) < 6 * 60 * 60 * 1000) return;
    await API.post("/tracker/client-info", info);
    localStorage.setItem("rmf_client_sig", sig);
    localStorage.setItem("rmf_client_at", String(Date.now()));
  } catch (e) { /* best-effort */ }
}
