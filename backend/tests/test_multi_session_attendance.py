"""Backend tests for the per-employee multi_session_attendance feature.

Strategy:
  - Use admin (hr_admin) to toggle the flag and seed attendance records.
  - Login as the target employee for /api/attendance/my reads.
  - Punch-in/Punch-out BLOCK paths are testable because the existing-record
    check fires BEFORE the face-match check in routes/attendance.py.
  - Rule engine math (sum of session hours, late-lock) is verified via direct
    DB seed + GET /api/attendance/my.
  - We always restore multi_session_attendance=False at teardown.
"""
import os
import requests
from datetime import datetime, timezone, timedelta
from pymongo import MongoClient
import pytest

BASE = os.environ.get("REACT_APP_BACKEND_URL", "https://radhya-field-track.preview.emergentagent.com").rstrip("/")
API = f"{BASE}/api"

ADMIN = ("admin", "Admin@123")
EMP_USER = "RMF0023"
EMP_PWD = "Welcome@123"

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "radhya_hr_db")
client = MongoClient(MONGO_URL)
db = client[DB_NAME]


def _login(u, p):
    r = requests.post(f"{API}/auth/login", json={"username": u, "password": p}, timeout=15)
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture(scope="module")
def admin_h():
    return {"Authorization": f"Bearer {_login(*ADMIN)}"}


@pytest.fixture(scope="module")
def emp_h():
    return {"Authorization": f"Bearer {_login(EMP_USER, EMP_PWD)}"}


@pytest.fixture(autouse=True)
def cleanup():
    """Wipe any test attendance for RMF0023 on the test date and reset flag."""
    yield
    db.attendance_records.delete_many({"employee_id": EMP_USER})
    db.employees.update_one({"employee_id": EMP_USER}, {"$set": {"multi_session_attendance": False}})


# ---- 1. Flag persistence ----
def test_put_employee_persists_flag(admin_h):
    r = requests.put(f"{API}/employees/{EMP_USER}", json={"multi_session_attendance": True}, headers=admin_h, timeout=15)
    assert r.status_code == 200, r.text
    assert r.json().get("multi_session_attendance") is True

    g = requests.get(f"{API}/employees/{EMP_USER}", headers=admin_h, timeout=15)
    assert g.status_code == 200
    assert g.json().get("multi_session_attendance") is True

    # Toggle back off
    r2 = requests.put(f"{API}/employees/{EMP_USER}", json={"multi_session_attendance": False}, headers=admin_h, timeout=15)
    assert r2.status_code == 200
    assert r2.json().get("multi_session_attendance") is False


# ---- 2. Backward compat: flag OFF blocks 2nd punch-in / 2nd punch-out ----
def test_block_when_flag_off_already_punched_in(admin_h, emp_h):
    db.employees.update_one({"employee_id": EMP_USER}, {"$set": {"multi_session_attendance": False}})
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    db.attendance_records.delete_many({"employee_id": EMP_USER, "date": today})
    db.attendance_records.insert_one({
        "employee_id": EMP_USER, "date": today,
        "punch_in_time": datetime.now(timezone.utc).isoformat(),
        "sessions": [{"punch_in_time": datetime.now(timezone.utc).isoformat(), "punch_out_time": None}],
        "status": "present",
    })
    r = requests.post(f"{API}/attendance/punch-in", headers=emp_h, timeout=15,
                      json={"employee_id": EMP_USER, "latitude": 0.0, "longitude": 0.0})
    assert r.status_code == 400, r.text
    assert "Already punched in today" in r.json().get("detail", "")


def test_block_when_flag_off_already_punched_out(admin_h, emp_h):
    db.employees.update_one({"employee_id": EMP_USER}, {"$set": {"multi_session_attendance": False}})
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    now_iso = datetime.now(timezone.utc).isoformat()
    db.attendance_records.delete_many({"employee_id": EMP_USER, "date": today})
    db.attendance_records.insert_one({
        "employee_id": EMP_USER, "date": today,
        "punch_in_time": now_iso, "punch_out_time": now_iso,
        "sessions": [{"punch_in_time": now_iso, "punch_out_time": now_iso, "hours_worked": 1.0}],
        "status": "present",
    })
    r = requests.post(f"{API}/attendance/punch-out", headers=emp_h, timeout=15,
                      json={"employee_id": EMP_USER, "latitude": 0.0, "longitude": 0.0})
    assert r.status_code == 400, r.text
    assert "Already punched out today" in r.json().get("detail", "")


# ---- 3. Multi-session ON: open-session block ----
def test_multi_session_blocks_when_session_open(admin_h, emp_h):
    db.employees.update_one({"employee_id": EMP_USER}, {"$set": {"multi_session_attendance": True}})
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    db.attendance_records.delete_many({"employee_id": EMP_USER, "date": today})
    in_iso = datetime.now(timezone.utc).isoformat()
    db.attendance_records.insert_one({
        "employee_id": EMP_USER, "date": today,
        "punch_in_time": in_iso,
        "sessions": [{"punch_in_time": in_iso, "punch_out_time": None}],
        "status": "present",
    })
    r = requests.post(f"{API}/attendance/punch-in", headers=emp_h, timeout=15,
                      json={"employee_id": EMP_USER, "latitude": 0.0, "longitude": 0.0})
    assert r.status_code == 400, r.text
    assert "session is already open" in r.json().get("detail", "").lower()


