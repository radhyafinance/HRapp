import React, { useEffect, useState, useMemo, useCallback } from "react";
import API from "../../utils/api";
import { ChevronLeft, ChevronRight, Loader, Download } from "lucide-react";

/* ── constants ─────────────────────────────────────────────── */
const DAY_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

const FROZEN_WIDTHS = [76, 148, 108, 148]; // empId, name, dept, designation
const FROZEN_LEFTS  = FROZEN_WIDTHS.reduce((acc, w, i) => {
  acc.push(i === 0 ? 0 : acc[i - 1] + FROZEN_WIDTHS[i - 1]);
  return acc;
}, []);
const DATE_COL_W = 46;

/* ── helpers ────────────────────────────────────────────────── */
const pad = n => String(n).padStart(2, "0");

function buildDates(year, month) {
  const list = [];
  const d = new Date(year, month - 1, 1);
  while (d.getMonth() === month - 1) {
    list.push({ dateStr: d.toISOString().split("T")[0], dow: d.getDay() });
    d.setDate(d.getDate() + 1);
  }
  return list;
}

/** Expand multi-day leave into per-date entries */
function expandLeave(leave) {
  const s = leave.start_date || leave.from_date || "";
  const e = leave.end_date   || leave.to_date   || "";
  if (!s || !e) return [];
  const dates = [];
  const cur = new Date(s);
  const end = new Date(e);
  while (cur <= end) {
    dates.push(cur.toISOString().split("T")[0]);
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

function buildLeaveMap(leaves) {
  const m = {};
  for (const l of leaves) {
    if (l.status !== "approved") continue;
    const id = l.employee_id;
    if (!m[id]) m[id] = {};
    for (const d of expandLeave(l)) m[id][d] = l.leave_type || "L";
  }
  return m;
}

/** Return { code, color } for a cell */
function cellInfo(att, leaveType, dow, isHoliday, isFuture) {
  if (dow === 0) return { code: "WO",  color: "slate"  };
  if (isHoliday) return { code: "H",   color: "purple" };
  if (isFuture)  return { code: "",    color: "empty"  };

  if (att) {
    const { status, geofence_verified, regularised } = att;
    if (status === "present" || status === "full_day") {
      if (regularised)        return { code: "FD", color: "reg"    };
      if (!geofence_verified) return { code: "FD", color: "orange" };
                              return { code: "FD", color: "black"  };
    }
    if (status === "half_day") return { code: "HD", color: "amber"  };
    if (status === "leave") {
      const code = leaveType ? leaveType.substring(0, 3).toUpperCase() : "L";
      return { code, color: "blue" };
    }
    if (status === "absent") {
      if (leaveType) return { code: leaveType.substring(0, 3).toUpperCase(), color: "blue" };
      return { code: "A", color: "red" };
    }
    if (status === "weekly_off") return { code: "WO", color: "slate"  };
    if (status === "holiday")    return { code: "H",  color: "purple" };
  }

  if (leaveType) return { code: leaveType.substring(0, 3).toUpperCase(), color: "blue" };
  return { code: "A", color: "red" };
}

const COLOR_CLS = {
  black:  "text-slate-800 font-semibold",
  reg:    "text-blue-600 font-bold",
  orange: "text-orange-500 font-semibold",
  amber:  "text-amber-600 font-bold",
  red:    "text-red-600 font-bold",
  slate:  "text-slate-400",
  purple: "text-purple-500 font-semibold",
  blue:   "text-sky-600 font-semibold",
  empty:  "text-slate-200",
};

/* ── Cell component (memoised for perf) ─────────────────────── */
const Cell = React.memo(({ att, leaveType, dow, isHoliday, isFuture, dateStr, empId }) => {
  const { code, color } = cellInfo(att, leaveType, dow, isHoliday, isFuture);
  const bgCls = dow === 0 ? "bg-slate-50" : isHoliday ? "bg-purple-50" : "";
  const title = att
    ? `${empId} · ${dateStr} · ${att.status}${att.regularised ? " (regularised)" : ""}${!att.geofence_verified && att.status === "present" ? " (outside fence)" : ""}`
    : `${empId} · ${dateStr}${leaveType ? " · " + leaveType : ""}`;

  return (
    <td
      className={`border-b border-r border-slate-100 text-center align-middle ${bgCls}`}
      style={{ minWidth: DATE_COL_W, width: DATE_COL_W, padding: "5px 2px" }}
      title={title}
    >
      <span className={`${COLOR_CLS[color]} text-[11px] leading-none`}>{code || "—"}</span>
    </td>
  );
});

/* ── main component ─────────────────────────────────────────── */
export function AttendanceRegisterTab() {
  const now = new Date();
  const [year,  setYear]  = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [employees,  setEmployees]  = useState([]);
  const [attRecords, setAttRecords] = useState([]);
  const [leaves,     setLeaves]     = useState([]);
  const [holidays,   setHolidays]   = useState(new Set());
  const [loading,    setLoading]    = useState(false);
  const [deptFilter, setDeptFilter] = useState("");

  const today     = now.toISOString().split("T")[0];
  const allDates  = useMemo(() => buildDates(year, month), [year, month]);
  const monthLabel = new Date(year, month - 1, 1).toLocaleString("en-IN", { month: "long", year: "numeric" });

  const prevMonth = () => {
    if (month === 1) { setMonth(12); setYear(y => y - 1); }
    else setMonth(m => m - 1);
  };
  const nextMonth = () => {
    const n = new Date();
    if (year > n.getFullYear() || (year === n.getFullYear() && month >= n.getMonth() + 1)) return;
    if (month === 12) { setMonth(1); setYear(y => y + 1); }
    else setMonth(m => m + 1);
  };

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const from = `${year}-${pad(month)}-01`;
      const daysT = new Date(year, month, 0).getDate();
      const to   = `${year}-${pad(month)}-${pad(daysT)}`;
      const [empR, attR, leaveR, holR] = await Promise.all([
        API.get("/employees?status=all&limit=500"),
        API.get("/attendance", { params: { date_from: from, date_to: to, limit: 3000 } }),
        API.get("/leaves",     { params: { status: "approved" } }),
        API.get("/holidays",   { params: { year } }),
      ]);
      setEmployees(empR.data || []);
      setAttRecords(attR.data || []);
      setLeaves(leaveR.data || []);
      setHolidays(new Set((holR.data || []).map(h => h.date)));
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [year, month]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  /* lookup maps */
  const attMap = useMemo(() => {
    const m = {};
    for (const r of attRecords) {
      if (!m[r.employee_id]) m[r.employee_id] = {};
      m[r.employee_id][r.date] = r;
    }
    return m;
  }, [attRecords]);

  const leaveMap = useMemo(() => buildLeaveMap(leaves), [leaves]);

  /* departments for filter */
  const departments = useMemo(
    () => [...new Set(employees.map(e => e.department).filter(Boolean))].sort(),
    [employees]
  );

  const filteredEmps = useMemo(
    () => deptFilter ? employees.filter(e => e.department === deptFilter) : employees,
    [employees, deptFilter]
  );

  /* per-date summary (FD count / A count) shown under date header */
  const dateSummary = useMemo(() => {
    const s = {};
    for (const { dateStr, dow } of allDates) {
      if (dow === 0) { s[dateStr] = null; continue; }
      let fd = 0, a = 0;
      for (const emp of filteredEmps) {
        const att = attMap[emp.employee_id]?.[dateStr];
        const lt  = leaveMap[emp.employee_id]?.[dateStr];
        const { code } = cellInfo(att, lt, dow, holidays.has(dateStr), dateStr > today);
        if (code === "FD") fd++;
        else if (code === "A") a++;
      }
      s[dateStr] = { fd, a };
    }
    return s;
  }, [allDates, filteredEmps, attMap, leaveMap, holidays, today]);

  /* ── render ──────────────────────────────────────────────── */
  return (
    <div className="space-y-3" data-testid="att-register">

      {/* Controls bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-3 flex flex-wrap gap-3 items-center justify-between">
        <div className="flex items-center gap-2">
          <button onClick={prevMonth} className="p-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-600" data-testid="reg-prev-month">
            <ChevronLeft size={16} />
          </button>
          <span className="font-bold text-[#1E2A47] text-sm min-w-[140px] text-center" style={{ fontFamily: "'Outfit', sans-serif" }}>
            {monthLabel}
          </span>
          <button onClick={nextMonth} className="p-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-600" data-testid="reg-next-month">
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="flex gap-2 items-center">
          <select
            value={deptFilter}
            onChange={e => setDeptFilter(e.target.value)}
            className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm bg-white"
            data-testid="reg-dept-filter"
          >
            <option value="">All Departments</option>
            {departments.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          <span className="text-xs text-slate-400">{filteredEmps.length} employees</span>
        </div>
      </div>

      {loading ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 flex items-center justify-center gap-3 text-slate-400 text-sm">
          <Loader size={18} className="animate-spin" /> Building attendance register…
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {/* scrollable container — both axes */}
          <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "68vh" }}>
            <table
              className="border-collapse text-xs"
              style={{ minWidth: "max-content", borderSpacing: 0 }}
              data-testid="att-register-table"
            >
              <thead>
                {/* ─ Row 1: group headers + date labels ─ */}
                <tr>
                  {/* "Employees" spanning first 2 cols */}
                  <th
                    colSpan={2}
                    className="bg-[#1E2A47] text-white text-left px-3 py-2 border-b border-r border-slate-600 text-[11px] font-bold tracking-widest uppercase"
                    style={{ position: "sticky", left: 0, top: 0, zIndex: 12, minWidth: FROZEN_WIDTHS[0] + FROZEN_WIDTHS[1] }}
                  >
                    Employees
                  </th>
                  {/* "Hierarchy" spanning last 2 frozen cols */}
                  <th
                    colSpan={2}
                    className="bg-[#1E2A47] text-white text-left px-3 py-2 border-b border-r border-slate-600 text-[11px] font-bold tracking-widest uppercase"
                    style={{ position: "sticky", left: FROZEN_LEFTS[2], top: 0, zIndex: 12, minWidth: FROZEN_WIDTHS[2] + FROZEN_WIDTHS[3] }}
                  >
                    Hierarchy
                  </th>
                  {/* Date header cells */}
                  {allDates.map(({ dateStr, dow }) => {
                    const isSun = dow === 0;
                    const isHol = holidays.has(dateStr);
                    const dd  = dateStr.slice(8);
                    const mon = new Date(dateStr).toLocaleString("en-IN", { month: "short" });
                    return (
                      <th
                        key={dateStr}
                        className={`border-b border-r border-slate-600 text-center py-1.5 text-[10px]
                          ${isSun ? "bg-slate-600 text-slate-200" : isHol ? "bg-purple-700 text-purple-100" : "bg-[#1E2A47] text-white"}`}
                        style={{ position: "sticky", top: 0, zIndex: 9, minWidth: DATE_COL_W, width: DATE_COL_W }}
                      >
                        <div className="font-bold">{dd}-{mon}</div>
                        <div className="opacity-60 text-[9px]">{DAY_SHORT[dow]}</div>
                      </th>
                    );
                  })}
                </tr>

                {/* ─ Row 2: column sub-headers + daily summary ─ */}
                <tr>
                  {["Employee ID", "Employee Name", "Department", "Designation"].map((label, i) => (
                    <th
                      key={label}
                      className="bg-slate-100 border-b border-r border-slate-200 text-slate-600 font-semibold px-2 py-1.5 text-left text-[11px] whitespace-nowrap"
                      style={{ position: "sticky", left: FROZEN_LEFTS[i], top: 0, zIndex: 11, minWidth: FROZEN_WIDTHS[i], width: FROZEN_WIDTHS[i] }}
                    >
                      {label}
                    </th>
                  ))}
                  {allDates.map(({ dateStr, dow }) => {
                    const isSun = dow === 0;
                    const sum   = dateSummary[dateStr];
                    return (
                      <th
                        key={dateStr}
                        className={`border-b border-r border-slate-100 text-center py-1 ${isSun ? "bg-slate-100" : "bg-slate-50"}`}
                        style={{ position: "sticky", top: 0, zIndex: 9, minWidth: DATE_COL_W, width: DATE_COL_W }}
                      >
                        {sum && (
                          <div className="flex flex-col items-center gap-0.5">
                            {sum.fd > 0 && <span className="text-green-600 text-[9px] font-bold leading-none">{sum.fd}</span>}
                            {sum.a  > 0 && <span className="text-red-500   text-[9px] font-bold leading-none">{sum.a}</span>}
                          </div>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>

              <tbody>
                {filteredEmps.map((emp, ri) => {
                  const evenRow = ri % 2 === 0;
                  const rowBg  = evenRow ? "#ffffff" : "#f8fafc";
                  return (
                    <tr key={emp.employee_id} data-testid={`reg-row-${emp.employee_id}`}>
                      {/* ── Frozen info cells ── */}
                      {[
                        emp.employee_id,
                        `${emp.first_name} ${emp.last_name || ""}`.trim(),
                        emp.department || "—",
                        emp.designation || "—",
                      ].map((val, ci) => (
                        <td
                          key={ci}
                          className="border-b border-r border-slate-100 px-2 py-1.5 whitespace-nowrap text-[11px]"
                          style={{ position: "sticky", left: FROZEN_LEFTS[ci], zIndex: 3, background: rowBg, minWidth: FROZEN_WIDTHS[ci], width: FROZEN_WIDTHS[ci], maxWidth: FROZEN_WIDTHS[ci], overflow: "hidden", textOverflow: "ellipsis" }}
                          title={val}
                        >
                          {ci === 0
                            ? <span className="text-[#E85B1E] font-mono font-bold">{val}</span>
                            : <span className="text-slate-700">{val}</span>
                          }
                        </td>
                      ))}

                      {/* ── Date cells ── */}
                      {allDates.map(({ dateStr, dow }) => (
                        <Cell
                          key={dateStr}
                          att={attMap[emp.employee_id]?.[dateStr]}
                          leaveType={leaveMap[emp.employee_id]?.[dateStr]}
                          dow={dow}
                          isHoliday={holidays.has(dateStr)}
                          isFuture={dateStr > today}
                          dateStr={dateStr}
                          empId={emp.employee_id}
                        />
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="flex flex-wrap gap-2">
        {[
          ["text-slate-800 font-semibold", "FD = Full Day"],
          ["text-blue-600 font-bold",      "FD (blue) = Regularised"],
          ["text-orange-500 font-semibold","FD (orange) = Outside Geofence"],
          ["text-amber-600 font-bold",     "HD = Half Day"],
          ["text-red-600 font-bold",       "A = Absent"],
          ["text-slate-400",               "WO = Weekly Off"],
          ["text-purple-500 font-semibold","H = Holiday"],
          ["text-sky-600 font-semibold",   "SL / CL / EL / CO = Leave type"],
        ].map(([cls, label]) => (
          <span key={label} className={`${cls} text-[10px] px-2 py-1 bg-slate-50 rounded border border-slate-200`}>
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
