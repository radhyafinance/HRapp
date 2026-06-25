"""
Backend tests for:
1. Admin Apply Leave for Employee (POST /api/leaves with employee_id)
2. Admin-applied leave auto-approved, applied_by_admin=true, balance deducted
3. Policy bypass for admin (e.g., CL > 2 days allowed)
4. Regular employee leave is pending
5. POST /api/exit/admin/run-auto-exit endpoint
"""
import pytest
import requests
import os
from datetime import date, timedelta

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")


# ──────────────────────────────────────────────────────────────
#  Auth helpers
# ──────────────────────────────────────────────────────────────
def get_admin_token():
    resp = requests.post(f"{BASE_URL}/api/auth/login", json={"username": "admin", "password": "Admin@12345"})
    assert resp.status_code == 200, f"Admin login failed: {resp.text}"
    # Token key is "access_token"
    return resp.json()["access_token"]


def get_employee_token(username="RMF0005", password="Radhya@123"):
    """Use RMF0005 — regular employee confirmed working with Radhya@123."""
    resp = requests.post(f"{BASE_URL}/api/auth/login", json={"username": username, "password": password})
    assert resp.status_code == 200, f"Employee login failed: {resp.text}"
    return resp.json()["access_token"]


def admin_headers():
    return {"Authorization": f"Bearer {get_admin_token()}"}


def employee_headers():
    return {"Authorization": f"Bearer {get_employee_token()}"}


# ──────────────────────────────────────────────────────────────
#  Leave cleanup helper
# ──────────────────────────────────────────────────────────────
CREATED_LEAVE_IDS = []


def cleanup_leave(leave_id: str, headers: dict):
    """Cancel a leave record — admin-cancel for approved, no endpoint for pending (just record for manual cleanup)."""
    try:
        requests.put(f"{BASE_URL}/api/leaves/{leave_id}/admin-cancel", json={"reason": "Test cleanup"}, headers=headers)
    except Exception:
        pass


# ──────────────────────────────────────────────────────────────
#  Test 1 — Admin applies leave for employee → auto-approved
# ──────────────────────────────────────────────────────────────
class TestAdminApplyLeaveForEmployee:
    """Admin applying leave on behalf of another employee."""

    leave_id = None  # class-level to share between tests
    target_employee = "RMF0002"
    # Use future dates to avoid conflicts
    start_date = (date.today() + timedelta(days=60)).isoformat()
    end_date = (date.today() + timedelta(days=60)).isoformat()

    @pytest.fixture(autouse=True, scope="class")
    def setup_and_teardown(self):
        yield
        # Cleanup: cancel the leave we created
        if TestAdminApplyLeaveForEmployee.leave_id:
            cleanup_leave(TestAdminApplyLeaveForEmployee.leave_id, admin_headers())

    def test_admin_apply_leave_returns_200(self):
        """Admin can POST /api/leaves with another employee's employee_id."""
        payload = {
            "employee_id": self.target_employee,
            "leave_type": "CL",
            "start_date": self.start_date,
            "end_date": self.end_date,
            "reason": "Admin applied for test",
        }
        resp = requests.post(f"{BASE_URL}/api/leaves", json=payload, headers=admin_headers())
        print(f"Admin apply leave response: {resp.status_code} — {resp.text[:300]}")
        assert resp.status_code == 200, f"Expected 200 got {resp.status_code}: {resp.text}"

        data = resp.json()
        TestAdminApplyLeaveForEmployee.leave_id = data.get("id")
        assert data.get("id"), "Response must contain 'id'"
        print(f"PASS: Admin applied leave, id={data['id']}")

    def test_admin_applied_leave_has_approved_status(self):
        """Status must be 'approved' immediately when admin applies."""
        leave_id = TestAdminApplyLeaveForEmployee.leave_id
        if not leave_id:
            pytest.skip("Prerequisite test (apply leave) did not run")

        resp = requests.get(f"{BASE_URL}/api/leaves/{leave_id}", headers=admin_headers())
        assert resp.status_code == 200
        data = resp.json()
        assert data.get("status") == "approved", f"Expected status=approved, got {data.get('status')}"
        print(f"PASS: status=approved confirmed in DB")

    def test_admin_applied_leave_has_applied_by_admin_true(self):
        """applied_by_admin must be True for admin-applied leaves."""
        leave_id = TestAdminApplyLeaveForEmployee.leave_id
        if not leave_id:
            pytest.skip("Prerequisite test (apply leave) did not run")

        resp = requests.get(f"{BASE_URL}/api/leaves/{leave_id}", headers=admin_headers())
        assert resp.status_code == 200
        data = resp.json()
        assert data.get("applied_by_admin") is True, f"applied_by_admin should be True, got {data.get('applied_by_admin')}"
        print(f"PASS: applied_by_admin=True confirmed")

    def test_admin_applied_leave_has_approved_by_set(self):
        """approved_by must be set to admin's id when admin applies."""
        leave_id = TestAdminApplyLeaveForEmployee.leave_id
        if not leave_id:
            pytest.skip("Prerequisite test (apply leave) did not run")

        resp = requests.get(f"{BASE_URL}/api/leaves/{leave_id}", headers=admin_headers())
        assert resp.status_code == 200
        data = resp.json()
        assert data.get("approved_by") is not None, "approved_by should be set"
        print(f"PASS: approved_by={data['approved_by']}")


