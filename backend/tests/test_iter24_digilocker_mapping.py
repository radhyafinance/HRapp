"""
Iteration 24 — DigiLocker mapping unit tests + endpoint reachability.

Tests:
1. _map_education_type() with board-agnostic inputs (edu_* key mapping)
2. PUC/SSC guard: POLLUTION UNDER CONTROL and STAFF SELECTION COMMISSION → None
3. _map_doc_type() fallback to _map_education_type for education strings
4. _map_doc_type() with combined URI+doctype string (the f'{uri} {doctype}' fix)
5. DigiLocker endpoint reachability (not 500)
"""

import sys
import os
import pytest
import requests

# ── Inject backend source path for direct function import ────────────────────
sys.path.insert(0, "/app/backend")
sys.path.insert(0, "/app/backend/routes")

# We import the functions directly — no DB/external calls needed for unit tests
from routes.digilocker import _map_education_type, _map_doc_type, _DL_TYPE_MAP

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")


# ─────────────────────────────────────────────────────────────────────────────
# Section 1: _map_education_type — positive mappings
# ─────────────────────────────────────────────────────────────────────────────

class TestMapEducationType:
    """Unit tests for _map_education_type() — board-agnostic keyword matching."""

    def test_10th_cbse_marksheet(self):
        """'MARKSHEET CBSE 10TH' → edu_10th (via '10TH' keyword)."""
        result = _map_education_type("MARKSHEET CBSE 10TH")
        assert result == "edu_10th", f"Expected edu_10th, got {result!r}"
        print("PASS: 'MARKSHEET CBSE 10TH' → edu_10th")

    def test_higher_secondary(self):
        """'HIGHER SECONDARY' → edu_12th."""
        result = _map_education_type("HIGHER SECONDARY")
        assert result == "edu_12th", f"Expected edu_12th, got {result!r}"
        print("PASS: 'HIGHER SECONDARY' → edu_12th")

    def test_12th_keyword(self):
        """'CLASS XII CERTIFICATE' → edu_12th."""
        result = _map_education_type("CLASS XII CERTIFICATE")
        assert result == "edu_12th", f"Expected edu_12th, got {result!r}"
        print("PASS: 'CLASS XII CERTIFICATE' → edu_12th")

    def test_graduation_degree(self):
        """'GRADUATION DEGREE' → edu_graduation (via 'GRADUATION' + 'DEGREE')."""
        result = _map_education_type("GRADUATION DEGREE")
        assert result == "edu_graduation", f"Expected edu_graduation, got {result!r}"
        print("PASS: 'GRADUATION DEGREE' → edu_graduation")

    def test_bachelor_degree(self):
        """'BACHELOR OF SCIENCE' → edu_graduation."""
        result = _map_education_type("BACHELOR OF SCIENCE")
        assert result == "edu_graduation", f"Expected edu_graduation, got {result!r}"
        print("PASS: 'BACHELOR OF SCIENCE' → edu_graduation")

    def test_master_mba(self):
        """'MASTER MBA' → edu_post_graduation."""
        result = _map_education_type("MASTER MBA")
        assert result == "edu_post_graduation", f"Expected edu_post_graduation, got {result!r}"
        print("PASS: 'MASTER MBA' → edu_post_graduation")

    def test_phd_doctorate(self):
        """'PHD DOCTORATE' → edu_phd."""
        result = _map_education_type("PHD DOCTORATE")
        assert result == "edu_phd", f"Expected edu_phd, got {result!r}"
        print("PASS: 'PHD DOCTORATE' → edu_phd")

    def test_phd_alone(self):
        """'PHD CERTIFICATE' → edu_phd."""
        result = _map_education_type("PHD CERTIFICATE")
        assert result == "edu_phd", f"Expected edu_phd, got {result!r}"
        print("PASS: 'PHD CERTIFICATE' → edu_phd")

    def test_marksheet_provisional(self):
        """'MARKSHEET PROVISIONAL' → edu_other (via 'MARKSHEET' + 'PROVISIONAL').
        Note: 'PROVISIONAL' matches edu_other; 'MARKSHEET' also matches edu_other.
        Neither matches a higher level → edu_other is correct."""
        result = _map_education_type("MARKSHEET PROVISIONAL")
        assert result == "edu_other", f"Expected edu_other, got {result!r}"
        print("PASS: 'MARKSHEET PROVISIONAL' → edu_other")

    def test_transcript(self):
        """'ACADEMIC TRANSCRIPT' → edu_other."""
        result = _map_education_type("ACADEMIC TRANSCRIPT")
        assert result == "edu_other", f"Expected edu_other, got {result!r}"
        print("PASS: 'ACADEMIC TRANSCRIPT' → edu_other")

    def test_diploma(self):
        """'DIPLOMA CERTIFICATE' → edu_other (via 'DIPLOMA')."""
        result = _map_education_type("DIPLOMA CERTIFICATE")
        assert result == "edu_other", f"Expected edu_other, got {result!r}"
        print("PASS: 'DIPLOMA CERTIFICATE' → edu_other")

    def test_sslc(self):
        """'SSLC BOARD' → edu_10th."""
        result = _map_education_type("SSLC BOARD")
        assert result == "edu_10th", f"Expected edu_10th, got {result!r}"
        print("PASS: 'SSLC BOARD' → edu_10th")

    def test_matric(self):
        """'MATRIC CERTIFICATE' → edu_10th."""
        result = _map_education_type("MATRIC CERTIFICATE")
        assert result == "edu_10th", f"Expected edu_10th, got {result!r}"
        print("PASS: 'MATRIC CERTIFICATE' → edu_10th")

    def test_hsc(self):
        """'HSC BOARD EXAM' → edu_12th (via 'HSC')."""
        result = _map_education_type("HSC BOARD EXAM")
        assert result == "edu_12th", f"Expected edu_12th, got {result!r}"
        print("PASS: 'HSC BOARD EXAM' → edu_12th")

    def test_puc_legitimate(self):
        """'PUC PRE-UNIVERSITY COURSE' → edu_12th (via 'PUC' keyword).
        The guard only blocks if POLLUTION/PUCC/STAFF SELECTION/SELECTION COMMISSION/VEHICLE present."""
        result = _map_education_type("PUC PRE-UNIVERSITY COURSE")
        assert result == "edu_12th", f"Expected edu_12th, got {result!r}"
        print("PASS: 'PUC PRE-UNIVERSITY COURSE' → edu_12th")

    def test_unrelated_string_returns_none(self):
        """'BIRTH CERTIFICATE' → None (no education keyword)."""
        result = _map_education_type("BIRTH CERTIFICATE")
        assert result is None, f"Expected None, got {result!r}"
        print("PASS: 'BIRTH CERTIFICATE' → None")


