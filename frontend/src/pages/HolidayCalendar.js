import React, { useEffect, useState, useMemo } from "react";
import API from "../utils/api";
import { useAuth } from "../contexts/AuthContext";
import { ChevronLeft, ChevronRight, Calendar as CalIcon, Sparkles } from "lucide-react";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const TYPE_STYLES = {
  holiday:       { bg: "bg-red-50",    border: "border-red-300",   ring: "ring-red-500",    label: "text-red-700",    badge: "bg-red-500" },
  sunday:        { bg: "bg-blue-50",   border: "border-blue-200",  ring: "ring-blue-400",   label: "text-blue-700",   badge: "bg-blue-400" },
  saturday_off:  { bg: "bg-emerald-50",border: "border-emerald-200",ring:"ring-emerald-400",label: "text-emerald-700",badge: "bg-emerald-400" },
};

// Per-leave-type theme for the SELF-overlay cell tint and pill
const LEAVE_THEMES = {
  SL: { bg: "bg-rose-50",    border: "border-rose-300",    label: "text-rose-700",    pill: "bg-rose-500/90 text-white",    name: "Sick" },
  CL: { bg: "bg-amber-50",   border: "border-amber-300",   label: "text-amber-700",   pill: "bg-amber-500/90 text-white",   name: "Casual" },
  EL: { bg: "bg-violet-50",  border: "border-violet-300",  label: "text-violet-700",  pill: "bg-violet-500/90 text-white",  name: "Earned" },
  CO: { bg: "bg-teal-50",    border: "border-teal-300",    label: "text-teal-700",    pill: "bg-teal-500/90 text-white",    name: "Comp-Off" },
  ML: { bg: "bg-pink-50",    border: "border-pink-300",    label: "text-pink-700",    pill: "bg-pink-500/90 text-white",    name: "Maternity" },
  PL: { bg: "bg-indigo-50",  border: "border-indigo-300",  label: "text-indigo-700",  pill: "bg-indigo-500/90 text-white",  name: "Paternity" },
  LOP:{ bg: "bg-slate-100",  border: "border-slate-300",   label: "text-slate-700",   pill: "bg-slate-600/90 text-white",   name: "LOP" },
};
const DEFAULT_LEAVE_THEME = { bg: "bg-slate-50", border: "border-slate-300", label: "text-slate-700", pill: "bg-slate-500/90 text-white", name: "Leave" };

const ABSENT_THEME = { bg: "bg-red-100", border: "border-red-400", label: "text-red-800", pill: "bg-red-600 text-white" };

