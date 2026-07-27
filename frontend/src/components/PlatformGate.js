/**
 * Three gates, applied in order, wrapping the whole app.
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
 * 2. APP VERSION — retires old APKs. v1.4.0 is the first build that tags its
 *    User-Agent ("RadhyaHRApp/1.4.0"); 1.2.0 and 1.3.0 tag nothing at all, so
 *    "native Android with no marker" IS the old-APK signal, not a detection
 *    failure.
 *
 *    The policy is SERVER-SIDE — minimum version, and whether being below it is
 *    a dismissible banner or a hard block — set from Settings → Mobile app. So
 *    retiring a build is a switch HR flips, not a code change per APK release.
 *    If the policy can't be read, enforcement is off.
 *
 * 3. TRACKING — for employees HR has explicitly marked as FIELD STAFF, requires
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
 *    Gate 3 applies INSIDE THE APK ONLY. Every browser is left alone: Android
 *    web is already stopped by gate 1, and desktop and iOS are deliberately
 *    exempt — there is no iOS build to send anyone to, and a desktop browser is
 *    a normal way to read a payslip rather than a way to dodge the tracker.
 *
 *    APKs older than v1.4.0 have no checkPermissions(), so gate 3 cannot tell
 *    what they granted and lets them through. That is now gate 2's job, but the
 *    fail-open stays as a backstop rather than becoming a block on a question
 *    the device cannot answer.
 *
 * FAIL OPEN, ALWAYS — with ONE deliberate exception. Every unknown (plugin
 * error, network failure, an account with no employee record) resolves to
 * "allowed"; a detection bug must never lock the field force out of punching
 * in. The exception is gate 2's missing-version case, which is fail-CLOSED on
 * purpose and explained at isOutdatedApp().
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

// ── Minimum Android app version (gate 2) ─────────────────────────────────────
// The policy — which builds are still allowed in, and whether being old is a
// banner or a block — is SERVER-SIDE, set from Settings → Mobile app. Retiring
// an APK is a switch HR flips, not an edit here and a redeploy per release.
//
// These are only the fallbacks used when the policy cannot be read. Note
// enforce defaults to FALSE: a backend hiccup must never invent a lockout.
const DEFAULT_MIN_APP_VERSION = "1.4.0";
const APP_POLICY_CACHE_KEY = "rmf_app_policy";
// Per browser session, so dismissing it silences the nag for that sitting but
// it returns next time they open the app.
const UPDATE_NAG_KEY = "rmf_update_nag_dismissed";

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

/** -1 / 0 / 1, comparing dotted versions part by part so 1.10.0 > 1.4.0. */
function compareVersions(a, b) {
  const pa = String(a).split(".");
  const pb = String(b).split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = parseInt(pa[i], 10) || 0;
    const y = parseInt(pb[i], 10) || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** The APK's version from its User-Agent marker, or null if unmarked. */
function appVersion() {
  try {
    const m = (navigator.userAgent || "").match(/RadhyaHRApp\/([0-9][0-9.]*)/i);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

/**
 * The server's app-version policy: { minVersion, enforce }.
 *
 * Cached per browser session — it changes about twice a year, and the gate runs
 * on every launch. FAILS SOFT: any error yields enforce=false, so a backend
 * outage degrades to "nobody is blocked", never to "everybody is".
 */
async function appPolicy() {
  const fallback = { minVersion: DEFAULT_MIN_APP_VERSION, enforce: false };
  try {
    const raw = sessionStorage.getItem(APP_POLICY_CACHE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p.minVersion === "string") return p;
    }
  } catch (e) { /* unreadable or corrupt cache — just re-fetch */ }
  try {
    const res = await API.get("/settings/app-version");
    const d = (res && res.data) || {};
    // Enforce ONLY on a well-formed answer. Not Boolean(d.enforce): a truthy
    // string from a half-broken backend would then lock people out on a
    // response we never actually understood. A malformed policy is a policy we
    // could not read, and an unread policy does not enforce anything.
    const versionOk = typeof d.min_version === "string" && /^\d+(\.\d+){0,3}$/.test(d.min_version);
    const p = {
      minVersion: versionOk ? d.min_version : DEFAULT_MIN_APP_VERSION,
      enforce: versionOk && d.enforce === true,
    };
    try { sessionStorage.setItem(APP_POLICY_CACHE_KEY, JSON.stringify(p)); } catch (e) { /* noop */ }
    return p;
  } catch (e) {
    return fallback;
  }
}

/** The cached policy only, for sync paths (first paint, the banner). */
function cachedPolicy() {
  try {
    const p = JSON.parse(sessionStorage.getItem(APP_POLICY_CACHE_KEY) || "null");
    return p && typeof p.minVersion === "string" ? p : null;
  } catch (e) {
    return null;
  }
}

/**
 * Is this an Android APK older than minVersion?
 *
 * THIS IS THE ONE FAIL-CLOSED CHECK IN THE FILE. A native Android client with
 * no version marker is treated as OUTDATED, not as "cannot tell". That is
 * correct here and nowhere else: the marker is a static string Capacitor bakes
 * into the WebView's User-Agent at startup, not a runtime call that can throw,
 * and the only builds that lack it are exactly the ones being retired. Failing
 * open would mean the gate never catches a single old APK, which is its entire
 * purpose.
 *
 * A thrown error is still fail-open — that is a detection failure, which is a
 * different thing from a confidently absent marker.
 */
function isOutdatedApp(minVersion) {
  try {
    if (!isNativeApp()) return false; // browsers are gate 1's business
    // Scoped to Android on purpose: there is no iOS build, so an iOS native
    // client could only ever be something unforeseen — don't nag it.
    if (!/android/i.test(navigator.userAgent || "")) return false;
    const v = appVersion();
    if (!v) return true; // unmarked == pre-1.4.0
    return compareVersions(v, minVersion || DEFAULT_MIN_APP_VERSION) < 0;
  } catch (e) {
    return false;
  }
}

/** Do the version gate's exemptions apply before we even look at the version? */
function versionGateApplies() {
  try {
    if (isPublicPath()) return false;
    // Nothing on the login screen: it is noise before anyone can act on it.
    if (!localStorage.getItem("auth_token")) return false;
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Should the "please update" banner sit over the working app right now?
 *
 * Sync, and reads only the CACHED policy — the banner is a nag, so it can wait
 * for the fetch that evaluate() already does rather than blocking first paint.
 */
function shouldNagUpdate() {
  try {
    if (!versionGateApplies()) return false;
    const p = cachedPolicy();
    if (!p) return false;
    if (!isOutdatedApp(p.minVersion)) return false;
    // Once enforcement is on, non-exempt users get the block screen instead;
    // HR sees the banner, since they are exempt from the block but still need
    // to update.
    return !p.enforce || isExemptRole();
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
    if (!isNativeApp()) return "allowed"; // gates 2 and 3 are app-only
    // A known-outdated app is decided from cache, so a returning user gets the
    // update screen straight away instead of a blank frame.
    const p = cachedPolicy();
    if (p && p.enforce && !isExemptRole() && isOutdatedApp(p.minVersion)) return "blocked-update";
    if (isExemptRole()) return "allowed";
    if (p && sessionStorage.getItem(FIELD_STAFF_CACHE_KEY) === "no") return "allowed";
  } catch (e) {
    return "allowed";
  }
  return "checking";
}

async function evaluate() {
  try {
    if (isPublicPath()) return "allowed";
    if (!localStorage.getItem("auth_token")) return "allowed";

    // Any browser — Android web is already stopped by gate 1, and desktop and
    // iOS are exempt. Checked first, so no browser ever costs an API call.
    if (!isNativeApp()) return "allowed";

    // Fetched before the role exemption on purpose: HR is exempt from the
    // BLOCK but still gets the banner, and the banner reads this cache.
    const policy = await appPolicy();
    if (isExemptRole()) return "allowed";

    // Gate 2 before gate 3 — "update the app" is something they can act on, and
    // an old APK cannot answer the permission question anyway.
    if (policy.enforce && isOutdatedApp(policy.minVersion)) return "blocked-update";

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

function UpdateRequiredScreen() {
  return (
    <div style={SHELL}>
      <div style={{ maxWidth: 420 }}>
        <Brand />
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 10px" }}>
          Please update the app
        </h1>
        <p style={{ fontSize: 15, lineHeight: 1.5, opacity: 0.85, margin: "0 0 8px" }}>
          You're using an old version of Radhya HR that is no longer supported.
          Please contact the IT team for the latest app.
        </p>
        <Contact />
        <p style={{ fontSize: 12, opacity: 0.6, margin: "20px 0 0" }}>
          Install the new app over this one — you won't lose anything, and you
          won't need to sign in again on this device.
        </p>
        <button type="button" onClick={signOut} style={LINK_BTN}>Sign out</button>
      </div>
    </div>
  );
}

/**
 * The soft version of the above: the app keeps working, with a bar along the
 * bottom. Dismissal is per session, so it nags again tomorrow rather than
 * being silenced forever by one stray tap.
 */
function UpdateBanner() {
  const [gone, setGone] = React.useState(() => {
    try { return sessionStorage.getItem(UPDATE_NAG_KEY) === "1"; } catch (e) { return false; }
  });
  if (gone) return null;
  const dismiss = () => {
    try { sessionStorage.setItem(UPDATE_NAG_KEY, "1"); } catch (e) { /* noop */ }
    setGone(true);
  };
  return (
    <div style={{
      position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 99999,
      background: "#E85B1E", color: "#fff", padding: "11px 14px",
      display: "flex", alignItems: "center", gap: 12,
      fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      boxShadow: "0 -2px 10px rgba(0,0,0,0.18)",
    }}>
      <div style={{ flex: 1, fontSize: 13.5, lineHeight: 1.45 }}>
        <strong>Update Radhya HR.</strong> You're on an old version.
        {IT_CONTACT ? ` Contact ${IT_CONTACT} for the latest app.` : " Please contact the IT team for the latest app."}
      </div>
      <button type="button" onClick={dismiss} aria-label="Dismiss"
        style={{
          background: "transparent", border: "1px solid rgba(255,255,255,0.5)",
          color: "#fff", borderRadius: 6, padding: "5px 10px",
          fontSize: 12.5, fontWeight: 700, cursor: "pointer", flexShrink: 0,
        }}>
        Dismiss
      </button>
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
  // The banner needs its OWN state, not a render-time read of the policy cache.
  // evaluate() is what fills that cache, and it usually resolves to the same
  // status we started with ("allowed") — React then skips the re-render, and a
  // cache-reading banner would never appear at all.
  const [nag, setNag] = React.useState(shouldNagUpdate);
  const [busy, setBusy] = React.useState(false);
  const tokenRef = React.useRef(null);

  const recheck = React.useCallback(async () => {
    setBusy(true);
    const next = await evaluate();
    setStatus(next);
    setNag(shouldNagUpdate());
    setBusy(false);
  }, []);

  React.useEffect(() => {
    let alive = true;
    const run = async () => {
      const next = await evaluate();
      if (!alive) return;
      setStatus(next);
      setNag(shouldNagUpdate());
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
  if (status === "blocked-update") return <UpdateRequiredScreen />;
  if (status === "blocked-app") return <LocationRequiredScreen onRecheck={recheck} busy={busy} />;
  if (nag) return <React.Fragment><UpdateBanner />{children}</React.Fragment>;
  return children;
}
