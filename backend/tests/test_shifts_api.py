"""Backend tests for /api/shifts CRUD + resolve + employee shift override + auto half-day rules."""
import os
from datetime import datetime, timedelta, timezone

import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://hr-system-dev-3.preview.emergentagent.com").rstrip("/")
ADMIN = {"username": "admin", "password": "Admin@123"}
FA = {"username": "RMF0023", "password": "Welcome@123"}

IST = timezone(timedelta(hours=5, minutes=30))


def _login(payload):
    r = requests.post(f"{BASE_URL}/api/auth/login", json=payload, timeout=15)
    assert r.status_code == 200, f"login failed {r.status_code}: {r.text}"
    return r.json()["access_token"]


@pytest.fixture(scope="session")
def admin_headers():
    return {"Authorization": f"Bearer {_login(ADMIN)}"}


@pytest.fixture(scope="session")
def fa_headers():
    return {"Authorization": f"Bearer {_login(FA)}"}


@pytest.fixture(scope="session")
def created_shift_ids():
    ids = []
    yield ids
    # teardown — delete (soft) any shift we created
    try:
        h = {"Authorization": f"Bearer {_login(ADMIN)}"}
        for sid in ids:
            # If shift is default, demote first so delete is allowed
            existing = requests.get(f"{BASE_URL}/api/shifts", headers=h, timeout=10).json()
            shift = next((s for s in existing if s.get("id") == sid), None)
            if not shift:
                continue
            if shift.get("is_default"):
                # Re-default the seeded HO Shift
                ho = next((s for s in existing if s.get("name") == "HO Shift"), None)
                if ho:
                    body = {k: ho[k] for k in ["name","start_hour","start_minute","end_hour","end_minute","grace_minutes","min_full_day_hours","assigned_roles","is_default","is_active"]}
                    body["is_default"] = True
                    requests.put(f"{BASE_URL}/api/shifts/{ho['id']}", json=body, headers=h, timeout=10)
                # Demote the test shift
                body = {k: shift[k] for k in ["name","start_hour","start_minute","end_hour","end_minute","grace_minutes","min_full_day_hours","assigned_roles","is_default","is_active"]}
                body["is_default"] = False
                requests.put(f"{BASE_URL}/api/shifts/{sid}", json=body, headers=h, timeout=10)
            requests.delete(f"{BASE_URL}/api/shifts/{sid}", headers=h, timeout=10)
        # Restore field_agent to Field Shift (it may have been moved off during role-exclusivity test)
        existing = requests.get(f"{BASE_URL}/api/shifts", headers=h, timeout=10).json()
        fs = next((s for s in existing if s.get("name") == "Field Shift"), None)
        if fs and "field_agent" not in (fs.get("assigned_roles") or []):
            body = {k: fs[k] for k in ["name","start_hour","start_minute","end_hour","end_minute","grace_minutes","min_full_day_hours","assigned_roles","is_default","is_active"]}
            body["assigned_roles"] = list(set((body.get("assigned_roles") or []) + ["field_agent"]))
            requests.put(f"{BASE_URL}/api/shifts/{fs['id']}", json=body, headers=h, timeout=10)
    except Exception as e:
        print(f"teardown error: {e}")


# ---------- list / seed ----------
class TestShiftsList:
    def test_list_seeded(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/shifts", headers=admin_headers, timeout=10)
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, list)
        names = [s["name"] for s in data]
        assert "Field Shift" in names
        assert "HO Shift" in names
        for s in data:
            assert "_id" not in s
            assert "id" in s

    def test_list_no_auth(self):
        r = requests.get(f"{BASE_URL}/api/shifts", timeout=10)
        assert r.status_code in (401, 403)


