from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional
from database import db
from auth_utils import get_current_user
from datetime import datetime, timezone
import re


router = APIRouter()


COMPANY_KEY = "company"


class CompanySettings(BaseModel):
    company_name: Optional[str] = "Radhya Micro Finance Private Limited"
    company_short_code: Optional[str] = "RMF0001"
    debit_account_no: Optional[str] = ""
    debit_account_ifsc: Optional[str] = ""
    debit_bank_name: Optional[str] = ""
    transaction_type: Optional[str] = "NFT"  # NFT, RTG, IFC, WIB
    address: Optional[str] = ""
    cin: Optional[str] = ""
    phone: Optional[str] = ""
    email: Optional[str] = ""
    website: Optional[str] = ""


@router.get("/company")
async def get_company(current_user: dict = Depends(get_current_user)):
    doc = await db.app_settings.find_one({"key": COMPANY_KEY})
    if not doc:
        defaults = CompanySettings().model_dump()
        defaults["key"] = COMPANY_KEY
        defaults["created_at"] = datetime.now(timezone.utc).isoformat()
        await db.app_settings.insert_one(defaults)
        doc = await db.app_settings.find_one({"key": COMPANY_KEY})
    doc.pop("_id", None)
    return doc


@router.put("/company")
async def update_company(data: CompanySettings, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    update = {k: v for k, v in data.model_dump().items() if v is not None}
    update["updated_at"] = datetime.now(timezone.utc).isoformat()
    await db.app_settings.update_one(
        {"key": COMPANY_KEY},
        {"$set": update, "$setOnInsert": {"key": COMPANY_KEY, "created_at": update["updated_at"]}},
        upsert=True,
    )
    doc = await db.app_settings.find_one({"key": COMPANY_KEY})
    doc.pop("_id", None)
    return doc


# ---------------- Face match settings ----------------

FACE_KEY = "face_match"


class FaceMatchSettings(BaseModel):
    strict: bool = False  # False = warn-but-allow (default); True = block punch on mismatch


@router.get("/face-match")
async def get_face_match(current_user: dict = Depends(get_current_user)):
    doc = await db.app_settings.find_one({"key": FACE_KEY}) or {"key": FACE_KEY, "strict": False}
    doc.pop("_id", None)
    return doc


@router.put("/face-match")
async def update_face_match(data: FaceMatchSettings, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    update = {**data.model_dump(), "updated_at": datetime.now(timezone.utc).isoformat()}
    await db.app_settings.update_one(
        {"key": FACE_KEY},
        {"$set": update, "$setOnInsert": {"key": FACE_KEY}},
        upsert=True,
    )
    doc = await db.app_settings.find_one({"key": FACE_KEY})
    doc.pop("_id", None)
    return doc


# ---------------- Android app version policy ----------------
# Which APK builds are still allowed in. Read by PlatformGate on every launch;
# lives here rather than as a constant in the frontend so retiring a build is a
# switch HR flips, not a code change and redeploy for every APK release.

APP_VERSION_KEY = "app_version"

# v1.4.0 is the first APK that tags its User-Agent ("RadhyaHRApp/1.4.0"), which
# is what makes any of this detectable. Used until HR saves something else.
DEFAULT_MIN_APP_VERSION = "1.4.0"

_VERSION_RE = re.compile(r"^\d+(\.\d+){0,3}$")


class AppVersionSettings(BaseModel):
    min_version: str = DEFAULT_MIN_APP_VERSION
    # False = a dismissible "please update" banner, app still works.
    # True  = older builds are held on a full-screen update screen.
    enforce: bool = False


def _app_version_defaults() -> dict:
    return {"key": APP_VERSION_KEY, "min_version": DEFAULT_MIN_APP_VERSION, "enforce": False}


@router.get("/app-version")
async def get_app_version(current_user: dict = Depends(get_current_user)):
    """Every logged-in client reads this on launch, so it is open to all roles.

    Deliberately does NOT create the document — a read from an employee's phone
    should never write. Absent config just means the defaults.
    """
    doc = await db.app_settings.find_one({"key": APP_VERSION_KEY}) or {}
    doc.pop("_id", None)
    out = _app_version_defaults()
    out.update({k: v for k, v in doc.items() if v is not None})
    # Never hand back something the client can't parse: a junk min_version with
    # enforce on would be a lockout nobody could explain.
    if not _VERSION_RE.match(str(out.get("min_version", ""))):
        out["min_version"] = DEFAULT_MIN_APP_VERSION
    out["enforce"] = bool(out.get("enforce"))
    return out


@router.put("/app-version")
async def update_app_version(data: AppVersionSettings, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    min_version = (data.min_version or "").strip()
    if not _VERSION_RE.match(min_version):
        raise HTTPException(
            status_code=400,
            detail="Minimum version must look like 1.4.0 (numbers and dots only)",
        )
    now = datetime.now(timezone.utc).isoformat()
    update = {
        "min_version": min_version,
        "enforce": bool(data.enforce),
        "updated_at": now,
        # Turning enforcement on can stop staff punching in; record who did it.
        "updated_by": current_user.get("employee_id") or current_user.get("username"),
    }
    await db.app_settings.update_one(
        {"key": APP_VERSION_KEY},
        {"$set": update, "$setOnInsert": {"key": APP_VERSION_KEY, "created_at": now}},
        upsert=True,
    )
    doc = await db.app_settings.find_one({"key": APP_VERSION_KEY})
    doc.pop("_id", None)
    return doc
