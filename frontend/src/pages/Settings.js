import React, { useEffect, useState } from "react";
import API from "../utils/api";
import { useAuth } from "../contexts/AuthContext";
import { MapPin, Plus, Edit, Trash2, X } from "lucide-react";

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b sticky top-0 bg-white">
          <h3 className="text-lg font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>{title}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100"><X size={18} /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

const INIT_FORM = { name: "", address: "", latitude: "", longitude: "", radius_meters: 10, location_type: "branch" };

const INIT_COMPANY = {
  company_name: "",
  company_short_code: "RMF0001",
  debit_account_no: "",
  debit_account_ifsc: "",
  debit_bank_name: "",
  transaction_type: "NFT",
  address: "",
  cin: "",
  phone: "",
  email: "",
  website: "",
};

export default function Settings() {
  const { user } = useAuth();
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editLoc, setEditLoc] = useState(null);
  const [form, setForm] = useState(INIT_FORM);
  const [saving, setSaving] = useState(false);
  const [users, setUsers] = useState([]);
  const [activeTab, setActiveTab] = useState("locations");
  const [company, setCompany] = useState(INIT_COMPANY);
  const [companyOriginal, setCompanyOriginal] = useState(INIT_COMPANY);
  const [savingCompany, setSavingCompany] = useState(false);
  const [faceMatchStrict, setFaceMatchStrict] = useState(false);
  const [savingFaceMatch, setSavingFaceMatch] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [locRes, userRes, compRes, faceRes] = await Promise.all([
        API.get("/locations"),
        API.get("/auth/users"),
        API.get("/settings/company"),
        API.get("/settings/face-match"),
      ]);
      setLocations(locRes.data);
      setUsers(userRes.data);
      const c = { ...INIT_COMPANY, ...compRes.data };
      setCompany(c);
      setCompanyOriginal(c);
      setFaceMatchStrict(!!faceRes.data?.strict);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchData(); }, []);

  const handleSaveLocation = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = { ...form, latitude: parseFloat(form.latitude), longitude: parseFloat(form.longitude), radius_meters: parseFloat(form.radius_meters) };
      if (editLoc) {
        await API.put(`/locations/${editLoc.id}`, payload);
      } else {
        await API.post("/locations", payload);
      }
      setShowAdd(false);
      setEditLoc(null);
      setForm(INIT_FORM);
      fetchData();
    } catch (e) { alert(e.response?.data?.detail || "Failed to save location"); }
    finally { setSaving(false); }
  };

  const deleteLocation = async (id) => {
    if (!window.confirm("Delete this location?")) return;
    try {
      await API.delete(`/locations/${id}`);
      fetchData();
    } catch (e) { alert("Failed to delete"); }
  };

  const toggleUser = async (userId) => {
    try {
      await API.put(`/auth/users/${userId}/toggle`);
      fetchData();
    } catch (e) { alert("Failed"); }
  };

  const saveCompany = async (e) => {
    e.preventDefault();
    setSavingCompany(true);
    try {
      const res = await API.put("/settings/company", company);
      const c = { ...INIT_COMPANY, ...res.data };
      setCompany(c);
      setCompanyOriginal(c);
      alert("Company settings saved");
    } catch (err) { alert(err.response?.data?.detail || "Failed to save"); }
    finally { setSavingCompany(false); }
  };

  const saveFaceMatch = async (newStrict) => {
    setSavingFaceMatch(true);
    try {
      await API.put("/settings/face-match", { strict: newStrict });
      setFaceMatchStrict(newStrict);
    } catch (err) { alert(err.response?.data?.detail || "Failed to save"); }
    finally { setSavingFaceMatch(false); }
  };

  const [creditResult, setCreditResult] = useState(null);
  const [crediting, setCrediting] = useState(false);
  const [elCreditResult, setElCreditResult] = useState(null);
  const [elCrediting, setElCrediting] = useState(false);

  const creditHalfYear = async () => {
    if (!window.confirm("This will credit half-year SL and CL to all active employees. Continue?")) return;
    setCrediting(true);
    setCreditResult(null);
    try {
      const res = await API.post("/leaves/admin/credit-halfyear");
      setCreditResult({ success: true, ...res.data });
    } catch (e) {
      setCreditResult({ success: false, message: e.response?.data?.detail || "Failed to credit leaves" });
    } finally {
      setCrediting(false);
    }
  };

  const creditMonthlyEL = async () => {
    if (!window.confirm("Credit 1 EL to all eligible employees (6+ months service) for this month?")) return;
    setElCrediting(true);
    setElCreditResult(null);
    try {
      const res = await API.post("/leaves/admin/credit-monthly-el");
      setElCreditResult({ success: true, ...res.data });
    } catch (e) {
      setElCreditResult({ success: false, message: e.response?.data?.detail || "Failed to credit EL" });
    } finally {
      setElCrediting(false);
    }
  };

  const TYPE_BADGE = { head_office: "bg-[#1E2A47] text-white", branch: "bg-blue-100 text-blue-700", field: "bg-green-100 text-green-700" };

  return (
    <div style={{ fontFamily: "'Work Sans', sans-serif" }}>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>Settings</h1>
        <p className="text-slate-500 text-sm">Manage locations, users and system settings</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6 border-b border-slate-200">
        {[["locations", "Office Locations"], ["company", "Company / Bank"], ["attendance", "Attendance"], ["leaves", "Leave Management"], ["users", "User Management"]].map(([val, label]) => (
          <button key={val} onClick={() => setActiveTab(val)} data-testid={`settings-tab-${val}`}
            className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 ${activeTab === val ? "border-[#E85B1E] text-[#E85B1E]" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
            {label}
          </button>
        ))}
      </div>

      {activeTab === "locations" && (
        <div>
          <div className="flex justify-end mb-4">
            <button onClick={() => { setShowAdd(true); setForm(INIT_FORM); setEditLoc(null); }} data-testid="add-location-btn"
              className="flex items-center gap-2 px-4 py-2 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold hover:bg-[#D04A15] transition-colors">
              <Plus size={16} /> Add Location
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4" data-testid="locations-grid">
            {loading ? [...Array(3)].map((_, i) => <div key={i} className="h-32 bg-slate-100 animate-pulse rounded-xl"></div>)
              : locations.map(loc => (
                <div key={loc.id} className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm hover:-translate-y-0.5 transition-transform">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <div className="w-9 h-9 rounded-lg bg-[#E85B1E]/10 flex items-center justify-center">
                        <MapPin size={18} className="text-[#E85B1E]" />
                      </div>
                      <div>
                        <p className="font-bold text-[#1E2A47] text-sm">{loc.name}</p>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${TYPE_BADGE[loc.location_type] || "bg-slate-100 text-slate-700"}`}>{loc.location_type}</span>
                      </div>
                    </div>
                    <div className="flex gap-1">
                      <button onClick={() => { setEditLoc(loc); setForm({ name: loc.name, address: loc.address, latitude: loc.latitude, longitude: loc.longitude, radius_meters: loc.radius_meters, location_type: loc.location_type }); setShowAdd(true); }} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400"><Edit size={14} /></button>
                      <button onClick={() => deleteLocation(loc.id)} className="p-1.5 rounded-lg hover:bg-red-50 text-red-400"><Trash2 size={14} /></button>
                    </div>
                  </div>
                  <p className="text-xs text-slate-500 mb-2">{loc.address}</p>
                  <div className="grid grid-cols-2 gap-2 text-xs text-slate-500">
                    <span>Lat: {loc.latitude}</span>
                    <span>Lon: {loc.longitude}</span>
                    <span className="col-span-2">Geofence Radius: <span className="font-semibold text-[#E85B1E]">{loc.radius_meters}m</span></span>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {activeTab === "company" && (
        <div className="max-w-3xl">
          <form onSubmit={saveCompany} className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm space-y-5" data-testid="company-settings-form">
            <div>
              <h3 className="font-bold text-[#1E2A47] text-base mb-1" style={{ fontFamily: "'Outfit', sans-serif" }}>Company Profile</h3>
              <p className="text-xs text-slate-500">Used on letters, payslips and NEFT files.</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Company Name</label>
                <input type="text" value={company.company_name} onChange={e => setCompany({ ...company, company_name: e.target.value })}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" data-testid="company-name-input" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Short Code (NEFT remarks)</label>
                <input type="text" value={company.company_short_code} onChange={e => setCompany({ ...company, company_short_code: e.target.value })}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" data-testid="company-short-code-input" />
                <p className="text-xs text-slate-400 mt-1">Used as remark prefix, e.g. <span className="font-mono">RMF0001 Salary Apr26</span></p>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">CIN</label>
                <input type="text" value={company.cin} onChange={e => setCompany({ ...company, cin: e.target.value })}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Phone</label>
                <input type="text" value={company.phone} onChange={e => setCompany({ ...company, phone: e.target.value })}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Email</label>
                <input type="email" value={company.email} onChange={e => setCompany({ ...company, email: e.target.value })}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Website</label>
                <input type="text" value={company.website} onChange={e => setCompany({ ...company, website: e.target.value })}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs font-semibold text-slate-700 mb-1">Registered Address</label>
                <textarea rows="2" value={company.address} onChange={e => setCompany({ ...company, address: e.target.value })}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
              </div>
            </div>

            <div className="border-t border-slate-100 pt-5">
              <h3 className="font-bold text-[#1E2A47] text-base mb-1" style={{ fontFamily: "'Outfit', sans-serif" }}>Bank / NEFT Configuration</h3>
              <p className="text-xs text-slate-500 mb-4">Used to populate the Debit Account column in the NEFT export.</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Debit Account No (12 digit)</label>
                  <input type="text" maxLength={12} value={company.debit_account_no} onChange={e => setCompany({ ...company, debit_account_no: e.target.value.replace(/\D/g, "") })}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm font-mono focus:ring-2 focus:ring-[#E85B1E] outline-none" data-testid="debit-account-input" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Debit Account IFSC</label>
                  <input type="text" maxLength={11} value={company.debit_account_ifsc} onChange={e => setCompany({ ...company, debit_account_ifsc: e.target.value.toUpperCase() })}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm font-mono focus:ring-2 focus:ring-[#E85B1E] outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Debit Bank Name</label>
                  <input type="text" value={company.debit_bank_name} onChange={e => setCompany({ ...company, debit_bank_name: e.target.value })}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Default Transaction Type</label>
                  <select value={company.transaction_type} onChange={e => setCompany({ ...company, transaction_type: e.target.value })}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm bg-white focus:ring-2 focus:ring-[#E85B1E] outline-none">
                    <option value="NFT">NFT (NEFT)</option>
                    <option value="RTG">RTG (RTGS)</option>
                    <option value="IFC">IFC (IMPS)</option>
                    <option value="WIB">WIB (Within Bank)</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="flex gap-3 justify-end">
              <button type="button" onClick={() => setCompany(companyOriginal)} className="px-4 py-2.5 border-2 border-slate-300 text-slate-600 rounded-lg text-sm font-medium">Reset</button>
              <button type="submit" disabled={savingCompany} className="px-6 py-2.5 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold disabled:opacity-60" data-testid="save-company-btn">
                {savingCompany ? "Saving..." : "Save Settings"}
              </button>
            </div>
          </form>
        </div>
      )}

      {activeTab === "attendance" && (
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6 space-y-5" data-testid="attendance-settings">
          <div>
            <h3 className="font-bold text-[#1E2A47] text-lg" style={{ fontFamily: "'Outfit', sans-serif" }}>Face Match Verification</h3>
            <p className="text-slate-500 text-sm">When employees punch in / out, their selfie is compared against the passport-size photo on file.</p>
          </div>

          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
            <p className="text-sm text-amber-900">
              <strong>Important:</strong> If an employee has no <em>passport_photo</em> uploaded under Employees → Documents, they cannot punch in until HR uploads one.
            </p>
          </div>

          <div className="border border-slate-200 rounded-lg p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-[#0F172A]">Strict mode</p>
                <p className="text-xs text-slate-500 mt-0.5">
                  {faceMatchStrict
                    ? "ON — punches are blocked if the face does not match the passport photo."
                    : "OFF — punches are allowed even if face mismatch, but flagged for HR review."}
                </p>
              </div>
              <button onClick={() => saveFaceMatch(!faceMatchStrict)} disabled={savingFaceMatch}
                data-testid="toggle-face-match-strict"
                className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${faceMatchStrict ? "bg-[#E85B1E]" : "bg-slate-300"}`}>
                <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${faceMatchStrict ? "translate-x-6" : "translate-x-1"}`} />
              </button>
            </div>
          </div>

          <p className="text-xs text-slate-500">
            Match threshold: <strong>0.40</strong> (balanced). Powered by face_recognition (dlib).
          </p>
        </div>
      )}

      {activeTab === "leaves" && (
        <div className="space-y-6 max-w-2xl">
          {/* Half-year credit card */}
          <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
            <h3 className="text-base font-bold text-[#1E2A47] mb-1" style={{ fontFamily: "'Outfit', sans-serif" }}>Half-Year Leave Credit</h3>
            <p className="text-sm text-slate-500 mb-4">
              As per policy, SL and CL are credited twice a year on the financial calendar:
            </p>
            <div className="grid grid-cols-2 gap-3 mb-5">
              {[
                { label: "H1 Credit", date: "1st April", detail: "+7 SL, +3 CL", color: "bg-green-50 border-green-200 text-green-700" },
                { label: "H2 Credit", date: "1st October", detail: "+7 SL, +3 CL", color: "bg-blue-50 border-blue-200 text-blue-700" },
              ].map(h => (
                <div key={h.label} className={`rounded-xl border p-4 ${h.color}`}>
                  <p className="text-xs font-bold uppercase tracking-wider mb-1">{h.label}</p>
                  <p className="text-sm font-semibold">{h.date}</p>
                  <p className="text-xs mt-0.5 opacity-80">{h.detail} per employee</p>
                </div>
              ))}
            </div>
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-xs text-amber-700 mb-5">
              <strong>Note:</strong> This credits leaves for all active &amp; probation employees for the current half-year period.
              If a credit has already been applied this half-year, those employees will be skipped automatically.
            </div>
            <button
              onClick={creditHalfYear}
              disabled={crediting}
              data-testid="credit-halfyear-btn"
              className="px-5 py-2.5 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold hover:bg-[#D04A15] disabled:opacity-60 transition-colors"
            >
              {crediting ? "Processing..." : "Credit Half-Year Leaves Now"}
            </button>
            {creditResult && (
              <div className={`mt-4 rounded-lg px-4 py-3 text-sm ${creditResult.success ? "bg-green-50 border border-green-200 text-green-700" : "bg-red-50 border border-red-200 text-red-700"}`}
                data-testid="credit-result">
                {creditResult.success
                  ? <><strong>Done!</strong> {creditResult.message} — {creditResult.credited} employees credited, {creditResult.skipped_already_credited} already credited this half.</>
                  : creditResult.message
                }
              </div>
            )}
          </div>

          {/* Monthly EL credit card */}
          <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
            <h3 className="text-base font-bold text-[#1E2A47] mb-1" style={{ fontFamily: "'Outfit', sans-serif" }}>Monthly EL Credit</h3>
            <p className="text-sm text-slate-500 mb-4">
              Earned Leave accrues at <strong>1 day per month</strong> for employees who have completed 6 months of service.
              Run this on the <strong>1st of every month.</strong>
            </p>
            <div className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 text-xs text-slate-600 mb-5 space-y-1">
              <p><span className="font-semibold text-green-700">Eligible:</span> Employees with 6+ months of service, not yet credited this month.</p>
              <p><span className="font-semibold text-slate-500">Skipped:</span> Employees with &lt;6 months service or already credited this month.</p>
            </div>
            <button onClick={creditMonthlyEL} disabled={elCrediting} data-testid="credit-monthly-el-btn"
              className="px-5 py-2.5 bg-[#1E2A47] text-white rounded-lg text-sm font-semibold hover:bg-[#2a3a5c] disabled:opacity-60 transition-colors">
              {elCrediting ? "Processing..." : "Credit 1 EL for This Month"}
            </button>
            {elCreditResult && (
              <div className={`mt-4 rounded-lg px-4 py-3 text-sm ${elCreditResult.success ? "bg-green-50 border border-green-200 text-green-700" : "bg-red-50 border border-red-200 text-red-700"}`}
                data-testid="el-credit-result">
                {elCreditResult.success
                  ? <><strong>Done!</strong> {elCreditResult.message} — {elCreditResult.credited} credited, {elCreditResult.skipped_not_eligible} not yet eligible, {elCreditResult.skipped_already_credited} already credited this month.</>
                  : elCreditResult.message}
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === "users" && (
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full" data-testid="users-table">
              <thead><tr className="bg-slate-50 border-b">
                {["Name", "Username", "Role", "Emp ID", "Status", "Action"].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {users.map(u => (
                  <tr key={u._id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-3 text-sm font-medium text-[#0F172A]">{u.name}</td>
                    <td className="px-4 py-3 text-sm font-mono text-slate-700">{u.username || "-"}</td>
                    <td className="px-4 py-3"><span className="px-2 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-medium">{u.role}</span></td>
                    <td className="px-4 py-3 text-xs font-mono text-[#E85B1E]">{u.employee_id || "-"}</td>
                    <td className="px-4 py-3"><span className={`px-2 py-1 rounded-full text-xs font-medium ${u.is_active ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>{u.is_active ? "Active" : "Inactive"}</span></td>
                    <td className="px-4 py-3">
                      {u.username !== user?.username && (
                        <button onClick={() => toggleUser(u._id)} className={`text-xs px-2 py-1 rounded-lg ${u.is_active ? "bg-red-100 text-red-700 hover:bg-red-200" : "bg-green-100 text-green-700 hover:bg-green-200"}`}>
                          {u.is_active ? "Deactivate" : "Activate"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showAdd && (
        <Modal title={editLoc ? "Edit Location" : "Add Location"} onClose={() => { setShowAdd(false); setEditLoc(null); }}>
          <form onSubmit={handleSaveLocation} className="space-y-4">
            {[["name", "Location Name", "text", true], ["address", "Address", "text", true]].map(([key, label, type, req]) => (
              <div key={key}>
                <label className="block text-xs font-semibold text-slate-700 mb-1">{label}{req && "*"}</label>
                <input type={type} value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })} required={req}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
              </div>
            ))}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Latitude*</label>
                <input type="number" step="any" value={form.latitude} onChange={e => setForm({ ...form, latitude: e.target.value })} required
                  className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Longitude*</label>
                <input type="number" step="any" value={form.longitude} onChange={e => setForm({ ...form, longitude: e.target.value })} required
                  className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Geofence Radius (meters)</label>
                <input type="number" value={form.radius_meters} onChange={e => setForm({ ...form, radius_meters: e.target.value })} min={5} max={500}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Type</label>
                <select value={form.location_type} onChange={e => setForm({ ...form, location_type: e.target.value })}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none bg-white">
                  <option value="head_office">Head Office</option>
                  <option value="branch">Branch</option>
                  <option value="field">Field</option>
                </select>
              </div>
            </div>
            <div className="flex gap-3">
              <button type="button" onClick={() => { setShowAdd(false); setEditLoc(null); }} className="flex-1 px-4 py-2.5 border-2 border-slate-300 text-slate-600 rounded-lg text-sm font-medium">Cancel</button>
              <button type="submit" disabled={saving} data-testid="save-location-btn" className="flex-1 px-4 py-2.5 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold disabled:opacity-60">{saving ? "Saving..." : "Save Location"}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
