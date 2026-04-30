import React, { useEffect, useState } from "react";
import API from "../utils/api";
import { useAuth } from "../contexts/AuthContext";
import { Plus, Check, X, UserCheck, Info, AlertTriangle } from "lucide-react";

const LEAVE_TYPES = ["CL", "SL", "EL", "Maternity", "Paternity", "Marriage", "Comp-Off", "LWP"];
const LEAVE_LABELS = {
  CL: "Casual Leave", SL: "Sick Leave", EL: "Earned Leave",
  Maternity: "Maternity Leave", Paternity: "Paternity Leave",
  Marriage: "Marriage Leave", "Comp-Off": "Comp-Off", LWP: "Leave Without Pay"
};
const STATUS_COLORS = {
  pending: "bg-amber-100 text-amber-700",
  approved: "bg-green-100 text-green-700",
  rejected: "bg-red-100 text-red-700"
};

// Policy hints shown below the leave type dropdown
const POLICY_HINTS = {
  CL: "Max 2 days at a time. SL and CL cannot be clubbed together.",
  SL: "Up to 2 days without documentation. From the 3rd day, a medical certificate is mandatory. Cannot be clubbed with CL.",
  EL: "Accrues after 6 months of service at 1 day/month. Encashable after 3 years (min 30 EL).",
  Marriage: "5 days, availed only once during employment. For own marriage only.",
  Paternity: "Apply at least 15 days in advance. Can be availed up to 2 times during employment.",
  Maternity: "Apply at least 30 days in advance. Can be availed up to 2 times. No EL during maternity period.",
  "Comp-Off": "Compensatory off for working on holidays/weekends.",
  LWP: "Leave Without Pay — approved by management.",
};

