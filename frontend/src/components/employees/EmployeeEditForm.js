import React, { useState, useEffect } from "react";
import { AlertCircle } from "lucide-react";
import API from "../../utils/api";
import { ReportingManagerInput } from "./ReportingManagerInput";
import { SalaryBreakupForm } from "../shared/SalaryBreakupForm";
import { useFieldUnique, UniqueHint, uniqueBorderClass } from "../../hooks/useFieldUnique";

const ROLES = ["hr_admin", "management", "managers", "employee", "field_agent"];
const ROLE_LABELS = { hr_admin: "HR Admin", management: "Management", managers: "Managers", employee: "HO Staff", field_agent: "Field Staff" };
const DEPARTMENTS = ["Accounts", "Administration", "Compliance", "Human Resources", "IT", "Management", "Operations", "Risk and Credit"];
const DESIGNATION_GROUPS = {
  "Management": ["Director", "Chief Executive Officer", "Chief Operating Officer"],
  "Head Office": ["Company Secretary", "HR Manager", "Accounts Manager", "Senior Manager", "Manager", "Assistant Manager", "Senior Executive", "Executive", "Assistant"],
  "Field Team": ["Divisional Manager", "Area Manager", "Senior Branch Manager", "Branch Manager", "Senior Field Officer", "Field Officer"],
  "Risk Team": ["Audit Manager", "Credit Officer"],
};

