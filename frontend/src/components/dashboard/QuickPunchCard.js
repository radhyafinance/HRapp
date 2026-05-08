import React, { useEffect, useState } from "react";
import API from "../../utils/api";
import { LogIn, LogOut, MapPin, CheckCircle, AlertCircle, Loader2 } from "lucide-react";
import { CameraCapture } from "../attendance/CameraCapture";

/**
 * Compact one-click punch widget for the personal dashboard.
 * Mirrors the core punch flow on /attendance:
 *  1. Acquire GPS on mount
 *  2. Click → open camera → capture selfie
 *  3. POST /api/attendance/punch-in or /punch-out
 */
export function QuickPunchCard({ user, todayStatus, onPunched }) {
  const [location, setLocation] = useState(null);
  const [locError, setLocError] = useState("");
  const [showCamera, setShowCamera] = useState(false);
  const [punchType, setPunchType] = useState("in"); // "in" | "out"
  const [processing, setProcessing] = useState(false);
  const [result, setResult] = useState(null);

  const skipSelfie = user?.role === "management";

  useEffect(() => {
    if (!navigator.geolocation) { setLocError("Geolocation not supported on this device"); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => setLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      () => setLocError("Location access denied. Please enable location."),
      { enableHighAccuracy: true, timeout: 15000 }
    );
  }, []);

  const doPunch = async (type, photo_base64) => {
    setProcessing(true);
    setResult(null);
    try {
      const endpoint = type === "in" ? "/attendance/punch-in" : "/attendance/punch-out";
      const res = await API.post(endpoint, {
        employee_id: user.employee_id,
        latitude: location?.lat || 0,
        longitude: location?.lon || 0,
        accuracy: location?.accuracy,
        photo_base64,
      });
      setResult({ success: true, ...res.data });
      onPunched && onPunched();
    } catch (e) {
      setResult({ success: false, message: e.response?.data?.detail || "Punch failed" });
    } finally {
      setProcessing(false);
    }
  };

  const startPunch = (type) => {
    setResult(null);
    if (skipSelfie) { doPunch(type, null); return; }
    if (!location) { setLocError("Getting location… try again in a moment."); return; }
    setPunchType(type);
    setShowCamera(true);
  };

  const handleCapture = async (b64) => {
    setShowCamera(false);
    await doPunch(punchType, b64);
  };

  const hasIn = todayStatus?.has_punched_in;
  const hasOut = todayStatus?.has_punched_out;
  const openSession = todayStatus?.has_open_session;
  const canPunchIn = !hasIn || (todayStatus?.session_count > 0 && !openSession); // multi-session re-entry
  const canPunchOut = hasIn && openSession;
  const fullyDone = hasOut && !openSession;

  return (
    <div className="bg-gradient-to-br from-[#1E2A47] to-[#2D3D63] text-white rounded-xl shadow-lg p-5 md:p-6 mb-6" data-testid="quick-punch-card">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-lg font-bold" style={{ fontFamily: "'Outfit', sans-serif" }}>Today's Attendance</h3>
          <p className="text-xs text-white/60 mt-0.5">{new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}</p>
        </div>
        {fullyDone && (
          <span className="px-3 py-1 bg-green-500/20 text-green-300 text-xs font-semibold rounded-full flex items-center gap-1">
            <CheckCircle size={12} /> Done
          </span>
        )}
      </div>

      {/* Status row */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="bg-white/10 rounded-lg p-3" data-testid="today-punch-in-status">
          <p className="text-[11px] text-white/60 uppercase tracking-wide">Punch In</p>
          <p className="text-lg font-bold mt-0.5">
            {todayStatus?.punch_in_time
              ? new Date(todayStatus.punch_in_time).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
              : "—"}
          </p>
        </div>
        <div className="bg-white/10 rounded-lg p-3" data-testid="today-punch-out-status">
          <p className="text-[11px] text-white/60 uppercase tracking-wide">Punch Out</p>
          <p className="text-lg font-bold mt-0.5">
            {todayStatus?.punch_out_time && !openSession
              ? new Date(todayStatus.punch_out_time).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
              : "—"}
          </p>
        </div>
      </div>

      {todayStatus?.session_count > 1 && (
        <p className="text-[11px] text-white/60 mb-3" data-testid="quick-punch-sessions">
          {todayStatus.session_count} sessions today · {todayStatus.hours_worked || 0}h worked
        </p>
      )}

      {/* Action button */}
      <div className="flex flex-col sm:flex-row gap-2">
        {canPunchIn && !fullyDone && (
          <button onClick={() => startPunch("in")} disabled={processing}
            data-testid="quick-punch-in-btn"
            className="flex-1 flex items-center justify-center gap-2 bg-[#E85B1E] hover:bg-[#D04A15] text-white font-bold rounded-lg py-3 text-sm disabled:opacity-60">
            {processing ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />}
            {hasIn ? "Punch In Again" : "Punch In Now"}
          </button>
        )}
        {canPunchOut && (
          <button onClick={() => startPunch("out")} disabled={processing}
            data-testid="quick-punch-out-btn"
            className="flex-1 flex items-center justify-center gap-2 bg-orange-500 hover:bg-orange-600 text-white font-bold rounded-lg py-3 text-sm disabled:opacity-60">
            {processing ? <Loader2 size={16} className="animate-spin" /> : <LogOut size={16} />}
            Punch Out
          </button>
        )}
        {fullyDone && (
          <p className="flex-1 text-center text-sm text-white/70 py-3" data-testid="quick-punch-complete-msg">
            You're all set for today. See you tomorrow!
          </p>
        )}
      </div>

      {/* Location / error / result strip */}
      <div className="mt-3 text-[11px] text-white/60 flex items-center gap-2 flex-wrap">
        {location ? (
          <span className="flex items-center gap-1"><MapPin size={11} /> Location ready</span>
        ) : locError ? (
          <span className="flex items-center gap-1 text-amber-300"><AlertCircle size={11} /> {locError}</span>
        ) : (
          <span className="flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> Getting location…</span>
        )}
        {skipSelfie && <span className="px-1.5 py-0.5 bg-white/10 rounded">No selfie required (Management)</span>}
      </div>

      {result && (
        <div className={`mt-3 p-2.5 rounded-lg text-xs flex items-start gap-2 ${result.success ? "bg-green-500/20 text-green-100" : "bg-red-500/20 text-red-100"}`}
          data-testid="quick-punch-result">
          {result.success ? <CheckCircle size={14} className="mt-0.5 flex-shrink-0" /> : <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />}
          <span>{result.message || (result.success ? "Punched successfully" : "Failed")}</span>
        </div>
      )}

      {showCamera && <CameraCapture onCapture={handleCapture} onClose={() => setShowCamera(false)} />}
    </div>
  );
}
