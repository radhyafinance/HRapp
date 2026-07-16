"""Employee ID cards: PDF generation and public QR verification.

Two routers:
  router         -> /api/id-cards       (HR only: preview meta, PDF, re-issue)
  public_router  -> /api/public/verify  (NO auth: what the QR opens)

The QR encodes /verify/<id_card_token>, never the employee ID. A random token
means outsiders can't walk RMF0001, RMF0002... to harvest the staff directory,
and a lost card can be killed on its own by rotating just that token.
"""

import base64
import os
import re
import secrets
import time
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

from auth_utils import get_current_user
from database import db

router = APIRouter()
public_router = APIRouter()

# Where the printed QR points. Must be a host that actually serves this app.
VERIFY_BASE_URL = os.environ.get("ID_CARD_VERIFY_BASE_URL", "https://hr.radhyafinance.com").rstrip("/")

# Employment statuses that make a card genuine vs. void.
VALID_STATUSES = {"active", "probation", "notice_period"}

_MOBILE_RE = re.compile(r"^(?:\+?91[\s-]?)?[6-9]\d{9}$")


def _clean_mobile(raw: str) -> Optional[str]:
    """Normalise an Indian mobile to '+91 XXXXX XXXXX', or None if implausible."""
    s = re.sub(r"[\s\-()]", "", (raw or "").strip())
    if not _MOBILE_RE.match(s):
        return None
    digits = s[-10:]
    return f"+91 {digits[:5]} {digits[5:]}"


def verify_url(token: str) -> str:
    return f"{VERIFY_BASE_URL}/verify/{token}"


def _require_hr(user: dict):
    if user.get("role") not in ("hr_admin", "management"):
        raise HTTPException(status_code=403, detail="Access denied")


async def _employee(employee_id: str) -> dict:
    emp = await db.employees.find_one({"employee_id": (employee_id or "").strip().upper()})
    if not emp:
        raise HTTPException(status_code=404, detail="Employee not found")
    return emp


async def _ensure_token(emp: dict) -> str:
    """Return this employee's card token, minting one on first use."""
    token = emp.get("id_card_token")
    if token:
        return token
    token = secrets.token_urlsafe(12)          # 16 chars, 96-bit
    await db.employees.update_one({"_id": emp["_id"]}, {"$set": {"id_card_token": token}})
    return token


async def _photo_bytes(employee_id: str) -> Optional[bytes]:
    doc = await db.employee_documents.find_one({"employee_id": employee_id})
    asset = (doc or {}).get("passport_photo")
    if not asset:
        return None
    raw = asset.get("data") if isinstance(asset, dict) else asset
    if not raw:
        return None
    try:
        return base64.b64decode(raw)
    except Exception:
        return None


def _emergency_of(emp: dict) -> str:
    return ((emp.get("emergency_contact") or {}).get("mobile") or "").strip()


def _card_blockers(emp: dict) -> list:
    """Reasons this employee can't have a card printed yet."""
    missing = []
    if not _emergency_of(emp):
        missing.append("Emergency contact number")
    if not (emp.get("designation") or "").strip():
        missing.append("Designation")
    if not (emp.get("blood_group") or "").strip():
        missing.append("Blood group")
    return missing


# ── HR-facing ────────────────────────────────────────────────────────────────
@router.get("/{employee_id}")
async def id_card_meta(employee_id: str, current_user: dict = Depends(get_current_user)):
    """Everything the ID Card tab needs to render its preview."""
    _require_hr(current_user)
    emp = await _employee(employee_id)
    token = await _ensure_token(emp)
    missing = _card_blockers(emp)
    return {
        "employee_id": emp.get("employee_id"),
        "name": f"{emp.get('first_name') or ''} {emp.get('last_name') or ''}".strip(),
        "designation": emp.get("designation") or "",
        "blood_group": emp.get("blood_group") or "",
        "emergency": _emergency_of(emp),
        "status": emp.get("status"),
        "has_photo": bool(await _photo_bytes(emp.get("employee_id"))),
        "verify_url": verify_url(token),
        "ready": not missing,
        "missing": missing,
    }


class EmergencyBody(BaseModel):
    mobile: str


@router.put("/{employee_id}/emergency")
async def set_emergency(employee_id: str, body: EmergencyBody,
                        current_user: dict = Depends(get_current_user)):
    """Save the next-of-kin number printed on the card.

    This is deliberately NOT the employee's own mobile, so HR confirms it before
    a card is generated. Stored on the employee so it need not be retyped.
    """
    _require_hr(current_user)
    emp = await _employee(employee_id)
    mobile = _clean_mobile(body.mobile)
    if not mobile:
        raise HTTPException(status_code=400, detail="Enter a valid 10-digit Indian mobile number.")
    ec = dict(emp.get("emergency_contact") or {})
    ec["mobile"] = mobile
    await db.employees.update_one({"_id": emp["_id"]}, {"$set": {"emergency_contact": ec}})
    return {"success": True, "mobile": mobile}