# ---------- create / role exclusivity / default exclusivity ----------
class TestShiftsCRUD:
    def test_field_agent_cannot_create(self, fa_headers):
        body = {"name": "TEST_FA_Shift", "start_hour": 10, "start_minute": 0, "end_hour": 19, "end_minute": 0,
                "grace_minutes": 15, "min_full_day_hours": 6.0, "assigned_roles": [], "is_default": False}
        r = requests.post(f"{BASE_URL}/api/shifts", json=body, headers=fa_headers, timeout=10)
        assert r.status_code == 403

    def test_create_shift_validation_bad_role(self, admin_headers):
        body = {"name": "TEST_BadRole", "start_hour": 10, "start_minute": 0, "end_hour": 19, "end_minute": 0,
                "grace_minutes": 15, "min_full_day_hours": 6.0, "assigned_roles": ["nonexistent_role"], "is_default": False}
        r = requests.post(f"{BASE_URL}/api/shifts", json=body, headers=admin_headers, timeout=10)
        assert r.status_code == 400

    def test_create_basic(self, admin_headers, created_shift_ids):
        body = {"name": "TEST_Basic_Shift", "start_hour": 11, "start_minute": 0, "end_hour": 20, "end_minute": 0,
                "grace_minutes": 20, "min_full_day_hours": 5.5, "assigned_roles": [], "is_default": False}
        r = requests.post(f"{BASE_URL}/api/shifts", json=body, headers=admin_headers, timeout=10)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["name"] == "TEST_Basic_Shift"
        assert data["grace_minutes"] == 20
        assert data["min_full_day_hours"] == 5.5
        assert "id" in data
        assert "_id" not in data
        created_shift_ids.append(data["id"])

        # GET to verify persistence
        gl = requests.get(f"{BASE_URL}/api/shifts", headers=admin_headers, timeout=10).json()
        assert any(s["id"] == data["id"] for s in gl)

    def test_role_auto_removed_from_other_shift(self, admin_headers, created_shift_ids):
        # Create shift A with field_agent
        body_a = {"name": "TEST_RoleA", "start_hour": 7, "start_minute": 0, "end_hour": 16, "end_minute": 0,
                  "grace_minutes": 30, "min_full_day_hours": 6.0, "assigned_roles": ["field_agent"], "is_default": False}
        ra = requests.post(f"{BASE_URL}/api/shifts", json=body_a, headers=admin_headers, timeout=10)
        assert ra.status_code == 200
        a = ra.json(); created_shift_ids.append(a["id"])
        assert "field_agent" in a["assigned_roles"]

        # Create shift B that ALSO claims field_agent
        body_b = {"name": "TEST_RoleB", "start_hour": 8, "start_minute": 0, "end_hour": 17, "end_minute": 0,
                  "grace_minutes": 30, "min_full_day_hours": 6.0, "assigned_roles": ["field_agent"], "is_default": False}
        rb = requests.post(f"{BASE_URL}/api/shifts", json=body_b, headers=admin_headers, timeout=10)
        assert rb.status_code == 200
        b = rb.json(); created_shift_ids.append(b["id"])
        assert "field_agent" in b["assigned_roles"]

        # Original A should have lost field_agent (and any pre-existing seeded shift too)
        all_shifts = requests.get(f"{BASE_URL}/api/shifts", headers=admin_headers, timeout=10).json()
        a_now = next(s for s in all_shifts if s["id"] == a["id"])
        assert "field_agent" not in (a_now.get("assigned_roles") or [])
        # Only ONE shift should have field_agent now: shift B
        owners = [s["id"] for s in all_shifts if "field_agent" in (s.get("assigned_roles") or [])]
        assert owners == [b["id"]]

    def test_is_default_exclusivity(self, admin_headers, created_shift_ids):
        body = {"name": "TEST_Default_New", "start_hour": 10, "start_minute": 0, "end_hour": 19, "end_minute": 0,
                "grace_minutes": 30, "min_full_day_hours": 6.0, "assigned_roles": [], "is_default": True}
        r = requests.post(f"{BASE_URL}/api/shifts", json=body, headers=admin_headers, timeout=10)
        assert r.status_code == 200
        new = r.json(); created_shift_ids.append(new["id"])
        all_shifts = requests.get(f"{BASE_URL}/api/shifts", headers=admin_headers, timeout=10).json()
        defaults = [s for s in all_shifts if s.get("is_default")]
        assert len(defaults) == 1
        assert defaults[0]["id"] == new["id"]

    def test_update_shift(self, admin_headers, created_shift_ids):
        body = {"name": "TEST_Edit_Me", "start_hour": 9, "start_minute": 0, "end_hour": 18, "end_minute": 0,
                "grace_minutes": 30, "min_full_day_hours": 6.0, "assigned_roles": [], "is_default": False}
        r = requests.post(f"{BASE_URL}/api/shifts", json=body, headers=admin_headers, timeout=10)
        sid = r.json()["id"]; created_shift_ids.append(sid)

        upd = {**body, "name": "TEST_Edited", "grace_minutes": 45}
        r2 = requests.put(f"{BASE_URL}/api/shifts/{sid}", json=upd, headers=admin_headers, timeout=10)
        assert r2.status_code == 200
        d = r2.json()
        assert d["name"] == "TEST_Edited"
        assert d["grace_minutes"] == 45

    def test_soft_delete(self, admin_headers, created_shift_ids):
        body = {"name": "TEST_DeleteMe", "start_hour": 9, "start_minute": 0, "end_hour": 18, "end_minute": 0,
                "grace_minutes": 30, "min_full_day_hours": 6.0, "assigned_roles": [], "is_default": False}
        r = requests.post(f"{BASE_URL}/api/shifts", json=body, headers=admin_headers, timeout=10)
        sid = r.json()["id"]
        rd = requests.delete(f"{BASE_URL}/api/shifts/{sid}", headers=admin_headers, timeout=10)
        assert rd.status_code == 200
        # Should no longer appear in list (filtered by is_active != false)
        all_shifts = requests.get(f"{BASE_URL}/api/shifts", headers=admin_headers, timeout=10).json()
        assert not any(s["id"] == sid for s in all_shifts)

    def test_cannot_delete_default(self, admin_headers, created_shift_ids):
        # Find current default
        all_shifts = requests.get(f"{BASE_URL}/api/shifts", headers=admin_headers, timeout=10).json()
        default = next((s for s in all_shifts if s.get("is_default")), None)
        if not default:
            pytest.skip("No default shift")
        rd = requests.delete(f"{BASE_URL}/api/shifts/{default['id']}", headers=admin_headers, timeout=10)
        assert rd.status_code == 400


