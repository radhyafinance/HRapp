/**
 * Odometer capture for the Android app (Capacitor).
 *
 * Only active inside the native app for employees whose HR enabled "Odometer
 * tracking". Photographs the odometer at start/end of day, reads the digits
 * on-device (ML Kit, free, offline), and uploads the reading + a small photo.
 *
 * Hybrid confirmation: if OCR finds exactly one plausible odometer number the
 * reading is submitted automatically (with an "Edit?" safety net); if the read
 * is empty or ambiguous, the employee confirms/corrects it first.
 *
 * Exposes captureOdometer()/getOdoStatus() so both the dashboard card and the
 * auto-popup share one code path.
 */
import { registerPlugin } from "@capacitor/core";
import API from "./api";
import { isNativeApp } from "./clientPlatform";
const Camera = registerPlugin("Camera");
const TextOCR = registerPlugin("CapacitorPluginMlKitTextRecognition");
// Small enough to keep storage/upload tiny, big enough for ML Kit to read digits.
const PHOTO_WIDTH = 800;
const PHOTO_QUALITY = 45;
let inited = false;
let busy = false;                      // a capture flow is in progress
const dismissedUntil = { start: 0, end: 0 };
function isNative() { return isNativeApp(); }
/** Returns the odometer status object, or null. Never throws.
 *  Works on web too (for the dashboard card preview); capture is still app-only. */
export async function getOdoStatus() {
  if (!localStorage.getItem("auth_token")) return null;
  try {
    const { data } = await API.get("/tracker/odometer/my-status");
    return data;
  } catch { return null; }
}
/** Pull plausible odometer numbers (4–7 digits) out of OCR text. */
function ocrCandidates(text) {
  const groups = (String(text || "").match(/\d[\d,]*/g) || [])
    .map(g => g.replace(/\D/g, "")).filter(Boolean);
  const plausible = [...new Set(groups.filter(g => g.length >= 4 && g.length <= 7))];
  plausible.sort((a, b) => b.length - a.length || Number(b) - Number(a));
  const fallback = groups.sort((a, b) => b.length - a.length)[0] || "";
  return { plausible, best: plausible[0] || fallback };
}
async function submitReading(kind, reading, ocrText, photo) {
  await API.post("/tracker/odometer/reading", {
    kind, reading_km: parseFloat(reading), ocr_text: ocrText, photo,
  });
}
/** Downscale + recompress a data URL to a small JPEG; returns raw base64. */
function downscaleDataUrl(dataUrl, maxW, quality) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxW / (img.width || maxW));
      const w = Math.round((img.width || maxW) * scale);
      const h = Math.round((img.height || maxW) * scale);
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL("image/jpeg", quality).split(",")[1] || "");
    };
    img.onerror = () => resolve((String(dataUrl).split(",")[1]) || "");
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
    input.onchange = () => {
      const file = input.files && input.files[0];
      try { document.body.removeChild(input); } catch (e) {}
      if (!file) { reject(new Error("cancelled")); return; }
      const reader = new FileReader();
      reader.onload = async () => {
        try { resolve(await downscaleDataUrl(reader.result, PHOTO_WIDTH, 0.5)); }
        catch (e) { reject(e); }
      };
      reader.onerror = () => reject(new Error("read failed"));
      reader.readAsDataURL(file);
    };
    document.body.appendChild(input);
    input.click();
  });
}
/** Get a photo (native camera on the app, file-input camera on the PWA). */
async function getPhotoBase64() {
  if (isNative()) {
    const p = await Camera.getPhoto({
      quality: PHOTO_QUALITY, width: PHOTO_WIDTH, allowEditing: false,
      resultType: "base64", source: "CAMERA", correctOrientation: true,
    });
    return { b64: p.base64String, native: true };
  }
  return { b64: await webCapturePhoto(), native: false };
}
/**
 * Full capture flow for one reading. `onDone` runs after a successful submit.
 * Opens the camera immediately, so call it from a user gesture.
 */
