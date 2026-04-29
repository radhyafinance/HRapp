import React, { useEffect, useState, useRef, useCallback } from "react";
import API from "../utils/api";
import { UserPlus, Search, Download, Upload, Eye, X, UserCheck, Loader, Edit3, FileText, Trash2, CheckCircle2, AlertCircle, Image as ImageIcon } from "lucide-react";

// Compress image client-side so the resulting file is under maxBytes (default 1 MB).
async function compressImage(file, { maxBytes = 1024 * 1024, maxDimension = 1920, mime = "image/jpeg" } = {}) {
  if (!file) return file;
  if (file.size <= maxBytes && /^image\/(jpe?g|png|webp)$/i.test(file.type)) return file;
  if (!file.type.startsWith("image/")) return file; // PDFs etc — return as-is
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = (e) => resolve(e.target.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = dataUrl;
  });
  let { width, height } = img;
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  width = Math.round(width * scale);
  height = Math.round(height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  const qualities = [0.85, 0.75, 0.65, 0.55, 0.45, 0.35];
  let blob = null;
  for (const q of qualities) {
    blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, q));
    if (blob && blob.size <= maxBytes) break;
  }
  if (!blob || blob.size > maxBytes) {
    for (const s of [0.75, 0.6, 0.5, 0.4]) {
      const w2 = Math.round(width * s), h2 = Math.round(height * s);
      const c2 = document.createElement("canvas");
      c2.width = w2; c2.height = h2;
      const cx = c2.getContext("2d");
      cx.fillStyle = "#FFFFFF"; cx.fillRect(0, 0, w2, h2);
      cx.drawImage(img, 0, 0, w2, h2);
      blob = await new Promise((resolve) => c2.toBlob(resolve, mime, 0.7));
      if (blob && blob.size <= maxBytes) break;
    }
  }
  if (!blob) return file;
  const renamed = (file.name || "image").replace(/\.[^.]+$/, ".jpg");
  return new File([blob], renamed, { type: mime, lastModified: Date.now() });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = (e) => resolve(e.target.result.split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

const ROLES = ["hr_admin", "management", "branch_manager", "employee", "field_agent"];
const ROLE_LABELS = { hr_admin: "HR Admin", management: "Management", branch_manager: "Manager", employee: "HO Staff", field_agent: "Field Staff" };
const ROLE_COLORS = { hr_admin: "bg-purple-100 text-purple-700", management: "bg-blue-100 text-blue-700", branch_manager: "bg-teal-100 text-teal-700", employee: "bg-slate-100 text-slate-700", field_agent: "bg-orange-100 text-orange-700" };
const STATUS_COLORS = { active: "bg-green-100 text-green-700", probation: "bg-yellow-100 text-yellow-700", resigned: "bg-red-100 text-red-700", terminated: "bg-gray-100 text-gray-700" };

const DESIGNATION_GROUPS = {
  "Head Office": ["Chief Executive Officer", "Chief Operating Officer", "Company Secretary", "HR Manager", "Accounts Manager", "Senior Manager", "Manager", "Senior Executive", "Executive", "Assistant"],
  "Field Team": ["Divisional Manager", "Area Manager", "Senior Branch Manager", "Branch Manager", "Senior Field Officer", "Field Officer"],
  "Risk Team": ["Audit Manager", "Credit Officer"],
};

const DEPARTMENTS = ["Accounts", "Administration", "Compliance", "Human Resources", "IT", "Operations", "Risk and Credit"];

/* ── Reporting Manager live-lookup input ── */
function ReportingManagerInput({ value, onChange }) {
  const [status, setStatus] = useState(null); // null | "loading" | "found" | "not_found"
  const [managerName, setManagerName] = useState("");
  const timerRef = useRef(null);

  const lookup = useCallback(async (id) => {
    if (!id || id.trim().length < 4) { setStatus(null); setManagerName(""); return; }
    setStatus("loading");
    try {
      const res = await API.get(`/employees/${id.trim().toUpperCase()}`);
      setManagerName(`${res.data.first_name} ${res.data.last_name} — ${res.data.designation}`);
      setStatus("found");
    } catch {
      setManagerName("");
      setStatus("not_found");
    }
  }, []);

  const handleChange = (e) => {
    const val = e.target.value.toUpperCase();
    onChange(val);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => lookup(val), 600);
  };

  return (
    <div>
      <label className="block text-xs font-semibold text-slate-700 mb-1">Reporting Manager (Employee ID)</label>
      <div className="relative">
        <input
          value={value}
          onChange={handleChange}
          placeholder="e.g. RMF0001"
          data-testid="emp-reporting-to"
          className={`w-full border rounded-lg px-3 py-2 pr-9 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none transition-colors
            ${status === "found" ? "border-green-400 bg-green-50" : status === "not_found" ? "border-red-300 bg-red-50" : "border-slate-300"}`}
        />
        <span className="absolute right-2.5 top-1/2 -translate-y-1/2">
          {status === "loading" && <Loader size={14} className="animate-spin text-slate-400" />}
          {status === "found" && <UserCheck size={14} className="text-green-600" />}
          {status === "not_found" && <X size={14} className="text-red-500" />}
        </span>
      </div>
      {status === "found" && <p className="text-xs text-green-700 mt-1 font-medium">{managerName}</p>}
      {status === "not_found" && <p className="text-xs text-red-500 mt-1">Employee not found</p>}
    </div>
  );
}

