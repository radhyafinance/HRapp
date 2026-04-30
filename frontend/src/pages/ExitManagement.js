import React, { useEffect, useState } from "react";
import API from "../utils/api";
import { useAuth } from "../contexts/AuthContext";
import { Plus, X, Check, Eye, UserCheck } from "lucide-react";

const STATUS_COLORS = { pending: "bg-amber-100 text-amber-700", approved: "bg-green-100 text-green-700", rejected: "bg-red-100 text-red-700", cleared: "bg-blue-100 text-blue-700" };

/* Inline reporting manager chip */
function ReportingManagerChip({ employeeId }) {
  const [mgr, setMgr] = useState(null);
  useEffect(() => {
    if (!employeeId) return;
    API.get(`/employees/${employeeId}`)
      .then(r => {
        if (r.data.reporting_to) setMgr(r.data.reporting_to);
      }).catch(() => {});
  }, [employeeId]);
  if (!mgr) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-slate-400 mt-0.5">
      <UserCheck size={11} /> {mgr}
    </span>
  );
}

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

export default function ExitManagement() {
  const { user } = useAuth();
  const [exits, setExits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showResign, setShowResign] = useState(false);
  const [showDetail, setShowDetail] = useState(null);
  const [showFFS, setShowFFS] = useState(null);
  const [ffsData, setFFSData] = useState(null);
  const [form, setForm] = useState({ employee_id: user?.employee_id || "", resignation_date: "", reason: "", notice_period_waiver: false });
  const [saving, setSaving] = useState(false);
  const isManager = ["hr_admin", "management", "managers"].includes(user?.role);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await API.get("/exit");
      setExits(res.data);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchData(); }, []);

  const handleResign = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await API.post("/exit", form);
      setShowResign(false);
      fetchData();
    } catch (e) { alert(e.response?.data?.detail || "Failed to submit resignation"); }
    finally { setSaving(false); }
  };

  const handleApproval = async (exitId, action) => {
    try {
      await API.put(`/exit/${exitId}/approve`, { action, remarks: "" });
      fetchData();
    } catch (e) { alert(e.response?.data?.detail || "Action failed"); }
  };

  const loadFFS = async (exitId) => {
    try {
      const res = await API.get(`/exit/${exitId}/ffs`);
      setFFSData(res.data);
      setShowFFS(exitId);
    } catch (e) { alert("Failed to load FFS"); }
  };

  return (
    <div style={{ fontFamily: "'Work Sans', sans-serif" }}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>Exit Management</h1>
          <p className="text-slate-500 text-sm">Resignation & Full & Final Settlement</p>
        </div>
        <button onClick={() => setShowResign(true)} data-testid="resign-btn"
          className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-semibold hover:bg-red-700 transition-colors">
          <Plus size={16} /> Submit Resignation
        </button>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full" data-testid="exit-table">
            <thead><tr className="bg-slate-50 border-b">
              {["Employee", "Resignation Date", "Last Working Day", "Notice Period", "Status", "Approvals", "Actions"].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {loading ? <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">Loading...</td></tr>
                : exits.length === 0 ? <tr><td colSpan={7} className="px-4 py-12 text-center text-slate-400">No exit requests</td></tr>
                : exits.map(e => (
                  <tr key={e.id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium">{e.employee_name}</p>
                      <p className="text-xs text-[#E85B1E] font-mono">{e.employee_id}</p>
                      <ReportingManagerChip employeeId={e.employee_id} />
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-600">{e.resignation_date}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{e.last_working_date}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{e.notice_period_days} days</td>
                    <td className="px-4 py-3"><span className={`px-2 py-1 rounded-full text-xs font-medium capitalize ${STATUS_COLORS[e.status] || "bg-slate-100 text-slate-700"}`}>{e.status}</span></td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        {e.approval_chain?.map((a, i) => (
                          <span key={i} className={`text-xs px-1.5 py-0.5 rounded ${a.status === "approve" ? "bg-green-100 text-green-700" : a.status === "reject" ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-500"}`}>
                            {a.level.split(" ")[0]}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        {isManager && e.status === "pending" && (
                          <>
                            <button onClick={() => handleApproval(e.id, "approve")} data-testid={`approve-exit-${e.id}`} className="p-1.5 rounded-lg bg-green-100 text-green-700 hover:bg-green-200"><Check size={14} /></button>
                            <button onClick={() => handleApproval(e.id, "reject")} className="p-1.5 rounded-lg bg-red-100 text-red-700 hover:bg-red-200"><X size={14} /></button>
                          </>
                        )}
                        {isManager && e.status === "approved" && (
                          <button onClick={() => loadFFS(e.id)} className="text-xs px-2 py-1 bg-blue-100 text-blue-700 rounded-lg hover:bg-blue-200">FFS</button>
                        )}
                        <button onClick={() => setShowDetail(e)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500"><Eye size={14} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Resignation Modal */}
      {showResign && (
        <Modal title="Submit Resignation" onClose={() => setShowResign(false)}>
          <form onSubmit={handleResign} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Employee ID*</label>
              <input value={form.employee_id} onChange={e => setForm({ ...form, employee_id: e.target.value })} placeholder="e.g. RMF0001" required
                className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Resignation Date*</label>
              <input type="date" value={form.resignation_date} onChange={e => setForm({ ...form, resignation_date: e.target.value })} required
                className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Reason for Resignation*</label>
              <textarea value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} required rows={4}
                className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none resize-none" />
            </div>
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
              Please note: Your notice period will be calculated based on your grade and employment status.
            </div>
            <div className="flex gap-3">
              <button type="button" onClick={() => setShowResign(false)} className="flex-1 px-4 py-2.5 border-2 border-slate-300 text-slate-600 rounded-lg text-sm font-medium">Cancel</button>
              <button type="submit" disabled={saving} data-testid="submit-resignation-btn" className="flex-1 px-4 py-2.5 bg-red-600 text-white rounded-lg text-sm font-semibold disabled:opacity-60">{saving ? "Submitting..." : "Submit Resignation"}</button>
            </div>
          </form>
        </Modal>
      )}

      {/* FFS Modal */}
      {showFFS && ffsData && (
        <Modal title="Full & Final Settlement" onClose={() => { setShowFFS(null); setFFSData(null); }}>
          <div className="space-y-4" data-testid="ffs-modal">
            <div className="bg-[#1E2A47] text-white p-4 rounded-lg">
              <p className="font-bold text-lg">{ffsData.employee_name}</p>
              <p className="text-slate-300 text-sm">Last Working Date: {ffsData.last_working_date}</p>
              <p className="text-slate-300 text-sm">Years of Service: {ffsData.years_of_service}</p>
            </div>
            {[["EL Encashment ({days} days)".replace("{days}", ffsData.el_remaining_days), ffsData.el_encashment], ["Gratuity", ffsData.gratuity_eligible ? ffsData.gratuity_amount : "Not Eligible (< 5 years)"]].map(([label, val]) => (
              <div key={label} className="flex justify-between text-sm border-b border-slate-100 pb-2">
                <span className="text-slate-600">{label}</span>
                <span className="font-bold text-[#1E2A47]">{typeof val === "number" ? `₹${val.toLocaleString("en-IN")}` : val}</span>
              </div>
            ))}
            <div className="bg-green-50 border border-green-200 p-3 rounded-lg flex justify-between font-bold">
              <span className="text-green-800">Total Amount</span>
              <span className="text-green-800">₹{ffsData.total_amount?.toLocaleString("en-IN")}</span>
            </div>
            <p className="text-xs text-slate-400">{ffsData.note}</p>
          </div>
        </Modal>
      )}
    </div>
  );
}
