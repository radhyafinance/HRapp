"""
Iteration 20 — Backend tests for Comp-Off leave deduction fix.

Bug fixed: Comp-Off leaves were not getting auto-deducted when approved.
Root cause: BALANCE_TRACKED list only had ['CL', 'SL', 'EL', 'Marriage'] — Comp-Off was missing.

Fix: Added dedicated Comp-Off deduction block in:
  1. approve_leave() — standard manager/admin approval flow (lines 849-874)
  2. apply_leave()   — auto-approve when HR applies on behalf (lines 372-394)

Test coverage:
  A) approve_leave() — grant-based path: create approved grant → apply (pending) → admin approves → grant='used'
  B) approve_leave() — manual balance path: set manual Comp-Off balance → apply (pending) → approve → balance decremented
  C) apply_leave() auto-approve — grant-based path: create grant → HR applies on behalf → grant='used' immediately
  D) apply_leave() auto-approve — manual balance path: set manual balance → HR applies on behalf → balance decremented
  E) CL leave regression: approve CL leave → CL balance decremented (not broken by code change)
  F) SL leave regression: approve SL leave → SL balance decremented
  G) GET /api/leaves/balances/all — Comp-Off remaining decremented after approval
  H) Idempotency: second Comp-Off leave approval without grants returns 200 (no crash)
"""

import pytest
import requests
import os
from pymongo import MongoClient
from bson import ObjectId
from datetime import datetime, timezone, timedelta

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")

# MongoDB for direct test data insertion/cleanup
MONGO_URL = "mongodb://localhost:27017"
DB_NAME = "radhya_hr_db"

# Test employees (active employees)
EMP_GRANT_APPROVE = "RMF0010"     # Test A: approve_leave() grant path (reporting_to: RMF0002)
EMP_MANUAL_APPROVE = "RMF0016"   # Test B: approve_leave() manual balance path (reporting_to: RMF0002)
EMP_GRANT_AUTOAPPROVE = "RMF0012"  # Test C: apply_leave() auto-approve grant path
EMP_MANUAL_AUTOAPPROVE = "RMF0005" # Test D: apply_leave() auto-approve manual balance path

# Regression test employees
EMP_CL_REGRESSION = "RMF0002"    # Test E: CL regression
EMP_SL_REGRESSION = "RMF0003"    # Test F: SL regression

# Future test dates (non-Sundays)
DATE_GRANT_APPROVE = "2026-09-21"       # Monday
DATE_MANUAL_APPROVE = "2026-09-22"      # Tuesday
DATE_GRANT_AUTOAPPROVE = "2026-09-23"   # Wednesday
DATE_MANUAL_AUTOAPPROVE = "2026-09-24"  # Thursday
DATE_CL_REGRESSION = "2026-10-12"       # Monday
DATE_SL_REGRESSION = "2026-10-13"       # Tuesday
DATE_NO_GRANT = "2026-09-25"            # For idempotency test

# Module-level state to share IDs between tests (cleanup + assertions)
_state = {}


def get_db():
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
def ah(admin_token):
    """Admin headers shorthand."""
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


# ── Cleanup Fixture ───────────────────────────────────────────────────────────

