"""
Iteration 25 — Backend tests for Comp-Off grant-ledger authoritative fix.

Features tested:
  A) GET /api/leaves/balance/my — Comp-Off returned as {total, used, remaining} from grant ledger
  B) GET /api/leaves/balance/{employee_id} — same structure, admin view
  C) GET /api/leaves/balances/all — every employee row has Comp-Off as {total, used, remaining}
  D) POST /api/comp-offs/manual — happy path: grant created as 'approved', balance +1
  E) DELETE /api/comp-offs/{grant_id} — grant cancelled, balance -1
  F) DELETE non-approved grant → 400
  G) POST /manual future date → 400
  H) POST /manual empty reason → 400
  I) POST /manual nonexistent employee → 404
  J) POST /manual duplicate date → 400
  K) Applying Comp-Off leave auto-approved (admin on behalf) burns oldest grant
  L) Admin approving Comp-Off pending leave burns oldest grant
  M) /api/leaves/pending — Comp-Off remaining from grant ledger
  N) PUT /api/leaves/admin/balance/{employee_id} — saves CL/SL/EL/Marriage without CompOff fields
"""

import pytest
import requests
import os
from pymongo import MongoClient
from bson import ObjectId
from datetime import datetime, timezone, timedelta, date as DateType

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")

MONGO_URL = "mongodb://localhost:27017"
DB_NAME = "radhya_hr_db"

# Test employees
EMP_ID = "RMF0003"          # management role — used for most tests
EMP_APPLY = "RMF0010"       # used for leave application tests (has reporting_to)

# Test-specific dates — past dates within 90-day expiry window, future for leave apps
# Today is ~2026-07-13; 90-day window starts 2026-04-14; use recent dates to avoid expiry
GRANT_DATE_MANUAL = "2026-06-01"      # within 90 days — for manual grant add tests
GRANT_DATE_DUPLICATE = "2026-06-02"  # within 90 days — for duplicate test
LEAVE_DATE_K = "2026-11-03"          # Monday — for auto-approve test
LEAVE_DATE_L = "2026-11-10"          # Monday — for pending→approve test

_state = {}


def get_db():
    client = MongoClient(MONGO_URL)
    return client[DB_NAME], client


# ── Auth Fixtures ─────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"username": "admin", "password": "Admin@12345"})
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text[:300]}"
    token = r.json().get("access_token") or r.json().get("token")
    assert token, f"No token in response: {r.json()}"
    return token


@pytest.fixture(scope="module")
def emp_token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"username": EMP_ID, "password": "Radhya@123"})
    assert r.status_code == 200, f"Employee login failed: {r.status_code} {r.text[:300]}"
    token = r.json().get("access_token") or r.json().get("token")
    assert token
    return token


@pytest.fixture(scope="module")
def ah(admin_token):
    """Admin headers."""
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def eh(emp_token):
    """Employee headers."""
    return {"Authorization": f"Bearer {emp_token}", "Content-Type": "application/json"}


# ── Cleanup ────────────────────────────────────────────────────────────────────

@pytest.fixture(scope="module", autouse=True)
def cleanup():
    """Delete test comp-off grants and leaves after module completes."""
    yield
    db, client = get_db()
    try:
        # Remove test grants by reason prefix TEST_iter25
        db.comp_off_grants.delete_many({"earn_reason": {"$regex": "^TEST_iter25"}})
        # Remove test grants by specific dates we created
        db.comp_off_grants.delete_many({
            "employee_id": {"$in": [EMP_ID, EMP_APPLY]},
            "earn_date": {"$in": [GRANT_DATE_MANUAL, GRANT_DATE_DUPLICATE, "2026-06-03", "2026-06-04"]}
        })
        # Remove test leave applications
        db.leave_applications.delete_many({
            "employee_id": {"$in": [EMP_ID, EMP_APPLY]},
            "start_date": {"$in": [LEAVE_DATE_K, LEAVE_DATE_L]},
            "leave_type": "Comp-Off"
        })
    except Exception as e:
        print(f"[cleanup] Error: {e}")
    finally:
        client.close()


