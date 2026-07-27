/**
 * Two gates, applied in order, wrapping the whole app.
 *
 * 1. PLATFORM — blocks Android web usage (regular browser AND installed PWA)
 *    and tells the user to contact IT for the Android APK. iOS (Safari/PWA),
 *    desktop, and the native APK itself are all allowed through untouched.
 *
 *    The APK is a Capacitor WebView loading this same web app, so we must NOT
 *    block it — isNativeApp() is true only inside the APK (Capacitor platform
 *    "android"/"ios") and false in any browser/PWA, which is exactly the signal
 *    we need.
 *
 * 2. TRACKING — for employees HR has explicitly marked as FIELD STAFF, requires
 *    Android's "Allow all the time" location. Without it the duty-cycle tracker
 *    silently produces no fixes once the screen locks, so the employee looks
 *    tracked while no data ever arrives. Those employees are held on a block
 *    screen until they grant it.
 *
 *    The marking is OPT-IN, one person at a time, from Field Tracking → Field
 *    Staff. Nobody is enforced until somebody in HR deliberately switches them
 *    on, so head office is safe by default rather than by curation — the flag
 *    being missing, stale or unreadable all mean "not blocked".
 *
 *    Gate 2 applies INSIDE THE APK ONLY. Every browser is left alone: Android
 *    web is already stopped by gate 1, and desktop and iOS are deliberately
 *    exempt — there is no iOS build to send anyone to, and a desktop browser is
 *    a normal way to read a payslip rather than a way to dodge the tracker.
 *
 * ONE MORE DELIBERATE EXEMPTION: APKs older than v1.4.0 have no
 * checkPermissions(), so we cannot tell what they granted and they pass
 * through. Left open on purpose — the plan is to retire v1.3.0 outright with a
 * minimum-version gate rather than to guess.
 *
 * FAIL OPEN, ALWAYS. Every unknown — plugin error, network failure, an account
 * with no employee record — resolves to "allowed". A detection bug must never
 * lock the field force out of punching in. The only route to a block screen is
 * a positive answer to BOTH "this person is tracked" and "this device does not
 * have background location".
 */
import React from "react";
import { isNativeApp } from "@/utils/clientPlatform";
import { registerPlugin } from "@capacitor/core";
import API from "@/utils/api";

// ── Optional IT contact shown on the block screens (leave "" to hide). ────────
const IT_CONTACT = ""; // e.g. "it@radhyafinance.com"
// Public, external-facing pages that anyone must be able to open on ANY device
// (candidates on the invite link, banks/police scanning an ID-card verify QR).
// These are never blocked, by either gate.
const PUBLIC_PREFIXES = ["/apply/", "/verify/"];
// Whether someone is field staff changes about once in their employment, so one
// lookup per browser session is plenty and keeps the gate off the hot path.
// The key is versioned by meaning, not by build: an earlier release cached the
// tracker's active flag under a different name, and a stale "yes" from that
// build must never be read back as "this person is field staff".
const FIELD_STAFF_CACHE_KEY = "rmf_field_staff";

const RadhyaTracker = registerPlugin("RadhyaTracker");

function isPublicPath() {
  try {
    const path = (window.location && window.location.pathname) || "";
    return PUBLIC_PREFIXES.some((pre) => path.startsWith(pre));
  } catch (e) {
    return false;
  }
}

function shouldBlockPlatform() {
  try {
    if (isPublicPath()) return false; // public pages must work on every device
    const isAndroid = /android/i.test(navigator.userAgent || "");
    return isAndroid && !isNativeApp(); // Android browser/PWA, but not the APK
  } catch (e) {
    return false; // never hard-fail the whole app on a detection error
  }
}

/**
 * HR and management run the system. Locking them out would leave nobody able to
 * switch a tracker off and undo a bad block, so they are never location-gated.
 */
function isExemptRole() {
  try {
    const u = JSON.parse(localStorage.getItem("auth_user") || "{}");
    return u.role === "hr_admin" || u.role === "management";
  } catch (e) {
    return false;
  }
}

/**
 * true  — background location granted
 * false — definitively not granted
 * null  — cannot tell (PWA, APK older than v1.4.0, or the plugin threw)
 */
