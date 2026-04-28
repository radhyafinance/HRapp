from fastapi import APIRouter, HTTPException, Depends, UploadFile, File
from pydantic import BaseModel
from typing import Optional
from database import db
from auth_utils import get_current_user
from datetime import datetime, timezone
from bson import ObjectId
import os
import uuid
import base64
import tempfile
import json
import re

router = APIRouter()


def cand_to_dict(c):
    c["id"] = str(c.pop("_id"))
    return c


class CandidateCreate(BaseModel):
    first_name: str
    last_name: str
    mobile: str
    email: Optional[str] = None
    position: str
    department: str
    interview_date: Optional[str] = None
    interviewer: Optional[str] = None
    status: str = "pending"  # pending, selected, rejected
    rejection_reason: Optional[str] = None
    expected_joining_date: Optional[str] = None
    offered_ctc: Optional[float] = None
    notes: Optional[str] = None


class CandidateUpdate(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    mobile: Optional[str] = None
    email: Optional[str] = None
    position: Optional[str] = None
    department: Optional[str] = None
    status: Optional[str] = None
    rejection_reason: Optional[str] = None
    expected_joining_date: Optional[str] = None
    offered_ctc: Optional[float] = None
    notes: Optional[str] = None


class AadhaarOCRRequest(BaseModel):
    image_base64: str
    mime_type: str = "image/jpeg"


@router.get("")
async def list_candidates(
    status: str = None,
    search: str = None,
    current_user: dict = Depends(get_current_user),
):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    query = {}
    if status:
        query["status"] = status
    if search:
        query["$or"] = [
            {"first_name": {"$regex": search, "$options": "i"}},
            {"last_name": {"$regex": search, "$options": "i"}},
            {"mobile": {"$regex": search, "$options": "i"}},
        ]
    candidates = await db.candidates.find(query).sort("created_at", -1).to_list(1000)
    return [cand_to_dict(c) for c in candidates]


@router.post("")
async def create_candidate(data: CandidateCreate, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    doc = {
        **data.model_dump(),
        "documents_checklist": {
            "aadhaar": False, "pan": False, "photo": False,
            "educational_certificates": False, "previous_exp_letter": False,
            "bank_details": False, "address_proof": False
        },
        "aadhaar_data": None,
        "created_by": current_user.get("employee_id"),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    result = await db.candidates.insert_one(doc)
    doc["id"] = str(result.inserted_id)
    doc.pop("_id", None)
    return doc


@router.get("/{cand_id}")
async def get_candidate(cand_id: str, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    cand = await db.candidates.find_one({"_id": ObjectId(cand_id)})
    if not cand:
        raise HTTPException(status_code=404, detail="Candidate not found")
    return cand_to_dict(cand)


@router.put("/{cand_id}")
async def update_candidate(cand_id: str, data: CandidateUpdate, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    update_data = {k: v for k, v in data.model_dump().items() if v is not None}
    update_data["updated_at"] = datetime.now(timezone.utc).isoformat()
    await db.candidates.update_one({"_id": ObjectId(cand_id)}, {"$set": update_data})
    cand = await db.candidates.find_one({"_id": ObjectId(cand_id)})
    return cand_to_dict(cand)


@router.post("/{cand_id}/aadhaar-ocr")
async def aadhaar_ocr(cand_id: str, data: AadhaarOCRRequest, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage, FileContentWithMimeType
        image_bytes = base64.b64decode(data.image_base64)
        suffix = ".jpg" if "jpeg" in data.mime_type else ".png"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
            f.write(image_bytes)
            temp_path = f.name
        try:
            chat = LlmChat(
                api_key=os.environ.get("EMERGENT_LLM_KEY"),
                session_id=f"aadhaar-{uuid.uuid4()}",
                system_message="You are an OCR assistant for Indian Aadhaar cards. Extract information precisely.",
            ).with_model("gemini", "gemini-2.5-flash")
            image_file = FileContentWithMimeType(file_path=temp_path, mime_type=data.mime_type)
            response = await chat.send_message(UserMessage(
                text="""Extract the following from this Aadhaar card image and return ONLY valid JSON (no markdown):
{"name": "full name", "dob": "date of birth DD/MM/YYYY", "gender": "Male/Female", "address": "full address", "aadhaar_last4": "last 4 digits only"}""",
                file_contents=[image_file],
            ))
            json_match = re.search(r'\{.*\}', response, re.DOTALL)
            if json_match:
                aadhaar_data = json.loads(json_match.group())
            else:
                aadhaar_data = {"raw_response": response}
        finally:
            os.unlink(temp_path)
        await db.candidates.update_one(
            {"_id": ObjectId(cand_id)},
            {"$set": {"aadhaar_data": aadhaar_data, "updated_at": datetime.now(timezone.utc).isoformat()}},
        )
        return {"success": True, "data": aadhaar_data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"OCR failed: {str(e)}")


@router.put("/{cand_id}/documents-checklist")
async def update_checklist(cand_id: str, checklist: dict, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    await db.candidates.update_one(
        {"_id": ObjectId(cand_id)},
        {"$set": {"documents_checklist": checklist, "updated_at": datetime.now(timezone.utc).isoformat()}},
    )
    return {"message": "Checklist updated"}
