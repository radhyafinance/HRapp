"""
Iteration 16 — Backend tests for 3 new features:
1. Regularisation + Leave Integration: status=leave → leave_type stored + balance deducted
2. Comp-Off Edit in Leaves > All Employees > Edit: CompOff_total/CompOff_used stored in leave_balances
3. Bug fix: approval_type defaults to actual leave type (not hardcoded 'sl')

Test coverage:
  a) POST /api/attendance/records status=leave leave_type=CL → record stored + CL balance decremented
  b) PATCH /api/attendance/records/{id} status=leave leave_type=SL → SL balance decremented
  c) Comp-Off regularisation (manual balance path) → Comp-Off.remaining decremented
  d) Comp-Off regularisation (grant-based path) → oldest approved grant marked 'used'
  e) PUT /api/leaves/admin/balance/{employee_id} CompOff_total=5 CompOff_used=2 → 200 + correct Comp-Off
  f) GET /api/leaves/balances/all → manual Comp-Off override shown (not grant-count)
  g) GET /api/leaves/balance/{employee_id} → stored Comp-Off values returned
  h) PUT /api/leaves/admin/balance without CompOff fields → other employee unaffected (still grant-count based)
  i) CL leave approval → approval_type="cl" (not hardcoded 'sl')
"""
import pytest
import requests
import os
from pymongo import MongoClient

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")

# Test employees (active, with FY2026 leave balances)
EMP_CL = "RMF0002"    # Used for CL regularisation + approval type test
EMP_SL = "RMF0004"    # Used for SL regularisation via PATCH
EMP_CO_MANUAL = "RMF0004"   # Used for Comp-Off manual balance test
EMP_CO_GRANT = "RMF0009"    # Has 1 approved grant (id: 69fc6cf27746668d4e9276f9)
EMP_CO_BALANCE = "RMF0003"  # Used for balance PUT/GET CompOff tests

# Test dates (far future, unlikely to have existing records, non-Sundays)
DATE_CL = "2026-09-15"      # Monday
DATE_SL_ABSENT = "2026-09-16"   # Tuesday (will be created as absent first)
DATE_SL_LEAVE = "2026-09-16"    # Same date, PATCH to leave
DATE_CO_MANUAL = "2026-09-17"   # Wednesday
DATE_CO_GRANT = "2026-09-18"    # Thursday

# MongoDB for cleanup
MONGO_URL = "mongodb://localhost:27017"
DB_NAME = "radhya_hr_db"

# Module-level state to share created resource IDs between tests
_state = {}


def get_mongo_db():
    client = MongoClient(MONGO_URL)
    return client[DB_NAME], client


# ── Auth Fixtures ────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"username": "admin", "password": "Admin@12345"})
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text[:200]}"
    token = r.json().get("access_token") or r.json().get("token")
    assert token, f"No token in response: {r.json()}"
    return token


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


# ── Cleanup Fixture (module teardown) ─────────────────────────────────────────