@pytest.fixture(scope="module", autouse=True)
def cleanup_test_data():
    """Insert test comp_off_grants before tests, clean up all test data after module completes."""
    db, client = get_db()

    # ── Pre-test setup: Insert test comp_off_grants in MongoDB ────────────────
    now_str = datetime.now(timezone.utc).isoformat()

    # Grant A: for EMP_GRANT_APPROVE (approve_leave() grant path)
    grant_a = {
        "employee_id": EMP_GRANT_APPROVE,
        "earn_date": "2026-07-01",
        "earn_reason": "TEST_iter20_grant_path_approve",
        "status": "approved",
        "source": "regularisation",
        "created_at": now_str,
        "approved_at": now_str,
        "approved_by": "admin",
        "expiry_date": "2027-01-31",
    }
    result_a = db.comp_off_grants.insert_one(grant_a)
    _state["grant_a_id"] = str(result_a.inserted_id)

    # Grant C: for EMP_GRANT_AUTOAPPROVE (apply_leave() auto-approve grant path)
    grant_c = {
        "employee_id": EMP_GRANT_AUTOAPPROVE,
        "earn_date": "2026-07-02",
        "earn_reason": "TEST_iter20_grant_path_autoapprove",
        "status": "approved",
        "source": "regularisation",
        "created_at": now_str,
        "approved_at": now_str,
        "approved_by": "admin",
        "expiry_date": "2027-01-31",
    }
    result_c = db.comp_off_grants.insert_one(grant_c)
    _state["grant_c_id"] = str(result_c.inserted_id)

    print(f"[setup] Inserted test grants: A={_state['grant_a_id']}, C={_state['grant_c_id']}")

    yield  # ── Tests run here ────────────────────────────────────────────────

    # ── Teardown: clean up all test data ─────────────────────────────────────
    try:
        # Remove test comp_off_grants (even if still 'approved' — failed test)
        for gid in [_state.get("grant_a_id"), _state.get("grant_c_id")]:
            if gid:
                db.comp_off_grants.delete_one({"_id": ObjectId(gid)})
                print(f"[cleanup] Deleted comp_off_grant {gid}")

        # Remove test leave applications
        for key in ["leave_a_id", "leave_b_id", "leave_e_id", "leave_f_id", "leave_h_id"]:
            lid = _state.get(key)
            if lid:
                db.leave_applications.delete_one({"_id": ObjectId(lid)})
                print(f"[cleanup] Deleted leave application {lid} ({key})")

        # Revert manual Comp-Off balance for EMP_MANUAL_APPROVE if set (unset completely)
        if _state.get("manual_b_set"):
            db.leave_balances.update_one(
                {"employee_id": EMP_MANUAL_APPROVE, "year": 2026},
                {"$unset": {"Comp-Off": ""}}
            )
            print(f"[cleanup] Removed Comp-Off manual override for {EMP_MANUAL_APPROVE}")
            # Mark as fully cleaned — skip separate $inc reversal below
            _state["manual_b_unset_done"] = True

        # Revert manual Comp-Off balance for EMP_MANUAL_AUTOAPPROVE if set (unset completely)
        if _state.get("manual_d_set"):
            db.leave_balances.update_one(
                {"employee_id": EMP_MANUAL_AUTOAPPROVE, "year": 2026},
                {"$unset": {"Comp-Off": ""}}
            )
            print(f"[cleanup] Removed Comp-Off manual override for {EMP_MANUAL_AUTOAPPROVE}")
            _state["manual_d_unset_done"] = True

        # Revert CL balance for regression employee
        if _state.get("cl_regression_deducted"):
            db.leave_balances.update_one(
                {"employee_id": EMP_CL_REGRESSION, "year": 2026},
                {"$inc": {"CL.used": -1.0, "CL.remaining": 1.0}}
            )
            print(f"[cleanup] Reverted CL balance for {EMP_CL_REGRESSION}")

        # Revert SL balance for regression employee
        if _state.get("sl_regression_deducted"):
            db.leave_balances.update_one(
                {"employee_id": EMP_SL_REGRESSION, "year": 2026},
                {"$inc": {"SL.used": -1.0, "SL.remaining": 1.0}}
            )
            print(f"[cleanup] Reverted SL balance for {EMP_SL_REGRESSION}")

        # Revert Comp-Off auto-approve balance if deducted from manual balance
        # (Only run if $unset was NOT already done above — avoids creating corrupt state)
        if _state.get("manual_b_deducted") and not _state.get("manual_b_unset_done"):
            db.leave_balances.update_one(
                {"employee_id": EMP_MANUAL_APPROVE, "year": 2026},
                {"$inc": {"Comp-Off.used": -1.0, "Comp-Off.remaining": 1.0}}
            )
            print(f"[cleanup] Reverted manual Comp-Off balance decrement for {EMP_MANUAL_APPROVE}")

        if _state.get("manual_d_deducted") and not _state.get("manual_d_unset_done"):
            db.leave_balances.update_one(
                {"employee_id": EMP_MANUAL_AUTOAPPROVE, "year": 2026},
                {"$inc": {"Comp-Off.used": -1.0, "Comp-Off.remaining": 1.0}}
            )
            print(f"[cleanup] Reverted manual Comp-Off balance decrement for {EMP_MANUAL_AUTOAPPROVE}")

    finally:
        client.close()


# ═════════════════════════════════════════════════════════════════════════════
# Group A: approve_leave() — grant-based Comp-Off deduction
# ═════════════════════════════════════════════════════════════════════════════

