"""Tests for shift-rules auto-status computation."""

from datetime import datetime, timezone

from services.shift_rules import (
    IST,
    compute_punch_in_status,
    compute_status_after_punch_out,
)


def _ist_iso(date_str: str, h: int, m: int) -> str:
    y, mo, d = (int(p) for p in date_str.split("-"))
    return datetime(y, mo, d, h, m, tzinfo=IST).astimezone(timezone.utc).isoformat()


DATE = "2026-02-10"


def test_field_agent_on_time_is_present():
    r = compute_punch_in_status("field_agent", _ist_iso(DATE, 7, 0), DATE)
    assert r["status"] == "present" and r["late_minutes"] == 0 and r["reason"] is None


def test_field_agent_within_grace_is_present():
    r = compute_punch_in_status("field_agent", _ist_iso(DATE, 7, 25), DATE)
    assert r["status"] == "present" and r["late_minutes"] == 25


def test_field_agent_after_grace_is_half_day():
    r = compute_punch_in_status("field_agent", _ist_iso(DATE, 7, 31), DATE)
    assert r["status"] == "half_day" and r["reason"] == "late_punch_in"


def test_field_agent_early_arrival_is_present():
    r = compute_punch_in_status("field_agent", _ist_iso(DATE, 6, 50), DATE)
    assert r["status"] == "present" and r["late_minutes"] == 0


def test_managers_use_field_shift():
    r = compute_punch_in_status("managers", _ist_iso(DATE, 7, 31), DATE)
    assert r["status"] == "half_day"


def test_employee_on_time_is_present():
    r = compute_punch_in_status("employee", _ist_iso(DATE, 9, 30), DATE)
    assert r["status"] == "present"


def test_employee_at_grace_edge_is_present():
    r = compute_punch_in_status("employee", _ist_iso(DATE, 10, 0), DATE)
    assert r["status"] == "present" and r["late_minutes"] == 30


def test_employee_after_grace_is_half_day():
    r = compute_punch_in_status("employee", _ist_iso(DATE, 10, 1), DATE)
    assert r["status"] == "half_day" and r["reason"] == "late_punch_in"


def test_management_uses_ho_shift():
    r = compute_punch_in_status("management", _ist_iso(DATE, 10, 30), DATE)
    assert r["status"] == "half_day"


def test_punch_out_short_hours_marks_half_day():
    r = compute_status_after_punch_out("present", None, 5.5)
    assert r["status"] == "half_day" and r["reason"] == "short_hours"


def test_punch_out_six_hours_is_full_day():
    r = compute_status_after_punch_out("present", None, 6.0)
    assert r["status"] == "present"


def test_late_half_day_locks_even_with_long_hours():
    r = compute_status_after_punch_out("half_day", "late_punch_in", 9.0)
    assert r["status"] == "half_day" and r["reason"] == "late_punch_in"


def test_late_half_day_stays_with_short_hours():
    r = compute_status_after_punch_out("half_day", "late_punch_in", 3.0)
    assert r["status"] == "half_day" and r["reason"] == "late_punch_in"


def test_unmapped_role_skips_rule():
    r = compute_punch_in_status("hr_admin", _ist_iso(DATE, 11, 0), DATE)
    assert r["status"] == "present" and r["reason"] is None