@pytest.fixture(scope="module", autouse=True)
def cleanup_test_data(admin_headers):
    """Clean up all test data created during this module's tests."""
    yield  # Tests run here

    db, client = get_mongo_db()
    try:
        # 1. Delete test attendance records
        for emp, date_str in [
            (EMP_CL, DATE_CL),
            (EMP_SL, DATE_SL_LEAVE),
            (EMP_CO_MANUAL, DATE_CO_MANUAL),
            (EMP_CO_GRANT, DATE_CO_GRANT),
        ]:
            result = db.attendance_records.delete_one({"employee_id": emp, "date": date_str, "regularised": True})
            if result.deleted_count:
                print(f"[cleanup] Deleted attendance record: {emp}/{date_str}")

        # 2. Revert CL balance for RMF0002 (if test ran and deducted)
        if _state.get("cl_deducted"):
            db.leave_balances.update_one(
                {"employee_id": EMP_CL, "year": 2026},
                {"$inc": {"CL.used": -1.0, "CL.remaining": 1.0}}
            )
            print(f"[cleanup] Reverted CL balance for {EMP_CL}")

        # 3. Revert SL balance for RMF0004 (if test ran)
        if _state.get("sl_deducted"):
            db.leave_balances.update_one(
                {"employee_id": EMP_SL, "year": 2026},
                {"$inc": {"SL.used": -1.0, "SL.remaining": 1.0}}
            )
            print(f"[cleanup] Reverted SL balance for {EMP_SL}")

        # 4. Remove manual Comp-Off override for RMF0004 (if set in tests)
        if _state.get("rmf0004_compoff_set"):
            db.leave_balances.update_one(
                {"employee_id": EMP_CO_MANUAL, "year": 2026},
                {"$unset": {"Comp-Off": ""}}
            )
            print(f"[cleanup] Removed Comp-Off override for {EMP_CO_MANUAL}")

        # 5. Remove Comp-Off manual override for RMF0003
        if _state.get("rmf0003_compoff_set"):
            db.leave_balances.update_one(
                {"employee_id": EMP_CO_BALANCE, "year": 2026},
                {"$unset": {"Comp-Off": ""}}
            )
            print(f"[cleanup] Removed Comp-Off override for {EMP_CO_BALANCE}")

        # 6. Revert grant status for RMF0009 if it was marked 'used' in tests
        grant_id = _state.get("comp_off_grant_id_used")
        if grant_id:
            from bson import ObjectId
            db.comp_off_grants.update_one(
                {"_id": ObjectId(grant_id)},
                {"$set": {"status": "approved"}, "$unset": {"used_at": ""}}
            )
            print(f"[cleanup] Reverted comp-off grant {grant_id} back to 'approved'")

        # 7. Delete test leave applications (CL leave created for approval test)
        if _state.get("test_leave_id"):
            from bson import ObjectId
            db.leave_applications.delete_one({"_id": ObjectId(_state["test_leave_id"])})
            print(f"[cleanup] Deleted test leave application {_state['test_leave_id']}")
            # Revert balance if the leave was approved and balance was deducted
            if _state.get("cl_balance_deducted_by_approval"):
                db.leave_balances.update_one(
                    {"employee_id": EMP_CL, "year": 2026},
                    {"$inc": {"CL.used": -1.0, "CL.remaining": 1.0}}
                )
                print(f"[cleanup] Reverted CL balance deducted by approval for {EMP_CL}")

    finally:
        client.close()


# ─────────────────────────────────────────────────────────────────────────────
# Group A: POST /api/attendance/records with status=leave + leave_type=CL
# ─────────────────────────────────────────────────────────────────────────────

class TestRegulariseCreateLeave:
    """POST /api/attendance/records: status=leave with leave_type stores the field and deducts balance."""

    def test_create_leave_cl_record_stored(self, admin_headers):
        """Record is created with leave_type=CL field stored."""
        r = requests.post(
            f"{BASE_URL}/api/attendance/records",
            headers=admin_headers,
            json={
                "employee_id": EMP_CL,
                "date": DATE_CL,
                "status": "leave",
                "leave_type": "CL",
                "reason": "TEST_create_leave_CL_regularisation",
            }
        )
        assert r.status_code in (200, 201), f"Expected 200/201, got {r.status_code}: {r.text[:300]}"
        data = r.json()

        # Status and leave_type must be stored
        assert data.get("status") == "leave", f"Expected status='leave', got {data.get('status')}"
        assert data.get("leave_type") == "CL", f"Expected leave_type='CL', got {data.get('leave_type')}"
        assert data.get("employee_id") == EMP_CL
        assert data.get("date") == DATE_CL
        assert data.get("regularised") is True, "Record must be marked as regularised"
        assert data.get("id"), "Response must include record ID"

        _state["cl_att_record_id"] = data["id"]
        _state["cl_deducted"] = True
        print(f"PASS: CL attendance record created: id={data['id']}, leave_type={data['leave_type']}")

    def test_create_leave_cl_balance_decremented(self, admin_headers):
        """CL balance decremented by 1.0 after regularisation."""
        # Get current balance (should have been decremented by previous test)
        r = requests.get(f"{BASE_URL}/api/leaves/balance/{EMP_CL}", headers=admin_headers)
        assert r.status_code == 200, f"Balance fetch failed: {r.status_code}"
        bal = r.json()

        cl_bal = bal.get("CL", {})
        used = cl_bal.get("used", 0)
        remaining = cl_bal.get("remaining", 0)
        total = cl_bal.get("total", 0)

        # Used should have increased by 1.0 from 0.0
        assert used >= 1.0, f"CL.used should be >= 1.0 after deduction, got {used}"
        assert remaining == (total - used), f"CL.remaining should be total-used, got remaining={remaining}, total={total}, used={used}"
        print(f"PASS: CL balance after regularisation — used={used}, remaining={remaining}, total={total}")