class TestApproveLeavCompOffGrantPath:
    """approve_leave() marks the oldest approved grant as 'used' when no manual balance exists."""

    def test_a1_ensure_no_manual_compoff_balance_for_employee(self, ah):
        """Precondition: EMP_GRANT_APPROVE must NOT have a manual Comp-Off balance."""
        r = requests.get(f"{BASE_URL}/api/leaves/balance/{EMP_GRANT_APPROVE}", headers=ah)
        assert r.status_code == 200, f"Balance fetch failed: {r.status_code}: {r.text[:200]}"
        bal = r.json()
        co = bal.get("Comp-Off", {})
        # If manual balance exists and has remaining > 0, unset it via direct MongoDB
        db, client = get_db()
        try:
            existing = db.leave_balances.find_one({"employee_id": EMP_GRANT_APPROVE, "year": 2026}, {"_id": 0, "Comp-Off": 1})
            if existing and existing.get("Comp-Off"):
                db.leave_balances.update_one(
                    {"employee_id": EMP_GRANT_APPROVE, "year": 2026},
                    {"$unset": {"Comp-Off": ""}}
                )
                print(f"[precondition] Cleared manual Comp-Off for {EMP_GRANT_APPROVE}")
        finally:
            client.close()
        print(f"PASS: Precondition OK — no manual Comp-Off for {EMP_GRANT_APPROVE}")

    def test_a2_grant_exists_and_approved_before_leave_apply(self, ah):
        """Verify our test grant for EMP_GRANT_APPROVE is in 'approved' status."""
        grant_id = _state.get("grant_a_id")
        assert grant_id, "Grant A not set up in fixture"

        db, client = get_db()
        try:
            grant = db.comp_off_grants.find_one({"_id": ObjectId(grant_id)})
            assert grant is not None, f"Test grant {grant_id} not found in DB"
            assert grant["status"] == "approved", f"Expected status='approved', got {grant['status']}"
            assert grant["employee_id"] == EMP_GRANT_APPROVE
        finally:
            client.close()
        print(f"PASS: Grant {grant_id} exists for {EMP_GRANT_APPROVE} with status='approved'")

    def test_a3_apply_compoff_leave_creates_pending_application(self, ah):
        """
        Insert a pending Comp-Off leave application via MongoDB (employee self-applies).
        We use direct DB insertion so we can test the approve_leave() path specifically,
        without triggering the auto-approve that happens when admin applies on behalf.
        """
        db, client = get_db()
        try:
            now_str = datetime.now(timezone.utc).isoformat()
            doc = {
                "employee_id": EMP_GRANT_APPROVE,
                "leave_type": "Comp-Off",
                "start_date": DATE_GRANT_APPROVE,
                "end_date": DATE_GRANT_APPROVE,
                "days": 1.0,
                "day_type": "full_day",
                "start_half": False,
                "end_half": False,
                "reason": "TEST_iter20_compoff_grant_approve_path",
                "status": "pending",
                "applied_at": now_str,
                "applied_by_admin": False,
                "approved_by": None,
                "approval_date": None,
                "remarks": None,
                "approval_type": None,
                "medical_certificate": None,
                "certificate_uploaded_at": None,
            }
            result = db.leave_applications.insert_one(doc)
            leave_id = str(result.inserted_id)
            _state["leave_a_id"] = leave_id
        finally:
            client.close()
        assert leave_id, "Failed to insert test leave application"
        print(f"PASS: Pending Comp-Off leave inserted for {EMP_GRANT_APPROVE}: id={leave_id}")

    def test_a4_approve_compoff_leave_returns_200(self, ah):
        """PUT /api/leaves/{id}/approve with action='approve' returns 200."""
        leave_id = _state.get("leave_a_id")
        assert leave_id, "Pre-condition failed: no leave_a_id"

        r = requests.put(
            f"{BASE_URL}/api/leaves/{leave_id}/approve",
            headers=ah,
            json={"action": "approve"},
        )
        assert r.status_code == 200, f"Approve failed: {r.status_code}: {r.text[:400]}"
        data = r.json()
        assert data.get("status") == "approved", f"Expected status='approved', got {data.get('status')}"
        assert data.get("approval_type") == "comp_off", (
            f"Expected approval_type='comp_off', got '{data.get('approval_type')}'"
        )
        print(f"PASS: Comp-Off leave approved: status={data['status']}, approval_type={data['approval_type']}, message='{data.get('message')}'")

    def test_a5_grant_marked_used_after_approve(self, ah):
        """After approve_leave(), the oldest approved grant for EMP_GRANT_APPROVE is 'used'."""
        grant_id = _state.get("grant_a_id")
        assert grant_id, "Grant A not set up"

        db, client = get_db()
        try:
            grant = db.comp_off_grants.find_one({"_id": ObjectId(grant_id)})
            assert grant is not None, f"Grant {grant_id} not found"
            assert grant["status"] == "used", (
                f"BUG: Grant {grant_id} should be 'used' after approve, but status='{grant['status']}'. "
                f"Comp-Off deduction was not triggered by approve_leave()."
            )
            assert grant.get("used_at") is not None, (
                f"BUG: Grant {grant_id} has status='used' but 'used_at' field is missing."
            )
        finally:
            client.close()
        print(f"PASS: Grant {grant_id} has status='used' and used_at set after approval.")

    def test_a6_balances_all_shows_zero_compoff_after_approval(self, ah):
        """GET /api/leaves/balances/all shows Comp-Off remaining=0 after the grant is used."""
        r = requests.get(f"{BASE_URL}/api/leaves/balances/all", headers=ah)
        assert r.status_code == 200, f"balances/all failed: {r.status_code}"
        all_balances = r.json()

        emp_bal = next((b for b in all_balances if b.get("employee_id") == EMP_GRANT_APPROVE), None)
        assert emp_bal is not None, f"{EMP_GRANT_APPROVE} not found in balances/all"
        co = emp_bal.get("Comp-Off", {})
        # After using the only grant, remaining should reflect the grant count (0 approved grants now)
        remaining = co.get("remaining", -1)
        assert remaining == 0, (
            f"BUG: Comp-Off remaining should be 0 after grant used, got {remaining}. "
            f"Full Comp-Off: {co}"
        )
        print(f"PASS: balances/all shows Comp-Off remaining={remaining} for {EMP_GRANT_APPROVE}")


