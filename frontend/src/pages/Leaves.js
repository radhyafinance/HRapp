import React, { useEffect, useState, useRef } from "react";
import API from "../utils/api";
import { useAuth } from "../contexts/AuthContext";
import { Plus, Check, X, UserCheck, Info, AlertTriangle, Upload, FileText, Eye } from "lucide-react";

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
const POLICY_HINTS = {
  CL: "Max 2 days at a time. SL and CL cannot be clubbed together.",
  SL: "Up to 2 days without documentation. From the 3rd day, a medical certificate is required (can be uploaded after the leave). If not provided, EL will be deducted or salary will be cut.",
  EL: "Accrues after 6 months of service at 1 day/month. Encashable after 3 years (min 30 EL).",
  Marriage: "5 days, availed only once during employment. For own marriage only.",
  Paternity: "Apply at least 15 days in advance. Can be availed up to 2 times during employment.",
  Maternity: "Apply at least 30 days in advance. Can be availed up to 2 times. No EL during maternity period.",
  "Comp-Off": "Compensatory off for working on holidays/weekends.",
  LWP: "Leave Without Pay — approved by management.",
};
const APPROVAL_TYPE_LABELS = {
  sl: "Approved (SL)", el: "Converted to EL", salary_deduction: "Salary Deduction"
};

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

// Reusable file-to-base64 hook
function useFileUpload() {
  const inputRef = useRef(null);
  const [file, setFile] = useState(null); // { data_base64, mime_type, file_name }

  const pick = () => inputRef.current?.click();

  const handleChange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const b64 = ev.target.result.split(",")[1];
      setFile({ data_base64: b64, mime_type: f.type, file_name: f.name });
    };
    reader.readAsDataURL(f);
  };

  const Input = () => (
    <input
      ref={inputRef}
      type="file"
      accept="image/jpeg,image/png,image/jpg,application/pdf"
      className="hidden"
      onChange={handleChange}
    />
  );

  return { file, setFile, pick, Input };
}