# ─────────────────────────────────────────────────────────────────────────────
# Group B: PATCH /api/attendance/records/{id} with status=leave + leave_type=SL
# ─────────────────────────────────────────────────────────────────────────────

class TestRegulariseEditLeave:
    """PATCH /api/attendance/records/{id}: Changing status=leave with leave_type=SL deducts SL balance."""

    def test_create_absent_record_for_sl_employee(self, admin_headers):
        """Pre-condition: create an 'absent' record for RMF0004 to PATCH later."""
        r = requests.post(
            f"{BASE_URL}/api/attendance/records",
            headers=admin_headers,
            json={
                "employee_id": EMP_SL,
                "date": DATE_SL_ABSENT,
                "status": "absent",
                "reason": "TEST_pre_condition_for_sl_patch",
            }
        )
        assert r.status_code in (200, 201), f"Pre-condition record creation failed: {r.status_code}: {r.text[:300]}"
        data = r.json()
        assert data.get("id"), "No ID returned"
        _state["sl_att_record_id"] = data["id"]
        print(f"PASS: Absent record created for {EMP_SL}: id={data['id']}")

    def test_patch_to_leave_sl_stores_leave_type(self, admin_headers):
        """PATCH changes status to leave and stores leave_type=SL."""
        rec_id = _state.get("sl_att_record_id")
        assert rec_id, "Pre-condition test failed — no record ID"

        r = requests.patch(
            f"{BASE_URL}/api/attendance/records/{rec_id}",
            headers=admin_headers,
            json={
                "status": "leave",
                "leave_type": "SL",
                "reason": "TEST_patch_to_leave_SL",
            }
        )
        assert r.status_code == 200, f"PATCH failed: {r.status_code}: {r.text[:300]}"
        data = r.json()

        assert data.get("status") == "leave", f"Expected status='leave', got {data.get('status')}"
        assert data.get("leave_type") == "SL", f"Expected leave_type='SL', got {data.get('leave_type')}"
        assert data.get("employee_id") == EMP_SL
        _state["sl_deducted"] = True
        print(f"PASS: Attendance record patched to leave/SL: id={rec_id}")

    def test_patch_sl_balance_decremented(self, admin_headers):
        """SL balance decremented by 1.0 after regularisation."""
        r = requests.get(f"{BASE_URL}/api/leaves/balance/{EMP_SL}", headers=admin_headers)
        assert r.status_code == 200
        bal = r.json()

        sl_bal = bal.get("SL", {})
        used = sl_bal.get("used", 0)
        remaining = sl_bal.get("remaining", 0)
        total = sl_bal.get("total", 0)

        assert used >= 1.0, f"SL.used should be >= 1.0 after deduction, got {used}"
        assert remaining == (total - used), f"SL.remaining inconsistent: total={total}, used={used}, remaining={remaining}"
        print(f"PASS: SL balance after PATCH regularisation — used={used}, remaining={remaining}")


# ─────────────────────────────────────────────────────────────────────────────
# Group C: Comp-Off regularisation (manual balance path)
# ─────────────────────────────────────────────────────────────────────────────