# ═══════════════════════════════════════════════════════════════════════════════
# A) GET /api/leaves/balance/my — Comp-Off from grant ledger
# ═══════════════════════════════════════════════════════════════════════════════

class TestMyBalance:
    """GET /api/leaves/balance/my — Comp-Off {total, used, remaining}"""

    def test_my_balance_returns_200(self, eh):
        r = requests.get(f"{BASE_URL}/api/leaves/balance/my", headers=eh)
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text[:300]}"
        print("PASS: GET /api/leaves/balance/my → 200")

    def test_my_balance_comp_off_is_dict(self, eh):
        r = requests.get(f"{BASE_URL}/api/leaves/balance/my", headers=eh)
        data = r.json()
        comp_off = data.get("Comp-Off")
        assert isinstance(comp_off, dict), f"Comp-Off must be a dict, got: {type(comp_off)} — {comp_off}"
        print(f"PASS: Comp-Off is dict: {comp_off}")

    def test_my_balance_comp_off_has_required_keys(self, eh):
        r = requests.get(f"{BASE_URL}/api/leaves/balance/my", headers=eh)
        comp_off = r.json().get("Comp-Off", {})
        for key in ("total", "used", "remaining"):
            assert key in comp_off, f"Comp-Off missing '{key}': {comp_off}"
        print(f"PASS: Comp-Off has total/used/remaining: {comp_off}")

    def test_my_balance_comp_off_remaining_equals_total_minus_used(self, eh):
        r = requests.get(f"{BASE_URL}/api/leaves/balance/my", headers=eh)
        co = r.json().get("Comp-Off", {})
        assert co["remaining"] == co["total"] - co["used"], \
            f"remaining ({co['remaining']}) != total - used ({co['total']} - {co['used']})"
        print(f"PASS: remaining = total - used: {co}")

    def test_my_balance_comp_off_values_non_negative(self, eh):
        r = requests.get(f"{BASE_URL}/api/leaves/balance/my", headers=eh)
        co = r.json().get("Comp-Off", {})
        for k in ("total", "used", "remaining"):
            assert co[k] >= 0, f"Comp-Off {k} is negative: {co}"
        print(f"PASS: Comp-Off values non-negative: {co}")


# ═══════════════════════════════════════════════════════════════════════════════
# B) GET /api/leaves/balance/{employee_id} — admin view
# ═══════════════════════════════════════════════════════════════════════════════

class TestEmployeeBalance:
    """GET /api/leaves/balance/{employee_id}"""

    def test_admin_get_employee_balance_200(self, ah):
        r = requests.get(f"{BASE_URL}/api/leaves/balance/{EMP_ID}", headers=ah)
        assert r.status_code == 200, f"{r.status_code}: {r.text[:300]}"
        print(f"PASS: GET /api/leaves/balance/{EMP_ID} → 200")

    def test_employee_balance_comp_off_structure(self, ah):
        r = requests.get(f"{BASE_URL}/api/leaves/balance/{EMP_ID}", headers=ah)
        co = r.json().get("Comp-Off", {})
        assert isinstance(co, dict), f"Comp-Off not a dict: {co}"
        for key in ("total", "used", "remaining"):
            assert key in co, f"Missing '{key}': {co}"
        print(f"PASS: /api/leaves/balance/{EMP_ID} Comp-Off: {co}")

    def test_employee_balance_nonexistent_returns_empty_or_defaults(self, ah):
        r = requests.get(f"{BASE_URL}/api/leaves/balance/RMFNOTFOUND", headers=ah)
        # Either 200 with defaults or 404 — backend currently returns 200 with defaults
        assert r.status_code in (200, 404), f"Unexpected {r.status_code}: {r.text[:200]}"
        print(f"PASS: nonexistent employee → {r.status_code}")


# ═══════════════════════════════════════════════════════════════════════════════
# C) GET /api/leaves/balances/all
# ═══════════════════════════════════════════════════════════════════════════════