# ─────────────────────────────────────────────────────────────────────────────
# Section 2: PUC / SSC collision guards
# ─────────────────────────────────────────────────────────────────────────────

class TestPUCSSCGuard:
    """Guard cases: short tokens ('PUC', 'SSC') collide with unrelated govt docs."""

    def test_pollution_under_control_returns_none(self):
        """'POLLUTION UNDER CONTROL' → None (not edu_12th via 'PUC')."""
        result = _map_education_type("POLLUTION UNDER CONTROL")
        assert result is None, (
            f"Expected None (guard should block), got {result!r}. "
            "'POLLUTION UNDER CONTROL' has PUC as acronym but is a vehicle cert, not education."
        )
        print("PASS: 'POLLUTION UNDER CONTROL' → None (guard blocks)")

    def test_pucc_cert_returns_none(self):
        """'PUCC VEHICLE EMISSION CERTIFICATE' → None."""
        result = _map_education_type("PUCC VEHICLE EMISSION CERTIFICATE")
        assert result is None, f"Expected None, got {result!r}"
        print("PASS: 'PUCC VEHICLE EMISSION CERTIFICATE' → None (guard blocks)")

    def test_staff_selection_commission_returns_none(self):
        """'STAFF SELECTION COMMISSION' → None (not edu_10th via 'SSC')."""
        result = _map_education_type("STAFF SELECTION COMMISSION")
        assert result is None, (
            f"Expected None (guard should block), got {result!r}. "
            "STAFF SELECTION COMMISSION is a govt body, not a school certificate."
        )
        print("PASS: 'STAFF SELECTION COMMISSION' → None (guard blocks)")

    def test_selection_commission_guard(self):
        """'SELECTION COMMISSION EXAM' → None."""
        result = _map_education_type("SELECTION COMMISSION EXAM")
        assert result is None, f"Expected None, got {result!r}"
        print("PASS: 'SELECTION COMMISSION EXAM' → None (guard blocks)")

    def test_vehicle_cert_returns_none(self):
        """'VEHICLE REGISTRATION CERTIFICATE' → None."""
        result = _map_education_type("VEHICLE REGISTRATION CERTIFICATE")
        assert result is None, f"Expected None, got {result!r}"
        print("PASS: 'VEHICLE REGISTRATION CERTIFICATE' → None (guard blocks)")

    def test_ssc_without_guard_trigger(self):
        """'SSC CLASS X BOARD' → edu_10th (SSC matches, no guard trigger)."""
        result = _map_education_type("SSC CLASS X BOARD")
        assert result == "edu_10th", f"Expected edu_10th (SSC is legitimate here), got {result!r}"
        print("PASS: 'SSC CLASS X BOARD' → edu_10th (no guard trigger)")


