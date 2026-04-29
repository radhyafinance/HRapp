import React, { useState } from "react";
import { Sparkles, FileText, CheckCircle2, AlertCircle } from "lucide-react";
import { Modal } from "../shared/Modal";
import { DocUploadCard } from "./DocUploadCard";
import API from "../../utils/api";
import { compressImage, fileToBase64 } from "../../utils/imageCompression";

const DEPARTMENTS = ["Accounts", "Administration", "Compliance", "Human Resources", "IT", "Operations", "Risk and Credit"];

const INITIAL_FORM = {
  first_name: "", last_name: "", mobile: "", email: "",
  position: "", department: "",
  interview_date: "", interview_time: "", interviewer: "", meet_link: "",
  status: "pending", rejection_reason: "", expected_joining_date: "", offered_ctc: "", notes: "",
  dob: "", gender: "", father_or_husband_name: "",
  aadhaar_number: "", pan_number: "",
  address: "", city: "", state: "", pincode: "",
};

export function AddCandidateModal({ onClose, onAdded }) {
  const [form, setForm] = useState(INITIAL_FORM);
  const [aadhaarFront, setAadhaarFront] = useState(null);
  const [aadhaarBack, setAadhaarBack] = useState(null);
  const [panFile, setPanFile] = useState(null);
  const [aadhaarOcrLoading, setAadhaarOcrLoading] = useState(false);
  const [panOcrLoading, setPanOcrLoading] = useState(false);
  const [aadhaarOcrDone, setAadhaarOcrDone] = useState(false);
  const [panOcrDone, setPanOcrDone] = useState(false);
  const [compressing, setCompressing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleFilePick = async (setter, file) => {
    if (!file) { setter(null); return; }
    setCompressing(true);
    try {
      const compressed = await compressImage(file, { maxBytes: 1024 * 1024 });
      setter(compressed);
    } catch (e) {
      setter(file);
    } finally {
      setCompressing(false);
    }
  };

  const runAadhaarOCR = async () => {
    if (!aadhaarFront && !aadhaarBack) { setError("Upload at least the Aadhaar front side."); return; }
    setError("");
    setAadhaarOcrLoading(true);
    try {
      const payload = {};
      if (aadhaarFront) { const f = await fileToBase64(aadhaarFront); payload.front_image_base64 = f.base64; payload.front_mime_type = f.mime; }
      if (aadhaarBack) { const b = await fileToBase64(aadhaarBack); payload.back_image_base64 = b.base64; payload.back_mime_type = b.mime; }
      const res = await API.post("/candidates/ocr/aadhaar", payload);
      const d = res.data?.data || {};
      let firstName = form.first_name;
      let lastName = form.last_name;
      if (d.name) {
        const parts = String(d.name).trim().split(/\s+/);
        firstName = firstName || parts[0] || "";
        lastName = lastName || parts.slice(1).join(" ") || "";
      }
      setForm((f) => ({
        ...f, first_name: firstName, last_name: lastName,
        dob: f.dob || d.dob || "", gender: f.gender || d.gender || "",
        father_or_husband_name: f.father_or_husband_name || d.father_or_husband_name || "",
        aadhaar_number: f.aadhaar_number || d.aadhaar_number || "",
        address: f.address || d.address || "", city: f.city || d.city || "",
        state: f.state || d.state || "", pincode: f.pincode || d.pincode || "",
      }));
      setAadhaarOcrDone(true);
    } catch (e) {
      setError("Aadhaar OCR failed: " + (e.response?.data?.detail || "Unknown error"));
    } finally {
      setAadhaarOcrLoading(false);
    }
  };

  const runPanOCR = async () => {
    if (!panFile) { setError("Upload PAN card image first."); return; }
    setError("");
    setPanOcrLoading(true);
    try {
      const f = await fileToBase64(panFile);
      const res = await API.post("/candidates/ocr/pan", { image_base64: f.base64, mime_type: f.mime });
      const d = res.data?.data || {};
      setForm((cur) => ({
        ...cur,
        pan_number: cur.pan_number || d.pan_number || "",
        first_name: cur.first_name || (d.name ? d.name.split(/\s+/)[0] : ""),
        last_name: cur.last_name || (d.name ? d.name.split(/\s+/).slice(1).join(" ") : ""),
        father_or_husband_name: cur.father_or_husband_name || d.father_name || "",
        dob: cur.dob || d.dob || "",
      }));
      setPanOcrDone(true);
    } catch (e) {
      setError("PAN OCR failed: " + (e.response?.data?.detail || "Unknown error"));
    } finally {
      setPanOcrLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = { ...form, offered_ctc: form.offered_ctc ? parseFloat(form.offered_ctc) : null };
      const res = await API.post("/candidates", payload);
      const candId = res.data.id;
      const docPayload = {};
      if (aadhaarFront) { const f = await fileToBase64(aadhaarFront); docPayload.aadhaar_front_base64 = f.base64; docPayload.aadhaar_front_mime = f.mime; }
      if (aadhaarBack) { const b = await fileToBase64(aadhaarBack); docPayload.aadhaar_back_base64 = b.base64; docPayload.aadhaar_back_mime = b.mime; }
      if (panFile) { const p = await fileToBase64(panFile); docPayload.pan_card_base64 = p.base64; docPayload.pan_card_mime = p.mime; }
      if (Object.keys(docPayload).length > 0) {
        try { await API.post(`/candidates/${candId}/documents`, docPayload); } catch (_) {}
      }
      onAdded();
      onClose();
    } catch (e) {
      setError(e.response?.data?.detail || "Failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Add Candidate" onClose={onClose} wide>
      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Aadhaar OCR */}
        <section className="bg-gradient-to-br from-[#1E2A47]/5 to-[#E85B1E]/5 border border-slate-200 rounded-xl p-4">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <h4 className="font-bold text-[#1E2A47] text-sm flex items-center gap-2">
                <Sparkles size={16} className="text-[#E85B1E]" /> Aadhaar Auto-fill (Front + Back)
              </h4>
              <p className="text-xs text-slate-500 mt-0.5">Upload both sides — Gemini AI extracts name, DOB, gender, father/husband, address, Aadhaar #. Images are auto-compressed to under 1 MB.</p>
            </div>
            {aadhaarOcrDone && <span className="flex items-center gap-1 text-green-600 text-xs font-medium"><CheckCircle2 size={14} /> Auto-filled</span>}
          </div>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <DocUploadCard label="Aadhaar Front" file={aadhaarFront} onChange={(f) => handleFilePick(setAadhaarFront, f)} onClear={() => setAadhaarFront(null)} testid="aadhaar-front-input" />
            <DocUploadCard label="Aadhaar Back" file={aadhaarBack} onChange={(f) => handleFilePick(setAadhaarBack, f)} onClear={() => setAadhaarBack(null)} testid="aadhaar-back-input" />
          </div>
          <button type="button" onClick={runAadhaarOCR} disabled={aadhaarOcrLoading || compressing || (!aadhaarFront && !aadhaarBack)} data-testid="run-aadhaar-ocr-btn"
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-[#1E2A47] text-white rounded-lg text-sm font-semibold hover:bg-[#2A3A5E] disabled:opacity-50 transition-colors">
            {aadhaarOcrLoading ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Extracting from Aadhaar...</>
              : compressing ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Compressing image...</>
                : <><Sparkles size={14} /> Extract Aadhaar Details</>}
          </button>
        </section>

        {/* PAN OCR */}
        <section className="bg-gradient-to-br from-blue-50 to-slate-50 border border-slate-200 rounded-xl p-4">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <h4 className="font-bold text-[#1E2A47] text-sm flex items-center gap-2">
                <FileText size={16} className="text-blue-600" /> PAN Auto-fill
              </h4>
              <p className="text-xs text-slate-500 mt-0.5">Upload the PAN card — Gemini AI extracts the 10-character PAN number. Image is auto-compressed to under 1 MB.</p>
            </div>
            {panOcrDone && <span className="flex items-center gap-1 text-green-600 text-xs font-medium"><CheckCircle2 size={14} /> Auto-filled</span>}
          </div>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <DocUploadCard label="PAN Card" file={panFile} onChange={(f) => handleFilePick(setPanFile, f)} onClear={() => setPanFile(null)} testid="pan-input" />
            <button type="button" onClick={runPanOCR} disabled={panOcrLoading || compressing || !panFile} data-testid="run-pan-ocr-btn"
              className="flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors">
              {panOcrLoading ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Extracting...</>
                : compressing ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Compressing...</>
                  : <><Sparkles size={14} /> Extract PAN</>}
            </button>
          </div>
        </section>

        {/* Personal Info */}
        <section>
          <h4 className="font-bold text-[#1E2A47] text-sm mb-3">Personal Details</h4>
          <div className="grid grid-cols-2 gap-3">
            {[["first_name", "First Name", "text", true], ["last_name", "Last Name", "text", true], ["mobile", "Mobile", "tel", true], ["email", "Email", "email", false], ["dob", "Date of Birth (DD/MM/YYYY)", "text", false], ["gender", "Gender", "text", false], ["father_or_husband_name", "Father's / Husband's Name", "text", false]].map(([key, label, type, req]) => (
              <div key={key}>
                <label className="block text-xs font-semibold text-slate-700 mb-1">{label}{req && <span className="text-red-500">*</span>}</label>
                <input type={type} value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })} required={req}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" data-testid={`form-${key}`} />
              </div>
            ))}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Aadhaar Number (12 digits)</label>
              <input value={form.aadhaar_number} onChange={e => setForm({ ...form, aadhaar_number: e.target.value.replace(/\D/g, "").slice(0, 12) })}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-[#E85B1E] outline-none" data-testid="form-aadhaar_number" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">PAN Number</label>
              <input value={form.pan_number} onChange={e => setForm({ ...form, pan_number: e.target.value.toUpperCase().slice(0, 10) })}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-[#E85B1E] outline-none" data-testid="form-pan_number" />
            </div>
          </div>
        </section>

        {/* Address */}
        <section>
          <h4 className="font-bold text-[#1E2A47] text-sm mb-3">Address (from Aadhaar back)</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-700 mb-1">Address</label>
              <textarea rows="2" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" data-testid="form-address" />
            </div>
            {[["city", "City"], ["state", "State"]].map(([key, label]) => (
              <div key={key}>
                <label className="block text-xs font-semibold text-slate-700 mb-1">{label}</label>
                <input value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" data-testid={`form-${key}`} />
              </div>
            ))}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Pincode</label>
              <input value={form.pincode} onChange={e => setForm({ ...form, pincode: e.target.value.replace(/\D/g, "").slice(0, 6) })}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-[#E85B1E] outline-none" data-testid="form-pincode" />
            </div>
          </div>
        </section>

        {/* Job / Recruitment */}
        <section>
          <h4 className="font-bold text-[#1E2A47] text-sm mb-3">Job / Recruitment</h4>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Position Applied For<span className="text-red-500">*</span></label>
              <input value={form.position} onChange={e => setForm({ ...form, position: e.target.value })} required
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" data-testid="form-position" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Department<span className="text-red-500">*</span></label>
              <select value={form.department} onChange={e => setForm({ ...form, department: e.target.value })} required
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none bg-white" data-testid="form-department">
                <option value="">Select department</option>
                {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Interview Date</label>
              <input type="date" value={form.interview_date} onChange={e => setForm({ ...form, interview_date: e.target.value })}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" data-testid="form-interview-date" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Interview Time</label>
              <input type="time" value={form.interview_time} onChange={e => setForm({ ...form, interview_time: e.target.value })}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" data-testid="form-interview-time" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Interviewer</label>
              <input value={form.interviewer} onChange={e => setForm({ ...form, interviewer: e.target.value })} placeholder="Name of interviewer"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" data-testid="form-interviewer" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Google Meet Link <span className="text-slate-400 font-normal">(paste from Google Calendar)</span></label>
              <input type="url" value={form.meet_link} onChange={e => setForm({ ...form, meet_link: e.target.value })} placeholder="https://meet.google.com/..."
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" data-testid="form-meet-link" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Status</label>
              <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none bg-white">
                <option value="pending">Pending</option>
                <option value="selected">Selected</option>
                <option value="rejected">Rejected</option>
              </select>
            </div>
          </div>
          {form.status === "selected" && (
            <div className="grid grid-cols-2 gap-3 border-t pt-3 mt-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Expected Joining Date</label>
                <input type="date" value={form.expected_joining_date} onChange={e => setForm({ ...form, expected_joining_date: e.target.value })}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Offered CTC (₹/month)</label>
                <input type="number" value={form.offered_ctc} onChange={e => setForm({ ...form, offered_ctc: e.target.value })}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
              </div>
            </div>
          )}
          {form.status === "rejected" && (
            <div className="border-t pt-3 mt-3">
              <label className="block text-xs font-semibold text-slate-700 mb-1">Rejection Reason</label>
              <input value={form.rejection_reason} onChange={e => setForm({ ...form, rejection_reason: e.target.value })}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
            </div>
          )}
        </section>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm p-3 rounded-lg flex items-start gap-2">
            <AlertCircle size={16} className="flex-shrink-0 mt-0.5" /><span>{error}</span>
          </div>
        )}

        <div className="flex gap-3 sticky bottom-0 bg-white pt-3 border-t border-slate-100">
          <button type="button" onClick={onClose} className="flex-1 px-4 py-2.5 border-2 border-slate-300 text-slate-600 rounded-lg text-sm font-medium">Cancel</button>
          <button type="submit" disabled={saving} data-testid="save-candidate-btn" className="flex-1 px-4 py-2.5 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold disabled:opacity-60">
            {saving ? "Saving..." : "Add Candidate"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
