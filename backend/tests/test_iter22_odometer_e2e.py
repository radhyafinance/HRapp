"""
Iteration 22 – End-to-end odometer endpoint tests.

Tests cover:
- GET /api/tracker/odometer/my-status  (admin, non-tracked, tracked employee)
- POST /api/tracker/odometer/reading   (start + end; distance calculation)
- GET /api/tracker/odometer/day/{id}   (admin audit view)
- GET /api/tracker/odometer/employees  (admin list, fields, booleans)
- POST /api/tracker/odometer/toggle/{id} (false→true→false; iter-21 bug-fix regression)
- Auth guards (unauthenticated, wrong role)
"""

import pytest
import requests
import os

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")

ADMIN_CREDS  = {"username": "admin",   "password": "Admin@12345"}
EMP_CREDS    = {"username": "RMF0006", "password": "Radhya@123"}
EMP_ID       = "RMF0006"
TEST_START_KM = 50000.0
TEST_END_KM   = 50120.0
EXPECTED_DIST = 120.0


# ── Fixtures ────────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login", json=ADMIN_CREDS)
    assert r.status_code == 200, f"Admin login failed: {r.text}"
    return r.json()["access_token"]


@pytest.fixture(scope="module")
def emp_token():
    r = requests.post(f"{BASE_URL}/api/auth/login", json=EMP_CREDS)
    assert r.status_code == 200, f"Employee login failed: {r.text}"
    return r.json()["access_token"]


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture(scope="module")
def emp_headers(emp_token):
    return {"Authorization": f"Bearer {emp_token}"}


# ── Helper ──────────────────────────────────────────────────────────────────

def _ensure_odometer_state(headers, employee_id, desired: bool):
    """Set employee's odometer_required to desired value; return current state."""
    r = requests.get(f"{BASE_URL}/api/tracker/odometer/employees", headers=headers)
    assert r.status_code == 200
    emp_list = r.json()
    emp = next((e for e in emp_list if e["employee_id"] == employee_id), None)
    if emp is None:
        pytest.skip(f"Employee {employee_id} not found in odometer/employees list")
    current = emp["odometer_required"]
    if current != desired:
        tr = requests.post(f"{BASE_URL}/api/tracker/odometer/toggle/{employee_id}", headers=headers)
        assert tr.status_code == 200
        assert tr.json()["odometer_required"] == desired
    return desired


# ══════════════════════════════════════════════════════════════════════════
# 1. GET /api/tracker/odometer/employees — admin list
# ══════════════════════════════════════════════════════════════════════════