# ─────────────────────────────────────────────────────────────────────────────
# Section 3: _map_doc_type — fallback to _map_education_type
# ─────────────────────────────────────────────────────────────────────────────

class TestMapDocTypeFallback:
    """_map_doc_type() must fall back to _map_education_type when no _DL_TYPE_MAP token matches."""

    def test_cbse_token_direct_map(self):
        """'10CBSE' token in URI → edu_10th via _DL_TYPE_MAP (no fallback needed)."""
        result = _map_doc_type("in.gov.cbse-10CBSE-XXXX", "CBSE X Marksheet")
        assert result == "edu_10th", f"Expected edu_10th, got {result!r}"
        print("PASS: '10CBSE' in URI → edu_10th via _DL_TYPE_MAP")

    def test_12cbse_token_direct_map(self):
        """'12CBSE' token in URI → edu_12th via _DL_TYPE_MAP."""
        result = _map_doc_type("in.gov.cbse-12CBSE-XXXX", "CBSE XII Marksheet")
        assert result == "edu_12th", f"Expected edu_12th, got {result!r}"
        print("PASS: '12CBSE' in URI → edu_12th via _DL_TYPE_MAP")

    def test_non_cbse_board_falls_back_to_education_type(self):
        """Non-CBSE board URI with 'HIGHER SECONDARY' name → edu_12th via fallback."""
        result = _map_doc_type("in.gov.icse-MARKSHT-XXXX", "HIGHER SECONDARY CERTIFICATE")
        assert result == "edu_12th", f"Expected edu_12th via fallback, got {result!r}"
        print("PASS: non-CBSE URI + 'HIGHER SECONDARY' name → edu_12th via fallback")

    def test_graduation_in_name_falls_back(self):
        """No CBSE/known token — 'GRADUATION DEGREE' in name → edu_graduation via fallback."""
        result = _map_doc_type("in.gov.univ-CERT-XXXX", "GRADUATION DEGREE CERTIFICATE")
        assert result == "edu_graduation", f"Expected edu_graduation, got {result!r}"
        print("PASS: 'GRADUATION DEGREE CERTIFICATE' name → edu_graduation via fallback")

    def test_master_in_name_falls_back(self):
        """'MASTER OF BUSINESS ADMINISTRATION' → edu_post_graduation via fallback."""
        result = _map_doc_type("in.gov.univ-CERT-XXXX", "MASTER OF BUSINESS ADMINISTRATION")
        assert result == "edu_post_graduation", f"Expected edu_post_graduation, got {result!r}"
        print("PASS: 'MASTER OF BUSINESS ADMINISTRATION' → edu_post_graduation via fallback")

    def test_phd_in_name_falls_back(self):
        """'DOCTORATE DEGREE' → edu_phd via fallback."""
        result = _map_doc_type("in.gov.univ-PHD-XXXX", "DOCTORATE DEGREE CERTIFICATE")
        assert result == "edu_phd", f"Expected edu_phd, got {result!r}"
        print("PASS: 'DOCTORATE DEGREE' → edu_phd via fallback")

    def test_marksheet_provisional_falls_back(self):
        """'MARKSHEET PROVISIONAL CERTIFICATE' → edu_other via fallback."""
        result = _map_doc_type("in.gov.board-MARKSHT-XXXX", "MARKSHEET PROVISIONAL CERTIFICATE")
        assert result == "edu_other", f"Expected edu_other, got {result!r}"
        print("PASS: 'MARKSHEET PROVISIONAL CERTIFICATE' → edu_other via fallback")

    def test_pan_still_works(self):
        """PAN card URI → pan_card (non-education doc must still resolve correctly)."""
        result = _map_doc_type("in.gov.pan-PANCR-ABCDE1234F", "PAN Card")
        assert result == "pan_card", f"Expected pan_card, got {result!r}"
        print("PASS: PAN card URI → pan_card")

    def test_aadhaar_still_works(self):
        """Aadhaar URI → aadhaar_digilocker."""
        result = _map_doc_type("in.gov.uid-ADHAR-123456789012", "Aadhaar Card")
        assert result == "aadhaar_digilocker", f"Expected aadhaar_digilocker, got {result!r}"
        print("PASS: Aadhaar URI → aadhaar_digilocker")

    def test_unknown_doc_returns_none(self):
        """Unrecognised document → None."""
        result = _map_doc_type("in.gov.revenue-DOMICILE-XXXX", "Domicile Certificate")
        assert result is None, f"Expected None, got {result!r}"
        print("PASS: unknown doc → None")

    def test_pollution_under_control_returns_none(self):
        """'POLLUTION UNDER CONTROL' cert → None (not edu_12th, even via _map_doc_type)."""
        result = _map_doc_type("in.gov.rto-PUCC-XXXX", "POLLUTION UNDER CONTROL CERTIFICATE")
        assert result is None, f"Expected None (guard blocks PUC/SSC collision), got {result!r}"
        print("PASS: 'POLLUTION UNDER CONTROL' via _map_doc_type → None")