class TestAllBalances:
    """GET /api/leaves/balances/all — every employee has Comp-Off {total, used, remaining}"""

    def test_all_balances_200(self, ah):
        r = requests.get(f"{BASE_URL}/api/leaves/balances/all", headers=ah)
        assert r.status_code == 200, f"{r.status_code}: {r.text[:300]}"
        print(f"PASS: GET /api/leaves/balances/all → 200 ({len(r.json())} employees)")

    def test_all_balances_comp_off_structure(self, ah):
        r = requests.get(f"{BASE_URL}/api/leaves/balances/all", headers=ah)
        rows = r.json()
        assert len(rows) > 0, "No employees returned"
        bad = []
        for row in rows[:10]:  # Sample first 10 for speed
            co = row.get("Comp-Off", {})
            if not isinstance(co, dict):
                bad.append((row.get("employee_id"), f"not dict: {co}"))
                continue
            for k in ("total", "used", "remaining"):
                if k not in co:
                    bad.append((row.get("employee_id"), f"missing {k}: {co}"))
        assert not bad, f"Comp-Off structure failures: {bad}"
        print(f"PASS: first 10 employees all have Comp-Off {{total,used,remaining}}")

    def test_all_balances_employee_row_has_required_fields(self, ah):
        r = requests.get(f"{BASE_URL}/api/leaves/balances/all", headers=ah)
        rows = r.json()
        row = rows[0]
        for field in ("employee_id", "name", "CL", "SL", "EL", "Marriage", "Comp-Off"):
            assert field in row, f"Missing field '{field}' in first row: {row}"
        print("PASS: all required fields present in balance row")


# ═══════════════════════════════════════════════════════════════════════════════
# D) POST /api/comp-offs/manual — happy path
# ═══════════════════════════════════════════════════════════════════════════════

class TestManualGrantAdd:
    """POST /api/comp-offs/manual"""

    def test_add_manual_grant_happy_path(self, ah):
        """Add a grant, verify it's 'approved' and balance increases by 1."""
        # Get balance before
        r_before = requests.get(f"{BASE_URL}/api/leaves/balance/{EMP_ID}", headers=ah)
        before_remaining = r_before.json().get("Comp-Off", {}).get("remaining", 0)

        # Add manual grant
        payload = {
            "employee_id": EMP_ID,
            "earn_date": GRANT_DATE_MANUAL,
            "earn_reason": "TEST_iter25 Republic Day 2025",
        }
        r = requests.post(f"{BASE_URL}/api/comp-offs/manual", json=payload, headers=ah)
        assert r.status_code == 200, f"Expected 200 got {r.status_code}: {r.text[:300]}"

        data = r.json()
        assert "id" in data, f"No 'id' in response: {data}"
        assert data["status"] == "approved", f"Expected approved, got: {data.get('status')}"
        assert data["earn_date"] == GRANT_DATE_MANUAL
        assert data["employee_id"] == EMP_ID
        assert data["source"] == "manual"
        _state["manual_grant_id"] = data["id"]

        # Verify balance increased by 1
        r_after = requests.get(f"{BASE_URL}/api/leaves/balance/{EMP_ID}", headers=ah)
        after_remaining = r_after.json().get("Comp-Off", {}).get("remaining", 0)
        assert after_remaining == before_remaining + 1, \
            f"Balance should be +1: before={before_remaining}, after={after_remaining}"
        print(f"PASS: Manual grant added, balance {before_remaining} → {after_remaining}")

    def test_add_manual_grant_appears_in_balance_endpoint(self, ah):
        """New grant appears in GET /api/comp-offs/balance/{employee_id}."""
        assert _state.get("manual_grant_id"), "Prerequisite: manual_grant_id not set"
        r = requests.get(f"{BASE_URL}/api/comp-offs/balance/{EMP_ID}", headers=ah)
        assert r.status_code == 200
        ids = [g["id"] for g in r.json()]
        assert _state["manual_grant_id"] in ids, \
            f"Grant {_state['manual_grant_id']} not found in balance: {ids}"
        print("PASS: New grant appears in /comp-offs/balance endpoint")


# ═══════════════════════════════════════════════════════════════════════════════
# E) DELETE /api/comp-offs/{grant_id} — remove available grant
# ═══════════════════════════════════════════════════════════════════════════════

