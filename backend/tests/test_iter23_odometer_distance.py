"""
Iteration 23 — Odometer + Distance backend regression tests.
Tests:
  - toggle_odometer: false→true→false round-trip
  - toggle_odometer: iter21 bug fix — employee with no odometer_required field doesn't 404
  - my-status: admin and employee variants
  - reading submission (start + end)
  - day detail
  - employees list
  - distance report (GET /tracker/distance) — rows + total_gps_km
  - distance export (GET /tracker/distance/export) — xlsx blob
"""

import pytest
import requests
import os
import io

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")

ADMIN_CREDS = {"username": "admin", "password": "Admin@12345"}
EMP_CREDS   = {"username": "RMF0006", "password": "Radhya@123"}
# RMF0003 has odometer_required=True from previous test iterations
TRACKED_EMP = "RMF0003"
TEST_EMP    = "RMF0006"   # restored to False in iter22; may need toggling


# ─── helpers ─────────────────────────────────────────────────────────────────

def login(creds) -> str:
    """Return a valid JWT token for the given credentials."""
    r = requests.post(f"{BASE_URL}/api/auth/login", json=creds)
    assert r.status_code == 200, f"Login failed {r.status_code}: {r.text}"
    token = r.json().get("access_token") or r.json().get("token")
    assert token, f"No token in response: {r.json()}"
    return token


def admin_headers():
    token = login(ADMIN_CREDS)
    return {"Authorization": f"Bearer {token}"}


def emp_headers():
    token = login(EMP_CREDS)
    return {"Authorization": f"Bearer {token}"}


# ─── Odometer employees list ──────────────────────────────────────────────────

class TestOdometerEmployeesList:
    """GET /tracker/odometer/employees"""

    def test_returns_200(self):
        r = requests.get(f"{BASE_URL}/api/tracker/odometer/employees", headers=admin_headers())
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"

    def test_returns_list(self):
        r = requests.get(f"{BASE_URL}/api/tracker/odometer/employees", headers=admin_headers())
        data = r.json()
        assert isinstance(data, list), f"Expected list, got {type(data)}"
        assert len(data) > 0, "Expected at least one employee"

    def test_employee_fields_present(self):
        r = requests.get(f"{BASE_URL}/api/tracker/odometer/employees", headers=admin_headers())
        row = r.json()[0]
        assert "employee_id" in row
        assert "name" in row
        assert "odometer_required" in row
        assert isinstance(row["odometer_required"], bool)

    def test_403_for_employee_role(self):
        r = requests.get(f"{BASE_URL}/api/tracker/odometer/employees", headers=emp_headers())
        assert r.status_code == 403, f"Expected 403, got {r.status_code}"

    def test_401_unauthenticated(self):
        r = requests.get(f"{BASE_URL}/api/tracker/odometer/employees")
        assert r.status_code in (401, 403), f"Expected 401/403, got {r.status_code}"


# ─── Toggle odometer (iter21 bug fix preserved) ──────────────────────────────