export default function Leaves() {
  const { user } = useAuth();
  const [leaves, setLeaves] = useState([]);
  const [balance, setBalance] = useState(null);
  const [pending, setPending] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("my");

  // Apply modal
  const [showApply, setShowApply] = useState(false);
  const [form, setForm] = useState({ leave_type: "CL", start_date: "", end_date: "", reason: "", employee_id: "" });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  // Certificate upload modal
  const [certLeave, setCertLeave] = useState(null); // leave object
  const [certUploading, setCertUploading] = useState(false);
  const [certError, setCertError] = useState("");
  const certFile = useFileUpload();

  const [allBalances, setAllBalances] = useState([]);
  const [balSearch, setBalSearch] = useState("");
  const [selectedEmp, setSelectedEmp] = useState(null); // { employee_id, name } for drill-down
  const [empLeaves, setEmpLeaves] = useState([]);
  const [empLeavesLoading, setEmpLeavesLoading] = useState(false);
  const [approvalLeave, setApprovalLeave] = useState(null);
  const [approvalType, setApprovalType] = useState("el");
  const [approvalRemarks, setApprovalRemarks] = useState("");
  const [approvalSaving, setApprovalSaving] = useState(false);
  const [approvalError, setApprovalError] = useState("");

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
        const [pendRes, allBalRes] = await Promise.all([
          API.get("/leaves/pending"),
          API.get("/leaves/balances/all"),
        ]);
        setPending(pendRes.data);
        setAllBalances(allBalRes.data);
      }
    } catch (e) {
      console.error("fetchData failed:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Apply leave
  const handleApply = async (e) => {
    e.preventDefault();
    setSaving(true);
    setFormError("");
    try {
      await API.post("/leaves", { ...form, employee_id: form.employee_id || user.employee_id });
      setShowApply(false);
      setForm({ leave_type: "CL", start_date: "", end_date: "", reason: "", employee_id: "" });
      fetchData();
    } catch (e) {
      setFormError(e.response?.data?.detail || "Failed to apply leave");
    } finally {
      setSaving(false);
    }
  };

  // Upload certificate
  const handleCertUpload = async () => {
    if (!certFile.file) { setCertError("Please select a file."); return; }
    setCertUploading(true);
    setCertError("");
    try {
      await API.post(`/leaves/${certLeave.id}/certificate`, certFile.file);
      setCertLeave(null);
      certFile.setFile(null);
      fetchData();
    } catch (e) {
      setCertError(e.response?.data?.detail || "Upload failed");
    } finally {
      setCertUploading(false);
    }
  };

  const openEmpLeaves = async (emp) => {
    setSelectedEmp(emp);
    setEmpLeavesLoading(true);
    try {
      const res = await API.get(`/leaves?employee_id=${emp.employee_id}`);
      setEmpLeaves(res.data);
    } catch (e) {
      console.error(e);
    } finally {
      setEmpLeavesLoading(false);
    }
  };

  // Simple approve/reject (for non-SL-cert cases)
  const handleSimpleApproval = async (leaveId, action) => {
    try {
      await API.put(`/leaves/${leaveId}/approve`, { action, remarks: "" });
      fetchData();
    } catch (e) {
      alert(e.response?.data?.detail || "Action failed");
    }
  };

  // Admin opens approval modal for SL > 2 days without cert
  const handleAdminApprove = (leave) => {
    const needsChoice = leave.leave_type === "SL" && leave.days > 2 && !leave.medical_certificate;
    if (needsChoice) {
      setApprovalLeave(leave);
      setApprovalType("el");
      setApprovalRemarks("");
      setApprovalError("");
    } else {
      handleSimpleApproval(leave.id, "approve");
    }
  };

  const handleApprovalSubmit = async () => {
    setApprovalSaving(true);
    setApprovalError("");
    try {
      await API.put(`/leaves/${approvalLeave.id}/approve`, {
        action: "approve",
        approval_type: approvalType,
        remarks: approvalRemarks,
      });
      setApprovalLeave(null);
      fetchData();
    } catch (e) {
      setApprovalError(e.response?.data?.detail || "Approval failed");
    } finally {
      setApprovalSaving(false);
    }
  };

  const days = form.start_date && form.end_date
    ? Math.max(1, Math.round((new Date(form.end_date) - new Date(form.start_date)) / 86400000) + 1)
    : 0;
  const hint = POLICY_HINTS[form.leave_type];

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
                  style={{ width: `${Math.min(100, ((balance[key]?.used || 0) / Math.max(balance[key]?.total || 1, 1)) * 100)}%` }} />
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
          {[["my", "My Leaves"], ["pending", `Pending Approvals (${pending.length})`], ["all", "All Employees"]].map(([val, label]) => (
            <button key={val} onClick={() => setActiveTab(val)} data-testid={`tab-${val}`}
              className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 ${activeTab === val ? "border-[#E85B1E] text-[#E85B1E]" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
              {label}
            </button>
          ))}
        </div>
      )}

      {/* All Employees Balances Tab */}
      {activeTab === "all" && !selectedEmp && (
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="p-4 border-b border-slate-100 flex items-center gap-3">
            <input
              value={balSearch} onChange={e => setBalSearch(e.target.value)}
              placeholder="Search by name or employee ID..."
              className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none"
              data-testid="bal-search"
            />
            <span className="text-xs text-slate-400">{allBalances.length} employees</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full" data-testid="all-balances-table">
              <thead><tr className="bg-slate-50 border-b">
                {["Employee", "Department", "CL", "SL", "EL", "Marriage", ""].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {loading
                  ? <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">Loading...</td></tr>
                  : allBalances
                      .filter(e => !balSearch || e.employee_id.toLowerCase().includes(balSearch.toLowerCase()) || e.name.toLowerCase().includes(balSearch.toLowerCase()))
                      .map(e => (
                    <tr key={e.employee_id} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <p className="text-sm font-semibold text-[#E85B1E] font-mono">{e.employee_id}</p>
                        <p className="text-xs text-slate-500">{e.name}</p>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-500">{e.department}</td>
                      {["CL","SL","EL","Marriage"].map(k => (
                        <td key={k} className="px-4 py-3">
                          <span className="text-sm font-bold text-slate-700">{e[k]?.remaining ?? 0}</span>
                          <span className="text-xs text-slate-400"> / {e[k]?.total ?? 0}</span>
                        </td>
                      ))}
                      <td className="px-4 py-3">
                        <button onClick={() => openEmpLeaves(e)}
                          data-testid={`view-leaves-${e.employee_id}`}
                          className="px-3 py-1 bg-slate-100 text-slate-600 rounded-lg text-xs font-medium hover:bg-slate-200">
                          View Leaves
                        </button>
                      </td>
                    </tr>
                  ))
                }
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Drill-down: individual employee leave history */}
      {activeTab === "all" && selectedEmp && (
        <div className="space-y-4">
          <button onClick={() => setSelectedEmp(null)}
            className="flex items-center gap-2 text-sm text-[#E85B1E] font-medium hover:underline">
            ← Back to All Employees
          </button>
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100">
              <p className="font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>{selectedEmp.name}</p>
              <p className="text-xs text-slate-400 font-mono">{selectedEmp.employee_id} · {selectedEmp.department}</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead><tr className="bg-slate-50 border-b">
                  {["Type","From","To","Days","Status","Certificate","Applied"].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {empLeavesLoading
                    ? <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">Loading...</td></tr>
                    : empLeaves.length === 0
                      ? <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">No leave applications found.</td></tr>
                      : empLeaves.map(l => (
                        <tr key={l.id} className="border-b border-slate-100 hover:bg-slate-50">
                          <td className="px-4 py-3"><span className="px-2 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-medium">{l.leave_type}</span></td>
                          <td className="px-4 py-3 text-sm text-slate-600">{l.start_date}</td>
                          <td className="px-4 py-3 text-sm text-slate-600">{l.end_date}</td>
                          <td className="px-4 py-3 text-sm font-medium">{l.days}d</td>
                          <td className="px-4 py-3"><span className={`px-2 py-1 rounded-full text-xs font-medium capitalize ${STATUS_COLORS[l.status]}`}>{l.status}</span></td>
                          <td className="px-4 py-3">{l.medical_certificate ? <span className="px-2 py-1 bg-green-100 text-green-700 rounded-full text-xs">Uploaded</span> : <span className="text-xs text-slate-400">—</span>}</td>
                          <td className="px-4 py-3 text-xs text-slate-400">{l.applied_at ? new Date(l.applied_at).toLocaleDateString("en-IN") : "—"}</td>
                        </tr>
                      ))
                  }
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Leaves Table (My + Pending tabs) */}
      {activeTab !== "all" && (
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full" data-testid="leaves-table">
            <thead><tr className="bg-slate-50 border-b">
              {activeTab === "pending"
                ? ["Employee", "Type", "From – To", "Days", "Certificate", "Actions"].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>
                ))
                : ["Type", "From", "To", "Days", "Status", "Certificate", "Applied"].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>
                ))
              }
            </tr></thead>
            <tbody>
              {loading
                ? <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">Loading...</td></tr>
                : activeTab === "pending"
                  ? pending.map(l => {
                    const needsCert = l.leave_type === "SL" && l.days > 2;
                    const hasCert = !!l.medical_certificate;
                    return (
                      <tr key={l.id} className="border-b border-slate-100 hover:bg-slate-50">
                        <td className="px-4 py-3">
                          <p className="text-sm font-mono font-semibold text-[#E85B1E]">{l.employee_id}</p>
                        </td>
                        <td className="px-4 py-3">
                          <span className="px-2 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-medium">{l.leave_type}</span>
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-600">{l.start_date} → {l.end_date}</td>
                        <td className="px-4 py-3 text-sm font-medium text-slate-700">{l.days}d</td>
                        <td className="px-4 py-3">
                          {needsCert ? (
                            hasCert ? (
                              <span className="px-2 py-1 bg-green-100 text-green-700 rounded-full text-xs font-medium flex items-center gap-1 w-fit">
                                <FileText size={11} /> Uploaded
                              </span>
                            ) : (
                              <span className="px-2 py-1 bg-red-100 text-red-600 rounded-full text-xs font-medium flex items-center gap-1 w-fit">
                                <AlertTriangle size={11} /> Missing
                              </span>
                            )
                          ) : (
                            <span className="text-xs text-slate-400">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex gap-2">
                            <button onClick={() => handleAdminApprove(l)} data-testid={`approve-leave-${l.id}`}
                              className="p-1.5 rounded-lg bg-green-100 text-green-700 hover:bg-green-200" title="Approve"><Check size={14} /></button>
                            <button onClick={() => handleSimpleApproval(l.id, "reject")} data-testid={`reject-leave-${l.id}`}
                              className="p-1.5 rounded-lg bg-red-100 text-red-700 hover:bg-red-200" title="Reject"><X size={14} /></button>
                            {hasCert && (
                              <a href={`data:${l.certificate_mime_type};base64,${l.medical_certificate}`}
                                download={l.certificate_file_name || "certificate"}
                                className="p-1.5 rounded-lg bg-slate-100 text-slate-600 hover:bg-slate-200" title="View Certificate">
                                <Eye size={14} />
                              </a>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                  : leaves.map(l => {
                    const needsCert = l.leave_type === "SL" && l.days > 2;
                    const hasCert = !!l.medical_certificate;
                    return (
                      <tr key={l.id} className="border-b border-slate-100 hover:bg-slate-50">
                        <td className="px-4 py-3">
                          <span className="px-2 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-medium">{l.leave_type}</span>
                          {l.approval_type && l.approval_type !== "sl" && (
                            <span className={`ml-1 px-1.5 py-0.5 rounded text-xs ${l.approval_type === "el" ? "bg-yellow-100 text-yellow-700" : "bg-red-100 text-red-700"}`}>
                              {APPROVAL_TYPE_LABELS[l.approval_type]}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-600">{l.start_date}</td>
                        <td className="px-4 py-3 text-sm text-slate-600">{l.end_date}</td>
                        <td className="px-4 py-3 text-sm font-medium">{l.days}d</td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-1 rounded-full text-xs font-medium capitalize ${STATUS_COLORS[l.status]}`}>{l.status}</span>
                        </td>
                        <td className="px-4 py-3">
                          {needsCert ? (
                            hasCert ? (
                              <span className="px-2 py-1 bg-green-100 text-green-700 rounded-full text-xs font-medium flex items-center gap-1 w-fit">
                                <FileText size={11} /> Uploaded
                              </span>
                            ) : (
                              <button onClick={() => { setCertLeave(l); setCertError(""); certFile.setFile(null); }}
                                data-testid={`upload-cert-${l.id}`}
                                className="flex items-center gap-1 px-2 py-1 bg-amber-100 text-amber-700 rounded-full text-xs font-medium hover:bg-amber-200">
                                <Upload size={11} /> Upload
                              </button>
                            )
                          ) : (
                            <span className="text-xs text-slate-400">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-400">
                          {l.applied_at ? new Date(l.applied_at).toLocaleDateString("en-IN") : "-"}
                        </td>
                      </tr>
                    );
                  })
              }
            </tbody>
          </table>
        </div>
      </div>
      )}

      {/* Apply Leave Modal */}
      {showApply && (
        <Modal title="Apply for Leave" onClose={() => { setShowApply(false); setFormError(""); }}>
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
              <select value={form.leave_type} onChange={e => setForm({ ...form, leave_type: e.target.value })}
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
                <input type="date" value={form.end_date} onChange={e => setForm({ ...form, end_date: e.target.value })}
                  required min={form.start_date} data-testid="leave-end-date"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
              </div>
            </div>
            {days > 0 && (
              <p className="text-sm text-[#E85B1E] font-medium">{days} day{days > 1 ? "s" : ""}</p>
            )}
            {form.leave_type === "SL" && days > 2 && (
              <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5 text-xs text-amber-700">
                <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                <span><strong>Medical certificate required</strong> for SL exceeding 2 days. You can upload it now or after the leave from your Leave History. If not uploaded, leave will be converted to EL or salary will be deducted.</span>
              </div>
            )}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Reason*</label>
              <textarea value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })}
                required rows={3} data-testid="leave-reason"
                className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none resize-none" />
            </div>
            {formError && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm p-3 rounded-lg flex items-start gap-2">
                <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                {formError}
              </div>
            )}
            <div className="flex gap-3">
              <button type="button" onClick={() => { setShowApply(false); setFormError(""); }}
                className="flex-1 px-4 py-2.5 border-2 border-slate-300 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50">Cancel</button>
              <button type="submit" disabled={saving} data-testid="submit-leave-btn"
                className="flex-1 px-4 py-2.5 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold disabled:opacity-60 transition-colors">
                {saving ? "Applying..." : "Apply Leave"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Certificate Upload Modal */}
      {certLeave && (
        <Modal title="Upload Medical Certificate" onClose={() => { setCertLeave(null); certFile.setFile(null); setCertError(""); }}>
          <certFile.Input />
          <div className="space-y-4">
            <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2.5 text-xs text-blue-700">
              <Info size={12} className="inline mr-1" />
              Upload the medical certificate for your SL application
              ({certLeave.start_date} → {certLeave.end_date}, {certLeave.days} days).
              Accepted formats: JPEG, PNG, PDF (max 5 MB).
            </div>
            <div
              onClick={certFile.pick}
              className="border-2 border-dashed border-slate-300 rounded-xl p-8 text-center cursor-pointer hover:border-[#E85B1E] hover:bg-orange-50 transition-colors"
              data-testid="cert-upload-zone"
            >
              {certFile.file ? (
                <div>
                  <FileText size={32} className="mx-auto mb-2 text-green-600" />
                  <p className="text-sm font-medium text-slate-700">{certFile.file.file_name}</p>
                  <p className="text-xs text-slate-400 mt-1">Click to change</p>
                </div>
              ) : (
                <div>
                  <Upload size={32} className="mx-auto mb-2 text-slate-400" />
                  <p className="text-sm text-slate-600 font-medium">Click to select file</p>
                  <p className="text-xs text-slate-400 mt-1">JPEG, PNG, or PDF</p>
                </div>
              )}
            </div>
            {certError && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm p-3 rounded-lg">
                {certError}
              </div>
            )}
            <div className="flex gap-3">
              <button onClick={() => { setCertLeave(null); certFile.setFile(null); setCertError(""); }}
                className="flex-1 px-4 py-2.5 border-2 border-slate-300 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50">Cancel</button>
              <button onClick={handleCertUpload} disabled={certUploading || !certFile.file}
                data-testid="submit-cert-btn"
                className="flex-1 px-4 py-2.5 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold disabled:opacity-60 transition-colors">
                {certUploading ? "Uploading..." : "Upload Certificate"}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Admin: Approval Decision Modal for SL > 2 days without cert */}
      {approvalLeave && (
        <Modal title="Approve Leave — Certificate Missing" onClose={() => setApprovalLeave(null)}>
          <div className="space-y-4">
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-3 text-sm text-amber-700">
              <AlertTriangle size={14} className="inline mr-1.5" />
              <strong>{approvalLeave.employee_id}</strong> applied for {approvalLeave.days} days SL
              ({approvalLeave.start_date} → {approvalLeave.end_date}) but has <strong>not uploaded a medical certificate</strong>.
            </div>
            <div>
              <p className="text-xs font-bold text-slate-700 mb-2">How should this leave be treated?</p>
              {[
                { val: "el", label: "Deduct from Earned Leave (EL)", desc: "Convert this SL to EL and deduct from EL balance." },
                { val: "salary_deduction", label: "Salary Deduction", desc: "No balance deducted — payroll team will manually deduct from salary." },
              ].map(opt => (
                <label key={opt.val} className={`flex items-start gap-3 p-3 rounded-xl border-2 cursor-pointer mb-2 transition-colors ${approvalType === opt.val ? "border-[#E85B1E] bg-orange-50" : "border-slate-200 hover:border-slate-300"}`}>
                  <input type="radio" name="approvalType" value={opt.val}
                    checked={approvalType === opt.val} onChange={() => setApprovalType(opt.val)}
                    className="mt-0.5" />
                  <div>
                    <p className="text-sm font-semibold text-slate-700">{opt.label}</p>
                    <p className="text-xs text-slate-500">{opt.desc}</p>
                  </div>
                </label>
              ))}
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Remarks (optional)</label>
              <input value={approvalRemarks} onChange={e => setApprovalRemarks(e.target.value)}
                placeholder="Add notes for employee..."
                className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
            </div>
            {approvalError && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm p-3 rounded-lg">{approvalError}</div>
            )}
            <div className="flex gap-3">
              <button onClick={() => setApprovalLeave(null)}
                className="flex-1 px-4 py-2.5 border-2 border-slate-300 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50">Cancel</button>
              <button onClick={handleApprovalSubmit} disabled={approvalSaving}
                data-testid="confirm-approval-btn"
                className="flex-1 px-4 py-2.5 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold disabled:opacity-60 transition-colors">
                {approvalSaving ? "Processing..." : "Confirm Approval"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
