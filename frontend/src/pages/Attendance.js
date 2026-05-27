import React, { useEffect, useState, useRef } from "react";
import API from "../utils/api";
import { Camera, MapPin, CheckCircle, AlertCircle, Clock, LogIn, LogOut, RefreshCw, Edit3, Plus, FileEdit, Search, Filter, Download, CalendarDays } from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import { AdminRegulariseModal, EmployeeRegulariseRequestModal, PendingRequestsPanel, MyRequestsList } from "../components/attendance/Regularisation";
import { FaceMismatchBadge, FaceMismatchModal } from "../components/attendance/FaceMismatch";
import { AttendanceStatusBadge } from "../components/attendance/StatusBadge";
import { SessionsBadge } from "../components/attendance/SessionsBadge";
import { CameraCapture } from "../components/attendance/CameraCapture";
import { MonthlyAttendanceReport } from "../components/attendance/MonthlyAttendanceReport";
import { AttendanceRegisterTab } from "../components/attendance/AttendanceRegisterTab";

export default function Attendance() {
  const { user } = useAuth();
  const [todayRecord, setTodayRecord] = useState(null);
  const [history, setHistory] = useState([]);
  const [teamRecords, setTeamRecords] = useState([]);
  const [teamLoading, setTeamLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const today_iso = new Date().toISOString().split("T")[0];
  const thirty_days_ago = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
  const [dateFrom, setDateFrom] = useState(thirty_days_ago);
  const [dateTo, setDateTo] = useState(today_iso);
  const [loading, setLoading] = useState(true);
  const [showCamera, setShowCamera] = useState(false);
  const [punchType, setPunchType] = useState(null);
  const [location, setLocation] = useState(null);
  const [locError, setLocError] = useState("");
  const [processing, setProcessing] = useState(false);
  const [result, setResult] = useState(null);
  const [todaySummary, setTodaySummary] = useState(null);
  const [trackingActive, setTrackingActive] = useState(false);
  const trackingTimerRef = useRef(null);
  const isManager = ["hr_admin", "management", "managers"].includes(user?.role);
  const canRegulariseAdmin = ["hr_admin", "management"].includes(user?.role);
  // Regularisation state
  const [regEditRecord, setRegEditRecord] = useState(null);   // record to edit
  const [regCreateOpen, setRegCreateOpen] = useState(false);  // admin add
  const [empReqOpen, setEmpReqOpen] = useState(false);        // employee request
  const [faceReview, setFaceReview] = useState(null);         // {record, side}
  const [pendingReload, setPendingReload] = useState(0);
  const [employees, setEmployees] = useState([]);
  const [multiSessionEnabled, setMultiSessionEnabled] = useState(false);
  const [activeTab, setActiveTab] = useState("today"); // "today" | "history" | "monthly"
  // Selfie+geofence required for everyone except management role per company policy
  const skipSelfieAndGeofence = user?.role === "management";

  // Fetch the employee's multi-session flag on mount (used for the punch-card UX)
  useEffect(() => {
    if (!user?.employee_id) return;
    API.get(`/employees/${user.employee_id}`)
      .then(r => setMultiSessionEnabled(!!r.data?.multi_session_attendance))
      .catch(() => setMultiSessionEnabled(false));
  }, [user?.employee_id]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const promises = [API.get("/attendance/my")];
      if (isManager) promises.push(API.get("/attendance/today"));
      const [myRes, todayRes] = await Promise.all(promises);
      const today = new Date().toISOString().split("T")[0];
      const todayRec = myRes.data.find(r => r.date === today);
      setTodayRecord(todayRec || null);
      setHistory(myRes.data);
      if (todayRes) setTodaySummary(todayRes.data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  // Privileged users: fetch team-wide attendance history
  const fetchTeamRecords = async () => {
    if (!isManager) return;
    setTeamLoading(true);
    try {
      const params = { date_from: dateFrom, date_to: dateTo, limit: 500 };
      if (search.trim()) params.search = search.trim();
      if (filterStatus) params.status = filterStatus;
      const res = await API.get("/attendance", { params });
      setTeamRecords(res.data || []);
    } catch (e) { console.error(e); }
    finally { setTeamLoading(false); }
  };

  useEffect(() => {
    if (!isManager) return;
    const t = setTimeout(fetchTeamRecords, 250);  // debounce search/date changes
    return () => clearTimeout(t);
  }, [isManager, search, filterStatus, dateFrom, dateTo, pendingReload]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load employee list once for admin's "Add attendance" modal dropdown
  useEffect(() => {
    if (canRegulariseAdmin) {
      API.get("/employees?status=all").then(r => setEmployees(r.data || [])).catch(() => {});
    }
  }, [canRegulariseAdmin]);

  const getLocation = () => {
    setLocError("");
    if (!navigator.geolocation) { setLocError("Geolocation not supported"); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => setLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      (err) => setLocError("Location access denied. Please enable location."),
      { enableHighAccuracy: true, timeout: 15000 }
    );
  };

  useEffect(() => { getLocation(); }, []);

  const startPunch = (type) => {
    if (skipSelfieAndGeofence) {
      // Management: punch without selfie / geofence
      doPunch(type, null);
      return;
    }
    if (!location) { getLocation(); setLocError("Getting location... Try again in a moment."); return; }
    setPunchType(type);
    setShowCamera(true);
  };

  const doPunch = async (type, photo_base64) => {
    setProcessing(true);
    setResult(null);
    try {
      const endpoint = type === "in" ? "/attendance/punch-in" : "/attendance/punch-out";
      const payload = {
        employee_id: user.employee_id,
        latitude: location?.lat || 0,
        longitude: location?.lon || 0,
        accuracy: location?.accuracy,
        photo_base64,
      };
      const res = await API.post(endpoint, payload);
      setResult({ success: true, ...res.data });
      fetchData();
    } catch (e) {
      setResult({ success: false, message: e.response?.data?.detail || "Punch failed" });
    } finally {
      setProcessing(false);
    }
  };

  const handleCapture = async (photo_base64) => {
    setShowCamera(false);
    if (!location) return;
    setPunchType(prev => prev); // keep punchType
    await doPunch(punchType, photo_base64);
  };

  const today = new Date().toISOString().split("T")[0];
  const sessions = todayRecord?.sessions || [];
  const lastSessionOpen = sessions.length > 0 && !sessions[sessions.length - 1]?.punch_out_time;
  // Has at least one punch-in today
  const hasPunchedToday = !!todayRecord?.punch_in_time;
  // Whether the user can punch IN right now
  const canPunchIn = !hasPunchedToday || (multiSessionEnabled && !lastSessionOpen);
  // Whether the user can punch OUT right now
  const canPunchOut = hasPunchedToday && (multiSessionEnabled ? lastSessionOpen : !todayRecord?.punch_out_time);
  // Legacy mirrors used by the existing UI labels below
  const alreadyIn = hasPunchedToday;
  const alreadyOut = !!todayRecord?.punch_out_time && !lastSessionOpen;

  // Continuous GPS tracking (every 2 min) between punch-in and punch-out
  // PWA strategy:
  //   1. Wake Lock API — keeps screen on so JS timers keep running
  //   2. Page Visibility API — immediate ping when user returns to app
  //   3. localStorage queue — stores missed pings; replayed on return
  const wakeLockRef = useRef(null);

  const sendLocationPing = (empId) => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          await API.post("/attendance/location-update", {
            employee_id: empId,
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          });
          // Clear any queued pings since we just sent a fresh one
          localStorage.removeItem("rmf_pending_ping");
        } catch (_) {
          // Queue the ping to retry when back online / visible
          localStorage.setItem("rmf_pending_ping", JSON.stringify({
            employee_id: empId,
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            queued_at: new Date().toISOString(),
          }));
        }
      },
      () => {},
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 }
    );
  };

  // Replay any queued ping from when the app was in background
  const replayQueuedPing = async () => {
    const queued = localStorage.getItem("rmf_pending_ping");
    if (!queued) return;
    try {
      const data = JSON.parse(queued);
      await API.post("/attendance/location-update", data);
      localStorage.removeItem("rmf_pending_ping");
    } catch (_) {}
  };

  useEffect(() => {
    const stopTracking = async () => {
      if (trackingTimerRef.current) {
        clearInterval(trackingTimerRef.current);
        trackingTimerRef.current = null;
      }
      // Release wake lock
      if (wakeLockRef.current) {
        try { await wakeLockRef.current.release(); } catch (_) {}
        wakeLockRef.current = null;
      }
      setTrackingActive(false);
    };

    if (!alreadyIn || alreadyOut || !user?.employee_id) {
      stopTracking();
      return;
    }
    if (skipSelfieAndGeofence) {
      stopTracking();
      return;
    }
    if (trackingTimerRef.current) return; // already running

    const empId = user.employee_id;

    // 1. Request Wake Lock to keep screen on during tracking
    const acquireWakeLock = async () => {
      if ("wakeLock" in navigator && !wakeLockRef.current) {
        try {
          wakeLockRef.current = await navigator.wakeLock.request("screen");
          wakeLockRef.current.addEventListener("release", () => {
            // Re-acquire if still tracking (e.g. after tab switch)
            if (trackingTimerRef.current) acquireWakeLock();
          });
        } catch (_) {} // Wake lock not granted (low battery, etc.)
      }
    };
    acquireWakeLock();

    // 2. Page Visibility API — ping immediately when employee returns to app
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        replayQueuedPing();  // send any queued ping first
        sendLocationPing(empId);  // then send fresh ping
        // Re-acquire wake lock if it was released
        acquireWakeLock();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // 3. Regular interval (every 2 min) while app is visible
    sendLocationPing(empId); // immediate ping on start
    trackingTimerRef.current = setInterval(() => {
      if (document.visibilityState === "visible") {
        sendLocationPing(empId);
      } else {
        // App is hidden — queue a placeholder so we know a ping was missed
        localStorage.setItem("rmf_pending_ping", JSON.stringify({
          employee_id: empId, queued_at: new Date().toISOString()
        }));
      }
    }, 2 * 60 * 1000);
    setTrackingActive(true);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      stopTracking();
    };
  }, [alreadyIn, alreadyOut, user?.employee_id, skipSelfieAndGeofence]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ fontFamily: "'Work Sans', sans-serif" }}>
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>Attendance</h1>
        <p className="text-slate-500 text-sm">{new Date().toLocaleDateString("en-IN", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</p>
      </div>

      {/* Tab Bar */}
      <div className="flex gap-1 mb-5 bg-slate-100 p-1 rounded-xl w-fit">
        {[
          { key: "today",    label: "Today",            icon: Clock,        roles: null },
          { key: "history",  label: "History",          icon: Search,       roles: null },
          { key: "monthly",  label: "Monthly Report",   icon: CalendarDays, roles: null },
          { key: "register", label: "Attendance Register", icon: Download,  roles: ["hr_admin", "management", "managers"] },
        ]
          .filter(t => !t.roles || t.roles.includes(user?.role))
          .map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            data-testid={`att-tab-${key}`}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
              activeTab === key
                ? "bg-white text-[#E85B1E] shadow-sm"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            <Icon size={14} />{label}
          </button>
        ))}
      </div>

      {/* ── TODAY TAB ────────────────────────────────────────── */}
      {activeTab === "today" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          {/* Punch Card — hidden for HR Admin (admin manages, doesn't punch) */}
          {user?.role !== "hr_admin" && (
          <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
            <h3 className="font-bold text-[#1E2A47] text-lg mb-4" style={{ fontFamily: "'Outfit', sans-serif" }}>Mark Attendance</h3>

            {/* Location Status */}
            {!skipSelfieAndGeofence && (
              <div className={`flex items-center gap-2 p-3 rounded-lg mb-4 text-sm ${location ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"}`}>
                <MapPin size={16} />
                {location ? (
                  <span>Location found (accuracy: {Math.round(location.accuracy || 0)}m)</span>
                ) : (
                  <span>{locError || "Getting location..."}</span>
                )}
                {!location && <button onClick={getLocation} className="ml-auto"><RefreshCw size={14} /></button>}
              </div>
            )}

            {skipSelfieAndGeofence && (
              <div className="flex items-center gap-2 p-3 rounded-lg mb-4 text-sm bg-blue-50 text-blue-700">
                <CheckCircle size={16} />
                <span>Management — selfie & geofence are not required for your role.</span>
              </div>
            )}

            {trackingActive && !alreadyOut && (
              <div className="p-3 rounded-lg mb-4 text-xs bg-[#1E2A47] text-white" data-testid="tracking-active-indicator">
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse flex-shrink-0"></span>
                  <span className="font-semibold">Live location tracking active</span>
                </div>
                <p className="text-slate-300 text-xs mt-0.5">GPS ping every 2 min. Keep app open for continuous tracking. Location is sent instantly when you return to this screen.</p>
              </div>
            )}

            {/* Today Status */}
            {alreadyIn && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-3 mb-4 text-sm text-green-700" data-testid="today-punched-in-banner">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-semibold">
                    Punched In: {new Date(todayRecord.punch_in_time).toLocaleTimeString("en-IN")}
                    {sessions.length > 1 && (
                      <span className="ml-2 inline-flex items-center text-[11px] px-2 py-0.5 rounded-full bg-green-200 text-green-800 font-bold" data-testid="session-count-badge">
                        {sessions.length} sessions
                      </span>
                    )}
                  </p>
                  {multiSessionEnabled && (
                    <span className="text-[10px] uppercase tracking-wide text-green-600 font-bold">Multi-session</span>
                  )}
                </div>
                {todayRecord.location_name && <p className="text-xs mt-0.5">at {todayRecord.location_name}</p>}
                {!todayRecord.geofence_verified && <p className="text-xs text-amber-600 mt-0.5">Note: Outside geofence</p>}
                {sessions.length > 1 && (
                  <details className="mt-2 text-xs">
                    <summary className="cursor-pointer text-green-800 font-semibold select-none">View all sessions</summary>
                    <div className="mt-1.5 space-y-1">
                      {sessions.map((s, i) => (
                        <div key={i} className="flex items-center gap-1.5 text-[11px]">
                          <span className="font-mono text-green-900">#{i + 1}</span>
                          <span>{new Date(s.punch_in_time).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</span>
                          <span className="text-green-600">→</span>
                          {s.punch_out_time ? (
                            <>
                              <span>{new Date(s.punch_out_time).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</span>
                              <span className="text-green-600">·</span>
                              <span className="font-semibold">{s.hours_worked}h</span>
                            </>
                          ) : (
                            <span className="italic text-amber-700">open</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            )}
            {alreadyOut && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4 text-sm text-blue-700">
                <p className="font-semibold">Punched Out: {new Date(todayRecord.punch_out_time).toLocaleTimeString("en-IN")}</p>
                <p className="text-xs mt-0.5">Total hours worked: {todayRecord.hours_worked}h{sessions.length > 1 ? ` across ${sessions.length} sessions` : ""}</p>
                {multiSessionEnabled && (
                  <p className="text-xs mt-1 text-blue-600">Multi-session is enabled — you can punch in again for another session.</p>
                )}
              </div>
            )}

            {result && (
              <div className={`flex items-start gap-2 p-3 rounded-lg mb-4 text-sm ${result.success ? (result.face_warning ? "bg-amber-50 text-amber-800 border border-amber-200" : "bg-green-50 text-green-700") : "bg-red-50 text-red-700"}`} data-testid="punch-result">
                {result.success ? <CheckCircle size={16} className="flex-shrink-0 mt-0.5" /> : <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />}
                <div className="flex-1">
                  <p>{result.message}</p>
                  {result.face_warning && (
                    <p className="text-xs mt-1 font-medium" data-testid="face-warning">
                      ⚠ Face check: {result.face_warning}
                    </p>
                  )}
                  {result.success && result.face_matched === true && (
                    <p className="text-xs mt-1 text-green-600" data-testid="face-matched">
                      ✓ Face verified
                    </p>
                  )}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => startPunch("in")}
                disabled={!canPunchIn || processing || !user?.employee_id}
                data-testid="punch-in-btn"
                className="flex items-center justify-center gap-2 py-4 bg-green-500 text-white rounded-xl font-bold text-base hover:bg-green-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-sm active:scale-95"
              >
                {processing && punchType === "in" ? <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <LogIn size={20} />}
                {hasPunchedToday && multiSessionEnabled && !lastSessionOpen ? "Punch In Again" : "Punch In"}
              </button>
              <button
                onClick={() => startPunch("out")}
                disabled={!canPunchOut || processing || !user?.employee_id}
                data-testid="punch-out-btn"
                className="flex items-center justify-center gap-2 py-4 bg-[#E85B1E] text-white rounded-xl font-bold text-base hover:bg-[#D04A15] disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-sm active:scale-95"
              >
                {processing && punchType === "out" ? <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <LogOut size={20} />}
                Punch Out
              </button>
            </div>

            {!user?.employee_id && (
              <p className="text-xs text-amber-600 text-center mt-3">No employee linked to your account</p>
            )}
          </div>
          )} {/* end hr_admin punch card conditional */}

          {/* Today's Summary (Manager) */}
          {isManager && todaySummary && (
            <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
              <h3 className="font-bold text-[#1E2A47] text-lg mb-4" style={{ fontFamily: "'Outfit', sans-serif" }}>Today's Summary</h3>
              <div className="grid grid-cols-2 gap-3 mb-4">
                {[["Present", todaySummary.present, "bg-green-500"], ["Absent", todaySummary.absent, "bg-red-500"], ["Punched Out", todaySummary.punched_out, "bg-blue-500"], ["Total", todaySummary.total_employees, "bg-slate-500"]].map(([label, val, color]) => (
                  <div key={label} className="text-center p-3 rounded-lg bg-slate-50">
                    <p className={`text-2xl font-bold ${color.replace("bg-", "text-")}`}>{val}</p>
                    <p className="text-xs text-slate-500">{label}</p>
                  </div>
                ))}
              </div>
              <div className="max-h-48 overflow-y-auto space-y-1">
                {todaySummary.records?.slice(0, 10).map(r => (
                  <div key={r.id} className="flex items-center justify-between text-xs py-1.5 border-b border-slate-50">
                    <span className="font-medium text-slate-700 flex items-center">
                      {r.employee_id}
                      <FaceMismatchBadge record={r} onOpen={(side) => setFaceReview({ record: r, side })} />
                    </span>
                    <span className="text-slate-500">{r.punch_in_time ? new Date(r.punch_in_time).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "-"}</span>
                    <AttendanceStatusBadge record={r} />
                    {canRegulariseAdmin && (
                      <button onClick={() => setRegEditRecord(r)} data-testid={`edit-attendance-${r.id}`}
                        title="Regularise this record"
                        className="p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-[#E85B1E]">
                        <Edit3 size={12} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Regularisation panel (HR Admin + Management) */}
          {canRegulariseAdmin && (
            <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm" data-testid="reg-admin-panel">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-bold text-[#1E2A47] text-lg flex items-center gap-2" style={{ fontFamily: "'Outfit', sans-serif" }}>
                  <FileEdit size={18} /> Attendance Regularisation
                </h3>
                <button onClick={() => setRegCreateOpen(true)} data-testid="reg-add-btn"
                  className="flex items-center gap-1 px-3 py-1.5 bg-[#E85B1E] text-white rounded-lg text-xs font-semibold hover:bg-[#D04A15]">
                  <Plus size={14} /> Add Record
                </button>
              </div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Pending Employee Requests</p>
              <PendingRequestsPanel key={pendingReload} onApproved={() => { setPendingReload(x => x + 1); fetchData(); }} />
            </div>
          )}
        </div>
      )}

      {/* ── HISTORY TAB ──────────────────────────────────────── */}
      {activeTab === "history" && (
        <div className="space-y-4">
          {/* Personal Attendance History */}
          {user?.employee_id && !canRegulariseAdmin && (
            <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between">
                <h3 className="font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>My Attendance History</h3>
                <button onClick={() => setEmpReqOpen(true)} data-testid="request-regularisation-btn"
                  className="flex items-center gap-1 px-3 py-1.5 bg-[#1E2A47] text-white rounded-lg text-xs font-semibold hover:bg-[#2A3A5E]">
                  <FileEdit size={12} /> Request Regularisation
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full" data-testid="attendance-table">
                  <thead><tr className="bg-slate-50 border-b">
                    {["Date", "Punch In", "Punch Out", "Hours", "Location", "Status"].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {loading ? <tr><td colSpan={6}><div className="h-8 bg-slate-100 animate-pulse m-4 rounded"></div></td></tr>
                      : history.slice(0, 20).map(r => (
                        <tr key={r.id} className="border-b border-slate-100 hover:bg-slate-50">
                          <td className="px-4 py-3 text-sm font-medium text-slate-700">
                            {r.date}{r.regularised && <span className="ml-1 text-[10px] text-amber-600 font-semibold">• REG</span>}
                            <SessionsBadge record={r} />
                            <FaceMismatchBadge record={r} onOpen={(side) => setFaceReview({ record: r, side })} />
                          </td>
                          <td className="px-4 py-3 text-sm text-slate-600">{r.punch_in_time ? new Date(r.punch_in_time).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "-"}</td>
                          <td className="px-4 py-3 text-sm text-slate-600">{r.punch_out_time ? new Date(r.punch_out_time).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "-"}</td>
                          <td className="px-4 py-3 text-sm text-slate-600">{r.hours_worked ? `${r.hours_worked}h` : "-"}</td>
                          <td className="px-4 py-3 text-xs text-slate-500">{r.location_name || "-"}</td>
                          <td className="px-4 py-3"><AttendanceStatusBadge record={r} /></td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              {user?.employee_id && (
                <div className="p-4 border-t border-slate-100">
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Your recent regularisation requests</p>
                  <MyRequestsList refreshToken={pendingReload} />
                </div>
              )}
            </div>
          )}

          {/* Team / Company-wide Attendance */}
          {isManager && (
            <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between flex-wrap gap-2">
                <h3 className="font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>
                  {user?.role === "managers" ? "Team Attendance" : "All Employee Attendance"}
                  <span className="text-xs font-normal text-slate-400 ml-2">({teamRecords.length} records)</span>
                </h3>
                <button onClick={fetchTeamRecords} className="flex items-center gap-1 px-3 py-1.5 bg-slate-100 text-slate-600 rounded-lg text-xs font-semibold hover:bg-slate-200" data-testid="refresh-team-attendance">
                  <RefreshCw size={12} /> Refresh
                </button>
              </div>

              {/* Filters */}
              <div className="px-5 py-3 border-b border-slate-100 grid grid-cols-1 md:grid-cols-[1fr_auto_auto_auto] gap-2">
                <div className="relative">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input value={search} onChange={e => setSearch(e.target.value)}
                    placeholder="Search by name or employee ID..."
                    className="w-full border border-slate-300 rounded-lg pl-9 pr-3 py-2 text-sm focus:ring-2 focus:ring-[#E85B1E] outline-none"
                    data-testid="team-search-input" />
                </div>
                <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} max={dateTo}
                  className="border border-slate-300 rounded-lg px-3 py-2 text-sm" data-testid="team-date-from" />
                <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} min={dateFrom} max={today_iso}
                  className="border border-slate-300 rounded-lg px-3 py-2 text-sm" data-testid="team-date-to" />
                <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
                  className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white" data-testid="team-status-filter">
                  <option value="">All statuses</option>
                  <option value="present">Present</option>
                  <option value="absent">Absent</option>
                  <option value="half_day">Half Day</option>
                  <option value="leave">Leave</option>
                  <option value="weekly_off">Weekly Off</option>
                  <option value="holiday">Holiday</option>
                </select>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full" data-testid="team-attendance-table">
                  <thead><tr className="bg-slate-50 border-b">
                    {["Employee", "Date", "Punch In", "Punch Out", "Hours", "Location", "Status", canRegulariseAdmin && ""].filter(Boolean).map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {teamLoading ? (
                      <tr><td colSpan={canRegulariseAdmin ? 8 : 7}><div className="h-8 bg-slate-100 animate-pulse m-4 rounded"></div></td></tr>
                    ) : teamRecords.length === 0 ? (
                      <tr><td colSpan={canRegulariseAdmin ? 8 : 7} className="px-4 py-12 text-center text-sm text-slate-400">No attendance records match the current filters.</td></tr>
                    ) : teamRecords.map(r => (
                      <tr key={r.id} className="border-b border-slate-100 hover:bg-slate-50" data-testid={`team-att-row-${r.id}`}>
                        <td className="px-4 py-3">
                          <p className="text-sm font-medium text-[#0F172A]">{r.employee_name || r.employee_id}</p>
                          <p className="text-[11px] text-[#E85B1E] font-mono">{r.employee_id}{r.designation ? ` · ${r.designation}` : ""}</p>
                        </td>
                        <td className="px-4 py-3 text-sm font-medium text-slate-700">
                          {r.date}{r.regularised && <span className="ml-1 text-[10px] text-amber-600 font-semibold">• REG</span>}
                          <SessionsBadge record={r} />
                          <FaceMismatchBadge record={r} onOpen={(side) => setFaceReview({ record: r, side })} />
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-600">{r.punch_in_time ? new Date(r.punch_in_time).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "-"}</td>
                        <td className="px-4 py-3 text-sm text-slate-600">{r.punch_out_time ? new Date(r.punch_out_time).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "-"}</td>
                        <td className="px-4 py-3 text-sm text-slate-600">{r.hours_worked ? `${r.hours_worked}h` : "-"}</td>
                        <td className="px-4 py-3 text-xs text-slate-500">{r.location_name || "-"}</td>
                        <td className="px-4 py-3"><AttendanceStatusBadge record={r} /></td>
                        {canRegulariseAdmin && (
                          <td className="px-4 py-3 text-right">
                            <button onClick={() => setRegEditRecord(r)} data-testid={`edit-team-${r.id}`}
                              title="Regularise this record"
                              className="p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-[#E85B1E]">
                              <Edit3 size={12} />
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── MONTHLY TAB ──────────────────────────────────────── */}
      {activeTab === "monthly" && <MonthlyAttendanceReport user={user} />}

      {/* ── REGISTER TAB ─────────────────────────────────────── */}
      {activeTab === "register" && <AttendanceRegisterTab />}

      {/* Regularisation modals — always mounted */}
      {regEditRecord && (
        <AdminRegulariseModal mode="edit" record={regEditRecord}
          onClose={() => setRegEditRecord(null)}
          onSaved={() => { setPendingReload(x => x + 1); fetchData(); }} />
      )}
      {regCreateOpen && (
        <AdminRegulariseModal mode="create" employees={employees}
          onClose={() => setRegCreateOpen(false)}
          onSaved={() => { setPendingReload(x => x + 1); fetchData(); }} />
      )}
      {empReqOpen && (
        <EmployeeRegulariseRequestModal
          onClose={() => setEmpReqOpen(false)}
          onSaved={() => setPendingReload(x => x + 1)} />
      )}

      {showCamera && <CameraCapture onCapture={handleCapture} onClose={() => setShowCamera(false)} />}
      {faceReview && (
        <FaceMismatchModal
          record={faceReview.record}
          side={faceReview.side}
          onClose={() => setFaceReview(null)}
        />
      )}
    </div>
  );
}