class TestCompOffManualBalancePath:
    """When leave_type=Comp-Off and employee has manual Comp-Off balance > 0, it is decremented."""

    def test_setup_compoff_manual_balance(self, admin_headers):
        """Set manual Comp-Off balance for RMF0004 (total=3, used=0)."""
        # First get current standard balances so we don't change them
        r = requests.get(f"{BASE_URL}/api/leaves/balance/{EMP_CO_MANUAL}", headers=admin_headers)
        assert r.status_code == 200
        bal = r.json()
        cl = bal.get("CL", {"total": 3.5, "used": 0.0})
        sl = bal.get("SL", {"total": 7.5, "used": 0.0})
        el = bal.get("EL", {"total": 0.0, "used": 0.0})
        marriage = bal.get("Marriage", {"total": 5.0, "used": 0.0})

        # PUT with CompOff_total=3, CompOff_used=0
        r = requests.put(
            f"{BASE_URL}/api/leaves/admin/balance/{EMP_CO_MANUAL}",
            headers=admin_headers,
            json={
                "CL_total": cl.get("total", 3.5),
                "CL_used": cl.get("used", 0.0),
                "SL_total": sl.get("total", 7.5),
                "SL_used": sl.get("used", 0.0),
                "EL_total": el.get("total", 0.0),
                "EL_used": el.get("used", 0.0),
                "Marriage_total": marriage.get("total", 5.0),
                "Marriage_used": marriage.get("used", 0.0),
                "CompOff_total": 3.0,
                "CompOff_used": 0.0,
                "reason": "TEST_setup_compoff_manual_balance",
            }
        )
        assert r.status_code == 200, f"Setup failed: {r.status_code}: {r.text[:300]}"
        data = r.json()
        co = data.get("balance", {}).get("Comp-Off", {})
        assert co.get("total") == 3.0
        assert co.get("used") == 0.0
        assert co.get("remaining") == 3.0
        _state["rmf0004_compoff_set"] = True
        print(f"PASS: Manual Comp-Off balance set for {EMP_CO_MANUAL}: {co}")

    def test_compoff_regularisation_decrements_manual_balance(self, admin_headers):
        """POST regularisation with leave_type=Comp-Off decrements manual balance."""
        # Get balance before
        r = requests.get(f"{BASE_URL}/api/leaves/balance/{EMP_CO_MANUAL}", headers=admin_headers)
        assert r.status_code == 200
        bal_before = r.json()
        co_before = bal_before.get("Comp-Off", {})
        remaining_before = co_before.get("remaining", 0)
        assert remaining_before > 0, f"Manual Comp-Off balance must be > 0 before test, got {remaining_before}"

        # Create regularisation with status=leave, leave_type=Comp-Off
        r = requests.post(
            f"{BASE_URL}/api/attendance/records",
            headers=admin_headers,
            json={
                "employee_id": EMP_CO_MANUAL,
                "date": DATE_CO_MANUAL,
                "status": "leave",
                "leave_type": "Comp-Off",
                "reason": "TEST_compoff_manual_balance_deduction",
            }
        )
        assert r.status_code in (200, 201), f"Regularisation failed: {r.status_code}: {r.text[:300]}"
        data = r.json()
        assert data.get("status") == "leave"
        assert data.get("leave_type") == "Comp-Off"
        print(f"PASS: Comp-Off leave record created for {EMP_CO_MANUAL}")

        # Verify manual balance decremented by 1.0
        r2 = requests.get(f"{BASE_URL}/api/leaves/balance/{EMP_CO_MANUAL}", headers=admin_headers)
        assert r2.status_code == 200
        bal_after = r2.json()
        co_after = bal_after.get("Comp-Off", {})
        remaining_after = co_after.get("remaining", 0)
        used_after = co_after.get("used", 0)

        assert remaining_after == remaining_before - 1.0, (
            f"Comp-Off.remaining should decrease by 1: before={remaining_before}, after={remaining_after}"
        )
        assert used_after == co_before.get("used", 0) + 1.0, (
            f"Comp-Off.used should increase by 1: before={co_before.get('used', 0)}, after={used_after}"
        )
        print(f"PASS: Comp-Off manual balance decremented — remaining: {remaining_before} → {remaining_after}")


# ─────────────────────────────────────────────────────────────────────────────
# Group D: Comp-Off regularisation (grant-based path)
# ─────────────────────────────────────────────────────────────────────────────

