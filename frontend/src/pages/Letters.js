import React, { useEffect, useState } from "react";
import API from "../utils/api";
import { useAuth } from "../contexts/AuthContext";
import { Plus, X, Download, FileText } from "lucide-react";

const LETTER_TYPES = ["appointment", "offer", "promotion", "warning", "experience", "relieving", "increment", "transfer"];
const LETTER_LABELS = { appointment: "Appointment Letter", offer: "Offer Letter", promotion: "Promotion Letter", warning: "Warning Letter", experience: "Experience Certificate", relieving: "Relieving Letter", increment: "Increment Letter", transfer: "Transfer Letter" };
const TYPE_COLORS = { appointment: "bg-green-100 text-green-700", offer: "bg-blue-100 text-blue-700", promotion: "bg-purple-100 text-purple-700", warning: "bg-red-100 text-red-700", experience: "bg-teal-100 text-teal-700", relieving: "bg-slate-100 text-slate-700", increment: "bg-[#E85B1E]/10 text-[#E85B1E]" };

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

export default function Letters() {
  const { user } = useAuth();
  const [letters, setLetters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showView, setShowView] = useState(null);
  const [form, setForm] = useState({ employee_id: "", letter_type: "appointment", custom_fields: {} });
  const [customFields, setCustomFields] = useState({});
  const [saving, setSaving] = useState(false);

  const fetchLetters = async () => {
    setLoading(true);
    try {
      const res = await API.get("/letters");
      setLetters(res.data);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchLetters(); }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await API.post("/letters", { ...form, custom_fields: customFields });
      setShowCreate(false);
      setForm({ employee_id: "", letter_type: "appointment", custom_fields: {} });
      setCustomFields({});
      fetchLetters();
    } catch (e) { alert(e.response?.data?.detail || "Failed to create letter"); }
    finally { setSaving(false); }
  };

  const downloadPDF = async (letterId, letterType, empId) => {
    try {
      const res = await API.get(`/letters/${letterId}/pdf`, { responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a"); a.href = url; a.download = `${letterType}_${empId}.pdf`; a.click();
    } catch (e) { alert("PDF download failed"); }
  };

  const fieldsByType = {
    promotion: ["new_designation", "effective_date", "new_ctc"],
    warning: ["issue", "details"],
    experience: ["last_working_date"],
    relieving: ["resignation_date", "last_working_date"],
    increment: ["old_ctc", "new_ctc", "increment_pct", "effective_date"],
    offer: ["interview_date", "expiry_date"],
  };

  const extraFields = fieldsByType[form.letter_type] || [];

  return (
    <div style={{ fontFamily: "'Work Sans', sans-serif" }}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>Letter Generation</h1>
          <p className="text-slate-500 text-sm">Generate HR letters for employees</p>
        </div>
        <button onClick={() => setShowCreate(true)} data-testid="create-letter-btn"
          className="flex items-center gap-2 px-4 py-2 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold hover:bg-[#D04A15] transition-colors">
          <Plus size={16} /> Create Letter
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {LETTER_TYPES.slice(0, 6).map(type => (
          <div key={type} className="bg-white border border-slate-200 rounded-lg p-4 cursor-pointer hover:-translate-y-0.5 transition-transform shadow-sm"
            onClick={() => { setForm({ employee_id: "", letter_type: type, custom_fields: {} }); setCustomFields({}); setShowCreate(true); }}>
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center mb-2 ${(TYPE_COLORS[type] || "bg-slate-100").split(" ")[0]}`}>
              <FileText size={16} className={(TYPE_COLORS[type] || "").split(" ")[1]} />
            </div>
            <p className="text-sm font-medium text-[#1E2A47]">{LETTER_LABELS[type]}</p>
          </div>
        ))}
      </div>

      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full" data-testid="letters-table">
            <thead><tr className="bg-slate-50 border-b">
              {["Employee", "Letter Type", "Created On", "Actions"].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {loading ? <tr><td colSpan={4} className="px-4 py-8 text-center text-slate-400">Loading...</td></tr>
                : letters.length === 0 ? <tr><td colSpan={4} className="px-4 py-12 text-center text-slate-400">No letters generated yet</td></tr>
                : letters.map(l => (
                  <tr key={l.id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-[#0F172A]">{l.employee_name}</p>
                      <p className="text-xs text-[#E85B1E] font-mono">{l.employee_id}</p>
                    </td>
                    <td className="px-4 py-3"><span className={`px-2 py-1 rounded-full text-xs font-medium ${TYPE_COLORS[l.letter_type] || "bg-slate-100 text-slate-700"}`}>{LETTER_LABELS[l.letter_type] || l.letter_type}</span></td>
                    <td className="px-4 py-3 text-sm text-slate-500">{l.created_at ? new Date(l.created_at).toLocaleDateString("en-IN") : "-"}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        <button onClick={() => setShowView(l)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500" data-testid={`view-letter-${l.id}`}><FileText size={15} /></button>
                        <button onClick={() => downloadPDF(l.id, l.letter_type, l.employee_id)} className="p-1.5 rounded-lg hover:bg-slate-100 text-[#E85B1E]" data-testid={`download-letter-${l.id}`}><Download size={15} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {showCreate && (
        <Modal title="Create Letter" onClose={() => setShowCreate(false)}>
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Employee ID*</label>
              <input value={form.employee_id} onChange={e => setForm({ ...form, employee_id: e.target.value })} placeholder="e.g. RMF0001" required
                className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Letter Type*</label>
              <select value={form.letter_type} onChange={e => { setForm({ ...form, letter_type: e.target.value }); setCustomFields({}); }}
                className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none bg-white">
                {LETTER_TYPES.map(t => <option key={t} value={t}>{LETTER_LABELS[t]}</option>)}
              </select>
            </div>
            {extraFields.map(field => (
              <div key={field}>
                <label className="block text-xs font-semibold text-slate-700 mb-1">{field.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}</label>
                <input value={customFields[field] || ""} onChange={e => setCustomFields({ ...customFields, [field]: e.target.value })}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
              </div>
            ))}
            <div className="flex gap-3">
              <button type="button" onClick={() => setShowCreate(false)} className="flex-1 px-4 py-2.5 border-2 border-slate-300 text-slate-600 rounded-lg text-sm font-medium">Cancel</button>
              <button type="submit" disabled={saving} data-testid="save-letter-btn" className="flex-1 px-4 py-2.5 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold disabled:opacity-60">{saving ? "Creating..." : "Generate Letter"}</button>
            </div>
          </form>
        </Modal>
      )}

      {showView && (
        <Modal title={LETTER_LABELS[showView.letter_type] || "Letter"} onClose={() => setShowView(null)}>
          <div className="bg-slate-50 rounded-lg p-4 font-mono text-sm whitespace-pre-wrap text-slate-700" data-testid="letter-content" style={{ minHeight: 300 }}>
            {showView.content}
          </div>
          <div className="mt-4 flex justify-end">
            <button onClick={() => downloadPDF(showView.id, showView.letter_type, showView.employee_id)} className="flex items-center gap-2 px-4 py-2 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold hover:bg-[#D04A15]">
              <Download size={16} /> Download PDF
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
