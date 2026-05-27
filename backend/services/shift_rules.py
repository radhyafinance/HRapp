"""Shift hours and auto-status rules.

A "shift" is a row in the `shifts` collection with this shape::

    {
      "_id": ObjectId,
      "id": "<str>",                      # uuid
      "name": "Field Shift",
      "start_hour": 7, "start_minute": 0,
      "end_hour":   16, "end_minute": 0,
      "grace_minutes": 30,
      "min_full_day_hours": 6.0,
      "assigned_roles": ["field_agent", "managers"],
      "is_default": False,                # at most one default
      "is_active": True,
    }

Resolution priority for a user:
  1. Employee-level override (`employees.shift_id`)
  2. A shift whose `assigned_roles` contains the user's role
  3. The shift flagged `is_default: True`
  4. Hard-coded fallback (legacy 7-16 / 9:30-18:30 by role) — keeps things working
     before any shift docs exist.

Half-day triggers per the resolved shift:
  1) Punch-in is more than `grace_minutes` after shift start.
  2) Total punched hours in the day < `min_full_day_hours`.
Once a day is half-day for late punch-in, it cannot be upgraded — penalty stands
even if total hours ≥ min.

HR-regularised records (regularised=True) are LOCKED — auto-rule is skipped.
"""

from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any

IST = timezone(timedelta(hours=5, minutes=30))

# Hard-coded fallback shifts used when no shift docs exist yet.
FALLBACK_SHIFTS: Dict[str, Dict[str, Any]] = {
    "field_agent": {
        "name": "Field Shift (legacy)",
        "start_hour": 7, "start_minute": 0,
        "end_hour": 16,  "end_minute": 0,
        "grace_minutes": 30,
        "min_full_day_hours": 6.0,
        "saturday_rule": "all_working",
    },
    "managers": {
        "name": "Field Shift (legacy)",
        "start_hour": 7, "start_minute": 0,
        "end_hour": 16,  "end_minute": 0,
        "grace_minutes": 30,
        "min_full_day_hours": 6.0,
        "saturday_rule": "all_working",
    },
    "management": {
        "name": "HO Shift (legacy)",
        "start_hour": 9, "start_minute": 30,
        "end_hour": 18,  "end_minute": 30,
        "grace_minutes": 30,
        "min_full_day_hours": 6.0,
        "saturday_rule": "alt_1_3_off",
    },
    "employee": {
        "name": "HO Shift (legacy)",
        "start_hour": 9, "start_minute": 30,
        "end_hour": 18,  "end_minute": 30,
        "grace_minutes": 30,
        "min_full_day_hours": 6.0,
        "saturday_rule": "alt_1_3_off",
    },
}


def _parse_iso(ts: str) -> Optional[datetime]:
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None


def fallback_shift_for_role(role: str) -> Optional[Dict[str, Any]]:
    return FALLBACK_SHIFTS.get(role)


async def resolve_shift_for(role: str, employee_id: Optional[str], db) -> Optional[Dict[str, Any]]:
    """Return the shift dict the user should follow, or None if the role doesn't punch."""
    # 1) Employee-level override
    if employee_id:
        emp = await db.employees.find_one({"employee_id": employee_id}, {"_id": 0, "shift_id": 1})
        sid = emp.get("shift_id") if emp else None
        if sid:
            shift = await db.shifts.find_one({"id": sid, "is_active": {"$ne": False}}, {"_id": 0})
            if shift:
                return shift

    # 2) Role default
    if role:
        shift = await db.shifts.find_one(
            {"assigned_roles": role, "is_active": {"$ne": False}},
            {"_id": 0},
        )
        if shift:
            return shift

    # 3) Default shift
    shift = await db.shifts.find_one({"is_default": True, "is_active": {"$ne": False}}, {"_id": 0})
    if shift:
        return shift

    # 4) Hard-coded fallback (legacy)
    return fallback_shift_for_role(role)


def shift_start_ist(shift: Dict[str, Any], date_str: str) -> Optional[datetime]:
    if not shift:
        return None
    try:
        d = datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        return None
    return datetime(
        d.year, d.month, d.day,
        int(shift.get("start_hour", 9)),
        int(shift.get("start_minute", 0)),
        tzinfo=IST,
    )


def compute_punch_in_status_with_shift(
    shift: Optional[Dict[str, Any]],
    punch_in_iso: str,
    date_str: str,
) -> dict:
    """Decide status from the punch-in alone, against an explicit shift dict."""
    shift_start = shift_start_ist(shift, date_str) if shift else None
    pin = _parse_iso(punch_in_iso)
    if not shift or not shift_start or not pin:
        return {"status": "present", "late_minutes": 0, "reason": None,
                "shift_id": (shift or {}).get("id"),
                "shift_name": (shift or {}).get("name")}

    pin_ist = pin.astimezone(IST)
    delta_min = (pin_ist - shift_start).total_seconds() / 60.0
    late_minutes = max(0, int(round(delta_min)))
    grace = int(shift.get("grace_minutes", 30))

    if delta_min > grace:
        return {
            "status": "half_day",
            "late_minutes": late_minutes,
            "reason": "late_punch_in",
            "shift_id": shift.get("id"),
            "shift_name": shift.get("name"),
        }
    return {
        "status": "present",
        "late_minutes": late_minutes,
        "reason": None,
        "shift_id": shift.get("id"),
        "shift_name": shift.get("name"),
    }


def compute_status_after_punch_out_with_shift(
    shift: Optional[Dict[str, Any]],
    current_status: str,
    current_reason: Optional[str],
    hours_worked: Optional[float],
) -> dict:
    """Recompute status after punch-out, against an explicit shift dict."""
    # Late lock — cannot be recovered.
    if current_status == "half_day" and current_reason == "late_punch_in":
        return {"status": "half_day", "reason": "late_punch_in"}

    if hours_worked is None:
        return {"status": current_status or "present", "reason": current_reason}

    min_hours = float((shift or {}).get("min_full_day_hours", 6.0))
    if hours_worked < min_hours:
        return {"status": "half_day", "reason": "short_hours"}

    return {"status": "present", "reason": None}


# -------------------------------------------------------------------------
# Backwards-compat helpers (used by older code paths and tests).
# These delegate to the role-fallback shift so old behaviour is unchanged.
# -------------------------------------------------------------------------

def compute_punch_in_status(role: str, punch_in_iso: str, date_str: str) -> dict:
    """Legacy entry point — uses the hard-coded role fallback shift."""
    return compute_punch_in_status_with_shift(
        fallback_shift_for_role(role), punch_in_iso, date_str
    )


def compute_status_after_punch_out(
    current_status: str,
    current_reason: Optional[str],
    hours_worked: Optional[float],
) -> dict:
    """Legacy entry point — uses the global default min hours (6.0)."""
    return compute_status_after_punch_out_with_shift(
        None, current_status, current_reason, hours_worked
    )
