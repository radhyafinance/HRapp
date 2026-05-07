import React, { useEffect, useState } from "react";
import { Plus, Edit, Trash2, X, Clock, Users, Star, AlertCircle } from "lucide-react";
import API from "../utils/api";

const ROLE_LABELS = {
  hr_admin: "HR Admin",
  management: "Management",
  managers: "Managers",
  employee: "HO Staff",
  field_agent: "Field Staff",
};
// Roles that actually punch attendance — only these are pickable
const ATTENDANCE_ROLES = ["field_agent", "managers", "management", "employee"];

const INIT_FORM = {
  name: "",
  start_hour: 9,
  start_minute: 0,
  end_hour: 18,
  end_minute: 0,
  grace_minutes: 30,
  min_full_day_hours: 6.0,
  assigned_roles: [],
  is_default: false,
  is_active: true,
};

function fmtTime(h, m) {
  const hh = String(h).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  return `${hh}:${mm}`;
}

function durationLabel(s) {
  const start = s.start_hour * 60 + s.start_minute;
  let end = s.end_hour * 60 + s.end_minute;
  if (end <= start) end += 24 * 60; // wrap past midnight
  const mins = end - start;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function ShiftModal({ initial, onClose, onSaved, otherShifts = [] }) {
  const [form, setForm] = useState({ ...INIT_FORM, ...(initial || {}) });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  // For each role, compute which OTHER shift currently owns it (will be auto-released on save)
  const roleConflicts = {};
  for (const role of ATTENDANCE_ROLES) {
    if (form.assigned_roles.includes(role)) {
      const owner = otherShifts.find(s => s.id !== form.id && (s.assigned_roles || []).includes(role));
      if (owner) roleConflicts[role] = owner.name;
    }
  }

  const toggleRole = (r) => {
    setForm(f => ({
      ...f,
      assigned_roles: f.assigned_roles.includes(r)
        ? f.assigned_roles.filter(x => x !== r)
        : [...f.assigned_roles, r],
    }));
  };

  const save = async (e) => {
    e.preventDefault();
    setErr("");
    if (!form.name.trim()) { setErr("Name is required"); return; }
    const startM = form.start_hour * 60 + form.start_minute;
    const endM = form.end_hour * 60 + form.end_minute;
    if (startM === endM) { setErr("Start and end times cannot be the same"); return; }

    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        start_hour: parseInt(form.start_hour, 10),
        start_minute: parseInt(form.start_minute, 10),
        end_hour: parseInt(form.end_hour, 10),
        end_minute: parseInt(form.end_minute, 10),
        grace_minutes: parseInt(form.grace_minutes, 10),
        min_full_day_hours: parseFloat(form.min_full_day_hours),
        assigned_roles: form.assigned_roles,
        is_default: !!form.is_default,
        is_active: !!form.is_active,
      };
      if (form.id) {
        await API.put(`/shifts/${form.id}`, payload);
      } else {
        await API.post("/shifts", payload);
      }
      onSaved();
    } catch (ex) {
      setErr(ex.response?.data?.detail || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b sticky top-0 bg-white z-10">
          <h3 className="text-lg font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>
            {form.id ? "Edit Shift" : "New Shift"}
          </h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100"><X size={18} /></button>
        </div>
        <form onSubmit={save} className="p-5 space-y-4" data-testid="shift-form">
          {err && <div className="bg-red-50 border border-red-200 text-red-700 text-sm p-3 rounded-lg flex gap-2"><AlertCircle size={16}/> {err}</div>}

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Shift Name</label>
            <input value={form.name} onChange={e => setForm({...form, name: e.target.value})}
              placeholder="e.g. Field Shift, Morning Shift"
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none"
              data-testid="shift-name-input" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Start Time (IST)</label>
              <div className="flex gap-1.5">
                <input type="number" min="0" max="23" value={form.start_hour}
                  onChange={e => setForm({...form, start_hour: e.target.value})}
                  className="w-1/2 border border-slate-300 rounded-lg px-2 py-2 text-sm" data-testid="shift-start-hour" />
                <input type="number" min="0" max="59" value={form.start_minute}
                  onChange={e => setForm({...form, start_minute: e.target.value})}
                  className="w-1/2 border border-slate-300 rounded-lg px-2 py-2 text-sm" data-testid="shift-start-min" />
              </div>
              <p className="text-[10px] text-slate-400 mt-1">HH : MM (24-hour)</p>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">End Time (IST)</label>
              <div className="flex gap-1.5">
                <input type="number" min="0" max="23" value={form.end_hour}
                  onChange={e => setForm({...form, end_hour: e.target.value})}
                  className="w-1/2 border border-slate-300 rounded-lg px-2 py-2 text-sm" data-testid="shift-end-hour" />
                <input type="number" min="0" max="59" value={form.end_minute}
                  onChange={e => setForm({...form, end_minute: e.target.value})}
                  className="w-1/2 border border-slate-300 rounded-lg px-2 py-2 text-sm" data-testid="shift-end-min" />
              </div>
              <p className="text-[10px] text-slate-400 mt-1">HH : MM (24-hour)</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Grace Period (min)</label>
              <input type="number" min="0" max="240" value={form.grace_minutes}
                onChange={e => setForm({...form, grace_minutes: e.target.value})}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" data-testid="shift-grace" />
              <p className="text-[10px] text-slate-400 mt-1">Punch-in &gt; this minutes late → half day</p>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Min Hours for Full Day</label>
              <input type="number" min="0.5" max="12" step="0.5" value={form.min_full_day_hours}
                onChange={e => setForm({...form, min_full_day_hours: e.target.value})}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" data-testid="shift-min-hours" />
              <p className="text-[10px] text-slate-400 mt-1">Worked hours below this → half day</p>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-2">Default for these roles</label>
            <div className="grid grid-cols-2 gap-2">
              {ATTENDANCE_ROLES.map(r => {
                const checked = form.assigned_roles.includes(r);
                const conflict = roleConflicts[r];
                return (
                  <label key={r}
                    className={`flex items-start gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                      checked ? "border-[#E85B1E] bg-orange-50" : "border-slate-200 hover:bg-slate-50"
                    }`}>
                    <input type="checkbox" checked={checked} onChange={() => toggleRole(r)}
                      className="mt-0.5 accent-[#E85B1E]" data-testid={`shift-role-${r}`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-700">{ROLE_LABELS[r]}</p>
                      {conflict && (
                        <p className="text-[10px] text-amber-600 mt-0.5">
                          Currently in <span className="font-semibold">{conflict}</span> — will move here on save
                        </p>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
            <p className="text-[10px] text-slate-400 mt-2">A role can be on at most one shift. Selecting a role here will remove it from any other shift.</p>
          </div>

          <label className="flex items-start gap-2 px-3 py-2 rounded-lg border border-slate-200 cursor-pointer">
            <input type="checkbox" checked={form.is_default} onChange={e => setForm({...form, is_default: e.target.checked})}
              className="mt-0.5 accent-[#E85B1E]" data-testid="shift-is-default" />
            <div className="flex-1">
              <p className="text-sm font-medium text-slate-700 flex items-center gap-1.5">
                <Star size={13} className="text-amber-500" /> Mark as default shift
              </p>
              <p className="text-[10px] text-slate-400 mt-0.5">Used for any user whose role isn't covered by another shift.</p>
            </div>
          </label>

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="flex-1 px-4 py-2.5 border-2 border-slate-300 text-slate-600 rounded-lg text-sm font-semibold">Cancel</button>
            <button type="submit" disabled={saving} data-testid="shift-save-btn"
              className="flex-1 px-4 py-2.5 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold disabled:opacity-60">
              {saving ? "Saving..." : (form.id ? "Update" : "Create")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function ShiftsTab() {
  const [shifts, setShifts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // null | shift dict | "new"

  const fetch = async () => {
    setLoading(true);
    try {
      const res = await API.get("/shifts");
      setShifts(res.data || []);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetch(); }, []);

  const onDelete = async (s) => {
    if (!window.confirm(`Delete shift "${s.name}"? Employees on this shift will fall back to their role default.`)) return;
    try {
      await API.delete(`/shifts/${s.id}`);
      fetch();
    } catch (e) {
      alert(e.response?.data?.detail || "Delete failed");
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-slate-500">
          Define office hours, grace period, and minimum work-hours per shift. Assign each shift to one or more roles —
          a role can only be on a single shift at a time.
        </p>
        <button onClick={() => setEditing({})} data-testid="add-shift-btn"
          className="flex items-center gap-2 px-4 py-2 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold hover:bg-[#D04A15]">
          <Plus size={16} /> New Shift
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4" data-testid="shifts-grid">
        {loading ? (
          [...Array(2)].map((_, i) => <div key={i} className="h-48 bg-slate-100 animate-pulse rounded-xl" />)
        ) : shifts.length === 0 ? (
          <div className="col-span-full p-8 text-center text-slate-400 text-sm bg-white border border-dashed border-slate-300 rounded-xl">
            No shifts defined yet.
          </div>
        ) : (
          shifts.map(s => (
            <div key={s.id} className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm hover:-translate-y-0.5 transition-transform"
              data-testid={`shift-card-${s.id}`}>
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-[#E85B1E]/10 flex items-center justify-center flex-shrink-0">
                    <Clock size={18} className="text-[#E85B1E]" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-bold text-[#1E2A47] text-sm truncate flex items-center gap-1.5">
                      {s.name}
                      {s.is_default && (
                        <span title="Default shift" className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-semibold">
                          <Star size={10} className="mr-0.5" /> Default
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-slate-500">
                      {fmtTime(s.start_hour, s.start_minute)} – {fmtTime(s.end_hour, s.end_minute)} IST · {durationLabel(s)}
                    </p>
                  </div>
                </div>
                <div className="flex gap-1 flex-shrink-0">
                  <button onClick={() => setEditing(s)} data-testid={`shift-edit-${s.id}`}
                    className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400">
                    <Edit size={14} />
                  </button>
                  <button onClick={() => onDelete(s)} data-testid={`shift-del-${s.id}`}
                    className="p-1.5 rounded-lg hover:bg-red-50 text-red-400">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs text-slate-500 mb-3">
                <div>
                  Grace: <span className="font-semibold text-slate-700">{s.grace_minutes} min</span>
                </div>
                <div>
                  Min hrs: <span className="font-semibold text-slate-700">{s.min_full_day_hours}h</span>
                </div>
              </div>

              <div className="flex items-start gap-1.5 text-xs">
                <Users size={12} className="text-slate-400 mt-0.5 flex-shrink-0" />
                {(s.assigned_roles || []).length === 0 ? (
                  <span className="text-slate-400 italic">No roles assigned</span>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {s.assigned_roles.map(r => (
                      <span key={r} className="inline-flex items-center px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 font-medium text-[11px]">
                        {ROLE_LABELS[r] || r}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {editing && (
        <ShiftModal
          initial={editing.id ? editing : null}
          otherShifts={shifts}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); fetch(); }}
        />
      )}
    </div>
  );
}
