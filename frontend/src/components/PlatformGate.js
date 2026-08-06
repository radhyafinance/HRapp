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
// Versioned by SHAPE. A cache written by the previous deployed build holds only
// {minVersion, enforce}; reading that back would satisfy any "is this a policy?"
// test while silently having no apkUrl, so the Update button never appears for
// the whole session — on the release whose entire purpose is that button.
const APP_POLICY_CACHE_KEY = "rmf_app_policy_v2";
// The policy used to be cached for the life of the browser session, on the
// grounds that it changes about twice a year. That stopped being true the moment
// it started carrying the download link: on rollout day a phone caches
// {apkUrl:""} in the window between deploying the web app and pasting the link
// into Settings, and field officers keep the app resident all day — so most of
// the fleet would never see the button until they force-closed it. One small GET
// every 15 minutes of app-resume is a trade worth making for that.
const APP_POLICY_TTL_MS = 15 * 60 * 1000;
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
  const fallback = { minVersion: DEFAULT_MIN_APP_VERSION, enforce: false, latestVersion: "", apkUrl: "" };
  try {
    const raw = sessionStorage.getItem(APP_POLICY_CACHE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      // Require the download-link keys to be PRESENT, not merely truthy — an
      // empty string is a legitimate policy ("no link configured"), an absent
      // key means this cache was written by code that did not know about them.
      const fresh = typeof p?.at === "number" && (Date.now() - p.at) < APP_POLICY_TTL_MS;
      if (p && typeof p.minVersion === "string" && typeof p.apkUrl === "string" && fresh) {
        return p;
      }
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
    // Same standard for the download pair, and BOTH must be usable: an
    // "Update now" button with no link, or a link with no version to compare
    // against, is a button that does nothing on a field phone. The backend
    // refuses to store half a pair; this is the second line of that defence,
    // because the value reaching here may predate that rule.
    const latestOk = typeof d.latest_version === "string" && /^\d+(\.\d+){0,3}$/.test(d.latest_version);
    const urlOk = typeof d.apk_url === "string" && /^https:\/\/\S+$/i.test(d.apk_url);
    const p = {
      minVersion: versionOk ? d.min_version : DEFAULT_MIN_APP_VERSION,
      enforce: versionOk && d.enforce === true,
      latestVersion: latestOk && urlOk ? d.latest_version : "",
      apkUrl: latestOk && urlOk ? d.apk_url : "",
    };
    try {
      sessionStorage.setItem(APP_POLICY_CACHE_KEY, JSON.stringify({ ...p, at: Date.now() }));
    } catch (e) { /* noop */ }
    return p;
  } catch (e) {
    return fallback;
  }
}

/**
 * Is there a newer APK than the one we are running, and can we fetch it?
 *
 * Separate from isOutdatedApp() and deliberately FAIL-OPEN in the other
 * direction: an unmarked (pre-1.4.0) app counts as outdated for the block gate,
 * but here an unknown version means we cannot say a specific build is newer, so
 * we offer the update anyway — those are the phones furthest behind.
 */
function updateAvailable(policy) {
  try {
    if (!policy || !policy.apkUrl || !policy.latestVersion) return false;
    if (!isNativeApp()) return false;
    if (!/android/i.test(navigator.userAgent || "")) return false;
    const v = appVersion();
    if (!v) return true;                       // unmarked == very old
    return compareVersions(v, policy.latestVersion) < 0;
  } catch (e) {
    return false;
  }
}

/**
 * Download the new APK and hand it to Android's installer.
 *
 * This is why v1.6.0 exists as much as the tracking rewrite does. Every build
 * before it was carried to ~36 phones by hand, and the result was measured: 28
 * were still on v1.4.0 long after v1.5 shipped, and 17 of the 20 phones showing
 * as stale that day were exactly those. Server-side fixes shipped; the handsets
 * did not get them.
 *
 * Returns an error string, or null if the download started. Android shows its
 * own install confirmation afterwards — that tap cannot be removed outside the
 * Play Store, and the copy below says so rather than pretending otherwise.
 */