# ──────────────────────────────────────────────────────────────
#  Test 2 — Admin-applied leave deducts balance immediately
# ──────────────────────────────────────────────────────────────
class TestAdminApplyLeaveBalanceDeduction:
    """Verify balance deduction happens immediately on admin-applied leave."""

    target_employee = "RMF0003"
    # Use specific dates unlikely to conflict
    start_date = (date.today() + timedelta(days=70)).isoformat()
    end_date = (date.today() + timedelta(days=70)).isoformat()
    leave_id = None
    initial_cl_remaining = None

    @pytest.fixture(autouse=True, scope="class")
    def setup_and_teardown(self):
        yield
        if TestAdminApplyLeaveBalanceDeduction.leave_id:
            cleanup_leave(TestAdminApplyLeaveBalanceDeduction.leave_id, admin_headers())

    def test_get_initial_balance(self):
        """Record initial CL balance before applying leave."""
        resp = requests.get(f"{BASE_URL}/api/leaves/balance/{self.target_employee}", headers=admin_headers())
        assert resp.status_code == 200
        data = resp.json()
        TestAdminApplyLeaveBalanceDeduction.initial_cl_remaining = data.get("CL", {}).get("remaining", None)
        print(f"Initial CL remaining for {self.target_employee}: {TestAdminApplyLeaveBalanceDeduction.initial_cl_remaining}")

    def test_admin_apply_cl_leave_for_employee(self):
        """Admin applies 1-day CL leave for another employee."""
        payload = {
            "employee_id": self.target_employee,
            "leave_type": "CL",
            "start_date": self.start_date,
            "end_date": self.end_date,
            "reason": "Balance deduction test",
        }
        resp = requests.post(f"{BASE_URL}/api/leaves", json=payload, headers=admin_headers())
        print(f"Apply leave status: {resp.status_code}")
        assert resp.status_code == 200
        data = resp.json()
        TestAdminApplyLeaveBalanceDeduction.leave_id = data.get("id")
        assert data["status"] == "approved"
        print(f"PASS: Leave applied and auto-approved: id={data['id']}")

    def test_balance_decremented_after_admin_apply(self):
        """CL balance must be decremented by 1 after admin-applied leave."""
        if TestAdminApplyLeaveBalanceDeduction.initial_cl_remaining is None:
            pytest.skip("Initial balance not fetched")
        if not TestAdminApplyLeaveBalanceDeduction.leave_id:
            pytest.skip("Leave not created")

        resp = requests.get(f"{BASE_URL}/api/leaves/balance/{self.target_employee}", headers=admin_headers())
        assert resp.status_code == 200
        data = resp.json()
        new_remaining = data.get("CL", {}).get("remaining", None)
        initial = TestAdminApplyLeaveBalanceDeduction.initial_cl_remaining
        print(f"Balance after admin apply: CL remaining={new_remaining} (was {initial})")
        assert new_remaining is not None, "CL remaining should exist"
        assert new_remaining == initial - 1.0, f"Expected CL remaining={initial - 1.0}, got {new_remaining}"
        print(f"PASS: Balance deducted from {initial} → {new_remaining}")