export async function captureOdometer(kind, onDone) {
  if (busy) return;
  busy = true;
  let b64, native;
  try {
    const r = await getPhotoBase64();
    b64 = r.b64; native = r.native;
  } catch (e) {
    busy = false;
    return; // user cancelled / no photo
  }
  if (!b64) { busy = false; return; }
  // On-device OCR only exists on the app; on the PWA the employee types it.
  let ocrText = "";
  if (native) {
    try {
      const res = await TextOCR.detectText({ base64Image: b64 });
      ocrText = res && res.text;
    } catch { /* OCR failed — fall through to manual confirm */ }
  }
  const { plausible, best } = ocrCandidates(ocrText);
  if (native && plausible.length === 1) {
    // Confident (app + one clean read): submit automatically, offer a correction.
    try {
      await submitReading(kind, plausible[0], ocrText, b64);
      busy = false;
      onDone && onDone();
      showRecordedToast(kind, plausible[0], b64, ocrText, onDone);
    } catch {
      busy = false;
      openConfirmModal(kind, b64, best, ocrText, onDone);
    }
  } else {
    // PWA, or empty/ambiguous read → confirm/enter the number.
    busy = false;
    openConfirmModal(kind, b64, best, ocrText, onDone);
  }
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
  card.setAttribute("style", [
    "background:#fff", "width:100%", "max-width:460px", "border-radius:18px 18px 0 0",
    "padding:20px 18px calc(20px + env(safe-area-inset-bottom))", "box-shadow:0 -8px 40px rgba(0,0,0,.3)",
  ].join(";"));
  wrap.appendChild(card);
  document.body.appendChild(wrap);
  const close = () => { try { document.body.removeChild(wrap); } catch (e) {} };
  return { card, close };
}
function btn(bg, color) {
  return `padding:13px 14px;border-radius:11px;border:none;font-size:14.5px;font-weight:650;
    cursor:pointer;background:${bg};color:${color};width:100%`;
}
function header(kind) {
  const label = kind === "start" ? "Start of day" : "End of day";
  return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
    <div style="width:34px;height:34px;border-radius:9px;background:#fff1e9;color:#ff5a00;
      display:grid;place-items:center;font-size:19px">📷</div>
    <div><div style="font-weight:750;font-size:16px;color:#1e2a47">${label} odometer</div>
    <div style="font-size:12.5px;color:#64748b">For your travel records</div></div></div>`;
}
/** Auto-submitted: brief confirmation with an Edit escape hatch. */
function showRecordedToast(kind, reading, b64, ocrText, onDone) {
  const { card, close } = makeModal();
  const num = Number(reading).toLocaleString("en-IN");
  card.innerHTML = `${header(kind)}
    <div style="display:flex;align-items:center;gap:10px;background:#e5f4ec;border-radius:12px;padding:14px">
      <div style="font-size:22px">✅</div>
      <div><div style="font-weight:750;color:#12855a;font-size:15px">Odometer recorded</div>
      <div style="font-size:20px;font-weight:800;color:#1e2a47;letter-spacing:1px">${num} km</div></div>
    </div>
    <button id="o-ok" style="${btn('#12855a', '#fff')};margin-top:14px">Done</button>
    <button id="o-edit" style="${btn('#f1f5f9', '#475569')};margin-top:9px">Wrong number? Edit</button>`;
  const t = setTimeout(close, 7000);
  card.querySelector("#o-ok").onclick = () => { clearTimeout(t); close(); };
  card.querySelector("#o-edit").onclick = () => {
    clearTimeout(t); close();
    openConfirmModal(kind, b64, String(reading), ocrText, onDone);
  };
}
/** Empty/ambiguous read (or Edit): confirm/correct before submitting. */
function openConfirmModal(kind, b64, prefill, ocrText, onDone) {
  const { card, close } = makeModal();
  card.innerHTML = `${header(kind)}
    <img src="data:image/jpeg;base64,${b64}" alt="odometer"
      style="width:100%;max-height:180px;object-fit:cover;border-radius:12px;border:1px solid #e2e8f0"/>
    <label style="display:block;margin:13px 0 6px;font-size:12.5px;font-weight:650;color:#475569">
      Odometer reading (km) — check it matches the photo</label>
    <input id="o-val" inputmode="numeric" value="${prefill || ""}"
      style="width:100%;padding:13px;border:1.5px solid #cbd5e1;border-radius:11px;font-size:20px;
      font-weight:700;color:#1e2a47;text-align:center;letter-spacing:2px"/>
    <button id="o-submit" style="${btn('#12855a', '#fff')};margin-top:13px">Confirm &amp; submit</button>
    <button id="o-retake" style="${btn('#f1f5f9', '#475569')};margin-top:9px">Retake photo</button>
    <div id="o-msg" style="color:#dc2626;font-size:12.5px;margin-top:9px;text-align:center"></div>`;
  const input = card.querySelector("#o-val");
  setTimeout(() => { try { input.focus(); } catch (e) {} }, 100);
  card.querySelector("#o-retake").onclick = () => { close(); captureOdometer(kind, onDone); };
  card.querySelector("#o-submit").onclick = async () => {
    const msg = card.querySelector("#o-msg");
    const val = parseFloat(String(input.value).replace(/[^\d.]/g, ""));
    if (!val || val <= 0) { msg.textContent = "Enter the odometer number from the photo."; return; }
    const submit = card.querySelector("#o-submit");
    submit.textContent = "Submitting…"; submit.disabled = true;
    try {
      await submitReading(kind, val, ocrText, b64);
      close();
      onDone && onDone();
    } catch {
      submit.textContent = "Confirm & submit"; submit.disabled = false;
      msg.textContent = "Couldn't submit — check your connection and try again.";
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
    dismissedUntil.start = now + 30 * 60 * 1000;
    captureOdometer("start");
  } else if (s.punched_out && !s.end_done && now > dismissedUntil.end) {
    dismissedUntil.end = now + 30 * 60 * 1000;
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
