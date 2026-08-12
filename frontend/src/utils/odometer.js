/**
 * Odometer capture for the Android app (Capacitor) and the PWA.
 *
 * Only active for employees whose HR enabled "Odometer tracking". Photographs
 * the odometer at start/end of day and uploads the photo together with a
 * reading the employee types in.
 *
 * The reading is ALWAYS typed by hand. An earlier build read the digits
 * on-device (ML Kit) and, when it found exactly one plausible number,
 * submitted it automatically behind a green tick. A misread never failed
 * loudly — it booked a reimbursement figure nobody looked at again. A read
 * that is right most of the time is worse than none, because people stop
 * checking it. The photo is the evidence; the typed number is the claim.
 *
 * Typing introduces its own error, so the sanity checks here cover BOTH
 * directions — a dropped digit and an extra one. They warn and let the
 * employee through; the authoritative version of the same comparison runs on
 * the server, which does not depend on the phone having had a signal.
 *
 * Exposes captureOdometer()/getOdoStatus() so both the dashboard card and the
 * auto-popup share one code path.
 */
import { registerPlugin } from "@capacitor/core";
import API from "./api";
import { isNativeApp } from "./clientPlatform";
const Camera = registerPlugin("Camera");
// Small enough to keep storage/upload tiny, big enough for the digits to be
// legible to a person auditing the photo later.
const PHOTO_WIDTH = 800;
const PHOTO_QUALITY = 45;
// Mirrors _ODO_MAX_DAY_KM in backend/routes/tracker.py. Far above any real day,
// so it only ever catches a mistyped digit.
const MAX_DAY_KM = 500;
// Matches the server's _ODO_MAX_READING_KM (2,000,000) rather than a digit
// count of its own. At 7 digits the client happily sent 9,999,999, the server
// answered 422, and the only catch in this file blamed the connection — so the
// employee retried a permanently invalid number on a working network.
const MAX_READING_KM = 2000000;
const SNOOZE_MS = 30 * 60 * 1000;
/** Fired on document after any successful submit, so the dashboard card can
 *  refresh even when it was not the thing that opened the camera. */
export const ODO_UPDATED = "radhya:odometer-updated";
let inited = false;
let busy = false;                      // a capture flow is in progress
const dismissedUntil = { start: 0, end: 0 };
function isNative() { return isNativeApp(); }
/** Returns the odometer status object, or null. Never throws.
 *  Works on web too (for the dashboard card preview); capture is still app-only. */