# ═════════════════════════════════════════════════════════════════════════════
# Group B: approve_leave() — manual balance Comp-Off deduction
# ═════════════════════════════════════════════════════════════════════════════

class TestApproveLeaveCompOffManualBalancePath:
    """approve_leave() decrements the manual Comp-Off balance when it exists with remaining > 0."""

    def test_b1_setup_manual_compoff_balance(self, ah):
        """Set manual Comp-Off balance (total=3, used=0, remaining=3) for EMP_MANUAL_APPROVE."""
        r = requests.get(f"{BASE_URL}/api/leaves/balance/{EMP_MANUAL_APPROVE}", headers=ah)
        assert r.status_code == 200
        bal = r.json()
        cl = bal.get("CL", {"total": 3.5, "used": 0.0})
        sl = bal.get("SL", {"total": 7.5, "used": 0.0})
        el = bal.get("EL", {"total": 0.0, "used": 0.0})
        marriage = bal.get("Marriage", {"total": 5.0, "used": 0.0})

        r2 = requests.put(
            f"{BASE_URL}/api/leaves/admin/balance/{EMP_MANUAL_APPROVE}",
            headers=ah,
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
                "reason": "TEST_iter20_setup_manual_compoff_balance_for_approval",
            }
        )
        assert r2.status_code == 200, f"Balance setup failed: {r2.status_code}: {r2.text[:300]}"
        _state["manual_b_set"] = True
        print(f"PASS: Manual Comp-Off balance (3, used=0, remaining=3) set for {EMP_MANUAL_APPROVE}")

    def test_b2_apply_pending_compoff_leave_manual(self, ah):
        """Insert a pending Comp-Off leave for EMP_MANUAL_APPROVE via MongoDB."""
        db, client = get_db()
        try:
            now_str = datetime.now(timezone.utc).isoformat()
            doc = {
                "employee_id": EMP_MANUAL_APPROVE,
                "leave_type": "Comp-Off",
                "start_date": DATE_MANUAL_APPROVE,
                "end_date": DATE_MANUAL_APPROVE,
                "days": 1.0,
                "day_type": "full_day",
                "start_half": False,
                "end_half": False,
                "reason": "TEST_iter20_compoff_manual_balance_approve_path",
                "status": "pending",
                "applied_at": now_str,
                "applied_by_admin": False,
                "approved_by": None,
                "approval_date": None,
                "remarks": None,
                "approval_type": None,
                "medical_certificate": None,
                "certificate_uploaded_at": None,
            }
            result = db.leave_applications.insert_one(doc)
            leave_id = str(result.inserted_id)
            _state["leave_b_id"] = leave_id
        finally:
            client.close()
        print(f"PASS: Pending Comp-Off leave inserted for {EMP_MANUAL_APPROVE}: id={leave_id}")

    def test_b3_approve_compoff_leave_manual_balance(self, ah):
        """Approve the pending Comp-Off leave. Should decrement manual balance."""
        leave_id = _state.get("leave_b_id")
        assert leave_id, "Pre-condition: no leave_b_id"

        r = requests.put(
            f"{BASE_URL}/api/leaves/{leave_id}/approve",
            headers=ah,
            json={"action": "approve"},
        )
        assert r.status_code == 200, f"Approve failed: {r.status_code}: {r.text[:400]}"
        data = r.json()
        assert data.get("status") == "approved"
        assert data.get("approval_type") == "comp_off"
        print(f"PASS: Comp-Off leave approved (manual balance path): approval_type={data['approval_type']}")

    def test_b4_manual_compoff_balance_decremented(self, ah):
        """After approval, manual Comp-Off balance.remaining should be 2 (was 3, minus 1)."""
        r = requests.get(f"{BASE_URL}/api/leaves/balance/{EMP_MANUAL_APPROVE}", headers=ah)
        assert r.status_code == 200
        bal = r.json()
        co = bal.get("Comp-Off", {})
        remaining = co.get("remaining", -1)
        used = co.get("used", -1)

        assert remaining == 2.0, (
            f"BUG: Comp-Off.remaining should be 2 after approval (was 3), got {remaining}. "
            f"Manual Comp-Off balance was NOT decremented by approve_leave()."
        )
        assert used == 1.0, f"Expected Comp-Off.used=1.0, got {used}"
        _state["manual_b_deducted"] = True
        print(f"PASS: Manual Comp-Off balance decremented — remaining: 3 → {remaining}, used: 0 → {used}")


# ═════════════════════════════════════════════════════════════════════════════
# Group C: apply_leave() auto-approve — grant-based Comp-Off deduction
# ═════════════════════════════════════════════════════════════════════════════

