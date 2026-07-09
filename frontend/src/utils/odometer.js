/**
 * Odometer capture for the Android app (Capacitor).
 *
 * Runs ONLY inside the native app, and only for employees whose HR has enabled
 * "Odometer tracking". When they've punched in without a START reading (or
 * punched out without an END reading), it prompts them to photograph the
 * odometer, reads the digits on-device (ML Kit, free, offline), lets them
 * confirm/correct the number, and uploads it with the photo for audit.
 *
 * Non-blocking: they can dismiss with "Later" — the backend keeps sending
 * reminder notifications and flags HR if still missing at day's end.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";
import API from "./api";

const Camera = registerPlugin("Camera");
const TextOCR = registerPlugin("CapacitorPluginMlKitTextRecognition");

let inited = false;
let modalOpen = false;
const dismissedUntil = { start: 0, end: 0 }; // cooldown after "Later"

function isNative() {
  try { return Capacitor.isNativePlatform(); } catch { return false; }
}

/** Pull the most likely odometer number out of OCR text: the longest digit run. */
function parseReading(text) {
  const groups = String(text || "").match(/\d[\d,]*/g) || [];
  let best = "";
  for (const g of groups) {
    const digits = g.replace(/\D/g, "");
    if (digits.length > best.length || (digits.length === best.length && Number(digits) > Number(best || 0))) {
      best = digits;
    }
  }
  return best;
}

async function syncOdometer() {
  if (!isNative() || modalOpen) return;
  if (!localStorage.getItem("auth_token")) return;
  let s;
  try {
    const { data } = await API.get("/tracker/odometer/my-status");
    s = data;
  } catch { return; }
  if (!s || !s.required) return;
  const now = Date.now();
  if (s.punched_in && !s.start_done && now > dismissedUntil.start) {
    openModal("start");
  } else if (s.punched_out && !s.end_done && now > dismissedUntil.end) {
    openModal("end");
  }
}

function openModal(kind) {
  if (modalOpen) return;
  modalOpen = true;
  const label = kind === "start" ? "Start of day" : "End of day";

  const wrap = document.createElement("div");
  wrap.setAttribute("style", [
    "position:fixed", "inset:0", "z-index:2147483000",
    "background:rgba(15,23,42,.55)", "display:flex", "align-items:flex-end",
    "justify-content:center", "font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif",
  ].join(";"));

  const card = document.createElement("div");
  card.setAttribute("style", [
    "background:#fff", "width:100%", "max-width:460px", "border-radius:18px 18px 0 0",
    "padding:20px 18px calc(20px + env(safe-area-inset-bottom))", "box-shadow:0 -8px 40px rgba(0,0,0,.3)",
  ].join(";"));
  card.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
      <div style="width:34px;height:34px;border-radius:9px;background:#fff1e9;color:#ff5a00;
        display:grid;place-items:center;font-size:19px">📷</div>
      <div>
        <div style="font-weight:750;font-size:16px;color:#1e2a47">${label} odometer</div>
        <div style="font-size:12.5px;color:#64748b">Photograph your odometer for travel records</div>
      </div>
    </div>
    <div id="odo-body" style="margin-top:14px"></div>
  `;
  wrap.appendChild(card);
  document.body.appendChild(wrap);
  const body = card.querySelector("#odo-body");

  const close = () => { try { document.body.removeChild(wrap); } catch (e) {} modalOpen = false; };
  const later = () => { dismissedUntil[kind] = Date.now() + 30 * 60 * 1000; close(); };

  renderCapture(body, kind, close, later);
}

function btn(labelHtml, bg, color) {
  return `padding:13px 14px;border-radius:11px;border:none;font-size:14.5px;font-weight:650;
    cursor:pointer;background:${bg};color:${color};width:100%`;
}

function renderCapture(body, kind, close, later) {
  body.innerHTML = `
    <button id="odo-shoot" style="${btn('#ff5a00', '#fff')}">Take odometer photo</button>
    <button id="odo-later" style="${btn('#f1f5f9', '#475569')};margin-top:9px">Later</button>
    <div id="odo-msg" style="color:#dc2626;font-size:12.5px;margin-top:10px;text-align:center"></div>
  `;
  body.querySelector("#odo-later").onclick = later;
  body.querySelector("#odo-shoot").onclick = async () => {
    const msg = body.querySelector("#odo-msg");
    msg.textContent = "";
    body.querySelector("#odo-shoot").textContent = "Opening camera…";
    let photo;
    try {
      photo = await Camera.getPhoto({
        quality: 55, width: 1100, allowEditing: false,
        resultType: "base64", source: "CAMERA", correctOrientation: true,
      });
    } catch (e) {
      body.querySelector("#odo-shoot").textContent = "Take odometer photo";
      return; // user cancelled the camera
    }
    const b64 = photo.base64String;
    let detected = "";
    try {
      const res = await TextOCR.detectText({ base64Image: b64 });
      detected = parseReading(res && res.text);
    } catch (e) { /* OCR failed — user types it */ }
    renderConfirm(body, kind, b64, detected, close, later);
  };
}

function renderConfirm(body, kind, b64, detected, close, later) {
  body.innerHTML = `
    <img src="data:image/jpeg;base64,${b64}" alt="odometer"
      style="width:100%;max-height:190px;object-fit:cover;border-radius:12px;border:1px solid #e2e8f0"/>
    <label style="display:block;margin:14px 0 6px;font-size:12.5px;font-weight:650;color:#475569">
      Odometer reading (km) — check it matches the photo</label>
    <input id="odo-val" inputmode="numeric" value="${detected}"
      style="width:100%;padding:13px;border:1.5px solid #cbd5e1;border-radius:11px;font-size:20px;
      font-weight:700;color:#1e2a47;text-align:center;letter-spacing:2px"/>
    <button id="odo-submit" style="${btn('#12855a', '#fff')};margin-top:14px">Confirm &amp; submit</button>
    <div style="display:flex;gap:9px;margin-top:9px">
      <button id="odo-retake" style="${btn('#f1f5f9', '#475569')}">Retake</button>
      <button id="odo-later2" style="${btn('#f1f5f9', '#475569')}">Later</button>
    </div>
    <div id="odo-msg" style="color:#dc2626;font-size:12.5px;margin-top:10px;text-align:center"></div>
  `;
  const input = body.querySelector("#odo-val");
  setTimeout(() => { try { input.focus(); } catch (e) {} }, 100);
  body.querySelector("#odo-retake").onclick = () => renderCapture(body, kind, close, later);
  body.querySelector("#odo-later2").onclick = later;
  body.querySelector("#odo-submit").onclick = async () => {
    const msg = body.querySelector("#odo-msg");
    const val = parseFloat(String(input.value).replace(/[^\d.]/g, ""));
    if (!val || val <= 0) { msg.textContent = "Enter the odometer number from the photo."; return; }
    const submit = body.querySelector("#odo-submit");
    submit.textContent = "Submitting…"; submit.disabled = true;
    try {
      await API.post("/tracker/odometer/reading", {
        kind, reading_km: val, ocr_text: detected, photo: b64,
      });
      close();
    } catch (e) {
      submit.textContent = "Confirm & submit"; submit.disabled = false;
      msg.textContent = "Couldn't submit — check your connection and try again.";
    }
  };
}

/** Call once after auth. Idempotent; no-op outside the app. */
export function initOdometer() {
  if (!isNative() || inited) return;
  inited = true;
  syncOdometer();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncOdometer();
  });
  setInterval(syncOdometer, 4 * 60 * 1000);
}