export async function getOdoStatus() {
  try {
    if (!localStorage.getItem("auth_token")) return null;
    const { data } = await API.get("/tracker/odometer/my-status");
    return data;
  } catch { return null; }
}
async function submitReading(kind, reading, photo, overrode) {
  const { data } = await API.post("/tracker/odometer/reading", {
    kind, reading_km: reading, photo,
    ...(overrode ? { override_warning: true } : {}),
  });
  return data || {};
}
/** Downscale + recompress a data URL to a small JPEG; returns raw base64. */
function downscaleDataUrl(dataUrl, maxW, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Every path below must settle this promise. An unsettled one leaves the
    // capture flow locked for the rest of the app session with nothing on screen.
    const t = setTimeout(() => reject(new Error("unreadable")), 15000);
    const done = (fn, v) => { clearTimeout(t); fn(v); };
    img.onload = () => {
      try {
        const scale = Math.min(1, maxW / (img.width || maxW));
        const w = Math.round((img.width || maxW) * scale);
        const h = Math.round((img.height || maxW) * scale);
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        const out = c.toDataURL("image/jpeg", quality).split(",")[1] || "";
        // A phone out of memory returns "data:," here. Uploading nothing is
        // worse than saying so — the employee would tap Capture and watch
        // nothing happen, forever.
        if (!out) { done(reject, new Error("unreadable")); return; }
        done(resolve, out);
      } catch (e) { done(reject, new Error("unreadable")); }
    };
    // Deliberately NOT a fallback to the original bytes. An image the browser
    // cannot decode is usually a HEIC or a 12MP original; uploading it raw
    // stores several MB of something the audit view then renders as a broken
    // image — the only evidence behind a reimbursement claim.
    img.onerror = () => done(reject, new Error("unreadable"));
    img.src = dataUrl;
  });
}
/** Web/PWA (incl. iOS Safari) photo capture via a camera file input. */
function webCapturePhoto() {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.setAttribute("capture", "environment"); // rear camera on phones
    input.style.display = "none";
    let settled = false;
    const cleanup = () => { try { document.body.removeChild(input); } catch (e) {} };
    const cancel = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", onFocus);
      cleanup();
      reject(new Error("cancelled"));
    };
    // Dismissing the picker fires `change` on nothing at all in most Android
    // browsers, and `cancel` only in newer Chrome. Without both of these the
    // promise never settles and the employee's Capture button silently stops
    // working until they reload the page.
    const onFocus = () => setTimeout(() => { if (!settled) cancel(); }, 1500);
    input.oncancel = cancel;
    input.onchange = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", onFocus);
      const file = input.files && input.files[0];
      cleanup();
      if (!file) { reject(new Error("cancelled")); return; }
      const reader = new FileReader();
      reader.onload = async () => {
        try { resolve(await downscaleDataUrl(reader.result, PHOTO_WIDTH, 0.5)); }
        catch (e) { reject(e); }
      };
      reader.onerror = () => reject(new Error("unreadable"));
      reader.readAsDataURL(file);
    };
    document.body.appendChild(input);
    input.click();
    setTimeout(() => window.addEventListener("focus", onFocus), 500);
  });
}
/** Get a photo (native camera on the app, file-input camera on the PWA). */
async function getPhotoBase64() {
  if (isNative()) {
    const p = await Camera.getPhoto({
      quality: PHOTO_QUALITY, width: PHOTO_WIDTH, allowEditing: false,
      resultType: "base64", source: "CAMERA", correctOrientation: true,
    });
    if (!p || !p.base64String) throw new Error("unreadable");
    return p.base64String;
  }
  return await webCapturePhoto();
}
/**
 * Full capture flow for one reading. Completion is announced via the
 * ODO_UPDATED event, not a callback — see the note at the submit handler.
 * Opens the camera immediately, so call it from a user gesture.
 */