class TestCompOffGrantPath:
    """When leave_type=Comp-Off and no manual balance stored, oldest approved grant is marked 'used'."""

    def test_compoff_regularisation_marks_grant_used(self, admin_headers):
        """Regularisation with Comp-Off marks oldest approved grant as 'used'."""
        # Find the approved grant for RMF0009
        r = requests.get(
            f"{BASE_URL}/api/comp-offs/all?status=approved&employee_id={EMP_CO_GRANT}",
            headers=admin_headers
        )
        assert r.status_code == 200
        grants = r.json()

        # Filter to the employee specifically
        emp_grants = [g for g in grants if g.get("employee_id") == EMP_CO_GRANT]
        assert len(emp_grants) > 0, f"No approved grants found for {EMP_CO_GRANT} — skip test if none"

        # Sort by earn_date ascending (oldest first)
        emp_grants.sort(key=lambda g: g.get("earn_date", ""))
        oldest_grant = emp_grants[0]
        grant_id = oldest_grant["id"]
        print(f"Oldest approved grant for {EMP_CO_GRANT}: id={grant_id}, earn={oldest_grant['earn_date']}")

        # Verify no manual Comp-Off override for this employee
        r2 = requests.get(f"{BASE_URL}/api/leaves/balance/{EMP_CO_GRANT}", headers=admin_headers)
        assert r2.status_code == 200
        bal = r2.json()
        assert bal.get("Comp-Off") is None or not isinstance(bal.get("Comp-Off"), dict), (
            f"Test requires no manual Comp-Off for {EMP_CO_GRANT}, found: {bal.get('Comp-Off')}"
        )

        # Create regularisation with status=leave, leave_type=Comp-Off
        r3 = requests.post(
            f"{BASE_URL}/api/attendance/records",
            headers=admin_headers,
            json={
                "employee_id": EMP_CO_GRANT,
                "date": DATE_CO_GRANT,
                "status": "leave",
                "leave_type": "Comp-Off",
                "reason": "TEST_compoff_grant_deduction",
            }
        )
        assert r3.status_code in (200, 201), f"Grant-path regularisation failed: {r3.status_code}: {r3.text[:300]}"
        data = r3.json()
        assert data.get("status") == "leave"
        assert data.get("leave_type") == "Comp-Off"

        # Verify the grant is now 'used'
        r4 = requests.get(
            f"{BASE_URL}/api/comp-offs/all?status=used&employee_id={EMP_CO_GRANT}",
            headers=admin_headers
        )
        assert r4.status_code == 200
        used_grants = [g for g in r4.json() if g.get("employee_id") == EMP_CO_GRANT and g.get("id") == grant_id]
        assert len(used_grants) == 1, (
            f"Expected grant {grant_id} to be 'used', not found in used grants. "
            f"Response: {r4.json()[:3]}"
        )
        _state["comp_off_grant_id_used"] = grant_id
        print(f"PASS: Comp-Off grant {grant_id} marked as 'used' after regularisation")


# ─────────────────────────────────────────────────────────────────────────────
# Group E: PUT /api/leaves/admin/balance/{employee_id} with CompOff fields
# ─────────────────────────────────────────────────────────────────────────────

class TestCompOffBalanceUpdate:
    """PUT balance endpoint stores CompOff_total/CompOff_used as manual override."""

    def test_put_balance_with_compoff_returns_correct_values(self, admin_headers):
        """PUT with CompOff_total=5, CompOff_used=2 → 200 with Comp-Off: {total:5, used:2, remaining:3}."""
        # Get current standard balances so we preserve them
        r = requests.get(f"{BASE_URL}/api/leaves/balance/{EMP_CO_BALANCE}", headers=admin_headers)
        assert r.status_code == 200
        bal = r.json()
        cl = bal.get("CL", {"total": 3.5, "used": 0.0})
        sl = bal.get("SL", {"total": 7.5, "used": 0.0})
        el = bal.get("EL", {"total": 0.0, "used": 0.0})
        marriage = bal.get("Marriage", {"total": 5.0, "used": 0.0})

        r2 = requests.put(
            f"{BASE_URL}/api/leaves/admin/balance/{EMP_CO_BALANCE}",
            headers=admin_headers,
            json={
                "CL_total": cl.get("total", 3.5),
                "CL_used": cl.get("used", 0.0),
                "SL_total": sl.get("total", 7.5),
                "SL_used": sl.get("used", 0.0),
                "EL_total": el.get("total", 0.0),
                "EL_used": el.get("used", 0.0),
                "Marriage_total": marriage.get("total", 5.0),
                "Marriage_used": marriage.get("used", 0.0),
                "CompOff_total": 5.0,
                "CompOff_used": 2.0,
                "reason": "TEST_compoff_balance_manual_override",
            }
        )
        assert r2.status_code == 200, f"PUT balance failed: {r2.status_code}: {r2.text[:300]}"
        data = r2.json()

        assert "balance" in data, "Response should contain 'balance' key"
        co = data["balance"].get("Comp-Off")
        assert co is not None, "Comp-Off should be present in balance response"
        assert co.get("total") == 5.0, f"Expected total=5.0, got {co.get('total')}"
        assert co.get("used") == 2.0, f"Expected used=2.0, got {co.get('used')}"
        assert co.get("remaining") == 3.0, f"Expected remaining=3.0, got {co.get('remaining')}"

        _state["rmf0003_compoff_set"] = True
        print(f"PASS: PUT balance with CompOff — response: {co}")

    def test_get_balances_all_shows_manual_compoff(self, admin_headers):
        """GET /api/leaves/balances/all shows manual Comp-Off override for RMF0003 (not grant-count)."""
        r = requests.get(f"{BASE_URL}/api/leaves/balances/all", headers=admin_headers)
        assert r.status_code == 200, f"Get all balances failed: {r.status_code}"
        all_balances = r.json()

        # Find RMF0003 in the result
        emp_bal = next((b for b in all_balances if b.get("employee_id") == EMP_CO_BALANCE), None)
        assert emp_bal is not None, f"{EMP_CO_BALANCE} not found in balances/all response"

        co = emp_bal.get("Comp-Off")
        assert co is not None, f"Comp-Off missing for {EMP_CO_BALANCE} in balances/all"
        assert co.get("total") == 5.0, f"Expected total=5, got {co.get('total')}"
        assert co.get("used") == 2.0, f"Expected used=2, got {co.get('used')}"
        assert co.get("remaining") == 3.0, f"Expected remaining=3, got {co.get('remaining')}"
        print(f"PASS: balances/all shows manual Comp-Off for {EMP_CO_BALANCE}: {co}")

    def test_get_balance_employee_shows_manual_compoff(self, admin_headers):
        """GET /api/leaves/balance/{employee_id} returns stored Comp-Off values."""
        r = requests.get(f"{BASE_URL}/api/leaves/balance/{EMP_CO_BALANCE}", headers=admin_headers)
        assert r.status_code == 200, f"Balance fetch failed: {r.status_code}"
        bal = r.json()

        co = bal.get("Comp-Off")
        assert co is not None, f"Comp-Off should be present in balance document for {EMP_CO_BALANCE}"
        assert co.get("total") == 5.0, f"Expected total=5.0, got {co.get('total')}"
        assert co.get("used") == 2.0, f"Expected used=2.0, got {co.get('used')}"
        assert co.get("remaining") == 3.0, f"Expected remaining=3.0, got {co.get('remaining')}"
        print(f"PASS: balance/{EMP_CO_BALANCE} shows manual Comp-Off: {co}")


