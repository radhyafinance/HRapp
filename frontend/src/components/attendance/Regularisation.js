import React, { useEffect, useState } from "react";
import API from "../../utils/api";
import { Edit3, Plus, X, Clock, CheckCircle2, XCircle, AlertTriangle, History } from "lucide-react";
import { toLocalDateStr } from "../../utils/shiftRules";

const STATUS_OPTIONS = [
  { value: "present", label: "Present" },
  { value: "absent", label: "Absent" },
  { value: "half_day", label: "Half Day" },
  { value: "leave", label: "Leave" },
  { value: "weekly_off", label: "Weekly Off" },
  { value: "holiday", label: "Holiday" },
];

function isoToTime(iso) {
  if (!iso) return "";
  // Already HH:MM or HH:MM:SS format
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(iso)) {
    return iso.slice(0, 5);
  }
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  } catch { return ""; }
}

function BaseModal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b sticky top-0 bg-white">
          <h3 className="text-base font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>{title}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100"><X size={18} /></button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

// ---------- ADMIN: Edit / Create attendance ----------
export function AdminRegulariseModal({ mode, record, employees, onClose, onSaved }) {
  // mode: "edit" (has record) | "create" (has employees list)
  const [empId, setEmpId] = useState(record?.employee_id || "");
  const [date, setDate] = useState(record?.date || toLocalDateStr());
  const [punchIn, setPunchIn] = useState(isoToTime(record?.punch_in_time));
  const [punchOut, setPunchOut] = useState(isoToTime(record?.punch_out_time));
  const [status, setStatus] = useState(record?.status || "present");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const save = async () => {
    setErr("");
    if (!reason.trim()) return setErr("Reason is required.");
    if (mode === "create" && !empId) return setErr("Select an employee.");
    setSaving(true);
    try {
      if (mode === "edit") {
        await API.patch(`/attendance/records/${record.id}`, {
          punch_in_time: punchIn || null,
          punch_out_time: punchOut || null,
          status,
          reason,
        });
      } else {
        await API.post("/attendance/records", {
          employee_id: empId,
          date,
          punch_in_time: punchIn || null,
          punch_out_time: punchOut || null,
          status,
          reason,
        });
      }
      onSaved?.();
      onClose();
    } catch (e) {
      setErr(e.response?.data?.detail || "Failed to save.");
    } finally { setSaving(false); }
  };

  return (
    <BaseModal title={mode === "edit" ? "Regularise Attendance" : "Add Attendance Record"} onClose={onClose}>
      <div className="space-y-3 text-sm">
        {mode === "create" && (
          <>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Employee</label>
              <select value={empId} onChange={(e) => setEmpId(e.target.value)} data-testid="reg-employee-select"
                className="w-full border border-slate-300 rounded-lg px-3 py-2">
                <option value="">Select employee…</option>
                {employees?.map(e => (
                  <option key={e.employee_id} value={e.employee_id}>
                    {e.employee_id} — {e.first_name} {e.last_name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Date</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} data-testid="reg-date"
                className="w-full border border-slate-300 rounded-lg px-3 py-2" />
            </div>
          </>
        )}
        {mode === "edit" && record && (
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs">
            <p><strong>{record.employee_id}</strong> • <strong>{record.date}</strong></p>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Punch In (HH:MM UTC)</label>
            <input type="time" value={punchIn} onChange={(e) => setPunchIn(e.target.value)} data-testid="reg-punch-in"
              className="w-full border border-slate-300 rounded-lg px-3 py-2" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Punch Out (HH:MM UTC)</label>
            <input type="time" value={punchOut} onChange={(e) => setPunchOut(e.target.value)} data-testid="reg-punch-out"
              className="w-full border border-slate-300 rounded-lg px-3 py-2" />
          </div>
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1">Status</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)} data-testid="reg-status"
            className="w-full border border-slate-300 rounded-lg px-3 py-2">
            {STATUS_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1">Reason <span className="text-red-500">*</span></label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} data-testid="reg-reason"
            placeholder="e.g. Forgot to punch — confirmed by branch manager"
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" />
        </div>
        {err && <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-xs">{err}</div>}
        <div className="flex gap-2 pt-2">
          <button onClick={onClose} className="flex-1 px-3 py-2 border border-slate-300 text-slate-600 rounded-lg text-sm">Cancel</button>
          <button onClick={save} disabled={saving} data-testid="reg-save-btn"
            className="flex-1 px-3 py-2 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold disabled:opacity-60">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </BaseModal>
  );
}

// ---------- EMPLOYEE: Request regularisation ----------
export function EmployeeRegulariseRequestModal({ onClose, onSaved }) {
  const [date, setDate] = useState(toLocalDateStr());
  const [attendance, setAttendance] = useState("present"); // "present" | "half_day"
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    setErr("");
    if (!reason.trim()) return setErr("Please explain why you're requesting this change.");
    setSaving(true);
    try {
      await API.post("/attendance/regularisation-requests", {
        date,
        requested_punch_in_time: null,
        requested_punch_out_time: null,
        requested_status: attendance,
        reason,
      });
      onSaved?.();
      onClose();
    } catch (e) {
      setErr(e.response?.data?.detail || "Failed to submit request.");
    } finally { setSaving(false); }
  };

  return (
    <BaseModal title="Request Attendance Regularisation" onClose={onClose}>
      <div className="space-y-4 text-sm">
        <div className="bg-blue-50 border border-blue-100 text-blue-800 rounded-lg p-3 text-xs">
          Your request will be reviewed by HR. You'll be notified once it's processed.
        </div>

        {/* Date */}
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1">Date <span className="text-red-500">*</span></label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} data-testid="empreg-date"
            max={toLocalDateStr()}
            className="w-full border border-slate-300 rounded-lg px-3 py-2" />
        </div>

        {/* Attendance Type — two clear buttons */}
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-2">Mark As <span className="text-red-500">*</span></label>
          <div className="grid grid-cols-2 gap-3">
            <button type="button" data-testid="empreg-full-day"
              onClick={() => setAttendance("present")}
              className={`py-3 rounded-xl border-2 font-semibold text-sm transition-all ${
                attendance === "present"
                  ? "border-green-500 bg-green-50 text-green-700"
                  : "border-slate-200 text-slate-500 hover:border-slate-300"
              }`}>
              Full Day Present
            </button>
            <button type="button" data-testid="empreg-half-day"
              onClick={() => setAttendance("half_day")}
              className={`py-3 rounded-xl border-2 font-semibold text-sm transition-all ${
                attendance === "half_day"
                  ? "border-amber-500 bg-amber-50 text-amber-700"
                  : "border-slate-200 text-slate-500 hover:border-slate-300"
              }`}>
              Half Day Present
            </button>
          </div>
        </div>

        {/* Reason */}
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1">Reason <span className="text-red-500">*</span></label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} data-testid="empreg-reason"
            placeholder="e.g. Forgot to punch, was on field visit"
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" />
        </div>

        {err && <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-xs">{err}</div>}
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 px-3 py-2 border border-slate-300 text-slate-600 rounded-lg text-sm">Cancel</button>
          <button onClick={submit} disabled={saving} data-testid="empreg-submit-btn"
            className="flex-1 px-3 py-2 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold disabled:opacity-60">
            {saving ? "Submitting…" : "Submit Request"}
          </button>
        </div>
      </div>
    </BaseModal>
  );
}

// ---------- ADMIN: Pending requests panel ----------
export function PendingRequestsPanel({ onApproved }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

  const fetchPending = async () => {
    setLoading(true);
    try {
      const res = await API.get("/attendance/regularisation-requests?status=pending");
      setRows(res.data);
    } catch { console.error("fetchPending regularisation requests failed"); }
    finally { setLoading(false); }
  };
  useEffect(() => { fetchPending(); }, []);

  const act = async (r, action) => {
    const remark = action === "reject"
      ? window.prompt(`Reject request for ${r.employee_id} on ${r.date}? Add a reason:`)
      : window.prompt(`Approve request for ${r.employee_id} on ${r.date}? Optional remark:`, "Approved") || "Approved";
    if (action === "reject" && !remark) return;
    if (remark === null) return;
    setBusyId(r.id);
    try {
      await API.put(`/attendance/regularisation-requests/${r.id}/action`, { action, admin_remark: remark });
      await fetchPending();
      onApproved?.();
    } catch (e) {
      alert(e.response?.data?.detail || "Failed to process.");
    } finally { setBusyId(null); }
  };

  if (loading) return <div className="text-xs text-slate-400 py-3">Loading pending requests…</div>;
  if (rows.length === 0) return (
    <div className="flex items-center gap-2 text-xs text-slate-400 py-3">
      <CheckCircle2 size={14} /> No pending regularisation requests.
    </div>
  );

  return (
    <div className="space-y-2" data-testid="pending-reg-requests">
      {rows.map(r => (
        <div key={r.id} className="border border-amber-200 bg-amber-50 rounded-lg p-3 text-xs">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-[#1E2A47]">{r.employee_name || r.employee_id} <span className="text-slate-500 font-mono">({r.employee_id})</span></p>
              <p className="text-slate-600 mt-0.5">
                <Clock size={10} className="inline mr-1" />
                {r.date}
                {r.requested_punch_in_time && <> • In: {isoToTime(r.requested_punch_in_time)}</>}
                {r.requested_punch_out_time && <> • Out: {isoToTime(r.requested_punch_out_time)}</>}
                {r.requested_status && <> • Status: {r.requested_status}</>}
              </p>
              <p className="text-slate-500 mt-1 italic">"{r.reason}"</p>
            </div>
            <div className="flex flex-col gap-1 flex-shrink-0">
              <button onClick={() => act(r, "approve")} disabled={busyId === r.id} data-testid={`approve-reg-${r.id}`}
                className="px-2 py-1 bg-green-600 text-white rounded text-[11px] font-semibold hover:bg-green-700 disabled:opacity-50">
                {busyId === r.id ? "…" : "Approve"}
              </button>
              <button onClick={() => act(r, "reject")} disabled={busyId === r.id} data-testid={`reject-reg-${r.id}`}
                className="px-2 py-1 bg-red-600 text-white rounded text-[11px] font-semibold hover:bg-red-700 disabled:opacity-50">
                Reject
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- EMPLOYEE: view own requests status ----------
export function MyRequestsList({ refreshToken }) {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    API.get("/attendance/regularisation-requests").then(r => setRows(r.data)).catch(() => {});
  }, [refreshToken]);
  if (rows.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="my-reg-requests">
      {rows.slice(0, 5).map(r => (
        <div key={r.id} className="border border-slate-200 rounded-lg p-2.5 text-xs bg-white">
          <div className="flex items-center justify-between">
            <span className="font-medium text-slate-700">{r.date}</span>
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ${
              r.status === "pending" ? "bg-amber-100 text-amber-700"
              : r.status === "approved" ? "bg-green-100 text-green-700"
              : "bg-red-100 text-red-700"
            }`}>{r.status}</span>
          </div>
          <p className="text-slate-500 mt-0.5 italic">"{r.reason}"</p>
          {r.admin_remark && <p className="text-slate-600 mt-0.5"><strong>HR:</strong> {r.admin_remark}</p>}
        </div>
      ))}
    </div>
  );
}