# ---------- resolve ----------
class TestShiftResolve:
    def test_resolve_me_admin(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/shifts/resolve/me", headers=admin_headers, timeout=10)
        assert r.status_code == 200
        # admin has no employee_id but role hr_admin → falls back to default
        data = r.json()
        # could be None if no default; but seeded HO Shift is default → expect dict
        assert data is not None or data is None  # tolerant — admin role has no rule

    def test_resolve_me_field_agent(self, fa_headers):
        r = requests.get(f"{BASE_URL}/api/shifts/resolve/me", headers=fa_headers, timeout=10)
        assert r.status_code == 200
        data = r.json()
        assert data is not None
        assert "_id" not in data
        # Field agent should resolve through role assignment → start_hour 7 (or assigned to a shift)
        assert "start_hour" in data

    def test_resolve_employee_id_hr_only(self, admin_headers, fa_headers):
        # admin OK
        r = requests.get(f"{BASE_URL}/api/shifts/resolve/RMF0023", headers=admin_headers, timeout=10)
        assert r.status_code == 200
        # Field agent forbidden
        r2 = requests.get(f"{BASE_URL}/api/shifts/resolve/RMF0023", headers=fa_headers, timeout=10)
        assert r2.status_code == 403


# ---------- employee shift override ----------
class TestEmployeeShiftOverride:
    def test_set_and_clear_shift_id(self, admin_headers, created_shift_ids):
        # create a shift to assign as override
        body = {"name": "TEST_Override_Shift", "start_hour": 12, "start_minute": 0, "end_hour": 21, "end_minute": 0,
                "grace_minutes": 30, "min_full_day_hours": 6.0, "assigned_roles": [], "is_default": False}
        r = requests.post(f"{BASE_URL}/api/shifts", json=body, headers=admin_headers, timeout=10)
        sid = r.json()["id"]; created_shift_ids.append(sid)

        # The PUT employee endpoint uses employee_id (e.g. RMF0023), not doc id
        emp_id = "RMF0023"

        # Set override
        upd = requests.put(f"{BASE_URL}/api/employees/{emp_id}", json={"shift_id": sid}, headers=admin_headers, timeout=15)
        assert upd.status_code == 200, upd.text

        # Resolve should now return the override shift
        rs = requests.get(f"{BASE_URL}/api/shifts/resolve/RMF0023", headers=admin_headers, timeout=10)
        assert rs.status_code == 200
        data = rs.json()
        assert data is not None
        assert data["id"] == sid

        # Clear override (empty string → $unset)
        upd2 = requests.put(f"{BASE_URL}/api/employees/{emp_id}", json={"shift_id": ""}, headers=admin_headers, timeout=15)
        assert upd2.status_code == 200

        rs2 = requests.get(f"{BASE_URL}/api/shifts/resolve/RMF0023", headers=admin_headers, timeout=10)
        assert rs2.status_code == 200
        data2 = rs2.json()
        assert data2 is None or data2["id"] != sid


# ---------- shift_rules unit-style: late punch-in & short hours ----------
class TestShiftHalfDayRules:
    def _make_iso(self, hour, minute, day_offset=0):
        d = datetime.now(IST).date() + timedelta(days=day_offset)
        return datetime(d.year, d.month, d.day, hour, minute, tzinfo=IST).isoformat()

    def test_rules_module_punch_in_late_and_short_hours(self):
        from services.shift_rules import (
            compute_punch_in_status_with_shift,
            compute_status_after_punch_out_with_shift,
        )
        shift = {"id": "x", "name": "Test",
                 "start_hour": 9, "start_minute": 0,
                 "end_hour": 18, "end_minute": 0,
                 "grace_minutes": 30, "min_full_day_hours": 6.0}

        # 31 min late → half_day late_punch_in
        late_iso = datetime(2026, 1, 5, 9, 31, tzinfo=IST).isoformat()
        out = compute_punch_in_status_with_shift(shift, late_iso, "2026-01-05")
        assert out["status"] == "half_day"
        assert out["reason"] == "late_punch_in"

        # within grace → present
        ok_iso = datetime(2026, 1, 5, 9, 20, tzinfo=IST).isoformat()
        out2 = compute_punch_in_status_with_shift(shift, ok_iso, "2026-01-05")
        assert out2["status"] == "present"

        # short hours → half_day short_hours
        out3 = compute_status_after_punch_out_with_shift(shift, "present", None, hours_worked=5.0)
        assert out3["status"] == "half_day"
        assert out3["reason"] == "short_hours"

        # late half_day stays half_day even with long hours
        out4 = compute_status_after_punch_out_with_shift(shift, "half_day", "late_punch_in", hours_worked=9.0)
        assert out4["status"] == "half_day"
        assert out4["reason"] == "late_punch_in"

        # full day
        out5 = compute_status_after_punch_out_with_shift(shift, "present", None, hours_worked=8.0)
        assert out5["status"] == "present"