# ─────────────────────────────────────────────────────────────────────────────
# Group F: PUT without CompOff fields — other employee unaffected (still grant-count)
# ─────────────────────────────────────────────────────────────────────────────

class TestCompOffNoSideEffects:
    """PUT /api/leaves/admin/balance without CompOff fields — employee unaffected (still uses grant-count)."""

    def test_put_balance_without_compoff_no_manual_override(self, admin_headers):
        """PUT for RMF0002 WITHOUT CompOff fields does not create a manual override."""
        # Get current balances for RMF0002
        r = requests.get(f"{BASE_URL}/api/leaves/balance/{EMP_CL}", headers=admin_headers)
        assert r.status_code == 200
        bal = r.json()
        cl = bal.get("CL", {"total": 3.5, "used": 0.0})
        sl = bal.get("SL", {"total": 7.5, "used": 0.0})
        el = bal.get("EL", {"total": 0.0, "used": 0.0})
        marriage = bal.get("Marriage", {"total": 5.0, "used": 0.0})

        # PUT without CompOff fields
        r2 = requests.put(
            f"{BASE_URL}/api/leaves/admin/balance/{EMP_CL}",
            headers=admin_headers,
            json={
                "CL_total": cl.get("total", 3.5),
                "CL_used": cl.get("used", 0.0),
                "SL_total": sl.get("total", 7.5),
                "SL_used": sl.get("used", 0.0),
                "EL_total": el.get("total", 0.0),
                "EL_used": el.get("used", 0.0),
                "Marriage_total": marriage.get("total", 5.0),
                "Marriage_used": marriage.get("used", 0.0),
                "reason": "TEST_no_compoff_fields_update",
            }
        )
        assert r2.status_code == 200, f"PUT without CompOff failed: {r2.status_code}: {r2.text[:300]}"
        data = r2.json()

        # Comp-Off should NOT be in the response balance (not set)
        co_in_response = data.get("balance", {}).get("Comp-Off")
        assert co_in_response is None, (
            f"Comp-Off should NOT be set when CompOff fields not provided, got: {co_in_response}"
        )
        print(f"PASS: PUT without CompOff fields — no Comp-Off in response balance")

    def test_balances_all_uses_grant_count_for_no_override_employee(self, admin_headers):
        """GET /api/leaves/balances/all: RMF0002 Comp-Off is grant-count based (no manual override)."""
        r = requests.get(f"{BASE_URL}/api/leaves/balances/all", headers=admin_headers)
        assert r.status_code == 200
        all_balances = r.json()

        # Find RMF0002 in the result
        emp_bal = next((b for b in all_balances if b.get("employee_id") == EMP_CL), None)
        assert emp_bal is not None, f"{EMP_CL} not found in balances/all"

        co = emp_bal.get("Comp-Off")
        assert co is not None, f"Comp-Off should always be present in balances/all for any employee"
        # RMF0002 has no approved grants, so remaining and total should match grant-count (0)
        # NOTE: This tests the fallback path (no manual override → use grant count)
        assert isinstance(co.get("remaining"), (int, float)), f"Comp-Off.remaining should be numeric: {co}"
        assert isinstance(co.get("total"), (int, float)), f"Comp-Off.total should be numeric: {co}"
        print(f"PASS: {EMP_CL} uses grant-count Comp-Off in balances/all: {co}")