export function EmployeeEditForm({ emp, onSaved, onCancel }) {
  const [form, setForm] = useState({
    first_name: emp.first_name || "", last_name: emp.last_name || "",
    email: emp.email || "", mobile: emp.mobile || "",
    department: emp.department || "", designation: emp.designation || "",
    role: emp.role || "employee", reporting_to: emp.reporting_to || "",
    joining_date: emp.joining_date || "", joining_location: emp.joining_location || "",
    branch: emp.branch || "",
    status: emp.status || "active", date_of_birth: emp.date_of_birth || "",
    gender: emp.gender || "", father_or_husband_name: emp.father_or_husband_name || "",
    aadhaar_number: emp.aadhaar_number || "", pan_number: emp.pan_number || "",
    blood_group: emp.blood_group || "",
    address_current: emp.address?.current || "", address_permanent: emp.address?.permanent || "",
    city: emp.city || "", state: emp.state || "", pincode: emp.pincode || "",
    emergency_contact_name: emp.emergency_contact?.name || "", emergency_contact_mobile: emp.emergency_contact?.mobile || "",
    ctc_monthly: emp.salary?.ctc_monthly || "", basic: emp.salary?.basic || "",
    hra: emp.salary?.hra || "", special_allowance: emp.salary?.special_allowance || "",
    canteen_allowance: emp.salary?.canteen_allowance || "", conveyance_allowance: emp.salary?.conveyance_allowance || "",
    epf_employee: emp.salary?.epf_employee || "",
    bank_name: emp.bank_details?.bank_name || "", account_number: emp.bank_details?.account_number || "",
    ifsc_code: emp.bank_details?.ifsc_code || "",
    uan_number: emp.uan_number || "", esi_number: emp.esi_number || "",
    shift_id: emp.shift_id || "",
    multi_session_attendance: !!emp.multi_session_attendance,
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [branches, setBranches] = useState([]);
  const [shifts, setShifts] = useState([]);
  const ifscValid = !form.ifsc_code || /^[A-Z]{4}0[A-Z0-9]{6}$/.test((form.ifsc_code || "").toUpperCase());

  // Uniqueness checks (exclude current employee)
  const mobileCheck  = useFieldUnique("mobile",         form.mobile,         { excludeEmployeeId: emp.employee_id }, 10);
  const emailCheck   = useFieldUnique("email",           form.email,          { excludeEmployeeId: emp.employee_id }, 5);
  const aadhaarCheck = useFieldUnique("aadhaar_number",  form.aadhaar_number, { excludeEmployeeId: emp.employee_id }, 12);
  const panCheck     = useFieldUnique("pan_number",      form.pan_number,     { excludeEmployeeId: emp.employee_id }, 10);
  const hasConflict  = mobileCheck.exists === true || emailCheck.exists === true || aadhaarCheck.exists === true || panCheck.exists === true;

  useEffect(() => {
    API.get("/locations")
      .then(r => setBranches(r.data.map(l => l.name).sort((a, b) => a.localeCompare(b))))
      .catch(() => setBranches([]));
    API.get("/shifts")
      .then(r => setShifts(r.data || []))
      .catch(() => setShifts([]));
  }, []);

  const save = async (e) => {
    e.preventDefault();
    setErr("");
    if (form.ifsc_code && !ifscValid) { setErr("Invalid IFSC code format."); return; }
    if (hasConflict) { setErr("Please fix duplicate entries (highlighted in red) before saving."); return; }
    setSaving(true);
    try {
      const payload = {};
      Object.keys(form).forEach((k) => {
        const v = form[k];
        // shift_id is special — empty string means "clear override"; we need to send it.
        if (k === "shift_id") {
          if (v !== emp.shift_id) payload[k] = v ?? "";
          return;
        }
        // Booleans: always send them so a toggle-off persists.
        if (typeof v === "boolean") {
          payload[k] = v;
          return;
        }
        if (v === "" || v === null || v === undefined) return;
        if (["basic", "hra", "special_allowance", "canteen_allowance", "conveyance_allowance", "ctc_monthly"].includes(k)) {
          const n = parseFloat(v);
          if (!isNaN(n)) payload[k] = n;
        } else {
          payload[k] = v;
        }
      });
      const res = await API.put(`/employees/${emp.employee_id}`, payload);
      onSaved(res.data);
    } catch (ex) {
      setErr(ex.response?.data?.detail || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const F = (key, label, type = "text", opts = {}) => (
    <div>
      <label className="block text-xs font-semibold text-slate-700 mb-1">{label}</label>
      {opts.options ? (
        <select value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })}
          className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-[#E85B1E] outline-none">
          {opts.options.map(o => <option key={o.value || o} value={o.value || o}>{o.label || o}</option>)}
        </select>
      ) : opts.textarea ? (
        <textarea rows="2" value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })}
          className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
      ) : (
        <input type={type} value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })}
          data-testid={`edit-${key}`}
          className={`w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none ${opts.error ? "border-red-300" : "border-slate-300"}`} />
      )}
    </div>
  );

  return (
    <form onSubmit={save} className="space-y-4">
      <h4 className="font-bold text-[#1E2A47] text-sm">Personal</h4>
      <div className="grid grid-cols-2 gap-3">
        {F("first_name", "First Name")}
        {F("last_name", "Last Name")}
        {/* Email — uniqueness check */}
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">Email</label>
          <input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })}
            data-testid="edit-email"
            className={`w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none ${uniqueBorderClass(emailCheck, form.email, 5)}`} />
          <UniqueHint {...emailCheck} value={form.email} minLen={5} />
        </div>
        {/* Mobile — uniqueness check */}
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">Mobile</label>
          <input type="tel" value={form.mobile} onChange={e => setForm({ ...form, mobile: e.target.value })}
            data-testid="edit-mobile"
            className={`w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none ${uniqueBorderClass(mobileCheck, form.mobile, 10)}`} />
          <UniqueHint {...mobileCheck} value={form.mobile} minLen={10} />
        </div>
        {F("date_of_birth", "Date of Birth (DD/MM/YYYY)")}
        {F("gender", "Gender", "text", { options: [{ value: "", label: "Select" }, "Male", "Female", "Other"] })}
        {F("father_or_husband_name", "Father / Husband Name")}
        {F("blood_group", "Blood Group")}
        {/* Aadhaar — uniqueness check */}
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">Aadhaar #</label>
          <input value={form.aadhaar_number} onChange={e => setForm({ ...form, aadhaar_number: e.target.value.replace(/\D/g, "").slice(0, 12) })}
            data-testid="edit-aadhaar_number"
            className={`w-full border rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-[#E85B1E] outline-none ${uniqueBorderClass(aadhaarCheck, form.aadhaar_number, 12)}`} />
          <UniqueHint {...aadhaarCheck} value={form.aadhaar_number} minLen={12} />
        </div>
        {/* PAN — uniqueness check */}
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">PAN</label>
          <input value={form.pan_number} onChange={e => setForm({ ...form, pan_number: e.target.value.toUpperCase().slice(0, 10) })}
            data-testid="edit-pan_number"
            className={`w-full border rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-[#E85B1E] outline-none ${uniqueBorderClass(panCheck, form.pan_number, 10)}`} />
          <UniqueHint {...panCheck} value={form.pan_number} minLen={10} />
        </div>
      </div>

      <h4 className="font-bold text-[#1E2A47] text-sm pt-2 border-t">Job</h4>
      <div className="grid grid-cols-2 gap-3">
        {F("department", "Department", "text", { options: [{ value: "", label: "Select" }, ...DEPARTMENTS] })}
        {F("designation", "Designation")}
        {F("role", "Role", "text", { options: ROLES.map(r => ({ value: r, label: ROLE_LABELS[r] })) })}
        {F("status", "Status", "text", { options: [
          { value: "active", label: "Active" },
          { value: "probation", label: "Probation" },
          { value: "notice_period", label: "Serving Notice Period" },
          { value: "resigned", label: "Resigned" },
          { value: "terminated", label: "Terminated" },
        ] })}
        {F("joining_date", "Joining Date", "date")}
        {F("joining_location", "Joining Location")}
        {F("branch", "Branch (Office Location)", "text", {
          options: [{ value: "", label: "— Not Assigned —" }, ...branches.map(b => ({ value: b, label: b }))]
        })}
      </div>
      <ReportingManagerInput value={form.reporting_to} onChange={(val) => setForm({ ...form, reporting_to: val })} />

      <div>
        <label className="block text-xs font-semibold text-slate-700 mb-1">Shift Override</label>
        <select value={form.shift_id} onChange={e => setForm({ ...form, shift_id: e.target.value })}
          data-testid="edit-shift_id"
          className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none bg-white">
          <option value="">— Use role default —</option>
          {shifts.map(s => (
            <option key={s.id} value={s.id}>
              {s.name} · {String(s.start_hour).padStart(2,"0")}:{String(s.start_minute).padStart(2,"0")} – {String(s.end_hour).padStart(2,"0")}:{String(s.end_minute).padStart(2,"0")}
            </option>
          ))}
        </select>
        <p className="text-[10px] text-slate-400 mt-1">Optional. Overrides the role-based shift for this specific employee.</p>
      </div>

      <label className="flex items-start gap-2 px-3 py-2 rounded-lg border border-slate-200 cursor-pointer hover:bg-slate-50">
        <input type="checkbox" checked={!!form.multi_session_attendance}
          onChange={e => setForm({ ...form, multi_session_attendance: e.target.checked })}
          data-testid="edit-multi_session_attendance"
          className="mt-0.5 accent-[#E85B1E]" />
        <div className="flex-1">
          <p className="text-sm font-medium text-slate-700">Allow multiple punch in / out per day</p>
          <p className="text-[10px] text-slate-400 mt-0.5">
            Useful for field staff who leave the office mid-day and return. Total hours are summed across all sessions.
            Late-arrival half-day rule still uses the first punch-in of the day.
          </p>
        </div>
      </label>

      <h4 className="font-bold text-[#1E2A47] text-sm pt-2 border-t">Statutory Numbers</h4>
      <div className="grid grid-cols-2 gap-3">
        {F("uan_number", "UAN Number")}
        {F("esi_number", "ESI Number")}
      </div>

      <h4 className="font-bold text-[#1E2A47] text-sm pt-2 border-t">Salary</h4>
      <SalaryBreakupForm
        form={form}
        onChange={(key, val) => setForm(prev => ({ ...prev, [key]: val }))}
      />

      <h4 className="font-bold text-[#1E2A47] text-sm pt-2 border-t">Bank</h4>
      <div className="grid grid-cols-3 gap-3">
        {F("bank_name", "Bank Name")}
        {F("account_number", "Account #")}
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">IFSC Code</label>
          <input value={form.ifsc_code} onChange={e => setForm({ ...form, ifsc_code: e.target.value.toUpperCase() })}
            maxLength={11} data-testid="edit-ifsc_code"
            className={`w-full border rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-[#E85B1E] outline-none ${form.ifsc_code && !ifscValid ? "border-red-300" : "border-slate-300"}`} />
          {form.ifsc_code && !ifscValid && <p className="text-[11px] text-red-600 mt-1">Invalid format</p>}
        </div>
      </div>

      <h4 className="font-bold text-[#1E2A47] text-sm pt-2 border-t">Address</h4>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">{F("address_current", "Current Address", "text", { textarea: true })}</div>
        <div className="sm:col-span-2">{F("address_permanent", "Permanent Address", "text", { textarea: true })}</div>
        {F("city", "City")}
        {F("state", "State")}
        {F("pincode", "Pincode")}
      </div>

      <h4 className="font-bold text-[#1E2A47] text-sm pt-2 border-t">Emergency Contact</h4>
      <div className="grid grid-cols-2 gap-3">
        {F("emergency_contact_name", "Name")}
        {F("emergency_contact_mobile", "Mobile", "tel")}
      </div>

      <ResetPasswordSection employeeId={emp.employee_id} />

      {err && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm p-3 rounded-lg flex gap-2">
          <AlertCircle size={16} className="flex-shrink-0 mt-0.5" /><span>{err}</span>
        </div>
      )}
      <div className="flex gap-3 sticky bottom-0 bg-white pt-3 border-t">
        <button type="button" onClick={onCancel} className="flex-1 px-4 py-2.5 border-2 border-slate-300 text-slate-600 rounded-lg text-sm font-medium">Cancel</button>
        <button type="submit" disabled={saving || hasConflict} data-testid="save-edit-btn"
          className="flex-1 px-4 py-2.5 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold disabled:opacity-60">
          {saving ? "Saving..." : hasConflict ? "Duplicate — Fix Fields" : "Save Changes"}
        </button>
      </div>
    </form>
  );
}


