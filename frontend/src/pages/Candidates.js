import React, { useEffect, useState } from "react";
import API from "../utils/api";
import { UserPlus, Search, X, Camera, Sparkles, Image as ImageIcon, FileText, CheckCircle2, AlertCircle, Eye, Undo2, CalendarClock, Send, Copy, Mail, UserCheck } from "lucide-react";

const STATUS_COLORS = { pending: "bg-amber-100 text-amber-700", selected: "bg-green-100 text-green-700", rejected: "bg-red-100 text-red-700", converted: "bg-blue-100 text-blue-700" };

const DEPARTMENTS = ["Accounts", "Administration", "Compliance", "Human Resources", "IT", "Operations", "Risk and Credit"];

// Compress image client-side so the resulting file is under TARGET_BYTES.
// Tries decreasing JPEG quality and downscaling until size fits.
async function compressImage(file, { maxBytes = 1024 * 1024, maxDimension = 1920, mime = "image/jpeg" } = {}) {
  if (!file) return file;
  // If already a small image and it's a jpeg/png, just return original
  if (file.size <= maxBytes && /^image\/(jpe?g|png|webp)$/i.test(file.type)) {
    return file;
  }
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
  // Final fallback: shrink dimensions further
  if (blob && blob.size > maxBytes) {
    const shrinkScales = [0.75, 0.6, 0.5, 0.4];
    for (const s of shrinkScales) {
      const w2 = Math.round(width * s);
      const h2 = Math.round(height * s);
      const c2 = document.createElement("canvas");
      c2.width = w2; c2.height = h2;
      const cx = c2.getContext("2d");
      cx.fillStyle = "#FFFFFF";
      cx.fillRect(0, 0, w2, h2);
      cx.drawImage(img, 0, 0, w2, h2);
      blob = await new Promise((resolve) => c2.toBlob(resolve, mime, 0.7));
      if (blob && blob.size <= maxBytes) break;
    }
  }
  if (!blob) return file;
  const renamed = file.name ? file.name.replace(/\.[^.]+$/, ".jpg") : "image.jpg";
  return new File([blob], renamed, { type: mime, lastModified: Date.now() });
}