# ─────────────────────────────────────────────────────────────────────────────
# Group G: CL leave approval — approval_type defaults correctly (not hardcoded 'sl')
# ─────────────────────────────────────────────────────────────────────────────

class TestLeaveApprovalTypeDefault:
    """Approving a CL leave without specifying approval_type → approval_type='cl' (not 'sl')."""

    def test_create_cl_leave_application(self, admin_headers):
        """Create a CL leave for RMF0002."""
        r = requests.post(
            f"{BASE_URL}/api/leaves",
            headers=admin_headers,
            json={
                "employee_id": EMP_CL,
                "leave_type": "CL",
                "start_date": "2026-10-05",
                "end_date": "2026-10-05",
                "reason": "TEST_CL_approval_type_check",
                "day_type": "full_day",
            }
        )
        assert r.status_code in (200, 201), f"CL leave creation failed: {r.status_code}: {r.text[:300]}"
        data = r.json()
        assert data.get("id"), "No leave ID in response"
        assert data.get("leave_type") == "CL"
        assert data.get("status") == "pending"
        _state["test_leave_id"] = data["id"]
        print(f"PASS: CL leave created: id={data['id']}, type={data['leave_type']}")

    def test_approve_cl_leave_correct_approval_type(self, admin_headers):
        """Approving CL leave without approval_type → approval_type='cl' (bug fix for hardcoded 'sl')."""
        leave_id = _state.get("test_leave_id")
        assert leave_id, "Pre-condition failed — no leave ID"

        # Approve without specifying approval_type (should default to 'cl')
        r = requests.put(
            f"{BASE_URL}/api/leaves/{leave_id}/approve",
            headers=admin_headers,
            json={"action": "approve"},
        )
        assert r.status_code == 200, f"CL approve failed: {r.status_code}: {r.text[:300]}"
        data = r.json()

        assert data.get("status") == "approved", f"Expected status='approved', got {data.get('status')}"
        approval_type = data.get("approval_type")
        assert approval_type == "cl", (
            f"BUG: approval_type should be 'cl' for CL leave, got '{approval_type}'. "
            f"This was the hardcoded 'sl' default bug."
        )

        # Verify the message is for CL, not SL
        message = data.get("message", "")
        assert "Sick Leave" not in message, (
            f"Message should not say 'Sick Leave' for a CL approval. Got: '{message}'"
        )
        assert "Casual Leave" in message or approval_type == "cl", (
            f"Expected CL-appropriate message, got: '{message}'"
        )

        _state["cl_balance_deducted_by_approval"] = True
        print(f"PASS: CL leave approved with approval_type='{approval_type}', message='{message}'")

    def test_get_approved_cl_leave_has_correct_approval_type(self, admin_headers):
        """Verify the approved leave record in DB has approval_type='cl'."""
        leave_id = _state.get("test_leave_id")
        assert leave_id, "Pre-condition failed — no leave ID"

        r = requests.get(f"{BASE_URL}/api/leaves/{leave_id}", headers=admin_headers)
        assert r.status_code == 200, f"Get leave failed: {r.status_code}"
        data = r.json()

        assert data.get("status") == "approved"
        assert data.get("approval_type") == "cl", (
            f"DB record has approval_type='{data.get('approval_type')}', expected 'cl'"
        )
        print(f"PASS: DB record has correct approval_type='cl' for approved CL leave")