function ReportingManagerTag({ employeeId }) {
  const [mgr, setMgr] = useState(null);
  useEffect(() => {
    if (!employeeId) return;
    API.get(`/employees/${employeeId}`)
      .then(r => {
        if (r.data.reporting_to) {
          API.get(`/employees/${r.data.reporting_to}`)
            .then(m => setMgr(`Reports to: ${m.data.first_name} ${m.data.last_name} (${r.data.reporting_to})`))
            .catch(() => setMgr(`Reports to: ${r.data.reporting_to}`));
        }
      })
      .catch(() => {});
  }, [employeeId]);
  if (!mgr) return null;
  return (
    <p className="text-xs text-slate-400 mt-0.5 flex items-center gap-1">
      <UserCheck size={11} /> {mgr}
    </p>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b sticky top-0 bg-white">
          <h3 className="text-lg font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>{title}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500"><X size={18} /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export default function Leaves() {
  const { user } = useAuth();
  const [leaves, setLeaves] = useState([]);
  const [balance, setBalance] = useState(null);
  const [pending, setPending] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showApply, setShowApply] = useState(false);
  const [form, setForm] = useState({ leave_type: "CL", start_date: "", end_date: "", reason: "", employee_id: "", medical_certificate: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState("my");
  const isManager = ["hr_admin", "management", "managers"].includes(user?.role);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [leavesRes, balRes] = await Promise.all([
        API.get("/leaves"),
        API.get("/leaves/balance/my"),
      ]);
      setLeaves(leavesRes.data);
      setBalance(balRes.data);
      if (isManager) {
        const pendRes = await API.get("/leaves/pending");
        setPending(pendRes.data);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleApply = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = {
        ...form,
        employee_id: form.employee_id || user.employee_id,
        medical_certificate: form.medical_certificate || null,
      };
      await API.post("/leaves", payload);
      setShowApply(false);
      setForm({ leave_type: "CL", start_date: "", end_date: "", reason: "", employee_id: "", medical_certificate: "" });
      fetchData();
    } catch (e) {
      setError(e.response?.data?.detail || "Failed to apply leave");
    } finally {
      setSaving(false);
    }
  };

  const handleApproval = async (leaveId, action) => {
    try {
      await API.put(`/leaves/${leaveId}/approve`, { action, remarks: "" });
      fetchData();
    } catch (e) {
      alert(e.response?.data?.detail || "Action failed");
    }
  };

  const days = form.start_date && form.end_date
    ? Math.max(1, Math.round((new Date(form.end_date) - new Date(form.start_date)) / 86400000) + 1)
    : 0;

  const showMedCert = form.leave_type === "SL" && days > 2;
  const hint = POLICY_HINTS[form.leave_type];

  // Balance cards: CL, SL, EL, Marriage
  const BALANCE_DISPLAY = [
    { key: "CL", label: "Casual", color: "text-blue-600" },
    { key: "SL", label: "Sick", color: "text-purple-600" },
    { key: "EL", label: "Earned", color: "text-green-600" },
    { key: "Marriage", label: "Marriage", color: "text-pink-600" },
  ];

  return (
    <div style={{ fontFamily: "'Work Sans', sans-serif" }}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>Leave Management</h1>
          <p className="text-slate-500 text-sm">Apply and track your leaves</p>
        </div>
        <button onClick={() => setShowApply(true)} data-testid="apply-leave-btn"
          className="flex items-center gap-2 px-4 py-2 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold hover:bg-[#D04A15] transition-colors">
          <Plus size={16} /> Apply Leave
        </button>
      </div>

      {/* Leave Balance */}
      {balance && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          {BALANCE_DISPLAY.map(({ key, label, color }) => (
            <div key={key} className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm" data-testid={`balance-${key}`}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500">{key}</span>
                <span className="text-xs text-slate-400">{label}</span>
              </div>
              <p className={`text-3xl font-bold ${color}`}>{balance[key]?.remaining ?? 0}</p>
              <div className="mt-2 bg-slate-100 rounded-full h-1.5">
                <div className="bg-[#E85B1E] h-1.5 rounded-full"
                  style={{ width: `${Math.min(100, ((balance[key]?.used || 0) / (balance[key]?.total || 1)) * 100)}%` }} />
              </div>
              <p className="text-xs text-slate-400 mt-1">{balance[key]?.used || 0} used / {balance[key]?.total || 0} total</p>
              {key === "Marriage" && (balance[key]?.remaining ?? 5) === 0 && (
                <p className="text-xs text-red-500 mt-1 font-medium">Already availed</p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      {isManager && (
        <div className="flex gap-2 mb-4 border-b border-slate-200">
          {[["my", "My Leaves"], ["pending", `Pending Approvals (${pending.length})`]].map(([val, label]) => (
            <button key={val} onClick={() => setActiveTab(val)} data-testid={`tab-${val}`}
              className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 ${activeTab === val ? "border-[#E85B1E] text-[#E85B1E]" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Leaves Table */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full" data-testid="leaves-table">
            <thead><tr className="bg-slate-50 border-b">
              {(activeTab === "pending"
                ? ["Employee ID", "Type", "From", "To", "Days", "Reason", "Actions"]
                : ["Type", "From", "To", "Days", "Status", "Applied On"]
              ).map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {loading
                ? <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">Loading...</td></tr>
                : activeTab === "pending"
                  ? pending.map(l => (
                    <tr key={l.id} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <p className="text-sm font-mono font-semibold text-[#E85B1E]">{l.employee_id}</p>
                        <ReportingManagerTag employeeId={l.employee_id} />
                      </td>
                      <td className="px-4 py-3">
                        <span className="px-2 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-medium">{l.leave_type}</span>
                        {l.medical_certificate && (
                          <span className="ml-1 px-1.5 py-0.5 bg-green-100 text-green-700 rounded text-xs">Cert</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-600">{l.start_date}</td>
                      <td className="px-4 py-3 text-sm text-slate-600">{l.end_date}</td>
                      <td className="px-4 py-3 text-sm font-medium text-slate-700">{l.days}d</td>
                      <td className="px-4 py-3 text-sm text-slate-500 max-w-xs truncate">{l.reason}</td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2">
                          <button onClick={() => handleApproval(l.id, "approve")} data-testid={`approve-leave-${l.id}`}
                            className="p-1.5 rounded-lg bg-green-100 text-green-700 hover:bg-green-200"><Check size={14} /></button>
                          <button onClick={() => handleApproval(l.id, "reject")} data-testid={`reject-leave-${l.id}`}
                            className="p-1.5 rounded-lg bg-red-100 text-red-700 hover:bg-red-200"><X size={14} /></button>
                        </div>
                      </td>
                    </tr>
                  ))
                  : leaves.map(l => (
                    <tr key={l.id} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <span className="px-2 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-medium">{l.leave_type}</span>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-600">{l.start_date}</td>
                      <td className="px-4 py-3 text-sm text-slate-600">{l.end_date}</td>
                      <td className="px-4 py-3 text-sm font-medium">{l.days}d</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-1 rounded-full text-xs font-medium capitalize ${STATUS_COLORS[l.status]}`}>{l.status}</span>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-400">
                        {l.applied_at ? new Date(l.applied_at).toLocaleDateString("en-IN") : "-"}
                      </td>
                    </tr>
                  ))
              }
            </tbody>
          </table>
        </div>
      </div>

      {/* Apply Leave Modal */}
      {showApply && (
        <Modal title="Apply for Leave" onClose={() => { setShowApply(false); setError(""); }}>
          <form onSubmit={handleApply} className="space-y-4">
            {isManager && (
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Employee ID*</label>
                <input value={form.employee_id} onChange={e => setForm({ ...form, employee_id: e.target.value })}
                  placeholder="e.g. RMF0001" required
                  className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Leave Type*</label>
              <select value={form.leave_type} onChange={e => setForm({ ...form, leave_type: e.target.value, medical_certificate: "" })}
                data-testid="leave-type-select"
                className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none bg-white">
                {LEAVE_TYPES.map(t => <option key={t} value={t}>{LEAVE_LABELS[t] || t}</option>)}
              </select>
              {hint && (
                <div className="mt-1.5 flex items-start gap-1.5 text-xs text-slate-500 bg-slate-50 rounded-lg px-3 py-2">
                  <Info size={12} className="mt-0.5 flex-shrink-0 text-[#E85B1E]" />
                  <span>{hint}</span>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">From Date*</label>
                <input type="date" value={form.start_date} onChange={e => setForm({ ...form, start_date: e.target.value })}
                  required data-testid="leave-start-date"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">To Date*</label>
                <input type="date" value={form.end_date}
                  onChange={e => setForm({ ...form, end_date: e.target.value })}
                  required min={form.start_date} data-testid="leave-end-date"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
              </div>
            </div>

            {days > 0 && (
              <p className="text-sm text-[#E85B1E] font-medium">{days} day{days > 1 ? "s" : ""}</p>
            )}

            {/* Medical certificate warning for SL > 2 days */}
            {showMedCert && (
              <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5 text-xs text-amber-700">
                <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                <span>
                  <strong>Medical certificate required</strong> for SL exceeding 2 consecutive days.
                  Please enter the certificate reference/details below.
                </span>
              </div>
            )}

            {showMedCert && (
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Medical Certificate Reference*</label>
                <input
                  value={form.medical_certificate}
                  onChange={e => setForm({ ...form, medical_certificate: e.target.value })}
                  placeholder="Doctor name, hospital, certificate date..."
                  required
                  data-testid="medical-certificate-input"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Reason*</label>
              <textarea value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })}
                required rows={3} data-testid="leave-reason"
                className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none resize-none" />
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm p-3 rounded-lg flex items-start gap-2">
                <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                {error}
              </div>
            )}

            <div className="flex gap-3">
              <button type="button" onClick={() => { setShowApply(false); setError(""); }}
                className="flex-1 px-4 py-2.5 border-2 border-slate-300 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50">
                Cancel
              </button>
              <button type="submit" disabled={saving} data-testid="submit-leave-btn"
                className="flex-1 px-4 py-2.5 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold disabled:opacity-60 transition-colors">
                {saving ? "Applying..." : "Apply Leave"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