class TestApplyLeaveAutoApproveGrantPath:
    """When HR applies on behalf (auto-approve), grant is marked 'used' immediately."""

    def test_c1_ensure_no_manual_compoff_for_autoapprove_employee(self, ah):
        """Precondition: EMP_GRANT_AUTOAPPROVE must NOT have a manual Comp-Off balance."""
        db, client = get_db()
        try:
            existing = db.leave_balances.find_one(
                {"employee_id": EMP_GRANT_AUTOAPPROVE, "year": 2026},
                {"_id": 0, "Comp-Off": 1}
            )
            if existing and existing.get("Comp-Off"):
                db.leave_balances.update_one(
                    {"employee_id": EMP_GRANT_AUTOAPPROVE, "year": 2026},
                    {"$unset": {"Comp-Off": ""}}
                )
                print(f"[precondition] Cleared manual Comp-Off for {EMP_GRANT_AUTOAPPROVE}")
        finally:
            client.close()
        print(f"PASS: Precondition OK — no manual Comp-Off for {EMP_GRANT_AUTOAPPROVE}")

    def test_c2_grant_c_is_approved_before_auto_apply(self, ah):
        """Verify test grant C for EMP_GRANT_AUTOAPPROVE has status='approved'."""
        grant_id = _state.get("grant_c_id")
        assert grant_id, "Grant C not inserted by fixture"

        db, client = get_db()
        try:
            grant = db.comp_off_grants.find_one({"_id": ObjectId(grant_id)})
            assert grant is not None
            assert grant["status"] == "approved"
            assert grant["employee_id"] == EMP_GRANT_AUTOAPPROVE
        finally:
            client.close()
        print(f"PASS: Grant {grant_id} is 'approved' for {EMP_GRANT_AUTOAPPROVE}")

    def test_c3_hr_applies_compoff_on_behalf_auto_approves(self, ah):
        """
        HR applies Comp-Off leave on behalf of EMP_GRANT_AUTOAPPROVE.
        This triggers apply_leave() with is_admin_for_other=True → auto-approve + grant deduction.
        """
        r = requests.post(
            f"{BASE_URL}/api/leaves",
            headers=ah,
            json={
                "employee_id": EMP_GRANT_AUTOAPPROVE,
                "leave_type": "Comp-Off",
                "start_date": DATE_GRANT_AUTOAPPROVE,
                "end_date": DATE_GRANT_AUTOAPPROVE,
                "reason": "TEST_iter20_autoapprove_grant_path",
                "day_type": "full_day",
            }
        )
        assert r.status_code in (200, 201), f"HR apply on behalf failed: {r.status_code}: {r.text[:400]}"
        data = r.json()
        # Auto-approve: status must be 'approved' immediately
        assert data.get("status") == "approved", (
            f"Expected status='approved' (admin applied on behalf → auto-approve), got {data.get('status')}"
        )
        assert data.get("applied_by_admin") is True, (
            f"Expected applied_by_admin=True, got {data.get('applied_by_admin')}"
        )
        assert data.get("employee_id") == EMP_GRANT_AUTOAPPROVE
        assert data.get("leave_type") == "Comp-Off"
        leave_id = data.get("id")
        # Store for possible cleanup if needed
        if leave_id:
            db, client = get_db()
            try:
                # Delete this auto-created leave after tests complete
                pass
            finally:
                client.close()
        _state["auto_approve_leave_id"] = leave_id
        print(f"PASS: HR applied Comp-Off on behalf → auto-approved: id={leave_id}, status={data['status']}")

    def test_c4_grant_marked_used_after_auto_approve(self, ah):
        """After apply_leave() auto-approve, the test grant C for EMP_GRANT_AUTOAPPROVE is 'used'."""
        grant_id = _state.get("grant_c_id")
        assert grant_id

        db, client = get_db()
        try:
            grant = db.comp_off_grants.find_one({"_id": ObjectId(grant_id)})
            assert grant is not None
            assert grant["status"] == "used", (
                f"BUG: Grant {grant_id} should be 'used' after auto-approve, but status='{grant['status']}'. "
                f"apply_leave() Comp-Off deduction block is not working."
            )
            assert grant.get("used_at") is not None, (
                f"BUG: Grant has status='used' but 'used_at' field is missing."
            )
        finally:
            client.close()
        print(f"PASS: Grant {grant_id} is 'used' after HR auto-approve apply_leave()")

    def test_c5_cleanup_auto_approved_leave(self, ah):
        """Clean up the auto-approved leave created in test_c3."""
        leave_id = _state.get("auto_approve_leave_id")
        if leave_id:
            db, client = get_db()
            try:
                db.leave_applications.delete_one({"_id": ObjectId(leave_id)})
                print(f"[cleanup_c5] Deleted auto-approved leave: {leave_id}")
            finally:
                client.close()
        print("PASS: Auto-approved leave cleaned up")


