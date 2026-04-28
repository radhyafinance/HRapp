import React, { useEffect, useState } from "react";
import API from "../utils/api";
import { useAuth } from "../contexts/AuthContext";
import { Plus, X, Star } from "lucide-react";

const STATUS_COLORS = {
  pending_self_assessment: "bg-amber-100 text-amber-700",
  pending_manager_review: "bg-blue-100 text-blue-700",
  pending_approval: "bg-purple-100 text-purple-700",
  approved: "bg-green-100 text-green-700",
};

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

export default function Performance() {
  const { user } = useAuth();
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showReview, setShowReview] = useState(null);
  const [showApprove, setShowApprove] = useState(null);
  const [createForm, setCreateForm] = useState({ employee_id: "", review_period: "H1-2025", year: 2025 });
  const [selfForm, setSelfForm] = useState({ achievements: "", challenges: "", skills_developed: "", goals_next_period: "", self_rating: 3, additional_comments: "" });
  const [managerForm, setManagerForm] = useState({ performance_rating: 3, strengths: "", areas_for_improvement: "", manager_comments: "", recommended_rating: "Meets Expectations" });
  const [approveForm, setApproveForm] = useState({ ctc_increase_percentage: 0, effective_date: "", management_comments: "" });
  const [saving, setSaving] = useState(false);
  const isManager = ["hr_admin", "management"].includes(user?.role);

  const fetchReviews = async () => {
    setLoading(true);
    try {
      const res = await API.get("/performance");
      setReviews(res.data);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchReviews(); }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await API.post("/performance", createForm);
      setShowCreate(false);
      fetchReviews();
    } catch (e) { alert(e.response?.data?.detail || "Failed"); }
    finally { setSaving(false); }
  };

  const handleSelfAssessment = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await API.put(`/performance/${showReview.id}/self-assessment`, selfForm);
      setShowReview(null);
      fetchReviews();
    } catch (e) { alert(e.response?.data?.detail || "Failed"); }
    finally { setSaving(false); }
  };

  const handleManagerAssessment = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await API.put(`/performance/${showReview.id}/manager-assessment`, managerForm);
      setShowReview(null);
      fetchReviews();
    } catch (e) { alert(e.response?.data?.detail || "Failed"); }
    finally { setSaving(false); }
  };

  const handleApprove = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await API.put(`/performance/${showApprove.id}/approve`, approveForm);
      setShowApprove(null);
      fetchReviews();
    } catch (e) { alert(e.response?.data?.detail || "Failed"); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ fontFamily: "'Work Sans', sans-serif" }}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>Performance Management</h1>
          <p className="text-slate-500 text-sm">Half-yearly performance reviews</p>
        </div>
        {isManager && (
          <button onClick={() => setShowCreate(true)} data-testid="create-review-btn"
            className="flex items-center gap-2 px-4 py-2 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold hover:bg-[#D04A15] transition-colors">
            <Plus size={16} /> Create Review
          </button>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full" data-testid="performance-table">
            <thead><tr className="bg-slate-50 border-b">
              {["Employee", "Period", "Current CTC", "Status", "Self Assessment", "Manager Review", "Actions"].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {loading ? <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">Loading...</td></tr>
                : reviews.length === 0 ? <tr><td colSpan={7} className="px-4 py-12 text-center text-slate-400">No performance reviews found</td></tr>
                : reviews.map(r => (
                  <tr key={r.id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-[#0F172A]">{r.employee_name}</p>
                      <p className="text-xs text-[#E85B1E] font-mono">{r.employee_id}</p>
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-600">{r.review_period}</td>
                    <td className="px-4 py-3 text-sm font-medium">₹{r.current_ctc_monthly?.toLocaleString("en-IN")}</td>
                    <td className="px-4 py-3"><span className={`px-2 py-1 rounded-full text-xs font-medium ${STATUS_COLORS[r.status] || "bg-slate-100 text-slate-700"}`}>{r.status?.replace(/_/g, " ")}</span></td>
                    <td className="px-4 py-3 text-sm text-slate-500">{r.self_assessment ? <span className="text-green-600 font-medium">Submitted</span> : "Pending"}</td>
                    <td className="px-4 py-3 text-sm text-slate-500">{r.manager_assessment ? <span className="text-green-600 font-medium">Done</span> : "Pending"}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        {r.status === "pending_self_assessment" && r.employee_id === user?.employee_id && (
                          <button onClick={() => setShowReview({ ...r, mode: "self" })} className="text-xs px-2 py-1 bg-blue-100 text-blue-700 rounded-lg hover:bg-blue-200">Self Assessment</button>
                        )}
                        {r.status === "pending_manager_review" && ["hr_admin", "management", "branch_manager"].includes(user?.role) && (
                          <button onClick={() => setShowReview({ ...r, mode: "manager" })} className="text-xs px-2 py-1 bg-purple-100 text-purple-700 rounded-lg hover:bg-purple-200">Manager Review</button>
                        )}
                        {r.status === "pending_approval" && isManager && (
                          <button onClick={() => { setShowApprove(r); setApproveForm({ ctc_increase_percentage: 0, effective_date: "", management_comments: "" }); }} className="text-xs px-2 py-1 bg-[#E85B1E]/10 text-[#E85B1E] rounded-lg hover:bg-[#E85B1E]/20">Approve</button>
                        )}
                        {r.status === "approved" && r.new_ctc_monthly && (
                          <span className="text-xs px-2 py-1 bg-green-100 text-green-700 rounded-lg">+{r.ctc_increase_percentage}% → ₹{r.new_ctc_monthly?.toLocaleString("en-IN")}</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create Review Modal */}
      {showCreate && (
        <Modal title="Create Performance Review" onClose={() => setShowCreate(false)}>
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Employee ID*</label>
              <input value={createForm.employee_id} onChange={e => setCreateForm({ ...createForm, employee_id: e.target.value })} placeholder="e.g. RMF0001" required
                className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Review Period*</label>
              <select value={createForm.review_period} onChange={e => setCreateForm({ ...createForm, review_period: e.target.value })}
                className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none bg-white">
                {["H1-2025", "H2-2025", "H1-2026", "H2-2026"].map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div className="flex gap-3">
              <button type="button" onClick={() => setShowCreate(false)} className="flex-1 px-4 py-2.5 border-2 border-slate-300 text-slate-600 rounded-lg text-sm font-medium">Cancel</button>
              <button type="submit" disabled={saving} className="flex-1 px-4 py-2.5 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold disabled:opacity-60">
                {saving ? "Creating..." : "Create Review"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Self/Manager Assessment Modal */}
      {showReview && (
        <Modal title={showReview.mode === "self" ? "Self Assessment" : "Manager Assessment"} onClose={() => setShowReview(null)}>
          {showReview.mode === "self" ? (
            <form onSubmit={handleSelfAssessment} className="space-y-4">
              {[["achievements", "Key Achievements", 3], ["challenges", "Challenges Faced", 3], ["goals_next_period", "Goals for Next Period", 3]].map(([key, label, rows]) => (
                <div key={key}>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">{label}*</label>
                  <textarea value={selfForm[key]} onChange={e => setSelfForm({ ...selfForm, [key]: e.target.value })} required rows={rows}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none resize-none" />
                </div>
              ))}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-2">Self Rating (1-5)</label>
                <div className="flex gap-2">
                  {[1,2,3,4,5].map(n => (
                    <button key={n} type="button" onClick={() => setSelfForm({ ...selfForm, self_rating: n })}
                      className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm transition-colors ${selfForm.self_rating >= n ? "bg-[#E85B1E] text-white" : "bg-slate-100 text-slate-500"}`}>{n}</button>
                  ))}
                </div>
              </div>
              <div className="flex gap-3">
                <button type="button" onClick={() => setShowReview(null)} className="flex-1 px-4 py-2.5 border-2 border-slate-300 text-slate-600 rounded-lg text-sm font-medium">Cancel</button>
                <button type="submit" disabled={saving} className="flex-1 px-4 py-2.5 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold disabled:opacity-60">{saving ? "Saving..." : "Submit"}</button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleManagerAssessment} className="space-y-4">
              {[["strengths", "Strengths", 2], ["areas_for_improvement", "Areas for Improvement", 2], ["manager_comments", "Overall Comments", 3]].map(([key, label, rows]) => (
                <div key={key}>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">{label}*</label>
                  <textarea value={managerForm[key]} onChange={e => setManagerForm({ ...managerForm, [key]: e.target.value })} required rows={rows}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none resize-none" />
                </div>
              ))}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Overall Rating</label>
                <select value={managerForm.recommended_rating} onChange={e => setManagerForm({ ...managerForm, recommended_rating: e.target.value })}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none bg-white">
                  {["Exceptional", "Exceeds Expectations", "Meets Expectations", "Needs Improvement"].map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div className="flex gap-3">
                <button type="button" onClick={() => setShowReview(null)} className="flex-1 px-4 py-2.5 border-2 border-slate-300 text-slate-600 rounded-lg text-sm font-medium">Cancel</button>
                <button type="submit" disabled={saving} className="flex-1 px-4 py-2.5 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold disabled:opacity-60">{saving ? "Saving..." : "Submit"}</button>
              </div>
            </form>
          )}
        </Modal>
      )}

      {/* Approve Modal */}
      {showApprove && (
        <Modal title="Approve Review & Set CTC Increase" onClose={() => setShowApprove(null)}>
          <form onSubmit={handleApprove} className="space-y-4">
            <div className="bg-slate-50 p-3 rounded-lg text-sm">
              <p className="font-medium text-[#1E2A47]">{showApprove.employee_name}</p>
              <p className="text-slate-500">Current CTC: ₹{showApprove.current_ctc_monthly?.toLocaleString("en-IN")}/month</p>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">CTC Increase (%)*</label>
              <input type="number" value={approveForm.ctc_increase_percentage} onChange={e => setApproveForm({ ...approveForm, ctc_increase_percentage: parseFloat(e.target.value) || 0 })} min={0} max={100} step={0.5} required
                className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
              {approveForm.ctc_increase_percentage > 0 && (
                <p className="text-xs text-green-600 mt-1">New CTC: ₹{Math.round(showApprove.current_ctc_monthly * (1 + approveForm.ctc_increase_percentage / 100)).toLocaleString("en-IN")}/month</p>
              )}
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Effective Date*</label>
              <input type="date" value={approveForm.effective_date} onChange={e => setApproveForm({ ...approveForm, effective_date: e.target.value })} required
                className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
            </div>
            <div className="flex gap-3">
              <button type="button" onClick={() => setShowApprove(null)} className="flex-1 px-4 py-2.5 border-2 border-slate-300 text-slate-600 rounded-lg text-sm font-medium">Cancel</button>
              <button type="submit" disabled={saving} className="flex-1 px-4 py-2.5 bg-green-600 text-white rounded-lg text-sm font-semibold disabled:opacity-60">{saving ? "Approving..." : "Approve & Set Increment"}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