function Modal({ title, onClose, children, wide = false }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className={`bg-white rounded-xl shadow-2xl w-full ${wide ? "max-w-4xl" : "max-w-2xl"} max-h-[90vh] overflow-y-auto`}>
        <div className="flex items-center justify-between p-5 border-b sticky top-0 bg-white">
          <h3 className="text-lg font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>{title}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500"><X size={18} /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

const INITIAL_FORM = { first_name: "", last_name: "", email: "", mobile: "", department: "", designation: "", role: "employee", reporting_to: "", joining_date: "", basic: "", hra: "", special_allowance: "", canteen_allowance: "", conveyance_allowance: "", bank_name: "", account_number: "", ifsc_code: "", password: "Welcome@123", create_user_account: true };

/* ── Employee Detail View (used in View modal) ── */
function EmployeeDetailView({ emp }) {
  const [managerInfo, setManagerInfo] = useState(null);

  useEffect(() => {
    if (!emp?.reporting_to) return;
    API.get(`/employees/${emp.reporting_to}`)
      .then(r => setManagerInfo(`${r.data.first_name} ${r.data.last_name} (${r.data.designation})`))
      .catch(() => setManagerInfo(null));
  }, [emp?.reporting_to]);

  const addr = emp.address || {};
  const sal = emp.salary || {};
  const bank = emp.bank_details || {};

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 p-4 bg-slate-50 rounded-lg">
        <div className="w-16 h-16 rounded-full bg-[#1E2A47] flex items-center justify-center text-white text-2xl font-bold">
          {emp.first_name?.charAt(0)}{emp.last_name?.charAt(0)}
        </div>
        <div>
          <h3 className="text-lg font-bold text-[#1E2A47]">{emp.first_name} {emp.last_name}</h3>
          <p className="text-[#E85B1E] font-semibold text-sm">{emp.employee_id}</p>
          <p className="text-slate-500 text-sm">{emp.designation} • {emp.department}</p>
        </div>
      </div>

      {emp.reporting_to && (
        <div className="flex items-center gap-3 p-3 bg-[#E85B1E]/5 border border-[#E85B1E]/20 rounded-lg">
          <UserCheck size={16} className="text-[#E85B1E] flex-shrink-0" />
          <div>
            <p className="text-xs text-slate-500">Reporting Manager</p>
            <p className="text-sm font-semibold text-[#1E2A47]">
              {emp.reporting_to}
              {managerInfo && <span className="font-normal text-slate-500"> — {managerInfo}</span>}
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
        {[
          ["Email", emp.email],
          ["Mobile", emp.mobile],
          ["Role", ROLE_LABELS[emp.role] || emp.role],
          ["Status", emp.status],
          ["Joining Date", emp.joining_date],
          ["Joining Location", emp.joining_location],
          ["Date of Birth", emp.date_of_birth],
          ["Gender", emp.gender],
          ["Father / Husband", emp.father_or_husband_name],
          ["Aadhaar #", emp.aadhaar_number ? emp.aadhaar_number.replace(/(\d{4})(?=\d)/g, "$1 ") : null],
          ["PAN", emp.pan_number],
          ["Blood Group", emp.blood_group],
          ["City", emp.city],
          ["State", emp.state],
          ["Pincode", emp.pincode],
          ["Monthly CTC", sal.ctc_monthly ? `₹${sal.ctc_monthly.toLocaleString("en-IN")}` : null],
          ["Annual CTC", sal.ctc_annual ? `₹${sal.ctc_annual.toLocaleString("en-IN")}` : null],
          ["Gross Salary", sal.gross ? `₹${sal.gross.toLocaleString("en-IN")}/month` : null],
          ["Basic", sal.basic ? `₹${sal.basic.toLocaleString("en-IN")}` : null],
          ["HRA", sal.hra ? `₹${sal.hra.toLocaleString("en-IN")}` : null],
          ["Special Allowance", sal.special_allowance ? `₹${sal.special_allowance.toLocaleString("en-IN")}` : null],
          ["Bank Name", bank.bank_name],
          ["Account #", bank.account_number],
          ["IFSC", bank.ifsc_code],
          ["Emergency Contact", emp.emergency_contact?.name],
          ["Emergency Mobile", emp.emergency_contact?.mobile],
        ].map(([label, val]) => val && (
          <div key={label} className="flex justify-between border-b border-slate-100 pb-1">
            <span className="text-slate-500">{label}</span>
            <span className="text-[#0F172A] font-medium text-right">{val}</span>
          </div>
        ))}
      </div>
      {(addr.current || addr.permanent) && (
        <div className="border-t pt-2">
          {addr.current && <p className="text-sm"><span className="text-slate-500">Current Address: </span><span className="font-medium">{addr.current}</span></p>}
          {addr.permanent && addr.permanent !== addr.current && <p className="text-sm mt-1"><span className="text-slate-500">Permanent Address: </span><span className="font-medium">{addr.permanent}</span></p>}
        </div>
      )}
    </div>
  );
}

/* ── Edit Form ── */
function EmployeeEditForm({ emp, onSaved, onCancel }) {
  const [form, setForm] = useState({
    first_name: emp.first_name || "",
    last_name: emp.last_name || "",
    email: emp.email || "",
    mobile: emp.mobile || "",
    department: emp.department || "",
    designation: emp.designation || "",
    role: emp.role || "employee",
    reporting_to: emp.reporting_to || "",
    joining_date: emp.joining_date || "",
    joining_location: emp.joining_location || "",
    status: emp.status || "active",
    date_of_birth: emp.date_of_birth || "",
    gender: emp.gender || "",
    father_or_husband_name: emp.father_or_husband_name || "",
    aadhaar_number: emp.aadhaar_number || "",
    pan_number: emp.pan_number || "",
    blood_group: emp.blood_group || "",
    address_current: emp.address?.current || "",
    address_permanent: emp.address?.permanent || "",
    city: emp.city || "",
    state: emp.state || "",
    pincode: emp.pincode || "",
    emergency_contact_name: emp.emergency_contact?.name || "",
    emergency_contact_mobile: emp.emergency_contact?.mobile || "",
    ctc_monthly: emp.salary?.ctc_monthly || "",
    basic: emp.salary?.basic || "",
    hra: emp.salary?.hra || "",
    special_allowance: emp.salary?.special_allowance || "",
    canteen_allowance: emp.salary?.canteen_allowance || "",
    conveyance_allowance: emp.salary?.conveyance_allowance || "",
    bank_name: emp.bank_details?.bank_name || "",
    account_number: emp.bank_details?.account_number || "",
    ifsc_code: emp.bank_details?.ifsc_code || "",
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
        {F("reporting_to", "Reporting To (Employee ID)")}
        {F("joining_date", "Joining Date", "date")}
        {F("joining_location", "Joining Location")}
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

/* ── Documents Tab ── */
const DOC_GROUPS = [
  {
    title: "KYC",
    items: [
      ["aadhaar_front", "Aadhaar — Front"],
      ["aadhaar_back", "Aadhaar — Back"],
      ["pan_card", "PAN Card"],
      ["voter_id_front", "Voter ID — Front"],
      ["voter_id_back", "Voter ID — Back"],
      ["driving_license_front", "Driving License — Front"],
      ["driving_license_back", "Driving License — Back"],
      ["passport_photo", "Passport-size Photo"],
    ],
  },
  {
    title: "Education",
    items: [
      ["edu_10th", "10th Certificate"],
      ["edu_12th", "12th Certificate"],
      ["edu_graduation", "Graduation"],
      ["edu_post_graduation", "Post-Graduation"],
      ["edu_phd", "Ph.D"],
      ["edu_other", "Other Qualification"],
    ],
  },
  {
    title: "Banking & Statutory",
    items: [
      ["cancelled_cheque", "Cancelled Cheque / Passbook"],
      ["pf_proof", "PF Proof"],
      ["esic_proof", "ESIC Proof"],
    ],
  },
  {
    title: "Other",
    items: [
      ["bike_rc", "Bike RC"],
      ["bike_puc_insurance", "Bike PUC / Insurance"],
      ["police_verification", "Police Verification"],
      ["medical_form", "Medical Form"],
    ],
  },
  {
    title: "Joining Kit",
    items: [
      ["joining_kit_pdf", "Joining Kit (Generated)"],
      ["signed_joining_kit", "Signed Joining Kit (uploaded back)"],
    ],
  },
];

function EmployeeDocumentsTab({ employeeId }) {
  const [docs, setDocs] = useState({});
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState(null);
  const [err, setErr] = useState("");

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await API.get(`/employees/${employeeId}/documents`);
      setDocs(res.data.documents || {});
    } catch (e) { setErr("Failed to load documents"); }
    finally { setLoading(false); }
  };

  useEffect(() => { refresh(); }, [employeeId]);

  const upload = async (docType, file) => {
    if (!file) return;
    setErr("");
    setBusyKey(docType);
    try {
      let toSend = file;
      if (file.type.startsWith("image/")) {
        toSend = await compressImage(file, { maxBytes: 1024 * 1024 });
      } else if (file.size > 5 * 1024 * 1024) {
        setErr("File too large. Please keep PDFs under 5 MB.");
        setBusyKey(null);
        return;
      }
      const b64 = await fileToBase64(toSend);
      await API.post(`/employees/${employeeId}/documents`, {
        doc_type: docType,
        data_base64: b64,
        mime_type: toSend.type || "application/octet-stream",
        file_name: toSend.name || `${docType}.bin`,
      });
      await refresh();
    } catch (e) {
      setErr(e.response?.data?.detail || "Upload failed");
    } finally {
      setBusyKey(null);
    }
  };

  const remove = async (docType) => {
    if (!confirm(`Delete ${docType}?`)) return;
    setBusyKey(docType);
    try {
      await API.delete(`/employees/${employeeId}/documents/${docType}`);
      await refresh();
    } catch (e) { setErr("Delete failed"); }
    finally { setBusyKey(null); }
  };

  const view = async (docType) => {
    try {
      const res = await API.get(`/employees/${employeeId}/documents/${docType}/file`, { responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) { setErr("Could not open document"); }
  };

  const download = async (docType, fallbackName) => {
    try {
      const res = await API.get(`/employees/${employeeId}/documents/${docType}/file`, {
        responseType: "blob",
        params: { as_attachment: true },
      });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = fallbackName || `${docType}.bin`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setErr("Could not download document"); }
  };

  const generateJoiningKit = async () => {
    setErr("");
    setBusyKey("joining_kit_pdf");
    try {
      const res = await API.get(`/employees/${employeeId}/joining-kit`, { responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = `JoiningKit_${employeeId}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      try {
        const text = await e.response.data.text();
        const parsed = JSON.parse(text);
        setErr(parsed.detail || "Failed to generate kit");
      } catch (_) {
        setErr("Failed to generate kit");
      }
    } finally {
      setBusyKey(null);
    }
  };

  if (loading) return <p className="text-center text-slate-400 py-8">Loading...</p>;

  return (
    <div className="space-y-5">
      {err && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm p-3 rounded-lg flex gap-2">
          <AlertCircle size={16} className="flex-shrink-0 mt-0.5" /><span>{err}</span>
        </div>
      )}

      {DOC_GROUPS.map(g => (
        <div key={g.title}>
          <h4 className="font-bold text-[#1E2A47] text-sm mb-3">{g.title}</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {g.items.map(([key, label]) => {
              const meta = docs[key] || { uploaded: false };
              const busy = busyKey === key;
              return (
                <div key={key} className={`border rounded-lg p-3 ${meta.uploaded ? "border-green-200 bg-green-50/40" : "border-slate-200 bg-slate-50/40"}`}>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <p className="text-xs font-semibold text-[#1E2A47] truncate">{label}</p>
                    {meta.uploaded ? (
                      <span className="flex items-center gap-1 text-[10px] text-green-700 font-medium"><CheckCircle2 size={11} /> Uploaded</span>
                    ) : (
                      <span className="text-[10px] text-slate-400 font-medium">Not uploaded</span>
                    )}
                  </div>
                  {meta.uploaded && (
                    <p className="text-[10px] text-slate-500 mb-2 truncate" title={meta.file_name}>
                      {meta.file_name || "—"} • {meta.size ? `${Math.round(meta.size / 1024)} KB` : ""}
                    </p>
                  )}
                  <div className="flex gap-1.5 flex-wrap">
                    <label className="inline-flex items-center gap-1 px-2 py-1 text-[11px] bg-[#E85B1E] text-white rounded cursor-pointer hover:bg-[#D04A15]">
                      <Upload size={11} /> {meta.uploaded ? "Replace" : "Upload"}
                      <input type="file" accept="image/*,application/pdf" capture="environment" hidden
                        onChange={e => upload(key, e.target.files?.[0])}
                        data-testid={`upload-${key}`}
                        disabled={busy} />
                    </label>
                    {key === "joining_kit_pdf" && (
                      <button type="button" onClick={generateJoiningKit} disabled={busyKey === "joining_kit_pdf"}
                        data-testid="generate-joining-kit-btn"
                        className="inline-flex items-center gap-1 px-2 py-1 text-[11px] bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50">
                        <FileText size={11} /> {busyKey === "joining_kit_pdf" ? "Generating..." : "Generate Now"}
                      </button>
                    )}
                    {meta.uploaded && (
                      <>
                        <button type="button" onClick={() => view(key)} disabled={busy} data-testid={`view-doc-${key}`}
                          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] bg-[#1E2A47]/10 text-[#1E2A47] rounded hover:bg-[#1E2A47]/20">
                          <Eye size={11} /> View
                        </button>
                        <button type="button" onClick={() => download(key, meta.file_name)} disabled={busy} data-testid={`download-doc-${key}`}
                          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] bg-blue-100 text-blue-700 rounded hover:bg-blue-200">
                          <Download size={11} /> Download
                        </button>
                        <button type="button" onClick={() => remove(key)} disabled={busy} data-testid={`delete-doc-${key}`}
                          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] bg-red-100 text-red-700 rounded hover:bg-red-200">
                          <Trash2 size={11} /> Delete
                        </button>
                      </>
                    )}
                    {busy && <span className="text-[11px] text-slate-500">Working...</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <p className="text-[11px] text-slate-500 italic">Image files are auto-compressed to under 1 MB before upload. PDFs must be under 5 MB.</p>
    </div>
  );
}

/* ── Tabbed Employee Modal ── */
function EmployeeModal({ emp, onClose, onUpdated }) {
  const [tab, setTab] = useState("view");
  const [current, setCurrent] = useState(emp);
  return (
    <Modal title={`${current.first_name} ${current.last_name} (${current.employee_id})`} onClose={onClose} wide>
      <div className="flex gap-1 mb-4 border-b border-slate-200">
        {[
          ["view", "View", Eye],
          ["edit", "Edit", Edit3],
          ["docs", "Documents", FileText],
        ].map(([val, label, Icon]) => (
          <button key={val} onClick={() => setTab(val)} data-testid={`emp-tab-${val}`}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${tab === val ? "border-[#E85B1E] text-[#E85B1E]" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>
      {tab === "view" && <EmployeeDetailView emp={current} />}
      {tab === "edit" && (
        <EmployeeEditForm
          emp={current}
          onCancel={() => setTab("view")}
          onSaved={(updated) => {
            setCurrent(updated);
            onUpdated && onUpdated(updated);
            setTab("view");
          }}
        />
      )}
      {tab === "docs" && <EmployeeDocumentsTab employeeId={current.employee_id} />}
    </Modal>
  );
}

export default function Employees() {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showAdd, setShowAdd] = useState(false);
  const [showView, setShowView] = useState(null);
  const [form, setForm] = useState(INITIAL_FORM);
  const [nextId, setNextId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef();

  const fetchEmployees = async () => {
    setLoading(true);
    try {
      const params = {};
      if (statusFilter && statusFilter !== "all") params.status = statusFilter;
      if (search) params.search = search;
      const res = await API.get("/employees", { params });
      setEmployees(res.data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const fetchNextId = async () => {
    try {
      const res = await API.get("/employees/next-id");
      setNextId(res.data.next_id);
    } catch (e) {}
  };

  useEffect(() => { fetchEmployees(); }, [search, statusFilter]);

  const handleAdd = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = { ...form, basic: parseFloat(form.basic) || 0, hra: parseFloat(form.hra) || 0, special_allowance: parseFloat(form.special_allowance) || 0, canteen_allowance: parseFloat(form.canteen_allowance) || 0, conveyance_allowance: parseFloat(form.conveyance_allowance) || 0 };
      await API.post("/employees", payload);
      setShowAdd(false);
      setForm(INITIAL_FORM);
      fetchEmployees();
    } catch (e) {
      setError(e.response?.data?.detail || "Failed to create employee");
    } finally {
      setSaving(false);
    }
  };

  const handleBulkUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await API.post("/employees/bulk-upload", formData, { headers: { "Content-Type": "multipart/form-data" } });
      alert(`Uploaded: ${res.data.created} created, ${res.data.skipped} skipped`);
      fetchEmployees();
    } catch (e) {
      alert("Upload failed: " + (e.response?.data?.detail || "Unknown error"));
    }
    e.target.value = "";
  };

  const downloadTemplate = () => {
    const headers = "employee_id,first_name,last_name,email,mobile,department,designation,role,reporting_to,joining_date,status,basic,hra,special_allowance,canteen_allowance,conveyance_allowance,bank_name,account_number,ifsc_code\n";
    const sample = "RMF0001,John,Doe,john.doe@radhyamfi.com,9876543210,Operations,Field Officer,field_agent,RMF0005,2024-01-15,active,15000,6000,3000,1500,1500,SBI,1234567890,SBIN0001234\n";
    const blob = new Blob([headers + sample], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "employee_template.csv"; a.click();
  };

  const gross = (f) => (parseFloat(f.basic) || 0) + (parseFloat(f.hra) || 0) + (parseFloat(f.special_allowance) || 0) + (parseFloat(f.canteen_allowance) || 0) + (parseFloat(f.conveyance_allowance) || 0);

  return (
    <div style={{ fontFamily: "'Work Sans', sans-serif" }}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>Employees</h1>
          <p className="text-slate-500 text-sm">{employees.length} employees</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => fileRef.current.click()} className="flex items-center gap-2 px-4 py-2 border-2 border-[#1E2A47] text-[#1E2A47] rounded-lg text-sm font-medium hover:bg-slate-50 transition-colors" data-testid="bulk-upload-btn">
            <Upload size={16} /> Bulk Upload
          </button>
          <button onClick={downloadTemplate} className="flex items-center gap-2 px-4 py-2 border border-slate-300 text-slate-600 rounded-lg text-sm hover:bg-slate-50 transition-colors">
            <Download size={16} /> Template
          </button>
          <button onClick={() => { setShowAdd(true); fetchNextId(); setError(""); }} className="flex items-center gap-2 px-4 py-2 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold hover:bg-[#D04A15] transition-colors" data-testid="add-employee-btn">
            <UserPlus size={16} /> Add Employee
          </button>
        </div>
        <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleBulkUpload} />
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search employees..." data-testid="employee-search"
            className="w-full pl-9 pr-4 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-[#E85B1E] focus:border-transparent outline-none" />
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} data-testid="status-filter"
          className="border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none bg-white">
          <option value="all">All Status</option>
          <option value="active">Active</option>
          <option value="probation">Probation</option>
          <option value="resigned">Resigned</option>
        </select>
        <select onChange={e => setSearch(e.target.value === "all" ? "" : e.target.value)} data-testid="dept-filter"
          className="border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none bg-white">
          <option value="all">All Departments</option>
          {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>

      {/* Table */}
      <div className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full" data-testid="employees-table">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                {["Emp ID", "Name", "Designation", "Department", "Reports To", "Status", "Actions"].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [...Array(5)].map((_, i) => (
                  <tr key={i}><td colSpan={8} className="px-4 py-3"><div className="h-8 bg-slate-100 animate-pulse rounded"></div></td></tr>
                ))
              ) : employees.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-12 text-center text-slate-400">No employees found</td></tr>
              ) : employees.map(emp => (
                <tr key={emp.id} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                  <td className="px-4 py-3 text-sm font-mono font-semibold text-[#E85B1E]">{emp.employee_id}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full bg-[#1E2A47] flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                        {emp.first_name?.charAt(0)}{emp.last_name?.charAt(0)}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-[#0F172A]">{emp.first_name} {emp.last_name}</p>
                        <p className="text-xs text-slate-400">{emp.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-600">{emp.designation}</td>
                  <td className="px-4 py-3 text-sm text-slate-600">{emp.department}</td>
                  <td className="px-4 py-3">
                    {emp.reporting_to
                      ? <span className="font-mono text-xs px-2 py-1 bg-[#E85B1E]/10 text-[#E85B1E] rounded-full">{emp.reporting_to}</span>
                      : <span className="text-xs text-slate-400">—</span>}
                  </td>
                  <td className="px-4 py-3"><span className={`px-2 py-1 rounded-full text-xs font-medium capitalize ${STATUS_COLORS[emp.status] || "bg-slate-100"}`}>{emp.status}</span></td>
                  <td className="px-4 py-3">
                    <button onClick={() => setShowView(emp)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500" data-testid={`view-emp-${emp.employee_id}`}><Eye size={16} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add Employee Modal */}
      {showAdd && (
        <Modal title={`Add Employee (Next ID: ${nextId})`} onClose={() => setShowAdd(false)}>
          <form onSubmit={handleAdd} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              {[["first_name", "First Name", "text", true], ["last_name", "Last Name", "text", true], ["email", "Email", "email", true], ["mobile", "Mobile", "tel", true]].map(([key, label, type, req]) => (
                <div key={key}>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">{label}{req && <span className="text-red-500">*</span>}</label>
                  <input type={type} value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })} required={req} data-testid={`emp-${key}`}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
                </div>
              ))}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Department*</label>
                <select value={form.department} onChange={e => setForm({ ...form, department: e.target.value })} required data-testid="emp-department"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none bg-white">
                  <option value="">Select Department</option>
                  {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Designation*</label>
                <select value={form.designation} onChange={e => setForm({ ...form, designation: e.target.value })} required data-testid="emp-designation"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none bg-white">
                  <option value="">Select Designation</option>
                  {Object.entries(DESIGNATION_GROUPS).map(([group, items]) => (
                    <optgroup key={group} label={group}>
                      {items.map(d => <option key={d} value={d}>{d}</option>)}
                    </optgroup>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Role*</label>
                <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })} data-testid="emp-role"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none bg-white">
                  {ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Joining Date*</label>
                <input type="date" value={form.joining_date} onChange={e => setForm({ ...form, joining_date: e.target.value })} required data-testid="emp-joining-date"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
              </div>
            </div>
            {/* Reporting Manager — full width */}
            <div className="border border-slate-200 rounded-lg p-4 bg-slate-50/60">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">Reporting Manager</p>
              <ReportingManagerInput
                value={form.reporting_to}
                onChange={(val) => setForm({ ...form, reporting_to: val })}
              />
            </div>
            <div className="border-t pt-3">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">Salary Components (Monthly)</p>
              <div className="grid grid-cols-2 gap-3">
                {[["basic", "Basic"], ["hra", "HRA"], ["special_allowance", "Special Allowance"], ["canteen_allowance", "Canteen Allowance"], ["conveyance_allowance", "Conveyance"]].map(([key, label]) => (
                  <div key={key}>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">{label} (₹)</label>
                    <input type="number" value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })} data-testid={`emp-${key}`}
                      className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
                  </div>
                ))}
                <div className="bg-slate-50 rounded-lg p-3 flex items-center justify-between">
                  <span className="text-xs text-slate-500">Gross Salary</span>
                  <span className="font-bold text-[#E85B1E]">₹{gross(form).toLocaleString("en-IN")}</span>
                </div>
              </div>
            </div>
            <div className="border-t pt-3">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">Bank Details</p>
              <div className="grid grid-cols-2 gap-3">
                {[["bank_name", "Bank Name"], ["account_number", "Account Number"], ["ifsc_code", "IFSC Code"]].map(([key, label]) => (
                  <div key={key}>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">{label}</label>
                    <input value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })} data-testid={`emp-${key}`}
                      className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
                  </div>
                ))}
              </div>
            </div>
            <div className="border-t pt-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.create_user_account} onChange={e => setForm({ ...form, create_user_account: e.target.checked })} className="w-4 h-4 accent-[#E85B1E]" />
                <span className="text-sm text-slate-700">Create login account</span>
              </label>
              {form.create_user_account && (
                <input value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder="Initial password"
                  className="mt-2 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
              )}
            </div>
            {error && <div className="bg-red-50 text-red-700 text-sm p-3 rounded-lg">{error}</div>}
            <div className="flex gap-3 pt-2">
              <button type="button" onClick={() => setShowAdd(false)} className="flex-1 px-4 py-2.5 border-2 border-slate-300 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50">Cancel</button>
              <button type="submit" disabled={saving} data-testid="save-employee-btn"
                className="flex-1 px-4 py-2.5 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold hover:bg-[#D04A15] disabled:opacity-60 transition-colors">
                {saving ? "Saving..." : "Add Employee"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Employee Modal: View / Edit / Documents */}
      {showView && (
        <EmployeeModal
          emp={showView}
          onClose={() => setShowView(null)}
          onUpdated={(updated) => setEmployees(prev => prev.map(e => e.employee_id === updated.employee_id ? { ...e, ...updated } : e))}
        />
      )}
    </div>
  );
}