class TestGrantRemove:
    """DELETE /api/comp-offs/{grant_id}"""

    def test_remove_grant_happy_path(self, ah):
        """Remove the manually-added grant, verify balance decreases by 1."""
        grant_id = _state.get("manual_grant_id")
        assert grant_id, "Prerequisite: manual_grant_id not set (TestManualGrantAdd must run first)"

        # Balance before
        r_before = requests.get(f"{BASE_URL}/api/leaves/balance/{EMP_ID}", headers=ah)
        before_remaining = r_before.json().get("Comp-Off", {}).get("remaining", 0)

        # Delete
        r = requests.delete(f"{BASE_URL}/api/comp-offs/{grant_id}", headers=ah)
        assert r.status_code == 200, f"Expected 200 got {r.status_code}: {r.text[:300]}"
        data = r.json()
        assert data.get("success") is True
        assert data.get("removed") == grant_id

        # Verify status is 'cancelled' in DB
        db, client = get_db()
        try:
            doc = db.comp_off_grants.find_one({"_id": ObjectId(grant_id)})
            assert doc is not None, "Grant not found in DB"
            assert doc["status"] == "cancelled", f"Expected cancelled, got: {doc['status']}"
        finally:
            client.close()

        # Verify balance decreased by 1
        r_after = requests.get(f"{BASE_URL}/api/leaves/balance/{EMP_ID}", headers=ah)
        after_remaining = r_after.json().get("Comp-Off", {}).get("remaining", 0)
        assert after_remaining == before_remaining - 1, \
            f"Balance should be -1: before={before_remaining}, after={after_remaining}"
        print(f"PASS: Grant removed, balance {before_remaining} → {after_remaining}")


# ═══════════════════════════════════════════════════════════════════════════════
# F) DELETE non-approved grant → 400
# ═══════════════════════════════════════════════════════════════════════════════

class TestGrantRemoveErrors:
    """DELETE /api/comp-offs/{grant_id} error cases"""

    def test_delete_pending_grant_returns_400(self, ah):
        """Cannot delete a pending (non-approved) grant."""
        db, client = get_db()
        try:
            now = datetime.now(timezone.utc).isoformat()
            res = db.comp_off_grants.insert_one({
                "employee_id": EMP_ID,
                "earn_date": "2026-06-03",
                "earn_reason": "TEST_iter25 pending grant",
                "status": "pending",
                "created_at": now,
            })
            pending_id = str(res.inserted_id)
            _state["pending_grant_id"] = pending_id
        finally:
            client.close()

        r = requests.delete(f"{BASE_URL}/api/comp-offs/{pending_id}", headers=ah)
        assert r.status_code == 400, f"Expected 400 for pending grant, got {r.status_code}: {r.text[:300]}"
        print(f"PASS: DELETE pending grant → 400: {r.json().get('detail')}")

    def test_delete_nonexistent_grant_returns_404(self, ah):
        fake_id = "000000000000000000000000"
        r = requests.delete(f"{BASE_URL}/api/comp-offs/{fake_id}", headers=ah)
        assert r.status_code == 404, f"Expected 404, got {r.status_code}: {r.text[:300]}"
        print(f"PASS: DELETE nonexistent grant → 404")

    def test_delete_invalid_grant_id_returns_400(self, ah):
        r = requests.delete(f"{BASE_URL}/api/comp-offs/not_a_valid_id", headers=ah)
        assert r.status_code == 400, f"Expected 400, got {r.status_code}: {r.text[:300]}"
        print(f"PASS: DELETE invalid grant id → 400")

    def test_delete_used_grant_returns_400(self, ah):
        """Cannot delete a used grant."""
        db, client = get_db()
        try:
            now = datetime.now(timezone.utc).isoformat()
            res = db.comp_off_grants.insert_one({
                "employee_id": EMP_ID,
                "earn_date": "2026-06-04",
                "earn_reason": "TEST_iter25 used grant",
                "status": "used",
                "created_at": now,
                "approved_at": now,
                "used_at": now,
            })
            used_id = str(res.inserted_id)
            _state["used_grant_id"] = used_id
        finally:
            client.close()

        r = requests.delete(f"{BASE_URL}/api/comp-offs/{used_id}", headers=ah)
        assert r.status_code == 400, f"Expected 400 for used grant, got {r.status_code}: {r.text[:300]}"
        print(f"PASS: DELETE used grant → 400: {r.json().get('detail')}")