# ═════════════════════════════════════════════════════════════════════════════
# Group D: apply_leave() auto-approve — manual balance Comp-Off deduction
# ═════════════════════════════════════════════════════════════════════════════

class TestApplyLeaveAutoApproveManualBalancePath:
    """When HR applies on behalf and employee has manual Comp-Off balance, it is decremented."""

    def test_d1_setup_manual_compoff_balance_for_autoapprove(self, ah):
        """Set manual Comp-Off balance (total=4, used=1, remaining=3) for EMP_MANUAL_AUTOAPPROVE."""
        r = requests.get(f"{BASE_URL}/api/leaves/balance/{EMP_MANUAL_AUTOAPPROVE}", headers=ah)
        assert r.status_code == 200
        bal = r.json()
        cl = bal.get("CL", {"total": 3.5, "used": 0.0})
        sl = bal.get("SL", {"total": 7.5, "used": 0.0})
        el = bal.get("EL", {"total": 0.0, "used": 0.0})
        marriage = bal.get("Marriage", {"total": 5.0, "used": 0.0})

        r2 = requests.put(
            f"{BASE_URL}/api/leaves/admin/balance/{EMP_MANUAL_AUTOAPPROVE}",
            headers=ah,
            json={
                "CL_total": cl.get("total", 3.5),
                "CL_used": cl.get("used", 0.0),
                "SL_total": sl.get("total", 7.5),
                "SL_used": sl.get("used", 0.0),
                "EL_total": el.get("total", 0.0),
                "EL_used": el.get("used", 0.0),
                "Marriage_total": marriage.get("total", 5.0),
                "Marriage_used": marriage.get("used", 0.0),
                "CompOff_total": 4.0,
                "CompOff_used": 1.0,
                "reason": "TEST_iter20_setup_manual_compoff_for_autoapprove",
            }
        )
        assert r2.status_code == 200, f"Balance setup failed: {r2.status_code}: {r2.text[:300]}"
        _state["manual_d_set"] = True
        print(f"PASS: Manual Comp-Off balance (total=4, used=1, remaining=3) set for {EMP_MANUAL_AUTOAPPROVE}")

    def test_d2_hr_applies_compoff_on_behalf_manual_balance(self, ah):
        """HR applies Comp-Off on behalf → auto-approve → manual Comp-Off balance decremented."""
        r = requests.post(
            f"{BASE_URL}/api/leaves",
            headers=ah,
            json={
                "employee_id": EMP_MANUAL_AUTOAPPROVE,
                "leave_type": "Comp-Off",
                "start_date": DATE_MANUAL_AUTOAPPROVE,
                "end_date": DATE_MANUAL_AUTOAPPROVE,
                "reason": "TEST_iter20_autoapprove_manual_balance_path",
                "day_type": "full_day",
            }
        )
        assert r.status_code in (200, 201), f"HR apply failed: {r.status_code}: {r.text[:400]}"
        data = r.json()
        assert data.get("status") == "approved", f"Expected auto-approved, got {data.get('status')}"
        assert data.get("leave_type") == "Comp-Off"
        _state["auto_approve_d_leave_id"] = data.get("id")
        print(f"PASS: HR applied Comp-Off on behalf for {EMP_MANUAL_AUTOAPPROVE}: auto-approved id={data.get('id')}")

    def test_d3_manual_balance_decremented_after_auto_approve(self, ah):
        """After auto-approve, manual Comp-Off remaining should be 2 (was 3, minus 1)."""
        r = requests.get(f"{BASE_URL}/api/leaves/balance/{EMP_MANUAL_AUTOAPPROVE}", headers=ah)
        assert r.status_code == 200
        bal = r.json()
        co = bal.get("Comp-Off", {})
        remaining = co.get("remaining", -1)
        used = co.get("used", -1)

        assert remaining == 2.0, (
            f"BUG: Comp-Off.remaining should be 2 after auto-approve (was 3), got {remaining}. "
            f"apply_leave() manual Comp-Off deduction block is not working."
        )
        assert used == 2.0, f"Expected Comp-Off.used=2.0 (was 1+1=2), got {used}"
        _state["manual_d_deducted"] = True
        print(f"PASS: Manual Comp-Off balance decremented after auto-approve — remaining: 3→{remaining}, used: 1→{used}")

    def test_d4_cleanup_auto_approved_leave_d(self, ah):
        """Clean up auto-approved leave from test_d2."""
        leave_id = _state.get("auto_approve_d_leave_id")
        if leave_id:
            db, client = get_db()
            try:
                db.leave_applications.delete_one({"_id": ObjectId(leave_id)})
                print(f"[cleanup_d4] Deleted auto-approved leave: {leave_id}")
            finally:
                client.close()
        print("PASS: Auto-approved leave D cleaned up")


# ═════════════════════════════════════════════════════════════════════════════
# Group E: CL leave regression — still works after code change
# ═════════════════════════════════════════════════════════════════════════════

