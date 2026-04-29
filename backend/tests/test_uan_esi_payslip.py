"""
Tests for new features:
1. UAN Number and ESI Number fields on employees (edit + view)
2. Payslip PDF download endpoint
"""
import pytest
import requests
import os

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")

# Known test data from previous iterations
KNOWN_EMPLOYEE_ID = "RMF0003"  # Has uan_number and esi_number set
KNOWN_PAYROLL_RECORD_ID = "69f1e022c2a475886373f6b6"  # RMF0003 Apr-2026


@pytest.fixture(scope="module")
def headers():
    resp = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": "admin@radhyamfi.com", "password": "Admin@123"}
    )
    assert resp.status_code == 200, f"Login failed: {resp.text}"
    token = resp.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(scope="module")
def any_payroll_record_id(headers):
    """Get any real payroll record id for the 2026-04 period."""
    r = requests.get(f"{BASE_URL}/api/payroll?period=2026-04", headers=headers)
    assert r.status_code == 200, r.text
    records = r.json()
    assert len(records) > 0, "No payroll records for 2026-04"
    return records[0]["id"]


# ─── Employee UAN / ESI tests ────────────────────────────────────────────────

class TestUANESIEmployeeFields:
    """UAN Number and ESI Number fields on the Employee model"""

    def test_update_employee_uan_esi(self, headers):
        """PUT /employees/{id} accepts uan_number and esi_number and persists them."""
        payload = {
            "uan_number": "102108206145",
            "esi_number": "3013878059",
        }
        r = requests.put(
            f"{BASE_URL}/api/employees/{KNOWN_EMPLOYEE_ID}",
            json=payload,
            headers=headers
        )
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
        data = r.json()
        assert "_id" not in data, "MongoDB _id should not be in response"
        assert data.get("uan_number") == "102108206145", f"uan_number mismatch: {data.get('uan_number')}"
        assert data.get("esi_number") == "3013878059", f"esi_number mismatch: {data.get('esi_number')}"

    def test_get_employee_has_uan_esi(self, headers):
        """GET /employees/{id} returns uan_number and esi_number fields."""
        r = requests.get(f"{BASE_URL}/api/employees/{KNOWN_EMPLOYEE_ID}", headers=headers)
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
        data = r.json()
        assert "_id" not in data, "MongoDB _id should not be in response"
        assert "uan_number" in data, "uan_number missing from employee response"
        assert "esi_number" in data, "esi_number missing from employee response"
        # Values must match what we set
        assert data["uan_number"] == "102108206145", f"uan_number is {data['uan_number']}"
        assert data["esi_number"] == "3013878059", f"esi_number is {data['esi_number']}"

    def test_list_employees_has_uan_esi_for_updated_employee(self, headers):
        """GET /employees list returns employees; verify UAN/ESI is stored."""
        r = requests.get(f"{BASE_URL}/api/employees", headers=headers)
        assert r.status_code == 200
        employees = r.json()
        target = next((e for e in employees if e.get("employee_id") == KNOWN_EMPLOYEE_ID), None)
        assert target is not None, f"Employee {KNOWN_EMPLOYEE_ID} not found in list"
        assert target.get("uan_number") == "102108206145"
        assert target.get("esi_number") == "3013878059"

    def test_update_employee_uan_esi_with_new_test_employee(self, headers):
        """Create a fresh employee and set UAN/ESI through PUT."""
        import time
        suffix = hex(int(time.time()))[-6:]
        payload = {
            "first_name": "TEST_UAN",
            "last_name": "ESI",
            "email": f"test_uanesi_{suffix}@radhyamfi.com",
            "mobile": "9000000000",
            "department": "Operations",
            "designation": "Field Officer",
            "joining_date": "2024-01-15",
            "role": "employee",
            "basic": 10000,
            "hra": 2000,
            "uan_number": "102108000001",
            "esi_number": "3013000001",
        }
        create_r = requests.post(f"{BASE_URL}/api/employees", json=payload, headers=headers)
        assert create_r.status_code in (200, 201), f"Create failed: {create_r.text}"
        emp_id = create_r.json()["employee_id"]

        # Verify UAN/ESI immediately after creation
        get_r = requests.get(f"{BASE_URL}/api/employees/{emp_id}", headers=headers)
        assert get_r.status_code == 200
        emp = get_r.json()
        assert emp.get("uan_number") == "102108000001", f"uan_number: {emp.get('uan_number')}"
        assert emp.get("esi_number") == "3013000001", f"esi_number: {emp.get('esi_number')}"

        # Now update UAN/ESI
        update_r = requests.put(
            f"{BASE_URL}/api/employees/{emp_id}",
            json={"uan_number": "102108999999", "esi_number": "3013999999"},
            headers=headers
        )
        assert update_r.status_code == 200, update_r.text
        updated_emp = update_r.json()
        assert updated_emp.get("uan_number") == "102108999999"
        assert updated_emp.get("esi_number") == "3013999999"

        # GET to verify persistence
        verify_r = requests.get(f"{BASE_URL}/api/employees/{emp_id}", headers=headers)
        assert verify_r.status_code == 200
        verified_emp = verify_r.json()
        assert verified_emp.get("uan_number") == "102108999999"
        assert verified_emp.get("esi_number") == "3013999999"


