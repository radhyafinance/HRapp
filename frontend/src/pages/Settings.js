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

  const fetchData = async () => {
    setLoading(true);
    try {
      const [locRes, userRes] = await Promise.all([
        API.get("/locations"),
        API.get("/auth/users"),
      ]);
      setLocations(locRes.data);
      setUsers(userRes.data);
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

  const TYPE_BADGE = { head_office: "bg-[#1E2A47] text-white", branch: "bg-blue-100 text-blue-700", field: "bg-green-100 text-green-700" };

  return (
    <div style={{ fontFamily: "'Work Sans', sans-serif" }}>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>Settings</h1>
        <p className="text-slate-500 text-sm">Manage locations, users and system settings</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6 border-b border-slate-200">
        {[["locations", "Office Locations"], ["users", "User Management"]].map(([val, label]) => (
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

      {activeTab === "users" && (
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full" data-testid="users-table">
              <thead><tr className="bg-slate-50 border-b">
                {["Name", "Email", "Role", "Emp ID", "Status", "Action"].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {users.map(u => (
                  <tr key={u._id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-3 text-sm font-medium text-[#0F172A]">{u.name}</td>
                    <td className="px-4 py-3 text-sm text-slate-500">{u.email}</td>
                    <td className="px-4 py-3"><span className="px-2 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-medium">{u.role}</span></td>
                    <td className="px-4 py-3 text-xs font-mono text-[#E85B1E]">{u.employee_id || "-"}</td>
                    <td className="px-4 py-3"><span className={`px-2 py-1 rounded-full text-xs font-medium ${u.is_active ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>{u.is_active ? "Active" : "Inactive"}</span></td>
                    <td className="px-4 py-3">
                      {u.email !== user?.email && (
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