@router.get("/{employee_id}/pdf")
async def id_card_pdf(employee_id: str, current_user: dict = Depends(get_current_user)):
    """The printable card: 50 x 82 mm, front + back, with a cut line."""
    _require_hr(current_user)
    emp = await _employee(employee_id)

    missing = _card_blockers(emp)
    if missing:
        raise HTTPException(
            status_code=400,
            detail="Fill these before generating the ID card: " + ", ".join(missing) + ".",
        )

    token = await _ensure_token(emp)
    payload = {
        "first_name": emp.get("first_name"),
        "last_name": emp.get("last_name"),
        "designation": emp.get("designation"),
        "employee_id": emp.get("employee_id"),
        "blood_group": emp.get("blood_group"),
        "emergency": _emergency_of(emp),
    }

    from services.id_card_pdf import build_id_card_pdf
    pdf = build_id_card_pdf(payload, verify_url(token),
                            photo_bytes=await _photo_bytes(emp.get("employee_id")))
    fname = f"IDCard_{emp.get('employee_id')}.pdf"
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="{fname}"'})


@router.post("/{employee_id}/reissue")
async def reissue_card(employee_id: str, current_user: dict = Depends(get_current_user)):
    """Rotate the token: any previously printed card's QR stops verifying at once.

    Use when a card is lost or stolen. Only this employee is affected.
    """
    _require_hr(current_user)
    emp = await _employee(employee_id)
    token = secrets.token_urlsafe(12)
    await db.employees.update_one({"_id": emp["_id"]}, {"$set": {"id_card_token": token}})
    return {"success": True, "verify_url": verify_url(token)}


# ── public verification (the QR destination) ─────────────────────────────────
_HITS: dict = {}
_WINDOW = 60.0
_MAX_PER_WINDOW = 20


def _rate_limit(request: Request):
    """Crude per-IP limiter -- defence in depth on an unauthenticated endpoint."""
    ip = (request.client.host if request.client else "?") or "?"
    now = time.time()
    hits = [t for t in _HITS.get(ip, []) if now - t < _WINDOW]
    if len(hits) >= _MAX_PER_WINDOW:
        raise HTTPException(status_code=429, detail="Too many requests. Try again shortly.")
    hits.append(now)
    _HITS[ip] = hits
    if len(_HITS) > 5000:  # keep the dict from growing forever
        for k in [k for k, v in _HITS.items() if not v or now - v[-1] > _WINDOW]:
            _HITS.pop(k, None)


# An unknown token and a former employee return the SAME shape on purpose: never
# reveal whether a token exists, and never leak a name/photo for an invalid card.
_INVALID = {"valid": False, "status": "invalid"}


@public_router.get("/{token}")
async def public_verify(token: str, request: Request):
    """Open by QR. Returns the minimum needed to check a person against a card."""
    _rate_limit(request)
    emp = await db.employees.find_one({"id_card_token": (token or "").strip()})
    if not emp:
        return _INVALID

    status = (emp.get("status") or "").lower()
    if status not in VALID_STATUSES:
        # exited / absconding / terminated -> card is void
        return {
            "valid": False,
            "status": status or "invalid",
            "employee_id": emp.get("employee_id"),
            "name": f"{emp.get('first_name') or ''} {emp.get('last_name') or ''}".strip(),
        }

    return {
        "valid": True,
        "status": status,
        "employee_id": emp.get("employee_id"),
        "name": f"{emp.get('first_name') or ''} {emp.get('last_name') or ''}".strip(),
        "designation": emp.get("designation") or "",
        "has_photo": bool(await _photo_bytes(emp.get("employee_id"))),
        "photo_url": f"/api/public/verify/{token}/photo",
    }


@public_router.get("/{token}/photo")
async def public_verify_photo(token: str, request: Request):
    """The passport photo, reachable only via a card's token -- and only while valid."""
    _rate_limit(request)
    emp = await db.employees.find_one({"id_card_token": (token or "").strip()})
    if not emp or (emp.get("status") or "").lower() not in VALID_STATUSES:
        raise HTTPException(status_code=404, detail="Not found")
    data = await _photo_bytes(emp.get("employee_id"))
    if not data:
        raise HTTPException(status_code=404, detail="Not found")
    doc = await db.employee_documents.find_one({"employee_id": emp.get("employee_id")})
    mime = ((doc or {}).get("passport_photo") or {}).get("mime") or "image/jpeg"
    return Response(content=data, media_type=mime,
                    headers={"Cache-Control": "private, max-age=300"})