function ResetPasswordSection({ employeeId }) {
  const [show, setShow] = useState(false);
  const [pwd, setPwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const reset = async () => {
    setMsg(""); setErr("");
    if (!pwd || pwd.length < 4) { setErr("Password must be at least 4 characters."); return; }
    if (!window.confirm(`Reset login password for ${employeeId}?\n\nThe employee will need to use this new password to log in.`)) return;
    setBusy(true);
    try {
      await API.post(`/auth/employees/${employeeId}/reset-password`, { new_password: pwd });
      setMsg(`Password reset. Login as ${employeeId} / ${pwd}. Share with employee securely.`);
      setPwd("");
    } catch (e) {
      setErr(e.response?.data?.detail || "Failed to reset password.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t pt-4">
      <h4 className="font-bold text-[#1E2A47] text-sm mb-2">Login Account</h4>
      <p className="text-xs text-slate-500 mb-2">
        Login username: <span className="font-mono font-semibold text-[#E85B1E]">{employeeId}</span>
      </p>
      {!show ? (
        <button type="button" onClick={() => setShow(true)} data-testid="show-reset-pwd-btn"
          className="text-xs px-3 py-1.5 border border-amber-300 text-amber-700 rounded-lg hover:bg-amber-50">
          Reset Password
        </button>
      ) : (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-2">
          <label className="block text-xs font-semibold text-slate-700">New Password</label>
          <input type="text" value={pwd} onChange={(e) => setPwd(e.target.value)} placeholder="e.g. Welcome@123"
            data-testid="reset-pwd-input"
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-[#E85B1E] outline-none" />
          {msg && <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded p-2" data-testid="reset-pwd-success">{msg}</p>}
          {err && <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">{err}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={() => { setShow(false); setPwd(""); setMsg(""); setErr(""); }}
              className="flex-1 text-xs px-3 py-1.5 border border-slate-300 text-slate-600 rounded-lg">Close</button>
            <button type="button" onClick={reset} disabled={busy} data-testid="confirm-reset-pwd-btn"
              className="flex-1 text-xs px-3 py-1.5 bg-amber-600 text-white rounded-lg disabled:opacity-60">
              {busy ? "Resetting..." : "Confirm Reset"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
