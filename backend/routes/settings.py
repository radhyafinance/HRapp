from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional
from database import db
from auth_utils import get_current_user
from datetime import datetime, timezone


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
