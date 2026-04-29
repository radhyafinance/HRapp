import React, { useState } from "react";
import { AlertCircle } from "lucide-react";
import API from "../../utils/api";
import { ReportingManagerInput } from "./ReportingManagerInput";

const ROLES = ["hr_admin", "management", "branch_manager", "employee", "field_agent"];
const ROLE_LABELS = { hr_admin: "HR Admin", management: "Management", branch_manager: "Manager", employee: "HO Staff", field_agent: "Field Staff" };
const DEPARTMENTS = ["Accounts", "Administration", "Compliance", "Human Resources", "IT", "Operations", "Risk and Credit"];
const DESIGNATION_GROUPS = {
  "Head Office": ["Chief Executive Officer", "Chief Operating Officer", "Company Secretary", "HR Manager", "Accounts Manager", "Senior Manager", "Manager", "Senior Executive", "Executive", "Assistant"],
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
    bank_name: emp.bank_details?.bank_name || "", account_number: emp.bank_details?.account_number || "",
    ifsc_code: emp.bank_details?.ifsc_code || "",
    uan_number: emp.uan_number || "", esi_number: emp.esi_number || "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const ifscValid = !form.ifsc_code || /^[A-Z]{4}0[A-Z0-9]{6}$/.test((form.ifsc_code || "").toUpperCase());

  const save = async (e) => {
    e.preventDefault();
    setErr("");
    if (form.ifsc_code && !ifscValid) { setErr("Invalid IFSC code format."); return; }
    setSaving(true);
    try {
      const payload = {};
      Object.keys(form).forEach((k) => {
        const v = form[k];
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
        {F("email", "Email", "email")}
        {F("mobile", "Mobile", "tel")}
        {F("date_of_birth", "Date of Birth (DD/MM/YYYY)")}
        {F("gender", "Gender", "text", { options: [{ value: "", label: "Select" }, "Male", "Female", "Other"] })}
        {F("father_or_husband_name", "Father / Husband Name")}
        {F("blood_group", "Blood Group")}
        {F("aadhaar_number", "Aadhaar #")}
        {F("pan_number", "PAN")}
      </div>

      <h4 className="font-bold text-[#1E2A47] text-sm pt-2 border-t">Job</h4>
      <div className="grid grid-cols-2 gap-3">
        {F("department", "Department", "text", { options: [{ value: "", label: "Select" }, ...DEPARTMENTS] })}
        {F("designation", "Designation")}
        {F("role", "Role", "text", { options: ROLES.map(r => ({ value: r, label: ROLE_LABELS[r] })) })}
        {F("status", "Status", "text", { options: ["active", "probation", "resigned", "terminated"] })}
        {F("joining_date", "Joining Date", "date")}
        {F("joining_location", "Joining Location")}
      </div>
      <ReportingManagerInput value={form.reporting_to} onChange={(val) => setForm({ ...form, reporting_to: val })} />

      <h4 className="font-bold text-[#1E2A47] text-sm pt-2 border-t">Statutory Numbers</h4>
      <div className="grid grid-cols-2 gap-3">
        {F("uan_number", "UAN Number")}
        {F("esi_number", "ESI Number")}
      </div>

      <h4 className="font-bold text-[#1E2A47] text-sm pt-2 border-t">Salary</h4>
      <div className="grid grid-cols-3 gap-3">
        {F("ctc_monthly", "Monthly CTC (₹)", "number")}
        {F("basic", "Basic (₹)", "number")}
        {F("hra", "HRA (₹)", "number")}
        {F("special_allowance", "Special (₹)", "number")}
        {F("canteen_allowance", "Canteen (₹)", "number")}
        {F("conveyance_allowance", "Conveyance (₹)", "number")}
      </div>

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

      {err && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm p-3 rounded-lg flex gap-2">
          <AlertCircle size={16} className="flex-shrink-0 mt-0.5" /><span>{err}</span>
        </div>
      )}
      <div className="flex gap-3 sticky bottom-0 bg-white pt-3 border-t">
        <button type="button" onClick={onCancel} className="flex-1 px-4 py-2.5 border-2 border-slate-300 text-slate-600 rounded-lg text-sm font-medium">Cancel</button>
        <button type="submit" disabled={saving} data-testid="save-edit-btn" className="flex-1 px-4 py-2.5 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold disabled:opacity-60">
          {saving ? "Saving..." : "Save Changes"}
        </button>
      </div>
    </form>
  );
}