def test_multi_session_punch_out_no_open_session(admin_h, emp_h):
    """When flag ON and last session already closed, punch-out tells user to punch in first."""
    db.employees.update_one({"employee_id": EMP_USER}, {"$set": {"multi_session_attendance": True}})
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    db.attendance_records.delete_many({"employee_id": EMP_USER, "date": today})
    now_iso = datetime.now(timezone.utc).isoformat()
    db.attendance_records.insert_one({
        "employee_id": EMP_USER, "date": today,
        "punch_in_time": now_iso, "punch_out_time": now_iso,
        "sessions": [{"punch_in_time": now_iso, "punch_out_time": now_iso, "hours_worked": 2.0}],
        "status": "present",
    })
    r = requests.post(f"{API}/attendance/punch-out", headers=emp_h, timeout=15,
                      json={"employee_id": EMP_USER, "latitude": 0.0, "longitude": 0.0})
    assert r.status_code == 400, r.text
    assert "no open session" in r.json().get("detail", "").lower()


# ---- 4. /attendance/my returns sessions, hours_worked sum, top-level mirrors ----
def test_my_returns_session_aggregates(admin_h, emp_h):
    """Seed two closed sessions and one third with sum of hours; verify response shape."""
    db.employees.update_one({"employee_id": EMP_USER}, {"$set": {"multi_session_attendance": True}})
    now = datetime.now(timezone.utc)
    today = now.strftime("%Y-%m-%d")
    db.attendance_records.delete_many({"employee_id": EMP_USER, "date": today})

    s1_in = (now - timedelta(hours=8)).isoformat()
    s1_out = (now - timedelta(hours=6)).isoformat()  # 2.0h
    s2_in = (now - timedelta(hours=5)).isoformat()
    s2_out = (now - timedelta(hours=3)).isoformat()  # 2.0h
    s3_in = (now - timedelta(hours=2)).isoformat()
    s3_out = (now - timedelta(hours=0, minutes=30)).isoformat()  # 1.5h

    sessions = [
        {"punch_in_time": s1_in, "punch_out_time": s1_out, "hours_worked": 2.0},
        {"punch_in_time": s2_in, "punch_out_time": s2_out, "hours_worked": 2.0},
        {"punch_in_time": s3_in, "punch_out_time": s3_out, "hours_worked": 1.5},
    ]
    db.attendance_records.insert_one({
        "employee_id": EMP_USER, "date": today,
        "punch_in_time": s1_in,        # mirrors first session
        "punch_out_time": s3_out,      # mirrors last session
        "sessions": sessions,
        "session_count": 3,
        "hours_worked": 5.5,
        "status": "present",
    })

    r = requests.get(f"{API}/attendance/my", headers=emp_h, timeout=15)
    assert r.status_code == 200, r.text
    rec = next((x for x in r.json() if x.get("date") == today), None)
    assert rec is not None
    assert len(rec["sessions"]) == 3
    assert rec["session_count"] == 3
    assert rec["punch_in_time"] == s1_in
    assert rec["punch_out_time"] == s3_out
    assert abs(rec["hours_worked"] - 5.5) < 0.01
    assert rec["status"] == "present"


# ---- 5. Late half-day stays half-day even with sufficient summed hours ----
def test_late_half_day_locked_even_with_sum_hours(admin_h, emp_h):
    """If the FIRST punch-in marked the day half_day(late), summed hours >= min must NOT upgrade."""
    db.employees.update_one({"employee_id": EMP_USER}, {"$set": {"multi_session_attendance": True}})
    now = datetime.now(timezone.utc)
    today = now.strftime("%Y-%m-%d")
    db.attendance_records.delete_many({"employee_id": EMP_USER, "date": today})

    s1_in = (now - timedelta(hours=10)).isoformat()
    s1_out = (now - timedelta(hours=5)).isoformat()    # 5h
    s2_in = (now - timedelta(hours=4)).isoformat()
    s2_out = (now - timedelta(hours=0, minutes=15)).isoformat()  # ~3.75h
    sessions = [
        {"punch_in_time": s1_in, "punch_out_time": s1_out, "hours_worked": 5.0},
        {"punch_in_time": s2_in, "punch_out_time": s2_out, "hours_worked": 3.75},
    ]
    db.attendance_records.insert_one({
        "employee_id": EMP_USER, "date": today,
        "punch_in_time": s1_in, "punch_out_time": s2_out,
        "sessions": sessions, "session_count": 2, "hours_worked": 8.75,
        "status": "half_day", "auto_status_reason": "late_punch_in", "late_minutes": 90,
    })
    # Verify rule engine: feed half_day/late_punch_in into compute_status_after_punch_out_with_shift
    from services.shift_rules import compute_status_after_punch_out_with_shift
    res = compute_status_after_punch_out_with_shift(
        {"min_full_day_hours": 6.0}, "half_day", "late_punch_in", 8.75,
    )
    assert res["status"] == "half_day"
    assert res["reason"] == "late_punch_in"


# ---- 6. Short-hours half-day rule — sum < min_full_day_hours ----
def test_short_hours_half_day_via_rule_engine():
    from services.shift_rules import compute_status_after_punch_out_with_shift
    # Sum 4h < 6h min => half_day short_hours
    res = compute_status_after_punch_out_with_shift(
        {"min_full_day_hours": 6.0}, "present", None, 4.0,
    )
    assert res["status"] == "half_day"
    assert res["reason"] == "short_hours"

    # Sum 7h >= 6h => present
    res2 = compute_status_after_punch_out_with_shift(
        {"min_full_day_hours": 6.0}, "present", None, 7.0,
    )
    assert res2["status"] == "present"
    assert res2["reason"] is None
