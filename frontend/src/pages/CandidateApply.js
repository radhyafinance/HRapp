/**
 * Public candidate self-onboarding form.
 *
 * Open with no auth. Validates the invite token first, then collects:
 *   - Name, mobile, email
 *   - Aadhaar front + back (image, auto-compressed <1 MB)
 *   - PAN card (image, auto-compressed)
 *   - Passport-size photo (image, auto-compressed)
 *   - CV (PDF or image)
 *
 * On submit, OCR runs server-side and a Candidate record is created.
 */
import React, { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import axios from "axios";
import { CheckCircle2, AlertTriangle, Upload, FileText, Loader2 } from "lucide-react";
import { useFieldUnique, UniqueHint, uniqueBorderClass } from "../hooks/useFieldUnique";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";
const MAX_BYTES = 1_000_000;       // 1 MB target after compression
const MAX_DIM = 1600;              // resize down to this on the longer side
const COMPRESS_QUALITY_STEPS = [0.85, 0.75, 0.65, 0.55, 0.45, 0.35];

/** Compress an image File to under MAX_BYTES using canvas + jpeg quality steps. */
async function compressImage(file) {
  if (!file.type.startsWith("image/")) return file;
  if (file.size <= MAX_BYTES) return file;

  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  const img = await new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = dataUrl;
  });
  let { width: w, height: h } = img;
  if (Math.max(w, h) > MAX_DIM) {
    const ratio = MAX_DIM / Math.max(w, h);
    w = Math.round(w * ratio);
    h = Math.round(h * ratio);
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);

  for (const q of COMPRESS_QUALITY_STEPS) {
    const blob = await new Promise(res => canvas.toBlob(res, "image/jpeg", q));
    if (blob && blob.size <= MAX_BYTES) {
      return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
    }
  }
  // Fallback: return the smallest blob (may still exceed). Server enforces a 1.1MB hard cap.
  const final = await new Promise(res => canvas.toBlob(res, "image/jpeg", 0.3));
  return new File([final], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
}

const FieldFile = ({ label, accept, file, setFile, hint, testId }) => {
  const ref = useRef(null);
  const [working, setWorking] = useState(false);
  const onPick = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setWorking(true);
    try {
      const compressed = f.type.startsWith("image/") ? await compressImage(f) : f;
      if (compressed.size > 1_100_000) {
        alert(`${label}: file is still ${(compressed.size / 1024).toFixed(0)} KB after compression. Please upload a smaller image.`);
        ref.current.value = "";
        return;
      }
      setFile(compressed);
    } finally {
      setWorking(false);
    }
  };
  return (
    <div>
      <label className="block text-xs font-bold text-slate-700 mb-1.5 uppercase tracking-wider">{label}*</label>
      <button
        type="button"
        onClick={() => ref.current.click()}
        data-testid={testId}
        className={`w-full border-2 border-dashed ${file ? "border-green-300 bg-green-50/50" : "border-slate-300 bg-slate-50/50"} rounded-xl px-4 py-3 text-sm flex items-center gap-3 hover:border-[#E85B1E] hover:bg-[#E85B1E]/5 transition-colors`}
      >
        {working
          ? <Loader2 size={18} className="text-[#E85B1E] animate-spin" />
          : file
            ? <CheckCircle2 size={18} className="text-green-600" />
            : <Upload size={18} className="text-slate-400" />}
        <div className="flex-1 text-left min-w-0">
          {file ? (
            <>
              <p className="text-sm font-medium text-slate-700 truncate">{file.name}</p>
              <p className="text-[11px] text-slate-500">{(file.size / 1024).toFixed(0)} KB · click to replace</p>
            </>
          ) : (
            <>
              <p className="text-sm text-slate-600">{working ? "Compressing..." : "Click to upload"}</p>
              <p className="text-[11px] text-slate-400">{hint}</p>
            </>
          )}
        </div>
      </button>
      <input ref={ref} type="file" accept={accept} className="hidden" onChange={onPick} />
    </div>
  );
};