class TestToggleOdometer:
    """POST /tracker/odometer/toggle/{employee_id}"""

    def _get_state(self, emp_id) -> bool:
        r = requests.get(f"{BASE_URL}/api/tracker/odometer/employees", headers=admin_headers())
        for e in r.json():
            if e["employee_id"] == emp_id:
                return bool(e.get("odometer_required"))
        return False

    def test_toggle_false_to_true(self):
        """Toggle TEST_EMP on and verify."""
        hdr = admin_headers()
        # Ensure starting state is False
        before = self._get_state(TEST_EMP)
        if before:
            requests.post(f"{BASE_URL}/api/tracker/odometer/toggle/{TEST_EMP}", headers=hdr)
        r = requests.post(f"{BASE_URL}/api/tracker/odometer/toggle/{TEST_EMP}", headers=hdr)
        assert r.status_code == 200, f"Toggle failed {r.status_code}: {r.text}"
        data = r.json()
        assert data["odometer_required"] is True
        assert data["employee_id"] == TEST_EMP

    def test_toggle_true_to_false(self):
        """Toggle TEST_EMP back off and verify."""
        hdr = admin_headers()
        # Ensure state is True
        if not self._get_state(TEST_EMP):
            requests.post(f"{BASE_URL}/api/tracker/odometer/toggle/{TEST_EMP}", headers=hdr)
        r = requests.post(f"{BASE_URL}/api/tracker/odometer/toggle/{TEST_EMP}", headers=hdr)
        assert r.status_code == 200
        data = r.json()
        assert data["odometer_required"] is False

    def test_persistence_via_get(self):
        """After toggle to True, GET list confirms persisted state."""
        hdr = admin_headers()
        if not self._get_state(TEST_EMP):
            requests.post(f"{BASE_URL}/api/tracker/odometer/toggle/{TEST_EMP}", headers=hdr)
        state = self._get_state(TEST_EMP)
        assert state is True, "Expected odometer_required=True after toggle"

    def test_403_for_employee_role(self):
        r = requests.post(f"{BASE_URL}/api/tracker/odometer/toggle/{TEST_EMP}", headers=emp_headers())
        assert r.status_code == 403

    def test_404_for_nonexistent_employee(self):
        r = requests.post(f"{BASE_URL}/api/tracker/odometer/toggle/RMF_DOES_NOT_EXIST_XYZ", headers=admin_headers())
        assert r.status_code == 404

    def test_iter21_fix_employee_without_field(self):
        """
        iter21 regression: toggling an employee whose odometer_required field was
        NEVER set in DB must return 200 (not 404).
        
        Find any employee that is odometer_required=False — they may never have had
        the field set. If we toggle them we should get 200 back with a new state.
        We immediately restore to original state.
        """
        hdr = admin_headers()
        # Find an employee with odometer_required=False (likely no field in DB)
        emps = requests.get(f"{BASE_URL}/api/tracker/odometer/employees", headers=hdr).json()
        candidate = next((e for e in emps if not e["odometer_required"]), None)
        if candidate is None:
            pytest.skip("No employee with odometer_required=False to test iter21 fix")
        
        emp_id = candidate["employee_id"]
        r = requests.post(f"{BASE_URL}/api/tracker/odometer/toggle/{emp_id}", headers=hdr)
        assert r.status_code == 200, (
            f"iter21 bug! Expected 200 but got {r.status_code} for employee "
            f"{emp_id} (odometer_required was False/missing in DB)"
        )
        assert r.json()["odometer_required"] is True
        # Restore
        requests.post(f"{BASE_URL}/api/tracker/odometer/toggle/{emp_id}", headers=hdr)

    def teardown_method(self, method):
        """Ensure TEST_EMP is restored to False after each test."""
        hdr = admin_headers()
        state = self._get_state(TEST_EMP)
        if state:
            requests.post(f"{BASE_URL}/api/tracker/odometer/toggle/{TEST_EMP}", headers=hdr)


# ─── my-status ───────────────────────────────────────────────────────────────

class TestMyOdometerStatus:
    """GET /tracker/odometer/my-status"""

    def test_admin_returns_required_false(self):
        """Admin has no employee_id — should get {required: false}."""
        r = requests.get(f"{BASE_URL}/api/tracker/odometer/my-status", headers=admin_headers())
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
        data = r.json()
        assert data.get("required") is False

    def test_employee_not_tracked_returns_required_false(self):
        """RMF0006 (restored to False in iter22) should return {required: false}."""
        # Ensure RMF0006 is not tracked
        hdr_a = admin_headers()
        emps = requests.get(f"{BASE_URL}/api/tracker/odometer/employees", headers=hdr_a).json()
        state = next((e["odometer_required"] for e in emps if e["employee_id"] == TEST_EMP), False)
        if state:
            requests.post(f"{BASE_URL}/api/tracker/odometer/toggle/{TEST_EMP}", headers=hdr_a)

        r = requests.get(f"{BASE_URL}/api/tracker/odometer/my-status", headers=emp_headers())
        assert r.status_code == 200
        data = r.json()
        assert data.get("required") is False

    def test_tracked_employee_returns_full_status(self):
        """TRACKED_EMP (RMF0003, odometer_required=True) returns all status fields."""
        # Login as RMF0003
        token = login({"username": TRACKED_EMP, "password": "Radhya@123"})
        hdr = {"Authorization": f"Bearer {token}"}
        r = requests.get(f"{BASE_URL}/api/tracker/odometer/my-status", headers=hdr)
        assert r.status_code == 200
        data = r.json()
        # If required=True, the full set of fields must be present
        if data.get("required"):
            for field in ["date", "punched_in", "punched_out", "start_done", "end_done"]:
                assert field in data, f"Missing field: {field}"

    def test_401_unauthenticated(self):
        r = requests.get(f"{BASE_URL}/api/tracker/odometer/my-status")
        assert r.status_code in (401, 403)


