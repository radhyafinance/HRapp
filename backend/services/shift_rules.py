"""Shift hours and auto-status rules per role.

Roles → office hours (IST):
  - field_agent (Field Staff) + managers     → 07:00 – 16:00
  - management + employee (HO Staff)         → 09:30 – 18:30
  - hr_admin                                 → does not punch (no employee_id)

Half-day triggers:
  1) Punch-in is more than 30 min after shift start.
  2) Total punched hours in the day < 6.

Once a day is marked half_day for late punch-in, it cannot be upgraded —
penalty is final even if total hours ≥ 6.

HR-regularised records (regularised=True) are LOCKED — auto-rule is skipped.
"""

from datetime import datetime, timezone, timedelta
from typing import Optional

IST = timezone(timedelta(hours=5, minutes=30))

# (start_hour, start_minute, end_hour, end_minute) — all in IST
SHIFT_BY_ROLE = {
    "field_agent": (7, 0, 16, 0),
    "managers":    (7, 0, 16, 0),
    "management":  (9, 30, 18, 30),
    "employee":    (9, 30, 18, 30),
}

LATE_GRACE_MINUTES = 30
MIN_FULL_DAY_HOURS = 6.0


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


def shift_for_role(role: str):
    """Return shift tuple for the role, or None if the role doesn't punch."""
    return SHIFT_BY_ROLE.get(role)


def shift_start_ist(role: str, date_str: str) -> Optional[datetime]:
    """Return the IST-localized shift start datetime for the given role and date (YYYY-MM-DD)."""
    shift = shift_for_role(role)
    if not shift:
        return None
    sh, sm, _, _ = shift
    try:
        d = datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        return None
    return datetime(d.year, d.month, d.day, sh, sm, tzinfo=IST)


def compute_punch_in_status(role: str, punch_in_iso: str, date_str: str) -> dict:
    """Decide status from the punch-in alone.

    Returns:
      {
        "status": "present" | "half_day",
        "late_minutes": int (0 if on time or early),
        "reason": "late_punch_in" | None,
      }
    If the role has no shift defined, returns status='present' with no late computation.
    """
    shift_start = shift_start_ist(role, date_str)
    pin = _parse_iso(punch_in_iso)
    if not shift_start or not pin:
        return {"status": "present", "late_minutes": 0, "reason": None}

    pin_ist = pin.astimezone(IST)
    delta_min = (pin_ist - shift_start).total_seconds() / 60.0
    late_minutes = max(0, int(round(delta_min)))

    if delta_min > LATE_GRACE_MINUTES:
        return {"status": "half_day", "late_minutes": late_minutes, "reason": "late_punch_in"}
    return {"status": "present", "late_minutes": late_minutes, "reason": None}


def compute_status_after_punch_out(
    current_status: str,
    current_reason: Optional[str],
    hours_worked: Optional[float],
) -> dict:
    """Recompute status after punch-out.

    Rules:
      - If punch-in already produced a 'half_day' (late), stay half_day.
      - Else if hours_worked < 6 → half_day with reason 'short_hours'.
      - Else → present.
    Returns:
      { "status": ..., "reason": ... }
    """
    # Late lock — cannot be recovered.
    if current_status == "half_day" and current_reason == "late_punch_in":
        return {"status": "half_day", "reason": "late_punch_in"}

    if hours_worked is None:
        # Punch-out without a sensible duration: keep whatever was set.
        return {"status": current_status or "present", "reason": current_reason}

    if hours_worked < MIN_FULL_DAY_HOURS:
        return {"status": "half_day", "reason": "short_hours"}

    return {"status": "present", "reason": None}