async function startUpdate(apkUrl) {
  try {
    if (!apkUrl) return "No update link has been set. Please contact the IT team.";
    if (!RadhyaTracker || typeof RadhyaTracker.downloadAndInstall !== "function") {
      return OLD_BUILD_MSG;
    }
    await RadhyaTracker.downloadAndInstall({ url: apkUrl });
    return null;
  } catch (e) {
    // Any APK before v1.6.0 — the very builds most in need of updating — has no
    // installer bridge. The typeof guard above does NOT catch them: Capacitor's
    // registerPlugin returns a Proxy that hands back a function for ANY name, so
    // an unimplemented method looks callable and only fails when called. Those
    // people need one last manual update and must be told so plainly, not shown
    // a raw bridge error they cannot act on.
    const msg = (e && e.message) ? String(e.message) : "";
    if (/not implement|does not exist|unimplemented|no such method/i.test(msg)) {
      return OLD_BUILD_MSG;
    }
    return msg || "Download failed. Check your connection and try again.";
  }
}
const OLD_BUILD_MSG =
  "This version can't update itself. Please contact the IT team for the new app.";

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
 * Should the "please update" banner sit over the working app right now, and in
 * which of its two tones? Returns { kind, policy } or null.
 *
 *   "required"  — below min_version. They are running a retired build.
 *   "available" — allowed, but a newer APK exists. This is the one that keeps
 *                 the fleet current: waiting until a build is RETIRED before
 *                 telling anyone is how 28 phones ended up on v1.4.0.
 *
 * Sync, and reads only the CACHED policy — the banner is a nag, so it can wait
 * for the fetch that evaluate() already does rather than blocking first paint.
 */
