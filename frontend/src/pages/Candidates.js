import React, { useEffect, useState } from "react";
import API from "../utils/api";
import { useAuth } from "../contexts/AuthContext";
import { UserPlus, Search, X, Upload, Camera } from "lucide-react";

const STATUS_COLORS = { pending: "bg-amber-100 text-amber-700", selected: "bg-green-100 text-green-700", rejected: "bg-red-100 text-red-700" };

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b sticky top-0 bg-white">
          <h3 className="text-lg font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>{title}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100"><X size={18} /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

const INITIAL_FORM = { first_name: "", last_name: "", mobile: "", email: "", position: "", department: "", interview_date: "", status: "pending", rejection_reason: "", expected_joining_date: "", offered_ctc: "", notes: "" };

export default function Candidates() {
  const { user } = useAuth();
  const [candidates, setCandidates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [showDetail, setShowDetail] = useState(null);
  const [form, setForm] = useState(INITIAL_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [aadhaarFile, setAadhaarFile] = useState(null);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrResult, setOcrResult] = useState(null);

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

  const handleAdd = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = { ...form, offered_ctc: form.offered_ctc ? parseFloat(form.offered_ctc) : null };
      await API.post("/candidates", payload);
      setShowAdd(false);
      setForm(INITIAL_FORM);
      fetchCandidates();
    } catch (e) { setError(e.response?.data?.detail || "Failed"); }
    finally { setSaving(false); }
  };

  const handleStatusUpdate = async (candId, status, extra = {}) => {
    try {
      await API.put(`/candidates/${candId}`, { status, ...extra });
      fetchCandidates();
      if (showDetail?.id === candId) setShowDetail({ ...showDetail, status, ...extra });
    } catch (e) { alert(e.response?.data?.detail || "Update failed"); }
  };

  const handleAadhaarOCR = async (candId) => {
    if (!aadhaarFile) return;
    setOcrLoading(true);
    setOcrResult(null);
    try {
      const reader = new FileReader();
      reader.onload = async (ev) => {
        const base64 = ev.target.result.split(",")[1];
        const mime = aadhaarFile.type;
        try {
          const res = await API.post(`/candidates/${candId}/aadhaar-ocr`, { image_base64: base64, mime_type: mime });
          setOcrResult(res.data.data);
        } catch (e) { alert("OCR failed: " + (e.response?.data?.detail || "Unknown error")); }
        finally { setOcrLoading(false); }
      };
      reader.readAsDataURL(aadhaarFile);
    } catch (e) { setOcrLoading(false); }
  };

  return (
    <div style={{ fontFamily: "'Work Sans', sans-serif" }}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>Candidate Management</h1>
          <p className="text-slate-500 text-sm">{candidates.length} candidates</p>
        </div>
        <button onClick={() => { setShowAdd(true); setError(""); }} data-testid="add-candidate-btn"
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
        </select>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full" data-testid="candidates-table">
            <thead><tr className="bg-slate-50 border-b">
              {["Name", "Mobile", "Position", "Department", "Interview Date", "Status", "Actions"].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {loading ? <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">Loading...</td></tr>
                : candidates.length === 0 ? <tr><td colSpan={7} className="px-4 py-12 text-center text-slate-400">No candidates found</td></tr>
                : candidates.map(c => (
                  <tr key={c.id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-[#0F172A]">{c.first_name} {c.last_name}</p>
                      <p className="text-xs text-slate-400">{c.email || "-"}</p>
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-600">{c.mobile}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{c.position}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{c.department}</td>
                    <td className="px-4 py-3 text-sm text-slate-500">{c.interview_date || "-"}</td>
                    <td className="px-4 py-3"><span className={`px-2 py-1 rounded-full text-xs font-medium capitalize ${STATUS_COLORS[c.status] || "bg-slate-100 text-slate-700"}`}>{c.status}</span></td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        <button onClick={() => setShowDetail(c)} className="text-xs px-2 py-1 bg-[#1E2A47]/10 text-[#1E2A47] rounded-lg hover:bg-[#1E2A47]/20">View</button>
                        {c.status === "pending" && (
                          <>
                            <button onClick={() => handleStatusUpdate(c.id, "selected")} className="text-xs px-2 py-1 bg-green-100 text-green-700 rounded-lg hover:bg-green-200">Select</button>
                            <button onClick={() => handleStatusUpdate(c.id, "rejected", { rejection_reason: "Not suitable" })} className="text-xs px-2 py-1 bg-red-100 text-red-700 rounded-lg hover:bg-red-200">Reject</button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add Candidate Modal */}
      {showAdd && (
        <Modal title="Add Candidate" onClose={() => setShowAdd(false)}>
          <form onSubmit={handleAdd} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              {[["first_name", "First Name", "text", true], ["last_name", "Last Name", "text", true], ["mobile", "Mobile", "tel", true], ["email", "Email", "email", false], ["position", "Position Applied For", "text", true], ["department", "Department", "text", true]].map(([key, label, type, req]) => (
                <div key={key}>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">{label}{req && <span className="text-red-500">*</span>}</label>
                  <input type={type} value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })} required={req}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
                </div>
              ))}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Interview Date</label>
                <input type="date" value={form.interview_date} onChange={e => setForm({ ...form, interview_date: e.target.value })}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
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
              <div className="grid grid-cols-2 gap-3 border-t pt-3">
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
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Rejection Reason</label>
                <input value={form.rejection_reason} onChange={e => setForm({ ...form, rejection_reason: e.target.value })}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
              </div>
            )}
            {error && <div className="bg-red-50 text-red-700 text-sm p-3 rounded-lg">{error}</div>}
            <div className="flex gap-3">
              <button type="button" onClick={() => setShowAdd(false)} className="flex-1 px-4 py-2.5 border-2 border-slate-300 text-slate-600 rounded-lg text-sm font-medium">Cancel</button>
              <button type="submit" disabled={saving} data-testid="save-candidate-btn" className="flex-1 px-4 py-2.5 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold disabled:opacity-60">{saving ? "Saving..." : "Add Candidate"}</button>
            </div>
          </form>
        </Modal>
      )}

      {/* Detail Modal with Aadhaar OCR */}
      {showDetail && (
        <Modal title="Candidate Details" onClose={() => { setShowDetail(null); setOcrResult(null); setAadhaarFile(null); }}>
          <div className="space-y-4">
            <div className="bg-slate-50 p-4 rounded-lg">
              <h3 className="font-bold text-[#1E2A47]">{showDetail.first_name} {showDetail.last_name}</h3>
              <p className="text-sm text-slate-500">{showDetail.position} | {showDetail.department}</p>
              <span className={`mt-1 inline-block px-2 py-0.5 rounded-full text-xs font-medium capitalize ${STATUS_COLORS[showDetail.status]}`}>{showDetail.status}</span>
            </div>
            {[["Mobile", showDetail.mobile], ["Email", showDetail.email], ["Interview Date", showDetail.interview_date], ["Expected Joining", showDetail.expected_joining_date], ["Offered CTC", showDetail.offered_ctc ? `₹${showDetail.offered_ctc}/month` : null]].map(([label, val]) => val && (
              <div key={label} className="flex justify-between text-sm border-b border-slate-100 pb-1">
                <span className="text-slate-500">{label}</span>
                <span className="font-medium text-[#0F172A]">{val}</span>
              </div>
            ))}

            {/* Aadhaar OCR Section */}
            <div className="border-t pt-4">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">Aadhaar OCR (Gemini AI)</p>
              {showDetail.aadhaar_data && (
                <div className="bg-green-50 border border-green-200 p-3 rounded-lg mb-3 text-sm">
                  <p className="font-semibold text-green-700 mb-1">Extracted Data:</p>
                  {Object.entries(showDetail.aadhaar_data).map(([k, v]) => v && (
                    <p key={k} className="text-slate-600"><span className="font-medium">{k}:</span> {String(v)}</p>
                  ))}
                </div>
              )}
              <div className="flex gap-2 items-center">
                <input type="file" accept="image/*" onChange={e => setAadhaarFile(e.target.files[0])} className="text-xs flex-1 border border-slate-200 rounded-lg p-2" />
                <button onClick={() => handleAadhaarOCR(showDetail.id)} disabled={!aadhaarFile || ocrLoading} data-testid="aadhaar-ocr-btn"
                  className="flex items-center gap-2 px-3 py-2 bg-[#1E2A47] text-white rounded-lg text-xs font-semibold disabled:opacity-60">
                  {ocrLoading ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Camera size={14} />}
                  {ocrLoading ? "Extracting..." : "Extract"}
                </button>
              </div>
              {ocrResult && (
                <div className="mt-2 bg-blue-50 border border-blue-200 p-3 rounded-lg text-xs text-slate-700">
                  {Object.entries(ocrResult).map(([k, v]) => v && <p key={k}><span className="font-semibold">{k}:</span> {String(v)}</p>)}
                </div>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