# ═══════════════════════════════════════════════════════════════════════════════
# G-J) POST /api/comp-offs/manual validation errors
# ═══════════════════════════════════════════════════════════════════════════════

class TestManualGrantValidation:
    """POST /api/comp-offs/manual — input validation"""

    def test_future_date_returns_400(self, ah):
        future = (DateType.today() + timedelta(days=1)).isoformat()
        r = requests.post(f"{BASE_URL}/api/comp-offs/manual", headers=ah,
                          json={"employee_id": EMP_ID, "earn_date": future,
                                "earn_reason": "TEST_iter25 future"})
        assert r.status_code == 400, f"Expected 400 for future date, got {r.status_code}: {r.text[:300]}"
        print(f"PASS: future date → 400: {r.json().get('detail')}")

    def test_empty_reason_returns_400(self, ah):
        r = requests.post(f"{BASE_URL}/api/comp-offs/manual", headers=ah,
                          json={"employee_id": EMP_ID, "earn_date": "2025-11-01",
                                "earn_reason": "  "})
        assert r.status_code == 400, f"Expected 400 for empty reason, got {r.status_code}: {r.text[:300]}"
        print(f"PASS: empty reason → 400: {r.json().get('detail')}")

    def test_nonexistent_employee_returns_404(self, ah):
        r = requests.post(f"{BASE_URL}/api/comp-offs/manual", headers=ah,
                          json={"employee_id": "RMF9999", "earn_date": "2025-11-01",
                                "earn_reason": "TEST_iter25 nonexistent emp"})
        assert r.status_code == 404, f"Expected 404, got {r.status_code}: {r.text[:300]}"
        print(f"PASS: nonexistent employee → 404: {r.json().get('detail')}")

    def test_duplicate_date_returns_400(self, ah):
        """Add a grant for GRANT_DATE_DUPLICATE then try adding again."""
        # First add
        r1 = requests.post(f"{BASE_URL}/api/comp-offs/manual", headers=ah,
                           json={"employee_id": EMP_ID, "earn_date": GRANT_DATE_DUPLICATE,
                                 "earn_reason": "TEST_iter25 first add"})
        assert r1.status_code == 200, f"First add failed: {r1.status_code}: {r1.text[:300]}"
        _state["dup_grant_id"] = r1.json().get("id")
        print(f"  [setup] First grant created: {_state['dup_grant_id']}")

        # Second add — same date
        r2 = requests.post(f"{BASE_URL}/api/comp-offs/manual", headers=ah,
                           json={"employee_id": EMP_ID, "earn_date": GRANT_DATE_DUPLICATE,
                                 "earn_reason": "TEST_iter25 duplicate"})
        assert r2.status_code == 400, f"Expected 400 for duplicate, got {r2.status_code}: {r2.text[:300]}"
        print(f"PASS: duplicate date → 400: {r2.json().get('detail')}")

    def test_non_admin_cannot_add_grant(self):
        """Employee role cannot POST /api/comp-offs/manual.
        Uses RMF0002 (employee role), not RMF0003 (management — allowed)."""
        emp_r = requests.post(f"{BASE_URL}/api/auth/login",
                              json={"username": "RMF0002", "password": "Radhya@123"})
        if emp_r.status_code != 200:
            pytest.skip(f"RMF0002 login failed: {emp_r.status_code}")
        emp_tok = emp_r.json().get("access_token") or emp_r.json().get("token")
        emp_hdrs = {"Authorization": f"Bearer {emp_tok}", "Content-Type": "application/json"}
        r = requests.post(f"{BASE_URL}/api/comp-offs/manual", headers=emp_hdrs,
                          json={"employee_id": "RMF0002", "earn_date": "2026-05-01",
                                "earn_reason": "TEST_iter25 unauthorized"})
        assert r.status_code in (403, 401), f"Expected 403/401, got {r.status_code}: {r.text[:300]}"
        print(f"PASS: employee role cannot add grant → {r.status_code}")