function updateNag() {
  try {
    if (!versionGateApplies()) return null;
    const p = cachedPolicy();
    if (!p) return null;
    if (isOutdatedApp(p.minVersion)) {
      // Once enforcement is on, non-exempt users get the block screen instead;
      // HR sees the banner, since they are exempt from the block but still need
      // to update.
      if (p.enforce && !isExemptRole()) return null;
      return { kind: "required", policy: p };
    }
    if (updateAvailable(p)) return { kind: "available", policy: p };
    return null;
  } catch (e) {
    return null;
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

/**
 * evaluate(), but it cannot hang.
 *
 * `status === "checking"` renders NOTHING — no spinner, no app. evaluate() awaits
 * two API calls, and the axios instance has no timeout, so a request that stalls
 * rather than fails (a half-open socket on a flaky tower — routine in the field)
 * never settles and leaves a white screen with no way to punch in. Every other
 * failure in this file is fail-open; this was the one hole in that, and it was
 * the worst-behaved one because it is indistinguishable from a crash.
 */
const GATE_TIMEOUT_MS = 8000;
function evaluateOrAllow() {
  return Promise.race([
    evaluate(),
    new Promise((resolve) => setTimeout(() => resolve("allowed"), GATE_TIMEOUT_MS)),
  ]).catch(() => "allowed");
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

/**
 * The download button, shared by the block screen and the banner.
 *
 * Renders nothing at all when there is no usable link, so the fallback copy
 * ("contact the IT team") is what shows — a dead button is worse than no
 * button on a phone the employee cannot troubleshoot.
 */
function UpdateButton({ apkUrl, style, label }) {
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState(null);
  const [failed, setFailed] = React.useState(false);
  if (!apkUrl) return null;
  const go = async () => {
    setBusy(true);
    setMsg(null);
    const err = await startUpdate(apkUrl);
    setBusy(false);
    setFailed(Boolean(err));
    // Success message, not silence: the download runs in Android's notification
    // shade, so without this the button looks like it did nothing for the
    // minute or two before the install prompt appears.
    setMsg(err || "Downloading… the install prompt will appear when it's ready.");
  };
  return (
    <React.Fragment>
      <button type="button" style={style || BTN} onClick={go} disabled={busy}
              data-testid="update-now">
        {busy ? "Starting…" : (label || "Update now")}
      </button>
      {msg ? (
        <p style={{
              fontSize: 12.5, lineHeight: 1.45, margin: "8px 0 0",
              // A failure and a "downloading…" used to render identically. On a
              // field phone that is the difference between waiting patiently and
              // knowing to call the office.
              opacity: failed ? 1 : 0.85,
              fontWeight: failed ? 700 : 400,
              color: failed ? "#FFD5C2" : undefined,
            }}
           data-testid="update-msg">{msg}</p>
      ) : null}
    </React.Fragment>
  );
}

function UpdateRequiredScreen({ policy }) {
  const apkUrl = (policy && policy.apkUrl) || "";
  return (
    <div style={SHELL}>
      <div style={{ maxWidth: 420 }}>
        <Brand />
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 10px" }}>
          Please update the app
        </h1>
        <p style={{ fontSize: 15, lineHeight: 1.5, opacity: 0.85, margin: "0 0 8px" }}>
          You're using an old version of Radhya HR that is no longer supported.
          {apkUrl ? " Tap Update now to install the latest version."
                  : " Please contact the IT team for the latest app."}
        </p>
        <Contact />
        <UpdateButton apkUrl={apkUrl} />
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
function UpdateBanner({ nag }) {
  const [gone, setGone] = React.useState(() => {
    try { return sessionStorage.getItem(UPDATE_NAG_KEY) === "1"; } catch (e) { return false; }
  });
  // How far up to sit so we do not cover Layout's mobile bottom navigation.
  //
  // That nav is `fixed bottom-0 z-[60]`, and this banner is `bottom-0` at
  // z-99999 — so it sat directly on top of it, including the More button that
  // opens the rest of the menu. The banner ONLY ever renders inside the Android
  // APK, so the nav is always present when it shows: on the day an update is
  // published, every phone below that version would have launched into an app
  // whose entire bottom navigation was untappable.
  //
  // Measured rather than hardcoded: the nav's height varies with the device's
  // safe-area inset, and a constant would either leave a gap or keep covering it.
  const [lift, setLift] = React.useState(0);
  React.useLayoutEffect(() => {
    if (gone) return undefined;
    const measure = () => {
      try {
        const nav = document.querySelector('[data-testid="mobile-bottom-nav"]');
        setLift(nav ? Math.round(nav.getBoundingClientRect().height) : 0);
      } catch (e) { setLift(0); }
    };
    measure();
    // Rotation changes the inset, and the nav mounts after the gate on a cold
    // start, so re-measure shortly after paint as well.
    const t = setTimeout(measure, 400);
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
    };
  }, [gone]);
  if (gone) return null;
  const policy = (nag && nag.policy) || {};
  const apkUrl = policy.apkUrl || "";
  const required = !nag || nag.kind === "required";
  const dismiss = () => {
    try { sessionStorage.setItem(UPDATE_NAG_KEY, "1"); } catch (e) { /* noop */ }
    setGone(true);
  };
  const fallback = IT_CONTACT
    ? ` Contact ${IT_CONTACT} for the latest app.`
    : " Please contact the IT team for the latest app.";
  return (
    <div data-testid="update-banner" style={{
      position: "fixed", left: 0, right: 0, bottom: lift, zIndex: 99999,
      background: "#E85B1E", color: "#fff", padding: "11px 14px",
      display: "flex", alignItems: "center", gap: 12,
      fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      boxShadow: "0 -2px 10px rgba(0,0,0,0.18)",
    }}>
      <div style={{ flex: 1, fontSize: 13.5, lineHeight: 1.45 }}>
        <strong>Update Radhya HR.</strong>{" "}
        {required
          ? "You're on an old version."
          : `Version ${policy.latestVersion} is available.`}
        {apkUrl ? "" : fallback}
        {apkUrl ? (
          <div style={{ marginTop: 6 }}>
            <UpdateButton apkUrl={apkUrl} style={{
              ...BTN, width: "auto", marginTop: 0, padding: "7px 14px",
              fontSize: 13, background: "#fff", color: "#E85B1E",
            }} />
          </div>
        ) : null}
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
  const [nag, setNag] = React.useState(updateNag);
  const [busy, setBusy] = React.useState(false);
  const tokenRef = React.useRef(null);

  const recheck = React.useCallback(async () => {
    setBusy(true);
    const next = await evaluateOrAllow();
    setStatus(next);
    setNag(updateNag());
    setBusy(false);
  }, []);

  React.useEffect(() => {
    let alive = true;
    const run = async () => {
      const next = await evaluateOrAllow();
      if (!alive) return;
      setStatus(next);
      setNag(updateNag());
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
  if (status === "blocked-update") return <UpdateRequiredScreen policy={cachedPolicy()} />;
  if (status === "blocked-app") return <LocationRequiredScreen onRecheck={recheck} busy={busy} />;
  // ALWAYS a Fragment, even with no banner. Switching between `children` and
  // `<Fragment>…{children}</Fragment>` changes the root child's element type,
  // which makes React tear down and remount the whole app the first time the
  // nag appears — losing every bit of in-progress form state with it.
  return (
    <React.Fragment>
      {nag ? <UpdateBanner nag={nag} /> : null}
      {children}
    </React.Fragment>
  );
}
