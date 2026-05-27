/**
 * Shared shift / weekly-off / date helpers for attendance views.
 *
 * IMPORTANT TZ NOTE
 * -----------------
 * Date strings ("YYYY-MM-DD") for attendance/calendar use are intended to be
 * **local civil dates**. Never use `Date.prototype.toISOString().split('T')[0]`
 * for these — that returns the *UTC* date, which is one day behind for IST
 * (UTC+5:30) anywhere from 18:30 to 23:59 local. Use `toLocalDateStr(d)`.
 */

const pad2 = (n) => String(n).padStart(2, "0");

/** Returns the local YYYY-MM-DD for a Date instance (or today by default). */
export function toLocalDateStr(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Build the list of {dateStr, dow} entries for the given month/year. */
export function buildMonthDates(year, month) {
  const list = [];
  const d = new Date(year, month - 1, 1);
  while (d.getMonth() === month - 1) {
    list.push({ dateStr: toLocalDateStr(d), dow: d.getDay() });
    d.setDate(d.getDate() + 1);
  }
  return list;
}

/** Same as buildMonthDates but returns just the date-string array. */
export function daysInMonth(year, month) {
  return buildMonthDates(year, month).map((e) => e.dateStr);
}

/** Returns date-string of the Nth Saturday (1-indexed) of year/month, or null. */
export function getNthSaturday(year, month, n) {
  const d = new Date(year, month - 1, 1);
  while (d.getDay() !== 6) d.setDate(d.getDate() + 1);
  d.setDate(d.getDate() + (n - 1) * 7);
  return d.getMonth() === month - 1 ? toLocalDateStr(d) : null;
}

/** Which Saturday number (1-5) is this date? Returns 0 if not a Saturday. */
export function saturdayIndex(dateStr, year, month) {
  for (let n = 1; n <= 5; n++) {
    if (getNthSaturday(year, month, n) === dateStr) return n;
  }
  return 0;
}

/**
 * Is this date a weekly off?
 *   - Sunday (dow === 0) → always WO
 *   - Saturday (dow === 6) → depends on saturday_rule:
 *       "all_working"  → working
 *       "alt_1_3_off"  → 1st/3rd (and 5th) Sat are WO
 *       "alt_2_4_off"  → 2nd/4th Sat are WO
 *       "all_off"      → every Saturday WO
 */
export function isWeeklyOff(dateStr, dow, satRule, year, month) {
  if (dow === 0) return true;
  if (dow !== 6) return false;
  if (!satRule || satRule === "all_working") return false;
  if (satRule === "all_off") return true;
  const idx = saturdayIndex(dateStr, year, month);
  if (satRule === "alt_1_3_off") return idx === 1 || idx === 3 || idx === 5;
  if (satRule === "alt_2_4_off") return idx === 2 || idx === 4;
  return false;
}

/**
 * Resolve the effective saturday_rule for an employee:
 *   1. explicit emp.shift_id → that shift
 *   2. role-assigned shift
 *   3. default shift
 *   4. "all_working" fallback
 */
export function resolveEmpSatRule(emp, shifts) {
  if (!emp || !shifts?.length) return "all_working";
  if (emp.shift_id) {
    const s = shifts.find((sh) => sh.id === emp.shift_id);
    if (s) return s.saturday_rule || "all_working";
  }
  const byRole = shifts.find((sh) => sh.assigned_roles?.includes(emp.role));
  if (byRole) return byRole.saturday_rule || "all_working";
  const def = shifts.find((sh) => sh.is_default);
  return def?.saturday_rule || "all_working";
}