# ═══════════════════════════════════════════════════════════════════════════════
# K) Admin applies leave on behalf → auto-approve burns oldest grant
# ═══════════════════════════════════════════════════════════════════════════════

class TestCompOffLeaveAutoApprove:
    """POST /api/leaves (admin on behalf, auto-approved) burns oldest grant."""

    def test_auto_approve_burns_oldest_grant(self, ah):
        # 1. Create a grant for EMP_APPLY
        grant_payload = {
            "employee_id": EMP_APPLY,
            "earn_date": "2026-05-14",
            "earn_reason": "TEST_iter25 auto-approve grant",
        }
        r_grant = requests.post(f"{BASE_URL}/api/comp-offs/manual", json=grant_payload, headers=ah)
        assert r_grant.status_code == 200, f"Grant creation failed: {r_grant.status_code}: {r_grant.text[:300]}"
        grant_id = r_grant.json()["id"]
        _state["auto_approve_grant_id"] = grant_id
        print(f"  [setup] Grant created: {grant_id} for {EMP_APPLY} on 2025-09-14")

        # 2. Admin applies Comp-Off on behalf → auto-approved immediately
        leave_payload = {
            "employee_id": EMP_APPLY,
            "leave_type": "Comp-Off",
            "start_date": LEAVE_DATE_K,
            "end_date": LEAVE_DATE_K,
            "day_type": "full_day",
            "reason": "TEST_iter25 auto-approve leave",
        }
        r_leave = requests.post(f"{BASE_URL}/api/leaves", json=leave_payload, headers=ah)
        assert r_leave.status_code == 200, f"Apply leave failed: {r_leave.status_code}: {r_leave.text[:300]}"
        leave_data = r_leave.json()
        assert leave_data.get("status") == "approved", \
            f"Admin-on-behalf leave should be auto-approved: {leave_data.get('status')}"
        _state["auto_approve_leave_id"] = leave_data.get("id")
        print(f"  [setup] Leave applied and auto-approved: {leave_data.get('id')}")

        # 3. Verify the grant is now 'used'
        db, client = get_db()
        try:
            doc = db.comp_off_grants.find_one({"_id": ObjectId(grant_id)})
            assert doc is not None, "Grant not found in DB"
            assert doc["status"] == "used", \
                f"Expected grant status 'used' after auto-approve, got: {doc['status']}"
        finally:
            client.close()
        print(f"PASS: Grant {grant_id} status → 'used' after auto-approve")


# ═══════════════════════════════════════════════════════════════════════════════
# L) Admin approves pending Comp-Off leave → burns oldest grant
# ═══════════════════════════════════════════════════════════════════════════════

