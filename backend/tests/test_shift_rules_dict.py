"""Tests for shift-dict-aware computation (per-shift grace + min hours)."""

from datetime import datetime, timezone

from services.shift_rules import (
    IST,
    compute_punch_in_status_with_shift,
    compute_status_after_punch_out_with_shift,
)


def _ist_iso(date_str: str, h: int, m: int) -> str:
    y, mo, d = (int(p) for p in date_str.split("-"))
    return datetime(y, mo, d, h, m, tzinfo=IST).astimezone(timezone.utc).isoformat()


DATE = "2026-02-10"

NIGHT_SHIFT = {
    "id": "abc",
    "name": "Night Shift",
    "start_hour": 22, "start_minute": 0,
    "end_hour": 6, "end_minute": 0,
    "grace_minutes": 15,
    "min_full_day_hours": 7.5,
}

LENIENT_SHIFT = {
    "id": "xyz",
    "name": "Lenient",
    "start_hour": 10, "start_minute": 0,
    "end_hour": 19, "end_minute": 0,
    "grace_minutes": 60,   # very generous grace
    "min_full_day_hours": 4.0,
}


def test_custom_grace_15min_late_at_16min():
    r = compute_punch_in_status_with_shift(NIGHT_SHIFT, _ist_iso(DATE, 22, 16), DATE)
    assert r["status"] == "half_day" and r["reason"] == "late_punch_in"


def test_custom_grace_15min_on_time_at_15min():
    r = compute_punch_in_status_with_shift(NIGHT_SHIFT, _ist_iso(DATE, 22, 15), DATE)
    assert r["status"] == "present" and r["late_minutes"] == 15


def test_lenient_grace_60min_late_at_55min_still_present():
    r = compute_punch_in_status_with_shift(LENIENT_SHIFT, _ist_iso(DATE, 10, 55), DATE)
    assert r["status"] == "present" and r["late_minutes"] == 55


def test_lenient_grace_60min_late_at_61min_is_half_day():
    r = compute_punch_in_status_with_shift(LENIENT_SHIFT, _ist_iso(DATE, 11, 1), DATE)
    assert r["status"] == "half_day"


def test_custom_min_hours_75_marks_short_at_7():
    r = compute_status_after_punch_out_with_shift(NIGHT_SHIFT, "present", None, 7.0)
    assert r["status"] == "half_day" and r["reason"] == "short_hours"


def test_custom_min_hours_75_full_at_75():
    r = compute_status_after_punch_out_with_shift(NIGHT_SHIFT, "present", None, 7.5)
    assert r["status"] == "present"


def test_lenient_min_hours_4_full_at_5():
    r = compute_status_after_punch_out_with_shift(LENIENT_SHIFT, "present", None, 5.0)
    assert r["status"] == "present"


def test_late_locks_even_with_custom_shift():
    r = compute_status_after_punch_out_with_shift(NIGHT_SHIFT, "half_day", "late_punch_in", 12.0)
    assert r["status"] == "half_day" and r["reason"] == "late_punch_in"


def test_no_shift_falls_back_to_present():
    r = compute_punch_in_status_with_shift(None, _ist_iso(DATE, 13, 0), DATE)
    assert r["status"] == "present" and r["reason"] is None
