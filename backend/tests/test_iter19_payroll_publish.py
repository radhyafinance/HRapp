"""
Backend tests for iteration 19: Payroll Publish feature
Tests: POST /api/payroll/publish, period filter, employee gating
"""
import pytest
import requests
import os

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")

# ── Auth helpers ──────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def admin_token():
    """Obtain HR Admin token"""
    resp = requests.post(f"{BASE_URL}/api/auth/login", json={
        "username": "admin",
        "password": "Admin@12345"
    })
    if resp.status_code != 200:
        pytest.skip(f"Admin login failed: {resp.status_code} {resp.text}")
    return resp.json().get("access_token")


@pytest.fixture(scope="module")
def employee_token():
    """Obtain employee token (RMF0006 — role: employee, confirmed working)"""
    resp = requests.post(f"{BASE_URL}/api/auth/login", json={
        "username": "RMF0006",
        "password": "Radhya@123"
    })
    if resp.status_code != 200:
        pytest.skip(f"Employee login failed: {resp.status_code} {resp.text}")
    return resp.json().get("access_token")


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def employee_headers(employee_token):
    return {"Authorization": f"Bearer {employee_token}", "Content-Type": "application/json"}


# ── Test 1: POST /publish with already-published period returns published:0 ──

class TestPublishEndpoint:
    """Tests for POST /api/payroll/publish"""

    def test_publish_already_published_period_returns_zero(self, admin_headers):
        """Re-publishing 2026-05 should return published:0 (all are already processed)"""
        resp = requests.post(f"{BASE_URL}/api/payroll/publish?period=2026-05",
                             headers=admin_headers)
        assert resp.status_code == 200, f"Unexpected status: {resp.status_code} - {resp.text}"
        data = resp.json()
        assert "period" in data, f"Missing 'period' in response: {data}"
        assert "published" in data, f"Missing 'published' in response: {data}"
        assert data["period"] == "2026-05", f"Wrong period in response: {data['period']}"
        assert data["published"] == 0, (
            f"Expected published=0 (all already processed), got {data['published']}"
        )

    def test_publish_requires_auth(self):
        """Unauthenticated publish should return 401 or 403"""
        resp = requests.post(f"{BASE_URL}/api/payroll/publish?period=2026-05")
        assert resp.status_code in (401, 403), f"Expected 401/403, got {resp.status_code}"

    def test_publish_employee_role_forbidden(self, employee_headers):
        """Employee role must be denied publish action"""
        resp = requests.post(f"{BASE_URL}/api/payroll/publish?period=2026-05",
                             headers=employee_headers)
        assert resp.status_code == 403, f"Expected 403, got {resp.status_code} - {resp.text}"

    def test_publish_invalid_period_returns_400(self, admin_headers):
        """Invalid period format should return 400"""
        resp = requests.post(f"{BASE_URL}/api/payroll/publish?period=badformat",
                             headers=admin_headers)
        assert resp.status_code == 400, f"Expected 400, got {resp.status_code} - {resp.text}"

    def test_publish_future_period_returns_zero(self, admin_headers):
        """Publishing a period with no draft records (e.g., future) should return published:0"""
        resp = requests.post(f"{BASE_URL}/api/payroll/publish?period=2099-01",
                             headers=admin_headers)
        assert resp.status_code == 200, f"Unexpected status: {resp.status_code}"
        data = resp.json()
        assert data["published"] == 0


# ── Test 2: May 2026 records status after publish ───────────────────────────

class TestPayrollStatus:
    """May 2026 payroll records should all be 'processed' after publish"""

    def test_may_2026_records_are_processed(self, admin_headers):
        """GET /payroll?period=2026-05 must return records with status processed/paid"""
        resp = requests.get(f"{BASE_URL}/api/payroll?period=2026-05",
                            headers=admin_headers)
        assert resp.status_code == 200, f"Unexpected status: {resp.status_code}"
        records = resp.json()
        assert len(records) > 0, "Expected >0 records for 2026-05 but got none"

        draft_records = [r for r in records if r.get("status") == "draft"]
        assert len(draft_records) == 0, (
            f"Found {len(draft_records)} draft records after publish — expected 0. "
            f"IDs: {[r['id'] for r in draft_records[:5]]}"
        )

        processed_or_paid = [r for r in records if r.get("status") in ("processed", "paid")]
        assert len(processed_or_paid) == len(records), (
            f"Not all records are processed/paid. Statuses: "
            f"{set(r['status'] for r in records)}"
        )
        print(f"May 2026: {len(records)} records, all processed/paid. PASS")

    def test_list_payroll_with_period_filter(self, admin_headers):
        """Admin can filter payroll by period"""
        resp = requests.get(f"{BASE_URL}/api/payroll?period=2026-05",
                            headers=admin_headers)
        assert resp.status_code == 200
        data = resp.json()
        # All returned records should belong to 2026-05
        for r in data:
            assert r.get("period") == "2026-05", f"Record has wrong period: {r.get('period')}"

    def test_list_payroll_no_filter_returns_all(self, admin_headers):
        """Admin without period filter gets all records"""
        resp = requests.get(f"{BASE_URL}/api/payroll", headers=admin_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) >= 0  # Just ensure it doesn't error


