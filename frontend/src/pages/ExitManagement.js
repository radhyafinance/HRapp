import React, { useEffect, useState, useCallback, useRef } from "react";
import API from "../utils/api";
import { useAuth } from "../contexts/AuthContext";
import {
  X, Check, Clock, AlertCircle, FileText, Upload, Download,
  ChevronRight, ChevronDown, User, Calendar, Building2,
  CheckCircle2, XCircle, Hourglass, Shield, Laptop, Briefcase,
  DoorOpen, Plus, Eye, Edit2
} from "lucide-react";

// ── Helpers ──────────────────────────────────────────────────
const STATUS_META = {
  submitted:        { label: "Pending Approval", color: "bg-amber-100 text-amber-700 border-amber-200" },
  noc_in_progress:  { label: "NOC In Progress",  color: "bg-blue-100 text-blue-700 border-blue-200" },
  noc_complete:     { label: "NOC Complete",      color: "bg-teal-100 text-teal-700 border-teal-200" },
  completed:        { label: "Completed",         color: "bg-green-100 text-green-700 border-green-200" },
  rejected:         { label: "Rejected",          color: "bg-red-100 text-red-700 border-red-200" },
};

const TIMELINE_ICONS = {
  submitted:           <DoorOpen size={14} />,
  level_1_approved:    <CheckCircle2 size={14} className="text-green-500" />,
  level_2_approved:    <CheckCircle2 size={14} className="text-green-500" />,
  level_3_approved:    <CheckCircle2 size={14} className="text-green-500" />,
  level_1_rejected:    <XCircle size={14} className="text-red-500" />,
  level_2_rejected:    <XCircle size={14} className="text-red-500" />,
  fully_approved:      <Check size={14} className="text-green-600" />,
  lwd_updated:         <Calendar size={14} />,
  all_nocs_cleared:    <Shield size={14} className="text-teal-500" />,
  fnf_uploaded:        <FileText size={14} />,
  relieving_uploaded:  <FileText size={14} />,
  completed:           <CheckCircle2 size={14} className="text-green-600" />,
};

const NOC_SECTION_ICONS = {
  branch_manager: <User size={16} />,
  accounts:       <Briefcase size={16} />,
  it:             <Laptop size={16} />,
  audit:          <Shield size={16} />,
  admin:          <Building2 size={16} />,
};

function formatDate(d) {
  if (!d) return "—";
  try { return new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); }
  catch { return d; }
}

