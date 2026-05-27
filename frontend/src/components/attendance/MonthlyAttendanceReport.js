import React, { useEffect, useState, useCallback } from "react";
import API from "../../utils/api";
import { Calendar, ChevronLeft, ChevronRight, User, TrendingDown, Clock, CheckCircle, XCircle, AlertCircle, Loader } from "lucide-react";
import { AttendanceStatusBadge } from "./StatusBadge";

/* ── helpers ──────────────────────────────────────────────────── */
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function daysInMonth(year, month) {
  const dates = [];
  const d = new Date(year, month - 1, 1);
  while (d.getMonth() === month - 1) {
    dates.push(d.toISOString().split("T")[0]);
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

function fmtTime(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }); }
  catch { return "—"; }
}

function leavesCovering(leaves, dateStr) {
  return leaves.find(l => {
    const s = l.start_date || l.from_date || "";
    const e = l.end_date || l.to_date || "";
    return s <= dateStr && dateStr <= e && l.status === "approved";
  });
}

/* ── Saturday WO helpers (shared logic) ─────────────────────── */
function getNthSaturday(year, month, n) {
  const d = new Date(year, month - 1, 1);
  while (d.getDay() !== 6) d.setDate(d.getDate() + 1);
  d.setDate(d.getDate() + (n - 1) * 7);
  return d.getMonth() === month - 1 ? d.toISOString().split("T")[0] : null;
}

function isWeeklyOff(dateStr, dow, satRule, year, month) {
  if (dow === 0) return true;
  if (dow !== 6) return false;
  if (!satRule || satRule === "all_working") return false;
  if (satRule === "all_off") return true;
  let idx = 0;
  for (let n = 1; n <= 5; n++) { if (getNthSaturday(year, month, n) === dateStr) { idx = n; break; } }
  if (satRule === "alt_1_3_off") return idx === 1 || idx === 3 || idx === 5;
  if (satRule === "alt_2_4_off") return idx === 2 || idx === 4;
  return false;
}

function resolveShiftSatRule(shifts, emp) {
  if (!shifts?.length || !emp) return "all_working";
  if (emp.shift_id) {
    const s = shifts.find(sh => sh.id === emp.shift_id);
    if (s) return s.saturday_rule || "all_working";
  }
  const byRole = shifts.find(sh => sh.assigned_roles?.includes(emp.role));
  if (byRole) return byRole.saturday_rule || "all_working";
  const def = shifts.find(sh => sh.is_default);
  return def?.saturday_rule || "all_working";
}

const STATUS_ROW = {
  present:     "bg-green-50  hover:bg-green-100",
  half_day:    "bg-amber-50  hover:bg-amber-100",
  absent:      "bg-red-50    hover:bg-red-100",
  lop:         "bg-rose-100  hover:bg-rose-200",
  leave:       "bg-sky-50    hover:bg-sky-100",
  weekly_off:  "bg-slate-50  hover:bg-slate-100",
  holiday:     "bg-purple-50 hover:bg-purple-100",
  future:      "opacity-40",
};

/* ── summary card ─────────────────────────────────────────────── */
function StatPill({ label, value, color, icon: Icon }) {
  return (
    <div className={`flex flex-col items-center justify-center rounded-xl p-3 min-w-[76px] ${color}`}>
      {Icon && <Icon size={16} className="mb-1 opacity-70" />}
      <p className="text-xl font-extrabold leading-none" style={{ fontFamily: "'Outfit', sans-serif" }}>{value}</p>
      <p className="text-[10px] font-semibold mt-0.5 uppercase tracking-wide opacity-70">{label}</p>
    </div>
  );
}