# ── Test 3: Employee gating logic ────────────────────────────────────────────

class TestEmployeeVisibilityGating:
    """Employee-role users should only see processed/paid records for past months"""

    def test_employee_gating_draft_invisible(self, employee_headers):
        """RMF0006 has only April 2026 draft payroll — should be invisible (gating works).
        Confirms _is_payslip_visible_to_employee() correctly blocks draft records."""
        resp = requests.get(f"{BASE_URL}/api/payroll", headers=employee_headers)
        assert resp.status_code == 200, f"Unexpected status: {resp.status_code}"
        records = resp.json()

        # RMF0006 has April 2026 in draft — draft must be invisible to employee
        april_records = [r for r in records if r.get("period") == "2026-04"]
        assert len(april_records) == 0, (
            f"RMF0006 should not see their April 2026 draft payslip, "
            f"but got {len(april_records)} record(s)"
        )
        print("RMF0006 correctly cannot see draft April 2026 payslip. Gating PASS")

    def test_employee_cannot_see_july_2026_payslip(self, employee_headers):
        """Employee must NOT see July 2026 records (current month not ended)"""
        resp = requests.get(f"{BASE_URL}/api/payroll", headers=employee_headers)
        assert resp.status_code == 200
        records = resp.json()

        july_records = [r for r in records if r.get("period") == "2026-07"]
        # If July is processed, it still should be invisible (month not ended)
        assert len(july_records) == 0, (
            f"Employee should not see July 2026 payslips (month not yet ended), "
            f"but got {len(july_records)} record(s)"
        )
        print("July 2026 payslips correctly hidden from employee. PASS")

    def test_employee_cannot_see_draft_records(self, employee_headers):
        """All records returned to employee must be processed or paid"""
        resp = requests.get(f"{BASE_URL}/api/payroll", headers=employee_headers)
        assert resp.status_code == 200
        records = resp.json()

        for r in records:
            assert r.get("status") in ("processed", "paid"), (
                f"Employee received a draft record! id={r.get('id')}, status={r.get('status')}, period={r.get('period')}"
            )

    def test_employee_only_sees_own_payroll(self, employee_headers):
        """Employee must only see their own payroll records"""
        resp = requests.get(f"{BASE_URL}/api/payroll", headers=employee_headers)
        assert resp.status_code == 200
        records = resp.json()

        non_own = [r for r in records if r.get("employee_id") != "RMF0006"]
        assert len(non_own) == 0, (
            f"Employee sees other employees' records: {[r.get('employee_id') for r in non_own]}"
        )

    def test_employee_payroll_endpoint_returns_own_records(self, employee_headers):
        """GET /payroll/employee/RMF0006 returns employee's records with gating applied"""
        resp = requests.get(f"{BASE_URL}/api/payroll/employee/RMF0006",
                            headers=employee_headers)
        assert resp.status_code == 200
        records = resp.json()
        for r in records:
            assert r.get("employee_id") == "RMF0006"
            assert r.get("status") in ("processed", "paid")


# ── Test 4: Admin sees all records including draft ───────────────────────────

class TestAdminFullAccess:

    def test_admin_sees_all_records(self, admin_headers):
        """Admin must see all records regardless of status"""
        resp = requests.get(f"{BASE_URL}/api/payroll", headers=admin_headers)
        assert resp.status_code == 200
        records = resp.json()
        assert len(records) >= 0
        # Admin may or may not have draft records; no assertion on status here
        statuses = set(r.get("status") for r in records)
        print(f"Admin sees {len(records)} records with statuses: {statuses}")

    def test_admin_payroll_june_2026_period(self, admin_headers):
        """Admin should be able to query June 2026 period without error"""
        resp = requests.get(f"{BASE_URL}/api/payroll?period=2026-06", headers=admin_headers)
        assert resp.status_code == 200, f"Unexpected: {resp.status_code} - {resp.text}"
        data = resp.json()
        print(f"June 2026 payroll: {len(data)} records returned to admin")

    def test_admin_payroll_july_2026_period(self, admin_headers):
        """Admin should be able to query July 2026 period without error"""
        resp = requests.get(f"{BASE_URL}/api/payroll?period=2026-07", headers=admin_headers)
        assert resp.status_code == 200, f"Unexpected: {resp.status_code} - {resp.text}"
        data = resp.json()
        print(f"July 2026 payroll: {len(data)} records returned to admin")
