import React, { useEffect, useState } from "react";
import API from "../utils/api";
import { useAuth } from "../contexts/AuthContext";
import { MapPin, Activity, Clock, AlertCircle, ArrowLeft, RefreshCw, Battery, Smartphone, Search } from "lucide-react";
import RouteMap from "../components/RouteMap";
import { toLocalDateStr } from "../utils/shiftRules";

const FRESHNESS_STYLES = {
  live:    { label: "Live",    dot: "bg-green-500",    bg: "bg-green-50",    text: "text-green-700",  border: "border-green-200" },
  recent:  { label: "Recent",  dot: "bg-emerald-400",  bg: "bg-emerald-50",  text: "text-emerald-700",border: "border-emerald-200" },
  stale:   { label: "Stale",   dot: "bg-amber-500",    bg: "bg-amber-50",    text: "text-amber-700",  border: "border-amber-200" },
  silent:  { label: "Silent",  dot: "bg-red-500",      bg: "bg-red-50",      text: "text-red-700",    border: "border-red-200" },
  never:   { label: "Never",   dot: "bg-slate-400",    bg: "bg-slate-50",    text: "text-slate-600",  border: "border-slate-200" },
};

function minsAgoLabel(m) {
  if (m == null) return "Never";
  if (m < 1) return "Just now";
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.floor(m / 60)} h ago`;
  return `${Math.floor(m / 1440)} d ago`;
}

export default function FieldTracking() {
  const { user } = useAuth();
  const [tab, setTab] = useState("live");          // live | devices | history
  const [activeStaff, setActiveStaff] = useState([]);
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);   // { employee_id, name, ... }
  const [trackData, setTrackData] = useState(null);
  const [trackLoading, setTrackLoading] = useState(false);
  const [date, setDate] = useState(toLocalDateStr());
  const [devFilter, setDevFilter] = useState("");

  // Distance report + odometer management
  const [distDate, setDistDate] = useState(toLocalDateStr());
  const [distData, setDistData] = useState(null);
  const [distLoading, setDistLoading] = useState(false);
  const [odoList, setOdoList] = useState([]);
  const [odoSearch, setOdoSearch] = useState("");
  const [odoLoading, setOdoLoading] = useState(false);

  // History mode
  const [histEmpSearch, setHistEmpSearch] = useState("");
  const [histDate, setHistDate] = useState(toLocalDateStr());
  const [histEmployees, setHistEmployees] = useState([]);
  const [histSelected, setHistSelected] = useState(null);
  const [histTrack, setHistTrack] = useState(null);
  const [histLoading, setHistLoading] = useState(false);

  const isManager = ["hr_admin", "management", "managers"].includes(user?.role);

  const fetchActive = async () => {
    setLoading(true);
    try {
      const res = await API.get("/attendance/field-staff/active");
      setActiveStaff(res.data);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  const fetchDevices = async () => {
    setLoading(true);
    try {
      const res = await API.get("/tracker/devices");
      setDevices(res.data);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  const fetchEmployees = async () => {
    try {
      const res = await API.get("/employees?status=all");
      setHistEmployees(res.data);
    } catch (e) { console.error(e); }
  };

  const fetchDistance = async (d) => {
    setDistLoading(true);
    try { const res = await API.get("/tracker/distance", { params: { date_str: d } }); setDistData(res.data); }
    catch (e) { console.error(e); } finally { setDistLoading(false); }
  };

  const fetchOdoList = async () => {
    setOdoLoading(true);
    try { const res = await API.get("/tracker/odometer/employees"); setOdoList(res.data); }
    catch (e) { console.error(e); } finally { setOdoLoading(false); }
  };

  const toggleOdo = async (id) => {
    try {
      const res = await API.post(`/tracker/odometer/toggle/${id}`);
      setOdoList(list => list.map(x => x.employee_id === id
        ? { ...x, odometer_required: res.data.odometer_required } : x));
    } catch (e) { console.error(e); }
  };

  const exportDistance = async () => {
    const to = distDate;
    const from = new Date(new Date(distDate).getTime() - 29 * 86400000).toISOString().slice(0, 10);
    try {
      const res = await API.get("/tracker/distance/export",
        { params: { from_date: from, to_date: to }, responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url; a.download = `distance_${from}_to_${to}.xlsx`; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { console.error(e); }
  };

  const fetchTrack = async (empId, d) => {
    setTrackLoading(true);
    try {
      const res = await API.get(`/attendance/location-track/${empId}`, { params: { date_str: d } });
      setTrackData(res.data);
    } catch (e) { console.error(e); }
    finally { setTrackLoading(false); }
  };

  const fetchHistTrack = async (empId, d) => {
    setHistLoading(true);
    try {
      const res = await API.get(`/attendance/location-track/${empId}`, { params: { date_str: d } });
      setHistTrack(res.data);
    } catch (e) { console.error(e); }
    finally { setHistLoading(false); }
  };

  useEffect(() => { if (!isManager) return;
    if (tab === "live") fetchActive();
    else if (tab === "devices") fetchDevices();
    else if (tab === "history" && histEmployees.length === 0) fetchEmployees();
    else if (tab === "distance") fetchDistance(distDate);
    else if (tab === "odometer") fetchOdoList();
  }, [isManager, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isManager && tab === "distance") fetchDistance(distDate);
  }, [distDate]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh every 30s on live / devices tab when not drilled in
  useEffect(() => {
    if (!isManager || selected) return;
    const t = setInterval(() => {
      if (tab === "live") fetchActive();
      else if (tab === "devices") fetchDevices();
    }, 30000);
    return () => clearInterval(t);
  }, [isManager, selected, tab]);

  useEffect(() => {
    if (selected) fetchTrack(selected.employee_id, date);
  }, [selected, date]);

  useEffect(() => {
    if (histSelected) fetchHistTrack(histSelected.employee_id, histDate);
  }, [histSelected, histDate]);

  if (!isManager) {
    return (
      <div style={{ fontFamily: "'Work Sans', sans-serif" }} className="text-center py-12">
        <p className="text-slate-500">Access restricted to managers and HR</p>
      </div>
    );
  }

  const stops = trackData?.stops || [];
  const locations = trackData?.locations || [];
  const histStops = histTrack?.stops || [];
  const histLocations = histTrack?.locations || [];

  const filteredDevices = devices.filter(d => {
    if (!devFilter) return true;
    const q = devFilter.toLowerCase();
    return d.employee_id.toLowerCase().includes(q)
        || (d.name || "").toLowerCase().includes(q)
        || (d.designation || "").toLowerCase().includes(q)
        || d.freshness === devFilter;
  });

  const filteredEmployees = histEmployees.filter(e => {
    if (!histEmpSearch) return true;
    const q = histEmpSearch.toLowerCase();
    return e.employee_id.toLowerCase().includes(q)
        || `${e.first_name || ""} ${e.last_name || ""}`.toLowerCase().includes(q);
  }).slice(0, 12);

  return (
    <div style={{ fontFamily: "'Work Sans', sans-serif" }}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>
            Field Tracking
          </h1>
          <p className="text-slate-500 text-sm">Live GPS routes with stops &gt; 15 minutes</p>
        </div>
      </div>

      {/* Tabs */}
      {!selected && !histSelected && (
        <div className="flex gap-1 mb-4 border-b border-slate-200">
          {[
            ["live", `Active Today (${activeStaff.length})`],
            ["devices", `Tracker Devices (${devices.length})`],
            ["distance", "Distance"],
            ["odometer", "Odometer"],
            ["history", "History"],
          ].map(([val, label]) => (
            <button key={val} onClick={() => setTab(val)} data-testid={`ft-tab-${val}`}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${tab === val ? "border-[#E85B1E] text-[#E85B1E]" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
              {label}
            </button>
          ))}
        </div>
      )}

      {/* TAB: Distance travelled */}
      {!selected && !histSelected && tab === "distance" && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm flex flex-wrap gap-3 items-center">
            <input type="date" value={distDate} onChange={e => setDistDate(e.target.value)}
              className="border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none"
              data-testid="distance-date" />
            {distData && (
              <span className="text-sm text-slate-600">
                Team total (GPS): <strong className="text-[#1E2A47]">{distData.total_gps_km} km</strong>
              </span>
            )}
            <button onClick={exportDistance} data-testid="distance-export"
              className="ml-auto flex items-center gap-1.5 px-3 py-2 bg-[#12855a] text-white rounded-lg text-xs font-semibold hover:bg-[#0f6f4c]">
              Export 30 days (Excel)
            </button>
          </div>
          <p className="text-xs text-slate-400 -mt-2 px-1">GPS distance is a filtered straight-line estimate from 3-min pings. Odometer km (for tracked staff) is the reimbursement figure.</p>
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead><tr className="bg-slate-50 border-b">
                  {["Employee", "GPS km (est.)", "Odometer km", "Odometer status"].map(h =>
                    <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>)}
                </tr></thead>
                <tbody>
                  {distLoading ? <tr><td colSpan={4} className="px-4 py-8 text-center text-slate-400">Loading...</td></tr>
                  : !distData || distData.rows.length === 0 ? <tr><td colSpan={4} className="px-4 py-12 text-center text-slate-400">No distance data for this date.</td></tr>
                  : distData.rows.map(r => {
                    const st = r.odo_status === "complete" ? ["Complete", "bg-green-100 text-green-700"]
                      : r.odo_status === "missing" ? ["Missing", "bg-red-100 text-red-700"]
                      : ["—", "bg-slate-100 text-slate-400"];
                    return (
                      <tr key={r.employee_id} className="border-b border-slate-100 hover:bg-slate-50">
                        <td className="px-4 py-3">
                          <p className="text-sm font-medium text-[#0F172A]">{r.name}</p>
                          <p className="text-xs text-[#E85B1E] font-mono">{r.employee_id}</p>
                        </td>
                        <td className="px-4 py-3 text-sm font-semibold text-[#1E2A47]">{r.gps_km} km</td>
                        <td className="px-4 py-3 text-sm text-slate-700">
                          {r.odo_km != null ? <strong>{r.odo_km} km</strong>
                            : r.odometer_required ? <span className="text-slate-400">—</span>
                            : <span className="text-slate-300">not tracked</span>}
                          {r.odo_start_km != null && r.odo_end_km != null &&
                            <span className="block text-[11px] text-slate-400">{r.odo_start_km} → {r.odo_end_km}</span>}
                        </td>
                        <td className="px-4 py-3">
                          {r.odometer_required
                            ? <span className={`px-2 py-1 rounded-full text-xs font-medium ${st[1]}`}>{st[0]}</span>
                            : <span className="text-xs text-slate-300">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB: Odometer tracking management */}
      {!selected && !histSelected && tab === "odometer" && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={odoSearch} onChange={e => setOdoSearch(e.target.value)}
                placeholder="Search employees to enable odometer tracking..."
                className="w-full border border-slate-300 rounded-lg pl-9 pr-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none"
                data-testid="odo-search" />
            </div>
            <p className="text-xs text-slate-400 mt-2">Enabled staff must photograph their odometer at start &amp; end of day. Missing readings are flagged here and to the employee.</p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead><tr className="bg-slate-50 border-b">
                  {["Employee", "Designation", "Odometer tracking"].map(h =>
                    <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>)}
                </tr></thead>
                <tbody>
                  {odoLoading ? <tr><td colSpan={3} className="px-4 py-8 text-center text-slate-400">Loading...</td></tr>
                  : odoList.filter(e => {
                      if (!odoSearch) return true;
                      const q = odoSearch.toLowerCase();
                      return e.employee_id.toLowerCase().includes(q) || (e.name || "").toLowerCase().includes(q);
                    }).map(e => (
                    <tr key={e.employee_id} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <p className="text-sm font-medium text-[#0F172A]">{e.name}</p>
                        <p className="text-xs text-[#E85B1E] font-mono">{e.employee_id}</p>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-600">{e.designation || "-"}</td>
                      <td className="px-4 py-3">
                        <button onClick={() => toggleOdo(e.employee_id)} data-testid={`odo-toggle-${e.employee_id}`}
                          className={`relative w-11 h-6 rounded-full transition-colors ${e.odometer_required ? "bg-[#12855a]" : "bg-slate-300"}`}>
                          <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${e.odometer_required ? "translate-x-5" : ""}`} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 1: Live — Active Today */}
      {!selected && !histSelected && tab === "live" && (
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between">
            <h3 className="font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>Punched In Today</h3>
            <button onClick={fetchActive} data-testid="refresh-active-btn"
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1E2A47] text-white rounded-lg text-xs font-semibold hover:bg-[#2A3A5E]">
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full" data-testid="active-staff-table">
              <thead><tr className="bg-slate-50 border-b">
                {["Employee", "Designation", "Punch In", "Status", "Points", "Last Seen", ""].map(h =>
                  <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>)}
              </tr></thead>
              <tbody>
                {loading ? <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">Loading...</td></tr>
                : activeStaff.length === 0 ? <tr><td colSpan={7} className="px-4 py-12 text-center text-slate-400">No active staff today. Check the <strong>Tracker Devices</strong> tab to diagnose.</td></tr>
                : activeStaff.map(s => (
                  <tr key={s.employee_id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-[#0F172A]">{s.name}</p>
                      <p className="text-xs text-[#E85B1E] font-mono">{s.employee_id}</p>
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-600">{s.designation || "-"}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{s.punch_in_time ? new Date(s.punch_in_time).toLocaleTimeString("en-IN", { hour:"2-digit", minute:"2-digit" }) : "-"}</td>
                    <td className="px-4 py-3"><span className={`px-2 py-1 rounded-full text-xs font-medium ${s.punch_out_time ? "bg-blue-100 text-blue-700" : "bg-green-100 text-green-700"}`}>{s.punch_out_time ? "Punched Out" : "Active"}</span></td>
                    <td className="px-4 py-3 text-sm font-semibold text-[#1E2A47]">{s.location_points}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">{s.last_seen ? new Date(s.last_seen).toLocaleTimeString("en-IN", { hour:"2-digit", minute:"2-digit" }) : "-"}</td>
                    <td className="px-4 py-3">
                      <button onClick={() => setSelected(s)} data-testid={`view-track-${s.employee_id}`}
                        className="text-xs px-3 py-1.5 bg-[#E85B1E] text-white rounded-lg hover:bg-[#D04A15] flex items-center gap-1">
                        <MapPin size={12} /> Route
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 2: Tracker Devices — all configured, with freshness */}
      {!selected && !histSelected && tab === "devices" && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm flex flex-wrap gap-2 items-center">
            <div className="relative flex-1 min-w-[240px]">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={devFilter} onChange={e => setDevFilter(e.target.value)}
                placeholder="Filter by ID, name, or freshness (live/stale/silent)..."
                className="w-full border border-slate-300 rounded-lg pl-9 pr-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none"
                data-testid="device-filter-input" />
            </div>
            {["live","recent","stale","silent","never"].map(k => (
              <button key={k} onClick={() => setDevFilter(devFilter === k ? "" : k)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${devFilter === k ? FRESHNESS_STYLES[k].bg + " " + FRESHNESS_STYLES[k].text + " " + FRESHNESS_STYLES[k].border : "bg-white border-slate-200 text-slate-500"}`}
                data-testid={`filter-chip-${k}`}>
                <span className={`w-2 h-2 rounded-full ${FRESHNESS_STYLES[k].dot}`} />
                {FRESHNESS_STYLES[k].label} ({devices.filter(d => d.freshness === k).length})
              </button>
            ))}
            <button onClick={fetchDevices} data-testid="refresh-devices-btn"
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1E2A47] text-white rounded-lg text-xs font-semibold hover:bg-[#2A3A5E]">
              <RefreshCw size={12} /> Refresh
            </button>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full" data-testid="devices-table">
                <thead><tr className="bg-slate-50 border-b">
                  {["Status", "Employee", "Role", "Last Ping", "Battery", "Interval", ""].map(h =>
                    <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>)}
                </tr></thead>
                <tbody>
                  {loading ? <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">Loading...</td></tr>
                  : filteredDevices.length === 0 ? <tr><td colSpan={7} className="px-4 py-12 text-center text-slate-400">No tracker devices yet. A device is created automatically when a field employee logs into the Radhya HR app and punches in.</td></tr>
                  : filteredDevices.map(d => {
                    const style = FRESHNESS_STYLES[d.freshness] || FRESHNESS_STYLES.never;
                    return (
                      <tr key={d.employee_id} className="border-b border-slate-100 hover:bg-slate-50" data-testid={`device-row-${d.employee_id}`}>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium ${style.bg} ${style.text} ${style.border} border`}>
                            <span className={`w-2 h-2 rounded-full ${style.dot} ${d.freshness === "live" ? "animate-pulse" : ""}`} />
                            {style.label}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-sm font-medium text-[#0F172A]">{d.name}</p>
                          <p className="text-xs text-[#E85B1E] font-mono">{d.employee_id}</p>
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-600">{d.designation || "-"}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            <Clock size={12} className="text-slate-400" />
                            <span className="text-sm text-slate-700">{minsAgoLabel(d.minutes_ago)}</span>
                          </div>
                          {d.last_ping_at && (
                            <p className="text-[11px] text-slate-400">{new Date(d.last_ping_at).toLocaleString("en-IN", { dateStyle:"short", timeStyle:"short" })}</p>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {d.last_battery != null ? (
                            <div className="flex items-center gap-1.5">
                              <Battery size={12} className={d.last_battery > 30 ? "text-green-600" : d.last_battery > 15 ? "text-amber-500" : "text-red-600"} />
                              <span className="text-sm font-semibold text-slate-700">{Math.round(d.last_battery)}%</span>
                            </div>
                          ) : <span className="text-xs text-slate-400">—</span>}
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-500">{d.interval_seconds}s</td>
                        <td className="px-4 py-3">
                          <button
                            onClick={() => { setHistDate(toLocalDateStr()); setHistSelected({ employee_id: d.employee_id, name: d.name, designation: d.designation }); setTab("history"); }}
                            data-testid={`device-route-${d.employee_id}`}
                            disabled={d.freshness === "never"}
                            className="text-xs px-3 py-1.5 bg-[#E85B1E] text-white rounded-lg hover:bg-[#D04A15] disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1">
                            <MapPin size={12} /> Route
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs text-blue-700">
            <strong>Freshness key:</strong> Live ≤ 5 min · Recent ≤ 30 min · Stale ≤ 24 h · Silent &gt; 24 h · Never = never pinged.
            Silent / Never devices are likely off or mis-configured on the employee's phone.
          </div>
        </div>
      )}

      {/* TAB 3: History — search any employee, any date */}
      {!selected && !histSelected && tab === "history" && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
            <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input value={histEmpSearch} onChange={e => setHistEmpSearch(e.target.value)}
                  placeholder="Search employee by ID or name..."
                  className="w-full border border-slate-300 rounded-lg pl-9 pr-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none"
                  data-testid="hist-emp-search" />
              </div>
              <input type="date" value={histDate} onChange={e => setHistDate(e.target.value)}
                max={toLocalDateStr()}
                className="border border-slate-300 rounded-lg px-3 py-2.5 text-sm bg-white"
                data-testid="hist-date-input" />
            </div>

            {histEmpSearch && (
              <div className="mt-3 max-h-60 overflow-y-auto divide-y divide-slate-100 border border-slate-100 rounded-lg" data-testid="hist-emp-results">
                {filteredEmployees.length === 0 ? (
                  <p className="p-3 text-xs text-slate-400">No employees match.</p>
                ) : filteredEmployees.map(e => (
                  <button key={e.employee_id}
                    onClick={() => { setHistSelected({ employee_id: e.employee_id, name: `${e.first_name||""} ${e.last_name||""}`.trim(), designation: e.designation }); }}
                    data-testid={`hist-pick-${e.employee_id}`}
                    className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-slate-50">
                    <div>
                      <p className="text-sm font-medium text-slate-700">{e.first_name} {e.last_name}</p>
                      <p className="text-xs text-slate-500">{e.designation || "—"} · {e.department || "—"}</p>
                    </div>
                    <span className="text-xs font-mono text-[#E85B1E]">{e.employee_id}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-800">
            <AlertCircle size={13} className="inline mr-1" />
            View any employee's route on any past date from their app GPS pings. No attendance record required.
          </div>
        </div>
      )}

      {/* Drill-down view: shared between Live and History */}
      {(selected || histSelected) && (
        <>
          <div className="flex items-center justify-between mb-4">
            <button onClick={() => { setSelected(null); setHistSelected(null); setTrackData(null); setHistTrack(null); }}
              data-testid="back-to-list-btn"
              className="flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-[#1E2A47]">
              <ArrowLeft size={16} /> Back
            </button>
            <div className="flex items-center gap-2">
              <input type="date"
                value={selected ? date : histDate}
                onChange={e => selected ? setDate(e.target.value) : setHistDate(e.target.value)}
                max={toLocalDateStr()}
                className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white"
                data-testid="track-date-input" />
              <button onClick={() => selected ? fetchTrack(selected.employee_id, date) : fetchHistTrack(histSelected.employee_id, histDate)}
                className="p-2 rounded-lg bg-slate-100 hover:bg-slate-200" data-testid="refresh-track-btn">
                <RefreshCw size={14} />
              </button>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm mb-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
              <div>
                <p className="font-bold text-[#1E2A47] text-lg">{(selected || histSelected).name}</p>
                <p className="text-xs text-slate-500">{(selected || histSelected).designation || "—"} · <span className="font-mono text-[#E85B1E]">{(selected || histSelected).employee_id}</span></p>
              </div>
              <div className="grid grid-cols-3 gap-3 text-center text-xs">
                <div className="px-3 py-2 bg-slate-50 rounded-lg">
                  <p className="text-lg font-bold text-[#1E2A47]">{(selected ? locations : histLocations).length}</p>
                  <p className="text-slate-500">Points</p>
                </div>
                <div className="px-3 py-2 bg-slate-50 rounded-lg">
                  <p className="text-lg font-bold text-[#E85B1E]">{(selected ? stops : histStops).length}</p>
                  <p className="text-slate-500">Stops &gt; 15m</p>
                </div>
                <div className="px-3 py-2 bg-slate-50 rounded-lg">
                  <p className="text-sm font-bold text-green-700">
                    {(selected ? trackData : histTrack)?.attendance?.punch_in_time ? new Date((selected ? trackData : histTrack).attendance.punch_in_time).toLocaleTimeString("en-IN", { hour:"2-digit", minute:"2-digit" }) : "—"}
                  </p>
                  <p className="text-slate-500">Punch In</p>
                </div>
              </div>
            </div>

            {(selected ? trackLoading : histLoading) ? (
              <div className="text-center py-12 text-slate-400">Loading map...</div>
            ) : (selected ? locations : histLocations).length === 0 ? (
              <div className="text-center py-12">
                <AlertCircle size={32} className="mx-auto text-slate-300 mb-2" />
                <p className="text-sm text-slate-500">No location data captured for this day</p>
                <p className="text-xs text-slate-400">Tracker may have been off or the employee didn't punch in.</p>
              </div>
            ) : (
              <RouteMap
                locations={selected ? locations : histLocations}
                stops={selected ? stops : histStops}
                attendance={(selected ? trackData : histTrack)?.attendance}
              />
            )}
          </div>

          {(selected ? stops : histStops).length > 0 && (
            <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100 bg-amber-50/50">
                <h3 className="font-bold text-[#1E2A47] flex items-center gap-2" style={{ fontFamily: "'Outfit', sans-serif" }}>
                  <Clock size={16} className="text-[#E85B1E]" /> Stops longer than 15 minutes
                </h3>
              </div>
              <table className="w-full" data-testid="stops-table">
                <thead><tr className="bg-slate-50 border-b">
                  {["#", "Start Time", "End Time", "Duration", "Coordinates"].map(h =>
                    <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>)}
                </tr></thead>
                <tbody>
                  {(selected ? stops : histStops).map((s, i) => (
                    <tr key={`stop-${s.latitude}-${s.longitude}-${i}`} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="px-4 py-3 text-sm font-medium text-[#1E2A47]">{i + 1}</td>
                      <td className="px-4 py-3 text-sm text-slate-600">{new Date(s.start).toLocaleTimeString("en-IN")}</td>
                      <td className="px-4 py-3 text-sm text-slate-600">{new Date(s.end).toLocaleTimeString("en-IN")}</td>
                      <td className="px-4 py-3 text-sm font-semibold text-[#E85B1E]">{s.duration_minutes} min</td>
                      <td className="px-4 py-3 text-xs font-mono text-slate-500">
                        {s.latitude.toFixed(5)}, {s.longitude.toFixed(5)}{" "}
                        <a href={`https://www.google.com/maps?q=${s.latitude},${s.longitude}`}
                          target="_blank" rel="noopener noreferrer"
                          className="ml-2 text-[#E85B1E] hover:underline">Open in Maps</a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