/* ── main component ───────────────────────────────────────────── */
export function MonthlyAttendanceReport({ user }) {
  const isPrivileged = ["hr_admin", "management"].includes(user?.role);
  const isManager    = user?.role === "managers";

  const now = new Date();
  const [year,  setYear]  = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [empId, setEmpId] = useState(user?.employee_id || "");
  const [empSearch, setEmpSearch] = useState("");
  const [employees, setEmployees]   = useState([]);
  const [records,   setRecords]     = useState([]);
  const [leaves,    setLeaves]      = useState([]);
  const [holidays,  setHolidays]    = useState(new Set());
  const [shifts,    setShifts]      = useState([]);
  const [empObj,    setEmpObj]      = useState(null); // full employee doc for shift resolution
  const [loading,   setLoading]     = useState(false);
  const [empName,   setEmpName]     = useState("");

  /* load employee list for selectors */
  useEffect(() => {
    if (!isPrivileged && !isManager) return;
    API.get("/employees?status=all&limit=500")
      .then(r => setEmployees(r.data || []))
      .catch(() => {});
  }, [isPrivileged, isManager]);

  /* resolve display name */
  useEffect(() => {
    if (!empId) return;
    const found = employees.find(e => e.employee_id === empId);
    if (found) setEmpName(`${found.first_name} ${found.last_name || ""}`.trim());
    else if (user?.employee_id === empId) setEmpName(user?.name || user?.username || empId);
    else setEmpName(empId);
  }, [empId, employees, user]);

  /* fetch data whenever employee / month / year changes */
  const fetchData = useCallback(async () => {
    if (!empId) return;
    setLoading(true);
    try {
      const pad   = n => String(n).padStart(2, "0");
      const from  = `${year}-${pad(month)}-01`;
      const daysT = new Date(year, month, 0).getDate();
      const to    = `${year}-${pad(month)}-${pad(daysT)}`;

      const [attRes, leaveRes, holRes, shiftRes, empRes] = await Promise.all([
        API.get("/attendance", { params: { employee_id: empId, date_from: from, date_to: to, limit: 100 } }),
        API.get("/leaves",     { params: { employee_id: empId } }),
        API.get("/holidays",   { params: { year } }),
        API.get("/shifts"),
        API.get(`/employees/${empId}`).catch(() => ({ data: null })),
      ]);

      setRecords(attRes.data || []);
      setLeaves(leaveRes.data || []);
      const holDates = new Set((holRes.data || []).map(h => h.date));
      setHolidays(holDates);
      setShifts(shiftRes.data || []);
      setEmpObj(empRes.data || null);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [empId, year, month]);

  useEffect(() => { fetchData(); }, [fetchData]);

  /* navigate months */
  const prevMonth = () => {
    if (month === 1) { setMonth(12); setYear(y => y - 1); }
    else setMonth(m => m - 1);
  };
  const nextMonth = () => {
    const today = new Date();
    if (year > today.getFullYear() || (year === today.getFullYear() && month >= today.getMonth() + 1)) return;
    if (month === 12) { setMonth(1); setYear(y => y + 1); }
    else setMonth(m => m + 1);
  };

  /* build day-by-day rows */
  const today = new Date().toISOString().split("T")[0];
  const recMap = Object.fromEntries(records.map(r => [r.date, r]));
  const allDates = daysInMonth(year, month);
  const empSatRule = resolveShiftSatRule(shifts, empObj);

  const rows = allDates.map(dateStr => {
    const dow  = new Date(dateStr).getDay();
    const isFuture  = dateStr > today;
    const isSunday  = dow === 0;
    const isWO      = isWeeklyOff(dateStr, dow, empSatRule, year, month);
    const isHoliday = holidays.has(dateStr);
    const rec       = recMap[dateStr];
    const leave     = leavesCovering(leaves, dateStr);

    let status = rec?.status;
    let leaveType = leave?.leave_type || "";

    if (!status) {
      if (isWO)       status = "weekly_off";
      else if (isHoliday) status = "holiday";
      else if (leave)  status = "leave";
      else if (!isFuture) status = "absent";
      else status = "future";
    }
    if (status === "leave" && leave) leaveType = leave.leave_type;

    return { dateStr, dow, isFuture, isSunday, isWO, isHoliday, rec, leave, status, leaveType };
  });

  /* summary counts */
  const counts = rows.reduce((acc, r) => {
    const s = r.status;
    acc[s] = (acc[s] || 0) + 1;
    if (s === "half_day") acc.present = (acc.present || 0) + 0.5;
    return acc;
  }, {});
  const workingDays = allDates.filter(d => {
    const dow = new Date(d).getDay();
    return !isWeeklyOff(d, dow, empSatRule, year, month) && !holidays.has(d) && d <= today;
  }).length;
  const totalHours = records.reduce((sum, r) => sum + (r.hours_worked && r.hours_worked > 0 ? r.hours_worked : 0), 0);
  const lopDays    = rows.filter(r => r.rec?.lop || r.status === "lop").length;

  /* month label */
  const monthLabel = new Date(year, month - 1, 1).toLocaleString("en-IN", { month: "long", year: "numeric" });

  /* filtered employee list for dropdown */
  const filteredEmps = employees.filter(e =>
    !empSearch ||
    `${e.first_name} ${e.last_name || ""} ${e.employee_id}`.toLowerCase().includes(empSearch.toLowerCase())
  );

  return (
    <div className="space-y-4" data-testid="monthly-report">

      {/* Controls */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap gap-3 items-end">

        {/* Employee selector — only for privileged */}
        {(isPrivileged || isManager) && (
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
              <User size={11} className="inline mr-1" />Employee
            </label>
            <div className="relative">
              <select
                value={empId}
                onChange={e => setEmpId(e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-[#E85B1E] outline-none appearance-none pr-8"
                data-testid="monthly-emp-select"
              >
                <option value="">— Select employee —</option>
                {employees.map(e => (
                  <option key={e.employee_id} value={e.employee_id}>
                    {e.employee_id} · {e.first_name} {e.last_name || ""}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* Month navigator */}
        <div>
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
            <Calendar size={11} className="inline mr-1" />Month
          </label>
          <div className="flex items-center gap-2">
            <button onClick={prevMonth} className="p-2 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-600" data-testid="prev-month">
              <ChevronLeft size={16} />
            </button>
            <span className="font-semibold text-[#1E2A47] text-sm min-w-[140px] text-center" style={{ fontFamily: "'Outfit', sans-serif" }}>
              {monthLabel}
            </span>
            <button onClick={nextMonth} className="p-2 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-600" data-testid="next-month">
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </div>

      {!empId ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center text-slate-400 text-sm">
          Select an employee to view the monthly report.
        </div>
      ) : loading ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 flex items-center justify-center gap-3 text-slate-400 text-sm">
          <Loader size={18} className="animate-spin" /> Loading attendance data…
        </div>
      ) : (
        <>
          {/* Summary strip */}
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">
              {empName} · {monthLabel}
            </p>
            <div className="flex flex-wrap gap-2">
              <StatPill label="Working"  value={workingDays}              color="bg-slate-100 text-slate-700"   />
              <StatPill label="Present"  value={(counts.present || 0) + (counts.half_day ? (counts.half_day * 0.5) : 0)} color="bg-green-100 text-green-800"   icon={CheckCircle} />
              <StatPill label="Absent"   value={counts.absent   || 0}     color="bg-red-100 text-red-800"       icon={XCircle} />
              <StatPill label="Leave"    value={counts.leave    || 0}     color="bg-sky-100 text-sky-800"       />
              <StatPill label="Half Day" value={counts.half_day || 0}     color="bg-amber-100 text-amber-800"   icon={AlertCircle} />
              <StatPill label="LOP"      value={lopDays}                  color="bg-rose-100 text-rose-800"     icon={TrendingDown} />
              <StatPill label="Holidays" value={counts.holiday  || 0}     color="bg-purple-100 text-purple-800" />
              <StatPill label="Hrs Wkd"  value={`${totalHours.toFixed(1)}h`} color="bg-indigo-100 text-indigo-800" icon={Clock} />
            </div>
          </div>

          {/* Day-by-day table */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="monthly-table">
                <thead>
                  <tr className="bg-[#1E2A47] text-white">
                    {["Date", "Day", "Status", "Punch In", "Punch Out", "Hours", "Leave / Note"].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider opacity-80">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ dateStr, dow, isFuture, status, rec, leaveType, isHoliday, isWO }) => {
                    const rowCls = STATUS_ROW[status] || "";
                    const isSun = dow === 0;
                    return (
                      <tr key={dateStr} className={`border-b border-slate-100 transition-colors ${rowCls}`} data-testid={`monthly-row-${dateStr}`}>
                        <td className="px-4 py-2.5 font-medium text-slate-700 whitespace-nowrap">
                          {dateStr}
                          {dateStr === today && <span className="ml-1.5 text-[9px] bg-[#E85B1E] text-white rounded-full px-1.5 py-0.5 font-bold">TODAY</span>}
                        </td>
                        <td className="px-4 py-2.5 text-slate-500 text-xs font-semibold">{DAYS[dow]}</td>
                        <td className="px-4 py-2.5">
                          {isFuture ? (
                            <span className="text-xs text-slate-400 italic">—</span>
                          ) : (
                            <AttendanceStatusBadge record={{ status, ...(rec || {}) }} />
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-slate-600 font-mono text-xs">{fmtTime(rec?.punch_in_time)}</td>
                        <td className="px-4 py-2.5 text-slate-600 font-mono text-xs">{fmtTime(rec?.punch_out_time)}</td>
                        <td className="px-4 py-2.5 text-slate-600 text-xs">
                          {rec?.hours_worked && rec.hours_worked > 0 ? `${rec.hours_worked}h` : "—"}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-slate-500">
                          {leaveType && <span className="inline-block bg-sky-100 text-sky-700 text-[10px] font-bold rounded px-1.5 py-0.5 mr-1">{leaveType}</span>}
                          {isHoliday && <span className="inline-block bg-purple-100 text-purple-700 text-[10px] font-bold rounded px-1.5 py-0.5">Holiday</span>}
                          {rec?.regularised && <span className="inline-block bg-amber-100 text-amber-700 text-[10px] font-bold rounded px-1.5 py-0.5">REG</span>}
                          {rec?.location_name && <span className="text-[10px] text-slate-400 ml-1">{rec.location_name}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Legend */}
          <div className="flex flex-wrap gap-2 text-[10px] font-semibold">
            {[["bg-green-100 text-green-700", "Present"],["bg-red-100 text-red-700","Absent"],
              ["bg-sky-100 text-sky-700","Leave"],["bg-amber-100 text-amber-700","Half Day"],
              ["bg-rose-100 text-rose-700","LOP"],["bg-purple-100 text-purple-700","Holiday"],
              ["bg-slate-100 text-slate-500","Weekly Off"]].map(([cls, label]) => (
              <span key={label} className={`px-2 py-1 rounded-full ${cls}`}>{label}</span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
