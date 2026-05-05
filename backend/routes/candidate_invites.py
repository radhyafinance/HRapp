"""
Public candidate self-onboarding via single-use invite tokens.

Flow:
  1. HR clicks "Generate Invite Link" on the Candidates page.
     → POST /api/candidate-invites
     ← { token, public_url, expires_at }
  2. HR copies and shares the link manually (WhatsApp / phone).
  3. Candidate opens /apply/<token> in any browser. No login.
     → GET /api/public/candidate-invite/<token>     (validate)
     → POST /api/public/candidate-invite/<token>/submit (with files)
  4. Server compresses uploads (already <1MB on client; we double-check),
     runs Gemini OCR on Aadhaar front + back + PAN, creates the Candidate
     record with extracted fields, marks the invite as used.
  5. HR refreshes the Candidates page and finishes filling the rest.
"""
import base64
import os
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from bson import ObjectId
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from auth_utils import get_current_user
from database import db

router = APIRouter()
public_router = APIRouter()  # mounted without auth on a different prefix

# ---------------------------- Config ----------------------------

INVITE_TTL_DAYS = 7
MAX_BYTES_PER_FILE = 1_100_000  # ~1 MB hard cap (slight headroom over 1 MB)
ALLOWED_IMAGE_MIMES = {"image/jpeg", "image/jpg", "image/png", "image/webp"}
ALLOWED_CV_MIMES = {"application/pdf", "image/jpeg", "image/png"}
PUBLIC_BASE_URL_ENV = "PUBLIC_BASE_URL"  # optional override


def _public_url_for_token(token: str) -> str:
    base = os.environ.get(PUBLIC_BASE_URL_ENV) or os.environ.get("FRONTEND_URL") or ""
    base = base.rstrip("/")
    if not base:
        # fall back to a placeholder that frontend will rewrite
        return f"/apply/{token}"
    return f"{base}/apply/{token}"


def _invite_to_dict(inv: dict) -> dict:
    inv = dict(inv)
    inv["id"] = str(inv.pop("_id"))
    inv["public_url"] = _public_url_for_token(inv["token"])
    return inv


# ---------------------------- HR-side endpoints ----------------------------


class InviteCreateRequest(BaseModel):
    note: Optional[str] = None  # internal note ("Sent to Ravi via WhatsApp 5/2")


@router.post("")
async def create_invite(
    data: InviteCreateRequest,
    current_user: dict = Depends(get_current_user),
):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    token = secrets.token_urlsafe(24)  # ~32-char URL-safe token
    now = datetime.now(timezone.utc)
    doc = {
        "token": token,
        "status": "active",  # active | used | revoked
        "note": (data.note or "").strip() or None,
        "created_by": current_user.get("username") or current_user.get("employee_id"),
        "created_at": now.isoformat(),
        "expires_at": (now + timedelta(days=INVITE_TTL_DAYS)).isoformat(),
        "used_at": None,
        "candidate_id": None,
    }
    res = await db.candidate_invites.insert_one(doc)
    doc["_id"] = res.inserted_id
    return _invite_to_dict(doc)