# ─── Payslip PDF endpoint tests ───────────────────────────────────────────────

class TestPayslipPDF:
    """GET /payroll/{record_id}/payslip/pdf endpoint"""

    def test_pdf_endpoint_returns_200(self, headers, any_payroll_record_id):
        """Basic check: endpoint is reachable and returns HTTP 200."""
        r = requests.get(
            f"{BASE_URL}/api/payroll/{any_payroll_record_id}/payslip/pdf",
            headers=headers
        )
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text[:300]}"

    def test_pdf_content_type(self, headers, any_payroll_record_id):
        """Response Content-Type must be application/pdf."""
        r = requests.get(
            f"{BASE_URL}/api/payroll/{any_payroll_record_id}/payslip/pdf",
            headers=headers
        )
        assert r.status_code == 200, r.text[:200]
        ct = r.headers.get("Content-Type", "")
        assert "application/pdf" in ct, f"Expected application/pdf, got '{ct}'"

    def test_pdf_content_disposition_header(self, headers, any_payroll_record_id):
        """Response must have a Content-Disposition attachment header."""
        r = requests.get(
            f"{BASE_URL}/api/payroll/{any_payroll_record_id}/payslip/pdf",
            headers=headers
        )
        assert r.status_code == 200
        cd = r.headers.get("Content-Disposition", "")
        assert "attachment" in cd, f"Expected attachment in Content-Disposition, got '{cd}'"
        assert ".pdf" in cd, f"Expected .pdf in Content-Disposition, got '{cd}'"

    def test_pdf_is_valid_pdf_bytes(self, headers, any_payroll_record_id):
        """Response body must start with the PDF magic bytes %PDF-."""
        r = requests.get(
            f"{BASE_URL}/api/payroll/{any_payroll_record_id}/payslip/pdf",
            headers=headers
        )
        assert r.status_code == 200
        assert r.content[:4] == b"%PDF", f"Not a valid PDF. First bytes: {r.content[:10]}"

    def test_pdf_minimum_size(self, headers, any_payroll_record_id):
        """PDF must be non-trivially large (at least 5 KB) indicating real content."""
        r = requests.get(
            f"{BASE_URL}/api/payroll/{any_payroll_record_id}/payslip/pdf",
            headers=headers
        )
        assert r.status_code == 200
        size_kb = len(r.content) / 1024
        assert size_kb >= 3, f"PDF too small ({size_kb:.1f} KB) — likely empty or corrupt"

    def test_known_record_pdf_downloads(self, headers):
        """Use the known RMF0003 payroll record specifically (has UAN/ESI numbers)."""
        r = requests.get(
            f"{BASE_URL}/api/payroll/{KNOWN_PAYROLL_RECORD_ID}/payslip/pdf",
            headers=headers
        )
        assert r.status_code == 200, f"Known record PDF failed: {r.status_code}: {r.text[:200]}"
        assert r.content[:4] == b"%PDF", "Not a valid PDF"
        ct = r.headers.get("Content-Type", "")
        assert "application/pdf" in ct

    def test_pdf_404_for_invalid_record(self, headers):
        """Invalid record ID must return 404."""
        r = requests.get(
            f"{BASE_URL}/api/payroll/000000000000000000000000/payslip/pdf",
            headers=headers
        )
        assert r.status_code == 404, f"Expected 404 for invalid ID, got {r.status_code}"

    def test_pdf_endpoint_unauthenticated_returns_401(self):
        """Without auth header, endpoint must return 401."""
        r = requests.get(
            f"{BASE_URL}/api/payroll/{KNOWN_PAYROLL_RECORD_ID}/payslip/pdf"
        )
        assert r.status_code in (401, 403), f"Expected 401/403, got {r.status_code}"
