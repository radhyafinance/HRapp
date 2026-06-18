import React, { useEffect, useState, useRef } from "react";
import API from "../utils/api";
import { useAuth } from "../contexts/AuthContext";
import { Plus, Check, X, UserCheck, Info, AlertTriangle, Upload, FileText, Eye, Edit2, Download, History } from "lucide-react";

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
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/50">
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
  const isAdminOrMgmt = ["hr_admin", "management"].includes(user?.role);
  const [activeTab, setActiveTab] = useState(isAdminOrMgmt ? "pending" : "my");
  const [approvedLeaves, setApprovedLeaves] = useState([]);

  // Approved Leaves filter
  const [approvedSearch, setApprovedSearch] = useState("");
  const [approvedDateFrom, setApprovedDateFrom] = useState("");
  const [approvedDateTo, setApprovedDateTo] = useState("");
  const filteredApproved = approvedLeaves.filter(l => {
    const matchName = !approvedSearch || (l.employee_name || "").toLowerCase().includes(approvedSearch.toLowerCase()) || (l.employee_id || "").toLowerCase().includes(approvedSearch.toLowerCase());
    const matchFrom = !approvedDateFrom || l.end_date >= approvedDateFrom;
    const matchTo = !approvedDateTo || l.start_date <= approvedDateTo;
    return matchName && matchFrom && matchTo;
  });

  // Apply modal
  const [showApply, setShowApply] = useState(false);
  const [form, setForm] = useState({ leave_type: "CL", start_date: "", end_date: "", reason: "", employee_id: "", day_type: "full_day", start_half: false, end_half: false });
  const [saving, setSaving] = useState(false);

  // Edit approved leave modal (admin/management only)
  const [editLeave, setEditLeave] = useState(null);
  const [editLeaveForm, setEditLeaveForm] = useState({ leave_type: "", reason: "", remarks: "", approval_type: "" });
  const [editLeaveSaving, setEditLeaveSaving] = useState(false);
  const [editLeaveError, setEditLeaveError] = useState("");
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

  const [balForm, setBalForm] = useState({ CL_total: 0, CL_used: 0, SL_total: 0, SL_used: 0, EL_total: 0, EL_used: 0, Marriage_total: 0, Marriage_used: 0, reason: "" });
  const [balSaving, setBalSaving] = useState(false);
  const [balError, setBalError] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState(null);
  const [auditLog, setAuditLog] = useState(null); // null = closed, [] = open
  const [coDetail, setCoDetail] = useState(null); // { employee_id, name, grants[] | "loading" | "error" }
  const bulkFileRef = useRef(null);

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
      // Only hr_admin / management can see all leave balances
      if (isAdminOrMgmt) {
        const [allBalRes] = await Promise.all([
          API.get("/leaves/balances/all"),
        ]);
        setAllBalances(allBalRes.data);
        try {
          const apRes = await API.get("/leaves/approved");
          setApprovedLeaves(apRes.data);
        } catch (e) {
          console.error("approved fetch failed:", e);
        }
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
    // Client-side policy checks
    if (form.leave_type === "SL" && days > 3) {
      setFormError("Sick Leave (SL) cannot exceed 3 consecutive days. For longer illness, apply for EL or LWP.");
      setSaving(false);
      return;
    }
    if (form.leave_type === "CL" && days > 2) {
      setFormError("Casual Leave (CL) cannot exceed 2 consecutive days.");
      setSaving(false);
      return;
    }
    try {
      await API.post("/leaves", { ...form, employee_id: form.employee_id || user.employee_id });
      setShowApply(false);
      setForm({ leave_type: "CL", start_date: "", end_date: "", reason: "", employee_id: "", day_type: "full_day", start_half: false, end_half: false });
      fetchData();
    } catch (e) {
      setFormError(e.response?.data?.detail || "Failed to apply leave");
    } finally {
      setSaving(false);
    }
  };

  // Balance management
  const [editBalance, setEditBalance] = useState(null); // employee row being edited

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

  const openCompOffDetail = async (emp) => {
    setCoDetail({ employee_id: emp.employee_id, name: emp.name, grants: "loading" });
    try {
      const res = await API.get(`/comp-offs/balance/${emp.employee_id}`);
      setCoDetail({ employee_id: emp.employee_id, name: emp.name, grants: res.data });
    } catch (e) {
      setCoDetail({ employee_id: emp.employee_id, name: emp.name, grants: "error", err: e.response?.data?.detail || "Failed to load" });
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

  // Open edit modal for an approved leave
  const openEditLeave = (l) => {
    setEditLeave(l);
    setEditLeaveForm({
      leave_type: l.leave_type || "",
      reason: l.reason || "",
      remarks: l.remarks || "",
      approval_type: l.approval_type || "",
    });
    setEditLeaveError("");
  };

  const submitEditLeave = async () => {
    setEditLeaveSaving(true);
    setEditLeaveError("");
    try {
      const payload = {};
      if (editLeaveForm.leave_type !== editLeave.leave_type) payload.leave_type = editLeaveForm.leave_type;
      payload.reason = editLeaveForm.reason;
      payload.remarks = editLeaveForm.remarks;
      if (editLeaveForm.approval_type && editLeaveForm.approval_type !== editLeave.approval_type) payload.approval_type = editLeaveForm.approval_type;
      await API.put(`/leaves/${editLeave.id}/admin-edit`, payload);
      setEditLeave(null);
      fetchData();
    } catch (e) {
      setEditLeaveError(e.response?.data?.detail || "Failed to update leave");
    } finally {
      setEditLeaveSaving(false);
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

  // Open Edit Balance modal with current values pre-filled
  const openEditBalance = (emp) => {
    setEditBalance(emp);
    setBalForm({
      CL_total: emp.CL?.total ?? 7,   CL_used: emp.CL?.used ?? 0,
      SL_total: emp.SL?.total ?? 15,  SL_used: emp.SL?.used ?? 0,
      EL_total: emp.EL?.total ?? 0,   EL_used: emp.EL?.used ?? 0,
      Marriage_total: emp.Marriage?.total ?? 5, Marriage_used: emp.Marriage?.used ?? 0,
      CompOff_total: emp["Comp-Off"]?.total ?? 0, CompOff_used: emp["Comp-Off"]?.used ?? 0,
      reason: "",
    });
    setBalError("");
  };

  const submitBalance = async () => {
    if (!balForm.reason.trim()) { setBalError("Reason is required."); return; }
    for (const k of ["CL", "SL", "EL", "Marriage"]) {
      const total = Number(balForm[`${k}_total`]);
      const used = Number(balForm[`${k}_used`]);
      if (total < 0 || used < 0) { setBalError(`${k}: values cannot be negative.`); return; }
      if (used > total) { setBalError(`${k}: used (${used}) cannot exceed total (${total}).`); return; }
    }
    const coTotal = Number(balForm.CompOff_total);
    const coUsed = Number(balForm.CompOff_used);
    if (coTotal < 0 || coUsed < 0) { setBalError("Comp-Off: values cannot be negative."); return; }
    if (coUsed > coTotal) { setBalError(`Comp-Off: used (${coUsed}) cannot exceed total (${coTotal}).`); return; }
    setBalSaving(true);
    setBalError("");
    try {
      const payload = {};
      for (const k of ["CL", "SL", "EL", "Marriage"]) {
        payload[`${k}_total`] = Number(balForm[`${k}_total`]);
        payload[`${k}_used`] = Number(balForm[`${k}_used`]);
      }
      payload.CompOff_total = coTotal;
      payload.CompOff_used = coUsed;
      payload.reason = balForm.reason.trim();
      await API.put(`/leaves/admin/balance/${editBalance.employee_id}`, payload);
      setEditBalance(null);
      fetchData();
    } catch (e) {
      setBalError(e.response?.data?.detail || "Failed to update balance.");
    } finally {
      setBalSaving(false);
    }
  };


  const downloadTemplate = async () => {
    try {
      const res = await API.get("/leaves/admin/balances-template", { responseType: "blob" });
      const url = URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement("a");
      a.href = url;
      a.download = `Leave_Balances_FY.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert("Failed to download template");
    }
  };

  const handleBulkUpload = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setBulkBusy(true);
    setBulkResult(null);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await API.post("/leaves/admin/balances-upload", fd);
      setBulkResult({ success: true, ...res.data });
      fetchData();
    } catch (err) {
      setBulkResult({ success: false, message: err.response?.data?.detail || "Upload failed" });
    } finally {
      setBulkBusy(false);
      if (bulkFileRef.current) bulkFileRef.current.value = "";
    }
  };

  const openAuditLog = async () => {
    try {
      const res = await API.get("/leaves/admin/balance-audit?limit=200");
      setAuditLog(res.data);
    } catch (e) {
      alert("Failed to load audit log");
    }
  };

  const isSingleDay = form.start_date && form.end_date && form.start_date === form.end_date;
  const isMultiDay = form.start_date && form.end_date && form.start_date !== form.end_date;
  const days = form.start_date && form.end_date
    ? (() => {
        if (isSingleDay) return form.day_type !== "full_day" ? 0.5 : 1;
        let d = Math.max(1, Math.round((new Date(form.end_date) - new Date(form.start_date)) / 86400000) + 1);
        if (form.start_half) d -= 0.5;
        if (form.end_half) d -= 0.5;
        return Math.max(0.5, d);
      })()
    : 0;
  const hint = POLICY_HINTS[form.leave_type];

  const BALANCE_DISPLAY = [
    { key: "CL", label: "Casual", color: "text-blue-600" },
    { key: "SL", label: "Sick", color: "text-purple-600" },
    { key: "EL", label: "Earned", color: "text-green-600" },
    { key: "Comp-Off", label: "Comp-Off", color: "text-orange-600" },
  ];

  return (
    <div style={{ fontFamily: "'Work Sans', sans-serif" }}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>Leave Management</h1>
          <p className="text-slate-500 text-sm">{isAdminOrMgmt ? "Approve, track, and audit company-wide leaves" : "Apply and track your leaves"}</p>
        </div>
        {!isAdminOrMgmt && (
          <button onClick={() => setShowApply(true)} data-testid="apply-leave-btn"
            className="flex items-center gap-2 px-4 py-2 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold hover:bg-[#D04A15] transition-colors">
            <Plus size={16} /> Apply Leave
          </button>
        )}
      </div>

      {/* Leave Balance — hide for admin/management since they don't apply leaves */}
      {balance && !isAdminOrMgmt && (
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
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      {isManager && (
        <div className="flex gap-2 mb-4 border-b border-slate-200 flex-wrap">
          {(isAdminOrMgmt
            ? [["pending", `Pending Approvals (${pending.length})`], ["approved", `All Approved Leaves (${approvedLeaves.length})`], ["all", "All Employees"]]
            : [["my", "My Leaves"], ["pending", `Pending Approvals (${pending.length})`], ["team", "Team Leaves"]]
          ).map(([val, label]) => (
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
          <div className="p-4 border-b border-slate-100 flex flex-wrap items-center gap-3">
            <input
              value={balSearch} onChange={e => setBalSearch(e.target.value)}
              placeholder="Search by name or employee ID..."
              className="flex-1 min-w-[200px] border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none"
              data-testid="bal-search"
            />
            {(user?.role === "hr_admin" || user?.role === "management") && (
              <>
                <button onClick={downloadTemplate}
                  data-testid="download-template-btn"
                  className="flex items-center gap-1.5 px-3 py-2 border-2 border-[#1E2A47] text-[#1E2A47] rounded-lg text-xs font-semibold hover:bg-slate-50">
                  <Download size={13} /> Download Template
                </button>
                <input ref={bulkFileRef} type="file" accept=".xlsx" className="hidden" onChange={handleBulkUpload} />
                <button onClick={() => bulkFileRef.current?.click()} disabled={bulkBusy}
                  data-testid="bulk-upload-btn"
                  className="flex items-center gap-1.5 px-3 py-2 bg-[#E85B1E] text-white rounded-lg text-xs font-semibold hover:bg-[#D04A15] disabled:opacity-60">
                  <Upload size={13} /> {bulkBusy ? "Uploading..." : "Bulk Upload"}
                </button>
                <button onClick={openAuditLog}
                  data-testid="audit-log-btn"
                  className="flex items-center gap-1.5 px-3 py-2 border-2 border-slate-300 text-slate-600 rounded-lg text-xs font-semibold hover:bg-slate-50">
                  <History size={13} /> Audit Log
                </button>
              </>
            )}
            <span className="text-xs text-slate-400 ml-auto">{allBalances.length} employees</span>
          </div>
          {bulkResult && (() => {
            const hasErrors = bulkResult.errors?.length > 0;
            const allFailed = bulkResult.updated === 0 && hasErrors;
            const partial = bulkResult.updated > 0 && hasErrors;
            const bannerClass = allFailed
              ? "bg-red-50 border-red-200 text-red-700"
              : partial
              ? "bg-amber-50 border-amber-200 text-amber-800"
              : bulkResult.success
              ? "bg-green-50 border-green-200 text-green-700"
              : "bg-red-50 border-red-200 text-red-700";
            return (
              <div className={`px-4 py-3 text-sm border-b ${bannerClass}`} data-testid="bulk-result">
                {bulkResult.success ? (
                  <>
                    <div className="flex items-start justify-between gap-2">
                      <span>
                        <strong>{allFailed ? "Upload Failed" : partial ? "Partial Update" : "Done!"}</strong>{" "}
                        {bulkResult.updated} updated
                        {bulkResult.skipped_no_reason > 0 && `, ${bulkResult.skipped_no_reason} skipped (no reason)`}
                        {bulkResult.skipped_unknown > 0 && `, ${bulkResult.skipped_unknown} skipped (unknown ID)`}
                        .
                      </span>
                      <button onClick={() => setBulkResult(null)} className="text-xs underline shrink-0">Dismiss</button>
                    </div>
                    {hasErrors && (
                      <ul className="mt-2 list-disc pl-5 text-xs space-y-0.5">
                        {bulkResult.errors.map((err, i) => <li key={i}>{err}</li>)}
                      </ul>
                    )}
                  </>
                ) : (
                  <div className="flex items-center justify-between">
                    {bulkResult.message}
                    <button onClick={() => setBulkResult(null)} className="ml-2 text-xs underline">Dismiss</button>
                  </div>
                )}
              </div>
            );
          })()}
          <div className="overflow-x-auto">
            <table className="w-full" data-testid="all-balances-table">
              <thead><tr className="bg-slate-50 border-b">
                {["Employee", "Department", "CL", "SL", "EL", "Marriage", "Comp-Off", ""].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {loading
                  ? <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-400">Loading...</td></tr>
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
                      <td className="px-4 py-3" data-testid={`comp-off-balance-${e.employee_id}`}>
                        {(e["Comp-Off"]?.remaining ?? 0) > 0 ? (
                          <button onClick={() => openCompOffDetail(e)}
                            data-testid={`comp-off-breakdown-${e.employee_id}`}
                            className="text-sm font-bold text-violet-700 underline decoration-dotted hover:bg-violet-50 px-1 rounded"
                            title="Click to see breakdown">
                            {e["Comp-Off"].remaining}
                          </button>
                        ) : (
                          <span className="text-sm font-bold text-slate-400">0</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2">
                          <button onClick={() => openEmpLeaves(e)}
                            data-testid={`view-leaves-${e.employee_id}`}
                            className="px-3 py-1 bg-slate-100 text-slate-600 rounded-lg text-xs font-medium hover:bg-slate-200">
                            View
                          </button>
                          {(user?.role === "hr_admin" || user?.role === "management") && (
                            <button onClick={() => openEditBalance(e)}
                              data-testid={`edit-balance-${e.employee_id}`}
                              className="flex items-center gap-1 px-3 py-1 bg-[#E85B1E]/10 text-[#E85B1E] rounded-lg text-xs font-semibold hover:bg-[#E85B1E]/20">
                              <Edit2 size={11} /> Edit
                            </button>
                          )}
                        </div>
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
                          <td className="px-4 py-3 text-sm font-medium">{l.days}d{l.day_type && l.day_type !== "full_day" && <span className="ml-1 text-[10px] bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-full">{l.day_type === "first_half" ? "AM" : "PM"}</span>}</td>
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

      {/* Team Leaves tab — managers only: shows all team leave history (no balances) */}
      {activeTab === "team" && (
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100">
            <p className="text-sm font-semibold text-[#1E2A47]">Team Leave History</p>
            <p className="text-xs text-slate-400">{leaves.filter(l => l.employee_id !== user?.employee_id).length} leave records across your team</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead><tr className="bg-slate-50 border-b">
                {["Employee", "Type", "From", "To", "Days", "Status", "Applied"].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {loading
                  ? <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">Loading...</td></tr>
                  : leaves.filter(l => l.employee_id !== user?.employee_id).length === 0
                    ? <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">No team leave records found.</td></tr>
                    : leaves.filter(l => l.employee_id !== user?.employee_id).map(l => (
                      <tr key={l.id} className="border-b border-slate-100 hover:bg-slate-50">
                        <td className="px-4 py-3">
                          <p className="text-sm font-semibold text-[#0F172A]">{l.employee_name || l.employee_id}</p>
                          <p className="text-xs font-mono text-[#E85B1E]">{l.employee_id}</p>
                        </td>
                        <td className="px-4 py-3"><span className="px-2 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-medium">{l.leave_type}</span></td>
                        <td className="px-4 py-3 text-sm text-slate-600">{l.start_date || l.from_date}</td>
                        <td className="px-4 py-3 text-sm text-slate-600">{l.end_date || l.to_date}</td>
                        <td className="px-4 py-3 text-sm font-medium">{l.days}d{l.day_type && l.day_type !== "full_day" && <span className="ml-1 text-[10px] bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-full">{l.day_type === "first_half" ? "AM" : "PM"}</span>}</td>
                        <td className="px-4 py-3"><span className={`px-2 py-1 rounded-full text-xs font-medium capitalize ${STATUS_COLORS[l.status]}`}>{l.status}</span></td>
                        <td className="px-4 py-3 text-xs text-slate-400">{l.applied_at ? new Date(l.applied_at).toLocaleDateString("en-IN") : "—"}</td>
                      </tr>
                    ))
                }
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Leaves Table (My + Pending + Approved tabs) */}
      {activeTab !== "all" && activeTab !== "team" && (
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        {/* Approved Leaves filter bar */}
        {activeTab === "approved" && (
          <div className="px-4 py-3 border-b border-slate-100 flex flex-wrap gap-2 items-center">
            <input
              type="text"
              placeholder="Search by name or ID…"
              value={approvedSearch}
              onChange={e => setApprovedSearch(e.target.value)}
              data-testid="approved-search"
              className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm w-48 focus:ring-2 focus:ring-[#E85B1E] outline-none"
            />
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-slate-500 font-medium">From</label>
              <input
                type="date"
                value={approvedDateFrom}
                onChange={e => setApprovedDateFrom(e.target.value)}
                data-testid="approved-date-from"
                className="border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-slate-500 font-medium">To</label>
              <input
                type="date"
                value={approvedDateTo}
                onChange={e => setApprovedDateTo(e.target.value)}
                data-testid="approved-date-to"
                className="border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none"
              />
            </div>
            {(approvedSearch || approvedDateFrom || approvedDateTo) && (
              <button
                onClick={() => { setApprovedSearch(""); setApprovedDateFrom(""); setApprovedDateTo(""); }}
                data-testid="approved-clear-filter"
                className="text-xs text-slate-400 hover:text-red-500 underline"
              >
                Clear filters
              </button>
            )}
            <span className="ml-auto text-xs text-slate-400">{filteredApproved.length} of {approvedLeaves.length}</span>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full" data-testid="leaves-table">
            <thead><tr className="bg-slate-50 border-b">
              {activeTab === "pending"
                ? ["Employee", "Designation", "Branch", "Type", "From – To", "Days", "Certificate", "Actions"].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>
                ))
                : activeTab === "approved"
                ? ["Employee", "Designation", "Branch", "Type", "From – To", "Days", "Approved By", "Reason", ""].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>
                ))
                : ["Type", "From", "To", "Days", "Status", "Certificate", "Applied"].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>
                ))
              }
            </tr></thead>
            <tbody>
              {loading
                ? <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-400">Loading...</td></tr>
                : activeTab === "pending"
                  ? pending.length === 0
                    ? <tr><td colSpan={8} className="px-4 py-12 text-center text-slate-400">No pending leave requests.</td></tr>
                    : pending.map(l => {
                    const needsCert = l.leave_type === "SL" && l.days > 2;
                    const hasCert = !!l.medical_certificate;
                    return (
                      <tr key={l.id} className="border-b border-slate-100 hover:bg-slate-50">
                        <td className="px-4 py-3">
                          <p className="text-sm font-semibold text-[#0F172A]">{l.employee_name || l.employee_id}</p>
                          <p className="text-xs font-mono text-[#E85B1E]">{l.employee_id}</p>
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-600">{l.designation || <span className="text-slate-300">—</span>}</td>
                        <td className="px-4 py-3 text-sm text-slate-600">{l.branch || <span className="text-slate-300">—</span>}</td>
                        <td className="px-4 py-3">
                          <span className="px-2 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-medium">{l.leave_type}</span>
                          {l.remaining_balance !== null && l.remaining_balance !== undefined && (
                            <p className={`text-[11px] mt-1 font-medium ${l.remaining_balance < l.days ? "text-red-500" : "text-slate-500"}`}>
                              Balance: {l.remaining_balance}d left
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-600">{l.start_date} → {l.end_date}</td>
                        <td className="px-4 py-3 text-sm font-medium text-slate-700">{l.days}d{l.day_type && l.day_type !== "full_day" && <span className="ml-1 text-[10px] bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-full">{l.day_type === "first_half" ? "AM" : "PM"}</span>}</td>
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
                : activeTab === "approved"
                  ? filteredApproved.length === 0
                    ? <tr><td colSpan={8} className="px-4 py-12 text-center text-slate-400">No approved leaves found.</td></tr>
                    : filteredApproved.map(l => (
                    <tr key={l.id} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <p className="text-sm font-semibold text-[#0F172A]">{l.employee_name || l.employee_id}</p>
                        <p className="text-xs font-mono text-[#E85B1E]">{l.employee_id}</p>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-600">{l.designation || <span className="text-slate-300">—</span>}</td>
                      <td className="px-4 py-3 text-sm text-slate-600">{l.branch || <span className="text-slate-300">—</span>}</td>
                      <td className="px-4 py-3 min-w-[130px]">
                        <div className="flex flex-col gap-1">
                          <span className="px-2 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-medium w-fit">{l.leave_type}</span>
                          {l.approval_type && l.approval_type !== "sl" && (
                            <span className={`px-1.5 py-0.5 rounded text-xs w-fit ${l.approval_type === "el" ? "bg-yellow-100 text-yellow-700" : "bg-red-100 text-red-700"}`}>
                              {APPROVAL_TYPE_LABELS[l.approval_type]}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-600">{l.start_date} → {l.end_date}</td>
                      <td className="px-4 py-3 text-sm font-medium text-slate-700">{l.days}d</td>
                      <td className="px-4 py-3 text-xs font-mono text-slate-500">{l.approved_by || <span className="text-slate-300">—</span>}</td>
                      <td className="px-4 py-3 text-xs text-slate-500 max-w-xs truncate" title={l.reason}>{l.reason || <span className="text-slate-300">—</span>}</td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => openEditLeave(l)}
                          data-testid={`edit-approved-leave-${l.id}`}
                          className="flex items-center gap-1 px-2.5 py-1.5 bg-[#E85B1E]/10 text-[#E85B1E] rounded-lg text-xs font-semibold hover:bg-[#E85B1E]/20 transition-colors"
                          title="Edit Leave"
                        >
                          <Edit2 size={12} /> Edit
                        </button>
                      </td>
                    </tr>
                  ))
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
                        <td className="px-4 py-3 text-sm font-medium">{l.days}d{l.day_type && l.day_type !== "full_day" && <span className="ml-1 text-[10px] bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-full">{l.day_type === "first_half" ? "AM" : "PM"}</span>}</td>
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
                <input type="date" value={form.start_date}
                  onChange={e => setForm({ ...form, start_date: e.target.value, end_date: e.target.value, day_type: "full_day", start_half: false, end_half: false })}
                  required data-testid="leave-start-date"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">To Date*</label>
                <input type="date" value={form.end_date}
                  onChange={e => setForm({ ...form, end_date: e.target.value, day_type: "full_day", start_half: false, end_half: false })}
                  required min={form.start_date} data-testid="leave-end-date"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
              </div>
            </div>

            {/* Half-day selector */}
            {isSingleDay && (
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-2">Day Type</label>
                <div className="grid grid-cols-3 gap-2" data-testid="day-type-selector">
                  {[
                    { value: "full_day",    label: "Full Day" },
                    { value: "first_half",  label: "1st Half" },
                    { value: "second_half", label: "2nd Half" },
                  ].map(opt => (
                    <button key={opt.value} type="button"
                      onClick={() => setForm(f => ({ ...f, day_type: opt.value }))}
                      data-testid={`day-type-${opt.value}`}
                      className={`py-2 px-3 rounded-lg border text-sm font-medium transition-colors ${form.day_type === opt.value ? "bg-[#E85B1E] text-white border-[#E85B1E]" : "bg-white text-slate-600 border-slate-300 hover:border-[#E85B1E]"}`}>
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {isMultiDay && (
              <div className="space-y-2">
                <label className="block text-xs font-semibold text-slate-700">Half-Day Options</label>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input type="checkbox" checked={form.start_half}
                    onChange={e => setForm(f => ({ ...f, start_half: e.target.checked }))}
                    data-testid="start-half-checkbox"
                    className="w-4 h-4 accent-[#E85B1E]" />
                  <span className="text-sm text-slate-600">First day: <strong>2nd half only</strong> <span className="text-xs text-slate-400">(−0.5 day)</span></span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input type="checkbox" checked={form.end_half}
                    onChange={e => setForm(f => ({ ...f, end_half: e.target.checked }))}
                    data-testid="end-half-checkbox"
                    className="w-4 h-4 accent-[#E85B1E]" />
                  <span className="text-sm text-slate-600">Last day: <strong>1st half only</strong> <span className="text-xs text-slate-400">(−0.5 day)</span></span>
                </label>
              </div>
            )}
            {days > 0 && (
              <p className="text-sm text-[#E85B1E] font-medium">
                {days} day{days !== 1 ? "s" : ""}
                {(form.day_type !== "full_day" && isSingleDay) && <span className="ml-2 text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full">{form.day_type === "first_half" ? "Morning" : "Afternoon"}</span>}
              </p>
            )}
            {form.leave_type === "SL" && days > 3 && (
              <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5 text-xs text-red-700">
                <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                <span><strong>Not allowed:</strong> SL cannot exceed 3 consecutive days. Apply for EL or LWP for longer illness.</span>
              </div>
            )}
            {form.leave_type === "SL" && days > 2 && days <= 3 && (
              <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5 text-xs text-amber-700">
                <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                <span><strong>Medical certificate required</strong> for SL exceeding 2 days. You can upload it after the leave from your Leave History.</span>
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

      {/* Edit Balance Modal */}
      {editBalance && (
        <Modal title={`Edit Leave Balance — ${editBalance.employee_id}`} onClose={() => setEditBalance(null)}>
          <div className="space-y-4">
            <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-600">
              <strong>{editBalance.name}</strong> · {editBalance.department || "—"}
              <p className="mt-1 text-[11px] text-slate-500">Remaining is auto-calculated as Total − Used on save.</p>
            </div>
            {[
              { k: "CL", label: "Casual Leave" },
              { k: "SL", label: "Sick Leave" },
              { k: "EL", label: "Earned Leave" },
              { k: "Marriage", label: "Marriage Leave" },
            ].map(({ k, label }) => (
              <div key={k} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-2">
                <label className="text-xs font-semibold text-slate-700">{label}</label>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] uppercase tracking-wider text-slate-400">Total</span>
                  <input type="number" min="0" step="0.5"
                    value={balForm[`${k}_total`]}
                    onChange={e => setBalForm(f => ({ ...f, [`${k}_total`]: e.target.value }))}
                    data-testid={`bal-${k}-total`}
                    className="w-20 border border-slate-300 rounded-md px-2 py-1.5 text-sm text-center focus:ring-2 focus:ring-[#E85B1E] outline-none" />
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] uppercase tracking-wider text-slate-400">Used</span>
                  <input type="number" min="0" step="0.5"
                    value={balForm[`${k}_used`]}
                    onChange={e => setBalForm(f => ({ ...f, [`${k}_used`]: e.target.value }))}
                    data-testid={`bal-${k}-used`}
                    className="w-20 border border-slate-300 rounded-md px-2 py-1.5 text-sm text-center focus:ring-2 focus:ring-[#E85B1E] outline-none" />
                </div>
                <div className="w-16 text-right">
                  <span className="text-[10px] uppercase tracking-wider text-slate-400 block">Remain</span>
                  <span className="text-sm font-bold text-[#E85B1E]">
                    {Math.max(0, (Number(balForm[`${k}_total`]) || 0) - (Number(balForm[`${k}_used`]) || 0))}
                  </span>
                </div>
              </div>
            ))}
            {/* Comp-Off row */}
            <div className="border-t border-slate-100 pt-3">
              <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-2">
                <label className="text-xs font-semibold text-slate-700">
                  Comp-Off
                  <span className="block text-[10px] font-normal text-slate-400">Manual override</span>
                </label>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] uppercase tracking-wider text-slate-400">Total</span>
                  <input type="number" min="0" step="1"
                    value={balForm.CompOff_total}
                    onChange={e => setBalForm(f => ({ ...f, CompOff_total: e.target.value }))}
                    data-testid="bal-CompOff-total"
                    className="w-20 border border-slate-300 rounded-md px-2 py-1.5 text-sm text-center focus:ring-2 focus:ring-[#E85B1E] outline-none" />
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] uppercase tracking-wider text-slate-400">Used</span>
                  <input type="number" min="0" step="1"
                    value={balForm.CompOff_used}
                    onChange={e => setBalForm(f => ({ ...f, CompOff_used: e.target.value }))}
                    data-testid="bal-CompOff-used"
                    className="w-20 border border-slate-300 rounded-md px-2 py-1.5 text-sm text-center focus:ring-2 focus:ring-[#E85B1E] outline-none" />
                </div>
                <div className="w-16 text-right">
                  <span className="text-[10px] uppercase tracking-wider text-slate-400 block">Remain</span>
                  <span className="text-sm font-bold text-[#E85B1E]">
                    {Math.max(0, (Number(balForm.CompOff_total) || 0) - (Number(balForm.CompOff_used) || 0))}
                  </span>
                </div>
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Reason*</label>
              <textarea value={balForm.reason}
                onChange={e => setBalForm(f => ({ ...f, reason: e.target.value }))}
                required rows={2} data-testid="bal-reason"
                placeholder="e.g. Adjustment after maternity leave reconciliation"
                className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none resize-none" />
            </div>
            {balError && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm p-3 rounded-lg">{balError}</div>
            )}
            <div className="flex gap-3">
              <button onClick={() => setEditBalance(null)}
                className="flex-1 px-4 py-2.5 border-2 border-slate-300 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50">Cancel</button>
              <button onClick={submitBalance} disabled={balSaving}
                data-testid="submit-balance-btn"
                className="flex-1 px-4 py-2.5 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold disabled:opacity-60 transition-colors">
                {balSaving ? "Saving..." : "Save Balance"}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Audit Log Modal */}
      {auditLog !== null && (
        <Modal title="Leave Balance — Audit Log" onClose={() => setAuditLog(null)}>
          <div className="space-y-3">
            {auditLog.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-8">No balance edits recorded yet.</p>
            ) : (
              auditLog.map((a, i) => (
                <div key={i} className="border border-slate-200 rounded-lg p-3 text-xs" data-testid={`audit-entry-${i}`}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="font-semibold font-mono text-[#E85B1E]">{a.employee_id}</span>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                      a.source === "manual" ? "bg-blue-100 text-blue-700" :
                      a.source === "bulk_upload" ? "bg-purple-100 text-purple-700" :
                      "bg-green-100 text-green-700"
                    }`}>{a.source}</span>
                  </div>
                  <div className="grid grid-cols-4 gap-1.5 text-[11px] mb-1.5">
                    {["CL","SL","EL","Marriage"].map(k => {
                      const b = a.before?.[k];
                      const af = a.after?.[k];
                      const changed = b && af && (b.total !== af.total || b.used !== af.used);
                      return (
                        <div key={k} className={`rounded px-2 py-1 ${changed ? "bg-amber-50 border border-amber-200" : "bg-slate-50"}`}>
                          <p className="font-bold text-slate-500">{k}</p>
                          {b ? (
                            <p className="text-slate-500">{b.total}/{b.used} → <span className="font-semibold text-slate-700">{af?.total}/{af?.used}</span></p>
                          ) : (
                            <p className="text-slate-700 font-semibold">{af?.total}/{af?.used}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-slate-600"><strong>Reason:</strong> {a.reason}</p>
                  <p className="text-slate-400 mt-1">
                    by <span className="font-mono">{a.changed_by}</span> · {a.changed_at ? new Date(a.changed_at).toLocaleString("en-IN") : "—"}
                  </p>
                </div>
              ))
            )}
          </div>
        </Modal>
      )}

      {/* Comp-Off Breakdown Modal */}
      {coDetail && (
        <Modal title={`Comp-Off Breakdown — ${coDetail.name} (${coDetail.employee_id})`} onClose={() => setCoDetail(null)}>
          {coDetail.grants === "loading" ? (
            <p className="text-sm text-slate-400 text-center py-8">Loading…</p>
          ) : coDetail.grants === "error" ? (
            <p className="text-sm text-red-600 text-center py-8">{coDetail.err || "Failed to load"}</p>
          ) : coDetail.grants.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-8">No active comp-offs.</p>
          ) : (
            <div className="space-y-2" data-testid="comp-off-breakdown-list">
              {coDetail.grants.map((g) => {
                const expiry = g.expiry_date ? new Date(g.expiry_date) : null;
                const today = new Date(); today.setHours(0,0,0,0);
                const daysLeft = expiry ? Math.ceil((expiry - today) / 86400000) : null;
                const expiringSoon = daysLeft !== null && daysLeft <= 14;
                const sourceLabel = g.source === "regularisation" ? "Regularised" : "Punch-in";
                const sourceCls = g.source === "regularisation" ? "bg-amber-100 text-amber-700" : "bg-violet-100 text-violet-700";
                return (
                  <div key={g.id} className="border border-slate-200 rounded-lg p-3 text-xs" data-testid={`co-grant-${g.id}`}>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-sm font-bold text-[#1E2A47]">
                        Earned: {g.earn_date ? new Date(g.earn_date).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—"}
                      </span>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${sourceCls}`}>{sourceLabel}</span>
                    </div>
                    {g.earn_reason && <p className="text-slate-500 mb-1">{g.earn_reason}</p>}
                    <div className="flex items-center justify-between">
                      <span className="text-slate-600">
                        Expires: <strong className={expiringSoon ? "text-red-600" : "text-slate-700"}>
                          {expiry ? expiry.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—"}
                        </strong>
                      </span>
                      {daysLeft !== null && (
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${expiringSoon ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"}`}>
                          {daysLeft > 0 ? `${daysLeft} day${daysLeft === 1 ? "" : "s"} left` : "Expired"}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
              <p className="text-[11px] text-slate-400 pt-2 border-t border-slate-100">
                Comp-offs expire 90 days after the date earned. Showing approved & unused only.
              </p>
            </div>
          )}
        </Modal>
      )}

      {/* Edit Approved Leave Modal (Admin/Management only) */}
      {editLeave && (
        <Modal title={`Edit Leave — ${editLeave.employee_name || editLeave.employee_id}`} onClose={() => setEditLeave(null)}>
          <div className="space-y-4">
            <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-600">
              <strong>{editLeave.employee_id}</strong> · {editLeave.start_date} → {editLeave.end_date} · {editLeave.days}d
              <p className="mt-1 text-[11px] text-slate-500">Balance is auto-adjusted when leave type or approval type changes.</p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Leave Type</label>
              <select
                value={editLeaveForm.leave_type}
                onChange={e => setEditLeaveForm(f => ({ ...f, leave_type: e.target.value }))}
                data-testid="edit-leave-type"
                className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none bg-white"
              >
                {LEAVE_TYPES.map(t => <option key={t} value={t}>{LEAVE_LABELS[t] || t}</option>)}
              </select>
            </div>

            {/* Approval Type — shown when leave type is SL */}
            {editLeaveForm.leave_type === "SL" && (
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-2">How was/should this SL be treated?</label>
                {[
                  { val: "sl", label: "Approved as Sick Leave (normal SL deduction)" },
                  { val: "el", label: "Converted to Earned Leave (EL deduction)" },
                  { val: "salary_deduction", label: "Salary Deduction (no balance deducted)" },
                ].map(opt => (
                  <label key={opt.val} className={`flex items-center gap-2 p-2.5 rounded-lg border cursor-pointer mb-1.5 transition-colors ${editLeaveForm.approval_type === opt.val ? "border-[#E85B1E] bg-orange-50" : "border-slate-200 hover:border-slate-300"}`}>
                    <input
                      type="radio"
                      name="editApprovalType"
                      value={opt.val}
                      checked={editLeaveForm.approval_type === opt.val}
                      onChange={() => setEditLeaveForm(f => ({ ...f, approval_type: opt.val }))}
                      className="accent-[#E85B1E]"
                    />
                    <span className="text-sm text-slate-700">{opt.label}</span>
                  </label>
                ))}
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Reason</label>
              <textarea
                value={editLeaveForm.reason}
                onChange={e => setEditLeaveForm(f => ({ ...f, reason: e.target.value }))}
                rows={2}
                data-testid="edit-leave-reason"
                className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none resize-none"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Admin Remarks</label>
              <input
                value={editLeaveForm.remarks}
                onChange={e => setEditLeaveForm(f => ({ ...f, remarks: e.target.value }))}
                placeholder="Optional notes..."
                data-testid="edit-leave-remarks"
                className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none"
              />
            </div>

            {editLeaveError && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm p-3 rounded-lg flex items-start gap-2">
                <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                {editLeaveError}
              </div>
            )}

            <div className="flex gap-3">
              <button onClick={() => setEditLeave(null)}
                className="flex-1 px-4 py-2.5 border-2 border-slate-300 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50">
                Cancel
              </button>
              <button onClick={submitEditLeave} disabled={editLeaveSaving}
                data-testid="submit-edit-leave-btn"
                className="flex-1 px-4 py-2.5 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold disabled:opacity-60 transition-colors">
                {editLeaveSaving ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
