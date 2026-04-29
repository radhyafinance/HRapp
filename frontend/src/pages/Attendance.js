import React, { useEffect, useState, useRef } from "react";
import API from "../utils/api";
import { Camera, MapPin, CheckCircle, AlertCircle, Clock, LogIn, LogOut, RefreshCw, Edit3, Plus, FileEdit } from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import { AdminRegulariseModal, EmployeeRegulariseRequestModal, PendingRequestsPanel, MyRequestsList } from "../components/attendance/Regularisation";

function CameraCapture({ onCapture, onClose }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          setReady(true);
        }
      } catch (e) {
        setError("Camera access denied. Please allow camera access.");
      }
    };
    startCamera();
    return () => { if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop()); };
  }, []);

  const capture = () => {
    if (!videoRef.current || !canvasRef.current) return;
    const canvas = canvasRef.current;
    canvas.width = 320;
    canvas.height = 240;
    canvas.getContext("2d").drawImage(videoRef.current, 0, 0, 320, 240);
    const base64 = canvas.toDataURL("image/jpeg", 0.7).split(",")[1];
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    onCapture(base64);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="bg-white rounded-xl p-5 w-full max-w-sm">
        <h3 className="text-lg font-bold text-[#1E2A47] mb-3" style={{ fontFamily: "'Outfit', sans-serif" }}>Take Selfie</h3>
        {error ? (
          <div className="bg-red-50 text-red-700 p-3 rounded-lg text-sm mb-3">{error}</div>
        ) : (
          <video ref={videoRef} autoPlay playsInline muted className="w-full rounded-lg bg-slate-900 mb-3" style={{ height: 240 }} />
        )}
        <canvas ref={canvasRef} className="hidden" />
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 px-4 py-2.5 border-2 border-slate-300 text-slate-600 rounded-lg text-sm font-medium">Cancel</button>
          <button onClick={capture} disabled={!ready} data-testid="capture-selfie-btn"
            className="flex-1 px-4 py-2.5 bg-[#E85B1E] text-white rounded-lg text-sm font-semibold disabled:opacity-60 flex items-center justify-center gap-2">
            <Camera size={16} /> Capture
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Attendance() {
  const { user } = useAuth();
  const [todayRecord, setTodayRecord] = useState(null);
  const [history, setHistory] = useState([]);
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
  const isManager = ["hr_admin", "management", "branch_manager"].includes(user?.role);
  const canRegulariseAdmin = ["hr_admin", "management"].includes(user?.role);
  // Regularisation state
  const [regEditRecord, setRegEditRecord] = useState(null);   // record to edit
  const [regCreateOpen, setRegCreateOpen] = useState(false);  // admin add
  const [empReqOpen, setEmpReqOpen] = useState(false);        // employee request
  const [pendingReload, setPendingReload] = useState(0);
  const [employees, setEmployees] = useState([]);
  // Selfie+geofence required for everyone except management role per company policy
  const skipSelfieAndGeofence = user?.role === "management";

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
  const alreadyIn = !!todayRecord?.punch_in_time;
  const alreadyOut = !!todayRecord?.punch_out_time;

  // Continuous GPS tracking (every 2 min) between punch-in and punch-out
  useEffect(() => {
    const stopTracking = () => {
      if (trackingTimerRef.current) {
        clearInterval(trackingTimerRef.current);
        trackingTimerRef.current = null;
      }
      setTrackingActive(false);
    };

    if (!alreadyIn || alreadyOut || !user?.employee_id) {
      stopTracking();
      return;
    }
    if (skipSelfieAndGeofence) {
      // Management role: no continuous tracking required
      stopTracking();
      return;
    }
    if (trackingTimerRef.current) return; // already running

    const sendPing = () => {
      if (!navigator.geolocation) return;
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          try {
            await API.post("/attendance/location-update", {
              employee_id: user.employee_id,
              latitude: pos.coords.latitude,
              longitude: pos.coords.longitude,
              accuracy: pos.coords.accuracy,
            });
          } catch (_) {}
        },
        () => {},
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 }
      );
    };

    sendPing(); // immediate
    trackingTimerRef.current = setInterval(sendPing, 2 * 60 * 1000);
    setTrackingActive(true);
    return stopTracking;
  }, [alreadyIn, alreadyOut, user?.employee_id, skipSelfieAndGeofence]);

  return (
    <div style={{ fontFamily: "'Work Sans', sans-serif" }}>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>Attendance</h1>
        <p className="text-slate-500 text-sm">{new Date().toLocaleDateString("en-IN", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        {/* Punch Card */}
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
            <div className="flex items-center gap-2 p-3 rounded-lg mb-4 text-xs bg-[#1E2A47] text-white" data-testid="tracking-active-indicator">
              <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse"></span>
              <span>Live tracking active — sending GPS ping every 2 minutes</span>
            </div>
          )}

          {/* Today Status */}
          {alreadyIn && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-3 mb-4 text-sm text-green-700">
              <p className="font-semibold">Punched In: {new Date(todayRecord.punch_in_time).toLocaleTimeString("en-IN")}</p>
              {todayRecord.location_name && <p className="text-xs mt-0.5">at {todayRecord.location_name}</p>}
              {!todayRecord.geofence_verified && <p className="text-xs text-amber-600 mt-0.5">Note: Outside geofence</p>}
            </div>
          )}
          {alreadyOut && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4 text-sm text-blue-700">
              <p className="font-semibold">Punched Out: {new Date(todayRecord.punch_out_time).toLocaleTimeString("en-IN")}</p>
              <p className="text-xs mt-0.5">Hours worked: {todayRecord.hours_worked}h</p>
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
              disabled={alreadyIn || processing || !user?.employee_id}
              data-testid="punch-in-btn"
              className="flex items-center justify-center gap-2 py-3 bg-green-500 text-white rounded-xl font-semibold text-sm hover:bg-green-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {processing && punchType === "in" ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <LogIn size={18} />}
              Punch In
            </button>
            <button
              onClick={() => startPunch("out")}
              disabled={!alreadyIn || alreadyOut || processing || !user?.employee_id}
              data-testid="punch-out-btn"
              className="flex items-center justify-center gap-2 py-3 bg-[#E85B1E] text-white rounded-xl font-semibold text-sm hover:bg-[#D04A15] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {processing && punchType === "out" ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <LogOut size={18} />}
              Punch Out
            </button>
          </div>

          {!user?.employee_id && (
            <p className="text-xs text-amber-600 text-center mt-3">No employee linked to your account</p>
          )}
        </div>

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
                  <span className="font-medium text-slate-700">{r.employee_id}</span>
                  <span className="text-slate-500">{r.punch_in_time ? new Date(r.punch_in_time).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "-"}</span>
                  <span className={`px-2 py-0.5 rounded-full ${r.geofence_verified ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>
                    {r.geofence_verified ? "In Fence" : "Out Fence"}
                  </span>
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

      {/* Attendance History */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between">
          <h3 className="font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>Attendance History</h3>
          {!isManager && user?.employee_id && (
            <button onClick={() => setEmpReqOpen(true)} data-testid="request-regularisation-btn"
              className="flex items-center gap-1 px-3 py-1.5 bg-[#1E2A47] text-white rounded-lg text-xs font-semibold hover:bg-[#2A3A5E]">
              <FileEdit size={12} /> Request Regularisation
            </button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full" data-testid="attendance-table">
            <thead><tr className="bg-slate-50 border-b">
              {["Date", "Punch In", "Punch Out", "Hours", "Location", "Status", ""].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {loading ? <tr><td colSpan={7}><div className="h-8 bg-slate-100 animate-pulse m-4 rounded"></div></td></tr>
                : history.slice(0, 20).map(r => (
                  <tr key={r.id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-3 text-sm font-medium text-slate-700">
                      {r.date}{r.regularised && <span className="ml-1 text-[10px] text-amber-600 font-semibold">• REG</span>}
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-600">{r.punch_in_time ? new Date(r.punch_in_time).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "-"}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{r.punch_out_time ? new Date(r.punch_out_time).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "-"}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{r.hours_worked ? `${r.hours_worked}h` : "-"}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">{r.location_name || "-"}</td>
                    <td className="px-4 py-3"><span className={`px-2 py-1 rounded-full text-xs font-medium ${r.geofence_verified ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>{r.punch_in_time ? (r.geofence_verified ? "Present" : "Outside Fence") : (r.status || "Absent")}</span></td>
                    <td className="px-4 py-3 text-right">
                      {canRegulariseAdmin && (
                        <button onClick={() => setRegEditRecord(r)} data-testid={`edit-history-${r.id}`}
                          title="Regularise this record"
                          className="p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-[#E85B1E]">
                          <Edit3 size={12} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {!isManager && user?.employee_id && (
          <div className="p-4 border-t border-slate-100">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Your recent regularisation requests</p>
            <MyRequestsList refreshToken={pendingReload} />
          </div>
        )}
      </div>

      {/* Regularisation modals */}
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
    </div>
  );
}
