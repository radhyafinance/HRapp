/**
 * Save a file the page has fetched (a Blob) — the one place downloads go through.
 *
 * Browsers (desktop, iPhone Safari, Android Chrome) save a hidden
 * <a download href="blob:..."> click. Android's WebView — i.e. our APK — silently
 * ignores that click, so in the app a payslip "download" did nothing at all.
 * Inside the app the bytes go to the native RadhyaFiles plugin instead (APK
 * 1.6.5+), which saves to the phone's Downloads folder and opens the file.
 * An older APK has no such plugin: say so, rather than doing nothing.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";
import { isNativeApp } from "./clientPlatform";

const RadhyaFiles = registerPlugin("RadhyaFiles");

export const APP_UPDATE_FOR_DOWNLOADS =
  "To download files in the app, please update Radhya HR to the latest version.\n\n" +
  "Or open hr.radhyafinance.com in Chrome and download it there.";

const MIME_BY_EXT = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  csv: "text/csv",
};

function mimeFor(blob, filename) {
  if (blob && blob.type) return blob.type;
  const ext = String(filename || "").split(".").pop().toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || "");
      resolve(s.slice(s.indexOf(",") + 1));      // drop the "data:...;base64," prefix
    };
    r.onerror = () => reject(r.error || new Error("Could not read the file"));
    r.readAsDataURL(blob);
  });
}

/**
 * Returns { saved: true, ... } once saved (and, in the app, opened), or
 * { saved: false, reason: "update" } when an old APK cannot save files.
 * Throws if the app tried and failed — the caller shows its own message.
 */
export async function saveBlob(blob, filename) {
  if (isNativeApp()) {
    if (!Capacitor.isPluginAvailable("RadhyaFiles")) {
      alert(APP_UPDATE_FOR_DOWNLOADS);
      return { saved: false, reason: "update" };
    }
    const data = await blobToBase64(blob);
    const res = await RadhyaFiles.saveFile({ data, filename, mimeType: mimeFor(blob, filename), open: true });
    if (res && !res.opened) {
      alert(res.location === "Downloads"
        ? `Saved to Downloads as ${res.filename}. Open it from the Files app.`
        : `Saved as ${res.filename}, but this phone has no app that can open it.`);
    }
    return { saved: true, ...(res || {}) };
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { saved: true };
}