function StatusBadge({ status }) {
  const m = STATUS_META[status] || { label: status, color: "bg-slate-100 text-slate-600 border-slate-200" };
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${m.color}`}>
      {m.label}
    </span>
  );
}

// ── Modal shell ───────────────────────────────────────────────
function Modal({ title, onClose, children, wide }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/50">
      <div className={`bg-white rounded-t-2xl sm:rounded-xl shadow-2xl w-full ${wide ? "sm:max-w-3xl" : "sm:max-w-lg"} max-h-[92vh] flex flex-col`}>
        <div className="flex items-center justify-between px-5 py-4 border-b sticky top-0 bg-white rounded-t-2xl sm:rounded-t-xl z-10">
          <h3 className="text-base font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>{title}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500"><X size={18} /></button>
        </div>
        <div className="overflow-y-auto flex-1 p-5">{children}</div>
      </div>
    </div>
  );
}

// ── Resignation form ──────────────────────────────────────────
function ResignationModal({ onClose, onSubmit, currentUser }) {
  const [form, setForm] = useState({
    resignation_date: new Date().toISOString().split("T")[0],
    reason: "",
    employee_id_override: "",
  });
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const isAdmin = currentUser?.role === "hr_admin";

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const fd = new FormData();
      fd.append("reason", form.reason);
      fd.append("resignation_date", form.resignation_date);
      if (isAdmin && form.employee_id_override) fd.append("employee_id_override", form.employee_id_override);
      if (file) fd.append("file", file);
      await API.post("/exit", fd);
      onSubmit();
      onClose();
    } catch (e) { setError(e.response?.data?.detail || "Failed to submit"); }
    finally { setSaving(false); }
  };

  return (
    <Modal title="Submit Resignation" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {isAdmin && (
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Employee ID (leave blank for self)</label>
            <input value={form.employee_id_override} onChange={e => setForm({ ...form, employee_id_override: e.target.value })}
              placeholder="e.g. RMF0010 (HR submitting on behalf)"
              className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
          </div>
        )}
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">Date of Resignation*</label>
          <input type="date" required value={form.resignation_date} onChange={e => setForm({ ...form, resignation_date: e.target.value })}
            className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">Reason for Resignation*</label>
          <textarea required rows={4} value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })}
            placeholder="Please describe your reason for leaving..."
            className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none resize-none" />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">Resignation Letter (optional — PDF/Image)</label>
          <label className={`flex items-center gap-3 border-2 border-dashed rounded-lg px-4 py-3 cursor-pointer hover:border-[#E85B1E] transition-colors ${file ? "border-[#E85B1E] bg-orange-50" : "border-slate-300"}`}>
            <Upload size={18} className={file ? "text-[#E85B1E]" : "text-slate-400"} />
            <span className="text-sm text-slate-600">{file ? file.name : "Click to upload PDF or image"}</span>
            <input type="file" className="hidden" accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls"
              onChange={e => setFile(e.target.files?.[0] || null)} />
          </label>
        </div>
        <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
          Notice period will be auto-calculated based on your grade. Your resignation will go for approval to your reporting manager.
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-3 pt-1">
          <button type="button" onClick={onClose} className="flex-1 px-4 py-2.5 border border-slate-300 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50">Cancel</button>
          <button type="submit" disabled={saving} data-testid="submit-resignation-btn"
            className="flex-1 px-4 py-2.5 bg-red-600 text-white rounded-lg text-sm font-semibold hover:bg-red-700 disabled:opacity-60 transition-colors">
            {saving ? "Submitting..." : "Submit Resignation"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Approval modal (with optional LWD picker for admin) ───────
function ApprovalModal({ exit, onClose, onDone, currentUser }) {
  const [action, setAction] = useState("approve");
  const [remarks, setRemarks] = useState("");
  const [lwd, setLwd] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Is this the final admin approval?
  const pendingItem = exit?.approval_chain?.find(a => a.status === "pending");
  const isAdminLevel = pendingItem?.approver_id === "admin";
  const isHrOrMgmt = currentUser?.role === "hr_admin" || currentUser?.role === "management";
  // Show LWD picker when approving the final level (admin/override) and action=approve
  const showLwdPicker = action === "approve" && (isAdminLevel || (isHrOrMgmt && pendingItem));

  const handleSubmit = async () => {
    if (action === "approve" && isAdminLevel && !lwd) {
      setError("Please set the Last Working Day before giving final approval.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await API.put(`/exit/${exit.id}/approve`, { action, remarks, last_working_day: lwd || undefined });
      onDone();
      onClose();
    } catch (e) { setError(e.response?.data?.detail || "Action failed"); }
    finally { setSaving(false); }
  };

  return (
    <Modal title="Approval Decision" onClose={onClose}>
      <div className="space-y-4">
        <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
          <p className="font-semibold text-[#1E2A47] text-sm">{exit?.employee_name}</p>
          <p className="text-xs text-slate-500">{exit?.designation} · Resigned on {formatDate(exit?.resignation_date)}</p>
          {pendingItem && <p className="text-xs text-slate-500 mt-1">You are approving as: <span className="font-medium">{pendingItem.approver_name}</span> (Level {pendingItem.level})</p>}
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-2">Decision*</label>
          <div className="flex gap-3">
            {[["approve", "Approve", "bg-green-600 text-white border-green-600"], ["reject", "Reject", "bg-red-600 text-white border-red-600"]].map(([val, label, activeClass]) => (
              <button key={val} onClick={() => setAction(val)}
                className={`flex-1 py-2 rounded-lg border-2 text-sm font-semibold transition-colors ${action === val ? activeClass : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {showLwdPicker && (
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Last Working Day*</label>
            <input type="date" value={lwd} onChange={e => setLwd(e.target.value)} required
              className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
            <p className="text-xs text-slate-500 mt-1">This will initiate the NOC clearance process.</p>
          </div>
        )}
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">Remarks (optional)</label>
          <textarea rows={3} value={remarks} onChange={e => setRemarks(e.target.value)} placeholder="Add any notes or conditions..."
            className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none resize-none" />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 py-2.5 border border-slate-300 rounded-lg text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
          <button onClick={handleSubmit} disabled={saving}
            className={`flex-1 py-2.5 rounded-lg text-sm font-semibold text-white disabled:opacity-60 transition-colors ${action === "approve" ? "bg-green-600 hover:bg-green-700" : "bg-red-600 hover:bg-red-700"}`}>
            {saving ? "Saving..." : `Confirm ${action === "approve" ? "Approval" : "Rejection"}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── NOC section form ──────────────────────────────────────────
function NOCModal({ exit, section, sectionConfig, onClose, onDone }) {
  const sectionData = exit?.noc_clearances?.[section] || {};
  const [items, setItems] = useState(
    (sectionData.items || []).map(i => ({
      name: i.name,
      done: i.done === true ? true : i.done === false ? false : null,
      remarks: i.remarks || ""
    }))
  );
  const [overallRemarks, setOverallRemarks] = useState(sectionData.overall_remarks || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const allMarked = items.every(i => i.done !== null);

  const toggleItem = (idx, val) => setItems(prev => prev.map((it, i) => i === idx ? { ...it, done: val } : it));
  const setRemarks = (idx, val) => setItems(prev => prev.map((it, i) => i === idx ? { ...it, remarks: val } : it));

  const handleSubmit = async () => {
    if (!allMarked) { setError("Please mark all items as Done or Not Done."); return; }
    setSaving(true);
    setError("");
    try {
      await API.post(`/exit/${exit.id}/noc/${section}`, {
        items: items.map(i => ({ name: i.name, done: i.done, remarks: i.remarks })),
        overall_remarks: overallRemarks
      });
      onDone();
      onClose();
    } catch (e) { setError(e.response?.data?.detail || "Failed to submit"); }
    finally { setSaving(false); }
  };

  return (
    <Modal title={sectionConfig?.label || section} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="p-3 bg-slate-50 rounded-lg border border-slate-200 text-xs text-slate-600">
          Please mark each clearance item for <span className="font-semibold">{exit?.employee_name}</span>.
        </div>
        <div className="space-y-3">
          {items.map((item, idx) => (
            <div key={idx} className={`border rounded-lg p-3 transition-colors ${item.done === true ? "border-green-200 bg-green-50" : item.done === false ? "border-red-200 bg-red-50" : "border-slate-200"}`}>
              <p className="text-sm font-medium text-slate-800 mb-2">{item.name}</p>
              <div className="flex gap-2 mb-2">
                <button onClick={() => toggleItem(idx, true)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${item.done === true ? "bg-green-600 text-white border-green-600" : "border-slate-300 text-slate-600 hover:bg-green-50"}`}>
                  <Check size={12} /> Done
                </button>
                <button onClick={() => toggleItem(idx, false)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${item.done === false ? "bg-red-600 text-white border-red-600" : "border-slate-300 text-slate-600 hover:bg-red-50"}`}>
                  <X size={12} /> Not Done
                </button>
              </div>
              {item.done === false && (
                <input value={item.remarks} onChange={e => setRemarks(idx, e.target.value)}
                  placeholder="Remarks / reason (required)"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-xs focus:ring-1 focus:ring-red-300 outline-none" />
              )}
            </div>
          ))}
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">Overall Remarks (optional)</label>
          <textarea rows={2} value={overallRemarks} onChange={e => setOverallRemarks(e.target.value)}
            className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none resize-none" />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 py-2.5 border border-slate-300 rounded-lg text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
          <button onClick={handleSubmit} disabled={saving || !allMarked}
            className="flex-1 py-2.5 bg-[#1E2A47] text-white rounded-lg text-sm font-semibold hover:bg-[#16213a] disabled:opacity-60 transition-colors">
            {saving ? "Submitting..." : "Submit Clearance"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Final Documents upload modal ──────────────────────────────
function FinalDocsModal({ exit, onClose, onDone }) {
  const [fnfFile, setFnfFile] = useState(null);
  const [rlFile, setRlFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleUpload = async () => {
    if (!fnfFile && !rlFile) { setError("Please select at least one file to upload."); return; }
    setSaving(true);
    setError("");
    try {
      const fd = new FormData();
      if (fnfFile) fd.append("fnf_sheet", fnfFile);
      if (rlFile) fd.append("relieving_letter", rlFile);
      await API.post(`/exit/${exit.id}/final-docs`, fd);
      onDone();
      onClose();
    } catch (e) { setError(e.response?.data?.detail || "Upload failed"); }
    finally { setSaving(false); }
  };

  const alreadyHasFnf = exit?.final_documents?.fnf_sheet?.has_file;
  const alreadyHasRl = exit?.final_documents?.relieving_letter?.has_file;

  return (
    <Modal title="Upload Final Documents" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">Upload the Full & Final Settlement sheet and/or the Relieving Letter for <span className="font-semibold">{exit?.employee_name}</span>.</p>
        {[
          ["fnf_sheet", "F&F Settlement Sheet", fnfFile, setFnfFile, alreadyHasFnf, exit?.final_documents?.fnf_sheet?.file_name],
          ["relieving_letter", "Relieving Letter", rlFile, setRlFile, alreadyHasRl, exit?.final_documents?.relieving_letter?.file_name],
        ].map(([key, label, fileState, setFileState, alreadyUploaded, existingName]) => (
          <div key={key}>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              {label} {alreadyUploaded && <span className="text-green-600 font-normal">(already uploaded: {existingName})</span>}
            </label>
            <label className={`flex items-center gap-3 border-2 border-dashed rounded-lg px-4 py-3 cursor-pointer hover:border-[#E85B1E] transition-colors ${fileState ? "border-[#E85B1E] bg-orange-50" : alreadyUploaded ? "border-green-300 bg-green-50" : "border-slate-300"}`}>
              <Upload size={18} className={fileState ? "text-[#E85B1E]" : alreadyUploaded ? "text-green-500" : "text-slate-400"} />
              <span className="text-sm text-slate-600">{fileState ? fileState.name : alreadyUploaded ? `Replace: ${existingName}` : "Click to upload PDF/Excel"}</span>
              <input type="file" className="hidden" accept=".pdf,.xlsx,.xls,.doc,.docx"
                onChange={e => setFileState(e.target.files?.[0] || null)} />
            </label>
          </div>
        ))}
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 py-2.5 border border-slate-300 rounded-lg text-sm text-slate-600">Cancel</button>
          <button onClick={handleUpload} disabled={saving}
            className="flex-1 py-2.5 bg-[#1E2A47] text-white rounded-lg text-sm font-semibold hover:bg-[#16213a] disabled:opacity-60 transition-colors">
            {saving ? "Uploading..." : "Upload"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── LWD Edit modal ────────────────────────────────────────────
function EditLWDModal({ exit, onClose, onDone }) {
  const [lwd, setLwd] = useState(exit?.last_working_day || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    if (!lwd) { setError("Please select a date."); return; }
    setSaving(true);
    try {
      await API.put(`/exit/${exit.id}/lwd`, { last_working_day: lwd });
      onDone();
      onClose();
    } catch (e) { setError(e.response?.data?.detail || "Failed"); }
    finally { setSaving(false); }
  };

  return (
    <Modal title="Update Last Working Day" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">Update the Last Working Day for <span className="font-semibold">{exit?.employee_name}</span>.</p>
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">Last Working Day*</label>
          <input type="date" value={lwd} onChange={e => setLwd(e.target.value)}
            className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 py-2.5 border border-slate-300 rounded-lg text-sm text-slate-600">Cancel</button>
          <button onClick={handleSave} disabled={saving}
            className="flex-1 py-2.5 bg-[#1E2A47] text-white rounded-lg text-sm font-semibold disabled:opacity-60 transition-colors">
            {saving ? "Saving..." : "Update"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Detail panel (slide-up on mobile) ─────────────────────────
function DetailPanel({ exit, currentUser, onClose, onRefresh }) {
  const [activeTab, setActiveTab] = useState("overview");
  const [nocModal, setNocModal] = useState(null);
  const [showApprove, setShowApprove] = useState(false);
  const [showDocs, setShowDocs] = useState(false);
  const [showEditLwd, setShowEditLwd] = useState(false);
  const [nocSections, setNocSections] = useState({});
  const [ffsData, setFfsData] = useState(null);
  const [ffsLoading, setFfsLoading] = useState(false);

  const isAdmin = currentUser?.role === "hr_admin";
  const isManagement = currentUser?.role === "management";
  const isManager = currentUser?.role === "managers";
  const myEmpId = currentUser?.employee_id;

  // Which NOC sections can I fill?
  const myNocSections = Object.entries(exit?.noc_clearances || {}).filter(([key, sec]) => {
    if (sec.status === "cleared") return false;
    if (isAdmin) return true;
    return sec.assignee_id && sec.assignee_id === myEmpId;
  });

  // Can I approve?
  const pendingApproval = exit?.approval_chain?.find(a => a.status === "pending");
  const canApprove = exit?.status === "submitted" && pendingApproval && (
    isAdmin ||              // HR Admin can approve/override any level
    isManagement ||         // Management can approve/override any level
    (pendingApproval.approver_id === myEmpId)  // Direct approver
  );

  useEffect(() => {
    API.get("/exit/noc-sections").then(r => setNocSections(r.data)).catch(() => {});
  }, []);

  const loadFFS = async () => {
    if (ffsData) return;
    setFfsLoading(true);
    try { const r = await API.get(`/exit/${exit.id}/ffs`); setFfsData(r.data); }
    catch { } finally { setFfsLoading(false); }
  };

  useEffect(() => {
    if (activeTab === "documents") loadFFS();
  }, [activeTab]);

  const handleDownload = async (docType) => {
    try {
      const response = await API.get(`/exit/${exit.id}/download/${docType}`, { responseType: "blob" });
      const url = URL.createObjectURL(response.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = docType;
      a.click();
      URL.revokeObjectURL(url);
    } catch { alert("Download failed"); }
  };

  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "approvals", label: "Approvals" },
    { id: "noc", label: `NOC (${Object.values(exit?.noc_clearances || {}).filter(s => s.status === "cleared").length}/5)` },
    { id: "documents", label: "Documents" },
  ];

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-white">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-4 border-b bg-[#1E2A47]">
        <button onClick={onClose} className="p-2 rounded-lg hover:bg-white/10 text-white"><X size={20} /></button>
        <div className="flex-1 min-w-0">
          <p className="font-bold text-white text-sm truncate">{exit?.employee_name}</p>
          <p className="text-xs text-slate-300 truncate">{exit?.designation} · {exit?.department}</p>
        </div>
        <StatusBadge status={exit?.status} />
      </div>

      {/* Tabs */}
      <div className="flex border-b bg-white overflow-x-auto">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)}
            className={`flex-shrink-0 px-4 py-3 text-xs font-semibold border-b-2 transition-colors ${activeTab === t.id ? "border-[#E85B1E] text-[#E85B1E]" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* ── Overview Tab ── */}
        {activeTab === "overview" && (
          <>
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
              <div className="grid grid-cols-2 gap-3 text-sm">
                {[
                  ["Employee ID", exit?.employee_id],
                  ["Department", exit?.department],
                  ["Designation", exit?.designation],
                  ["Joined", formatDate(exit?.joining_date)],
                  ["Resigned On", formatDate(exit?.resignation_date)],
                  ["Last Working Day", exit?.last_working_day ? formatDate(exit.last_working_day) : "Pending"],
                  ["Notice Period", `${exit?.notice_period_days} days`],
                ].map(([label, value]) => (
                  <div key={label}>
                    <p className="text-xs text-slate-500">{label}</p>
                    <p className="font-semibold text-[#1E2A47] text-sm">{value || "—"}</p>
                  </div>
                ))}
              </div>
            </div>

            {exit?.reason && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                <p className="text-xs font-semibold text-amber-700 mb-1">Reason for Resignation</p>
                <p className="text-sm text-amber-900">{exit.reason}</p>
              </div>
            )}

            {/* Admin actions */}
            <div className="space-y-2">
              {canApprove && (
                <button onClick={() => setShowApprove(true)} data-testid={`approve-exit-${exit.id}`}
                  className="w-full py-3 bg-green-600 text-white rounded-xl text-sm font-semibold hover:bg-green-700 transition-colors flex items-center justify-center gap-2">
                  <Check size={16} /> Take Approval Decision
                </button>
              )}
              {isAdmin && exit?.status === "noc_in_progress" && (
                <button onClick={() => setShowEditLwd(true)}
                  className="w-full py-2.5 border border-slate-300 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-50 flex items-center justify-center gap-2">
                  <Edit2 size={14} /> Update Last Working Day
                </button>
              )}
            </div>

            {/* Timeline */}
            <div>
              <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Timeline</p>
              <div className="space-y-0">
                {(exit?.timeline || []).map((event, i) => (
                  <div key={i} className="flex gap-3 relative">
                    <div className="flex flex-col items-center">
                      <div className="w-7 h-7 rounded-full bg-slate-100 border border-slate-300 flex items-center justify-center text-slate-500 z-10 flex-shrink-0">
                        {TIMELINE_ICONS[event.event] || <Clock size={12} />}
                      </div>
                      {i < (exit?.timeline || []).length - 1 && <div className="w-px flex-1 bg-slate-200 my-1" />}
                    </div>
                    <div className="pb-4 flex-1 min-w-0">
                      <p className="text-sm text-slate-700">{event.description}</p>
                      <p className="text-xs text-slate-400 mt-0.5">{formatDate(event.timestamp)} · {event.actor}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* ── Approvals Tab ── */}
        {activeTab === "approvals" && (
          <div className="space-y-3">
            {(exit?.approval_chain || []).map((item, i) => (
              <div key={i} className={`border rounded-xl p-4 ${item.status === "approve" ? "border-green-200 bg-green-50" : item.status === "reject" ? "border-red-200 bg-red-50" : "border-slate-200 bg-white"}`}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-[#1E2A47]">Level {item.level}: {item.approver_name}</p>
                    <p className="text-xs text-slate-500">{item.approver_designation}</p>
                  </div>
                  <span className={`flex-shrink-0 flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${item.status === "approve" ? "bg-green-600 text-white" : item.status === "reject" ? "bg-red-600 text-white" : "bg-slate-200 text-slate-600"}`}>
                    {item.status === "approve" ? <Check size={10} /> : item.status === "reject" ? <X size={10} /> : <Hourglass size={10} />}
                    {item.status === "approve" ? "Approved" : item.status === "reject" ? "Rejected" : "Pending"}
                  </span>
                </div>
                {item.remarks && <p className="text-xs text-slate-600 mt-2 italic">"{item.remarks}"</p>}
                {item.timestamp && <p className="text-xs text-slate-400 mt-1">{formatDate(item.timestamp)}</p>}
              </div>
            ))}
            {canApprove && (
              <button onClick={() => setShowApprove(true)}
                className="w-full py-3 bg-green-600 text-white rounded-xl text-sm font-semibold hover:bg-green-700 transition-colors">
                Take Decision Now
              </button>
            )}
          </div>
        )}

        {/* ── NOC Tab ── */}
        {activeTab === "noc" && (
          <div className="space-y-3">
            {Object.entries(exit?.noc_clearances || {}).map(([sectionKey, sectionData]) => {
              const config = nocSections[sectionKey] || {};
              const isMySection = myNocSections.some(([k]) => k === sectionKey);
              const cleared = sectionData.status === "cleared";
              return (
                <div key={sectionKey} className={`border rounded-xl overflow-hidden ${cleared ? "border-green-200" : "border-slate-200"}`}>
                  <div className={`flex items-center justify-between px-4 py-3 ${cleared ? "bg-green-50" : "bg-slate-50"}`}>
                    <div className="flex items-center gap-2">
                      <span className={`${cleared ? "text-green-600" : "text-slate-500"}`}>{NOC_SECTION_ICONS[sectionKey]}</span>
                      <div>
                        <p className="text-sm font-semibold text-[#1E2A47]">{config.label || sectionKey}</p>
                        <p className="text-xs text-slate-500">{sectionData.assignee_name || "—"}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${cleared ? "bg-green-600 text-white" : "bg-slate-200 text-slate-600"}`}>
                        {cleared ? "Cleared" : "Pending"}
                      </span>
                      {!cleared && isMySection && exit?.status !== "submitted" && exit?.status !== "rejected" && (
                        <button onClick={() => setNocModal(sectionKey)}
                          className="text-xs px-3 py-1.5 bg-[#1E2A47] text-white rounded-lg font-medium hover:bg-[#16213a] transition-colors">
                          Fill
                        </button>
                      )}
                    </div>
                  </div>
                  {cleared && (
                    <div className="px-4 py-3 bg-white border-t border-green-100">
                      <div className="space-y-1.5">
                        {(sectionData.items || []).map((item, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs">
                            {item.done ? <Check size={12} className="text-green-600 flex-shrink-0" /> : <X size={12} className="text-red-500 flex-shrink-0" />}
                            <span className="text-slate-700">{item.name}</span>
                            {!item.done && item.remarks && <span className="text-slate-500 italic">— {item.remarks}</span>}
                          </div>
                        ))}
                      </div>
                      {sectionData.overall_remarks && (
                        <p className="text-xs text-slate-500 mt-2 italic">Note: {sectionData.overall_remarks}</p>
                      )}
                      <p className="text-xs text-slate-400 mt-1">
                        Cleared by {sectionData.submitted_by_name || "—"} · {formatDate(sectionData.submitted_at)}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── Documents Tab ── */}
        {activeTab === "documents" && (
          <div className="space-y-4">
            {/* Resignation Letter */}
            {exit?.resignation_letter?.has_file && (
              <div className="border border-slate-200 rounded-xl p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <FileText size={20} className="text-[#E85B1E]" />
                  <div>
                    <p className="text-sm font-semibold text-[#1E2A47]">Resignation Letter</p>
                    <p className="text-xs text-slate-500">{exit.resignation_letter.file_name}</p>
                  </div>
                </div>
                <button onClick={() => handleDownload("resignation_letter")}
                  className="p-2 rounded-lg hover:bg-slate-100 text-slate-600"><Download size={16} /></button>
              </div>
            )}

            {/* FFS Calculator */}
            {["noc_in_progress","noc_complete","completed"].includes(exit?.status) && (
              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-4 py-3 bg-slate-50 border-b border-slate-200">
                  <p className="text-sm font-semibold text-[#1E2A47]">F&F Settlement Estimate</p>
                </div>
                {ffsLoading ? (
                  <div className="p-4 text-center text-sm text-slate-400">Loading...</div>
                ) : ffsData ? (
                  <div className="p-4 space-y-2">
                    {[
                      [`EL Encashment (${ffsData.el_remaining_days} days)`, ffsData.el_encashment],
                      ["Gratuity", ffsData.gratuity_eligible ? ffsData.gratuity_amount : null],
                    ].map(([label, val]) => (
                      <div key={label} className="flex justify-between text-sm border-b border-slate-100 pb-1.5">
                        <span className="text-slate-600">{label}</span>
                        <span className="font-semibold text-[#1E2A47]">
                          {val !== null ? `₹${Number(val).toLocaleString("en-IN")}` : "Not eligible (< 5 yrs)"}
                        </span>
                      </div>
                    ))}
                    <div className="flex justify-between text-sm font-bold text-green-700 pt-1">
                      <span>Estimated Total</span>
                      <span>₹{ffsData.total_amount?.toLocaleString("en-IN")}</span>
                    </div>
                    <p className="text-xs text-slate-400">{ffsData.note}</p>
                  </div>
                ) : <div className="p-4 text-center"><button onClick={loadFFS} className="text-sm text-[#E85B1E]">Load estimate</button></div>}
              </div>
            )}

            {/* Final Documents (admin upload / employee download) */}
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                <p className="text-sm font-semibold text-[#1E2A47]">Final Documents</p>
                {isAdmin && exit?.status === "noc_complete" && (
                  <button onClick={() => setShowDocs(true)}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-[#E85B1E] text-white rounded-lg font-medium hover:bg-[#c74d18]">
                    <Upload size={12} /> Upload
                  </button>
                )}
                {isAdmin && exit?.status === "completed" && (
                  <button onClick={() => setShowDocs(true)}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 border border-slate-300 text-slate-600 rounded-lg font-medium hover:bg-slate-50">
                    <Upload size={12} /> Replace
                  </button>
                )}
              </div>
              <div className="p-4 space-y-3">
                {[
                  ["fnf_sheet", "F&F Settlement Sheet"],
                  ["relieving_letter", "Relieving Letter"],
                ].map(([key, label]) => {
                  const doc = exit?.final_documents?.[key];
                  return (
                    <div key={key} className={`flex items-center justify-between p-3 rounded-lg ${doc?.has_file ? "bg-green-50 border border-green-200" : "bg-slate-50 border border-slate-200"}`}>
                      <div className="flex items-center gap-3">
                        <FileText size={16} className={doc?.has_file ? "text-green-600" : "text-slate-400"} />
                        <div>
                          <p className="text-sm font-medium text-slate-800">{label}</p>
                          <p className="text-xs text-slate-500">{doc?.has_file ? doc.file_name : "Not uploaded"}</p>
                        </div>
                      </div>
                      {doc?.has_file && (
                        <button onClick={() => handleDownload(key)} className="p-2 rounded-lg hover:bg-green-100 text-green-700"><Download size={14} /></button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Modals triggered from detail panel */}
      {showApprove && <ApprovalModal exit={exit} onClose={() => setShowApprove(false)} onDone={onRefresh} currentUser={currentUser} />}
      {nocModal && (
        <NOCModal exit={exit} section={nocModal} sectionConfig={nocSections[nocModal]}
          onClose={() => setNocModal(null)} onDone={onRefresh} />
      )}
      {showDocs && <FinalDocsModal exit={exit} onClose={() => setShowDocs(false)} onDone={onRefresh} />}
      {showEditLwd && <EditLWDModal exit={exit} onClose={() => setShowEditLwd(false)} onDone={onRefresh} />}
    </div>
  );
}

// ── NOC progress summary bar ──────────────────────────────────
function NOCProgress({ clearances }) {
  if (!clearances) return null;
  const cleared = Object.values(clearances).filter(s => s.status === "cleared").length;
  const total = 5;
  return (
    <div className="flex items-center gap-2">
      <div className="flex gap-0.5">
        {Object.values(clearances).map((s, i) => (
          <div key={i} className={`w-3 h-3 rounded-full border ${s.status === "cleared" ? "bg-green-500 border-green-500" : "bg-slate-200 border-slate-300"}`} />
        ))}
      </div>
      <span className="text-xs text-slate-500">{cleared}/{total}</span>
    </div>
  );
}

// ── Exit card (list item) ─────────────────────────────────────
function ExitCard({ exit, onClick, currentUser }) {
  const myEmpId = currentUser?.employee_id;
  const isAdmin = currentUser?.role === "hr_admin";
  const pendingApproval = exit?.approval_chain?.find(a => a.status === "pending");
  const needsMyApproval = exit?.status === "submitted" && pendingApproval && (
    (pendingApproval.approver_id === "admin" && isAdmin) ||
    (pendingApproval.approver_id === myEmpId)
  );
  const myNocPending = exit?.status === "noc_in_progress" && Object.entries(exit?.noc_clearances || {}).some(([, sec]) => {
    if (sec.status === "cleared") return false;
    if (isAdmin) return true;
    return sec.assignee_id === myEmpId;
  });
  const showAlert = needsMyApproval || myNocPending || (isAdmin && exit?.status === "noc_complete");

  return (
    <div onClick={onClick} data-testid={`exit-card-${exit.id}`}
      className="bg-white border border-slate-200 rounded-xl p-4 cursor-pointer hover:border-[#E85B1E] hover:shadow-sm transition-all active:scale-[0.99]">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-[#1E2A47] text-sm truncate">{exit.employee_name}</p>
          <p className="text-xs text-[#E85B1E] font-mono">{exit.employee_id}</p>
          <p className="text-xs text-slate-500 truncate">{exit.designation}</p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <StatusBadge status={exit.status} />
          {showAlert && (
            <span className="flex items-center gap-1 text-xs text-red-600 font-semibold">
              <AlertCircle size={11} />
              {needsMyApproval ? "Action needed" : myNocPending ? "NOC pending" : "Upload docs"}
            </span>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs text-slate-600">
        <div>
          <span className="text-slate-400">Resigned</span>
          <span className="ml-1 font-medium">{formatDate(exit.resignation_date)}</span>
        </div>
        <div>
          <span className="text-slate-400">LWD</span>
          <span className="ml-1 font-medium">{exit.last_working_day ? formatDate(exit.last_working_day) : "—"}</span>
        </div>
      </div>
      {exit.status === "noc_in_progress" && (
        <div className="mt-2 pt-2 border-t border-slate-100">
          <NOCProgress clearances={exit.noc_clearances} />
        </div>
      )}
      <div className="flex justify-end mt-2">
        <ChevronRight size={16} className="text-slate-400" />
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────
export default function ExitManagement() {
  const { user } = useAuth();
  const [exits, setExits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [showResign, setShowResign] = useState(false);
  const [filterStatus, setFilterStatus] = useState("all");
  const [search, setSearch] = useState("");

  const isAdmin = user?.role === "hr_admin";
  const isManagement = user?.role === "management";
  const isEmployee = ["employee", "field_agent"].includes(user?.role);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try { const r = await API.get("/exit"); setExits(r.data); }
    catch { }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Refresh selected item
  const refreshSelected = useCallback(async () => {
    await fetchData();
    if (selected) {
      try { const r = await API.get(`/exit/${selected.id}`); setSelected(r.data); }
      catch { }
    }
  }, [fetchData, selected]);

  const filtered = exits.filter(e => {
    if (filterStatus !== "all" && e.status !== filterStatus) return false;
    if (search) {
      const q = search.toLowerCase();
      return (e.employee_name || "").toLowerCase().includes(q) ||
        (e.employee_id || "").toLowerCase().includes(q) ||
        (e.designation || "").toLowerCase().includes(q);
    }
    return true;
  });

  // Stats (admin/management only)
  const stats = {
    total: exits.length,
    pending: exits.filter(e => e.status === "submitted").length,
    noc: exits.filter(e => e.status === "noc_in_progress").length,
    completed: exits.filter(e => e.status === "completed").length,
  };

  // Check if current employee already has an active request
  const myActiveRequest = isEmployee ? exits.find(e => e.employee_id === user?.employee_id && !["rejected", "completed"].includes(e.status)) : null;

  return (
    <div className="max-w-2xl mx-auto px-4 py-4" style={{ fontFamily: "'Work Sans', sans-serif" }} data-testid="exit-management-page">
      {/* Header */}
      <div className="flex items-start justify-between mb-5 gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>Exit Management</h1>
          <p className="text-slate-500 text-sm mt-0.5">Resignation & NOC clearance process</p>
        </div>
        <button onClick={() => setShowResign(true)} data-testid="resign-btn"
          className="flex-shrink-0 flex items-center gap-1.5 px-4 py-2.5 bg-red-600 text-white rounded-xl text-sm font-semibold hover:bg-red-700 transition-colors shadow-sm">
          <Plus size={15} /> {isAdmin ? "Submit on Behalf" : "Resign"}
        </button>
      </div>

      {/* Stats (admin/management) */}
      {(isAdmin || isManagement) && (
        <div className="grid grid-cols-4 gap-2 mb-5">
          {[
            ["Total", stats.total, "text-[#1E2A47]", "bg-slate-50 border-slate-200"],
            ["Pending", stats.pending, "text-amber-700", "bg-amber-50 border-amber-200"],
            ["NOC", stats.noc, "text-blue-700", "bg-blue-50 border-blue-200"],
            ["Done", stats.completed, "text-green-700", "bg-green-50 border-green-200"],
          ].map(([label, val, textColor, bg]) => (
            <div key={label} className={`border rounded-xl p-3 text-center ${bg}`}>
              <p className={`text-xl font-bold ${textColor}`}>{val}</p>
              <p className="text-xs text-slate-500 mt-0.5">{label}</p>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      {(isAdmin || isManagement || user?.role === "managers") && exits.length > 3 && (
        <div className="mb-4 space-y-2">
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name or ID..."
            className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {[["all", "All"], ["submitted", "Pending"], ["noc_in_progress", "NOC"], ["noc_complete", "Ready"], ["completed", "Done"], ["rejected", "Rejected"]].map(([val, label]) => (
              <button key={val} onClick={() => setFilterStatus(val)}
                className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${filterStatus === val ? "bg-[#1E2A47] text-white" : "bg-white border border-slate-300 text-slate-600 hover:bg-slate-50"}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Own active request highlight for employees */}
      {myActiveRequest && (
        <div className="mb-4">
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">My Resignation</p>
          <ExitCard exit={myActiveRequest} onClick={() => setSelected(myActiveRequest)} currentUser={user} />
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => <div key={i} className="h-24 bg-slate-100 rounded-xl animate-pulse" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16">
          <DoorOpen size={40} className="mx-auto text-slate-300 mb-3" />
          <p className="text-slate-400 text-sm">No exit requests found</p>
          {isEmployee && !myActiveRequest && (
            <button onClick={() => setShowResign(true)} className="mt-4 text-sm text-[#E85B1E] font-medium hover:underline">Submit a resignation</button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(e => (
            <ExitCard key={e.id} exit={e} onClick={() => setSelected(e)} currentUser={user} />
          ))}
        </div>
      )}

      {/* Detail Panel */}
      {selected && (
        <DetailPanel
          exit={selected}
          currentUser={user}
          onClose={() => setSelected(null)}
          onRefresh={refreshSelected}
        />
      )}

      {/* Resignation Modal */}
      {showResign && (
        <ResignationModal
          currentUser={user}
          onClose={() => setShowResign(false)}
          onSubmit={fetchData}
        />
      )}
    </div>
  );
}