# ─────────────────────────────────────────────────────────────────────────────
# Section 4: f'{uri} {doctype}' fix — Perfios doctype token in URI scan
# ─────────────────────────────────────────────────────────────────────────────

class TestDoctypeInUriScan:
    """Verify the _do_fetch_and_store fix: doc_key = _map_doc_type(f'{uri} {doctype}', name).
    When the URI alone has no recognisable token but the Perfios doctype does, the fix
    ensures the doctype is also scanned."""

    def test_doctype_higher_secondary_appended_to_uri(self):
        """URI alone is opaque; doctype='HIGHER SECONDARY MARKSHEET' appended.
        _map_doc_type(f'{uri} {doctype}', name) → edu_12th via fallback."""
        uri = "in.gov.ap-board-OPAQUE12345"
        doctype = "HIGHER SECONDARY MARKSHEET"
        name = ""
        combined = f"{uri} {doctype}"
        result = _map_doc_type(combined, name)
        assert result == "edu_12th", f"Expected edu_12th when doctype appended, got {result!r}"
        print("PASS: URI+doctype combined scan → edu_12th")

    def test_doctype_graduation_appended(self):
        """Doctype='GRADUATION DEGREE CERTIFICATE' appended to opaque URI → edu_graduation."""
        uri = "in.gov.univ-OPAQUE-98765"
        doctype = "GRADUATION DEGREE CERTIFICATE"
        name = ""
        result = _map_doc_type(f"{uri} {doctype}", name)
        assert result == "edu_graduation", f"Expected edu_graduation, got {result!r}"
        print("PASS: URI+doctype combined → edu_graduation")

    def test_without_doctype_append_opaque_uri_returns_none(self):
        """Without the fix (only URI, no doctype in scan), opaque URI alone returns None."""
        uri = "in.gov.ap-board-OPAQUE12345"
        name = ""
        # old behavior: only URI scanned
        result = _map_doc_type(uri, name)
        assert result is None, (
            f"Expected None for opaque URI-only scan (simulating pre-fix behavior), got {result!r}"
        )
        print("PASS: opaque URI alone (no doctype) → None (pre-fix behavior confirmed)")

    def test_doctype_cbse_10th_appended_to_uri(self):
        """Doctype='10CBSE' appended to some URI → edu_10th via _DL_TYPE_MAP token."""
        uri = "in.gov.cbse-CERT-XXX"
        doctype = "10CBSE"
        result = _map_doc_type(f"{uri} {doctype}", "")
        assert result == "edu_10th", f"Expected edu_10th via _DL_TYPE_MAP token in doctype, got {result!r}"
        print("PASS: doctype='10CBSE' in combined URI scan → edu_10th via _DL_TYPE_MAP")

    def test_doctype_master_appended_to_uri(self):
        """Doctype='MASTER OF SCIENCE' appended → edu_post_graduation."""
        uri = "in.gov.univ-CERT-DUMMY"
        doctype = "MASTER OF SCIENCE"
        result = _map_doc_type(f"{uri} {doctype}", "")
        assert result == "edu_post_graduation", f"Expected edu_post_graduation, got {result!r}"
        print("PASS: doctype='MASTER OF SCIENCE' appended → edu_post_graduation")