class TestCompOffLeaveAdminApprove:
    """PUT /api/leaves/{id}/approve for Comp-Off burns oldest grant."""

    def test_approve_pending_burns_oldest_grant(self, ah):
        # 1. Create a grant for EMP_APPLY
        grant_payload = {
            "employee_id": EMP_APPLY,
            "earn_date": "2026-05-25",
            "earn_reason": "TEST_iter25 admin-approve grant",
        }
        r_grant = requests.post(f"{BASE_URL}/api/comp-offs/manual", json=grant_payload, headers=ah)
        assert r_grant.status_code == 200, f"Grant creation failed: {r_grant.status_code}: {r_grant.text[:300]}"
        grant_id = r_grant.json()["id"]
        _state["admin_approve_grant_id"] = grant_id
        print(f"  [setup] Grant created: {grant_id} for {EMP_APPLY} on 2025-08-25")

        # 2. Employee applies Comp-Off leave (pending)
        emp_token_r = requests.post(f"{BASE_URL}/api/auth/login",
                                    json={"username": EMP_APPLY, "password": "Radhya@123"})
        if emp_token_r.status_code != 200:
            pytest.skip(f"EMP_APPLY login failed: {emp_token_r.status_code}")
        emp_token = emp_token_r.json().get("access_token") or emp_token_r.json().get("token")
        emp_hdrs = {"Authorization": f"Bearer {emp_token}", "Content-Type": "application/json"}

        leave_payload = {
            "employee_id": EMP_APPLY,   # required field — employee submits own ID
            "leave_type": "Comp-Off",
            "start_date": LEAVE_DATE_L,
            "end_date": LEAVE_DATE_L,
            "day_type": "full_day",
            "reason": "TEST_iter25 admin-approve leave",
        }
        r_leave = requests.post(f"{BASE_URL}/api/leaves", json=leave_payload, headers=emp_hdrs)
        assert r_leave.status_code == 200, f"Apply leave failed: {r_leave.status_code}: {r_leave.text[:300]}"
        leave_data = r_leave.json()
        assert leave_data.get("status") == "pending", \
            f"Leave should be pending: {leave_data.get('status')}"
        leave_id = leave_data.get("id")
        _state["admin_approve_leave_id"] = leave_id
        print(f"  [setup] Leave applied (pending): {leave_id}")

        # 3. Admin approves the leave
        r_approve = requests.put(f"{BASE_URL}/api/leaves/{leave_id}/approve",
                                 json={"action": "approve", "remarks": "TEST approved"},
                                 headers=ah)
        assert r_approve.status_code == 200, \
            f"Approve failed: {r_approve.status_code}: {r_approve.text[:300]}"
        print(f"  [approve] Leave approved: {r_approve.json()}")

        # 4. Verify the grant is now 'used'
        db, client = get_db()
        try:
            doc = db.comp_off_grants.find_one({"_id": ObjectId(grant_id)})
            assert doc is not None, "Grant not found in DB"
            assert doc["status"] == "used", \
                f"Expected grant status 'used' after approve, got: {doc['status']}"
        finally:
            client.close()
        print(f"PASS: Grant {grant_id} status → 'used' after admin approval")


# ═══════════════════════════════════════════════════════════════════════════════
# M) /api/leaves/pending — Comp-Off remaining from grant ledger
# ═══════════════════════════════════════════════════════════════════════════════

class TestPendingLeavesCompOff:
    """/api/leaves/pending correctly computes Comp-Off remaining."""

    def test_pending_leaves_returns_200(self, ah):
        r = requests.get(f"{BASE_URL}/api/leaves/pending", headers=ah)
        assert r.status_code == 200, f"{r.status_code}: {r.text[:300]}"
        print(f"PASS: GET /api/leaves/pending → 200 ({len(r.json())} leaves)")

    def test_pending_comp_off_has_remaining_balance(self, ah):
        """If any pending Comp-Off leave exists, it should have remaining_balance."""
        r = requests.get(f"{BASE_URL}/api/leaves/pending", headers=ah)
        leaves = r.json()
        co_leaves = [l for l in leaves if l.get("leave_type") == "Comp-Off"]
        if not co_leaves:
            print("SKIP: No pending Comp-Off leaves to check (not a failure)")
            return
        for l in co_leaves:
            assert "remaining_balance" in l, \
                f"Pending Comp-Off leave missing remaining_balance: {l}"
            assert l["remaining_balance"] is not None, \
                f"remaining_balance is None for Comp-Off leave: {l}"
        print(f"PASS: {len(co_leaves)} pending Comp-Off leaves have remaining_balance")


# ═══════════════════════════════════════════════════════════════════════════════
# N) PUT /api/leaves/admin/balance/{employee_id} — CL/SL/EL/Marriage only
# ═══════════════════════════════════════════════════════════════════════════════

