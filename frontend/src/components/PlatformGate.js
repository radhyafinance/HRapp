/**
 * Blocks Android web usage (regular browser AND installed PWA) and tells the
 * user to contact IT for the Android APK. iOS (Safari/PWA), desktop, and the
 * native APK itself are all allowed through untouched.
 *
 * The APK is a Capacitor WebView loading this same web app, so we must NOT block
 * it — isNativeApp() is true only inside the APK (Capacitor platform
 * "android"/"ios") and false in any browser/PWA, which is exactly the signal we
 * need.
 */
import React from "react";
import { isNativeApp } from "@/utils/clientPlatform";

// ── Optional IT contact shown on the block screen (leave "" to hide). ─────────
const IT_CONTACT = ""; // e.g. "it@radhyafinance.com"

function shouldBlock() {
  try {
    const isAndroid = /android/i.test(navigator.userAgent || "");
    return isAndroid && !isNativeApp(); // Android browser/PWA, but not the APK
  } catch (e) {
    return false; // never hard-fail the whole app on a detection error
  }
}

function AndroidDownloadScreen() {
  return (
    <div style={{
      position: "fixed", inset: 0, display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", textAlign: "center",
      padding: "24px", background: "#1E2A47", color: "#fff",
      fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", zIndex: 999999,
    }}>
      <div style={{ maxWidth: 420 }}>
        <div style={{
          fontSize: 22, fontWeight: 700, marginBottom: 12, letterSpacing: 0.2,
        }}>Radhya HR</div>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 10px" }}>
          Please use the Android app
        </h1>
        <p style={{ fontSize: 15, lineHeight: 1.5, opacity: 0.85, margin: "0 0 8px" }}>
          The web version isn't available on Android. Please contact the IT team
          for the latest Radhya HR app.
        </p>
        {IT_CONTACT ? (
          <p style={{ fontSize: 14, fontWeight: 600, color: "#E85B1E", margin: "0 0 8px" }}>
            {IT_CONTACT}
          </p>
        ) : null}
        <p style={{ fontSize: 12, opacity: 0.6, margin: "20px 0 0" }}>
          Already installed it? Open Radhya HR from your home screen.
        </p>
      </div>
    </div>
  );
}

export default function PlatformGate({ children }) {
  if (shouldBlock()) return <AndroidDownloadScreen />;
  return children;
}