# ──────────────────────────────────────────────────────────────
#  Test 3 — Policy bypass: admin can apply CL > 2 days
# ──────────────────────────────────────────────────────────────
class TestAdminPolicyBypass:
    """Admin can apply more than 2 days CL (bypasses policy)."""

    target_employee = "RMF0003"
    # 3-day CL would normally be rejected for regular employees
    start_date = (date.today() + timedelta(days=80)).isoformat()
    end_date = (date.today() + timedelta(days=82)).isoformat()  # 3 days
    leave_id = None

    @pytest.fixture(autouse=True, scope="class")
    def setup_and_teardown(self):
        yield
        if TestAdminPolicyBypass.leave_id:
            cleanup_leave(TestAdminPolicyBypass.leave_id, admin_headers())

    def test_admin_can_apply_3_day_cl(self):
        """Admin should be able to apply 3-day CL (bypasses 2-day CL limit)."""
        payload = {
            "employee_id": self.target_employee,
            "leave_type": "CL",
            "start_date": self.start_date,
            "end_date": self.end_date,
            "reason": "Policy bypass test — 3 day CL",
        }
        resp = requests.post(f"{BASE_URL}/api/leaves", json=payload, headers=admin_headers())
        print(f"Admin 3-day CL: status={resp.status_code}, body={resp.text[:300]}")
        assert resp.status_code == 200, f"Admin should bypass 2-day CL policy, got {resp.status_code}: {resp.text}"
        data = resp.json()
        TestAdminPolicyBypass.leave_id = data.get("id")
        assert data.get("status") == "approved"
        assert data.get("days") == 3.0
        print(f"PASS: Admin applied 3-day CL successfully, auto-approved, days={data['days']}")


# ──────────────────────────────────────────────────────────────
#  Test 4 — Regular employee leave goes as pending
# ──────────────────────────────────────────────────────────────
class TestRegularEmployeeLeave:
    """Regular employee applying own leave should get pending status."""

    target_employee = "RMF0005"
    start_date = (date.today() + timedelta(days=90)).isoformat()
    end_date = (date.today() + timedelta(days=90)).isoformat()
    leave_id = None

    @pytest.fixture(autouse=True, scope="class")
    def setup_and_teardown(self):
        yield
        # Can't admin-cancel pending — just leave it for now or try
        if TestRegularEmployeeLeave.leave_id:
            try:
                requests.put(
                    f"{BASE_URL}/api/leaves/{TestRegularEmployeeLeave.leave_id}/admin-cancel",
                    json={"reason": "Test cleanup"},
                    headers=admin_headers()
                )
            except Exception:
                pass

    def test_employee_own_leave_is_pending(self):
        """Employee applying their own leave should get status=pending."""
        payload = {
            "employee_id": self.target_employee,
            "leave_type": "CL",
            "start_date": self.start_date,
            "end_date": self.end_date,
            "reason": "Test employee own leave",
        }
        emp_headers = employee_headers()
        resp = requests.post(f"{BASE_URL}/api/leaves", json=payload, headers=emp_headers)
        print(f"Employee own leave: status={resp.status_code}, body={resp.text[:300]}")
        assert resp.status_code == 200, f"Expected 200 got {resp.status_code}: {resp.text}"
        data = resp.json()
        TestRegularEmployeeLeave.leave_id = data.get("id")
        assert data.get("status") == "pending", f"Employee leave should be pending, got {data.get('status')}"
        assert data.get("applied_by_admin") is not True, "applied_by_admin should not be True for employee's own leave"
        print(f"PASS: Employee leave status=pending confirmed, applied_by_admin={data.get('applied_by_admin')}")