function Modal({ title, onClose, children, wide }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className={`bg-white rounded-xl shadow-2xl w-full ${wide ? "max-w-4xl" : "max-w-2xl"} max-h-[92vh] overflow-y-auto`}>
        <div className="flex items-center justify-between p-5 border-b sticky top-0 bg-white z-10">
          <h3 className="text-lg font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>{title}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100"><X size={18} /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

const INITIAL_FORM = {
  first_name: "", last_name: "", mobile: "", email: "",
  position: "", department: "",
  interview_date: "", interview_time: "", interviewer: "", meet_link: "",
  status: "pending", rejection_reason: "", expected_joining_date: "", offered_ctc: "", notes: "",
  // KYC fields auto-filled by OCR
  dob: "", gender: "", father_or_husband_name: "",
  aadhaar_number: "", pan_number: "",
  address: "", city: "", state: "", pincode: "",
};

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const b64 = e.target.result.split(",")[1];
      resolve({ base64: b64, mime: file.type || "image/jpeg" });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function DocUploadCard({ label, file, onChange, onClear, testid }) {
  const [preview, setPreview] = useState(null);
  useEffect(() => {
    if (!file) { setPreview(null); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const sizeKb = file ? Math.round(file.size / 1024) : 0;
  return (
    <label className={`relative flex flex-col items-center justify-center border-2 border-dashed rounded-xl p-3 text-center cursor-pointer transition-colors ${file ? "border-[#E85B1E] bg-[#E85B1E]/5" : "border-slate-300 hover:border-slate-400 bg-slate-50/50"}`}>
      {preview ? (
        <>
          <img src={preview} alt={label} className="w-full h-28 object-cover rounded-lg mb-2" />
          <p className="text-xs font-semibold text-[#1E2A47] truncate w-full">{label}</p>
          <p className="text-[10px] text-slate-500">{sizeKb} KB</p>
          <button type="button" onClick={(e) => { e.preventDefault(); onClear(); }} className="absolute top-1 right-1 bg-white/90 rounded-full p-1 text-red-500 hover:bg-white">
            <X size={12} />
          </button>
        </>
      ) : (
        <>
          <ImageIcon size={28} className="text-slate-400 mb-1" />
          <p className="text-xs font-semibold text-slate-700">{label}</p>
          <p className="text-[10px] text-slate-400">Click to upload</p>
        </>
      )}
      <input
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => onChange(e.target.files?.[0] || null)}
        data-testid={testid}
      />
    </label>
  );
}

export default function Candidates() {
  const [candidates, setCandidates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [showDetail, setShowDetail] = useState(null);
  const [scheduleFor, setScheduleFor] = useState(null);
  const [form, setForm] = useState(INITIAL_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Add-flow OCR state
  const [aadhaarFront, setAadhaarFront] = useState(null);
  const [aadhaarBack, setAadhaarBack] = useState(null);
  const [panFile, setPanFile] = useState(null);
  const [aadhaarOcrLoading, setAadhaarOcrLoading] = useState(false);
  const [panOcrLoading, setPanOcrLoading] = useState(false);
  const [aadhaarOcrDone, setAadhaarOcrDone] = useState(false);
  const [panOcrDone, setPanOcrDone] = useState(false);
  const [compressing, setCompressing] = useState(false);

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

  const fetchCandidates = async () => {
    setLoading(true);
    try {
      const params = {};
      if (statusFilter) params.status = statusFilter;
      if (search) params.search = search;
      const res = await API.get("/candidates", { params });
      setCandidates(res.data);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchCandidates(); }, [search, statusFilter]);

  const resetAddFlow = () => {
    setForm(INITIAL_FORM);
    setAadhaarFront(null);
    setAadhaarBack(null);
    setPanFile(null);
    setAadhaarOcrDone(false);
    setPanOcrDone(false);
    setError("");
  };

  const closeAdd = () => {
    setShowAdd(false);
    resetAddFlow();
  };

  const runAadhaarOCR = async () => {
    if (!aadhaarFront && !aadhaarBack) {
      setError("Upload at least the Aadhaar front side.");
      return;
    }
    setError("");
    setAadhaarOcrLoading(true);
    try {
      const payload = {};
      if (aadhaarFront) {
        const f = await fileToBase64(aadhaarFront);
        payload.front_image_base64 = f.base64;
        payload.front_mime_type = f.mime;
      }
      if (aadhaarBack) {
        const b = await fileToBase64(aadhaarBack);
        payload.back_image_base64 = b.base64;
        payload.back_mime_type = b.mime;
      }
      const res = await API.post("/candidates/ocr/aadhaar", payload);
      const d = res.data?.data || {};
      // Split name -> first/last
      let firstName = form.first_name;
      let lastName = form.last_name;
      if (d.name) {
        const parts = String(d.name).trim().split(/\s+/);
        firstName = firstName || parts[0] || "";
        lastName = lastName || parts.slice(1).join(" ") || "";
      }
      setForm((f) => ({
        ...f,
        first_name: firstName,
        last_name: lastName,
        dob: f.dob || d.dob || "",
        gender: f.gender || d.gender || "",
        father_or_husband_name: f.father_or_husband_name || d.father_or_husband_name || "",
        aadhaar_number: f.aadhaar_number || d.aadhaar_number || "",
        address: f.address || d.address || "",
        city: f.city || d.city || "",
        state: f.state || d.state || "",
        pincode: f.pincode || d.pincode || "",
      }));
      setAadhaarOcrDone(true);
    } catch (e) {
      setError("Aadhaar OCR failed: " + (e.response?.data?.detail || "Unknown error"));
    } finally {
      setAadhaarOcrLoading(false);
    }
  };

  const runPanOCR = async () => {
    if (!panFile) {
      setError("Upload PAN card image first.");
      return;
    }
    setError("");
    setPanOcrLoading(true);
    try {
      const f = await fileToBase64(panFile);
      const res = await API.post("/candidates/ocr/pan", {
        image_base64: f.base64,
        mime_type: f.mime,
      });
      const d = res.data?.data || {};
      setForm((cur) => ({
        ...cur,
        pan_number: cur.pan_number || d.pan_number || "",
        // If we have name from PAN and not yet from Aadhaar, use it
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

  const handleAdd = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = {
        ...form,
        offered_ctc: form.offered_ctc ? parseFloat(form.offered_ctc) : null,
      };
      const res = await API.post("/candidates", payload);
      const candId = res.data.id;

      // Upload documents (if any)
      const docPayload = {};
      if (aadhaarFront) {
        const f = await fileToBase64(aadhaarFront);
        docPayload.aadhaar_front_base64 = f.base64;
        docPayload.aadhaar_front_mime = f.mime;
      }
      if (aadhaarBack) {
        const b = await fileToBase64(aadhaarBack);
        docPayload.aadhaar_back_base64 = b.base64;
        docPayload.aadhaar_back_mime = b.mime;
      }
      if (panFile) {
        const p = await fileToBase64(panFile);
        docPayload.pan_card_base64 = p.base64;
        docPayload.pan_card_mime = p.mime;
      }
      if (Object.keys(docPayload).length > 0) {
        try { await API.post(`/candidates/${candId}/documents`, docPayload); } catch (_) {}
      }
      closeAdd();
      fetchCandidates();
    } catch (e) {
      setError(e.response?.data?.detail || "Failed");
    } finally {
      setSaving(false);
    }
  };

  const handleStatusUpdate = async (candId, status, extra = {}) => {
    try {
      await API.put(`/candidates/${candId}`, { status, ...extra });
      fetchCandidates();
      if (showDetail?.id === candId) setShowDetail({ ...showDetail, status, ...extra });
    } catch (e) { alert(e.response?.data?.detail || "Update failed"); }
  };

  return (
    <div style={{ fontFamily: "'Work Sans', sans-serif" }}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>Candidate Management</h1>
          <p className="text-slate-500 text-sm">{candidates.length} candidates</p>
        </div>
        <button onClick={() => { setShowAdd(true); resetAddFlow(); }} data-testid="add-candidate-btn"
          className="flex items-center gap-2 px-4 py-2 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold hover:bg-[#D04A15] transition-colors">
          <UserPlus size={16} /> Add Candidate
        </button>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search candidates..."
            className="w-full pl-9 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          className="border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none bg-white">
          <option value="">All Status</option>
          <option value="pending">Pending</option>
          <option value="selected">Selected</option>
          <option value="rejected">Rejected</option>
          <option value="converted">Converted</option>
        </select>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full" data-testid="candidates-table">
            <thead><tr className="bg-slate-50 border-b">
              {["Name", "Mobile", "Aadhaar", "PAN", "Position", "Department", "Interview", "Status", "Actions"].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {loading ? <tr><td colSpan={9} className="px-4 py-8 text-center text-slate-400">Loading...</td></tr>
                : candidates.length === 0 ? <tr><td colSpan={9} className="px-4 py-12 text-center text-slate-400">No candidates found</td></tr>
                : candidates.map(c => (
                  <tr key={c.id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-[#0F172A]">{c.first_name} {c.last_name}</p>
                      <p className="text-xs text-slate-400">{c.email || "-"}</p>
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-600">{c.mobile}</td>
                    <td className="px-4 py-3 text-xs font-mono text-slate-600">{c.aadhaar_number ? `XXXX-XXXX-${c.aadhaar_number.slice(-4)}` : "-"}</td>
                    <td className="px-4 py-3 text-xs font-mono text-slate-600">{c.pan_number || "-"}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{c.position}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{c.department}</td>
                    <td className="px-4 py-3 text-xs">
                      {c.interview_date ? (
                        <div>
                          <p className="font-medium text-slate-700">{c.interview_date}{c.interview_time && ` ${c.interview_time}`}</p>
                          {c.meet_link && (
                            <a href={c.meet_link} target="_blank" rel="noopener noreferrer" className="text-[#E85B1E] hover:underline truncate inline-block max-w-[140px]" title={c.meet_link}>Meet link</a>
                          )}
                        </div>
                      ) : (
                        <span className="text-slate-300">Not scheduled</span>
                      )}
                    </td>
                    <td className="px-4 py-3"><span className={`px-2 py-1 rounded-full text-xs font-medium capitalize ${STATUS_COLORS[c.status] || "bg-slate-100 text-slate-700"}`}>{c.status}</span></td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1.5">
                        <button onClick={() => setShowDetail(c)} data-testid={`view-cand-${c.id}`} className="text-xs px-2 py-1 bg-[#1E2A47]/10 text-[#1E2A47] rounded-lg hover:bg-[#1E2A47]/20">View</button>
                        <button onClick={() => setScheduleFor(c)} data-testid={`schedule-cand-${c.id}`} className="flex items-center gap-1 text-xs px-2 py-1 bg-blue-100 text-blue-700 rounded-lg hover:bg-blue-200">
                          <CalendarClock size={12} /> {c.interview_date ? "Reschedule" : "Schedule"}
                        </button>
                        {c.status === "pending" && (
                          <>
                            <button onClick={() => handleStatusUpdate(c.id, "selected")} data-testid={`select-cand-${c.id}`} className="text-xs px-2 py-1 bg-green-100 text-green-700 rounded-lg hover:bg-green-200">Select</button>
                            <button onClick={() => handleStatusUpdate(c.id, "rejected", { rejection_reason: "Not suitable" })} data-testid={`reject-cand-${c.id}`} className="text-xs px-2 py-1 bg-red-100 text-red-700 rounded-lg hover:bg-red-200">Reject</button>
                          </>
                        )}
                        {(c.status === "selected" || c.status === "rejected") && (
                          <button
                            onClick={() => handleStatusUpdate(c.id, "pending", { rejection_reason: "" })}
                            data-testid={`undo-cand-${c.id}`}
                            className="flex items-center gap-1 text-xs px-2 py-1 bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200"
                            title={`Undo ${c.status}`}
                          >
                            <Undo2 size={12} /> Undo
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {showAdd && (
        <Modal title="Add Candidate" onClose={closeAdd} wide>
          <form onSubmit={handleAdd} className="space-y-6">
            {/* Aadhaar OCR Section */}
            <section className="bg-gradient-to-br from-[#1E2A47]/5 to-[#E85B1E]/5 border border-slate-200 rounded-xl p-4">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                  <h4 className="font-bold text-[#1E2A47] text-sm flex items-center gap-2">
                    <Sparkles size={16} className="text-[#E85B1E]" /> Aadhaar Auto-fill (Front + Back)
                  </h4>
                  <p className="text-xs text-slate-500 mt-0.5">Upload both sides — Gemini AI extracts name, DOB, gender, father/husband, address, pincode, Aadhaar #. Images are auto-compressed to under 1 MB.</p>
                </div>
                {aadhaarOcrDone && (
                  <span className="flex items-center gap-1 text-green-600 text-xs font-medium"><CheckCircle2 size={14} /> Auto-filled</span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <DocUploadCard label="Aadhaar Front" file={aadhaarFront} onChange={(f) => handleFilePick(setAadhaarFront, f)} onClear={() => setAadhaarFront(null)} testid="aadhaar-front-input" />
                <DocUploadCard label="Aadhaar Back" file={aadhaarBack} onChange={(f) => handleFilePick(setAadhaarBack, f)} onClear={() => setAadhaarBack(null)} testid="aadhaar-back-input" />
              </div>
              <button type="button" onClick={runAadhaarOCR} disabled={aadhaarOcrLoading || compressing || (!aadhaarFront && !aadhaarBack)} data-testid="run-aadhaar-ocr-btn"
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-[#1E2A47] text-white rounded-lg text-sm font-semibold hover:bg-[#2A3A5E] disabled:opacity-50 transition-colors">
                {aadhaarOcrLoading ? (
                  <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Extracting from Aadhaar...</>
                ) : compressing ? (
                  <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Compressing image...</>
                ) : (
                  <><Sparkles size={14} /> Extract Aadhaar Details</>
                )}
              </button>
            </section>

            {/* PAN OCR Section */}
            <section className="bg-gradient-to-br from-blue-50 to-slate-50 border border-slate-200 rounded-xl p-4">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                  <h4 className="font-bold text-[#1E2A47] text-sm flex items-center gap-2">
                    <FileText size={16} className="text-blue-600" /> PAN Auto-fill
                  </h4>
                  <p className="text-xs text-slate-500 mt-0.5">Upload the PAN card — Gemini AI extracts the 10-character PAN number. Image is auto-compressed to under 1 MB.</p>
                </div>
                {panOcrDone && (
                  <span className="flex items-center gap-1 text-green-600 text-xs font-medium"><CheckCircle2 size={14} /> Auto-filled</span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <DocUploadCard label="PAN Card" file={panFile} onChange={(f) => handleFilePick(setPanFile, f)} onClear={() => setPanFile(null)} testid="pan-input" />
                <button type="button" onClick={runPanOCR} disabled={panOcrLoading || compressing || !panFile} data-testid="run-pan-ocr-btn"
                  className="flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors">
                  {panOcrLoading ? (
                    <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Extracting...</>
                  ) : compressing ? (
                    <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Compressing...</>
                  ) : (
                    <><Sparkles size={14} /> Extract PAN</>
                  )}
                </button>
              </div>
            </section>

            {/* Personal info */}
            <section>
              <h4 className="font-bold text-[#1E2A47] text-sm mb-3">Personal Details</h4>
              <div className="grid grid-cols-2 gap-3">
                {[
                  ["first_name", "First Name", "text", true],
                  ["last_name", "Last Name", "text", true],
                  ["mobile", "Mobile", "tel", true],
                  ["email", "Email", "email", false],
                  ["dob", "Date of Birth (DD/MM/YYYY)", "text", false],
                  ["gender", "Gender", "text", false],
                  ["father_or_husband_name", "Father's / Husband's Name", "text", false],
                ].map(([key, label, type, req]) => (
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
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">City</label>
                  <input value={form.city} onChange={e => setForm({ ...form, city: e.target.value })}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" data-testid="form-city" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">State</label>
                  <input value={form.state} onChange={e => setForm({ ...form, state: e.target.value })}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" data-testid="form-state" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Pincode</label>
                  <input value={form.pincode} onChange={e => setForm({ ...form, pincode: e.target.value.replace(/\D/g, "").slice(0, 6) })}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-[#E85B1E] outline-none" data-testid="form-pincode" />
                </div>
              </div>
            </section>

            {/* Job */}
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
                <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex gap-3 sticky bottom-0 bg-white pt-3 border-t border-slate-100">
              <button type="button" onClick={closeAdd} className="flex-1 px-4 py-2.5 border-2 border-slate-300 text-slate-600 rounded-lg text-sm font-medium">Cancel</button>
              <button type="submit" disabled={saving} data-testid="save-candidate-btn" className="flex-1 px-4 py-2.5 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold disabled:opacity-60">
                {saving ? "Saving..." : "Add Candidate"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {showDetail && (
        <CandidateDetailModal
          candidate={showDetail}
          onClose={() => setShowDetail(null)}
          onSchedule={(c) => { setShowDetail(null); setScheduleFor(c); }}
        />
      )}

      {scheduleFor && (
        <ScheduleInterviewModal
          candidate={scheduleFor}
          onClose={() => setScheduleFor(null)}
          onSaved={(updated) => {
            setScheduleFor(null);
            setCandidates((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
          }}
        />
      )}
    </div>
  );
}

function CandidateDetailModal({ candidate, onClose, onSchedule }) {
  const [c, setC] = useState(candidate);
  const [docsMeta, setDocsMeta] = useState(null);
  const [zoomDoc, setZoomDoc] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await API.get(`/candidates/${candidate.id}/documents`);
        setDocsMeta(res.data);
      } catch (e) { setDocsMeta({}); }
    })();
  }, [candidate.id]);

  // Note: we use a fetch->blob viewer to attach Authorization header
  const [docBlobs, setDocBlobs] = useState({});
  const fetchDoc = async (type) => {
    try {
      const res = await API.get(`/candidates/${candidate.id}/documents/${type}`, { responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      setDocBlobs(prev => ({ ...prev, [type]: url }));
      return url;
    } catch (e) { return null; }
  };

  useEffect(() => {
    return () => {
      Object.values(docBlobs).forEach((u) => URL.revokeObjectURL(u));
    };
  }, [docBlobs]);

  return (
    <Modal title={`${c.first_name} ${c.last_name}`} onClose={onClose} wide>
      <div className="space-y-5">
        <div className="bg-slate-50 p-4 rounded-lg flex items-center justify-between">
          <div>
            <p className="text-sm text-slate-500">{c.position} • {c.department}</p>
            <p className="text-xs text-slate-400 mt-0.5">{c.mobile} {c.email && `• ${c.email}`}</p>
          </div>
          <span className={`px-2 py-1 rounded-full text-xs font-medium capitalize ${STATUS_COLORS[c.status]}`}>{c.status}</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          {[
            ["Aadhaar #", c.aadhaar_number ? c.aadhaar_number.replace(/(\d{4})(?=\d)/g, "$1 ") : "-"],
            ["PAN", c.pan_number || "-"],
            ["DOB", c.dob || "-"],
            ["Gender", c.gender || "-"],
            ["Father / Husband", c.father_or_husband_name || "-"],
            ["Pincode", c.pincode || "-"],
            ["City", c.city || "-"],
            ["State", c.state || "-"],
          ].map(([label, val]) => (
            <div key={label} className="flex justify-between border-b border-slate-100 pb-1">
              <span className="text-slate-500">{label}</span>
              <span className="font-medium text-[#0F172A] text-right">{val}</span>
            </div>
          ))}
          {c.address && (
            <div className="md:col-span-2 border-b border-slate-100 pb-1">
              <p className="text-slate-500 text-xs mb-0.5">Address</p>
              <p className="font-medium text-[#0F172A] text-sm">{c.address}</p>
            </div>
          )}
        </div>

        <div className="border-t pt-4">
          <div className="flex items-center justify-between mb-2">
            <h4 className="font-bold text-[#1E2A47] text-sm">Interview</h4>
            <button onClick={() => onSchedule(c)} data-testid="detail-schedule-btn" className="flex items-center gap-1 text-xs px-3 py-1.5 bg-blue-100 text-blue-700 rounded-lg hover:bg-blue-200">
              <CalendarClock size={12} /> {c.interview_date ? "Reschedule / Share" : "Schedule"}
            </button>
          </div>
          {c.interview_date ? (
            <div className="bg-blue-50 border border-blue-100 rounded-lg p-3 text-sm space-y-1">
              <p><span className="text-slate-500">Date & Time:</span> <span className="font-semibold text-[#0F172A]">{c.interview_date}{c.interview_time && ` • ${c.interview_time}`}</span></p>
              {c.interviewer && <p><span className="text-slate-500">Interviewer:</span> <span className="font-medium">{c.interviewer}</span></p>}
              {c.meet_link && (
                <p className="break-all"><span className="text-slate-500">Meet:</span>{" "}
                  <a href={c.meet_link} target="_blank" rel="noopener noreferrer" className="text-[#E85B1E] hover:underline">{c.meet_link}</a>
                </p>
              )}
            </div>
          ) : (
            <p className="text-xs text-slate-400">No interview scheduled.</p>
          )}
        </div>

        {(c.status === "selected" || c.status === "converted") && (
          <div className="border-t pt-4" data-testid="joining-section">
            <h4 className="font-bold text-[#1E2A47] text-sm mb-3 flex items-center gap-2">
              <FileText size={14} className="text-[#E85B1E]" /> Joining Kit
            </h4>
            <JoiningKitPanel candidate={c} onCandidateUpdate={setC} />
          </div>
        )}

        <div className="border-t pt-4">
          <h4 className="font-bold text-[#1E2A47] text-sm mb-3">KYC Documents</h4>
          <div className="grid grid-cols-3 gap-3">
            {[
              ["aadhaar_front", "Aadhaar Front"],
              ["aadhaar_back", "Aadhaar Back"],
              ["pan_card", "PAN Card"],
            ].map(([key, label]) => {
              const exists = docsMeta && docsMeta[key];
              const blobUrl = docBlobs[key];
              return (
                <div key={key} className={`border rounded-xl p-2 text-center ${exists ? "border-slate-200 bg-white" : "border-dashed border-slate-300 bg-slate-50/50"}`}>
                  {!exists ? (
                    <div className="h-32 flex flex-col items-center justify-center text-slate-400">
                      <ImageIcon size={24} />
                      <p className="text-xs mt-1">Not uploaded</p>
                    </div>
                  ) : blobUrl ? (
                    <img src={blobUrl} alt={label} className="h-32 w-full object-contain mx-auto cursor-zoom-in" onClick={() => setZoomDoc({ url: blobUrl, label })} />
                  ) : (
                    <button type="button" onClick={() => fetchDoc(key)} data-testid={`load-${key}`} className="h-32 w-full flex flex-col items-center justify-center text-[#E85B1E] hover:bg-[#E85B1E]/5 rounded-lg">
                      <Eye size={20} />
                      <p className="text-xs mt-1 font-semibold">Load image</p>
                    </button>
                  )}
                  <p className="text-xs font-semibold text-slate-700 mt-1">{label}</p>
                </div>
              );
            })}
          </div>
        </div>

        {zoomDoc && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-6 bg-black/80" onClick={() => setZoomDoc(null)}>
            <img src={zoomDoc.url} alt={zoomDoc.label} className="max-w-full max-h-full rounded-lg shadow-2xl" />
          </div>
        )}
      </div>
    </Modal>
  );
}


function buildInviteMessage({ first_name, last_name, position, interview_date, interview_time, interviewer, meet_link }) {
  const fullName = `${first_name || ""} ${last_name || ""}`.trim();
  const lines = [
    `Hello ${fullName || "Candidate"},`,
    "",
    `You are invited to an interview at Radhya Micro Finance for the role of ${position || "the open position"}.`,
    "",
    `Date: ${interview_date || "TBD"}`,
    `Time: ${interview_time || "TBD"} (IST)`,
  ];
  if (interviewer) lines.push(`Interviewer: ${interviewer}`);
  if (meet_link) {
    lines.push("");
    lines.push(`Google Meet link: ${meet_link}`);
    lines.push("Please join 5 minutes before the scheduled time.");
  }
  lines.push("");
  lines.push("Please confirm your availability by replying to this message.");
  lines.push("");
  lines.push("Regards,");
  lines.push("HR Team — Radhya Micro Finance");
  return lines.join("\n");
}

function ScheduleInterviewModal({ candidate, onClose, onSaved }) {
  const [date, setDate] = useState(candidate.interview_date || "");
  const [time, setTime] = useState(candidate.interview_time || "");
  const [interviewer, setInterviewer] = useState(candidate.interviewer || "");
  const [meetLink, setMeetLink] = useState(candidate.meet_link || "");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState("");

  const message = buildInviteMessage({
    first_name: candidate.first_name,
    last_name: candidate.last_name,
    position: candidate.position,
    interview_date: date,
    interview_time: time,
    interviewer,
    meet_link: meetLink,
  });

  const cleanedMobile = (candidate.mobile || "").replace(/\D/g, "");
  // Default to India country code if mobile doesn't already include one
  const waNumber = cleanedMobile.length === 10 ? `91${cleanedMobile}` : cleanedMobile;
  const waUrl = waNumber ? `https://wa.me/${waNumber}?text=${encodeURIComponent(message)}` : null;
  const subject = `Interview invitation — Radhya Micro Finance (${candidate.position || ""})`;
  const mailto = candidate.email
    ? `mailto:${candidate.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`
    : null;

  const save = async () => {
    setSaving(true);
    setErr("");
    try {
      const res = await API.put(`/candidates/${candidate.id}`, {
        interview_date: date || "",
        interview_time: time || "",
        interviewer: interviewer || "",
        meet_link: meetLink || "",
      });
      onSaved(res.data);
    } catch (e) {
      setErr(e.response?.data?.detail || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setErr("Could not copy. Select the text and copy manually.");
    }
  };

  return (
    <Modal title="Schedule Interview" onClose={onClose}>
      <div className="space-y-5">
        <div className="bg-slate-50 p-3 rounded-lg flex items-center justify-between">
          <div>
            <p className="font-bold text-[#1E2A47] text-sm">{candidate.first_name} {candidate.last_name}</p>
            <p className="text-xs text-slate-500">{candidate.position} • {candidate.department}</p>
          </div>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${STATUS_COLORS[candidate.status]}`}>{candidate.status}</span>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Date</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} data-testid="schedule-date"
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Time</label>
            <input type="time" value={time} onChange={e => setTime(e.target.value)} data-testid="schedule-time"
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
          </div>
          <div className="col-span-2">
            <label className="block text-xs font-semibold text-slate-700 mb-1">Interviewer</label>
            <input value={interviewer} onChange={e => setInterviewer(e.target.value)} placeholder="Name of interviewer"
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" data-testid="schedule-interviewer" />
          </div>
          <div className="col-span-2">
            <label className="block text-xs font-semibold text-slate-700 mb-1">Google Meet Link <span className="text-slate-400 font-normal">(create one in Google Calendar and paste here)</span></label>
            <input type="url" value={meetLink} onChange={e => setMeetLink(e.target.value)} placeholder="https://meet.google.com/..."
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" data-testid="schedule-meet-link" />
            <p className="text-[10px] text-slate-500 mt-1">
              Tip: open <a className="text-[#E85B1E] hover:underline" href="https://calendar.google.com/calendar/u/0/r/eventedit" target="_blank" rel="noopener noreferrer">Google Calendar → New Event → Add Google Meet</a>, then copy-paste the link here.
            </p>
          </div>
        </div>

        {err && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm p-3 rounded-lg flex items-start gap-2">
            <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
            <span>{err}</span>
          </div>
        )}

        <div className="border-t pt-4">
          <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Invitation message preview</p>
          <pre data-testid="invite-preview" className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs text-slate-700 whitespace-pre-wrap font-sans max-h-40 overflow-y-auto">{message}</pre>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <button type="button" onClick={copyMessage} data-testid="copy-invite-btn"
            className="flex items-center justify-center gap-1 px-3 py-2 bg-slate-100 text-slate-700 rounded-lg text-xs font-semibold hover:bg-slate-200">
            <Copy size={12} /> {copied ? "Copied!" : "Copy"}
          </button>
          <a
            href={waUrl || "#"}
            onClick={(e) => { if (!waUrl) { e.preventDefault(); alert("Mobile number is missing for this candidate."); } }}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="whatsapp-share-btn"
            className={`flex items-center justify-center gap-1 px-3 py-2 rounded-lg text-xs font-semibold ${waUrl ? "bg-green-500 text-white hover:bg-green-600" : "bg-slate-200 text-slate-400 cursor-not-allowed"}`}
          >
            <Send size={12} /> WhatsApp
          </a>
          <a
            href={mailto || "#"}
            onClick={(e) => { if (!mailto) { e.preventDefault(); alert("Email is missing for this candidate."); } }}
            data-testid="email-share-btn"
            className={`flex items-center justify-center gap-1 px-3 py-2 rounded-lg text-xs font-semibold ${mailto ? "bg-blue-600 text-white hover:bg-blue-700" : "bg-slate-200 text-slate-400 cursor-not-allowed"}`}
          >
            <Mail size={12} /> Email
          </a>
        </div>

        <div className="flex gap-3 pt-2 border-t">
          <button type="button" onClick={onClose} className="flex-1 px-4 py-2.5 border-2 border-slate-300 text-slate-600 rounded-lg text-sm font-medium">Close</button>
          <button type="button" onClick={save} disabled={saving} data-testid="save-schedule-btn"
            className="flex-1 px-4 py-2.5 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold disabled:opacity-60">
            {saving ? "Saving..." : "Save Interview"}
          </button>
        </div>
      </div>
    </Modal>
  );
}


function JoiningKitPanel({ candidate, onCandidateUpdate }) {
  const [empId, setEmpId] = useState(candidate.employee_id || "");
  const [joiningDate, setJoiningDate] = useState(candidate.expected_joining_date || "");
  const [joiningLocation, setJoiningLocation] = useState(candidate.joining_location || "");
  const [savingMeta, setSavingMeta] = useState(false);
  const [suggestionLoading, setSuggestionLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [err, setErr] = useState("");
  const [showConvert, setShowConvert] = useState(false);
  const [converting, setConverting] = useState(false);
  const [convertedInfo, setConvertedInfo] = useState(null);
  const [convertForm, setConvertForm] = useState({
    role: "field_agent",
    ctc_monthly: "",
    basic: 0, hra: 0, special_allowance: 0,
    canteen_allowance: 0, conveyance_allowance: 0,
    bank_name: "", account_number: "", account_number_confirm: "",
    ifsc_code: "", reporting_to: "", password: "",
  });
  const [reportingToInfo, setReportingToInfo] = useState(null); // {name, designation} | {error}
  const [reportingToChecking, setReportingToChecking] = useState(false);

  const ctcNum = parseFloat(convertForm.ctc_monthly) || 0;
  const computedBasic = ctcNum > 0 ? Math.round(ctcNum * 0.5) : parseFloat(convertForm.basic) || 0;
  const computedHra = ctcNum > 0 ? Math.round(ctcNum * 0.2) : parseFloat(convertForm.hra) || 0;
  const computedSpecial = ctcNum > 0 ? Math.round(ctcNum * 0.3) : parseFloat(convertForm.special_allowance) || 0;
  const grossDisplay = computedBasic + computedHra + computedSpecial +
    (parseFloat(convertForm.canteen_allowance) || 0) + (parseFloat(convertForm.conveyance_allowance) || 0);

  const ifscValid = !convertForm.ifsc_code || /^[A-Z]{4}0[A-Z0-9]{6}$/.test(convertForm.ifsc_code.toUpperCase());
  const accNumMatch = !convertForm.account_number || convertForm.account_number === convertForm.account_number_confirm;

  // Lookup Reporting-To employee on debounce
  useEffect(() => {
    const value = (convertForm.reporting_to || "").trim().toUpperCase();
    setReportingToInfo(null);
    if (!value) return;
    setReportingToChecking(true);
    const t = setTimeout(async () => {
      try {
        const res = await API.get(`/employees/${value}`);
        const e = res.data;
        setReportingToInfo({
          name: `${e.first_name || ""} ${e.last_name || ""}`.trim(),
          designation: e.designation,
          department: e.department,
        });
      } catch (err) {
        setReportingToInfo({ error: err.response?.status === 404 ? `No employee with ID ${value}` : "Lookup failed" });
      } finally {
        setReportingToChecking(false);
      }
    }, 350);
    return () => { clearTimeout(t); setReportingToChecking(false); };
  }, [convertForm.reporting_to]);

  const dirty =
    empId.trim() !== (candidate.employee_id || "") ||
    joiningDate !== (candidate.expected_joining_date || "") ||
    joiningLocation !== (candidate.joining_location || "");

  const fetchSuggestion = async () => {
    setSuggestionLoading(true);
    try {
      const res = await API.get("/candidates/meta/next-employee-id");
      setEmpId(res.data.suggestion);
    } catch (e) {
      setErr(e.response?.data?.detail || "Could not fetch suggestion");
    } finally {
      setSuggestionLoading(false);
    }
  };

  const saveMeta = async () => {
    setErr("");
    setSavingMeta(true);
    try {
      const res = await API.put(`/candidates/${candidate.id}`, {
        employee_id: empId.trim().toUpperCase(),
        expected_joining_date: joiningDate || "",
        joining_location: joiningLocation || "",
      });
      onCandidateUpdate(res.data);
    } catch (e) {
      setErr(e.response?.data?.detail || "Failed to save");
    } finally {
      setSavingMeta(false);
    }
  };

  const downloadKit = async () => {
    setErr("");
    setDownloading(true);
    try {
      const res = await API.get(`/candidates/${candidate.id}/joining-kit`, { responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = `JoiningKit_${candidate.first_name || ""}_${candidate.last_name || ""}.pdf`.replace(/\s+/g, "_");
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 500);
    } catch (e) {
      try {
        const text = await e.response.data.text();
        const parsed = JSON.parse(text);
        setErr(parsed.detail || "Failed to generate PDF");
      } catch (_) {
        setErr("Failed to generate PDF");
      }
    } finally {
      setDownloading(false);
    }
  };

  const ready = !!(candidate.employee_id && candidate.expected_joining_date) && !dirty;
  const isConverted = candidate.status === "converted";

  const doConvert = async () => {
    setErr("");
    // Client-side validation
    if (convertForm.ifsc_code && !ifscValid) {
      setErr("Invalid IFSC code. Must be 4 letters + 0 + 6 alphanumeric (e.g. HDFC0001234).");
      return;
    }
    if (convertForm.account_number && !accNumMatch) {
      setErr("Account numbers do not match. Please re-enter to confirm.");
      return;
    }
    if (reportingToInfo?.error) {
      setErr(reportingToInfo.error);
      return;
    }
    setConverting(true);
    try {
      const payload = {
        role: convertForm.role || "employee",
        ctc_monthly: parseFloat(convertForm.ctc_monthly) || 0,
        basic: ctcNum > 0 ? 0 : parseFloat(convertForm.basic) || 0,
        hra: ctcNum > 0 ? 0 : parseFloat(convertForm.hra) || 0,
        special_allowance: ctcNum > 0 ? 0 : parseFloat(convertForm.special_allowance) || 0,
        canteen_allowance: parseFloat(convertForm.canteen_allowance) || 0,
        conveyance_allowance: parseFloat(convertForm.conveyance_allowance) || 0,
      };
      if (convertForm.bank_name) payload.bank_name = convertForm.bank_name;
      if (convertForm.account_number) payload.account_number = convertForm.account_number;
      if (convertForm.ifsc_code) payload.ifsc_code = convertForm.ifsc_code.toUpperCase();
      if (convertForm.reporting_to) payload.reporting_to = convertForm.reporting_to.trim().toUpperCase();
      if (convertForm.password) payload.password = convertForm.password;

      const res = await API.post(`/candidates/${candidate.id}/convert-to-employee`, payload);
      setConvertedInfo(res.data);
      setShowConvert(false);
      onCandidateUpdate({ ...candidate, status: "converted", employee_db_id: res.data.employee_db_id });
    } catch (e) {
      setErr(e.response?.data?.detail || "Conversion failed");
    } finally {
      setConverting(false);
    }
  };

  return (
    <div className="bg-amber-50 border border-amber-100 rounded-lg p-4 space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            Employee ID <span className="text-red-500">*</span>
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={empId}
              onChange={(e) => setEmpId(e.target.value.toUpperCase())}
              placeholder="e.g. RMF0001"
              data-testid="employee-id-input"
              className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-[#E85B1E] outline-none bg-white"
            />
            <button
              type="button"
              onClick={fetchSuggestion}
              disabled={suggestionLoading}
              data-testid="suggest-employee-id-btn"
              className="px-3 py-2 text-xs bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 whitespace-nowrap"
              title="Suggest next available ID"
            >
              {suggestionLoading ? "..." : "Auto"}
            </button>
          </div>
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            Tentative Joining Date <span className="text-red-500">*</span>
          </label>
          <input
            type="date"
            value={joiningDate}
            onChange={(e) => setJoiningDate(e.target.value)}
            data-testid="tentative-joining-date"
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none bg-white"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="block text-xs font-semibold text-slate-700 mb-1">Joining Location</label>
          <input
            type="text"
            value={joiningLocation}
            onChange={(e) => setJoiningLocation(e.target.value)}
            placeholder="Head Office, Moradabad"
            data-testid="joining-location-input"
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none bg-white"
          />
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <button
          type="button"
          onClick={saveMeta}
          disabled={savingMeta || !dirty || !empId.trim() || !joiningDate}
          data-testid="save-joining-meta-btn"
          className="flex-1 px-4 py-2 bg-[#1E2A47] text-white rounded-lg text-sm font-semibold hover:bg-[#2A3A5E] disabled:opacity-50"
        >
          {savingMeta ? "Saving..." : "Save Details"}
        </button>
        <button
          type="button"
          onClick={downloadKit}
          disabled={downloading || !ready}
          data-testid="download-joining-kit-btn"
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold hover:bg-[#D04A15] disabled:opacity-50"
        >
          {downloading ? (
            <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Generating...</>
          ) : (
            <><FileText size={14} /> Download Joining Kit (PDF)</>
          )}
        </button>
      </div>

      <div className="border-t border-amber-200 pt-3">
        {convertedInfo ? (
          <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm" data-testid="conversion-success">
            <div className="flex items-start gap-2">
              <CheckCircle2 size={16} className="text-green-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-green-800">{convertedInfo.message}</p>
                <p className="text-xs text-green-700 mt-1">Employee ID: <span className="font-mono">{convertedInfo.employee_id}</span></p>
                <p className="text-xs text-green-700">Default password: <span className="font-mono">{convertedInfo.default_password}</span> — share with employee on day 1.</p>
              </div>
            </div>
          </div>
        ) : isConverted ? (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm flex items-center gap-2" data-testid="already-converted">
            <CheckCircle2 size={16} className="text-blue-600" />
            <span className="text-blue-800 font-semibold">Already converted to Employee</span>
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setShowConvert((s) => !s)}
              disabled={!ready}
              data-testid="open-convert-employee-btn"
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-green-600 text-white rounded-lg text-sm font-semibold hover:bg-green-700 disabled:opacity-50"
            >
              <UserCheck size={14} /> {showConvert ? "Cancel Conversion" : "Convert to Employee"}
            </button>
            {!ready && (
              <p className="text-[11px] text-amber-700 mt-2">Save Employee ID and Joining Date first.</p>
            )}
          </>
        )}

        {showConvert && (
          <div className="mt-3 bg-white border border-slate-200 rounded-lg p-3 space-y-3" data-testid="convert-form">
            <p className="text-xs text-slate-500">Set CTC, role and bank details. KYC documents (Aadhaar / PAN) and personal data will be copied automatically.</p>

            {/* CTC + role */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Monthly CTC (₹) <span className="text-red-500">*</span>
                </label>
                <input
                  type="number" min="0" step="100"
                  value={convertForm.ctc_monthly}
                  onChange={e => setConvertForm({ ...convertForm, ctc_monthly: e.target.value })}
                  data-testid="convert-ctc-monthly"
                  placeholder="e.g. 20000"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none"
                />
                {ctcNum > 0 && (
                  <p className="text-[10px] text-slate-500 mt-1">
                    Annual CTC: <span className="font-semibold">₹{(ctcNum * 12).toLocaleString("en-IN")}</span>
                  </p>
                )}
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Role</label>
                <select value={convertForm.role} onChange={e => setConvertForm({ ...convertForm, role: e.target.value })}
                  data-testid="convert-role-select"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-[#E85B1E] outline-none">
                  <option value="field_agent">Field Staff</option>
                  <option value="employee">HO Staff</option>
                  <option value="branch_manager">Manager</option>
                  <option value="hr_admin">HR Admin</option>
                  <option value="management">Management</option>
                </select>
              </div>
            </div>

            {/* Auto-distributed salary breakup display */}
            {ctcNum > 0 && (
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs space-y-1" data-testid="ctc-breakup">
                <p className="font-semibold text-[#1E2A47]">Salary Breakup (auto-distributed from CTC)</p>
                <div className="grid grid-cols-3 gap-2 text-slate-600">
                  <div>Basic (50%): <span className="font-mono font-semibold text-[#1E2A47]">₹{computedBasic.toLocaleString("en-IN")}</span></div>
                  <div>HRA (20%): <span className="font-mono font-semibold text-[#1E2A47]">₹{computedHra.toLocaleString("en-IN")}</span></div>
                  <div>Special (30%): <span className="font-mono font-semibold text-[#1E2A47]">₹{computedSpecial.toLocaleString("en-IN")}</span></div>
                </div>
                <p className="text-[10px] text-slate-400 italic">HR can fine-tune the breakup later from the Employee detail page.</p>
              </div>
            )}

            {/* Reporting To with live lookup */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Reporting To <span className="text-slate-400">(Employee ID)</span>
              </label>
              <input
                value={convertForm.reporting_to}
                onChange={e => setConvertForm({ ...convertForm, reporting_to: e.target.value.toUpperCase() })}
                placeholder="e.g. RMF0002"
                data-testid="convert-reporting-to"
                className={`w-full border rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-[#E85B1E] outline-none ${reportingToInfo?.error ? "border-red-300" : "border-slate-300"}`}
              />
              {reportingToChecking && (
                <p className="text-[11px] text-slate-400 mt-1 flex items-center gap-1">
                  <div className="w-3 h-3 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin" /> Looking up...
                </p>
              )}
              {!reportingToChecking && reportingToInfo && !reportingToInfo.error && (
                <p className="text-[11px] text-green-700 mt-1 flex items-center gap-1" data-testid="reporting-to-name">
                  <CheckCircle2 size={12} /> {reportingToInfo.name} <span className="text-slate-500">— {reportingToInfo.designation}, {reportingToInfo.department}</span>
                </p>
              )}
              {!reportingToChecking && reportingToInfo?.error && (
                <p className="text-[11px] text-red-600 mt-1 flex items-center gap-1" data-testid="reporting-to-error">
                  <AlertCircle size={12} /> {reportingToInfo.error}
                </p>
              )}
            </div>

            {/* Bank details */}
            <div className="border-t border-slate-100 pt-3 grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Bank Name</label>
                <input value={convertForm.bank_name} onChange={e => setConvertForm({ ...convertForm, bank_name: e.target.value })}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">IFSC Code</label>
                <input
                  value={convertForm.ifsc_code}
                  onChange={e => setConvertForm({ ...convertForm, ifsc_code: e.target.value.toUpperCase() })}
                  data-testid="convert-ifsc"
                  placeholder="HDFC0001234"
                  maxLength={11}
                  className={`w-full border rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-[#E85B1E] outline-none ${convertForm.ifsc_code && !ifscValid ? "border-red-300" : "border-slate-300"}`}
                />
                {convertForm.ifsc_code && !ifscValid && (
                  <p className="text-[11px] text-red-600 mt-1" data-testid="ifsc-error">
                    Invalid format. Must be 4 letters + 0 + 6 alphanumeric.
                  </p>
                )}
                {convertForm.ifsc_code && ifscValid && (
                  <p className="text-[11px] text-green-600 mt-1" data-testid="ifsc-valid">Valid IFSC format.</p>
                )}
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Bank A/c No.</label>
                <input
                  type="password"
                  value={convertForm.account_number}
                  onChange={e => setConvertForm({ ...convertForm, account_number: e.target.value.replace(/\D/g, "") })}
                  data-testid="convert-account-number"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-[#E85B1E] outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Re-enter A/c No. <span className="text-slate-400">(confirmation)</span>
                </label>
                <input
                  value={convertForm.account_number_confirm}
                  onChange={e => setConvertForm({ ...convertForm, account_number_confirm: e.target.value.replace(/\D/g, "") })}
                  data-testid="convert-account-number-confirm"
                  className={`w-full border rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-[#E85B1E] outline-none ${convertForm.account_number_confirm && !accNumMatch ? "border-red-300" : "border-slate-300"}`}
                />
                {convertForm.account_number_confirm && !accNumMatch && (
                  <p className="text-[11px] text-red-600 mt-1" data-testid="account-number-mismatch">
                    Account numbers do not match.
                  </p>
                )}
                {convertForm.account_number_confirm && accNumMatch && convertForm.account_number && (
                  <p className="text-[11px] text-green-600 mt-1">Account numbers match.</p>
                )}
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-semibold text-slate-700 mb-1">Initial Password <span className="text-slate-400">(default: Welcome@123)</span></label>
                <input value={convertForm.password} onChange={e => setConvertForm({ ...convertForm, password: e.target.value })}
                  placeholder="Welcome@123" data-testid="convert-password"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-[#E85B1E] outline-none" />
              </div>
            </div>

            {ctcNum > 0 && (
              <div className="text-xs text-slate-500 bg-slate-50 rounded-lg p-2">
                <strong>Will copy:</strong> Name, Mobile, Email, DOB, Gender, Father/Husband, Aadhaar, PAN, Address (current = permanent), Department, Designation (= Position), Joining Date, Joining Location, KYC document images.
              </div>
            )}

            <button
              type="button"
              onClick={doConvert}
              disabled={converting || ctcNum <= 0 || !ifscValid || !accNumMatch || reportingToInfo?.error}
              data-testid="confirm-convert-btn"
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-green-600 text-white rounded-lg text-sm font-semibold hover:bg-green-700 disabled:opacity-50"
            >
              {converting ? (
                <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Converting...</>
              ) : (
                <><UserCheck size={14} /> Confirm — Create Employee</>
              )}
            </button>
            {ctcNum <= 0 && (
              <p className="text-[11px] text-amber-700">Set a Monthly CTC to enable conversion.</p>
            )}
          </div>
        )}
      </div>

      {!ready && (empId.trim() === "" || !joiningDate) && (
        <p className="text-[11px] text-amber-700">
          Set both <strong>Employee ID</strong> and <strong>Tentative Joining Date</strong> (then click Save Details) to enable the PDF download.
        </p>
      )}
      {dirty && (
        <p className="text-[11px] text-amber-700">You have unsaved changes — click Save Details before downloading.</p>
      )}
      {err && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-2 flex items-start gap-2">
          <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
          <span>{err}</span>
        </div>
      )}
      <p className="text-[11px] text-slate-500">
        The PDF mirrors the company's <em>Joining Kit Online</em> document 1:1 — bilingual labels, all sections, with KYC fields auto-filled.
      </p>
    </div>
  );
}
