import React, { useEffect, useState, useRef, useCallback } from "react";
import API from "../utils/api";
import { UserPlus, Search, Download, Upload, Eye, X, UserCheck, Loader } from "lucide-react";

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

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
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

      {/* Reporting Manager highlighted */}
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

      {[
        ["Email", emp.email],
        ["Mobile", emp.mobile],
        ["Role", ROLE_LABELS[emp.role] || emp.role],
        ["Status", emp.status],
        ["Joining Date", emp.joining_date],
        ["Gross Salary", `₹${emp.salary?.gross?.toLocaleString("en-IN") || 0}/month`],
        ["Basic", `₹${emp.salary?.basic?.toLocaleString("en-IN") || 0}`],
        ["Bank", emp.bank_details?.bank_name],
        ["Account", emp.bank_details?.account_number],
        ["IFSC", emp.bank_details?.ifsc_code],
      ].map(([label, val]) => val && (
        <div key={label} className="flex justify-between text-sm border-b border-slate-100 pb-2">
          <span className="text-slate-500">{label}</span>
          <span className="text-[#0F172A] font-medium">{val}</span>
        </div>
      ))}
    </div>
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

      {/* View Employee Modal */}
      {showView && (
        <Modal title="Employee Details" onClose={() => setShowView(null)}>
          <EmployeeDetailView emp={showView} />
        </Modal>
      )}
    </div>
  );
}
