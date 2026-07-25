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
    const info = { ...base };
    if (version) info.version = version;
    if (permission) info.location_permission = permission;
    // Permission is in the signature so a revocation re-reports on the next call
    // instead of waiting out the 6h throttle. (The APK should call this on resume.)
    const sig = `${base.platform}|${version || ""}|${permission || ""}`;
    const lastSig = localStorage.getItem("rmf_client_sig");
    const lastT = Number(localStorage.getItem("rmf_client_at") || 0);
    if (lastSig === sig && (Date.now() - lastT) < 6 * 60 * 60 * 1000) return;
    await API.post("/tracker/client-info", info);
    localStorage.setItem("rmf_client_sig", sig);
    localStorage.setItem("rmf_client_at", String(Date.now()));
  } catch (e) { /* best-effort */ }
}