# ─── Reading submission ───────────────────────────────────────────────────────

class TestOdometerReading:
    """POST /tracker/odometer/reading"""

    def _enable_emp(self):
        """Enable odometer for TEST_EMP so readings are accepted."""
        hdr = admin_headers()
        emps = requests.get(f"{BASE_URL}/api/tracker/odometer/employees", headers=hdr).json()
        state = next((e["odometer_required"] for e in emps if e["employee_id"] == TEST_EMP), False)
        if not state:
            requests.post(f"{BASE_URL}/api/tracker/odometer/toggle/{TEST_EMP}", headers=hdr)

    def _disable_emp(self):
        hdr = admin_headers()
        emps = requests.get(f"{BASE_URL}/api/tracker/odometer/employees", headers=hdr).json()
        state = next((e["odometer_required"] for e in emps if e["employee_id"] == TEST_EMP), False)
        if state:
            requests.post(f"{BASE_URL}/api/tracker/odometer/toggle/{TEST_EMP}", headers=hdr)

    def test_start_reading_accepted(self):
        self._enable_emp()
        r = requests.post(f"{BASE_URL}/api/tracker/odometer/reading",
                          json={"kind": "start", "reading_km": 50100},
                          headers=emp_headers())
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
        data = r.json()
        assert data.get("ok") is True

    def test_end_reading_returns_distance(self):
        """After start (50100) and end (50220) we should get distance_km=120."""
        self._enable_emp()
        hdr = emp_headers()
        requests.post(f"{BASE_URL}/api/tracker/odometer/reading",
                      json={"kind": "start", "reading_km": 50100}, headers=hdr)
        r = requests.post(f"{BASE_URL}/api/tracker/odometer/reading",
                          json={"kind": "end", "reading_km": 50220}, headers=hdr)
        assert r.status_code == 200
        data = r.json()
        assert data.get("ok") is True
        assert data.get("distance_km") == 120.0

    def test_invalid_kind_returns_400(self):
        self._enable_emp()
        r = requests.post(f"{BASE_URL}/api/tracker/odometer/reading",
                          json={"kind": "middle", "reading_km": 50000},
                          headers=emp_headers())
        assert r.status_code in (400, 422)

    def test_admin_blocked_on_reading(self):
        """Admin has no employee_id — must get 400."""
        r = requests.post(f"{BASE_URL}/api/tracker/odometer/reading",
                          json={"kind": "start", "reading_km": 50000},
                          headers=admin_headers())
        assert r.status_code == 400

    def teardown_method(self, method):
        self._disable_emp()


# ─── Day detail ───────────────────────────────────────────────────────────────

class TestOdometerDay:
    """GET /tracker/odometer/day/{employee_id}"""

    def test_returns_200_for_existing_employee(self):
        r = requests.get(f"{BASE_URL}/api/tracker/odometer/day/{TRACKED_EMP}",
                         headers=admin_headers())
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"

    def test_response_fields(self):
        r = requests.get(f"{BASE_URL}/api/tracker/odometer/day/{TRACKED_EMP}",
                         headers=admin_headers())
        data = r.json()
        assert "employee_id" in data
        assert "date" in data
        assert "start" in data
        assert "end" in data
        assert "distance_km" in data
        assert data["employee_id"] == TRACKED_EMP

    def test_nonexistent_employee_returns_200_with_nulls(self):
        """Audit view: nonexistent employee should get 200 with null readings."""
        r = requests.get(f"{BASE_URL}/api/tracker/odometer/day/RMF_NO_EXIST_777",
                         headers=admin_headers())
        assert r.status_code == 200
        data = r.json()
        assert data.get("start") is None
        assert data.get("end") is None
        assert data.get("distance_km") is None

    def test_403_for_employee_role(self):
        r = requests.get(f"{BASE_URL}/api/tracker/odometer/day/{TRACKED_EMP}",
                         headers=emp_headers())
        assert r.status_code == 403

    def test_401_unauthenticated(self):
        r = requests.get(f"{BASE_URL}/api/tracker/odometer/day/{TRACKED_EMP}")
        assert r.status_code in (401, 403)


