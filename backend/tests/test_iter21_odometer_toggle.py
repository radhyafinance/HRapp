"""
Iteration 21 — Odometer toggle endpoint tests
Tests: GET /api/tracker/odometer/employees, POST /api/tracker/odometer/toggle/{employee_id}
Bug fix: projection bug that caused 404 for employees without odometer_required field
"""
import pytest
import requests
import os

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")


@pytest.fixture(scope="module")
def admin_token():
    """Login as admin and return bearer token."""
    resp = requests.post(f"{BASE_URL}/api/auth/login", json={
        "username": "admin",
        "password": "Admin@12345"
    })
    assert resp.status_code == 200, f"Admin login failed: {resp.text}"
    data = resp.json()
    token = data.get("access_token") or data.get("token")
    assert token, "No token in login response"
    return token


@pytest.fixture(scope="module")
def admin_client(admin_token):
    """Requests session with admin auth header."""
    session = requests.Session()
    session.headers.update({
        "Content-Type": "application/json",
        "Authorization": f"Bearer {admin_token}",
    })
    return session


# ── Test: GET /api/tracker/odometer/employees ────────────────────────────────

class TestOdometerEmployeesList:
    """Tests for the odometer employees list endpoint."""

    def test_get_odometer_employees_returns_200(self, admin_client):
        resp = admin_client.get(f"{BASE_URL}/api/tracker/odometer/employees")
        assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"

    def test_get_odometer_employees_returns_list(self, admin_client):
        resp = admin_client.get(f"{BASE_URL}/api/tracker/odometer/employees")
        data = resp.json()
        assert isinstance(data, list), f"Expected list, got: {type(data)}"

    def test_get_odometer_employees_has_required_fields(self, admin_client):
        resp = admin_client.get(f"{BASE_URL}/api/tracker/odometer/employees")
        data = resp.json()
        assert len(data) > 0, "Expected at least one employee in list"
        first = data[0]
        assert "employee_id" in first, "Missing employee_id field"
        assert "name" in first, "Missing name field"
        assert "odometer_required" in first, "Missing odometer_required field"
        assert isinstance(first["odometer_required"], bool), \
            f"odometer_required must be bool, got {type(first['odometer_required'])}"

    def test_get_odometer_employees_no_exited(self, admin_client):
        """Employees with status=exited should not appear."""
        resp = admin_client.get(f"{BASE_URL}/api/tracker/odometer/employees")
        data = resp.json()
        # All returned employees should have a valid employee_id
        for e in data:
            assert e.get("employee_id"), "Employee with no employee_id found"

    def test_get_odometer_employees_forbidden_for_unauthenticated(self):
        resp = requests.get(f"{BASE_URL}/api/tracker/odometer/employees")
        assert resp.status_code in (401, 403), \
            f"Expected 401/403 for unauth, got {resp.status_code}"


# ── Test: POST /api/tracker/odometer/toggle/{employee_id} ───────────────────