class TestCLLeaveRegressionAfterCompOffFix:
    """CL leave approval still deducts from CL balance after the Comp-Off fix."""

    def test_e1_get_cl_balance_before(self, ah):
        """Record current CL balance for EMP_CL_REGRESSION before test."""
        r = requests.get(f"{BASE_URL}/api/leaves/balance/{EMP_CL_REGRESSION}", headers=ah)
        assert r.status_code == 200
        bal = r.json()
        cl = bal.get("CL", {})
        _state["cl_regression_before"] = cl
        print(f"CL balance before: {cl}")

    def test_e2_insert_pending_cl_leave(self, ah):
        """Insert a pending CL leave application for EMP_CL_REGRESSION."""
        db, client = get_db()
        try:
            now_str = datetime.now(timezone.utc).isoformat()
            doc = {
                "employee_id": EMP_CL_REGRESSION,
                "leave_type": "CL",
                "start_date": DATE_CL_REGRESSION,
                "end_date": DATE_CL_REGRESSION,
                "days": 1.0,
                "day_type": "full_day",
                "start_half": False,
                "end_half": False,
                "reason": "TEST_iter20_cl_regression_after_compoff_fix",
                "status": "pending",
                "applied_at": now_str,
                "applied_by_admin": False,
                "approved_by": None,
                "approval_date": None,
                "remarks": None,
                "approval_type": None,
                "medical_certificate": None,
                "certificate_uploaded_at": None,
            }
            result = db.leave_applications.insert_one(doc)
            _state["leave_e_id"] = str(result.inserted_id)
        finally:
            client.close()
        print(f"PASS: Pending CL leave inserted for {EMP_CL_REGRESSION}: id={_state['leave_e_id']}")

    def test_e3_approve_cl_leave(self, ah):
        """Admin approves the CL leave. Should return approval_type='cl'."""
        leave_id = _state.get("leave_e_id")
        assert leave_id

        r = requests.put(
            f"{BASE_URL}/api/leaves/{leave_id}/approve",
            headers=ah,
            json={"action": "approve"},
        )
        assert r.status_code == 200, f"CL approve failed: {r.status_code}: {r.text[:400]}"
        data = r.json()
        assert data.get("status") == "approved"
        assert data.get("approval_type") == "cl", (
            f"Expected approval_type='cl', got '{data.get('approval_type')}'"
        )
        print(f"PASS: CL leave approved: approval_type='{data['approval_type']}'")

    def test_e4_cl_balance_decremented(self, ah):
        """After CL approval, CL.remaining decremented by 1 and CL.used incremented by 1."""
        r = requests.get(f"{BASE_URL}/api/leaves/balance/{EMP_CL_REGRESSION}", headers=ah)
        assert r.status_code == 200
        bal = r.json()
        cl_after = bal.get("CL", {})
        cl_before = _state.get("cl_regression_before", {})

        remaining_before = cl_before.get("remaining", 0)
        remaining_after = cl_after.get("remaining", 0)
        used_before = cl_before.get("used", 0)
        used_after = cl_after.get("used", 0)

        assert remaining_after == remaining_before - 1.0, (
            f"REGRESSION BUG: CL.remaining should decrease by 1. Before={remaining_before}, After={remaining_after}. "
            f"CL balance deduction broken after Comp-Off fix."
        )
        assert used_after == used_before + 1.0, (
            f"REGRESSION BUG: CL.used should increase by 1. Before={used_before}, After={used_after}."
        )
        _state["cl_regression_deducted"] = True
        print(f"PASS CL regression: remaining {remaining_before}→{remaining_after}, used {used_before}→{used_after}")


# ═════════════════════════════════════════════════════════════════════════════
# Group F: SL leave regression — still works after code change
# ═════════════════════════════════════════════════════════════════════════════

