import pytest
import requests
import os

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")

@pytest.fixture(scope="module")
def auth_token():
    resp = requests.post(f"{BASE_URL}/api/auth/login", json={"email": "admin@radhyamfi.com", "password": "Admin@123"})
    assert resp.status_code == 200, f"Login failed: {resp.text}"
    return resp.json()["access_token"]

@pytest.fixture(scope="module")
def headers(auth_token):
    return {"Authorization": f"Bearer {auth_token}"}

# Auth tests
class TestAuth:
    def test_login_success(self):
        resp = requests.post(f"{BASE_URL}/api/auth/login", json={"email": "admin@radhyamfi.com", "password": "Admin@123"})
        assert resp.status_code == 200
        data = resp.json()
        assert "access_token" in data
        assert data["user"]["role"] == "hr_admin"

    def test_login_wrong_password(self):
        resp = requests.post(f"{BASE_URL}/api/auth/login", json={"email": "admin@radhyamfi.com", "password": "wrong"})
        assert resp.status_code in [401, 400]

    def test_get_me(self, headers):
        resp = requests.get(f"{BASE_URL}/api/auth/me", headers=headers)
        assert resp.status_code == 200
        assert resp.json()["email"] == "admin@radhyamfi.com"

# Dashboard
class TestDashboard:
    def test_get_stats(self, headers):
        resp = requests.get(f"{BASE_URL}/api/dashboard/stats", headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert "total_employees" in data

# Employees
class TestEmployees:
    created_id = None

    def test_list_employees(self, headers):
        resp = requests.get(f"{BASE_URL}/api/employees", headers=headers)
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)

    def test_create_employee(self, headers):
        payload = {
            "first_name": "TEST_John",
            "last_name": "Doe",
            "email": "TEST_john.doe2@radhyamfi.com",
            "mobile": "9876543210",
            "department": "Operations",
            "designation": "Field Officer",
            "joining_date": "2024-01-15",
            "employment_type": "full_time",
            "branch": "Head Office - Moradabad",
            "role": "employee",
            "basic": 15000,
            "hra": 3000,
            "special_allowance": 1000,
            "canteen_allowance": 500,
            "conveyance_allowance": 500
        }
        resp = requests.post(f"{BASE_URL}/api/employees", json=payload, headers=headers)
        assert resp.status_code == 200 or resp.status_code == 201, f"Create failed: {resp.text}"
        data = resp.json()
        assert "id" in data or "employee_id" in data
        TestEmployees.created_id = data.get("employee_id")

    def test_get_employee(self, headers):
        if not TestEmployees.created_id:
            pytest.skip("No employee created")
        resp = requests.get(f"{BASE_URL}/api/employees/{TestEmployees.created_id}", headers=headers)
        assert resp.status_code == 200

# Candidates
class TestCandidates:
    created_id = None

    def test_list_candidates(self, headers):
        resp = requests.get(f"{BASE_URL}/api/candidates", headers=headers)
        assert resp.status_code == 200

    def test_create_candidate(self, headers):
        payload = {
            "first_name": "TEST_Candidate",
            "last_name": "One",
            "email": "TEST_candidate1@example.com",
            "mobile": "9123456789",
            "position": "Field Officer",
            "department": "Operations"
        }
        resp = requests.post(f"{BASE_URL}/api/candidates", json=payload, headers=headers)
        assert resp.status_code in [200, 201], f"Failed: {resp.text}"
        TestCandidates.created_id = resp.json().get("id")

# Attendance
class TestAttendance:
    def test_get_attendance_records(self, headers):
        resp = requests.get(f"{BASE_URL}/api/attendance", headers=headers)
        assert resp.status_code == 200

# Leaves
class TestLeaves:
    def test_get_leave_balances(self, headers):
        # admin has no employee_id, so /balance/my returns 400
        resp = requests.get(f"{BASE_URL}/api/leaves/balance/my", headers=headers)
        assert resp.status_code in [200, 400]  # admin has no employee_id

    def test_list_leaves(self, headers):
        resp = requests.get(f"{BASE_URL}/api/leaves", headers=headers)
        assert resp.status_code == 200

# Payroll
class TestPayroll:
    def test_list_payroll(self, headers):
        resp = requests.get(f"{BASE_URL}/api/payroll", headers=headers)
        assert resp.status_code == 200

# Performance
class TestPerformance:
    def test_list_reviews(self, headers):
        resp = requests.get(f"{BASE_URL}/api/performance", headers=headers)
        assert resp.status_code == 200

# Letters
class TestLetters:
    def test_list_letters(self, headers):
        resp = requests.get(f"{BASE_URL}/api/letters", headers=headers)
        assert resp.status_code == 200

# Locations
class TestLocations:
    def test_list_locations(self, headers):
        resp = requests.get(f"{BASE_URL}/api/locations", headers=headers)
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 5, f"Expected 5 locations, got {len(data)}"

# Exit
class TestExit:
    def test_list_exit(self, headers):
        resp = requests.get(f"{BASE_URL}/api/exit", headers=headers)
        assert resp.status_code == 200

# Gratuity
class TestGratuity:
    def test_list_gratuity(self, headers):
        resp = requests.get(f"{BASE_URL}/api/gratuity", headers=headers)
        assert resp.status_code == 200
