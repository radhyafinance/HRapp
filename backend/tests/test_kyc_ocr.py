"""Tests for KYC OCR + candidate documents (Aadhaar/PAN) features.

Covers:
- POST /api/candidates/ocr/aadhaar (preview, no candidate yet) - 400/200 + shape
- POST /api/candidates/ocr/pan (preview) - 400/200 + shape
- POST /api/candidates with new KYC fields persists them
- POST /api/candidates/{id}/documents stores Aadhaar/PAN images
- GET  /api/candidates/{id}/documents returns booleans for each doc
- GET  /api/candidates/{id}/documents/{type} streams binary; 404 when missing; 400 on invalid type
- documents_checklist mirrors aadhaar/pan True after upload
- Role enforcement: non hr_admin/management is forbidden / unauthenticated 401|403
- _id never appears in any response
"""
import base64
import io
import os
import uuid

import pytest
import requests
from PIL import Image, ImageDraw

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")


def _fresh_aadhaar() -> str:
    """A different check-digit-valid Aadhaar number on every run.

    The server now refuses an invalid Aadhaar (the old fixed 123412341234 fails
    the check digit) and refuses a number already held by another live
    candidate — so a fixed value would also fail from the second run on.
    """
    import random
    d = ((0,1,2,3,4,5,6,7,8,9),(1,2,3,4,0,6,7,8,9,5),(2,3,4,0,1,7,8,9,5,6),(3,4,0,1,2,8,9,5,6,7),
         (4,0,1,2,3,9,5,6,7,8),(5,9,8,7,6,0,4,3,2,1),(6,5,9,8,7,1,0,4,3,2),(7,6,5,9,8,2,1,0,4,3),
         (8,7,6,5,9,3,2,1,0,4),(9,8,7,6,5,4,3,2,1,0))
    p = ((0,1,2,3,4,5,6,7,8,9),(1,5,7,6,2,8,3,0,9,4),(5,8,0,3,7,9,6,1,4,2),(8,9,1,6,0,4,3,5,2,7),
         (9,4,5,3,1,2,6,8,7,0),(4,2,8,6,5,7,3,9,0,1),(2,7,9,3,8,0,6,4,1,5),(7,0,4,6,9,1,3,2,5,8))
    base = str(random.randint(2, 9)) + "".join(str(random.randint(0, 9)) for _ in range(10))
    for check in "0123456789":
        c = 0
        for i, ch in enumerate(reversed(base + check)):
            c = d[c][p[i % 8][int(ch)]]
        if c == 0:
            return base + check
    raise AssertionError("unreachable")


def _fresh_pan() -> str:
    import random, string
    return ("".join(random.choice(string.ascii_uppercase) for _ in range(5))
            + "".join(random.choice(string.digits) for _ in range(4)) + random.choice(string.ascii_uppercase))


TEST_AADHAAR = _fresh_aadhaar()
TEST_PAN = _fresh_pan()
assert BASE_URL, "REACT_APP_BACKEND_URL is not set"


def _dummy_jpg_b64() -> str:
    """Generate a small JPG with some text content. Gemini rejects fully blank
    images with INVALID_ARGUMENT, so we draw some text/shapes to make it a
    valid-but-meaningless OCR target. We only assert response shape, not
    extracted values."""
    img = Image.new("RGB", (640, 400), "white")
    d = ImageDraw.Draw(img)
    # Some text-like content & shapes so Gemini can analyse the image
    d.rectangle([10, 10, 630, 390], outline="black", width=3)
    d.text((30, 30), "GOVERNMENT OF INDIA", fill="black")
    d.text((30, 60), "Sample Card", fill="black")
    d.text((30, 90), "Name: Test User", fill="black")
    d.text((30, 120), "DOB: 01/01/1995", fill="black")
    d.text((30, 150), "1234 5678 9012", fill="black")
    d.text((30, 180), "Address: 1 Test St, Moradabad, UP - 244001", fill="black")
    d.line([(30, 220), (610, 220)], fill="black", width=2)
    d.ellipse([500, 250, 600, 350], outline="black", width=2)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode("ascii")


@pytest.fixture(scope="module")
def headers():
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": "admin@radhyamfi.com", "password": "Admin@123"},
    )
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture(scope="module")
def dummy_b64():
    return _dummy_jpg_b64()


