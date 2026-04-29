// Compress image client-side so the resulting file is under TARGET_BYTES.
// Tries decreasing JPEG quality and downscaling until size fits.
export async function compressImage(file, { maxBytes = 1024 * 1024, maxDimension = 1920, mime = "image/jpeg" } = {}) {
  if (!file) return file;
  if (file.size <= maxBytes && /^image\/(jpe?g|png|webp)$/i.test(file.type)) return file;
  if (!file.type.startsWith("image/")) return file;
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = (e) => resolve(e.target.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = dataUrl;
  });
  let { width, height } = img;
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  width = Math.round(width * scale);
  height = Math.round(height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  const qualities = [0.85, 0.75, 0.65, 0.55, 0.45, 0.35];
  let blob = null;
  for (const q of qualities) {
    blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, q));
    if (blob && blob.size <= maxBytes) break;
  }
  if (blob && blob.size > maxBytes) {
    for (const s of [0.75, 0.6, 0.5, 0.4]) {
      const w2 = Math.round(width * s);
      const h2 = Math.round(height * s);
      const c2 = document.createElement("canvas");
      c2.width = w2;
      c2.height = h2;
      const cx = c2.getContext("2d");
      cx.fillStyle = "#FFFFFF";
      cx.fillRect(0, 0, w2, h2);
      cx.drawImage(img, 0, 0, w2, h2);
      blob = await new Promise((resolve) => c2.toBlob(resolve, mime, 0.7));
      if (blob && blob.size <= maxBytes) break;
    }
  }
  if (!blob) return file;
  const renamed = (file.name || "image").replace(/\.[^.]+$/, ".jpg");
  return new File([blob], renamed, { type: mime, lastModified: Date.now() });
}

// Returns { base64, mime } for use with API payloads
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = (e) => {
      const b64 = e.target.result.split(",")[1];
      resolve({ base64: b64, mime: file.type || "image/jpeg" });
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// Returns just the base64 string
export function fileToBase64String(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = (e) => resolve(e.target.result.split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