# ─── Distance report ─────────────────────────────────────────────────────────

class TestDistanceReport:
    """GET /tracker/distance"""

    def test_today_returns_200(self):
        r = requests.get(f"{BASE_URL}/api/tracker/distance", headers=admin_headers())
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"

    def test_response_has_required_fields(self):
        r = requests.get(f"{BASE_URL}/api/tracker/distance", headers=admin_headers())
        data = r.json()
        assert "rows" in data, "Missing 'rows' field"
        assert "total_gps_km" in data, "Missing 'total_gps_km' field"
        assert isinstance(data["rows"], list), "'rows' must be a list"
        assert isinstance(data["total_gps_km"], (int, float)), "'total_gps_km' must be numeric"

    def test_specific_date_works(self):
        import datetime
        today = datetime.date.today().strftime("%Y-%m-%d")
        r = requests.get(f"{BASE_URL}/api/tracker/distance",
                         params={"date_str": today},
                         headers=admin_headers())
        assert r.status_code == 200

    def test_row_fields_when_data_present(self):
        r = requests.get(f"{BASE_URL}/api/tracker/distance", headers=admin_headers())
        data = r.json()
        if data["rows"]:
            row = data["rows"][0]
            assert "employee_id" in row
            assert "name" in row
            assert "gps_km" in row
            assert "odo_status" in row

    def test_401_unauthenticated(self):
        r = requests.get(f"{BASE_URL}/api/tracker/distance")
        assert r.status_code in (401, 403)

    def test_403_for_employee_role(self):
        r = requests.get(f"{BASE_URL}/api/tracker/distance", headers=emp_headers())
        assert r.status_code == 403


# ─── Distance export ─────────────────────────────────────────────────────────

class TestDistanceExport:
    """GET /tracker/distance/export"""

    def test_export_returns_xlsx_blob(self):
        import datetime
        today = datetime.date.today()
        first = today.replace(day=1).strftime("%Y-%m-%d")
        last = today.strftime("%Y-%m-%d")
        r = requests.get(f"{BASE_URL}/api/tracker/distance/export",
                         params={"from_date": first, "to_date": last},
                         headers=admin_headers())
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
        ct = r.headers.get("content-type", "")
        assert "spreadsheetml" in ct or "octet-stream" in ct, f"Unexpected content-type: {ct}"
        assert len(r.content) > 100, "xlsx file is suspiciously small"

    def test_export_attachment_header(self):
        import datetime
        today = datetime.date.today()
        first = today.replace(day=1).strftime("%Y-%m-%d")
        last = today.strftime("%Y-%m-%d")
        r = requests.get(f"{BASE_URL}/api/tracker/distance/export",
                         params={"from_date": first, "to_date": last},
                         headers=admin_headers())
        assert r.status_code == 200
        cd = r.headers.get("content-disposition", "")
        assert "attachment" in cd.lower(), f"Missing attachment header: {cd}"
        assert ".xlsx" in cd, f"Filename should have .xlsx: {cd}"

    def test_export_invalid_date_returns_400(self):
        r = requests.get(f"{BASE_URL}/api/tracker/distance/export",
                         params={"from_date": "not-a-date", "to_date": "2025-01-31"},
                         headers=admin_headers())
        assert r.status_code == 400

    def test_export_range_too_large_returns_400(self):
        r = requests.get(f"{BASE_URL}/api/tracker/distance/export",
                         params={"from_date": "2020-01-01", "to_date": "2025-12-31"},
                         headers=admin_headers())
        assert r.status_code == 400

    def test_export_401_unauthenticated(self):
        import datetime
        today = datetime.date.today()
        first = today.replace(day=1).strftime("%Y-%m-%d")
        last = today.strftime("%Y-%m-%d")
        r = requests.get(f"{BASE_URL}/api/tracker/distance/export",
                         params={"from_date": first, "to_date": last})
        assert r.status_code in (401, 403)