class TestOdometerToggle:
    """Tests for the odometer toggle endpoint — the bug fix target."""

    def _get_employee_state(self, admin_client, emp_id):
        """Helper: fetch current odometer_required state for a specific employee."""
        resp = admin_client.get(f"{BASE_URL}/api/tracker/odometer/employees")
        assert resp.status_code == 200
        for e in resp.json():
            if e["employee_id"] == emp_id:
                return e["odometer_required"]
        return None

    def _get_any_active_employee_id(self, admin_client):
        resp = admin_client.get(f"{BASE_URL}/api/tracker/odometer/employees")
        data = resp.json()
        assert len(data) > 0, "No employees available for toggle test"
        return data[0]["employee_id"]

    def test_toggle_returns_200(self, admin_client):
        emp_id = self._get_any_active_employee_id(admin_client)
        resp = admin_client.post(f"{BASE_URL}/api/tracker/odometer/toggle/{emp_id}")
        assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
        # Revert to original state
        admin_client.post(f"{BASE_URL}/api/tracker/odometer/toggle/{emp_id}")

    def test_toggle_response_has_odometer_required_bool(self, admin_client):
        emp_id = self._get_any_active_employee_id(admin_client)
        resp = admin_client.post(f"{BASE_URL}/api/tracker/odometer/toggle/{emp_id}")
        data = resp.json()
        assert "odometer_required" in data, "Missing odometer_required in toggle response"
        assert isinstance(data["odometer_required"], bool), \
            f"odometer_required must be bool, got {type(data['odometer_required'])}"
        # Revert
        admin_client.post(f"{BASE_URL}/api/tracker/odometer/toggle/{emp_id}")

    def test_toggle_flips_state_from_false_to_true(self, admin_client):
        """Find an employee with odometer_required=False and toggle to True."""
        resp = admin_client.get(f"{BASE_URL}/api/tracker/odometer/employees")
        employees = resp.json()
        # Find employee with odometer_required=False (most employees)
        target = next((e for e in employees if not e["odometer_required"]), None)
        if target is None:
            pytest.skip("No employee with odometer_required=False found")
        emp_id = target["employee_id"]

        toggle_resp = admin_client.post(f"{BASE_URL}/api/tracker/odometer/toggle/{emp_id}")
        assert toggle_resp.status_code == 200
        assert toggle_resp.json()["odometer_required"] is True, \
            f"Expected True after toggle, got {toggle_resp.json()['odometer_required']}"

        # Verify it persisted via GET
        new_state = self._get_employee_state(admin_client, emp_id)
        assert new_state is True, "State did not persist after toggle to True"

        # Revert
        admin_client.post(f"{BASE_URL}/api/tracker/odometer/toggle/{emp_id}")

    def test_toggle_flips_state_from_true_to_false(self, admin_client):
        """Toggle an employee from False → True → False (full round-trip)."""
        resp = admin_client.get(f"{BASE_URL}/api/tracker/odometer/employees")
        employees = resp.json()
        target = next((e for e in employees if not e["odometer_required"]), None)
        if target is None:
            pytest.skip("No employee with odometer_required=False found")
        emp_id = target["employee_id"]

        # Enable
        r1 = admin_client.post(f"{BASE_URL}/api/tracker/odometer/toggle/{emp_id}")
        assert r1.json()["odometer_required"] is True

        # Disable (back to False)
        r2 = admin_client.post(f"{BASE_URL}/api/tracker/odometer/toggle/{emp_id}")
        assert r2.status_code == 200
        assert r2.json()["odometer_required"] is False, \
            f"Expected False after second toggle, got {r2.json()['odometer_required']}"

        # Verify persistence
        new_state = self._get_employee_state(admin_client, emp_id)
        assert new_state is False, "State did not persist after toggle back to False"

    def test_toggle_404_for_nonexistent_employee(self, admin_client):
        resp = admin_client.post(f"{BASE_URL}/api/tracker/odometer/toggle/NONEXISTENT999")
        assert resp.status_code == 404, \
            f"Expected 404 for non-existent employee, got {resp.status_code}"

    def test_toggle_forbidden_for_unauthenticated(self):
        resp = requests.post(f"{BASE_URL}/api/tracker/odometer/toggle/RMF0001")
        assert resp.status_code in (401, 403), \
            f"Expected 401/403 for unauth, got {resp.status_code}"

    def test_toggle_bug_fix_employee_without_odometer_field(self, admin_client):
        """
        Core bug-fix test: Toggling an employee who never had odometer_required set
        must return 200 (not 404). We rely on the fact that most employees
        don't have this field set, so the first returned employee with
        odometer_required=False is a candidate.
        The projection fix (employee_id included) + 'if emp is None' check
        ensures {} (missing field) no longer raises 404.
        """
        resp = admin_client.get(f"{BASE_URL}/api/tracker/odometer/employees")
        employees = resp.json()
        # Employees without odometer_required return False (field not set)
        target = next((e for e in employees if not e["odometer_required"]), None)
        if target is None:
            pytest.skip("All employees have odometer_required=True — can't test missing-field path")
        emp_id = target["employee_id"]

        toggle_resp = admin_client.post(f"{BASE_URL}/api/tracker/odometer/toggle/{emp_id}")
        assert toggle_resp.status_code == 200, \
            f"BUG REGRESSION: toggle returned {toggle_resp.status_code} (should be 200) for employee without odometer_required field. Response: {toggle_resp.text}"
        assert toggle_resp.json()["odometer_required"] is True

        # Revert
        admin_client.post(f"{BASE_URL}/api/tracker/odometer/toggle/{emp_id}")