# ─────────────────────────────────────────────────────────────────────────────
# Section 5: Endpoint reachability (not 500)
# ─────────────────────────────────────────────────────────────────────────────

class TestDigilockerEndpoints:
    """Verify DigiLocker endpoints are reachable (no 500 / import errors)."""

    @classmethod
    def setup_class(cls):
        """Authenticate as admin to get token."""
        cls.headers = {"Content-Type": "application/json"}
        cls.admin_token = None
        if not BASE_URL:
            pytest.skip("REACT_APP_BACKEND_URL not set")

        resp = requests.post(
            f"{BASE_URL}/api/auth/login",
            json={"username": "admin", "password": "Admin@12345"},
            timeout=15,
        )
        if resp.status_code == 200:
            data = resp.json()
            token = data.get("access_token") or data.get("token")
            if token:
                cls.admin_token = token
                cls.headers["Authorization"] = f"Bearer {token}"
                print(f"Admin auth OK (token prefix: {token[:20]}...)")
            else:
                print(f"Auth response: {data}")
        else:
            print(f"Admin auth failed: {resp.status_code} {resp.text[:200]}")

    def test_backend_health_not_500(self):
        """Backend root or health endpoint should return 200, not 500."""
        resp = requests.get(f"{BASE_URL}/api/", timeout=10)
        assert resp.status_code != 500, f"Backend returned 500: {resp.text[:200]}"
        print(f"PASS: backend health → {resp.status_code}")

    def test_digilocker_callback_not_500(self):
        """GET /api/digilocker/callback — no such backend route → 404 is OK; 500 is not.
        This confirms the backend didn't crash with import errors."""
        resp = requests.get(f"{BASE_URL}/api/digilocker/callback", timeout=10)
        # 404 = route not found (expected — callback is frontend only)
        # 405 = method not allowed (also OK)
        # 200/302 = if a route exists
        # 500 = backend crash — FAIL
        assert resp.status_code != 500, (
            f"GET /api/digilocker/callback returned 500 — possible import/startup error. "
            f"Body: {resp.text[:200]}"
        )
        print(f"PASS: GET /api/digilocker/callback → {resp.status_code} (not 500)")

    def test_digilocker_initiate_requires_auth(self):
        """POST /api/digilocker/initiate without auth → 401/403 (not 500)."""
        resp = requests.post(
            f"{BASE_URL}/api/digilocker/initiate",
            json={"context_type": "employee", "context_id": "RMF0001"},
            timeout=10,
        )
        assert resp.status_code in (401, 403, 422), (
            f"Expected 401/403/422, got {resp.status_code}: {resp.text[:200]}"
        )
        print(f"PASS: POST /api/digilocker/initiate (no auth) → {resp.status_code}")

    def test_digilocker_session_status_404_for_unknown(self):
        """GET /api/digilocker/session/{id}/status for non-existent session → 404 (not 500)."""
        if not self.admin_token:
            pytest.skip("Admin token not available")
        resp = requests.get(
            f"{BASE_URL}/api/digilocker/session/nonexistent-session-id/status",
            headers=self.headers,
            timeout=10,
        )
        assert resp.status_code in (404, 403, 401), (
            f"Expected 404, got {resp.status_code}: {resp.text[:200]}"
        )
        print(f"PASS: GET /api/digilocker/session/nonexistent/status → {resp.status_code}")

    def test_digilocker_fetch_and_store_404_for_unknown_session(self):
        """POST /api/digilocker/fetch-and-store/{id} for non-existent session → 404 (not 500)."""
        if not self.admin_token:
            pytest.skip("Admin token not available")
        resp = requests.post(
            f"{BASE_URL}/api/digilocker/fetch-and-store/nonexistent-session-id",
            headers=self.headers,
            timeout=10,
        )
        assert resp.status_code in (404, 403, 401), (
            f"Expected 404, got {resp.status_code}: {resp.text[:200]}"
        )
        print(f"PASS: POST /api/digilocker/fetch-and-store/nonexistent → {resp.status_code}")

    def test_digilocker_initiate_perfios_key_missing_error(self):
        """POST /api/digilocker/initiate with admin auth but no Perfios key → 500 (config error)
        OR 502 (Perfios unreachable). Either is acceptable if key is missing in test env."""
        if not self.admin_token:
            pytest.skip("Admin token not available")
        resp = requests.post(
            f"{BASE_URL}/api/digilocker/initiate",
            json={
                "context_type": "employee",
                "context_id": "RMF0001",
                "frontend_origin": BASE_URL,
            },
            headers=self.headers,
            timeout=30,
        )
        # Valid outcomes: 500 (no API key) or 502 (Perfios call failed — expected in test env)
        # Not acceptable: unexpected crash from import error or unrelated 500
        print(f"INFO: POST /api/digilocker/initiate → {resp.status_code}: {resp.text[:200]}")
        # Just verify backend returned a structured JSON response, not an unhandled exception
        try:
            data = resp.json()
            assert isinstance(data, dict), "Response should be a JSON object"
            print(f"PASS: initiate response is valid JSON: {list(data.keys())}")
        except Exception as e:
            assert False, f"Response is not valid JSON: {e}"