class TestOdometerEmployeesList:
    """Admin list: correct fields, boolean flag, no exited employees."""

    def test_returns_200(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/tracker/odometer/employees", headers=admin_headers)
        assert r.status_code == 200

    def test_returns_list(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/tracker/odometer/employees", headers=admin_headers)
        data = r.json()
        assert isinstance(data, list), "Should return a list"
        assert len(data) > 0, "Should have at least one employee"

    def test_required_fields_present(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/tracker/odometer/employees", headers=admin_headers)
        data = r.json()
        emp = data[0]
        for field in ("employee_id", "name", "designation", "odometer_required"):
            assert field in emp, f"Missing field: {field}"

    def test_odometer_required_is_boolean(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/tracker/odometer/employees", headers=admin_headers)
        data = r.json()
        for emp in data:
            assert isinstance(emp["odometer_required"], bool), \
                f"odometer_required must be bool for {emp['employee_id']}"

    def test_403_for_employee(self, emp_headers):
        """Regular employee cannot access admin list."""
        r = requests.get(f"{BASE_URL}/api/tracker/odometer/employees", headers=emp_headers)
        assert r.status_code in (403, 401)

    def test_401_unauthenticated(self):
        r = requests.get(f"{BASE_URL}/api/tracker/odometer/employees")
        assert r.status_code in (401, 403)


# ══════════════════════════════════════════════════════════════════════════
# 2. POST /api/tracker/odometer/toggle/{id}
# ══════════════════════════════════════════════════════════════════════════

class TestOdometerToggle:
    """Toggle: false→true→false round-trip + iter21 regression."""

    def test_toggle_false_to_true(self, admin_headers):
        _ensure_odometer_state(admin_headers, EMP_ID, False)
        r = requests.post(f"{BASE_URL}/api/tracker/odometer/toggle/{EMP_ID}", headers=admin_headers)
        assert r.status_code == 200
        data = r.json()
        assert data["employee_id"] == EMP_ID
        assert data["odometer_required"] is True

    def test_toggle_persists_true(self, admin_headers):
        """Verify toggle True was persisted by re-fetching list."""
        r = requests.get(f"{BASE_URL}/api/tracker/odometer/employees", headers=admin_headers)
        emp = next(e for e in r.json() if e["employee_id"] == EMP_ID)
        assert emp["odometer_required"] is True

    def test_toggle_true_to_false(self, admin_headers):
        _ensure_odometer_state(admin_headers, EMP_ID, True)
        r = requests.post(f"{BASE_URL}/api/tracker/odometer/toggle/{EMP_ID}", headers=admin_headers)
        assert r.status_code == 200
        assert r.json()["odometer_required"] is False

    def test_toggle_404_nonexistent_employee(self, admin_headers):
        r = requests.post(
            f"{BASE_URL}/api/tracker/odometer/toggle/NONEXISTENT9999",
            headers=admin_headers,
        )
        assert r.status_code == 404

    def test_toggle_403_for_employee(self, emp_headers):
        r = requests.post(
            f"{BASE_URL}/api/tracker/odometer/toggle/{EMP_ID}",
            headers=emp_headers,
        )
        assert r.status_code in (403, 401)

    def test_toggle_401_unauthenticated(self):
        r = requests.post(f"{BASE_URL}/api/tracker/odometer/toggle/{EMP_ID}")
        assert r.status_code in (401, 403)

    def test_iter21_regression_no_field_set(self, admin_headers):
        """Employees without odometer_required field in DB should toggle successfully (not 404)."""
        # RMF0006 may or may not have the field; we ensure it starts at False
        _ensure_odometer_state(admin_headers, EMP_ID, False)
        # Toggle should succeed even if field was missing (returns 200 not 404)
        r = requests.post(f"{BASE_URL}/api/tracker/odometer/toggle/{EMP_ID}", headers=admin_headers)
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
        # Cleanup — restore to False
        _ensure_odometer_state(admin_headers, EMP_ID, False)


# ══════════════════════════════════════════════════════════════════════════
# 3. GET /api/tracker/odometer/my-status
# ══════════════════════════════════════════════════════════════════════════

class TestMyOdometerStatus:
    """my-status: admin→{required:false}, non-tracked employee→{required:false},
    tracked employee→full status object."""

    def test_admin_returns_required_false(self, admin_headers):
        """Admin has no employee_id — backend returns {required: false} (not 400)."""
        r = requests.get(f"{BASE_URL}/api/tracker/odometer/my-status", headers=admin_headers)
        assert r.status_code == 200
        data = r.json()
        assert data.get("required") is False

    def test_non_tracked_employee_returns_required_false(self, admin_headers, emp_headers):
        """Employee with odometer_required=False → {required: false}."""
        _ensure_odometer_state(admin_headers, EMP_ID, False)
        r = requests.get(f"{BASE_URL}/api/tracker/odometer/my-status", headers=emp_headers)
        assert r.status_code == 200
        data = r.json()
        assert data.get("required") is False

    def test_tracked_employee_returns_full_status(self, admin_headers, emp_headers):
        """Employee with odometer_required=True → full status object with all required fields."""
        _ensure_odometer_state(admin_headers, EMP_ID, True)
        r = requests.get(f"{BASE_URL}/api/tracker/odometer/my-status", headers=emp_headers)
        assert r.status_code == 200
        data = r.json()
        assert data.get("required") is True
        for field in ("date", "punched_in", "punched_out", "start_done", "end_done", "start_km", "end_km", "distance_km"):
            assert field in data, f"Missing field '{field}' in my-status response"

    def test_tracked_employee_boolean_fields(self, admin_headers, emp_headers):
        _ensure_odometer_state(admin_headers, EMP_ID, True)
        r = requests.get(f"{BASE_URL}/api/tracker/odometer/my-status", headers=emp_headers)
        data = r.json()
        for bool_field in ("punched_in", "punched_out", "start_done", "end_done"):
            assert isinstance(data[bool_field], bool), f"{bool_field} must be bool"

    def test_401_unauthenticated(self):
        r = requests.get(f"{BASE_URL}/api/tracker/odometer/my-status")
        assert r.status_code in (401, 403)

    def test_cleanup_restore_false(self, admin_headers):
        """Cleanup: restore RMF0006 to non-tracked after above tests."""
        _ensure_odometer_state(admin_headers, EMP_ID, False)


# ══════════════════════════════════════════════════════════════════════════
# 4. POST /api/tracker/odometer/reading
# ══════════════════════════════════════════════════════════════════════════

class TestOdometerReading:
    """Submit start → end readings; verify distance calculation."""

    def test_setup_enable_tracking(self, admin_headers):
        """Enable odometer tracking for test employee before reading tests."""
        _ensure_odometer_state(admin_headers, EMP_ID, True)

    def test_submit_start_reading(self, emp_headers):
        r = requests.post(
            f"{BASE_URL}/api/tracker/odometer/reading",
            json={"kind": "start", "reading_km": TEST_START_KM},
            headers=emp_headers,
        )
        assert r.status_code == 200
        data = r.json()
        assert data.get("ok") is True
        # distance_km is None when only start is submitted
        assert data.get("distance_km") is None

    def test_submit_end_reading(self, emp_headers):
        r = requests.post(
            f"{BASE_URL}/api/tracker/odometer/reading",
            json={"kind": "end", "reading_km": TEST_END_KM},
            headers=emp_headers,
        )
        assert r.status_code == 200
        data = r.json()
        assert data.get("ok") is True
        assert data.get("distance_km") == EXPECTED_DIST, \
            f"Expected {EXPECTED_DIST} km, got {data.get('distance_km')}"

    def test_invalid_kind_rejected(self, emp_headers):
        r = requests.post(
            f"{BASE_URL}/api/tracker/odometer/reading",
            json={"kind": "invalid", "reading_km": 12345},
            headers=emp_headers,
        )
        assert r.status_code in (400, 422)

    def test_admin_returns_400_no_employee(self, admin_headers):
        """Admin has no employee_id — reading submission should fail with 400."""
        r = requests.post(
            f"{BASE_URL}/api/tracker/odometer/reading",
            json={"kind": "start", "reading_km": 99999},
            headers=admin_headers,
        )
        assert r.status_code == 400

    def test_401_unauthenticated(self):
        r = requests.post(
            f"{BASE_URL}/api/tracker/odometer/reading",
            json={"kind": "start", "reading_km": TEST_START_KM},
        )
        assert r.status_code in (401, 403)

    def test_idempotent_start_overwrite(self, emp_headers):
        """Re-submitting start reading updates (upsert) — returns 200."""
        r = requests.post(
            f"{BASE_URL}/api/tracker/odometer/reading",
            json={"kind": "start", "reading_km": TEST_START_KM + 1},
            headers=emp_headers,
        )
        assert r.status_code == 200
        assert r.json().get("ok") is True


# ══════════════════════════════════════════════════════════════════════════
# 5. GET /api/tracker/odometer/day/{employee_id}
# ══════════════════════════════════════════════════════════════════════════

class TestOdometerDayDetail:
    """Admin day-detail: start/end readings, distance_km."""

    def test_returns_200(self, admin_headers):
        r = requests.get(
            f"{BASE_URL}/api/tracker/odometer/day/{EMP_ID}",
            headers=admin_headers,
        )
        assert r.status_code == 200

    def test_required_fields(self, admin_headers):
        r = requests.get(
            f"{BASE_URL}/api/tracker/odometer/day/{EMP_ID}",
            headers=admin_headers,
        )
        data = r.json()
        for field in ("employee_id", "date", "start", "end", "distance_km"):
            assert field in data, f"Missing field: {field}"

    def test_employee_id_matches(self, admin_headers):
        r = requests.get(
            f"{BASE_URL}/api/tracker/odometer/day/{EMP_ID}",
            headers=admin_headers,
        )
        assert r.json()["employee_id"] == EMP_ID

    def test_start_end_readings_present_after_submission(self, admin_headers):
        """After submitting both readings, start and end should be non-null."""
        r = requests.get(
            f"{BASE_URL}/api/tracker/odometer/day/{EMP_ID}",
            headers=admin_headers,
        )
        data = r.json()
        # start was submitted (50001.0 after overwrite), end was submitted (50120.0)
        assert data["start"] is not None, "start reading should be present after submission"
        assert data["end"] is not None, "end reading should be present after submission"

    def test_distance_calculated(self, admin_headers):
        """distance_km should be calculated when both start and end are present."""
        r = requests.get(
            f"{BASE_URL}/api/tracker/odometer/day/{EMP_ID}",
            headers=admin_headers,
        )
        data = r.json()
        if data["start"] and data["end"]:
            assert data["distance_km"] is not None, "distance_km should be calculated"
            assert isinstance(data["distance_km"], (int, float))
            assert data["distance_km"] >= 0

    def test_nonexistent_employee_returns_empty_not_404(self, admin_headers):
        """Day detail for unknown employee returns 200 with null start/end (not 404)."""
        r = requests.get(
            f"{BASE_URL}/api/tracker/odometer/day/NONEXISTENT9999",
            headers=admin_headers,
        )
        assert r.status_code == 200
        data = r.json()
        assert data["start"] is None
        assert data["end"] is None
        assert data["distance_km"] is None

    def test_403_for_employee(self, emp_headers):
        r = requests.get(
            f"{BASE_URL}/api/tracker/odometer/day/{EMP_ID}",
            headers=emp_headers,
        )
        assert r.status_code in (403, 401)

    def test_401_unauthenticated(self):
        r = requests.get(f"{BASE_URL}/api/tracker/odometer/day/{EMP_ID}")
        assert r.status_code in (401, 403)

    def test_cleanup_disable_tracking(self, admin_headers):
        """Cleanup: disable odometer tracking for RMF0006 after all reading tests."""
        _ensure_odometer_state(admin_headers, EMP_ID, False)