# ──────────────────────────────────────────────────────────────
#  Test 5 — POST /api/exit/admin/run-auto-exit endpoint
# ──────────────────────────────────────────────────────────────
class TestAutoExitEndpoint:
    """Test the manual auto-exit trigger endpoint."""

    def test_run_auto_exit_returns_200(self):
        """POST /api/exit/admin/run-auto-exit should return 200 with exited_count."""
        resp = requests.post(f"{BASE_URL}/api/exit/admin/run-auto-exit", headers=admin_headers())
        print(f"run-auto-exit: status={resp.status_code}, body={resp.text[:300]}")
        assert resp.status_code == 200, f"Expected 200 got {resp.status_code}: {resp.text}"

    def test_run_auto_exit_response_has_exited_count(self):
        """Response must have exited_count (int) and message."""
        resp = requests.post(f"{BASE_URL}/api/exit/admin/run-auto-exit", headers=admin_headers())
        assert resp.status_code == 200
        data = resp.json()
        assert "exited_count" in data, f"Response missing exited_count: {data}"
        assert isinstance(data["exited_count"], int), f"exited_count should be int, got {type(data['exited_count'])}"
        assert "message" in data, f"Response missing message: {data}"
        print(f"PASS: exited_count={data['exited_count']}, message={data['message']}")

    def test_run_auto_exit_response_has_exited_employees(self):
        """Response must have exited_employees list."""
        resp = requests.post(f"{BASE_URL}/api/exit/admin/run-auto-exit", headers=admin_headers())
        assert resp.status_code == 200
        data = resp.json()
        assert "exited_employees" in data, f"Response missing exited_employees: {data}"
        assert isinstance(data["exited_employees"], list), f"exited_employees should be list, got {type(data['exited_employees'])}"
        print(f"PASS: exited_employees={data['exited_employees']}")

    def test_run_auto_exit_forbidden_for_employee(self):
        """Non-admin should get 403 when calling run-auto-exit."""
        resp = requests.post(f"{BASE_URL}/api/exit/admin/run-auto-exit", headers=employee_headers())
        print(f"Employee calling run-auto-exit: status={resp.status_code}")
        assert resp.status_code == 403, f"Expected 403 for non-admin, got {resp.status_code}"
        print(f"PASS: 403 returned for non-admin access")


# ──────────────────────────────────────────────────────────────
#  Test 6 — Admin-applied leave appears in /api/leaves/approved
# ──────────────────────────────────────────────────────────────
class TestAdminLeaveAppearsInApprovedList:
    """Admin-applied (auto-approved) leave should appear in /api/leaves/approved."""

    target_employee = "RMF0004"
    start_date = (date.today() + timedelta(days=100)).isoformat()
    end_date = (date.today() + timedelta(days=100)).isoformat()
    leave_id = None

    @pytest.fixture(autouse=True, scope="class")
    def setup_and_teardown(self):
        yield
        if TestAdminLeaveAppearsInApprovedList.leave_id:
            cleanup_leave(TestAdminLeaveAppearsInApprovedList.leave_id, admin_headers())

    def test_admin_applied_leave_in_approved_list(self):
        """After admin applies leave, it should appear in /api/leaves/approved."""
        payload = {
            "employee_id": self.target_employee,
            "leave_type": "SL",
            "start_date": self.start_date,
            "end_date": self.end_date,
            "reason": "Approved list test",
        }
        resp = requests.post(f"{BASE_URL}/api/leaves", json=payload, headers=admin_headers())
        assert resp.status_code == 200
        data = resp.json()
        TestAdminLeaveAppearsInApprovedList.leave_id = data["id"]
        created_id = data["id"]
        print(f"Created leave id={created_id}, status={data['status']}")

        # Fetch approved leaves
        approved_resp = requests.get(f"{BASE_URL}/api/leaves/approved", headers=admin_headers())
        assert approved_resp.status_code == 200
        approved_list = approved_resp.json()
        leave_ids = [l.get("id") for l in approved_list]
        assert created_id in leave_ids, f"Leave {created_id} not found in approved list (total: {len(approved_list)})"
        print(f"PASS: Admin-applied leave {created_id} found in /api/leaves/approved")
