import React, { useEffect, useState, useCallback } from "react";
import { Gauge, Camera, ChevronDown, ChevronUp, X } from "lucide-react";
import API from "../../utils/api";
import { getOdoStatus, captureOdometer, ODO_UPDATED } from "../../utils/odometer";
/**
 * Odometer prompt on the personal dashboard for employees with odometer
 * tracking enabled. Shows a Capture prompt for the start reading after punch-in,
 * lets them record the end reading any time after that (before OR after punch-out),
 * and a summary once done. Works in the app (native camera) and the PWA; in
 * both, the employee types the reading off the photo they just took.
 *
 * Below that, "My travel" — this month and last. These readings are a
 * reimbursement claim, and until this existed the employee kept no copy of one:
 * HR held the only record of both the number and the photo the employee took,
 * and today's figures vanished from the dashboard at midnight. Read-only; a
 * wrong reading is a conversation with HR, not an edit.
 *
 * The whole component renders nothing unless odometer tracking is enabled for
 * this employee, which is what keeps it off ~200 other dashboards.
 */
// Deliberately not the same strings HR sees. Same verdict, different reader:
// HR is being told what to check, the employee what will happen to their claim.
const REVIEW_NOTE = {
  below_start: "Lower than your start reading — HR will check this against your photo.",
  implausible: "More than 500 km in one day — HR will check this against your photo.",
};
const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-IN"));
const prettyDate = (ds) => {
  const d = new Date(`${ds}T00:00:00`);
  return isNaN(d) ? ds : d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
};
/** One day's photos, fetched only when the employee asks for them. A month of
 *  base64 in the list response would be a heavy download on a field phone. */
function DayPhotos({ date, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    setLoading(true);   // or a date change renders the PREVIOUS day's photos under the new date
    API.get(`/tracker/odometer/my-day/${date}`)
      .then(r => { if (live) { setData(r.data); setLoading(false); } })
      .catch(() => { if (live) { setData(null); setLoading(false); } });
    return () => { live = false; };
  }, [date]);
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl max-w-md w-full max-h-[90vh] overflow-y-auto p-5"
        onClick={e => e.stopPropagation()} data-testid="my-odo-day">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-[#1E2A47]">Your odometer — {prettyDate(date)}</h3>
          {/* 44px minimum. The icon is 18px; the tap target must not be. */}
          <button onClick={onClose} aria-label="Close" data-testid="my-odo-day-close"
            className="min-w-[44px] min-h-[44px] -mr-2 grid place-items-center text-slate-400 hover:text-slate-600">
            <X size={18} />
          </button>
        </div>
        {loading ? <p className="text-center text-slate-400 py-8">Loading…</p>
          : !data ? <p className="text-center text-slate-400 py-8">Couldn't load this day.</p>
          : (
            <div className="space-y-4">
              {["start", "end"].map(k => {
                const rd = data[k];
                return (
                  <div key={k} className="border border-slate-200 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-semibold text-[#1E2A47]">{k === "start" ? "Start" : "End"} of day</span>
                      <span className="text-sm font-bold text-[#1E2A47]">{rd?.reading_km != null ? `${fmt(rd.reading_km)} km` : "—"}</span>
                    </div>
                    {rd?.photo
                      ? <img src={`data:image/jpeg;base64,${rd.photo}`} alt={`${k} odometer`}
                          className="w-full max-h-[45vh] object-contain bg-slate-50 rounded-lg border border-slate-100" />
                      : <p className="text-xs text-slate-400">No photo submitted.</p>}
                  </div>
                );
              })}
              {data.review && (
                <p className="text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                  {REVIEW_NOTE[data.review]}
                </p>
              )}
              <div className="text-center text-sm text-slate-600">
                Distance: <strong className="text-[#12855a]">{data.distance_km != null ? `${fmt(data.distance_km)} km` : "—"}</strong>
              </div>
            </div>
          )}
      </div>
    </div>
  );
}
/** Collapsed by default, and fetched only on expand — the dashboard is the
 *  first screen on a slow phone and this is not what it is for. */