async function backgroundGranted() {
  if (!isNativeApp()) return null;
  try {
    if (!RadhyaTracker || typeof RadhyaTracker.checkPermissions !== "function") return null;
    const p = await RadhyaTracker.checkPermissions();
    if (!p) return null;
    return (p.background || p.always) === "granted";
  } catch (e) {
    return null;
  }
}

/**
 * Has HR explicitly marked this employee as field staff? Set per person from
 * Field Tracking → Field Staff.
 *
 * The endpoint is /tracker/my-enforcement and it must stay exactly that. It is
 * deliberately NOT /tracker/my-config: that one lazily creates a tracker row
 * with active=true, so asking it "should this person be blocked?" would answer
 * yes for everyone who ever opened the app. A wrong path 404s, lands in the
 * catch below, and silently turns this whole gate into a no-op that blocks
 * nobody — the failure is invisible from the outside, so the path is asserted
 * in test_gate.cjs.
 *
 * Anything unexpected returns false (= not field staff = allowed through).
 */
async function isFieldStaff() {
  try {
    const cached = sessionStorage.getItem(FIELD_STAFF_CACHE_KEY);
    if (cached === "yes") return true;
    if (cached === "no") return false;
  } catch (e) { /* sessionStorage unavailable — just re-fetch */ }
  try {
    const res = await API.get("/tracker/my-enforcement");
    const marked = Boolean(res && res.data && res.data.field_staff);
    try { sessionStorage.setItem(FIELD_STAFF_CACHE_KEY, marked ? "yes" : "no"); } catch (e) { /* noop */ }
    return marked;
  } catch (e) {
    return false; // fail open
  }
}

/**
 * Synchronous best guess used as the initial render state, so users who are
 * obviously fine never see a blank flash. Returns "checking" only when we
 * genuinely have to ask something asynchronously.
 */
function quickVerdict() {
  try {
    if (isPublicPath()) return "allowed";
    if (!localStorage.getItem("auth_token")) return "allowed"; // login screen
    if (isExemptRole()) return "allowed";
    if (!isNativeApp()) return "allowed"; // gate 2 is app-only
    if (sessionStorage.getItem(FIELD_STAFF_CACHE_KEY) === "no") return "allowed";
  } catch (e) {
    return "allowed";
  }
  return "checking";
}

async function evaluate() {
  try {
    if (isPublicPath()) return "allowed";
    if (!localStorage.getItem("auth_token")) return "allowed";
    if (isExemptRole()) return "allowed";

    // Any browser — Android web is already stopped by gate 1, and desktop and
    // iOS are exempt. Checked before the lookup, so no API call is ever made.
    if (!isNativeApp()) return "allowed";

    const bg = await backgroundGranted();
    // Granted, or an APK too old to tell us — either way, let them work.
    if (bg !== false) return "allowed";
    if (!(await isFieldStaff())) return "allowed";
    return "blocked-app";
  } catch (e) {
    return "allowed";
  }
}

// ── Screens ──────────────────────────────────────────────────────────────────

const SHELL = {
  position: "fixed", inset: 0, display: "flex", flexDirection: "column",
  alignItems: "center", justifyContent: "center", textAlign: "center",
  padding: "24px", background: "#1E2A47", color: "#fff",
  fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", zIndex: 999999,
};
const BTN = {
  display: "block", width: "100%", padding: "13px 18px", marginTop: 12,
  background: "#E85B1E", color: "#fff", border: "none", borderRadius: 8,
  fontSize: 15, fontWeight: 700, cursor: "pointer",
};
const BTN_GHOST = {
  ...BTN, background: "transparent", border: "1px solid rgba(255,255,255,0.35)",
  fontWeight: 600,
};
const LINK_BTN = {
  ...BTN, background: "transparent", border: "none", marginTop: 18,
  fontSize: 13, fontWeight: 600, opacity: 0.6,
};

function signOut() {
  try {
    localStorage.removeItem("auth_token");
    localStorage.removeItem("auth_user");
    sessionStorage.removeItem(FIELD_STAFF_CACHE_KEY);
  } catch (e) { /* noop */ }
  window.location.href = "/login";
}

function Brand() {
  return (
    <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 12, letterSpacing: 0.2 }}>
      Radhya HR
    </div>
  );
}