export default function HolidayCalendar() {
  const { user } = useAuth();
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  const role = user?.role || "employee";
  const meId = user?.employee_id || null;
  const canSeeTeamOverlay = ["hr_admin", "management", "managers"].includes(role);
  const [leaves, setLeaves] = useState([]);
  const [myAttendance, setMyAttendance] = useState([]);
  const [hoveredCell, setHoveredCell] = useState(null);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await API.get("/holidays/calendar", { params: { year, role } });
      setData(res.data);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  // Approved leaves overlapping the visible month.
  // Backend scopes automatically: employee→own, manager→reports+self, admin→all.
  const fetchLeaves = async () => {
    const monthStart = `${year}-${String(month + 1).padStart(2, "0")}-01`;
    const lastDay = new Date(year, month + 1, 0).getDate();
    const monthEnd = `${year}-${String(month + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    try {
      const res = await API.get("/leaves/calendar-overlay", {
        params: { date_from: monthStart, date_to: monthEnd },
      });
      setLeaves(res.data || []);
    } catch (e) { console.error(e); setLeaves([]); }
  };

  // Own attendance for the visible month (used to highlight Absent days).
  const fetchMyAttendance = async () => {
    if (!meId) { setMyAttendance([]); return; }
    try {
      const res = await API.get("/attendance/my", { params: { month: month + 1, year } });
      setMyAttendance(res.data || []);
    } catch (e) { console.error(e); setMyAttendance([]); }
  };

  useEffect(() => { fetchData(); }, [year, role]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { fetchLeaves(); fetchMyAttendance(); }, [year, month, meId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Map { 'YYYY-MM-DD': dayInfo } for fast lookup
  const dayMap = useMemo(() => {
    const m = {};
    for (const d of data) m[d.date] = d;
    return m;
  }, [data]);

  // Local-timezone-safe ISO date helper (avoids the toISOString UTC shift bug)
  const toLocalISO = (y, m, d) =>
    `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

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
      const iso = toLocalISO(year, month, d);
      cells.push({ day: d, iso, info: dayMap[iso] });
    }
    // Pad to 42 (6 rows × 7)
    while (cells.length < 42) cells.push(null);
    return cells;
  }, [year, month, dayMap]);

  // Map of YYYY-MM-DD → array of leaves on that day
  const leavesByDay = useMemo(() => {
    const m = {};
    for (const l of leaves) {
      const start = new Date(l.from_date + "T00:00:00");
      const end = new Date(l.to_date + "T00:00:00");
      const cur = new Date(start);
      while (cur <= end) {
        const iso = toLocalISO(cur.getFullYear(), cur.getMonth(), cur.getDate());
        if (!m[iso]) m[iso] = [];
        m[iso].push(l);
        cur.setDate(cur.getDate() + 1);
      }
    }
    return m;
  }, [leaves]);

  // Pull out the current user's own approved leaves per day (for self-cell tint)
  const myLeaveByDay = useMemo(() => {
    if (!meId) return {};
    const out = {};
    for (const [iso, list] of Object.entries(leavesByDay)) {
      const mine = list.find(l => l.employee_id === meId);
      if (mine) out[iso] = mine;
    }
    return out;
  }, [leavesByDay, meId]);

  // Map of YYYY-MM-DD → my attendance status
  const myAttendanceByDay = useMemo(() => {
    const m = {};
    for (const r of myAttendance) {
      if (r?.date) m[r.date] = r;
    }
    return m;
  }, [myAttendance]);

  // Holidays only for the right-side list
  const monthHolidays = data.filter(d => {
    const [y, m] = d.date.split("-").map(Number);
    return y === year && m - 1 === month;
  });

  const monthHolidayCount = monthHolidays.filter(h => h.type === "holiday").length;
  const totalNonWorking = monthGrid.filter(c => c?.info).length;

  // Personal stats for the visible month
  const myMonthLeaveDays = useMemo(() => {
    const prefix = `${year}-${String(month + 1).padStart(2, "0")}-`;
    return Object.keys(myLeaveByDay).filter(iso => iso.startsWith(prefix)).length;
  }, [myLeaveByDay, year, month]);

  const myMonthAbsentDays = useMemo(() => {
    return Object.values(myAttendanceByDay).filter(r => r.status === "absent").length;
  }, [myAttendanceByDay]);

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
          <div className="px-2 sm:px-4 py-2 sm:py-3 border-b border-slate-100 grid grid-cols-7 gap-1 sm:gap-1.5">
            {DAY_LABELS.map(d => (
              <div key={d} className="text-center text-[10px] sm:text-[11px] font-bold uppercase tracking-wider text-slate-500">{d}</div>
            ))}
          </div>
          {loading ? (
            <div className="p-12 text-center text-slate-400 text-sm">Loading...</div>
          ) : (
            <div className="p-1.5 sm:p-2 grid grid-cols-7 gap-1 sm:gap-1.5">
              {monthGrid.map((cell, i) => {
                if (!cell) return <div key={`pad-${i}`} className="aspect-square" />;

                const baseStyle = cell.info ? TYPE_STYLES[cell.info.type] || TYPE_STYLES.holiday : null;
                const isToday = cell.iso === toLocalISO(today.getFullYear(), today.getMonth(), today.getDate());
                const onLeave = leavesByDay[cell.iso] || [];

                // Self markers take precedence on the cell tint
                const myLeave = myLeaveByDay[cell.iso];
                const myAtt = myAttendanceByDay[cell.iso];
                const isMyAbsent = myAtt?.status === "absent";

                // Pick the cell tint:
                //   Holiday/Sunday/Sat-off (from base) wins ONLY when the user has nothing personal that day.
                //   My own approved leave → leave-type tint.
                //   My absent → red tint.
                let cellBg = "bg-white border-slate-100";
                let cellLabel = "text-slate-700";
                if (myLeave) {
                  const t = LEAVE_THEMES[myLeave.leave_type] || DEFAULT_LEAVE_THEME;
                  cellBg = `${t.bg} ${t.border}`;
                  cellLabel = t.label;
                } else if (isMyAbsent) {
                  cellBg = `${ABSENT_THEME.bg} ${ABSENT_THEME.border}`;
                  cellLabel = ABSENT_THEME.label;
                } else if (baseStyle) {
                  cellBg = `${baseStyle.bg} ${baseStyle.border}`;
                  cellLabel = baseStyle.label;
                }

                // Team overlay: filter out OWN leave to avoid double-rendering for managers/admins
                const teamOnLeave = canSeeTeamOverlay
                  ? onLeave.filter(l => l.employee_id !== meId)
                  : [];

                return (
                  <div key={cell.iso}
                    onMouseEnter={() => (teamOnLeave.length || myLeave) && setHoveredCell(cell.iso)}
                    onMouseLeave={() => setHoveredCell(null)}
                    onClick={() => (teamOnLeave.length || myLeave || isMyAbsent) && setHoveredCell(c => c === cell.iso ? null : cell.iso)}
                    title={cell.info ? `${cell.info.label}` : ""}
                    data-testid={`cal-cell-${cell.iso}`}
                    className={`aspect-square p-1 sm:p-2 rounded-md sm:rounded-lg border text-xs sm:text-sm relative overflow-hidden
                      ${cellBg}
                      ${isToday ? "ring-2 ring-[#E85B1E]" : ""}
                      flex flex-col justify-between transition-all hover:shadow-md sm:hover:scale-[1.02]`}>
                    <div className="flex items-start justify-between gap-0.5 min-w-0">
                      <span className={`font-semibold leading-none ${cellLabel}`}>{cell.day}</span>
                      {/* Top-right corner marker priority: my-leave > absent > base */}
                      {myLeave ? (
                        <span
                          data-testid={`my-leave-${cell.iso}`}
                          className={`text-[7px] sm:text-[8px] font-bold px-1 sm:px-1.5 py-0.5 rounded-full leading-none flex-shrink-0 ${(LEAVE_THEMES[myLeave.leave_type] || DEFAULT_LEAVE_THEME).pill}`}
                        >
                          {myLeave.leave_type || "LV"}
                        </span>
                      ) : isMyAbsent ? (
                        <span
                          data-testid={`my-absent-${cell.iso}`}
                          className={`text-[7px] sm:text-[8px] font-bold px-1 sm:px-1.5 py-0.5 rounded-full leading-none flex-shrink-0 ${ABSENT_THEME.pill}`}
                        >
                          ABS
                        </span>
                      ) : baseStyle ? (
                        <span className={`w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full flex-shrink-0 ${baseStyle.badge}`} />
                      ) : null}
                    </div>

                    {cell.info?.type === "holiday" && !myLeave && !isMyAbsent && (
                      <p className="hidden sm:block text-[10px] leading-tight font-semibold text-red-700 line-clamp-2">{cell.info.label}</p>
                    )}

                    {/* Team overlay — initials avatars (managers/hr_admin only, OTHER employees) */}
                    {teamOnLeave.length > 0 && (
                      <div className="flex items-end gap-0.5 mt-auto min-w-0 flex-nowrap overflow-hidden" data-testid={`cell-leaves-${cell.iso}`}>
                        {/* Mobile: show only 1; Desktop: show 3 */}
                        {teamOnLeave.slice(0, 1).map((lv, idx) => (
                          <span key={`${lv.id}-${idx}-m`}
                            title={`${lv.employee_name} • ${lv.leave_type} (${lv.from_date} → ${lv.to_date})`}
                            className={`sm:hidden inline-flex items-center justify-center text-[7px] font-bold rounded-full w-3.5 h-3.5 flex-shrink-0 ${
                              lv.leave_type === "SL" ? "bg-rose-200 text-rose-800" :
                              lv.leave_type === "CL" ? "bg-amber-200 text-amber-800" :
                              lv.leave_type === "EL" ? "bg-violet-200 text-violet-800" :
                              "bg-slate-200 text-slate-700"
                            }`}>
                            {lv.initials}
                          </span>
                        ))}
                        {teamOnLeave.length > 1 && (
                          <span className="sm:hidden text-[7px] font-bold text-slate-500 leading-none">+{teamOnLeave.length - 1}</span>
                        )}
                        {teamOnLeave.slice(0, 3).map((lv, idx) => (
                          <span key={`${lv.id}-${idx}-d`}
                            title={`${lv.employee_name} • ${lv.leave_type} (${lv.from_date} → ${lv.to_date})`}
                            className={`hidden sm:inline-flex items-center justify-center text-[8px] font-bold rounded-full w-4 h-4 flex-shrink-0 ${
                              lv.leave_type === "SL" ? "bg-rose-200 text-rose-800" :
                              lv.leave_type === "CL" ? "bg-amber-200 text-amber-800" :
                              lv.leave_type === "EL" ? "bg-violet-200 text-violet-800" :
                              "bg-slate-200 text-slate-700"
                            }`}>
                            {lv.initials}
                          </span>
                        ))}
                        {teamOnLeave.length > 3 && (
                          <span className="hidden sm:inline text-[8px] font-bold text-slate-500">+{teamOnLeave.length - 3}</span>
                        )}
                      </div>
                    )}

                    {/* Hover/click popover with details */}
                    {hoveredCell === cell.iso && (teamOnLeave.length > 0 || myLeave) && (
                      <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 z-30 pointer-events-none max-w-[90vw]">
                        <div className="bg-white border border-slate-200 shadow-xl rounded-lg p-2.5 min-w-[180px] sm:min-w-[200px] text-left">
                          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">
                            {cell.iso}
                          </p>
                          {myLeave && (
                            <div className="text-[11px] leading-tight mb-1.5 pb-1.5 border-b border-slate-100">
                              <p className="font-semibold text-slate-800">You · On leave</p>
                              <p className="text-slate-500">
                                <span className="font-semibold">{(LEAVE_THEMES[myLeave.leave_type] || DEFAULT_LEAVE_THEME).name}</span>
                                <span className="text-slate-400"> · {myLeave.from_date.slice(5)} → {myLeave.to_date.slice(5)}</span>
                              </p>
                            </div>
                          )}
                          {teamOnLeave.map(lv => (
                            <div key={lv.id} className="text-[11px] leading-tight mb-1.5 last:mb-0">
                              <p className="font-semibold text-slate-700 truncate">{lv.employee_name}</p>
                              <p className="text-slate-500">
                                <span className="font-mono text-[#E85B1E]">{lv.employee_id}</span> · {lv.leave_type}
                                <span className="text-slate-400"> · {lv.from_date.slice(5)} → {lv.to_date.slice(5)}</span>
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
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

              {meId && (
                <div className="border-t border-slate-100 mt-2 pt-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">Your markers</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-rose-500/90 text-white">SL</span>
                      <span className="text-slate-600">Sick</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-amber-500/90 text-white">CL</span>
                      <span className="text-slate-600">Casual</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-violet-500/90 text-white">EL</span>
                      <span className="text-slate-600">Earned</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-teal-500/90 text-white">CO</span>
                      <span className="text-slate-600">Comp-Off</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px] col-span-2">
                      <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-red-600 text-white">ABS</span>
                      <span className="text-slate-600">Marked Absent</span>
                    </div>
                  </div>
                </div>
              )}

              {canSeeTeamOverlay && (
                <div className="border-t border-slate-100 mt-2 pt-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">Team on leave (initials)</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <span className="inline-flex items-center justify-center text-[8px] font-bold rounded-full w-4 h-4 bg-rose-200 text-rose-800">SL</span>
                      <span className="text-slate-600">Sick</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <span className="inline-flex items-center justify-center text-[8px] font-bold rounded-full w-4 h-4 bg-amber-200 text-amber-800">CL</span>
                      <span className="text-slate-600">Casual</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <span className="inline-flex items-center justify-center text-[8px] font-bold rounded-full w-4 h-4 bg-violet-200 text-violet-800">EL</span>
                      <span className="text-slate-600">Earned</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <span className="inline-flex items-center justify-center text-[8px] font-bold rounded-full w-4 h-4 bg-slate-200 text-slate-700">··</span>
                      <span className="text-slate-600">Other</span>
                    </div>
                  </div>
                </div>
              )}
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
            {meId && (myMonthLeaveDays > 0 || myMonthAbsentDays > 0) && (
              <div className="mt-3 pt-3 border-t border-white/10 flex gap-4 text-xs">
                {myMonthLeaveDays > 0 && (
                  <div data-testid="my-month-leave-count">
                    <p className="opacity-70">On Leave</p>
                    <p className="text-lg font-bold">{myMonthLeaveDays}d</p>
                  </div>
                )}
                {myMonthAbsentDays > 0 && (
                  <div data-testid="my-month-absent-count">
                    <p className="opacity-70">Absent</p>
                    <p className="text-lg font-bold text-red-300">{myMonthAbsentDays}d</p>
                  </div>
                )}
              </div>
            )}
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

          {/* My approved leaves this month — visible to all employees */}
          {meId && (() => {
            const prefix = `${year}-${String(month + 1).padStart(2, "0")}-`;
            const myMonthLeaves = leaves
              .filter(l => l.employee_id === meId)
              .filter(l => (l.from_date && l.from_date <= `${prefix}31`) && (l.to_date && l.to_date >= `${prefix}01`))
              .sort((a, b) => a.from_date.localeCompare(b.from_date));
            if (myMonthLeaves.length === 0) return null;
            return (
              <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm" data-testid="my-leaves-panel">
                <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3 flex items-center gap-1.5">
                  <CalIcon size={12} /> My approved leaves
                </p>
                <div className="space-y-2 max-h-[200px] overflow-y-auto pr-1">
                  {myMonthLeaves.map(lv => {
                    const t = LEAVE_THEMES[lv.leave_type] || DEFAULT_LEAVE_THEME;
                    return (
                      <div key={lv.id} className="flex items-start gap-2 text-xs" data-testid={`my-leave-row-${lv.id}`}>
                        <span className={`text-[9px] font-bold px-1.5 py-1 rounded ${t.pill}`}>{lv.leave_type}</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-slate-700">{t.name}</p>
                          <p className="text-[11px] text-slate-500">
                            {lv.from_date.slice(5)} → {lv.to_date.slice(5)} · {lv.days}d
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {/* Team on leave this month (managers/admin only) */}
          {canSeeTeamOverlay && leaves.filter(l => l.employee_id !== meId).length > 0 && (
            <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm" data-testid="team-leaves-panel">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3 flex items-center gap-1.5">
                <CalIcon size={12} /> {role === "managers" ? "Team" : "Employees"} on leave
              </p>
              <div className="space-y-2 max-h-[260px] overflow-y-auto pr-1">
                {leaves
                  .filter(l => l.employee_id !== meId)
                  .sort((a, b) => a.from_date.localeCompare(b.from_date))
                  .map(lv => {
                    const typeColor =
                      lv.leave_type === "SL" ? "bg-rose-200 text-rose-800" :
                      lv.leave_type === "CL" ? "bg-amber-200 text-amber-800" :
                      lv.leave_type === "EL" ? "bg-violet-200 text-violet-800" :
                      "bg-slate-200 text-slate-700";
                    return (
                      <div key={lv.id} className="flex items-start gap-2 text-xs" data-testid={`team-leave-${lv.id}`}>
                        <span className={`inline-flex items-center justify-center text-[9px] font-bold rounded-full w-7 h-7 ${typeColor}`}>
                          {lv.initials}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-slate-700 truncate">{lv.employee_name}</p>
                          <p className="text-[11px] text-slate-500">
                            <span className={`px-1.5 py-0.5 rounded ${typeColor} font-semibold`}>{lv.leave_type}</span>
                            <span className="ml-1.5">{lv.from_date.slice(5)} → {lv.to_date.slice(5)}</span>
                            <span className="text-slate-400"> · {lv.days}d</span>
                          </p>
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