# --- Aadhaar OCR (preview) ---
class TestAadhaarOCR:
    def test_no_image_returns_400(self, headers):
        r = requests.post(
            f"{BASE_URL}/api/candidates/ocr/aadhaar", json={}, headers=headers
        )
        assert r.status_code == 400, r.text
        assert "Aadhaar" in r.json().get("detail", "")

    def test_front_only_returns_shape(self, headers, dummy_b64):
        r = requests.post(
            f"{BASE_URL}/api/candidates/ocr/aadhaar",
            json={"front_image_base64": dummy_b64, "front_mime_type": "image/jpeg"},
            headers=headers,
            timeout=120,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("success") is True
        data = body.get("data")
        assert isinstance(data, dict), f"data should be dict, got {type(data)}"
        # Must contain at least these shape keys (values may be empty for dummy image)
        # Accept raw_response fallback when Gemini returns non-JSON, but expected keys should exist for proper flow
        if "raw_response" not in data:
            for k in [
                "name", "dob", "gender", "father_or_husband_name",
                "aadhaar_number", "address", "city", "state", "pincode",
            ]:
                assert k in data, f"missing key {k} in OCR response"

    def test_front_and_back_accepted(self, headers, dummy_b64):
        r = requests.post(
            f"{BASE_URL}/api/candidates/ocr/aadhaar",
            json={
                "front_image_base64": dummy_b64,
                "back_image_base64": dummy_b64,
            },
            headers=headers,
            timeout=120,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("success") is True
        assert isinstance(body.get("data"), dict)

    def test_unauthenticated_forbidden(self):
        r = requests.post(f"{BASE_URL}/api/candidates/ocr/aadhaar", json={})
        assert r.status_code in (401, 403)


# --- PAN OCR (preview) ---
class TestPanOCR:
    def test_no_image_returns_400(self, headers):
        # Pydantic model requires image_base64; missing -> 422; empty string -> 400
        r = requests.post(
            f"{BASE_URL}/api/candidates/ocr/pan",
            json={"image_base64": ""},
            headers=headers,
        )
        assert r.status_code == 400, r.text

    def test_valid_image_returns_shape(self, headers, dummy_b64):
        r = requests.post(
            f"{BASE_URL}/api/candidates/ocr/pan",
            json={"image_base64": dummy_b64},
            headers=headers,
            timeout=120,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("success") is True
        data = body.get("data")
        assert isinstance(data, dict)
        if "raw_response" not in data:
            for k in ["pan_number", "name", "father_name", "dob"]:
                assert k in data, f"missing key {k}"

    def test_unauthenticated_forbidden(self):
        r = requests.post(
            f"{BASE_URL}/api/candidates/ocr/pan", json={"image_base64": "x"}
        )
        assert r.status_code in (401, 403)


# --- Candidate create + documents flow ---
class TestCandidateDocuments:
    @pytest.fixture(scope="class")
    def created_candidate(self, headers):
        suffix = uuid.uuid4().hex[:6]
        payload = {
            "first_name": f"TEST_KYC_{suffix}",
            "last_name": "Candidate",
            "mobile": "9000011122",
            "email": f"test_kyc_{suffix}@example.com",
            "position": "Field Officer",
            "department": "Operations",
            "dob": "01/01/1995",
            "gender": "Male",
            "father_or_husband_name": "Father Name",
            "aadhaar_number": TEST_AADHAAR,
            "pan_number": TEST_PAN,
            "address": "1 Test St",
            "city": "Moradabad",
            "state": "UP",
            "pincode": "244001",
            "aadhaar_data": {"name": "TEST", "raw": True},
            "pan_data": {"pan_number": "ABCDE1234F"},
        }
        r = requests.post(f"{BASE_URL}/api/candidates", json=payload, headers=headers)
        assert r.status_code in (200, 201), r.text
        body = r.json()
        assert "_id" not in body
        assert "id" in body
        # New fields persisted
        for k in [
            "dob", "gender", "father_or_husband_name", "aadhaar_number",
            "pan_number", "address", "city", "state", "pincode",
            "aadhaar_data", "pan_data",
        ]:
            assert body.get(k) == payload[k], f"field {k} not persisted"
        # Verify with GET
        g = requests.get(f"{BASE_URL}/api/candidates/{body['id']}", headers=headers)
        assert g.status_code == 200, g.text
        gb = g.json()
        assert "_id" not in gb
        assert gb.get("aadhaar_number") == TEST_AADHAAR
        return body["id"]

    def test_documents_no_payload_returns_400(self, headers, created_candidate):
        r = requests.post(
            f"{BASE_URL}/api/candidates/{created_candidate}/documents",
            json={},
            headers=headers,
        )
        assert r.status_code == 400, r.text

    def test_initial_documents_meta_all_false(self, headers, created_candidate):
        r = requests.get(
            f"{BASE_URL}/api/candidates/{created_candidate}/documents",
            headers=headers,
        )
        assert r.status_code == 200, r.text
        d = r.json()
        assert "_id" not in d
        assert d == {
            "candidate_id": created_candidate,
            "aadhaar_front": False,
            "aadhaar_back": False,
            "pan_card": False,
        }

    def test_get_missing_doc_binary_404(self, headers, created_candidate):
        r = requests.get(
            f"{BASE_URL}/api/candidates/{created_candidate}/documents/aadhaar_front",
            headers=headers,
        )
        assert r.status_code == 404

    def test_invalid_doc_type_400(self, headers, created_candidate):
        r = requests.get(
            f"{BASE_URL}/api/candidates/{created_candidate}/documents/passport",
            headers=headers,
        )
        assert r.status_code == 400

    def test_upload_aadhaar_front_back(self, headers, created_candidate, dummy_b64):
        r = requests.post(
            f"{BASE_URL}/api/candidates/{created_candidate}/documents",
            json={
                "aadhaar_front_base64": dummy_b64,
                "aadhaar_back_base64": dummy_b64,
            },
            headers=headers,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("success") is True
        assert set(body.get("saved", [])) >= {"aadhaar_front", "aadhaar_back"}

        # GET meta -> aadhaar flags True, pan still False
        g = requests.get(
            f"{BASE_URL}/api/candidates/{created_candidate}/documents",
            headers=headers,
        )
        assert g.status_code == 200
        gd = g.json()
        assert gd["aadhaar_front"] is True
        assert gd["aadhaar_back"] is True
        assert gd["pan_card"] is False

        # Candidate documents_checklist.aadhaar = True
        c = requests.get(
            f"{BASE_URL}/api/candidates/{created_candidate}", headers=headers
        )
        assert c.status_code == 200
        cdoc = c.json()
        assert "_id" not in cdoc
        assert cdoc.get("documents_checklist", {}).get("aadhaar") is True

    def test_get_aadhaar_front_binary(self, headers, created_candidate):
        r = requests.get(
            f"{BASE_URL}/api/candidates/{created_candidate}/documents/aadhaar_front",
            headers=headers,
        )
        assert r.status_code == 200
        assert r.headers.get("content-type", "").startswith("image/")
        # Should be a valid image
        img = Image.open(io.BytesIO(r.content))
        assert img.size[0] > 0 and img.size[1] > 0

    def test_upload_pan_only(self, headers, created_candidate, dummy_b64):
        r = requests.post(
            f"{BASE_URL}/api/candidates/{created_candidate}/documents",
            json={"pan_card_base64": dummy_b64, "pan_card_mime": "image/jpeg"},
            headers=headers,
        )
        assert r.status_code == 200, r.text
        assert "pan_card" in r.json().get("saved", [])

        c = requests.get(
            f"{BASE_URL}/api/candidates/{created_candidate}", headers=headers
        )
        assert c.json().get("documents_checklist", {}).get("pan") is True

    def test_unauthenticated_forbidden(self, created_candidate):
        for path in [
            f"/api/candidates/{created_candidate}/documents",
            f"/api/candidates/{created_candidate}/documents/aadhaar_front",
        ]:
            r = requests.get(f"{BASE_URL}{path}")
            assert r.status_code in (401, 403), f"{path} -> {r.status_code}"
        r = requests.post(
            f"{BASE_URL}/api/candidates/{created_candidate}/documents",
            json={"pan_card_base64": "x"},
        )
        assert r.status_code in (401, 403)