function Contact() {
  if (!IT_CONTACT) return null;
  return (
    <p style={{ fontSize: 14, fontWeight: 600, color: "#E85B1E", margin: "0 0 8px" }}>
      {IT_CONTACT}
    </p>
  );
}

function AndroidDownloadScreen() {
  return (
    <div style={SHELL}>
      <div style={{ maxWidth: 420 }}>
        <Brand />
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 10px" }}>
          Please use the Android app
        </h1>
        <p style={{ fontSize: 15, lineHeight: 1.5, opacity: 0.85, margin: "0 0 8px" }}>
          The web version isn't available on Android. Please contact the IT team
          for the latest Radhya HR app.
        </p>
        <Contact />
        <p style={{ fontSize: 12, opacity: 0.6, margin: "20px 0 0" }}>
          Already installed it? Open Radhya HR from your home screen.
        </p>
      </div>
    </div>
  );
}

function LocationRequiredScreen({ onRecheck, busy }) {
  const openSettings = () => {
    try {
      if (RadhyaTracker && typeof RadhyaTracker.promptBackgroundLocation === "function") {
        RadhyaTracker.promptBackgroundLocation();
      }
    } catch (e) { /* the button is a convenience; the written steps still work */ }
  };
  return (
    <div style={SHELL}>
      <div style={{ maxWidth: 420 }}>
        <Brand />
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 10px" }}>
          Location access required
        </h1>
        <p style={{ fontSize: 15, lineHeight: 1.5, opacity: 0.85, margin: "0 0 14px" }}>
          Your role requires location tracking during duty hours. To continue,
          set location access to <strong>Allow all the time</strong>.
        </p>
        <div style={{
          textAlign: "left", background: "rgba(255,255,255,0.08)", borderRadius: 8,
          padding: "12px 14px", fontSize: 14, lineHeight: 1.6, opacity: 0.9,
        }}>
          1. Tap <strong>Open Settings</strong><br />
          2. Go to <strong>Permissions → Location</strong><br />
          3. Choose <strong>Allow all the time</strong><br />
          4. Come back and tap <strong>I've enabled it</strong>
        </div>
        <button type="button" style={BTN} onClick={openSettings}>Open Settings</button>
        <button type="button" style={BTN_GHOST} onClick={onRecheck} disabled={busy}>
          {busy ? "Checking…" : "I've enabled it"}
        </button>
        {IT_CONTACT ? (
          <p style={{ fontSize: 13, opacity: 0.7, margin: "16px 0 0" }}>
            Trouble? Contact {IT_CONTACT}
          </p>
        ) : null}
        <button type="button" onClick={signOut} style={LINK_BTN}>Sign out</button>
      </div>
    </div>
  );
}

// ── Gate ─────────────────────────────────────────────────────────────────────

export default function PlatformGate({ children }) {
  const [status, setStatus] = React.useState(quickVerdict);
  const [busy, setBusy] = React.useState(false);
  const tokenRef = React.useRef(null);

  const recheck = React.useCallback(async () => {
    setBusy(true);
    const next = await evaluate();
    setStatus(next);
    setBusy(false);
  }, []);

  React.useEffect(() => {
    let alive = true;
    const run = async () => {
      const next = await evaluate();
      if (alive) setStatus(next);
    };
    try { tokenRef.current = localStorage.getItem("auth_token"); } catch (e) { /* noop */ }
    run();

    // Returning from the Android settings screen fires this, so the block
    // clears by itself once they grant the permission.
    const onVisible = () => { if (document.visibilityState === "visible") run(); };
    document.addEventListener("visibilitychange", onVisible);

    // This gate sits above the router, so logging in doesn't remount it. Watch
    // the token instead — cheap, and it catches both login and logout.
    const poll = setInterval(() => {
      let t = null;
      try { t = localStorage.getItem("auth_token"); } catch (e) { /* noop */ }
      if (t !== tokenRef.current) {
        tokenRef.current = t;
        try { sessionStorage.removeItem(FIELD_STAFF_CACHE_KEY); } catch (e) { /* noop */ }
        run();
      }
    }, 2000);

    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(poll);
    };
  }, []);

  if (shouldBlockPlatform()) return <AndroidDownloadScreen />;
  if (status === "checking") return null;
  if (status === "blocked-app") return <LocationRequiredScreen onRecheck={recheck} busy={busy} />;
  return children;
}
