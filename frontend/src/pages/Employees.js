import React, { useEffect, useState, useRef } from "react";
import API from "../utils/api";
import { UserPlus, Search, Download, Upload, Eye } from "lucide-react";
import { DocCompletenessRing } from "../components/employees/DocCompletenessRing";
import { EmployeeModal } from "../components/employees/EmployeeModal";
import { ReportingManagerInput } from "../components/employees/ReportingManagerInput";
import { Modal } from "../components/shared/Modal";
import { SalaryBreakupForm } from "../components/shared/SalaryBreakupForm";

const ROLES = ["hr_admin", "management", "managers", "employee", "field_agent"];
const ROLE_LABELS = { hr_admin: "HR Admin", management: "Management", managers: "Managers", employee: "HO Staff", field_agent: "Field Staff" };
const STATUS_COLORS = { active: "bg-green-100 text-green-700", probation: "bg-yellow-100 text-yellow-700", notice_period: "bg-orange-100 text-orange-700", resigned: "bg-red-100 text-red-700", terminated: "bg-gray-100 text-gray-700", exited: "bg-gray-100 text-gray-500" };
const STATUS_LABELS = { active: "Active", probation: "Probation", notice_period: "Serving Notice Period", resigned: "Resigned", terminated: "Terminated", exited: "Exited" };
const DEPARTMENTS = ["Accounts", "Administration", "Compliance", "Human Resources", "IT", "Operations", "Risk and Credit"];
const DESIGNATION_GROUPS = {
  "Management": ["Director"],
  "Head Office": ["Chief Executive Officer", "Chief Operating Officer", "Company Secretary", "HR Manager", "Accounts Manager", "Senior Manager", "Manager", "Senior Executive", "Executive", "Assistant"],
  "Field Team": ["Divisional Manager", "Area Manager", "Senior Branch Manager", "Branch Manager", "Senior Field Officer", "Field Officer"],
  "Risk Team": ["Audit Manager", "Credit Officer"],
};

const INITIAL_FORM = { first_name: "", last_name: "", email: "", mobile: "", department: "", designation: "", role: "employee", reporting_to: "", joining_date: "", ctc_monthly: "", basic: "", hra: "", special_allowance: "", canteen_allowance: "", conveyance_allowance: "", epf_employee: "", bank_name: "", account_number: "", ifsc_code: "", password: "Welcome@123", create_user_account: true };

const gross = (f) => (parseFloat(f.basic) || 0) + (parseFloat(f.hra) || 0) + (parseFloat(f.special_allowance) || 0) + (parseFloat(f.canteen_allowance) || 0) + (parseFloat(f.conveyance_allowance) || 0); // kept for reference only

export default function Employees() {
  const [employees, setEmployees] = useState([]);
  const [completeness, setCompleteness] = useState({});
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
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  const fetchCompleteness = async () => {
    try {
      const res = await API.get("/employees/document-completeness/all");
      setCompleteness(res.data.completeness || {});
    } catch (e) { /* non-critical */ }
  };

  const fetchNextId = async () => {
    try {
      const res = await API.get("/employees/next-id");
      setNextId(res.data.next_id);
    } catch (e) {}
  };

  useEffect(() => { fetchEmployees(); }, [search, statusFilter]);
  useEffect(() => { fetchCompleteness(); }, []);

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
      const res = await API.post("/employees/bulk-upload", formData, { headers: { "Content-Type": "multipart/form-data" } });
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
        <input ref={fileRef} type="file" accept=".csv,.xlsx" className="hidden" onChange={handleBulkUpload} />
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
        <div className="overflow-x-auto">
          <table className="w-full" data-testid="employees-table">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                {["Emp ID", "Name", "Designation", "Department", "Reports To", "Status", "Docs", "Actions"].map(h => (
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
                  <td className="px-4 py-3"><span className={`px-2 py-1 rounded-full text-xs font-medium ${STATUS_COLORS[emp.status] || "bg-slate-100"}`}>{STATUS_LABELS[emp.status] || emp.status}</span></td>
                  <td className="px-4 py-3">
                    <button onClick={() => setShowView({ ...emp, _initialTab: "docs" })} className="cursor-pointer" title="View documents" data-testid={`docs-ring-${emp.employee_id}`}>
                      <DocCompletenessRing uploaded={completeness[emp.employee_id]?.uploaded || 0} total={completeness[emp.employee_id]?.total || 23} />
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <button onClick={() => setShowView(emp)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500" data-testid={`view-emp-${emp.employee_id}`}><Eye size={16} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

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
    </div>
  );
}
