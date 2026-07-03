import React, { useEffect, useState, useRef } from "react";
import API from "../utils/api";
import { UserPlus, Search, Download, Upload, Eye, TrendingUp, X, CheckCircle, AlertCircle, SkipForward, ShieldCheck } from "lucide-react";
import { DocCompletenessRing } from "../components/employees/DocCompletenessRing";
import { EmployeeModal } from "../components/employees/EmployeeModal";
import { ReportingManagerInput } from "../components/employees/ReportingManagerInput";
import { Modal } from "../components/shared/Modal";
import { SalaryBreakupForm } from "../components/shared/SalaryBreakupForm";
import { useAuth } from "../contexts/AuthContext";

const ROLES = ["hr_admin", "management", "managers", "employee", "field_agent"];
const ROLE_LABELS = { hr_admin: "HR Admin", management: "Management", managers: "Managers", employee: "HO Staff", field_agent: "Field Staff" };
const STATUS_COLORS = { active: "bg-green-100 text-green-700", probation: "bg-yellow-100 text-yellow-700", notice_period: "bg-orange-100 text-orange-700", resigned: "bg-red-100 text-red-700", terminated: "bg-gray-100 text-gray-700", exited: "bg-gray-100 text-gray-500" };
const STATUS_LABELS = { active: "Active", probation: "Probation", notice_period: "Notice Period", resigned: "Resigned", terminated: "Terminated", exited: "Exited" };
const DEPARTMENTS = ["Accounts", "Administration", "Compliance", "Human Resources", "IT", "Management", "Operations", "Risk and Credit"];
const DESIGNATION_GROUPS = {
  "Management": ["Director", "Chief Executive Officer", "Chief Operating Officer"],
  "Head Office": ["Company Secretary", "HR Manager", "Accounts Manager", "Senior Manager", "Manager", "Assistant Manager", "Senior Executive", "Executive", "Assistant"],
  "Field Team": ["Divisional Manager", "Area Manager", "Senior Branch Manager", "Branch Manager", "Senior Field Officer", "Field Officer"],
  "Risk Team": ["Audit Manager", "Credit Officer"],
};

const INITIAL_FORM = { first_name: "", last_name: "", email: "", mobile: "", department: "", designation: "", role: "employee", reporting_to: "", joining_date: "", branch: "", ctc_monthly: "", basic: "", hra: "", special_allowance: "", canteen_allowance: "", conveyance_allowance: "", epf_employee: "", bank_name: "", account_number: "", ifsc_code: "", password: "Welcome@123", create_user_account: true };

const gross = (f) => (parseFloat(f.basic) || 0) + (parseFloat(f.hra) || 0) + (parseFloat(f.special_allowance) || 0) + (parseFloat(f.canteen_allowance) || 0) + (parseFloat(f.conveyance_allowance) || 0); // kept for reference only