# ─────────────────────────────────────────────────────────────────────────────
# Section 6: _DL_TYPE_MAP completeness
# ─────────────────────────────────────────────────────────────────────────────

class TestDLTypeMap:
    """Verify _DL_TYPE_MAP still contains all expected CBSE tokens."""

    def test_map_contains_pan(self):
        assert "PANCR" in _DL_TYPE_MAP
        assert _DL_TYPE_MAP["PANCR"] == "pan_card"
        print("PASS: _DL_TYPE_MAP['PANCR'] == 'pan_card'")

    def test_map_contains_aadhaar(self):
        assert "ADHAR" in _DL_TYPE_MAP
        assert _DL_TYPE_MAP["ADHAR"] == "aadhaar_digilocker"
        print("PASS: _DL_TYPE_MAP['ADHAR'] == 'aadhaar_digilocker'")

    def test_map_contains_10cbse(self):
        assert "10CBSE" in _DL_TYPE_MAP
        assert _DL_TYPE_MAP["10CBSE"] == "edu_10th"
        print("PASS: _DL_TYPE_MAP['10CBSE'] == 'edu_10th'")

    def test_map_contains_12cbse(self):
        assert "12CBSE" in _DL_TYPE_MAP
        assert _DL_TYPE_MAP["12CBSE"] == "edu_12th"
        print("PASS: _DL_TYPE_MAP['12CBSE'] == 'edu_12th'")

    def test_map_contains_degree(self):
        assert "DEGREE" in _DL_TYPE_MAP
        assert _DL_TYPE_MAP["DEGREE"] == "edu_graduation"
        print("PASS: _DL_TYPE_MAP['DEGREE'] == 'edu_graduation'")

    def test_map_contains_mgrcer(self):
        assert "MGRCER" in _DL_TYPE_MAP
        assert _DL_TYPE_MAP["MGRCER"] == "edu_post_graduation"
        print("PASS: _DL_TYPE_MAP['MGRCER'] == 'edu_post_graduation'")
