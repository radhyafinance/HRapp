import React, { useEffect, useState, useMemo } from "react";
import API from "../utils/api";
import { useAuth } from "../contexts/AuthContext";
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon, Sun, Sparkles } from "lucide-react";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const TYPE_STYLES = {
  holiday:       { bg: "bg-red-50",    border: "border-red-300",   ring: "ring-red-500",    label: "text-red-700",    badge: "bg-red-500" },
  sunday:        { bg: "bg-blue-50",   border: "border-blue-200",  ring: "ring-blue-400",   label: "text-blue-700",   badge: "bg-blue-400" },
  saturday_off:  { bg: "bg-emerald-50",border: "border-emerald-200",ring:"ring-emerald-400",label: "text-emerald-700",badge: "bg-emerald-400" },
};

export default function HolidayCalendar() {
  const { user } = useAuth();
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  const role = user?.role || "employee";

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await API.get("/holidays/calendar", { params: { year, role } });
      setData(res.data);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchData(); }, [year, role]); // eslint-disable-line react-hooks/exhaustive-deps

  // Map { 'YYYY-MM-DD': dayInfo } for fast lookup
  const dayMap = useMemo(() => {
    const m = {};
    for (const d of data) m[d.date] = d;
    return m;
  }, [data]);

  // Build month grid (cells)
  const monthGrid = useMemo(() => {
    const first = new Date(year, month, 1);
    const last = new Date(year, month + 1, 0);
    const startWeekday = first.getDay(); // 0=Sun
    const daysInMonth = last.getDate();
    const cells = [];
    // Leading blanks
    for (let i = 0; i < startWeekday; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      const dt = new Date(year, month, d);
      const iso = dt.toISOString().split("T")[0];
      cells.push({ day: d, iso, info: dayMap[iso] });
    }
    // Pad to 42 (6 rows × 7)
    while (cells.length < 42) cells.push(null);
    return cells;
  }, [year, month, dayMap]);

  // Holidays only for the right-side list
  const monthHolidays = data.filter(d => {
    const [y, m] = d.date.split("-").map(Number);
    return y === year && m - 1 === month;
  });

  const monthHolidayCount = monthHolidays.filter(h => h.type === "holiday").length;
  const totalNonWorking = monthGrid.filter(c => c?.info).length;

  const prev = () => {
    if (month === 0) { setMonth(11); setYear(y => y - 1); }
    else setMonth(m => m - 1);
  };
  const next = () => {
    if (month === 11) { setMonth(0); setYear(y => y + 1); }
    else setMonth(m => m + 1);
  };

  return (
    <div style={{ fontFamily: "'Work Sans', sans-serif" }}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-[#1E2A47]" style={{ fontFamily: "'Outfit', sans-serif" }}>
            Holiday Calendar
          </h1>
          <p className="text-slate-500 text-sm">
            Holidays, weekly offs, and 1st/3rd Saturday for {role === "employee" ? "office staff" : role.replace("_", " ")}
          </p>
        </div>
        <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg p-1">
          <button onClick={prev} data-testid="cal-prev"
            className="p-2 rounded-md hover:bg-slate-100 text-slate-500"><ChevronLeft size={16} /></button>
          <div className="px-3 text-sm font-semibold text-[#1E2A47] min-w-[140px] text-center" data-testid="cal-month-label">
            {MONTHS[month]} {year}
          </div>
          <button onClick={next} data-testid="cal-next"
            className="p-2 rounded-md hover:bg-slate-100 text-slate-500"><ChevronRight size={16} /></button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        {/* Calendar grid */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 grid grid-cols-7 gap-1">
            {DAY_LABELS.map(d => (
              <div key={d} className="text-center text-[11px] font-bold uppercase tracking-wider text-slate-500">{d}</div>
            ))}
          </div>
          {loading ? (
            <div className="p-12 text-center text-slate-400 text-sm">Loading...</div>
          ) : (
            <div className="p-2 grid grid-cols-7 gap-1.5">
              {monthGrid.map((cell, i) => {
                if (!cell) return <div key={`pad-${i}`} className="aspect-square" />;
                const style = cell.info ? TYPE_STYLES[cell.info.type] || TYPE_STYLES.holiday : null;
                const isToday = cell.iso === today.toISOString().split("T")[0];
                return (
                  <div key={cell.iso}
                    title={cell.info ? `${cell.info.label}` : ""}
                    data-testid={`cal-cell-${cell.iso}`}
                    className={`aspect-square p-2 rounded-lg border text-sm relative
                      ${style ? `${style.bg} ${style.border}` : "bg-white border-slate-100"}
                      ${isToday ? "ring-2 ring-[#E85B1E]" : ""}
                      flex flex-col justify-between transition-all hover:scale-[1.02] hover:shadow-md`}>
                    <div className="flex items-start justify-between gap-1">
                      <span className={`font-semibold ${style ? style.label : "text-slate-700"}`}>{cell.day}</span>
                      {style && <span className={`w-2 h-2 rounded-full ${style.badge}`} />}
                    </div>
                    {cell.info?.type === "holiday" && (
                      <p className="text-[10px] leading-tight font-semibold text-red-700 line-clamp-2">{cell.info.label}</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Side panel */}
        <div className="space-y-4">
          {/* Legend */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">Legend</p>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs">
                <span className="w-3 h-3 rounded-full bg-red-500" />
                <span className="text-slate-600">Public/Festival Holiday</span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className="w-3 h-3 rounded-full bg-blue-400" />
                <span className="text-slate-600">Sunday (off for all)</span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className="w-3 h-3 rounded-full bg-emerald-400" />
                <span className="text-slate-600">1st/3rd Saturday (Employee role only)</span>
              </div>
            </div>
          </div>

          {/* Stats */}
          <div className="bg-gradient-to-br from-[#1E2A47] to-[#2a3a5c] rounded-xl p-4 text-white">
            <p className="text-xs uppercase tracking-wider opacity-70">{MONTHS[month]} {year}</p>
            <p className="text-3xl font-bold mt-1" style={{ fontFamily: "'Outfit', sans-serif" }}>
              {totalNonWorking} <span className="text-sm font-normal opacity-70">non-working</span>
            </p>
            <p className="text-xs opacity-80 mt-1">
              {monthHolidayCount} {monthHolidayCount === 1 ? "holiday" : "holidays"} this month
            </p>
          </div>

          {/* This month's holidays */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3 flex items-center gap-1.5">
              <Sparkles size={12} /> Holidays this month
            </p>
            {monthHolidays.filter(h => h.type === "holiday").length === 0 ? (
              <p className="text-xs text-slate-400 italic">No holidays in {MONTHS[month]}.</p>
            ) : (
              <div className="space-y-2">
                {monthHolidays.filter(h => h.type === "holiday").map(h => {
                  const d = new Date(h.date);
                  return (
                    <div key={h.date} className="flex items-start gap-2 text-xs" data-testid={`holiday-list-${h.date}`}>
                      <div className="bg-red-50 border border-red-200 rounded-md w-10 text-center py-1 flex-shrink-0">
                        <p className="text-[9px] font-bold text-red-600 uppercase">{d.toLocaleDateString("en-IN",{ weekday: "short" })}</p>
                        <p className="text-sm font-bold text-red-700 leading-none">{d.getDate()}</p>
                      </div>
                      <div className="min-w-0">
                        <p className="font-semibold text-slate-700 leading-tight">{h.label}</p>
                        <p className="text-[10px] text-slate-400 capitalize mt-0.5">{h.subtype || "festival"}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Year jump */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
            <label className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2 block">Jump to year</label>
            <div className="flex gap-2">
              {[year - 1, year, year + 1].map(y => (
                <button key={y} onClick={() => setYear(y)} data-testid={`year-${y}`}
                  className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-colors ${y === year ? "bg-[#E85B1E] text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
                  {y}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
