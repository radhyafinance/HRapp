import React, { useState } from "react";
import { RefreshCw, Upload, Keyboard, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import API from "../../utils/api";
import { compressImage, fileToBase64 } from "../../utils/imageCompression";
import { useFieldUnique, UniqueHint } from "../../hooks/useFieldUnique";
import { aadhaarIsValid, panIsValid } from "../../utils/kycIds";

// "Fix KYC details" — for a candidate whose Aadhaar or PAN didn't come through:
// a masked Aadhaar, a blurry photo, or a scan that simply missed. Three ways out,
// in the order HR should try them: replace the image and re-scan it, re-scan the
// images already on file, or type the number by hand. The server validates and
// de-duplicates whatever is saved (routes/candidates.py, _check_kyc_numbers).

const LABELS = {
  first_name: "First name", last_name: "Last name", dob: "Date of birth", gender: "Gender",
  father_or_husband_name: "Father / Husband", aadhaar_number: "Aadhaar number",
  pan_number: "PAN", address: "Address", city: "City", state: "State", pincode: "Pincode",
};

// Turn a scan result into candidate fields. The Aadhaar scan returns one "name";
// the record keeps first and last name apart, split the way the rest of the app does.
function scanToFields(scan) {
  const out = {};
  const a = scan.aadhaar;
  if (a) {
    if (a.name) {
      const parts = String(a.name).trim().split(/\s+/);
      out.first_name = parts[0] || "";
      out.last_name = parts.slice(1).join(" ");
    }
    ["dob", "gender", "father_or_husband_name", "address", "city", "state", "pincode"]
      .forEach((k) => { if (a[k]) out[k] = a[k]; });
    if (a.aadhaar_number) out.aadhaar_number = a.aadhaar_number;   // only ever a VALID number
  }
  const p = scan.pan;
  if (p) {
    if (p.pan_number) out.pan_number = p.pan_number;
    if (p.dob && !out.dob) out.dob = p.dob;
    if (p.father_name && !out.father_or_husband_name) out.father_or_husband_name = p.father_name;
  }
  return out;
}

export function KycFixPanel({ candidate, docsMeta, onChanged }) {
  const [mode, setMode] = useState(null);          // null | "aadhaar" | "pan" | "manual"
  const [files, setFiles] = useState({});           // aadhaar_front | aadhaar_back | pan_card -> File
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(null);     // { scan, current, fields, ticks }
  const [manual, setManual] = useState({ aadhaar_number: "", pan_number: "" });
  const [extra, setExtra] = useState({});           // other blank KYC fields typed by hand
  const [done, setDone] = useState("");

  const aadhaarCheck = useFieldUnique("aadhaar_number", manual.aadhaar_number,
    { excludeCandidateId: candidate.id }, 12);
  const panCheck = useFieldUnique("pan_number", manual.pan_number,
    { excludeCandidateId: candidate.id }, 10);

  if (candidate.status === "converted") return null;

  const hasAadhaarImg = docsMeta && (docsMeta.aadhaar_front || docsMeta.aadhaar_back);
  const hasPanImg = docsMeta && docsMeta.pan_card;
  const aadhaarOk = aadhaarIsValid(candidate.aadhaar_number);
  const panOk = panIsValid(candidate.pan_number);
  const lastScan = candidate.ocr_status?.aadhaar_status;

  const reset = () => { setMode(null); setFiles({}); setError(""); setPreview(null); setBusy(""); };

  const runScan = async (which) => {
    setBusy("Scanning…");
    const res = await API.post(`/candidates/${candidate.id}/kyc/scan`, which);
    const fields = scanToFields(res.data.scan);
    const current = res.data.current || {};
    // Pre-tick only what is BLANK on file: a filled value may have been
    // corrected by hand, and a fresh scan is not automatically better.
    const ticks = {};
    const usable = (k, v) => (k === "aadhaar_number" ? aadhaarIsValid(v)
                              : k === "pan_number" ? panIsValid(v) : !!v);
    // An invalid number on file (e.g. a masked "XXXXXXXX1234") counts as blank.
    Object.keys(fields).forEach((k) => { ticks[k] = !usable(k, current[k]) && !!fields[k]; });
    setPreview({ scan: res.data.scan, current, fields, ticks });
  };

  const uploadAndScan = async () => {
    setError("");
    const keys = mode === "aadhaar" ? ["aadhaar_front", "aadhaar_back"] : ["pan_card"];
    const chosen = keys.filter((k) => files[k]);
    if (!chosen.length) { setError(mode === "aadhaar" ? "Choose the front, the back, or both." : "Choose the PAN card image."); return; }
    let uploaded = false;
    try {
      setBusy("Uploading…");
      const payload = {};
      for (const k of chosen) {
        const small = await compressImage(files[k], { maxBytes: 1024 * 1024 });
        const f = await fileToBase64(small);
        payload[`${k}_base64`] = f.base64;
        payload[`${k}_mime`] = f.mime;
      }
      await API.post(`/candidates/${candidate.id}/documents`, payload);
      uploaded = true;
      onChanged && onChanged(null);   // documents changed: let the parent reload them
      await runScan(mode === "aadhaar" ? { aadhaar: true, pan: false } : { aadhaar: false, pan: true });
    } catch (e) {
      const why = e.response?.data?.detail || "please try again";
      if (uploaded) {
        // The images ARE replaced; only reading them failed. Back to the buttons
        // so HR can simply press Re-scan.
        setMode(null);
        setError(`The new images were saved, but the scan failed (${why}). Press Re-scan to try again.`);
      } else {
        setError(`Upload failed: ${why}`);
      }
    } finally { setBusy(""); }
  };

  const rescan = async () => {
    setError(""); setMode("rescan");
    try { await runScan({ aadhaar: !!hasAadhaarImg, pan: !!hasPanImg }); }
    catch (e) {
      setMode(null);   // otherwise the panel is left with no buttons at all
      setError(e.response?.data?.detail || "Scan failed. Please try again.");
    }
    finally { setBusy(""); }
  };

  const apply = async (fields, source) => {
    setError("");
    try {
      setBusy("Saving…");
      const res = await API.post(`/candidates/${candidate.id}/kyc/apply`, { fields, source });
      setDone(res.data.kyc_complete ? "Saved. KYC details are complete."
                                    : `Saved. Still needed: ${res.data.kyc_reason || ""}`);
      reset();
      setManual({ aadhaar_number: "", pan_number: "" });
      setExtra({});
      onChanged && onChanged(res.data.candidate);
    } catch (e) {
      setError(e.response?.data?.detail || "Could not save.");
      setBusy("");
    }
  };

  const applyPreview = () => {
    const f = {};
    Object.entries(preview.ticks).forEach(([k, on]) => { if (on) f[k] = preview.fields[k]; });
    if (!Object.keys(f).length) { setError("Tick at least one field to apply."); return; }
    apply(f, "scan");
  };

  const saveManual = () => {
    const f = {};
    if (manual.aadhaar_number) f.aadhaar_number = manual.aadhaar_number;
    if (manual.pan_number) f.pan_number = manual.pan_number;
    Object.entries(extra).forEach(([k, v]) => { if (String(v || "").trim()) f[k] = String(v).trim(); });
    if (!Object.keys(f).length) { setError("Enter at least one detail."); return; }
    apply(f, "manual");
  };

  const aadhaarScanMsg = preview?.scan?.aadhaar && preview.scan.aadhaar.aadhaar_status !== "ok"
    ? preview.scan.aadhaar.aadhaar_message : "";
  const manualAadhaarBad = manual.aadhaar_number.length === 12 && !aadhaarIsValid(manual.aadhaar_number);
  const manualPanBad = manual.pan_number.length === 10 && !panIsValid(manual.pan_number);
  // The other KYC fields the joining kit needs, offered only when blank on file:
  // a scan that cannot read S/O or the address (newer cards often omit S/O)
  // otherwise left no way at all to fill them in.
  const EXTRA_FIELDS = ["first_name", "last_name", "dob", "gender", "father_or_husband_name", "address"]
    .filter((k) => !String(candidate[k] || "").trim());
  const hasExtra = Object.values(extra).some((v) => String(v || "").trim());
  const manualReady = (manual.aadhaar_number || manual.pan_number || hasExtra)
    && (!manual.aadhaar_number || (aadhaarIsValid(manual.aadhaar_number) && aadhaarCheck.exists !== true))
    && (!manual.pan_number || (panIsValid(manual.pan_number) && panCheck.exists !== true));

  const FilePick = ({ k, label }) => (
    <label className="flex-1 border border-dashed border-slate-300 rounded-lg p-2 text-xs text-slate-600 cursor-pointer hover:bg-slate-50">
      <span className="font-semibold block">{label}</span>
      <span className="text-slate-400 truncate block">{files[k] ? files[k].name : "Choose image…"}</span>
      <input type="file" accept="image/*" className="hidden" data-testid={`kyc-file-${k}`}
        onChange={(e) => setFiles((p) => ({ ...p, [k]: e.target.files?.[0] || null }))} />
    </label>
  );

  return (
    <div className="mt-4 border border-slate-200 rounded-xl p-3 bg-slate-50/60" data-testid="kyc-fix-panel">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <p className="text-sm font-bold text-[#1E2A47]">Fix KYC details</p>
          <p className="text-[11px] text-slate-500 mt-0.5" data-testid="kyc-fix-status">
            Aadhaar number: {aadhaarOk ? <span className="text-green-700 font-semibold">on file ✓</span>
              : candidate.aadhaar_number ? <span className="text-red-600 font-semibold">not a valid Aadhaar number</span>
              : <span className="text-red-600 font-semibold">missing</span>}
            {" · "}PAN: {panOk ? <span className="text-green-700 font-semibold">on file ✓</span>
              : <span className="text-red-600 font-semibold">{candidate.pan_number ? "not valid" : "missing"}</span>}
          </p>
          {!aadhaarOk && lastScan === "masked" && (
            <p className="text-[11px] text-amber-700 mt-0.5" data-testid="kyc-fix-masked-note">
              The Aadhaar on file is masked (only the last 4 digits printed) — get the full Aadhaar from the candidate.
            </p>
          )}
        </div>
        {!mode && (
          <div className="flex gap-2 flex-wrap">
            <button type="button" onClick={() => { reset(); setMode("aadhaar"); setDone(""); }} data-testid="kyc-replace-aadhaar"
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold bg-white border border-slate-300 rounded-lg hover:bg-slate-100">
              <Upload size={12} /> Replace Aadhaar
            </button>
            <button type="button" onClick={() => { reset(); setMode("pan"); setDone(""); }} data-testid="kyc-replace-pan"
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold bg-white border border-slate-300 rounded-lg hover:bg-slate-100">
              <Upload size={12} /> Replace PAN
            </button>
            <button type="button" onClick={() => { reset(); setDone(""); rescan(); }} disabled={!hasAadhaarImg && !hasPanImg}
              data-testid="kyc-rescan"
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold bg-white border border-slate-300 rounded-lg hover:bg-slate-100 disabled:opacity-40">
              <RefreshCw size={12} /> Re-scan
            </button>
            <button type="button" onClick={() => { reset(); setMode("manual"); setDone(""); }} data-testid="kyc-manual"
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold bg-white border border-slate-300 rounded-lg hover:bg-slate-100">
              <Keyboard size={12} /> Enter by hand
            </button>
          </div>
        )}
      </div>

      {done && !mode && (
        <p className="mt-2 text-xs text-green-800 bg-green-50 border border-green-200 rounded-lg p-2 flex items-start gap-1.5" data-testid="kyc-fix-done">
          <CheckCircle2 size={14} className="flex-shrink-0 mt-0.5" /> {done}
        </p>
      )}

      {(mode === "aadhaar" || mode === "pan") && !preview && (
        <div className="mt-3 space-y-2" data-testid="kyc-replace-form">
          <p className="text-[11px] text-slate-500">
            {mode === "aadhaar"
              ? "Upload the FULL Aadhaar, not the masked version. The new images replace the ones on file, then they are scanned."
              : "The new image replaces the PAN card on file, then it is scanned."}
          </p>
          <div className="flex gap-2">
            {mode === "aadhaar" ? (<><FilePick k="aadhaar_front" label="Aadhaar — front" /><FilePick k="aadhaar_back" label="Aadhaar — back" /></>)
              : <FilePick k="pan_card" label="PAN card" />}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={reset} className="px-3 py-1.5 text-xs border border-slate-300 rounded-lg">Cancel</button>
            <button type="button" onClick={uploadAndScan} disabled={!!busy} data-testid="kyc-upload-scan"
              className="px-3 py-1.5 text-xs font-semibold bg-[#E85B1E] text-white rounded-lg disabled:opacity-50 flex items-center gap-1">
              {busy ? <><Loader2 size={12} className="animate-spin" /> {busy}</> : "Upload & scan"}
            </button>
          </div>
        </div>
      )}

      {mode === "rescan" && !preview && busy && (
        <p className="mt-3 text-xs text-slate-500 flex items-center gap-1"><Loader2 size={12} className="animate-spin" /> {busy}</p>
      )}

      {preview && (
        <div className="mt-3" data-testid="kyc-scan-preview">
          {aadhaarScanMsg && (
            <p className="mb-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2 flex items-start gap-1.5" data-testid="kyc-scan-warning">
              <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" /> {aadhaarScanMsg}
            </p>
          )}
          {Object.keys(preview.fields).length === 0 ? (
            <p className="text-xs text-slate-500">The scan found nothing that can be applied.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="text-slate-500 text-left">
                  <th className="py-1 pr-2">Apply</th><th className="py-1 pr-2">Field</th>
                  <th className="py-1 pr-2">On file</th><th className="py-1">From scan</th>
                </tr></thead>
                <tbody>
                  {Object.entries(preview.fields).map(([k, v]) => (
                    <tr key={k} className="border-t border-slate-200">
                      <td className="py-1 pr-2">
                        <input type="checkbox" checked={!!preview.ticks[k]} data-testid={`kyc-tick-${k}`}
                          onChange={(e) => setPreview((p) => ({ ...p, ticks: { ...p.ticks, [k]: e.target.checked } }))} />
                      </td>
                      <td className="py-1 pr-2 text-slate-600">{LABELS[k] || k}</td>
                      <td className="py-1 pr-2 text-slate-500">{preview.current[k] || "—"}</td>
                      <td className="py-1 font-medium text-[#0F172A]">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex gap-2 mt-2">
            <button type="button" onClick={reset} className="px-3 py-1.5 text-xs border border-slate-300 rounded-lg">Close</button>
            {Object.keys(preview.fields).length > 0 && (
              <button type="button" onClick={applyPreview} disabled={!!busy} data-testid="kyc-apply"
                className="px-3 py-1.5 text-xs font-semibold bg-[#E85B1E] text-white rounded-lg disabled:opacity-50">
                {busy || "Apply ticked fields"}
              </button>
            )}
          </div>
        </div>
      )}

      {mode === "manual" && (
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3" data-testid="kyc-manual-form">
          <div>
            <label className="block text-[11px] font-semibold text-slate-700 mb-1">Aadhaar number (12 digits){aadhaarOk ? " (optional)" : ""}</label>
            <input value={manual.aadhaar_number} inputMode="numeric" data-testid="kyc-manual-aadhaar"
              onChange={(e) => setManual((m) => ({ ...m, aadhaar_number: e.target.value.replace(/\D/g, "").slice(0, 12) }))}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono" placeholder="Full number from the card" />
            {manualAadhaarBad
              ? <p className="text-[11px] text-red-600 mt-1" data-testid="kyc-manual-aadhaar-invalid">Not a valid Aadhaar number — check it against the card.</p>
              : <UniqueHint {...aadhaarCheck} value={manual.aadhaar_number} minLen={12} />}
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-slate-700 mb-1">PAN{panOk ? " (optional)" : ""}</label>
            <input value={manual.pan_number} data-testid="kyc-manual-pan"
              onChange={(e) => setManual((m) => ({ ...m, pan_number: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) }))}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono" placeholder="ABCDE1234F" />
            {manualPanBad
              ? <p className="text-[11px] text-red-600 mt-1">Not a valid PAN (5 letters, 4 digits, 1 letter).</p>
              : <UniqueHint {...panCheck} value={manual.pan_number} minLen={10} />}
          </div>
          {EXTRA_FIELDS.map((k) => (
            <div key={k} className={k === "address" ? "sm:col-span-2" : ""}>
              <label className="block text-[11px] font-semibold text-slate-700 mb-1">{LABELS[k]} (missing on file)</label>
              {k === "gender" ? (
                <select value={extra[k] || ""} onChange={(e) => setExtra((x) => ({ ...x, [k]: e.target.value }))}
                  data-testid={`kyc-manual-${k}`} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white">
                  <option value="">—</option><option>Male</option><option>Female</option><option>Other</option>
                </select>
              ) : (
                <input value={extra[k] || ""} data-testid={`kyc-manual-${k}`}
                  placeholder={k === "dob" ? "DD/MM/YYYY" : ""}
                  onChange={(e) => setExtra((x) => ({ ...x, [k]: e.target.value }))}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" />
              )}
            </div>
          ))}
          <div className="sm:col-span-2 flex gap-2">
            <button type="button" onClick={reset} className="px-3 py-1.5 text-xs border border-slate-300 rounded-lg">Cancel</button>
            <button type="button" onClick={saveManual} disabled={!manualReady || !!busy} data-testid="kyc-manual-save"
              className="px-3 py-1.5 text-xs font-semibold bg-[#E85B1E] text-white rounded-lg disabled:opacity-40">
              {busy || "Save"}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-2" data-testid="kyc-fix-error">{error}</p>
      )}
    </div>
  );
}