export default function CandidateApply() {
  const { token } = useParams();

  const [checking, setChecking] = useState(true);
  const [linkValid, setLinkValid] = useState(false);
  const [linkError, setLinkError] = useState("");

  const [mobile, setMobile] = useState("");
  const [email, setEmail] = useState("");

  // Real-time uniqueness checks
  const mobileCheck = useFieldUnique("mobile", mobile, {}, 10);
  const emailCheck  = useFieldUnique("email",  email,  {}, 5);
  const hasConflict = mobileCheck.exists === true || emailCheck.exists === true;

  const [aadhaarFront, setAadhaarFront] = useState(null);
  const [aadhaarBack, setAadhaarBack] = useState(null);
  const [panCard, setPanCard] = useState(null);
  const [cv, setCv] = useState(null);

  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    axios.get(`${API}/public/candidate-invite/${token}`)
      .then(r => { if (active) setLinkValid(!!r.data.valid); })
      .catch(e => { if (active) setLinkError(e.response?.data?.detail || "This link is invalid."); })
      .finally(() => active && setChecking(false));
    return () => { active = false; };
  }, [token]);

  const valid = /^\d{10}$/.test(mobile.trim()) && /^\S+@\S+\.\S+$/.test(email.trim()) && aadhaarFront && aadhaarBack && panCard && cv && !hasConflict;

  const submit = async (e) => {
    e.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const fd = new FormData();
      fd.append("mobile", mobile.trim());
      fd.append("email", email.trim());
      fd.append("aadhaar_front", aadhaarFront);
      fd.append("aadhaar_back", aadhaarBack);
      fd.append("pan_card", panCard);
      fd.append("cv", cv);
      const res = await axios.post(`${API}/public/candidate-invite/${token}/submit`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 120000,
      });
      setSuccess(res.data);
    } catch (e) {
      setError(e.response?.data?.detail || "Submission failed. Please try again or contact HR.");
    } finally {
      setSubmitting(false);
    }
  };

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-center">
          <Loader2 size={32} className="text-[#E85B1E] animate-spin mx-auto mb-3" />
          <p className="text-sm text-slate-500">Checking link...</p>
        </div>
      </div>
    );
  }

  if (!linkValid) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <div className="bg-white border border-red-200 rounded-2xl p-8 max-w-md text-center" data-testid="invite-invalid">
          <div className="w-14 h-14 mx-auto rounded-full bg-red-100 flex items-center justify-center mb-4">
            <AlertTriangle size={28} className="text-red-600" />
          </div>
          <h1 className="text-xl font-bold text-slate-800 mb-2" style={{ fontFamily: "'Outfit', sans-serif" }}>Link Unavailable</h1>
          <p className="text-sm text-slate-600">{linkError || "This link is no longer valid."}</p>
          <p className="text-xs text-slate-400 mt-4">Please contact Radhya HR for a fresh link.</p>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <div className="bg-white border border-green-200 rounded-2xl p-8 max-w-md text-center" data-testid="invite-success">
          <div className="w-14 h-14 mx-auto rounded-full bg-green-100 flex items-center justify-center mb-4">
            <CheckCircle2 size={28} className="text-green-600" />
          </div>
          <h1 className="text-xl font-bold text-slate-800 mb-2" style={{ fontFamily: "'Outfit', sans-serif" }}>Submitted Successfully</h1>
          <p className="text-sm text-slate-600">{success.message}</p>
          <p className="text-xs text-slate-400 mt-4">Our HR team will reach out to you shortly. You can close this window now.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 py-8 px-4">
      <div className="max-w-2xl mx-auto">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>Radhya Micro Finance</h1>
          <p className="text-sm text-slate-500">Candidate Onboarding</p>
        </div>

        <form onSubmit={submit} className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 shadow-sm space-y-5">
          <div>
            <h2 className="font-bold text-[#1E2A47] mb-1" style={{ fontFamily: "'Outfit', sans-serif" }}>Contact Details</h2>
            <p className="text-xs text-slate-500 mb-4">We&apos;ll auto-fill your name from your Aadhaar/PAN — just give us a way to reach you.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5 uppercase tracking-wider">Mobile* (10 digits)</label>
                <input value={mobile} onChange={e => setMobile(e.target.value.replace(/\D/g, "").slice(0, 10))} data-testid="apply-mobile"
                  inputMode="numeric" placeholder="9876543210"
                  className={`w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none ${uniqueBorderClass(mobileCheck, mobile, 10)}`} />
                <UniqueHint {...mobileCheck} value={mobile} minLen={10} />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5 uppercase tracking-wider">Email*</label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} data-testid="apply-email"
                  placeholder="you@example.com"
                  className={`w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none ${uniqueBorderClass(emailCheck, email, 5)}`} />
                <UniqueHint {...emailCheck} value={email} minLen={5} />
              </div>
            </div>
          </div>

          <div className="border-t border-slate-100 pt-5">
            <h2 className="font-bold text-[#1E2A47] mb-1" style={{ fontFamily: "'Outfit', sans-serif" }}>Documents</h2>
            <p className="text-xs text-slate-500 mb-4">Images will be auto-compressed to under 1 MB before upload.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <FieldFile label="Aadhaar — Front" accept="image/*" hint="JPG/PNG · clear photo of front side"
                file={aadhaarFront} setFile={setAadhaarFront} testId="apply-aadhaar-front" />
              <FieldFile label="Aadhaar — Back" accept="image/*" hint="JPG/PNG · clear photo of back side"
                file={aadhaarBack} setFile={setAadhaarBack} testId="apply-aadhaar-back" />
              <FieldFile label="PAN Card" accept="image/*" hint="JPG/PNG · clear photo"
                file={panCard} setFile={setPanCard} testId="apply-pan" />
              <FieldFile label="CV / Resume" accept="application/pdf,image/*" hint="PDF preferred, max 1 MB"
                file={cv} setFile={setCv} testId="apply-cv" />
            </div>
          </div>

          {error && (
            <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm flex items-start gap-2" data-testid="apply-error">
              <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button type="submit" disabled={!valid || submitting} data-testid="apply-submit"
            className="w-full py-3 bg-[#E85B1E] text-white rounded-xl font-bold text-sm hover:bg-[#D04A15] disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2">
            {submitting ? (
              <>
                <Loader2 size={16} className="animate-spin" /> Uploading and verifying documents... (this may take ~30 sec)
              </>
            ) : (
              <>
                <FileText size={16} /> Submit My Application
              </>
            )}
          </button>
          {!submitting && !valid && (
            <p className="text-[11px] text-slate-400 text-center">
              {hasConflict ? "This mobile or email is already registered. Please use a different one." : "Fill in all fields and upload all four documents to enable submit."}
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
