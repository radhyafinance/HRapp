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
import { Capacitor } from "@capacitor/core";
import API from "./api";
/**
 * Is this the Android APK (not the PWA)? Reads the INJECTED native bridge
 * (window.Capacitor) directly, which is reliable in a remote-loaded WebView even
 * when the imported @capacitor/core flag is not. Falls back to our own plugins.
 */
export function isNativeApp() {
  try {
    if (Capacitor && typeof Capacitor.isNativePlatform === "function" && Capacitor.isNativePlatform()) {
      return true;
    }
    const cap = (typeof window !== "undefined") ? window.Capacitor : null;
    if (cap) {
      if (typeof cap.isNativePlatform === "function" && cap.isNativePlatform()) return true;
      if (typeof cap.getPlatform === "function") {
        const p = cap.getPlatform();
        if (p === "android" || p === "ios") return true;
      }
      if (cap.isNative === true || cap.platform === "android" || cap.platform === "ios") return true;
      if (cap.Plugins && (cap.Plugins.RadhyaTracker || cap.Plugins.CapacitorPluginMlKitTextRecognition || cap.Plugins.App)) {
        return true;
      }
    }
  } catch (e) { /* ignore */ }
  return false;
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
    const version = await detectVersion(base.platform === "app");
    const info = version ? { ...base, version } : base;
    const sig = `${base.platform}|${version || ""}`;
    const lastSig = localStorage.getItem("rmf_client_sig");
    const lastT = Number(localStorage.getItem("rmf_client_at") || 0);
    if (lastSig === sig && (Date.now() - lastT) < 6 * 60 * 60 * 1000) return;
    await API.post("/tracker/client-info", info);
    localStorage.setItem("rmf_client_sig", sig);
    localStorage.setItem("rmf_client_at", String(Date.now()));
  } catch (e) { /* best-effort */ }
}
