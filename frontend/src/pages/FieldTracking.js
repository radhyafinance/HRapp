import React, { useEffect, useState } from "react";
import API from "../utils/api";
import { useAuth } from "../contexts/AuthContext";
import { MapPin, Activity, Clock, AlertCircle, ArrowLeft, RefreshCw } from "lucide-react";
import RouteMap from "../components/RouteMap";

export default function FieldTracking() {
  const { user } = useAuth();
  const [activeStaff, setActiveStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [trackData, setTrackData] = useState(null);
  const [trackLoading, setTrackLoading] = useState(false);
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const isManager = ["hr_admin", "management", "managers"].includes(user?.role);

  const fetchActive = async () => {
    setLoading(true);
    try {
      const res = await API.get("/attendance/field-staff/active");
      setActiveStaff(res.data);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  const fetchTrack = async (empId, d) => {
    setTrackLoading(true);
    try {
      const res = await API.get(`/attendance/location-track/${empId}`, { params: { date_str: d } });
      setTrackData(res.data);
    } catch (e) { console.error(e); }
    finally { setTrackLoading(false); }
  };

  useEffect(() => { if (isManager) fetchActive(); }, [isManager]);

  // Auto-refresh active list every 30s
  useEffect(() => {
    if (!isManager || selected) return;
    const t = setInterval(fetchActive, 30000);
    return () => clearInterval(t);
  }, [isManager, selected]);

  useEffect(() => {
    if (selected) fetchTrack(selected.employee_id, date);
  }, [selected, date]);

  if (!isManager) {
    return (
      <div style={{ fontFamily: "'Work Sans', sans-serif" }} className="text-center py-12">
        <p className="text-slate-500">Access restricted to managers and HR</p>
      </div>
    );
  }

  const stops = trackData?.stops || [];
  const locations = trackData?.locations || [];

  return (
    <div style={{ fontFamily: "'Work Sans', sans-serif" }}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>
            Field Tracking
          </h1>
          <p className="text-slate-500 text-sm">Live GPS routes with stops &gt; 15 minutes</p>
        </div>
        {!selected && (
          <button onClick={fetchActive} data-testid="refresh-active-btn" className="flex items-center gap-2 px-4 py-2 bg-[#1E2A47] text-white rounded-lg text-sm font-semibold hover:bg-[#2A3A5E] transition-colors">
            <RefreshCw size={14} /> Refresh
          </button>
        )}
      </div>

      {!selected ? (
        <>
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden mb-4">
            <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between">
              <h3 className="font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>
                Active Today ({activeStaff.length})
              </h3>
              <span className="text-xs text-slate-500 flex items-center gap-1">
                <Activity size={12} className="text-green-500" /> Auto-refresh 30s
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full" data-testid="active-staff-table">
                <thead>
                  <tr className="bg-slate-50 border-b">
                    {["Employee", "Designation", "Punch In", "Status", "Points", "Last Seen", "Action"].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">Loading...</td></tr>
                  ) : activeStaff.length === 0 ? (
                    <tr><td colSpan={7} className="px-4 py-12 text-center text-slate-400">No active staff today</td></tr>
                  ) : activeStaff.map(s => (
                    <tr key={s.employee_id} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <p className="text-sm font-medium text-[#0F172A]">{s.name}</p>
                        <p className="text-xs text-[#E85B1E] font-mono">{s.employee_id}</p>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-600">{s.designation || "-"}</td>
                      <td className="px-4 py-3 text-sm text-slate-600">
                        {s.punch_in_time ? new Date(s.punch_in_time).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "-"}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${s.punch_out_time ? "bg-blue-100 text-blue-700" : "bg-green-100 text-green-700"}`}>
                          {s.punch_out_time ? "Punched Out" : "Active"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm font-semibold text-[#1E2A47]">{s.location_points}</td>
                      <td className="px-4 py-3 text-xs text-slate-500">
                        {s.last_seen ? new Date(s.last_seen).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "-"}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => setSelected(s)}
                          data-testid={`view-track-${s.employee_id}`}
                          className="text-xs px-3 py-1.5 bg-[#E85B1E] text-white rounded-lg hover:bg-[#D04A15] flex items-center gap-1"
                        >
                          <MapPin size={12} /> View Route
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between mb-4">
            <button onClick={() => { setSelected(null); setTrackData(null); }} data-testid="back-to-list-btn" className="flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-[#1E2A47]">
              <ArrowLeft size={16} /> Back to list
            </button>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={date}
                onChange={e => setDate(e.target.value)}
                max={new Date().toISOString().split("T")[0]}
                className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white"
                data-testid="track-date-input"
              />
              <button onClick={() => fetchTrack(selected.employee_id, date)} className="p-2 rounded-lg bg-slate-100 hover:bg-slate-200" data-testid="refresh-track-btn">
                <RefreshCw size={14} />
              </button>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm mb-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
              <div>
                <p className="font-bold text-[#1E2A47] text-lg">{selected.name}</p>
                <p className="text-xs text-slate-500">{selected.designation} • <span className="font-mono text-[#E85B1E]">{selected.employee_id}</span></p>
              </div>
              <div className="grid grid-cols-3 gap-3 text-center text-xs">
                <div className="px-3 py-2 bg-slate-50 rounded-lg">
                  <p className="text-lg font-bold text-[#1E2A47]">{locations.length}</p>
                  <p className="text-slate-500">Points</p>
                </div>
                <div className="px-3 py-2 bg-slate-50 rounded-lg">
                  <p className="text-lg font-bold text-[#E85B1E]">{stops.length}</p>
                  <p className="text-slate-500">Stops &gt; 15m</p>
                </div>
                <div className="px-3 py-2 bg-slate-50 rounded-lg">
                  <p className="text-sm font-bold text-green-700">
                    {trackData?.attendance?.punch_in_time ? new Date(trackData.attendance.punch_in_time).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "-"}
                  </p>
                  <p className="text-slate-500">Punch In</p>
                </div>
              </div>
            </div>

            {trackLoading ? (
              <div className="text-center py-12 text-slate-400">Loading map...</div>
            ) : locations.length === 0 ? (
              <div className="text-center py-12">
                <AlertCircle size={32} className="mx-auto text-slate-300 mb-2" />
                <p className="text-sm text-slate-500">No location data captured for this day</p>
                <p className="text-xs text-slate-400">Tracking starts after punch-in (every 2 min)</p>
              </div>
            ) : (
              <RouteMap locations={locations} stops={stops} attendance={trackData?.attendance} />
            )}
          </div>

          {stops.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100 bg-amber-50/50">
                <h3 className="font-bold text-[#1E2A47] flex items-center gap-2" style={{ fontFamily: "'Outfit', sans-serif" }}>
                  <Clock size={16} className="text-[#E85B1E]" /> Stops longer than 15 minutes
                </h3>
              </div>
              <table className="w-full" data-testid="stops-table">
                <thead>
                  <tr className="bg-slate-50 border-b">
                    {["#", "Start Time", "End Time", "Duration", "Coordinates"].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {stops.map((s, i) => (
                    <tr key={i} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="px-4 py-3 text-sm font-medium text-[#1E2A47]">{i + 1}</td>
                      <td className="px-4 py-3 text-sm text-slate-600">{new Date(s.start).toLocaleTimeString("en-IN")}</td>
                      <td className="px-4 py-3 text-sm text-slate-600">{new Date(s.end).toLocaleTimeString("en-IN")}</td>
                      <td className="px-4 py-3 text-sm font-semibold text-[#E85B1E]">{s.duration_minutes} min</td>
                      <td className="px-4 py-3 text-xs font-mono text-slate-500">
                        {s.latitude.toFixed(5)}, {s.longitude.toFixed(5)}
                        {" "}
                        <a
                          href={`https://www.google.com/maps?q=${s.latitude},${s.longitude}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-2 text-[#E85B1E] hover:underline"
                        >Open in Maps</a>
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