class TestSLLeaveRegressionAfterCompOffFix:
    """SL leave approval still deducts from SL balance after the Comp-Off fix."""

    def test_f1_get_sl_balance_before(self, ah):
        """Record current SL balance for EMP_SL_REGRESSION."""
        r = requests.get(f"{BASE_URL}/api/leaves/balance/{EMP_SL_REGRESSION}", headers=ah)
        assert r.status_code == 200
        bal = r.json()
        sl = bal.get("SL", {})
        _state["sl_regression_before"] = sl
        print(f"SL balance before: {sl}")

    def test_f2_insert_pending_sl_leave(self, ah):
        """Insert a pending SL leave for EMP_SL_REGRESSION."""
        db, client = get_db()
        try:
            now_str = datetime.now(timezone.utc).isoformat()
            doc = {
                "employee_id": EMP_SL_REGRESSION,
                "leave_type": "SL",
                "start_date": DATE_SL_REGRESSION,
                "end_date": DATE_SL_REGRESSION,
                "days": 1.0,
                "day_type": "full_day",
                "start_half": False,
                "end_half": False,
                "reason": "TEST_iter20_sl_regression_after_compoff_fix",
                "status": "pending",
                "applied_at": now_str,
                "applied_by_admin": False,
                "approved_by": None,
                "approval_date": None,
                "remarks": None,
                "approval_type": None,
                "medical_certificate": None,
                "certificate_uploaded_at": None,
            }
            result = db.leave_applications.insert_one(doc)
            _state["leave_f_id"] = str(result.inserted_id)
        finally:
            client.close()
        print(f"PASS: Pending SL leave inserted for {EMP_SL_REGRESSION}: id={_state['leave_f_id']}")

    def test_f3_approve_sl_leave(self, ah):
        """Approve SL leave (1 day — no cert required). Returns approval_type='sl'."""
        leave_id = _state.get("leave_f_id")
        assert leave_id

        r = requests.put(
            f"{BASE_URL}/api/leaves/{leave_id}/approve",
            headers=ah,
            json={"action": "approve"},
        )
        assert r.status_code == 200, f"SL approve failed: {r.status_code}: {r.text[:400]}"
        data = r.json()
        assert data.get("status") == "approved"
        assert data.get("approval_type") == "sl", (
            f"Expected approval_type='sl', got '{data.get('approval_type')}'"
        )
        print(f"PASS: SL leave approved: approval_type='{data['approval_type']}'")

    def test_f4_sl_balance_decremented(self, ah):
        """After SL approval, SL.remaining decremented by 1."""
        r = requests.get(f"{BASE_URL}/api/leaves/balance/{EMP_SL_REGRESSION}", headers=ah)
        assert r.status_code == 200
        bal = r.json()
        sl_after = bal.get("SL", {})
        sl_before = _state.get("sl_regression_before", {})

        remaining_before = sl_before.get("remaining", 0)
        remaining_after = sl_after.get("remaining", 0)
        used_before = sl_before.get("used", 0)
        used_after = sl_after.get("used", 0)

        assert remaining_after == remaining_before - 1.0, (
            f"REGRESSION BUG: SL.remaining should decrease by 1. Before={remaining_before}, After={remaining_after}."
        )
        assert used_after == used_before + 1.0, (
            f"REGRESSION BUG: SL.used should increase by 1. Before={used_before}, After={used_after}."
        )
        _state["sl_regression_deducted"] = True
        print(f"PASS SL regression: remaining {remaining_before}→{remaining_after}, used {used_before}→{used_after}")


# ═════════════════════════════════════════════════════════════════════════════
# Group H: Idempotency — Comp-Off approval with no grants → no crash
# ═════════════════════════════════════════════════════════════════════════════

class TestCompOffApproveWithNoGrantsNoCrash:
    """
    If an employee has no approved grants AND no manual Comp-Off balance,
    approve_leave() should still return 200 without crashing.
    The inner for loop simply finds nothing and is a no-op.
    """

    def test_h1_create_pending_compoff_for_no_grant_employee(self, ah):
        """Insert a pending Comp-Off leave for an employee with no grants."""
        # Use EMP_SL_REGRESSION (RMF0003) — has no comp_off_grants
        db, client = get_db()
        try:
            # Ensure no manual Comp-Off balance
            db.leave_balances.update_one(
                {"employee_id": EMP_SL_REGRESSION, "year": 2026},
                {"$unset": {"Comp-Off": ""}}
            )
            now_str = datetime.now(timezone.utc).isoformat()
            doc = {
                "employee_id": EMP_SL_REGRESSION,
                "leave_type": "Comp-Off",
                "start_date": DATE_NO_GRANT,
                "end_date": DATE_NO_GRANT,
                "days": 1.0,
                "day_type": "full_day",
                "start_half": False,
                "end_half": False,
                "reason": "TEST_iter20_compoff_no_grants_no_crash",
                "status": "pending",
                "applied_at": now_str,
                "applied_by_admin": False,
                "approved_by": None,
                "approval_date": None,
                "remarks": None,
                "approval_type": None,
                "medical_certificate": None,
                "certificate_uploaded_at": None,
            }
            result = db.leave_applications.insert_one(doc)
            _state["leave_h_id"] = str(result.inserted_id)
        finally:
            client.close()
        print(f"PASS: Pending Comp-Off leave inserted for no-grant scenario: id={_state['leave_h_id']}")

    def test_h2_approve_compoff_no_grants_returns_200(self, ah):
        """Approving Comp-Off leave with no grants available returns 200 (no 500 crash)."""
        leave_id = _state.get("leave_h_id")
        assert leave_id

        r = requests.put(
            f"{BASE_URL}/api/leaves/{leave_id}/approve",
            headers=ah,
            json={"action": "approve"},
        )
        assert r.status_code == 200, (
            f"CRASH: Approving Comp-Off with no grants should return 200, got {r.status_code}: {r.text[:400]}"
        )
        data = r.json()
        assert data.get("status") == "approved", f"Expected status='approved', got {data.get('status')}"
        print(f"PASS: No crash when approving Comp-Off with no grants — status={data['status']}")
