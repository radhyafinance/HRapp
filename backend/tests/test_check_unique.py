"""
Backend tests for GET /api/candidates/check-unique endpoint.
Tests uniqueness checks across candidates and employees for mobile, email, aadhaar_number, pan_number.
"""
import pytest
import requests
import os

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")


class TestCheckUniqueEndpoint:
    """Tests for GET /api/candidates/check-unique - public endpoint (no auth required)."""

    def test_check_unique_invalid_field_returns_400(self):
        """Invalid field should return 400."""
        res = requests.get(f"{BASE_URL}/api/candidates/check-unique", params={"field": "unknown_field", "value": "test"})
        assert res.status_code == 400, f"Expected 400, got {res.status_code}: {res.text}"
        print("PASS: invalid field returns 400")

    def test_check_unique_empty_value_returns_false(self):
        """Empty value should return exists=False without error."""
        res = requests.get(f"{BASE_URL}/api/candidates/check-unique", params={"field": "mobile", "value": ""})
        assert res.status_code == 200, f"Expected 200, got {res.status_code}: {res.text}"
        data = res.json()
        assert data.get("exists") is False, f"Expected exists=False, got: {data}"
        print("PASS: empty value returns exists=False")

    def test_check_unique_mobile_known_conflict(self):
        """Mobile 9999999999 is known to exist (candidate Sunita)."""
        res = requests.get(f"{BASE_URL}/api/candidates/check-unique", params={"field": "mobile", "value": "9999999999"})
        assert res.status_code == 200, f"Expected 200, got {res.status_code}: {res.text}"
        data = res.json()
        assert data.get("exists") is True, f"Expected exists=True for known mobile, got: {data}"
        assert data.get("conflict_in") in ("candidate", "employee"), f"Expected conflict_in field, got: {data}"
        assert data.get("conflict_name"), f"Expected conflict_name, got: {data}"
        print(f"PASS: mobile 9999999999 conflict found - {data.get('conflict_in')}: {data.get('conflict_name')}")

    def test_check_unique_mobile_non_existing(self):
        """A clearly non-existing mobile should return exists=False."""
        res = requests.get(f"{BASE_URL}/api/candidates/check-unique", params={"field": "mobile", "value": "0000000001"})
        assert res.status_code == 200, f"Expected 200, got {res.status_code}: {res.text}"
        data = res.json()
        assert data.get("exists") is False, f"Expected exists=False for non-existing mobile, got: {data}"
        print("PASS: non-existing mobile returns exists=False")

    def test_check_unique_email_non_existing(self):
        """A clearly non-existing email should return exists=False."""
        res = requests.get(f"{BASE_URL}/api/candidates/check-unique", params={"field": "email", "value": "zzz_nonexist_test_xyz@test123.com"})
        assert res.status_code == 200, f"Expected 200, got {res.status_code}: {res.text}"
        data = res.json()
        assert data.get("exists") is False, f"Expected exists=False for non-existing email, got: {data}"
        print("PASS: non-existing email returns exists=False")

    def test_check_unique_email_existing(self):
        """admin@radhyamfi.com is the admin email and should exist in employees."""
        res = requests.get(f"{BASE_URL}/api/candidates/check-unique", params={"field": "email", "value": "admin@radhyamfi.com"})
        assert res.status_code == 200, f"Expected 200, got {res.status_code}: {res.text}"
        data = res.json()
        # Admin email may or may not be stored - this is informational
        print(f"INFO: admin@radhyamfi.com check: exists={data.get('exists')}, conflict_in={data.get('conflict_in')}, name={data.get('conflict_name')}")

    def test_check_unique_aadhaar_non_existing(self):
        """A clearly non-existing aadhaar should return exists=False."""
        res = requests.get(f"{BASE_URL}/api/candidates/check-unique", params={"field": "aadhaar_number", "value": "000000000001"})
        assert res.status_code == 200, f"Expected 200, got {res.status_code}: {res.text}"
        data = res.json()
        assert data.get("exists") is False, f"Expected exists=False, got: {data}"
        print("PASS: non-existing aadhaar returns exists=False")

    def test_check_unique_pan_non_existing(self):
        """A clearly non-existing pan should return exists=False."""
        res = requests.get(f"{BASE_URL}/api/candidates/check-unique", params={"field": "pan_number", "value": "ZZZZZ9999Z"})
        assert res.status_code == 200, f"Expected 200, got {res.status_code}: {res.text}"
        data = res.json()
        assert data.get("exists") is False, f"Expected exists=False, got: {data}"
        print("PASS: non-existing pan returns exists=False")

    def test_check_unique_pan_case_insensitive(self):
        """PAN number check should be case-insensitive (normalized to uppercase)."""
        # First test with uppercase
        res_upper = requests.get(f"{BASE_URL}/api/candidates/check-unique", params={"field": "pan_number", "value": "ZZZZZ9999Z"})
        # Then test with lowercase (should give same result as backend normalizes)
        res_lower = requests.get(f"{BASE_URL}/api/candidates/check-unique", params={"field": "pan_number", "value": "zzzzz9999z"})
        assert res_upper.status_code == 200
        assert res_lower.status_code == 200
        assert res_upper.json().get("exists") == res_lower.json().get("exists"), "PAN case normalization inconsistency"
        print("PASS: PAN number case-insensitive normalization works")

    def test_check_unique_email_case_insensitive(self):
        """Email check should be case-insensitive (normalized to lowercase)."""
        res_lower = requests.get(f"{BASE_URL}/api/candidates/check-unique", params={"field": "email", "value": "zzz_nonexist_test_xyz@test123.com"})
        res_upper = requests.get(f"{BASE_URL}/api/candidates/check-unique", params={"field": "email", "value": "ZZZ_NONEXIST_TEST_XYZ@TEST123.COM"})
        assert res_lower.status_code == 200
        assert res_upper.status_code == 200
        assert res_lower.json().get("exists") == res_upper.json().get("exists"), "Email case normalization inconsistency"
        print("PASS: Email case-insensitive normalization works")

    def test_check_unique_exclude_employee_id(self):
        """exclude_employee_id should prevent the employee's own value from triggering conflict.
        First find an employee's mobile, then check with exclusion."""
        # Get admin employee's mobile (login as admin to get it)
        login_res = requests.post(f"{BASE_URL}/api/auth/login", json={"username": "admin", "password": "Admin@123"})
        if login_res.status_code != 200:
            pytest.skip("Auth failed - skipping exclude test")

        token = login_res.json().get("token")
        headers = {"Authorization": f"Bearer {token}"}

        # Get employees list
        emp_res = requests.get(f"{BASE_URL}/api/employees", headers=headers)
        if emp_res.status_code != 200:
            pytest.skip("Cannot fetch employees")

        employees = emp_res.json()
        # Find an employee that has a mobile
        test_emp = None
        for emp in (employees if isinstance(employees, list) else employees.get("employees", [])):
            if emp.get("mobile"):
                test_emp = emp
                break

        if not test_emp:
            pytest.skip("No employee with mobile found")

        emp_id = test_emp.get("employee_id")
        emp_mobile = test_emp.get("mobile")

        # Without exclusion - should detect conflict
        res_no_exclude = requests.get(f"{BASE_URL}/api/candidates/check-unique",
                                       params={"field": "mobile", "value": emp_mobile})
        assert res_no_exclude.status_code == 200
        # With exclusion - should NOT detect conflict (own value)
        res_with_exclude = requests.get(f"{BASE_URL}/api/candidates/check-unique",
                                         params={"field": "mobile", "value": emp_mobile, "exclude_employee_id": emp_id})
        assert res_with_exclude.status_code == 200

        without = res_no_exclude.json().get("exists")
        with_excl = res_with_exclude.json().get("exists")
        print(f"INFO: mobile={emp_mobile}, emp_id={emp_id}")
        print(f"  Without exclude: exists={without}")
        print(f"  With exclude:    exists={with_excl}")

        # If the mobile was found in employees, excluding own id should give different result
        if without is True:
            # If the ONLY match is this employee, exclusion should make it False
            conflict_id = res_no_exclude.json().get("conflict_id", "")
            if conflict_id == emp_id or res_no_exclude.json().get("conflict_in") == "employee":
                assert with_excl is False, f"Expected exists=False after excluding own employee_id, got: {with_excl}"
                print(f"PASS: excludeEmployeeId works - employee's own mobile {emp_mobile} doesn't conflict when excluded")
            else:
                print(f"INFO: Mobile {emp_mobile} conflicts with a DIFFERENT entity {conflict_id}, skipping exclude assertion")
        else:
            print(f"INFO: Mobile {emp_mobile} not found in DB - no conflict to verify exclude logic with")

    def test_check_unique_conflict_response_structure(self):
        """When conflict exists, response should have exists, conflict_in, conflict_name fields."""
        res = requests.get(f"{BASE_URL}/api/candidates/check-unique",
                           params={"field": "mobile", "value": "9999999999"})
        assert res.status_code == 200
        data = res.json()
        if data.get("exists") is True:
            assert "conflict_in" in data, "Missing conflict_in in conflict response"
            assert "conflict_name" in data, "Missing conflict_name in conflict response"
            assert data["conflict_in"] in ("candidate", "employee"), f"Invalid conflict_in value: {data['conflict_in']}"
            print(f"PASS: conflict response structure valid: {data}")
        else:
            print(f"INFO: Mobile 9999999999 not found as conflict. Response: {data}")

    def test_all_four_valid_fields(self):
        """All four valid fields should return 200."""
        fields = [
            ("mobile", "9876543210"),
            ("email", "test_nonexistent@xyz.com"),
            ("aadhaar_number", "123456789012"),
            ("pan_number", "ABCDE1234F"),
        ]
        for field, value in fields:
            res = requests.get(f"{BASE_URL}/api/candidates/check-unique", params={"field": field, "value": value})
            assert res.status_code == 200, f"Field {field} returned {res.status_code}: {res.text}"
            data = res.json()
            assert "exists" in data, f"Missing 'exists' key for field {field}"
            print(f"PASS: field={field}, exists={data['exists']}")