export default function Employees() {
  const { user } = useAuth();
  // Managers (reporting managers) have a read-only view: no add / bulk / template buttons
  // and salary/CTC fields are stripped by the backend for them.
  const canManageEmployees = ["hr_admin", "management"].includes(user?.role);
  const [employees, setEmployees] = useState([]);
  const [completeness, setCompleteness] = useState({});
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showAdd, setShowAdd] = useState(false);
  const [showView, setShowView] = useState(null);
  const [form, setForm] = useState(INITIAL_FORM);
  const [nextId, setNextId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [salaryResult, setSalaryResult] = useState(null); // { updated, skipped, errors }
  const fileRef = useRef();
  const salaryFileRef = useRef();

  const fetchEmployees = async () => {
    setLoading(true);
    try {
      const params = {};
      if (statusFilter && statusFilter !== "all") params.status = statusFilter;
      if (search) params.search = search;
      const res = await API.get("/employees", { params });
      setEmployees(res.data);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  const fetchCompleteness = async () => {
    try {
      const res = await API.get("/employees/document-completeness/all");
      setCompleteness(res.data.completeness || {});
    } catch (e) { console.error("fetchCompleteness failed:", e); }
  };

  const fetchNextId = async () => {
    try {
      const res = await API.get("/employees/next-id");
      setNextId(res.data.next_id);
    } catch (e) { console.error("fetchNextId failed:", e); }
  };

  useEffect(() => { fetchEmployees(); }, [search, statusFilter]);
  useEffect(() => { fetchCompleteness(); }, []);
  useEffect(() => {
    API.get("/locations")
      .then(r => setBranches(r.data.map(l => l.name).sort((a, b) => a.localeCompare(b))))
      .catch(() => setBranches([]));
  }, []);

  const handleAdd = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = { ...form, basic: parseFloat(form.basic) || 0, hra: parseFloat(form.hra) || 0, special_allowance: parseFloat(form.special_allowance) || 0, canteen_allowance: parseFloat(form.canteen_allowance) || 0, conveyance_allowance: parseFloat(form.conveyance_allowance) || 0, ctc_monthly: parseFloat(form.ctc_monthly) || 0, epf_employee: parseFloat(form.epf_employee) || 0 };
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
      const res = await API.post("/employees/bulk-upload", formData);
      alert(`Uploaded: ${res.data.created} created, ${res.data.skipped} skipped`);
      fetchEmployees();
    } catch (e) {
      alert("Upload failed: " + (e.response?.data?.detail || "Unknown error"));
    }
    e.target.value = "";
  };

  const downloadTemplate = async () => {
    try {
      const res = await API.get("/employees/bulk-upload/template", { responseType: "blob" });
      const url = URL.createObjectURL(new Blob([res.data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "employee_bulk_upload_template.xlsx";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert("Failed to download template: " + (e.response?.data?.detail || e.message));
    }
  };

  const downloadSalaryTemplate = async () => {
    try {
      const res = await API.get("/employees/bulk-salary/template", { responseType: "blob" });
      const url = URL.createObjectURL(new Blob([res.data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "salary_revision.xlsx";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert("Failed to download: " + (e.response?.data?.detail || e.message));
    }
  };

  const handleSalaryUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await API.post("/employees/bulk-salary/upload", formData);
      setSalaryResult(res.data);
      fetchEmployees();
    } catch (e) {
      alert("Upload failed: " + (e.response?.data?.detail || "Unknown error"));
    }
    e.target.value = "";
  };

  return (
    <div style={{ fontFamily: "'Work Sans', sans-serif" }}>
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>Employees</h1>
          <p className="text-slate-500 text-sm">{employees.length} employees</p>
        </div>
        {canManageEmployees && (
          <div className="flex flex-wrap gap-2 justify-end">
            <button onClick={() => fileRef.current.click()} className="flex items-center gap-1.5 px-3 py-1.5 border-2 border-[#1E2A47] text-[#1E2A47] rounded-lg text-xs font-medium hover:bg-slate-50 transition-colors" data-testid="bulk-upload-btn">
              <Upload size={13} /> Bulk Upload
            </button>
            <button onClick={downloadTemplate} className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 text-slate-600 rounded-lg text-xs hover:bg-slate-50 transition-colors" data-testid="download-template-btn">
              <Download size={13} /> Template
            </button>
            <button onClick={downloadSalaryTemplate} className="flex items-center gap-1.5 px-3 py-1.5 border border-amber-400 text-amber-700 bg-amber-50 rounded-lg text-xs font-medium hover:bg-amber-100 transition-colors" data-testid="salary-template-btn">
              <TrendingUp size={13} /> Salary
            </button>
            <button onClick={() => salaryFileRef.current.click()} className="flex items-center gap-1.5 px-3 py-1.5 border-2 border-amber-500 text-amber-700 rounded-lg text-xs font-medium hover:bg-amber-50 transition-colors" data-testid="salary-upload-btn">
              <Upload size={13} /> Revision
            </button>
            <button onClick={() => { setShowAdd(true); fetchNextId(); setError(""); }} className="flex items-center gap-1.5 px-3 py-1.5 bg-[#E85B1E] text-white rounded-lg text-xs font-semibold hover:bg-[#D04A15] transition-colors" data-testid="add-employee-btn">
              <UserPlus size={13} /> Add
            </button>
          </div>
        )}
        {canManageEmployees && (
          <>
            <input ref={fileRef} type="file" accept=".csv,.xlsx" className="hidden" onChange={handleBulkUpload} />
            <input ref={salaryFileRef} type="file" accept=".xlsx" className="hidden" onChange={handleSalaryUpload} />
          </>
        )}
      </div>

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
          <option value="notice_period">Serving Notice Period</option>
          <option value="resigned">Resigned</option>
        </select>
        <select onChange={e => setSearch(e.target.value === "all" ? "" : e.target.value)} data-testid="dept-filter"
          className="border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none bg-white">
          <option value="all">All Departments</option>
          {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden">
        <table className="w-full table-fixed" data-testid="employees-table">
          <colgroup>
            <col style={{ width: "22%" }} />
            <col style={{ width: "18%" }} />
            <col style={{ width: "16%" }} />
            <col style={{ width: "14%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "10%" }} />
            <col style={{ width: "8%" }} />
          </colgroup>
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              {["Employee", "Role / Dept", "Branch / Manager", "Verifications", "Status", ...(["hr_admin","management"].includes(user?.role) ? ["Docs"] : []), ""].map((h, i) => (
                <th key={i} className="px-3 py-2.5 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              [...Array(5)].map((_, i) => (
                <tr key={i}><td colSpan={7} className="px-3 py-2"><div className="h-7 bg-slate-100 animate-pulse rounded"></div></td></tr>
              ))
            ) : employees.length === 0 ? (
              <tr><td colSpan={7} className="px-3 py-10 text-center text-slate-400">No employees found</td></tr>
            ) : employees.map(emp => (
              <tr key={emp.id} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                {/* Employee: avatar + name + emp ID */}
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-7 h-7 rounded-full bg-[#1E2A47] flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                      {emp.first_name?.charAt(0)}{emp.last_name?.charAt(0)}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-[#0F172A] truncate">{emp.first_name} {emp.last_name}</p>
                      <p className="text-xs font-mono text-[#E85B1E]">{emp.employee_id}</p>
                    </div>
                  </div>
                </td>
                {/* Designation / Department */}
                <td className="px-3 py-2">
                  <p className="text-xs font-medium text-slate-700 truncate">{emp.designation}</p>
                  <p className="text-xs text-slate-400 truncate">{emp.department}</p>
                </td>
                {/* Branch / Reports To */}
                <td className="px-3 py-2">
                  {emp.branch
                    ? <p className="text-xs font-medium text-blue-700 truncate">{emp.branch}</p>
                    : <p className="text-xs text-slate-300">—</p>}
                  {emp.reporting_to
                    ? <span className="font-mono text-[10px] text-[#E85B1E]">{emp.reporting_to}</span>
                    : null}
                </td>
                {/* EPF + Bank verifications */}
                <td className="px-3 py-2">
                  <div className="flex flex-col gap-0.5">
                    {emp.uan_verification?.verified
                      ? <span className="flex items-center gap-1 text-[10px] font-medium text-green-600" data-testid={`epf-verified-${emp.employee_id}`}><ShieldCheck size={10} />EPF</span>
                      : <span className="text-[10px] text-slate-300">EPF —</span>}
                    {emp.bank_details?.verified
                      ? <span className="flex items-center gap-1 text-[10px] font-medium text-green-600" data-testid={`bank-verified-${emp.employee_id}`}><ShieldCheck size={10} />Bank</span>
                      : <span className="text-[10px] text-slate-300">Bank —</span>}
                  </div>
                </td>
                {/* Status */}
                <td className="px-3 py-2">
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium whitespace-nowrap ${STATUS_COLORS[emp.status] || "bg-slate-100"}`}>
                    {STATUS_LABELS[emp.status] || emp.status}
                  </span>
                </td>
                {/* Docs ring — admin/management only */}
                {["hr_admin","management"].includes(user?.role) && (
                <td className="px-3 py-2">
                  <button onClick={() => setShowView({ ...emp, _initialTab: "docs" })} className="cursor-pointer" title="View documents" data-testid={`docs-ring-${emp.employee_id}`}>
                    <DocCompletenessRing uploaded={completeness[emp.employee_id]?.uploaded || 0} total={completeness[emp.employee_id]?.total || 23} />
                  </button>
                </td>
                )}
                {/* Actions */}
                <td className="px-3 py-2">
                  <button onClick={() => setShowView(emp)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500" data-testid={`view-emp-${emp.employee_id}`}><Eye size={15} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <Modal title={`Add Employee (Next ID: ${nextId})`} onClose={() => setShowAdd(false)}>
          <form onSubmit={handleAdd} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              {[["first_name", "First Name", "text", true], ["last_name", "Last Name", "text", false], ["email", "Email", "email", true], ["mobile", "Mobile", "tel", true]].map(([key, label, type, req]) => (
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
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Branch</label>
                <select value={form.branch} onChange={e => setForm({ ...form, branch: e.target.value })} data-testid="emp-branch"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-[#E85B1E] outline-none">
                  <option value="">— Not Assigned —</option>
                  {branches.map(b => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
            </div>
            <div className="border border-slate-200 rounded-lg p-4 bg-slate-50/60">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">Reporting Manager</p>
              <ReportingManagerInput value={form.reporting_to} onChange={(val) => setForm({ ...form, reporting_to: val })} />
            </div>
            <div className="border-t pt-3">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">Salary</p>
              <SalaryBreakupForm
                form={form}
                onChange={(key, val) => setForm(prev => ({ ...prev, [key]: val }))}
              />
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

      {showView && (
        <EmployeeModal
          emp={showView}
          onClose={() => setShowView(null)}
          onUpdated={(updated) => setEmployees(prev => prev.map(e => e.employee_id === updated.employee_id ? { ...e, ...updated } : e))}
          onDocsChanged={fetchCompleteness}
        />
      )}

      {salaryResult && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <h2 className="font-bold text-[#1E2A47] text-lg" style={{ fontFamily: "'Outfit', sans-serif" }}>Salary Revision — Result</h2>
              <button onClick={() => setSalaryResult(null)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400" data-testid="close-salary-result"><X size={18} /></button>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="bg-green-50 border border-green-200 rounded-xl p-4">
                  <CheckCircle size={22} className="text-green-600 mx-auto mb-1" />
                  <p className="text-2xl font-bold text-green-700" data-testid="salary-updated-count">{salaryResult.updated}</p>
                  <p className="text-xs text-green-600 font-medium">Updated</p>
                </div>
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
                  <SkipForward size={22} className="text-slate-400 mx-auto mb-1" />
                  <p className="text-2xl font-bold text-slate-600" data-testid="salary-skipped-count">{salaryResult.skipped}</p>
                  <p className="text-xs text-slate-500 font-medium">Skipped</p>
                </div>
                <div className="bg-red-50 border border-red-200 rounded-xl p-4">
                  <AlertCircle size={22} className="text-red-500 mx-auto mb-1" />
                  <p className="text-2xl font-bold text-red-600" data-testid="salary-errors-count">{salaryResult.errors?.length ?? 0}</p>
                  <p className="text-xs text-red-500 font-medium">Errors</p>
                </div>
              </div>
              {salaryResult.errors?.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-4 max-h-48 overflow-y-auto">
                  <p className="text-xs font-bold text-red-700 mb-2">Errors:</p>
                  {salaryResult.errors.map((e, i) => (
                    <p key={i} className="text-xs text-red-600 py-0.5">{e}</p>
                  ))}
                </div>
              )}
              <button onClick={() => setSalaryResult(null)} className="w-full py-2.5 bg-[#1E2A47] text-white rounded-xl text-sm font-semibold hover:bg-[#2a3a5c]" data-testid="close-salary-result-btn">
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
