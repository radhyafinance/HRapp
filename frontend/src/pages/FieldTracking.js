import React, { useEffect, useState } from "react";
import API from "../utils/api";
import { useAuth } from "../contexts/AuthContext";
import { MapPin, Activity, Clock, AlertCircle, ArrowLeft, RefreshCw, Battery, Smartphone, Search } from "lucide-react";
import RouteMap from "../components/RouteMap";
import { toLocalDateStr } from "../utils/shiftRules";
// Location-permission chip. A SEPARATE axis from freshness — see the note below
// the table. Reported by the v1.4.0+ app; older apps / PWA show "—".
// Why the server thinks a day's odometer readings need a person to look. Derived
// server-side from the two readings, so it is present whether or not the phone
// was online when the employee submitted.
const ODO_REVIEW_LABELS = {
  below_start: "End reading is lower than the start reading",
  implausible: "More than 500 km in one day",
};
const PERMISSION_STYLES = {
  always: { label: "Allowed always", cls: "bg-green-50 text-green-700 border-green-200" },
  in_use: { label: "Foreground only", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  denied: { label: "Denied", cls: "bg-red-50 text-red-700 border-red-200" },
  prompt: { label: "Not asked yet", cls: "bg-slate-100 text-slate-600 border-slate-200" },
};
function permissionCell(d) {
  const st = PERMISSION_STYLES[d.location_permission];
  if (st) {
    return { label: st.label, cls: st.cls,
      sub: d.location_permission_at
        ? `as of ${new Date(d.location_permission_at).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" })}`
        : null };
  }
  // No permission reported. Say why, so "—" is never a mystery.
  if (d.last_platform === "app")
    return { label: "Update the app", cls: "bg-slate-100 text-slate-500 border-slate-200",
             sub: "app too old to report" };
  if (d.last_platform === "pwa")
    return { label: "On web (PWA)", cls: "bg-slate-100 text-slate-500 border-slate-200",
             sub: "install the app to track" };
  return { label: "—", cls: "bg-slate-50 text-slate-400 border-slate-200", sub: null };
}
/**
 * How old is this phone's self-report?
 *
 * The Blockers column is a SNAPSHOT taken when the app last ran, not a live
 * reading, and it used to be rendered with no age at all. A test phone died at
 * 08:00 and the tab kept showing a confident green "None" for over an hour —
 * the one column meant to explain a silent device was the column lying about it.
 * Returns minutes, or null if the phone has never reported.
 */
function healthAgeMin(d) {
  // Server-computed. Diffing health_at against the viewer's own clock made an
  // HR laptop running slow produce a negative age, clamp to "just now", and
  // show a green all-clear for a day-old reading on a dead phone.
  // `== null` FIRST. The backend always emits this key, as JSON null for a
  // phone that has never reported — and Number(null) is 0, which Number.isFinite
  // accepts. Coercing first turned "never reported" into "checked just now" and
  // put a confident green "None" on every 1.4.0 phone and PWA user: the exact
  // false all-clear this column exists to prevent.
  if (d.health_age_min == null) return null;
  const n = Number(d.health_age_min);
  return Number.isFinite(n) ? n : null;
}
/**
 * Beyond this, a clean reading is too old to be worth believing.
 *
 * Note the cadence this is judged against: health is reported on login and on
 * app-resume (throttled), while a tracking phone pings every few minutes. So a
 * reading being older than the last ping is the NORMAL, healthy case — an
 * earlier version treated that as staleness and consequently showed
 * "Not checked recently" for every device that was working, and a green "None"
 * mostly for devices that were not. Age alone is the honest test.
 */
const HEALTH_FRESH_MIN = 90;
function healthIsStale(d) {
  const age = healthAgeMin(d);
  if (age === null) return false;
  if (age > HEALTH_FRESH_MIN) return true;
  // A reading taken BEFORE the device went quiet cannot vouch for the present.
  // Scoped to devices that are actually quiet: on a live device a health
  // reading older than the last ping is the normal case (pings are minutes
  // apart, health is reported on app-resume), and testing it unconditionally
  // marked every working phone "Not checked recently".
  if ((d.freshness === "stale" || d.freshness === "silent")
      && d.last_ping_at && d.health_at) {
    return new Date(d.health_at).getTime() < new Date(d.last_ping_at).getTime();
  }
  return false;
}
/** A phone-measured age, carried forward to now. The phone reported "the alarm
 *  fired N minutes ago" when it last checked in; without adding the age of that
 *  check-in, an alarm that died this morning still reads as firing 2 min ago. */
function carriedAge(d, mins) {
  if (mins == null || !Number.isFinite(Number(mins))) return null;
  return Number(mins) + (healthAgeMin(d) || 0);
}
const HEALTH_TONES = {
  bad: "bg-red-50 text-red-700 border-red-200",
  warn: "bg-amber-50 text-amber-700 border-amber-200",
  unknown: "bg-slate-100 text-slate-500 border-slate-200",
};
/**
 * What the phone's backstop said about its own last pass (v1.6.0+), in words HR
 * can act on. Exists because "the worker ran and no fix arrived" covered a
 * denied permission, a GPS timeout and a failed upload — three different
 * repairs that were indistinguishable from the server, and that ambiguity cost
 * a full round of diagnosis on RMF0022 and RMF0060.
 */
const WORKER_OUTCOMES = {
  healthy: "not needed — the main tracker was delivering",
  fixed: "took its own position successfully",
  fixed_last_known: "sent the phone's last known position (couldn't get a fresh one)",
  post_failed: "got a position but couldn't upload it — it is buffered on the phone",
  no_location: "the phone returned no position at all",
  stale_last_known: "only had a position over an hour old, so sent nothing",
  no_permission: "location permission was refused",
  inactive: "the employee is punched out",
  error: "failed unexpectedly",
};
/**
 * Concrete, fixable reasons a device goes quiet while its permission column
 * looks perfectly healthy. Reported by the v1.5.0+ app.
 *
 * This column exists because "Allowed always" plus 90% battery was all HR could
 * see, and that is exactly what a phone shows when the maker's cleaner has been
 * killing the tracker all morning — so every stale device looked like a mystery
 * or a network problem. Each chip names the setting that fixes it.
 *
 * Strict === comparisons throughout: undefined means the app never reported the
 * field (any build before v1.5.0), which must not be shown as either good or bad.
 */
function healthIssues(d) {
  const out = [];
  if (d.battery_optimised === true)
    out.push({ label: "Battery optimised", tone: "bad", fix: "Phone Settings → Apps → Radhya HR → Battery → Unrestricted" });
  // Only a fault on the builds where the alarm actually carried the tracking.
  // From v1.6.0 a standing GPS subscription does that and the alarm is a spare
  // heartbeat — flagging it there would put a red chip on a healthy phone, and
  // the whole point of this column is that its chips are worth acting on.
  if (d.exact_alarms === false && d.fix_age_min == null)
    out.push({ label: "Alarms restricted", tone: "bad", fix: "Phone Settings → Apps → Radhya HR → Alarms & reminders → Allow" });
  // What the backstop actually hit. These are the two outcomes that need a
  // human: everything else either resolves itself or is already covered by
  // another chip. Both come from v1.6.0+; older builds report nothing here.
  if (d.worker_outcome === "no_permission")
    out.push({ label: "Location permission gone", tone: "bad",
               fix: "The tracker asked for a position and was refused. Phone Settings → Apps → Radhya HR → Permissions → Location → Allow all the time" });
  if (d.worker_outcome === "no_location")
    out.push({ label: "GPS returning nothing", tone: "warn",
               fix: "The tracker ran but the phone gave it no position at all — usually GPS/Location switched off in the quick settings, or the employee is deep inside a building. Check the location toggle first." });
  // These two were originally left to the hover text on the grounds that they
  // "resolve themselves". They do not, and a tooltip does not exist on a touch
  // screen — so a phone that had explicitly reported a fault rendered the green
  // "None" badge, which is the one thing this column must never do.
  if (d.worker_outcome === "stale_last_known")
    out.push({ label: "Only an old position available", tone: "warn",
               fix: "The tracker could not get a fresh fix and the phone's last known position was over an hour old, so nothing was sent. Usually means GPS has been off or the phone has been indoors for a long stretch." });
  if (d.worker_outcome === "error")
    out.push({ label: "Backstop failed", tone: "bad",
               fix: "The recovery job hit an unexpected error. If this persists on one phone, reinstall the app on it." });
  // Scoped to devices that are ALREADY quiet. On a phone that is reporting
  // normally this flips every time the employee walks into a building, and a
  // chip that appears in every doorway trains people to ignore the column.
  if (d.location_unavailable === true
      && (d.freshness === "stale" || d.freshness === "silent" || d.freshness === "never"))
    out.push({ label: "Phone can't get a GPS fix", tone: "warn",
               fix: "The phone itself reports that location is currently unavailable — check that Location/GPS is switched on in the quick settings, not just that the app has permission." });
  if (d.service_dead === true)
    out.push({ label: "Service killed", tone: "bad", fix: "Enable Autostart for Radhya HR and lock it in the recents screen" });
  // Amber, not red: buffering is the phone working correctly through a coverage
  // gap, and it clears itself. It earns a chip only so a catching-up device is
  // not mistaken for a broken one.
  if (d.queued_pings > 0)
    out.push({ label: `${d.queued_pings} buffered`, tone: "warn",
               fix: "Fixes taken with no coverage, held on the phone. They upload by themselves once it has a connection — no action needed." });
  return out;
}
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
  const [tab, setTab] = useState("live");
  const [activeStaff, setActiveStaff] = useState([]);
  const [liveBranch, setLiveBranch] = useState("");
  const [liveSearch, setLiveSearch] = useState("");
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [trackData, setTrackData] = useState(null);
  const [trackLoading, setTrackLoading] = useState(false);
  const [date, setDate] = useState(toLocalDateStr());
  const [devFilter, setDevFilter] = useState("");
  const [devBranch, setDevBranch] = useState("");
  const [wdog, setWdog] = useState(null);
  const [distDate, setDistDate] = useState(toLocalDateStr());
  const [distData, setDistData] = useState(null);
  const [distLoading, setDistLoading] = useState(false);
  const [odoList, setOdoList] = useState([]);
  const [odoSearch, setOdoSearch] = useState("");
  const [odoLoading, setOdoLoading] = useState(false);
  const [odoView, setOdoView] = useState(null);
  const [adoption, setAdoption] = useState(null);
  const [adoptionLoading, setAdoptionLoading] = useState(false);
  const [adoptionFilter, setAdoptionFilter] = useState("");
  const [histEmpSearch, setHistEmpSearch] = useState("");
  const [histDate, setHistDate] = useState(toLocalDateStr());
  const [histEmployees, setHistEmployees] = useState([]);
  const [histSelected, setHistSelected] = useState(null);
  const [histTrack, setHistTrack] = useState(null);
  const [histLoading, setHistLoading] = useState(false);
  // Access comes from the server, not from the role alone: a Risk & Credit
  // manager can be granted read-only tracking without being made an admin.
  // Until it answers, fall back to the role so admins see no flicker.
  const roleIsManager = ["hr_admin", "management", "managers"].includes(user?.role);
  const roleIsAdmin = ["hr_admin", "management"].includes(user?.role);
  const [access, setAccess] = useState(null);
  useEffect(() => {
    API.get("/tracker/my-access")
      .then(r => setAccess(r.data))
      .catch(() => setAccess({ can_view: roleIsManager, can_admin: roleIsAdmin, via: "role" }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const isManager = access ? access.can_view : roleIsManager;
  const canAdmin = access ? access.can_admin : roleIsAdmin;
  // Odometer photos are evidence of a field visit — the point of a granted
  // viewer. Managers have never had them and are not being widened here.
  const canViewOdoPhotos = canAdmin || access?.via === "grant";
  // Branch list is derived from who is actually punched in today, not the full
  // branch master — a filter offering branches with nobody in them is noise.
  const liveBranches = [...new Set(activeStaff.map(s => s.branch).filter(Boolean))].sort();

  const liveRows = activeStaff.filter(s => {
    if (liveBranch && s.branch !== liveBranch) return false;
    const q = liveSearch.trim().toLowerCase();
    if (!q) return true;
    return (s.name || "").toLowerCase().includes(q) ||
           (s.employee_id || "").toLowerCase().includes(q);
  });

  const fetchActive = async () => {
    setLoading(true);
    try { const res = await API.get("/attendance/field-staff/active"); setActiveStaff(res.data); }
    catch (e) { console.error(e); } finally { setLoading(false); }
  };
  const fetchDevices = async () => {
    setLoading(true);
    // Fetched alongside the devices list, and deliberately never allowed to
    // break it: this is diagnostics about the thing, not the thing.
    API.get("/tracker/watchdog-status").then(r => setWdog(r.data)).catch(() => setWdog(null));
    try { const res = await API.get("/tracker/devices"); setDevices(res.data); }
    catch (e) { console.error(e); } finally { setLoading(false); }
  };
  const fetchEmployees = async () => {
    // Tracked staff, not the employee directory. This used /employees?status=all,
    // which scopes managers to their own reporting line and ignores the tracking
    // grant entirely — so a granted viewer searching History found one person.
    // Widening that endpoint would have handed over the whole staff directory
    // for a permission that was only ever about tracking.
    try { const res = await API.get("/tracker/trackable-employees"); setHistEmployees(res.data); }
    catch (e) { console.error(e); }
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
      setOdoList(list => list.map(x => x.employee_id === id ? { ...x, odometer_required: res.data.odometer_required } : x));
    } catch (e) { console.error(e); }
  };
  // Switching this ON locks the employee out of the Android app until they set
  // location to "Allow all the time", so it asks first — every other toggle on
  // this page is harmless and reversible from the employee's side; this one
  // isn't. Switching OFF is the undo and needs no confirmation.
  const toggleFieldStaff = async (e) => {
    if (!e.field_staff && !window.confirm(
      `Mark ${e.name} (${e.employee_id}) as field staff?\n\n` +
      `On the Android app they will not be able to use Radhya HR — including punching in — ` +
      `until they set location access to "Allow all the time".\n\n` +
      `Nothing changes for them on desktop or iPhone.`
    )) return;
    try {
      const res = await API.post(`/tracker/field-staff/toggle/${e.employee_id}`);
      setOdoList(list => list.map(x => x.employee_id === e.employee_id ? { ...x, field_staff: res.data.field_staff } : x));
    } catch (err) { console.error(err); }
  };
  // Granting this shows one person the location history of every tracked
  // employee, including people outside their reporting line — so it confirms,
  // and the server records who granted it. Revoking needs no confirmation.
  const toggleTrackingViewer = async (e) => {
    if (!e.tracking_viewer && !window.confirm(
      `Give ${e.name} (${e.employee_id}) read-only tracking access?\n\n` +
      `They will be able to see live location, route history, distance reports ` +
      `and odometer photos for EVERY tracked employee — not just their own team.\n\n` +
      `They will not be able to change any tracking setting, disable a device, ` +
      `or see payroll, salaries or exits.`
    )) return;
    try {
      const res = await API.post(`/tracker/tracking-viewer/toggle/${e.employee_id}`);
      setOdoList(list => list.map(x => x.employee_id === e.employee_id
        ? { ...x, tracking_viewer: res.data.tracking_viewer } : x));
    } catch (err) { console.error(err); }
  };
  const exportDistance = async () => {
    const d = new Date(distDate + "T00:00:00");
    const pad = (n) => String(n).padStart(2, "0");
    const from = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const to = `${last.getFullYear()}-${pad(last.getMonth() + 1)}-${pad(last.getDate())}`;
    try {
      const res = await API.get("/tracker/distance/export", { params: { from_date: from, to_date: to }, responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url; a.download = `distance_${from}_to_${to}.xlsx`; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { console.error(e); }
  };
  const fetchAdoption = async () => {
    setAdoptionLoading(true);
    try { const res = await API.get("/tracker/adoption"); setAdoption(res.data); }
    catch (e) { console.error(e); } finally { setAdoptionLoading(false); }
  };
  const openOdoPhotos = async (employee_id, name) => {
    setOdoView({ employee_id, name, date: distDate, loading: true, data: null });
    try {
      const res = await API.get(`/tracker/odometer/day/${employee_id}`, { params: { date_str: distDate } });
      setOdoView(v => (v && v.employee_id === employee_id) ? { ...v, loading: false, data: res.data } : v);
    } catch (e) { setOdoView(v => v ? { ...v, loading: false, data: null } : v); }
  };
  const fetchTrack = async (empId, d) => {
    setTrackLoading(true);
    try { const res = await API.get(`/attendance/location-track/${empId}`, { params: { date_str: d } }); setTrackData(res.data); }
    catch (e) { console.error(e); } finally { setTrackLoading(false); }
  };
  const fetchHistTrack = async (empId, d) => {
    setHistLoading(true);
    try { const res = await API.get(`/attendance/location-track/${empId}`, { params: { date_str: d } }); setHistTrack(res.data); }
    catch (e) { console.error(e); } finally { setHistLoading(false); }
  };
  // If access resolves to non-admin while an admin-only tab is open, fall back
  // rather than firing a request that can only 403.
  useEffect(() => {
    if (!canAdmin && (tab === "odometer" || tab === "adoption")) setTab("live");
  }, [canAdmin, tab]);
  useEffect(() => {
    if (!isManager) return;
    if (tab === "odometer" || tab === "adoption") { if (!canAdmin) return; }
    if (tab === "live") fetchActive();
    else if (tab === "devices") fetchDevices();
    else if (tab === "history" && histEmployees.length === 0) fetchEmployees();
    else if (tab === "distance") fetchDistance(distDate);
    else if (tab === "odometer") fetchOdoList();
    else if (tab === "adoption") fetchAdoption();
  }, [isManager, tab]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (isManager && tab === "distance") fetchDistance(distDate);
  }, [distDate]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!isManager || selected) return;
    const t = setInterval(() => {
      if (tab === "live") fetchActive();
      else if (tab === "devices") fetchDevices();
    }, 30000);
    return () => clearInterval(t);
  }, [isManager, selected, tab]);
  useEffect(() => { if (selected) fetchTrack(selected.employee_id, date); }, [selected, date]);
  useEffect(() => { if (histSelected) fetchHistTrack(histSelected.employee_id, histDate); }, [histSelected, histDate]);
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
  // Derived from the devices actually returned, not the branch master — a
  // branch with nobody tracked in it is noise in the dropdown.
  const deviceBranches = [...new Set(devices.map(d => d.branch).filter(Boolean))].sort();
  // Branch narrows first, and the freshness chip counts are taken from HERE, so
  // "Stale (4)" always means four rows in the table below rather than four
  // somewhere in the company.
  const branchDevices = devBranch ? devices.filter(d => d.branch === devBranch) : devices;
  const filteredDevices = branchDevices.filter(d => {
    if (!devFilter) return true;
    const q = devFilter.toLowerCase();
    return d.employee_id.toLowerCase().includes(q) || (d.name || "").toLowerCase().includes(q) || (d.designation || "").toLowerCase().includes(q) || d.freshness === devFilter;
  });
  const filteredEmployees = histEmployees.filter(e => {
    if (!histEmpSearch) return true;
    const q = histEmpSearch.toLowerCase();
    return e.employee_id.toLowerCase().includes(q) || `${e.first_name || ""} ${e.last_name || ""}`.toLowerCase().includes(q);
  }).slice(0, 12);
  return (
    <div style={{ fontFamily: "'Work Sans', sans-serif" }}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>Field Tracking</h1>
          <p className="text-slate-500 text-sm">Live GPS routes with stops &gt; 15 minutes</p>
        </div>
      </div>
      {/* Odometer photo viewer */}
      {odoView && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setOdoView(null)}>
          <div className="bg-white rounded-xl max-w-lg w-full max-h-[90vh] overflow-y-auto p-5" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>Odometer — {odoView.name} · {odoView.date}</h3>
              <button onClick={() => setOdoView(null)} className="text-slate-400 hover:text-slate-600 text-lg">✕</button>
            </div>
            {odoView.loading ? <p className="text-center text-slate-400 py-8">Loading…</p>
              : !odoView.data ? <p className="text-center text-slate-400 py-8">No data.</p>
              : (
                <div className="space-y-4">
                  {["start", "end"].map(k => {
                    const rd = odoView.data[k];
                    return (
                      <div key={k} className="border border-slate-200 rounded-lg p-3">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm font-semibold text-[#1E2A47]">{k === "start" ? "Start" : "End"} of day</span>
                          <span className="text-sm font-bold text-[#1E2A47]">{rd?.reading_km != null ? `${Number(rd.reading_km).toLocaleString("en-IN")} km` : "—"}</span>
                        </div>
                        {/* Keyed on the server's own comparison, not on the phone
                            saying it warned someone. The app's check needs a GET that
                            fails silently on bad coverage — which is where most of
                            these readings are taken — so trusting the phone would drop
                            the flag on exactly the readings most likely to be wrong. */}
                        {k === "end" && odoView.data.review && (
                          <p className="text-[11px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mb-2">
                            {ODO_REVIEW_LABELS[odoView.data.review]} — check this photo against the start reading.
                            {rd?.override_warning
                              ? " The employee was warned and submitted it anyway."
                              : " The employee was not warned (the app could not reach the server)."}
                          </p>
                        )}
                        {rd?.photo ? <img src={`data:image/jpeg;base64,${rd.photo}`} alt={`${k} odometer`} className="w-full max-h-[45vh] object-contain bg-slate-50 rounded-lg border border-slate-100" />
                          : <p className="text-xs text-slate-400">No photo submitted.</p>}
                        {rd?.created_at && <p className="text-[11px] text-slate-400 mt-1">{new Date(rd.created_at).toLocaleString("en-IN")}</p>}
                      </div>
                    );
                  })}
                  <div className="text-center text-sm text-slate-600">
                    Distance: <strong className="text-[#12855a]">{odoView.data.distance_km != null ? `${odoView.data.distance_km} km` : "—"}</strong>
                  </div>
                </div>
              )}
          </div>
        </div>
      )}
      {/* Tabs */}
      {!selected && !histSelected && (
        <div className="flex gap-1 mb-4 border-b border-slate-200 overflow-x-auto">
          {[
            ["live", `Active Today (${activeStaff.length})`],
            ["devices", `Tracker Devices (${devices.length})`],
            ["distance", "Distance"],
            // Both of these are backed by admin-only endpoints. Showing them to
            // anyone else renders a tab that can only ever 403 — which is what
            // the `managers` role got until now.
            ...(canAdmin ? [["odometer", "Field staff"], ["adoption", "App adoption"]] : []),
            ["history", "History"],
          ].map(([val, label]) => (
            <button key={val} onClick={() => setTab(val)} data-testid={`ft-tab-${val}`}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${tab === val ? "border-[#E85B1E] text-[#E85B1E]" : "border-transparent text-slate-500 hover:text-slate-700"}`}>
              {label}
            </button>
          ))}
        </div>
      )}
      {/* TAB: Distance */}
      {!selected && !histSelected && tab === "distance" && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm flex flex-wrap gap-3 items-center">
            <input type="date" value={distDate} onChange={e => setDistDate(e.target.value)}
              className="border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" data-testid="distance-date" />
            {distData && <span className="text-sm text-slate-600">Team total (GPS): <strong className="text-[#1E2A47]">{distData.total_gps_km} km</strong></span>}
            <button onClick={exportDistance} data-testid="distance-export"
              className="ml-auto flex items-center gap-1.5 px-3 py-2 bg-[#12855a] text-white rounded-lg text-xs font-semibold hover:bg-[#0f6f4c]">
              Export month (Excel)
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
                    // "Check" is deliberately its own status rather than a mark on
                    // top of Complete. Complete is the one HR scrolls past, and a
                    // day whose readings do not add up contributes nothing to the
                    // reimbursement total — it is the row that most needs opening.
                    const st = r.odo_status === "review" ? ["Check", "bg-amber-100 text-amber-800"]
                      : r.odo_status === "complete" ? ["Complete", "bg-green-100 text-green-700"]
                      : r.odo_status === "missing" ? ["Missing", "bg-red-100 text-red-700"]
                      : ["—", "bg-slate-100 text-slate-400"];
                    return (
                      <tr key={r.employee_id} className="border-b border-slate-100 hover:bg-slate-50">
                        <td className="px-4 py-3"><p className="text-sm font-medium text-[#0F172A]">{r.name}</p><p className="text-xs text-[#E85B1E] font-mono">{r.employee_id}</p></td>
                        <td className="px-4 py-3 text-sm font-semibold text-[#1E2A47]">{r.gps_km} km</td>
                        <td className="px-4 py-3 text-sm text-slate-700">
                          {r.odo_km != null ? <strong>{r.odo_km} km</strong> : r.odometer_required ? <span className="text-slate-400">—</span> : <span className="text-slate-300">not tracked</span>}
                          {r.odo_start_km != null && r.odo_end_km != null && <span className="block text-[11px] text-slate-400">{r.odo_start_km} → {r.odo_end_km}</span>}
                        </td>
                        <td className="px-4 py-3">
                          {r.odometer_required ? (
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className={`px-2 py-1 rounded-full text-xs font-medium ${st[1]}`}>{st[0]}</span>
                              {/* Spelled out, not a tooltip. HR opens this on a laptop
                                  but reads it on a phone often enough, and a hover
                                  tooltip is a finding nobody on a touch screen sees. */}
                              {r.odo_review && (
                                <span className="w-full text-[11px] text-amber-700">{ODO_REVIEW_LABELS[r.odo_review]}</span>
                              )}
                              {canViewOdoPhotos && (r.odo_start_km != null || r.odo_end_km != null) && (
                                <button onClick={() => openOdoPhotos(r.employee_id, r.name)} className="text-xs text-[#E85B1E] font-medium hover:underline">Photos</button>
                              )}
                            </div>
                          ) : <span className="text-xs text-slate-300">—</span>}
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
      {/* TAB: Field staff — the per-person opt-in flags */}
      {!selected && !histSelected && tab === "odometer" && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={odoSearch} onChange={e => setOdoSearch(e.target.value)}
                placeholder="Search employees..."
                className="w-full border border-slate-300 rounded-lg pl-9 pr-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" data-testid="odo-search" />
            </div>
            <p className="text-xs text-slate-400 mt-2">
              <strong className="text-slate-500">Field staff</strong> — switch on only for people who work in the field.
              On the Android app they must set location to &quot;Allow all the time&quot; before they can use Radhya HR at all;
              until they do, they see a screen explaining how. Everyone left off is untouched, and desktop and iPhone are never affected.
            </p>
            <p className="text-xs text-slate-400 mt-1">
              <strong className="text-slate-500">Odometer</strong> — enabled staff must photograph their odometer at start &amp; end of day.
              Missing readings are flagged here and to the employee.
            </p>
            <p className="text-xs text-slate-400 mt-1">
              <strong className="text-slate-500">Can view tracking</strong> — read-only access to live location, route
              history, distance and odometer photos for <em>every</em> tracked employee, for someone outside their
              reporting line (a risk or audit role). They get no toggles on this page and no payroll, salary or exit
              access. Switch it on for as few people as possible.
            </p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead><tr className="bg-slate-50 border-b">
                  {["Employee", "Designation", "Field staff", "Odometer tracking", "Can view tracking"].map(h =>
                    <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>)}
                </tr></thead>
                <tbody>
                  {odoLoading ? <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">Loading...</td></tr>
                  : odoList.filter(e => {
                      if (!odoSearch) return true;
                      const q = odoSearch.toLowerCase();
                      return e.employee_id.toLowerCase().includes(q) || (e.name || "").toLowerCase().includes(q);
                    }).map(e => (
                    <tr key={e.employee_id} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="px-4 py-3"><p className="text-sm font-medium text-[#0F172A]">{e.name}</p><p className="text-xs text-[#E85B1E] font-mono">{e.employee_id}</p></td>
                      <td className="px-4 py-3 text-sm text-slate-600">{e.designation || "-"}</td>
                      <td className="px-4 py-3">
                        <button onClick={() => toggleFieldStaff(e)} data-testid={`field-staff-toggle-${e.employee_id}`}
                          className={`relative w-11 h-6 rounded-full transition-colors ${e.field_staff ? "bg-[#E85B1E]" : "bg-slate-300"}`}>
                          <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${e.field_staff ? "translate-x-5" : ""}`} />
                        </button>
                        {e.field_staff && <span className="block text-[11px] text-slate-400 mt-1">location required</span>}
                      </td>
                      <td className="px-4 py-3">
                        <button onClick={() => toggleOdo(e.employee_id)} data-testid={`odo-toggle-${e.employee_id}`}
                          className={`relative w-11 h-6 rounded-full transition-colors ${e.odometer_required ? "bg-[#12855a]" : "bg-slate-300"}`}>
                          <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${e.odometer_required ? "translate-x-5" : ""}`} />
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <button onClick={() => toggleTrackingViewer(e)} data-testid={`tracking-viewer-toggle-${e.employee_id}`}
                          className={`relative w-11 h-6 rounded-full transition-colors ${e.tracking_viewer ? "bg-[#1E2A47]" : "bg-slate-300"}`}>
                          <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${e.tracking_viewer ? "translate-x-5" : ""}`} />
                        </button>
                        {e.tracking_viewer && (
                          <span className="block text-[11px] text-slate-400 mt-1" data-testid={`tracking-viewer-note-${e.employee_id}`}>
                            sees everyone{e.tracking_viewer_by ? ` · granted by ${e.tracking_viewer_by}` : ""}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      {/* TAB: App adoption */}
      {!selected && !histSelected && tab === "adoption" && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-3 items-center">
            {adoption && [
              ["On app", adoption.counts.app, "bg-emerald-50 text-emerald-700 border-emerald-200"],
              ["Still on PWA", adoption.counts.pwa, "bg-amber-50 text-amber-700 border-amber-200"],
              ["Never seen", adoption.counts.never, "bg-slate-50 text-slate-500 border-slate-200"],
            ].map(([label, n, cls]) => (
              <div key={label} className={`px-4 py-2.5 rounded-xl border ${cls}`}>
                <span className="text-xl font-bold">{n}</span>
                <span className="text-xs font-medium ml-2">{label}</span>
              </div>
            ))}
            <button onClick={fetchAdoption} className="ml-auto flex items-center gap-1.5 px-3 py-2 bg-[#1E2A47] text-white rounded-lg text-xs font-semibold hover:bg-[#2A3A5E]">
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={adoptionFilter} onChange={e => setAdoptionFilter(e.target.value)}
                placeholder="Search by name or ID..."
                className="w-full border border-slate-300 rounded-lg pl-9 pr-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" />
            </div>
            <p className="text-xs text-slate-400 mt-2">Data fills in as employees log in. The <strong>PWA</strong> rows are who still needs to install the app.</p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead><tr className="bg-slate-50 border-b">
                  {["Employee", "Now on", "Version", "OS", "Last seen", "Used app?"].map(h =>
                    <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>)}
                </tr></thead>
                <tbody>
                  {adoptionLoading ? <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">Loading...</td></tr>
                  : !adoption || adoption.rows.length === 0 ? <tr><td colSpan={6} className="px-4 py-12 text-center text-slate-400">No data yet.</td></tr>
                  : adoption.rows.filter(r => {
                      if (!adoptionFilter) return true;
                      const q = adoptionFilter.toLowerCase();
                      return r.employee_id.toLowerCase().includes(q) || (r.name || "").toLowerCase().includes(q);
                    }).map(r => {
                      const st = r.status === "app" ? ["App", "bg-emerald-100 text-emerald-700"]
                        : r.status === "pwa" ? ["PWA", "bg-amber-100 text-amber-700"]
                        : ["Never", "bg-slate-100 text-slate-500"];
                      return (
                        <tr key={r.employee_id} className="border-b border-slate-100 hover:bg-slate-50">
                          <td className="px-4 py-3"><p className="text-sm font-medium text-[#0F172A]">{r.name}</p><p className="text-xs text-[#E85B1E] font-mono">{r.employee_id}</p></td>
                          <td className="px-4 py-3"><span className={`px-2 py-1 rounded-full text-xs font-medium ${st[1]}`}>{st[0]}</span></td>
                          <td className="px-4 py-3 text-sm text-slate-600 font-mono">{r.version || "—"}</td>
                          <td className="px-4 py-3 text-sm text-slate-600 capitalize">{r.os || "-"}</td>
                          <td className="px-4 py-3 text-xs text-slate-500">{r.last_seen ? new Date(r.last_seen).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "-"}</td>
                          <td className="px-4 py-3">{r.ever_app ? <span className="text-emerald-600 text-sm">✓</span> : <span className="text-slate-300 text-sm">—</span>}</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      {/* TAB: Live — Active Today */}
      {!selected && !histSelected && tab === "live" && (
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between">
            <h3 className="font-bold text-[#1E2A47] whitespace-nowrap" style={{ fontFamily: "'Outfit', sans-serif" }}>
              Punched In Today
            </h3>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={liveSearch} onChange={e => setLiveSearch(e.target.value)}
                placeholder="Search name or ID…" data-testid="live-search"
                className="border border-slate-300 rounded-lg px-3 py-1.5 text-xs w-44 focus:ring-2 focus:ring-[#E85B1E] outline-none"
              />
              <select
                value={liveBranch} onChange={e => setLiveBranch(e.target.value)}
                data-testid="live-branch-filter"
                className="border border-slate-300 rounded-lg px-2 py-1.5 text-xs bg-white focus:ring-2 focus:ring-[#E85B1E] outline-none"
              >
                <option value="">All branches</option>
                {liveBranches.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
              <button onClick={fetchActive} data-testid="refresh-active-btn"
                className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1E2A47] text-white rounded-lg text-xs font-semibold hover:bg-[#2A3A5E]">
                <RefreshCw size={12} /> Refresh
              </button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full" data-testid="active-staff-table">
              <thead><tr className="bg-slate-50 border-b">
                {["Employee", "Punch In", "Status", "Distance", "Battery", "Last Seen", ""].map(h =>
                  <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>)}
              </tr></thead>
              <tbody>
                {loading ? <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">Loading...</td></tr>
                : activeStaff.length === 0 ? <tr><td colSpan={7} className="px-4 py-12 text-center text-slate-400">No active staff today. Check the <strong>Tracker Devices</strong> tab to diagnose.</td></tr>
                : liveRows.length === 0 ? <tr><td colSpan={7} className="px-4 py-12 text-center text-slate-400">No one matches that search or branch.</td></tr>
                : liveRows.map(s => (
                  <tr key={s.employee_id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-[#0F172A]">{s.name}</p>
                      <p className="text-xs text-[#E85B1E] font-mono">{s.employee_id}</p>
                      <p className="text-xs text-slate-500">{s.designation || "-"}{s.branch ? ` · ${s.branch}` : ""}</p>
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-600">{s.punch_in_time ? new Date(s.punch_in_time).toLocaleTimeString("en-IN", { hour:"2-digit", minute:"2-digit" }) : "-"}</td>
                    <td className="px-4 py-3"><span className={`px-2 py-1 rounded-full text-xs font-medium ${s.punch_out_time ? "bg-blue-100 text-blue-700" : "bg-green-100 text-green-700"}`}>{s.punch_out_time ? "Punched Out" : "Active"}</span></td>
                    <td className="px-4 py-3 text-sm font-semibold text-[#1E2A47]" data-testid={`distance-${s.employee_id}`}>
                      {s.distance_km_today != null ? `${s.distance_km_today} km` : "—"}
                    </td>
                    <td className="px-4 py-3" data-testid={`battery-${s.employee_id}`}>
                      {s.last_battery != null ? (
                        <span className="flex items-center gap-1">
                          <Battery size={12} className={s.last_battery > 30 ? "text-green-600" : s.last_battery > 15 ? "text-amber-500" : "text-red-600"} />
                          <span className="text-sm font-semibold text-slate-700">{Math.round(s.last_battery)}%</span>
                        </span>
                      ) : <span className="text-xs text-slate-400">—</span>}
                    </td>
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
      {/* TAB: Tracker Devices */}
      {!selected && !histSelected && tab === "devices" && (
        <div className="space-y-4">
          {/* Is the auto-recovery actually alive? Without this, a watchdog that
              died on a deploy and one that is working look identical from here —
              which is exactly how two rounds of diagnosis got lost. */}
          {wdog && (() => {
            const dead = !wdog.running;
            const noPush = !wdog.push?.usable;
            const bad = dead || noPush;
            return (
              <div data-testid="watchdog-status"
                   className={`rounded-xl p-3 text-xs border ${bad
                     ? "bg-red-50 border-red-200 text-red-800"
                     : "bg-green-50 border-green-200 text-green-800"}`}>
                <strong>Auto-recovery: {bad ? "NOT WORKING" : "running"}</strong>
                {" — "}
                {noPush
                  ? (wdog.push?.env_set
                      ? "push credentials are set but Firebase failed to start, so no phone can be woken."
                      : "push is not configured, so no phone can be woken.")
                  : dead
                    ? `the watchdog last ran ${minsAgoLabel(wdog.last_run_age_min)} and should run every ${wdog.interval_minutes} min — it has most likely died on a deploy and needs the backend restarted.`
                    : `last checked ${minsAgoLabel(wdog.last_run_age_min)}. Wakes a quiet phone after ${wdog.silent_after_min} min, notifies the employee after ${wdog.visible_after_min} min.`}
                {!bad && wdog.last_result && (
                  <span className="text-green-700">
                    {" "}Last pass: {wdog.last_result.checked ?? 0} watched,
                    {" "}{wdog.last_result.reporting ?? 0} reporting normally,
                    {" "}{wdog.last_result.silent ?? 0} woken,
                    {" "}{wdog.last_result.visible ?? 0} notified.
                    {wdog.last_result.skipped_not_field_staff
                      ? ` ${wdog.last_result.skipped_not_field_staff} skipped (not marked field staff).` : ""}
                  </span>
                )}
                {/* The counts that make "0 woken" readable. On their own the
                    numbers above are ambiguous: nothing sent can equally mean
                    "nothing needed sending" and "we gave up on four phones
                    hours ago", and those want opposite reactions from HR. */}
                {!bad && wdog.last_result
                  && (wdog.last_result.gave_up || wdog.last_result.no_push_token) ? (
                  <div className="mt-1.5 text-amber-800" data-testid="watchdog-unreached">
                    {wdog.last_result.no_push_token ? (
                      <div>
                        <strong>{wdog.last_result.no_push_token}</strong> quiet
                        {wdog.last_result.no_push_token === 1 ? " phone has" : " phones have"} no
                        push registration, so the watchdog cannot reach
                        {wdog.last_result.no_push_token === 1 ? " it" : " them"} at all —
                        {wdog.last_result.no_push_token === 1 ? " that phone needs" : " those phones need"} the
                        app opened once, and notification permission allowed.
                      </div>
                    ) : null}
                    {wdog.last_result.gave_up ? (
                      <div>
                        <strong>{wdog.last_result.gave_up}</strong> quiet for over 3 hours — no
                        longer being poked. Usually someone who finished and forgot to punch out;
                        if not, the phone needs looking at.
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })()}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm flex flex-wrap gap-2 items-center">
            <div className="relative flex-1 min-w-[240px]">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={devFilter} onChange={e => setDevFilter(e.target.value)}
                placeholder="Filter by ID, name, or freshness (live/stale/silent)..."
                className="w-full border border-slate-300 rounded-lg pl-9 pr-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" data-testid="device-filter-input" />
            </div>
            <select value={devBranch} onChange={e => setDevBranch(e.target.value)}
              data-testid="devices-branch-filter"
              className="border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none">
              <option value="">All branches</option>
              {deviceBranches.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
            {["live","recent","stale","silent","never"].map(k => (
              <button key={k} onClick={() => setDevFilter(devFilter === k ? "" : k)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${devFilter === k ? FRESHNESS_STYLES[k].bg + " " + FRESHNESS_STYLES[k].text + " " + FRESHNESS_STYLES[k].border : "bg-white border-slate-200 text-slate-500"}`}
                data-testid={`filter-chip-${k}`}>
                <span className={`w-2 h-2 rounded-full ${FRESHNESS_STYLES[k].dot}`} />
                {FRESHNESS_STYLES[k].label} ({branchDevices.filter(d => d.freshness === k).length})
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
                  {["Status", "Employee", "Branch", "Role", "Last Ping", "Battery", "Distance", "Location Access", "Blockers", ""].map(h =>
                    <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>)}
                </tr></thead>
                <tbody>
                  {loading ? <tr><td colSpan={10} className="px-4 py-8 text-center text-slate-400">Loading...</td></tr>
                  : filteredDevices.length === 0 ? <tr><td colSpan={10} className="px-4 py-12 text-center text-slate-400">No tracker devices yet.</td></tr>
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
                        <td className="px-4 py-3"><p className="text-sm font-medium text-[#0F172A]">{d.name}</p><p className="text-xs text-[#E85B1E] font-mono">{d.employee_id}</p></td>
                        <td className="px-4 py-3 text-sm text-slate-600" data-testid={`device-branch-${d.employee_id}`}>{d.branch || "-"}</td>
                        <td className="px-4 py-3 text-sm text-slate-600">{d.designation || "-"}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5"><Clock size={12} className="text-slate-400" /><span className="text-sm text-slate-700">{minsAgoLabel(d.minutes_ago)}</span></div>
                          {d.last_ping_at && <p className="text-[11px] text-slate-400">{new Date(d.last_ping_at).toLocaleString("en-IN", { dateStyle:"short", timeStyle:"short" })}</p>}
                        </td>
                        <td className="px-4 py-3">
                          {d.last_battery != null ? (
                            <div className="flex items-center gap-1.5">
                              <Battery size={12} className={d.last_battery > 30 ? "text-green-600" : d.last_battery > 15 ? "text-amber-500" : "text-red-600"} />
                              <span className="text-sm font-semibold text-slate-700">{Math.round(d.last_battery)}%</span>
                            </div>
                          ) : <span className="text-xs text-slate-400">—</span>}
                        </td>
                        <td className="px-4 py-3" data-testid={`device-distance-${d.employee_id}`}>
                          {d.distance_km_today != null
                            ? <span className="text-sm text-slate-700">{d.distance_km_today} km</span>
                            : <span className="text-xs text-slate-400">—</span>}
                        </td>
                        <td className="px-4 py-3">
                          {(() => { const p = permissionCell(d); return (
                            <>
                              <span className={`inline-flex items-center px-2 py-1 rounded-full text-[11px] font-medium border ${p.cls}`}
                                data-testid={`device-perm-${d.employee_id}`}>{p.label}</span>
                              {p.sub && <p className="text-[10px] text-slate-400 mt-0.5">{p.sub}</p>}
                            </>
                          ); })()}
                        </td>
                        <td className="px-4 py-3">
                          {(() => {
                            const issues = healthIssues(d);
                            const age = healthAgeMin(d);
                            const stale = healthIsStale(d);
                            const ageLabel = age === null ? null : `checked ${minsAgoLabel(age).replace("Just now", "just now")}`;
                            // Diagnostics behind a hover rather than more columns:
                            // "the alarm stopped 3 h ago but the worker ran 5 min
                            // ago" and "neither has run since lunch" need different
                            // fixes and look identical without this.
                            const detail = [
                              // v1.6.0+ reports fix_age_min: the standing GPS
                              // subscription's last delivery, which is the
                              // primary path on that build. The alarm line below
                              // is only a 15-min heartbeat there — measured as
                              // never firing at all on 4 of 5 phones — so it is
                              // labelled as secondary rather than shown next to
                              // the subscription as an equal signal.
                              carriedAge(d, d.fix_age_min) != null ? `GPS last delivered a fix ${minsAgoLabel(carriedAge(d, d.fix_age_min))}` : null,
                              carriedAge(d, d.alarm_age_min) != null
                                ? `${d.fix_age_min != null ? "Backup alarm" : "Alarm"} last fired ${minsAgoLabel(carriedAge(d, d.alarm_age_min))}`
                                : null,
                              carriedAge(d, d.worker_age_min) != null ? `Backstop last ran ${minsAgoLabel(carriedAge(d, d.worker_age_min))}` : null,
                              d.worker_outcome ? `Backstop result: ${WORKER_OUTCOMES[d.worker_outcome] || d.worker_outcome}` : null,
                              d.location_unavailable ? "The phone reported it cannot get a GPS fix right now (GPS off, or indoors)." : null,
                            ].filter(Boolean).join("\n");
                            if (issues.length) return (
                              <div className="space-y-1" data-testid={`device-health-${d.employee_id}`}>
                                {issues.map(i => (
                                  <span key={i.label} title={i.fix}
                                        className={`block w-fit px-2 py-1 rounded-full text-[11px] font-medium border cursor-help ${HEALTH_TONES[i.tone] || HEALTH_TONES.bad}`}>
                                    {i.label}
                                  </span>
                                ))}
                                {ageLabel && <p className="text-[10px] text-slate-400" title={detail}>{ageLabel}</p>}
                              </div>
                            );
                            // A clean reading is only worth showing if it is
                            // RECENT. Rendering a confident green "None" from an
                            // hour-old snapshot is what told HR a dead phone was
                            // fine — say "not checked recently" instead.
                            if (age !== null && stale) return (
                              <div data-testid={`device-health-${d.employee_id}`}>
                                <span title={detail || "The phone has not reported since it went quiet. Ask the employee to open the app."}
                                      className={`inline-flex px-2 py-1 rounded-full text-[11px] font-medium border cursor-help ${HEALTH_TONES.unknown}`}>
                                  Not checked recently
                                </span>
                                <p className="text-[10px] text-slate-400">{ageLabel}</p>
                              </div>
                            );
                            // Reported, clean and fresh: a real, useful answer —
                            // it rules out the phone and points at coverage.
                            if (age !== null) return (
                              <div data-testid={`device-health-${d.employee_id}`}>
                                <span title={detail}
                                      className="inline-flex px-2 py-1 rounded-full text-[11px] font-medium border bg-green-50 text-green-700 border-green-200">None</span>
                                <p className="text-[10px] text-slate-400">{ageLabel}</p>
                              </div>
                            );
                            return <span className="text-xs text-slate-400" data-testid={`device-health-${d.employee_id}`}>—</span>;
                          })()}
                        </td>
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
            <br /><strong>Location Access</strong> is a separate signal from freshness.
            <span className="font-medium"> Allowed always</span> is required — the tracker only runs with the screen locked when background location is on.
            A device can be <span className="font-medium">Allowed always</span> yet <span className="font-medium">Silent</span> (phone off, or the maker&apos;s battery saver killing the app),
            or <span className="font-medium">Denied</span> yet <span className="font-medium">Live</span> (app left open). Read the two columns together.
            <br /><strong>Blockers</strong> are phone settings that stop the tracker even when location access is correct — hover a chip for the exact setting to change.
            <span className="font-medium"> None</span> means the phone reported no blockers, so look at coverage or whether they punched out.
            <span className="font-medium"> Not checked recently</span> means the phone has not reported since it last opened the app, so treat any all-clear with suspicion.
            <span className="font-medium"> —</span> means the app is older than v1.5.0 and cannot report them yet.
          </div>
        </div>
      )}
      {/* TAB: History */}
      {!selected && !histSelected && tab === "history" && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
            <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input value={histEmpSearch} onChange={e => setHistEmpSearch(e.target.value)}
                  placeholder="Search employee by ID or name..."
                  className="w-full border border-slate-300 rounded-lg pl-9 pr-3 py-2.5 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none" data-testid="hist-emp-search" />
              </div>
              <input type="date" value={histDate} onChange={e => setHistDate(e.target.value)} max={toLocalDateStr()}
                className="border border-slate-300 rounded-lg px-3 py-2.5 text-sm bg-white" data-testid="hist-date-input" />
            </div>
            {histEmpSearch && (
              <div className="mt-3 max-h-60 overflow-y-auto divide-y divide-slate-100 border border-slate-100 rounded-lg" data-testid="hist-emp-results">
                {filteredEmployees.length === 0 ? (
                  <p className="p-3 text-xs text-slate-400">No employees match.</p>
                ) : filteredEmployees.map(e => (
                  <button key={e.employee_id}
                    onClick={() => setHistSelected({ employee_id: e.employee_id, name: `${e.first_name||""} ${e.last_name||""}`.trim(), designation: e.designation })}
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
            View any employee's route on any past date from their app GPS pings.
          </div>
        </div>
      )}
      {/* Drill-down: shared between Live and History */}
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
                max={toLocalDateStr()} className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white" data-testid="track-date-input" />
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
              <RouteMap locations={selected ? locations : histLocations} stops={selected ? stops : histStops} attendance={(selected ? trackData : histTrack)?.attendance} />
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
                        <a href={`https://www.google.com/maps?q=${s.latitude},${s.longitude}`} target="_blank" rel="noopener noreferrer" className="ml-2 text-[#E85B1E] hover:underline">Open in Maps</a>
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
