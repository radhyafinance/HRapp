import React, { useEffect, useState, useCallback } from "react";
import { Capacitor } from "@capacitor/core";
import { Gauge, Camera } from "lucide-react";
import { getOdoStatus, captureOdometer } from "../../utils/odometer";

/**
 * Odometer prompt on the personal dashboard — shown only inside the Android app
 * for employees with odometer tracking enabled. Mirrors the punch card style.
 */
export default function OdometerCard() {
  const [st, setSt] = useState(null);
  const refresh = useCallback(async () => { setSt(await getOdoStatus()); }, []);

  useEffect(() => {
    let native = false;
    try { native = Capacitor.isNativePlatform(); } catch (e) {}
    if (!native) return;
    refresh();
    const onVis = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVis);
    const t = setInterval(refresh, 3 * 60 * 1000);
    return () => { document.removeEventListener("visibilitychange", onVis); clearInterval(t); };
  }, [refresh]);

  if (!st || !st.required) return null;

  const pendingStart = st.punched_in && !st.start_done;
  const pendingEnd = st.punched_out && !st.end_done;
  const kind = pendingStart ? "start" : pendingEnd ? "end" : null;

  if (kind) {
    const label = kind === "start" ? "Start-of-day" : "End-of-day";
    return (
      <div className="bg-white border border-amber-200 rounded-xl shadow-sm p-5 mb-6" data-testid="odometer-card">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-amber-50 text-amber-600 grid place-items-center flex-none">
            <Gauge size={20} />
          </div>
          <div className="flex-1">
            <p className="font-semibold text-[#1E2A47]">{label} odometer pending</p>
            <p className="text-xs text-slate-500">Photograph your odometer to record today's travel.</p>
          </div>
        </div>
        <button onClick={() => captureOdometer(kind, refresh)} data-testid="odometer-capture-btn"
          className="mt-4 w-full flex items-center justify-center gap-2 bg-[#E85B1E] text-white rounded-lg py-3 text-sm font-semibold hover:bg-[#D04A15]">
          <Camera size={16} /> Capture {kind} odometer
        </button>
      </div>
    );
  }

  if (st.start_done || st.end_done) {
    const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-IN"));
    return (
      <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 mb-6" data-testid="odometer-card-done">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-white text-emerald-600 grid place-items-center flex-none">
            <Gauge size={18} />
          </div>
          <div className="text-sm">
            <span className="font-semibold text-emerald-700">Odometer recorded</span>
            <span className="text-slate-600">
              {" "}— {fmt(st.start_km)}{st.end_km != null ? ` → ${fmt(st.end_km)}` : ""}
              {st.distance_km != null ? ` km (${st.distance_km} km)` : " km"}
            </span>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