@router.get("")
async def list_invites(current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    # Auto-expire stale active invites in-line (cheap)
    now_iso = datetime.now(timezone.utc).isoformat()
    await db.candidate_invites.update_many(
        {"status": "active", "expires_at": {"$lt": now_iso}},
        {"$set": {"status": "expired"}},
    )
    rows = await db.candidate_invites.find({}).sort("created_at", -1).to_list(500)
    return [_invite_to_dict(r) for r in rows]


@router.delete("/{invite_id}")
async def revoke_invite(invite_id: str, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    inv = await db.candidate_invites.find_one({"_id": ObjectId(invite_id)})
    if not inv:
        raise HTTPException(status_code=404, detail="Invite not found")
    if inv.get("status") == "used":
        raise HTTPException(status_code=400, detail="Already submitted — cannot revoke. Delete the candidate instead.")
    await db.candidate_invites.update_one(
        {"_id": ObjectId(invite_id)},
        {"$set": {"status": "revoked"}},
    )
    return {"message": "Invite revoked"}


# ---------------------------- Public (no auth) endpoints ----------------------------


@public_router.get("/{token}")
async def public_invite_status(token: str):
    inv = await db.candidate_invites.find_one({"token": token})
    if not inv:
        raise HTTPException(status_code=404, detail="Invalid link.")
    now_iso = datetime.now(timezone.utc).isoformat()
    if inv.get("status") == "used":
        raise HTTPException(status_code=410, detail="This link has already been used. Please contact HR.")
    if inv.get("status") == "revoked":
        raise HTTPException(status_code=410, detail="This link has been revoked. Please contact HR.")
    if inv.get("status") == "expired" or (inv.get("expires_at") and inv["expires_at"] < now_iso):
        await db.candidate_invites.update_one({"_id": inv["_id"]}, {"$set": {"status": "expired"}})
        raise HTTPException(status_code=410, detail="This link has expired. Please contact HR for a new link.")
    return {
        "valid": True,
        "expires_at": inv.get("expires_at"),
    }


def _validate_upload(name: str, b: bytes, mime: str, allowed_mimes: set):
    if mime not in allowed_mimes:
        raise HTTPException(status_code=400, detail=f"{name}: file type {mime} not allowed.")
    if len(b) > MAX_BYTES_PER_FILE:
        raise HTTPException(
            status_code=400,
            detail=f"{name} is {len(b)//1024}KB — must be under 1 MB. Please re-upload a smaller image.",
        )


async def _ocr_aadhaar_safe(front_b64: Optional[str], back_b64: Optional[str], front_mime: str, back_mime: str) -> dict:
    """Best-effort Aadhaar OCR. Returns extracted fields or empty dict on failure."""
    if not front_b64 and not back_b64:
        return {}
    try:
        from routes.candidates import _gemini_vision_extract  # reuse
    except Exception:
        return {}
    files = []
    if front_b64:
        files.append((front_b64, front_mime))
    if back_b64:
        files.append((back_b64, back_mime))
    prompt = (
        "I am providing one or two images of an Indian Aadhaar card "
        f"({'front and back' if len(files) == 2 else 'one side only'}). "
        "Carefully read all visible text on every image and combine the information. "
        "Return ONLY a single valid JSON object (no markdown fences, no commentary) with these exact keys:\n"
        '{"name":"full name as printed",'
        '"dob":"date of birth in DD/MM/YYYY (or YOB if only year is printed)",'
        '"gender":"Male/Female/Other",'
        '"father_or_husband_name":"S/O or D/O or W/O name (parent or husband as printed; empty string if absent)",'
        '"aadhaar_number":"full 12-digit Aadhaar number with no spaces",'
        '"address":"complete address as printed (single line, comma separated, do not include pincode)",'
        '"city":"city / district / village name only",'
        '"state":"state name only",'
        '"pincode":"6-digit pincode only"'
        "}\n"
        "Rules: If a field is absent, use an empty string. Never invent values."
    )
    try:
        out = await _gemini_vision_extract(prompt, files)
    except Exception:
        return {}
    # Normalize
    aadhaar_no = re.sub(r"\D", "", out.get("aadhaar_number") or "")
    if len(aadhaar_no) == 12:
        out["aadhaar_number"] = aadhaar_no
    else:
        out["aadhaar_number"] = ""
    pincode = re.sub(r"\D", "", out.get("pincode") or "")
    if len(pincode) == 6:
        out["pincode"] = pincode
    return out


async def _ocr_pan_safe(b64: str, mime: str) -> dict:
    if not b64:
        return {}
    try:
        from routes.candidates import _gemini_vision_extract
    except Exception:
        return {}
    prompt = (
        "I am providing an image of an Indian PAN card. Read it carefully. "
        "Return ONLY a single valid JSON object (no markdown fences) with these exact keys:\n"
        '{"name":"full name as printed",'
        '"father_name":"father\'s name as printed",'
        '"dob":"date of birth in DD/MM/YYYY",'
        '"pan_number":"10-character PAN, uppercase, e.g. ABCDE1234F"}\n'
        "Rules: If a field is absent, use an empty string. Never invent."
    )
    try:
        out = await _gemini_vision_extract(prompt, [(b64, mime)])
    except Exception:
        return {}
    pan = (out.get("pan_number") or "").upper().replace(" ", "")
    if re.match(r"^[A-Z]{5}[0-9]{4}[A-Z]$", pan):
        out["pan_number"] = pan
    else:
        out["pan_number"] = ""
    return out


def _split_name(full: str) -> tuple[str, str]:
    full = (full or "").strip()
    if not full:
        return "", ""
    parts = full.split()
    if len(parts) == 1:
        return parts[0], ""
    return parts[0], " ".join(parts[1:])


@public_router.post("/{token}/submit")
async def public_invite_submit(
    token: str,
    first_name: str = Form(...),
    last_name: str = Form(...),
    mobile: str = Form(...),
    email: str = Form(...),
    aadhaar_front: UploadFile = File(...),
    aadhaar_back: UploadFile = File(...),
    pan_card: UploadFile = File(...),
    cv: UploadFile = File(...),
):
    inv = await db.candidate_invites.find_one({"token": token})
    if not inv:
        raise HTTPException(status_code=404, detail="Invalid link.")
    if inv.get("status") != "active":
        raise HTTPException(status_code=410, detail="This link is no longer active. Please contact HR.")
    now = datetime.now(timezone.utc)
    if inv.get("expires_at") and inv["expires_at"] < now.isoformat():
        await db.candidate_invites.update_one({"_id": inv["_id"]}, {"$set": {"status": "expired"}})
        raise HTTPException(status_code=410, detail="This link has expired. Please contact HR for a new link.")

    # Read + size-validate all uploads
    af_bytes = await aadhaar_front.read()
    ab_bytes = await aadhaar_back.read()
    pan_bytes = await pan_card.read()
    cv_bytes = await cv.read()
    _validate_upload("Aadhaar front", af_bytes, aadhaar_front.content_type or "", ALLOWED_IMAGE_MIMES)
    _validate_upload("Aadhaar back",  ab_bytes, aadhaar_back.content_type or "",  ALLOWED_IMAGE_MIMES)
    _validate_upload("PAN card",      pan_bytes, pan_card.content_type or "",     ALLOWED_IMAGE_MIMES)
    _validate_upload("CV",            cv_bytes,  cv.content_type or "",           ALLOWED_CV_MIMES)

    af_b64  = base64.b64encode(af_bytes).decode("ascii")
    ab_b64  = base64.b64encode(ab_bytes).decode("ascii")
    pan_b64 = base64.b64encode(pan_bytes).decode("ascii")
    cv_b64  = base64.b64encode(cv_bytes).decode("ascii")

    # Run OCR (best-effort — don't block submission if OCR fails)
    aadhaar_data = await _ocr_aadhaar_safe(
        af_b64, ab_b64,
        aadhaar_front.content_type or "image/jpeg",
        aadhaar_back.content_type or "image/jpeg",
    )
    pan_data = await _ocr_pan_safe(pan_b64, pan_card.content_type or "image/jpeg")

    # Pick name from explicit field first, else OCR
    aadhaar_name_first, aadhaar_name_last = _split_name(aadhaar_data.get("name", ""))

    cand_doc = {
        "first_name": first_name.strip(),
        "last_name": last_name.strip(),
        "mobile": (mobile or "").strip(),
        "email": (email or "").strip(),
        "position": "",
        "department": "",
        "status": "pending",
        # OCR-extracted data
        "dob": aadhaar_data.get("dob") or pan_data.get("dob") or "",
        "gender": aadhaar_data.get("gender", ""),
        "father_or_husband_name": aadhaar_data.get("father_or_husband_name", "") or pan_data.get("father_name", ""),
        "aadhaar_number": aadhaar_data.get("aadhaar_number", ""),
        "pan_number": pan_data.get("pan_number", ""),
        "address": aadhaar_data.get("address", ""),
        "city": aadhaar_data.get("city", ""),
        "state": aadhaar_data.get("state", ""),
        "pincode": aadhaar_data.get("pincode", ""),
        "aadhaar_data": aadhaar_data or None,
        "pan_data": pan_data or None,
        # Stored documents (base64)
        "aadhaar_front": {"data": af_b64,  "mime": aadhaar_front.content_type or "image/jpeg"},
        "aadhaar_back":  {"data": ab_b64,  "mime": aadhaar_back.content_type or "image/jpeg"},
        "pan_card":      {"data": pan_b64, "mime": pan_card.content_type or "image/jpeg"},
        "cv":            {"data": cv_b64,  "mime": cv.content_type or "application/pdf",
                          "file_name": cv.filename or "cv.pdf"},
        "documents_uploaded": {
            "aadhaar_front": True,
            "aadhaar_back": True,
            "pan_card": True,
            "cv": True,
        },
        # Tracking
        "source": "self_onboarding",
        "invite_token": token,
        "submitted_at": now.isoformat(),
        "created_at": now.isoformat(),
        "ocr_status": {
            "aadhaar_ok": bool(aadhaar_data.get("aadhaar_number")),
            "pan_ok": bool(pan_data.get("pan_number")),
        },
    }
    res = await db.candidates.insert_one(cand_doc)

    await db.candidate_invites.update_one(
        {"_id": inv["_id"]},
        {"$set": {
            "status": "used",
            "used_at": now.isoformat(),
            "candidate_id": str(res.inserted_id),
        }},
    )

    # Notify HR Admins (non-blocking)
    try:
        admins = await db.users.find({"role": {"$in": ["hr_admin", "management"]}}, {"_id": 0, "username": 1}).to_list(50)
        notif_docs = []
        for a in admins:
            notif_docs.append({
                "user_id": a.get("username"),
                "type": "candidate_self_onboarded",
                "title": "New candidate self-onboarded",
                "message": f"{cand_doc['first_name']} {cand_doc['last_name']} submitted documents via invite link. Please review and assign role.",
                "link": "/candidates",
                "read": False,
                "created_at": now.isoformat(),
            })
        if notif_docs:
            await db.notifications.insert_many(notif_docs)
    except Exception:
        pass

    return {
        "success": True,
        "message": "Thank you! Your details have been submitted to HR.",
        "ocr_status": cand_doc["ocr_status"],
    }