export async function captureOdometer(kind) {
  if (busy) return;
  busy = true;
  // Started, deliberately NOT awaited, before the camera: an await here would
  // put input.click() outside the user gesture and the PWA would refuse it.
  const statusP = kind === "end" ? getOdoStatus() : null;
  let b64;
  try {
    b64 = await getPhotoBase64();
  } catch (e) {
    busy = false;
    // "cancelled" is the employee changing their mind and needs no comment.
    // Anything else means the photo did not survive, and saying nothing leaves
    // them tapping Capture and watching the screen do nothing.
    if (e && e.message === "unreadable") {
      showNotice("Couldn't use that photo",
        "The phone couldn't save the picture. Please try again — hold the camera steady and a little further back.");
    }
    return;
  }
  // Today's start reading, for the hint and the sanity check. Only meaningful
  // for the end capture; a null means the check is skipped here — the server
  // still runs it, which is why the flag HR reads is derived there.
  let startKm = null;
  if (statusP) {
    const s = await statusP;
    if (s && typeof s.start_km === "number" && isFinite(s.start_km)) startKm = s.start_km;
  }
  // `busy` deliberately stays set until the modal is finished with. It is the
  // only thing stopping the auto-popup from opening the camera over an open
  // modal and stacking a second one on top — which it can, because the reading
  // is still outstanding until this modal submits.
  openConfirmModal(kind, b64, startKm);
}
// ── modal plumbing ────────────────────────────────────────────────
function makeModal() {
  const wrap = document.createElement("div");
  wrap.setAttribute("style", [
    "position:fixed", "inset:0", "z-index:2147483000", "background:rgba(15,23,42,.55)",
    "display:flex", "align-items:flex-end", "justify-content:center",
    "font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif",
  ].join(";"));
  const card = document.createElement("div");
  // The sheet must scroll. With the numeric keypad up on a 360x640 phone the
  // card is taller than what is left of the screen, and it overflows off the
  // TOP of a flex-end container — unreachable by any gesture. The photo went
  // off-screen at the exact moment the warning said "check the photo".
  card.setAttribute("style", [
    "background:#fff", "width:100%", "max-width:460px", "border-radius:18px 18px 0 0",
    "padding:20px 18px calc(20px + env(safe-area-inset-bottom))", "box-shadow:0 -8px 40px rgba(0,0,0,.3)",
    // box-sizing is what makes max-height mean anything here. Without it the
    // 20px padding sits OUTSIDE the clamp, so the card is always exactly 40px
    // taller than the viewport and its top 40px — the heading — cannot be
    // scrolled to at any offset. The input and buttons already set it; the card
    // was the one that was missed.
    "box-sizing:border-box", "max-height:100%", "overflow-y:auto", "overscroll-behavior:contain",
  ].join(";"));
  wrap.appendChild(card);
  document.body.appendChild(wrap);
  const close = () => { try { document.body.removeChild(wrap); } catch (e) {} };
  return { card, close };
}
function btn(bg, color) {
  // 15px padding keeps these at ~48px tall. At 13px they were 43px, under the
  // minimum, on a sheet used outdoors with wet hands.
  return `padding:15px 14px;border-radius:11px;border:none;font-size:14.5px;font-weight:650;
    cursor:pointer;background:${bg};color:${color};width:100%;box-sizing:border-box`;
}
function header(kind) {
  const label = kind === "start" ? "Start of day" : "End of day";
  return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
    <div style="width:34px;height:34px;border-radius:9px;background:#fff1e9;color:#ff5a00;
      display:grid;place-items:center;font-size:19px">📷</div>
    <div><div style="font-weight:750;font-size:16px;color:#1e2a47">${label} odometer</div>
    <div style="font-size:12.5px;color:#64748b">For your travel records</div></div></div>`;
}
const fmtKm = (n) => Number(n).toLocaleString("en-IN");
/** A dead end with an explanation, rather than a screen that does nothing. */
function showNotice(title, body) {
  const { card, close } = makeModal();
  card.innerHTML = `
    <div style="font-weight:750;font-size:16px;color:#1e2a47;margin-bottom:6px">${title}</div>
    <div style="font-size:13.5px;color:#475569;line-height:1.45">${body}</div>
    <button id="o-ok" style="${btn('#f1f5f9', '#475569')};margin-top:14px">OK</button>`;
  card.querySelector("#o-ok").onclick = close;
}
/** Brief receipt after a successful submit. This is the employee's only proof
 *  that their travel claim for the day actually landed. */
function showRecorded(kind, reading, serverReview) {
  const { card, close } = makeModal();
  const note = serverReview
    ? `<div style="font-size:12.5px;color:#b45309;background:#fffbeb;border:1px solid #fde68a;
         border-radius:9px;padding:9px;margin-top:11px">
         ${serverReview === "below_start"
           ? "This is lower than your start-of-day reading."
           : `That is more than ${MAX_DAY_KM} km in one day.`}
         It has been saved, and HR will check it against your photo.</div>`
    : "";
  card.innerHTML = `${header(kind)}
    <div style="display:flex;align-items:center;gap:10px;background:#e5f4ec;border-radius:12px;padding:14px">
      <div style="font-size:22px">✅</div>
      <div><div style="font-weight:750;color:#12855a;font-size:15px">Odometer recorded</div>
      <div style="font-size:20px;font-weight:800;color:#1e2a47;letter-spacing:1px">${fmtKm(reading)} km</div></div>
    </div>${note}
    <button id="o-ok" style="${btn('#12855a', '#fff')};margin-top:13px">Done</button>`;
  const t = setTimeout(close, serverReview ? 12000 : 5000);
  card.querySelector("#o-ok").onclick = () => { clearTimeout(t); close(); };
}
/** Devanagari and Arabic-Indic numerals to ASCII, then digits only.
 *  A Hindi keyboard types ४५१२० — every character of which the old strip
 *  removed, leaving "Enter the odometer number" on screen next to the number
 *  the employee had just entered, with no way forward.
 *  Digits only, no decimal point: "45.120" typed as a thousands separator
 *  parsed to 45.12 and booked a 45,000 km day. Odometers read in whole km. */
function readDigits(v) {
  return String(v == null ? "" : v)
    .replace(/[०-९]/g, (c) => String(c.charCodeAt(0) - 0x0966))
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    // A trailing .N or .NN is a decimal fraction — trip meters show tenths.
    // Stripping every dot turned 45120.7 into 451207, which is worse than the
    // 45.12 it was written to prevent. Longer dotted groups are separators.
    .replace(/[^\d.]/g, "")
    .replace(/\.(\d{1,2})$/, "")
    .replace(/\D/g, "")
    // Leading zeros are a stutter on the 0 key, not a digit count. Counting
    // them refused "00045120" with "too many digits — check the photo", about
    // a photo the employee had already read correctly.
    .replace(/^0+(?=\d)/, "");
}
/** Type the number off the photo, then submit. The only submit path. */
function openConfirmModal(kind, b64, startKm) {
  const { card, close } = makeModal();
  // The previous reading is shown, never prefilled. Putting a number in the box
  // is how you get people confirming a number they never looked at.
  const hint = (kind === "end" && startKm != null)
    ? `<div style="font-size:13px;color:#475569;margin-top:8px;text-align:center">
         Your start-of-day reading was <strong>${fmtKm(startKm)} km</strong></div>`
    : "";
  card.innerHTML = `${header(kind)}
    <!-- contain, not cover. cover centre-crops a portrait phone photo to its
         middle 42%, which is precisely where the odometer is not: the employee
         was shown the windscreen and asked to type a number he could not see. -->
    <img src="data:image/jpeg;base64,${b64}" alt="odometer"
      style="width:100%;height:34vh;max-height:230px;object-fit:contain;background:#f1f5f9;
      border-radius:12px;border:1px solid #e2e8f0"/>
    <label style="display:block;margin:13px 0 6px;font-size:12.5px;font-weight:650;color:#475569">
      Type the odometer reading (km) from the photo</label>
    <input id="o-val" inputmode="numeric" value=""
      style="box-sizing:border-box;width:100%;padding:13px;border:1.5px solid #cbd5e1;border-radius:11px;
      font-size:20px;font-weight:700;color:#1e2a47;text-align:center;letter-spacing:2px"/>
    ${hint}
    <!-- Above the buttons, not below them. With the numeric keypad up there is
         about one button's worth of screen left, and a warning printed under
         Retake is a warning nobody reads. -->
    <div id="o-msg" style="color:#dc2626;font-size:13px;margin-top:9px;text-align:center;line-height:1.4"></div>
    <button id="o-submit" style="${btn('#12855a', '#fff')};margin-top:13px">Confirm &amp; submit</button>
    <button id="o-retake" style="${btn('#f1f5f9', '#475569')};margin-top:9px">Retake photo</button>
    <button id="o-later" style="${btn('#fff', '#94a3b8')};margin-top:4px">Not now</button>`;
  const input = card.querySelector("#o-val");
  const msg = card.querySelector("#o-msg");
  const submit = card.querySelector("#o-submit");
  const finish = () => { busy = false; close(); };
  setTimeout(() => { try { input.focus(); } catch (e) {} }, 100);
  // Release before re-entering, or captureOdometer's own guard turns Retake into
  // a dead button.
  card.querySelector("#o-retake").onclick = () => { finish(); captureOdometer(kind); };
  // Without this the sheet has no exit but submitting. It covers everything at
  // the top z-index, it is outside the React tree so navigation does not clear
  // it, and there is no back-button handler — so an employee who cannot read
  // their odometer right now (wrong photo, vehicle already locked up) had a
  // choice between inventing a number and force-quitting the app.
  card.querySelector("#o-later").onclick = () => {
    dismissedUntil[kind] = Date.now() + SNOOZE_MS;
    finish();
  };
  /** Why this value needs a second look, or "". Recomputed on every tap — a
   *  latch set on the first tap survived the employee CORRECTING the number,
   *  so a fixed reading still arrived flagged, and the flag HR reads would
   *  have been mostly false within a week. */
  const reviewReason = (val) => {
    if (kind !== "end" || startKm == null) return "";
    if (val < startKm) return `That is lower than this morning's ${fmtKm(startKm)} km.`;
    if (val - startKm > MAX_DAY_KM) return `That is ${fmtKm(val - startKm)} km in one day.`;
    return "";
  };
  let confirmedValue = null;   // the exact value the employee has already been warned about
  const setLabel = (warn) => {
    submit.textContent = warn ? "Submit anyway" : "Confirm & submit";
    submit.style.background = warn ? "#b45309" : "#12855a";
  };
  submit.onclick = async () => {
    const digits = readDigits(input.value);
    if (!digits || Number(digits) <= 0) {
      msg.textContent = "Enter the odometer number from the photo.";
      setLabel(false); confirmedValue = null;
      return;
    }
    if (Number(digits) > MAX_READING_KM) {
      msg.textContent = "That is too many digits — check the photo and enter the odometer number only.";
      setLabel(false); confirmedValue = null;
      return;
    }
    const val = Number(digits);
    const reason = reviewReason(val);
    if (reason && confirmedValue !== val) {
      confirmedValue = val;
      msg.textContent = `${reason} Check the photo — tap again to submit it anyway.`;
      setLabel(true);
      // The warning grows the sheet upward, so "Submit anyway" lands on the same
      // pixel Confirm was on. On a laggy phone the natural response to a button
      // that appears not to have worked is to tap it again — which would clear a
      // guard nobody read. Make the second tap a separate decision.
      submit.disabled = true;
      setTimeout(() => { try { submit.disabled = false; } catch (e) {} }, 700);
      return;
    }
    if (!reason) { setLabel(false); confirmedValue = null; msg.textContent = ""; }
    const label = submit.textContent;
    submit.textContent = "Submitting…"; submit.disabled = true;
    try {
      const res = await submitReading(kind, val, b64, !!reason);
      finish();
      // The server ran the same comparison with data the phone may not have had.
      showRecorded(kind, val, res.review || null);
      // The ONE notification path. This used to also call onDone(), and the
      // dashboard card listens for this event as well — so a capture started
      // from the card fired two /my-status requests for one submit, on the
      // connection least able to spare them.
      try { document.dispatchEvent(new Event(ODO_UPDATED)); } catch (e) {}
    } catch (e) {
      submit.textContent = label;
      submit.disabled = false;
      // A 4xx is the server refusing this number; it will refuse it again.
      // Telling the employee to check a connection that is plainly working
      // sends them round the same loop forever.
      const code = e && e.response && e.response.status;
      msg.textContent = (code >= 400 && code < 500)
        ? "The server would not accept that reading — check the photo and enter the number again."
        : "Couldn't submit — check your connection and try again.";
    }
  };
}
// ── auto-popup (in addition to the dashboard card) ────────────────
async function autoPrompt() {
  if (busy) return;
  const s = await getOdoStatus();
  if (!s || !s.required) return;
  const now = Date.now();
  if (s.punched_in && !s.start_done && now > dismissedUntil.start) {
    dismissedUntil.start = now + SNOOZE_MS;
    captureOdometer("start");
  } else if (s.punched_out && !s.end_done && now > dismissedUntil.end) {
    dismissedUntil.end = now + SNOOZE_MS;
    captureOdometer("end");
  }
}
/** Call once after auth. Idempotent; no-op outside the app. */
export function initOdometer() {
  if (!isNative() || inited) return;
  inited = true;
  autoPrompt();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") autoPrompt();
  });
  setInterval(autoPrompt, 6 * 60 * 1000);
}