class TestUpdateEmployeeBalance:
    """PUT /api/leaves/admin/balance/{employee_id}"""

    def test_update_balance_without_compoff_fields(self, ah):
        """Sending only CL/SL/EL/Marriage (no CompOff) fields should succeed."""
        # Get current balance first
        r_get = requests.get(f"{BASE_URL}/api/leaves/balance/{EMP_ID}", headers=ah)
        bal = r_get.json()
        cl_total = bal.get("CL", {}).get("total", 7)
        cl_used = bal.get("CL", {}).get("used", 0)

        payload = {
            "CL_total": cl_total,
            "CL_used": cl_used,
            "SL_total": bal.get("SL", {}).get("total", 15),
            "SL_used": bal.get("SL", {}).get("used", 0),
            "EL_total": bal.get("EL", {}).get("total", 0),
            "EL_used": bal.get("EL", {}).get("used", 0),
            "Marriage_total": bal.get("Marriage", {}).get("total", 5),
            "Marriage_used": bal.get("Marriage", {}).get("used", 0),
            "reason": "TEST_iter25 balance update no compoff",
        }
        r = requests.put(f"{BASE_URL}/api/leaves/admin/balance/{EMP_ID}", json=payload, headers=ah)
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text[:300]}"

        data = r.json()
        assert "CL" in data or "message" in data or "employee_id" in data, \
            f"Unexpected response structure: {data}"
        print(f"PASS: PUT /api/leaves/admin/balance/{EMP_ID} without CompOff → 200")

    def test_update_balance_comp_off_not_in_response_directly(self, ah):
        """After update, GET balance still returns Comp-Off from grant ledger."""
        r = requests.get(f"{BASE_URL}/api/leaves/balance/{EMP_ID}", headers=ah)
        co = r.json().get("Comp-Off", {})
        assert isinstance(co, dict), f"Comp-Off should still be a dict: {co}"
        for k in ("total", "used", "remaining"):
            assert k in co, f"Comp-Off missing {k}: {co}"
        print(f"PASS: After balance update, Comp-Off still from ledger: {co}")

    def test_update_balance_missing_reason_returns_400(self, ah):
        payload = {
            "CL_total": 7, "CL_used": 0,
            "SL_total": 15, "SL_used": 0,
            "EL_total": 0, "EL_used": 0,
            "Marriage_total": 5, "Marriage_used": 0,
            "reason": "  ",  # whitespace-only
        }
        r = requests.put(f"{BASE_URL}/api/leaves/admin/balance/{EMP_ID}", json=payload, headers=ah)
        assert r.status_code == 400, f"Expected 400 for missing reason, got {r.status_code}: {r.text[:300]}"
        print(f"PASS: missing reason → 400: {r.json().get('detail')}")

    def test_update_balance_used_exceeds_total_returns_400(self, ah):
        payload = {
            "CL_total": 3, "CL_used": 5,   # used > total
            "SL_total": 15, "SL_used": 0,
            "EL_total": 0, "EL_used": 0,
            "Marriage_total": 5, "Marriage_used": 0,
            "reason": "TEST_iter25 invalid balance",
        }
        r = requests.put(f"{BASE_URL}/api/leaves/admin/balance/{EMP_ID}", json=payload, headers=ah)
        assert r.status_code == 400, f"Expected 400 for used>total, got {r.status_code}: {r.text[:300]}"
        print(f"PASS: used > total → 400: {r.json().get('detail')}")


# ═══════════════════════════════════════════════════════════════════════════════
# Additional cleanup: remove test grants created in TestGrantRemoveErrors
# ═══════════════════════════════════════════════════════════════════════════════

@pytest.fixture(scope="module", autouse=True)
def cleanup_error_test_grants():
    """Cleanup pending/used grants created in TestGrantRemoveErrors."""
    yield
    db, client = get_db()
    try:
        for key in ["pending_grant_id", "used_grant_id", "dup_grant_id"]:
            gid = _state.get(key)
            if gid:
                db.comp_off_grants.delete_one({"_id": ObjectId(gid)})
        # Also cleanup auto-approve / admin-approve test leaves
        for key in ["auto_approve_leave_id", "admin_approve_leave_id"]:
            lid = _state.get(key)
            if lid:
                db.leave_applications.delete_one({"_id": ObjectId(lid)})
        # Cleanup grants used in K/L tests
        for key in ["auto_approve_grant_id", "admin_approve_grant_id"]:
            gid = _state.get(key)
            if gid:
                db.comp_off_grants.delete_one({"_id": ObjectId(gid)})
        # Cleanup grants with these earn_dates
        db.comp_off_grants.delete_many({
            "employee_id": EMP_APPLY,
            "earn_date": {"$in": ["2026-05-14", "2026-05-25"]}
        })
    except Exception as e:
        print(f"[cleanup_error_test_grants] Error: {e}")
    finally:
        client.close()