function MyTravel() {
  const [open, setOpen] = useState(false);
  const [hist, setHist] = useState(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [day, setDay] = useState(null);
  // A failure must be a state of its own. Driving the effect off `!hist` meant
  // a failed load reset to exactly the condition that triggers a load, so the
  // effect re-fired the moment it finished — a self-sustaining request loop at
  // one per round trip, on a field phone, on the connection that just failed.
  // It only looked safe against a stub that rejected synchronously.
  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try { const r = await API.get("/tracker/odometer/my-history"); setHist(r.data); }
    catch { setHist(null); setFailed(true); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    if (open && !hist && !loading && !failed) load();
  }, [open, hist, loading, failed, load]);
  // A reading filed since the list was loaded must not leave a stale list behind.
  useEffect(() => {
    const onUpdate = () => { if (open) load(); else setHist(null); };
    document.addEventListener(ODO_UPDATED, onUpdate);
    return () => document.removeEventListener(ODO_UPDATED, onUpdate);
  }, [open, load]);
  const days = (hist && hist.days) || [];
  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm mb-6" data-testid="my-travel">
      <button onClick={() => setOpen(o => !o)} data-testid="my-travel-toggle"
        className="w-full flex items-center gap-3 p-4 text-left">
        <div className="w-9 h-9 rounded-lg bg-slate-100 text-slate-600 grid place-items-center flex-none">
          <Gauge size={18} />
        </div>
        <div className="flex-1">
          <p className="font-semibold text-[#1E2A47] text-sm">My travel</p>
          <p className="text-xs text-slate-500">Your odometer readings and photos, this month and last</p>
        </div>
        {open ? <ChevronUp size={18} className="text-slate-400" /> : <ChevronDown size={18} className="text-slate-400" />}
      </button>
      {open && (
        <div className="border-t border-slate-100 px-4 pb-4">
          {loading ? <p className="text-center text-slate-400 py-6 text-sm">Loading…</p>
            : failed || !hist ? (
              // A real button, not "pull down to retry" — there is no
              // pull-to-refresh on this component, and the retry has to be the
              // employee's decision rather than a loop the phone runs by itself.
              <div className="py-6 text-center">
                <p className="text-sm text-slate-400 mb-3">Couldn't load your travel.</p>
                <button onClick={load} data-testid="my-travel-retry"
                  className="min-h-[44px] px-5 rounded-lg bg-slate-100 text-slate-600 text-sm font-semibold">
                  Try again
                </button>
              </div>
            )
            : days.length === 0 ? <p className="text-center text-slate-400 py-6 text-sm">No odometer readings yet.</p>
            : (
              <>
                {/* Only days that add up and carry no flag. A day HR is going to
                    query is not money in hand, and banking it in bold directly
                    above its own amber warning is how a total becomes a lie. */}
                <p className="text-xs text-slate-500 pt-3 pb-2">
                  Total recorded: <strong className="text-[#1E2A47]">{fmt(hist.total_km)} km</strong>
                  {hist.excluded_days > 0 && (
                    <span className="text-amber-700"> · {hist.excluded_days} day
                      {hist.excluded_days > 1 ? "s" : ""} not counted</span>
                  )}
                </p>
                <div className="divide-y divide-slate-100">
                  {days.map(d => (
                    <button key={d.date} onClick={() => setDay(d.date)} data-testid="my-travel-day"
                      className="w-full flex items-center gap-3 py-3 text-left hover:bg-slate-50">
                      <div className="w-12 flex-none text-xs font-semibold text-[#1E2A47]">{prettyDate(d.date)}</div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-slate-700">
                          {fmt(d.start_km)}{d.end_km != null ? ` → ${fmt(d.end_km)}` : ""}
                        </p>
                        {d.review && (
                          <p className="text-[11px] text-amber-700 mt-0.5">{REVIEW_NOTE[d.review]}</p>
                        )}
                      </div>
                      {/* Green is "this is your distance" everywhere else in the
                          app. A flagged day is not that yet, and 4,00,000 km in
                          the same green reads as money already earned. */}
                      <div className={`text-sm font-bold flex-none ${d.review ? "text-amber-700" : "text-[#12855a]"}`}>
                        {d.distance_km != null ? `${fmt(d.distance_km)} km` : "—"}
                      </div>
                    </button>
                  ))}
                </div>
              </>
            )}
        </div>
      )}
      {day && <DayPhotos date={day} onClose={() => setDay(null)} />}
    </div>
  );
}
export default function OdometerCard() {
  const [st, setSt] = useState(null);
  const refresh = useCallback(async () => {
    const s = await getOdoStatus();
    // A failed poll must NOT delete the card. getOdoStatus swallows every error
    // and returns null, which is indistinguishable from "tracking is off" — and
    // since this component returns null for a null status, one dropped request
    // on the 3-minute timer took the whole card away mid-read, expanded history
    // and open photo modal with it. Most likely right after a submit, because
    // ODO_UPDATED re-polls on the same marginal connection that just carried
    // the upload. Keep the last known good answer instead.
    setSt(prev => (s === null && prev ? prev : s));
  }, []);
  useEffect(() => {
    refresh();
    const onVis = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVis);
    // The auto-popup can file a reading without this card having started it.
    // Waiting out the 3-minute poll leaves "pending" on screen after the
    // employee has already submitted, and they do the whole thing again.
    document.addEventListener(ODO_UPDATED, refresh);
    const t = setInterval(refresh, 3 * 60 * 1000);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      document.removeEventListener(ODO_UPDATED, refresh);
      clearInterval(t);
    };
  }, [refresh]);
  const captureCard = (kind, title, subtitle, iconCls) => (
    <div className="bg-white border border-amber-200 rounded-xl shadow-sm p-5 mb-6" data-testid="odometer-card">
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 rounded-lg grid place-items-center flex-none ${iconCls}`}>
          <Gauge size={20} />
        </div>
        <div className="flex-1">
          <p className="font-semibold text-[#1E2A47]">{title}</p>
          <p className="text-xs text-slate-500">{subtitle}</p>
        </div>
      </div>
      <button onClick={() => captureOdometer(kind)} data-testid="odometer-capture-btn"
        className="mt-4 w-full flex items-center justify-center gap-2 bg-[#E85B1E] text-white rounded-lg py-3 text-sm font-semibold hover:bg-[#D04A15]">
        <Camera size={16} /> {kind === "start" ? "Capture start odometer" : "Record end-of-day odometer"}
      </button>
    </div>
  );
  if (!st || !st.required) return null;
  const pendingStart = st.punched_in && !st.start_done;
  const pendingEnd = st.punched_out && !st.end_done;                       // reminder after punch-out
  const endEarly = st.punched_in && !st.punched_out && st.start_done && !st.end_done; // allowed before punch-out
  // Today's prompt, if there is one. Built as a value rather than returned
  // early, so "My travel" survives every branch — the history was the whole
  // point and the old shape returned null out from under it in two of five
  // states.
  let today = null;
  if (pendingStart) {
    today = captureCard("start", "Start-of-day odometer pending",
      "Photograph your odometer to record today's travel.", "bg-amber-50 text-amber-600");
  } else if (pendingEnd) {
    today = captureCard("end", "End-of-day odometer pending",
      "Photograph your odometer to close out today's travel.", "bg-amber-50 text-amber-600");
  } else if (endEarly) {
    today = captureCard("end", `Start recorded — ${fmt(st.start_km)} km`,
      "Record your end-of-day odometer when you finish (you can do this before punching out).",
      "bg-emerald-50 text-emerald-600");
  } else if (st.start_done || st.end_done) {
    today = (
      <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 mb-6" data-testid="odometer-card-done">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-white text-emerald-600 grid place-items-center flex-none">
            <Gauge size={18} />
          </div>
          <div className="text-sm">
            <span className="font-semibold text-emerald-700">Odometer recorded</span>
            <span className="text-slate-600">
              {" "}— {fmt(st.start_km)}{st.end_km != null ? ` → ${fmt(st.end_km)}` : ""}
              {st.distance_km != null ? ` km (${fmt(st.distance_km)} km)` : " km"}
            </span>
          </div>
        </div>
      </div>
    );
  }
  return (<>{today}<MyTravel /></>);
}
