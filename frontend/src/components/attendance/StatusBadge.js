import React from "react";

/**
 * Renders the attendance status pill + an optional "why half-day" reason badge.
 *
 *   <AttendanceStatusBadge record={r} />
 *
 * Status priority for display label:
 *   - status === "leave"        → Leave (amber)
 *   - status === "absent"       → Absent (red)
 *   - status === "half_day"     → Half Day (orange) + reason badge
 *   - status === "weekly_off"   → Off (slate)
 *   - status === "holiday"      → Holiday (rose)
 *   - punch_in & in fence       → Present (green)
 *   - punch_in & out of fence   → Outside Fence (amber)
 *   - else                      → Absent (slate)
 */
export function AttendanceStatusBadge({ record: r }) {
  if (!r) return null;
  const { status, geofence_verified, punch_in_time, late_minutes, auto_status_reason } = r;

  // Status pill — what to render & color
  let label;
  let cls;
  if (status === "leave") { label = "Leave"; cls = "bg-amber-100 text-amber-700"; }
  else if (status === "absent") { label = "Absent"; cls = "bg-red-100 text-red-700"; }
  else if (status === "half_day") { label = "Half Day"; cls = "bg-orange-100 text-orange-700"; }
  else if (status === "weekly_off") { label = "Off"; cls = "bg-slate-100 text-slate-600"; }
  else if (status === "holiday") { label = "Holiday"; cls = "bg-rose-100 text-rose-700"; }
  else if (punch_in_time) {
    if (geofence_verified) { label = "Present"; cls = "bg-green-100 text-green-700"; }
    else { label = "Outside Fence"; cls = "bg-amber-100 text-amber-700"; }
  } else { label = "Absent"; cls = "bg-slate-100 text-slate-500"; }

  // Optional reason chip explaining auto half-day
  let reason = null;
  if (status === "half_day" && auto_status_reason === "late_punch_in") {
    const txt = late_minutes ? `Late ${late_minutes}m` : "Late";
    reason = (
      <span
        title="Marked Half Day automatically — punched in more than 30 minutes after shift start."
        className="ml-1 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200"
        data-testid="auto-half-late"
      >
        {txt}
      </span>
    );
  } else if (status === "half_day" && auto_status_reason === "short_hours") {
    reason = (
      <span
        title="Marked Half Day automatically — total punched time was less than 6 hours."
        className="ml-1 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-orange-50 text-orange-700 border border-orange-200"
        data-testid="auto-half-short"
      >
        &lt;6h
      </span>
    );
  }

  return (
    <span className="inline-flex items-center" data-testid="att-status">
      <span className={`px-2 py-1 rounded-full text-xs font-medium ${cls}`}>{label}</span>
      {reason}
    </span>
  );
}

export default AttendanceStatusBadge;
