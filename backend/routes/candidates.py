from fastapi import APIRouter, HTTPException, Depends, Response
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
    interview_time: Optional[str] = None  # HH:MM (24-hour)
    interviewer: Optional[str] = None
    meet_link: Optional[str] = None
    status: str = "pending"  # pending, selected, rejected
    rejection_reason: Optional[str] = None
    expected_joining_date: Optional[str] = None
    offered_ctc: Optional[float] = None
    notes: Optional[str] = None
    # New fields populated via OCR / manual entry
    dob: Optional[str] = None  # DD/MM/YYYY
    gender: Optional[str] = None
    father_or_husband_name: Optional[str] = None
    aadhaar_number: Optional[str] = None
    pan_number: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    pincode: Optional[str] = None
    aadhaar_data: Optional[dict] = None
    pan_data: Optional[dict] = None
    employee_id: Optional[str] = None
    joining_location: Optional[str] = None


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
    interview_date: Optional[str] = None
    interview_time: Optional[str] = None
    interviewer: Optional[str] = None
    meet_link: Optional[str] = None
    dob: Optional[str] = None
    gender: Optional[str] = None
    father_or_husband_name: Optional[str] = None
    aadhaar_number: Optional[str] = None
    pan_number: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    pincode: Optional[str] = None
    employee_id: Optional[str] = None
    joining_location: Optional[str] = None


class AadhaarOCRRequest(BaseModel):
    front_image_base64: Optional[str] = None
    back_image_base64: Optional[str] = None
    front_mime_type: str = "image/jpeg"
    back_mime_type: str = "image/jpeg"


class PANOCRRequest(BaseModel):
    image_base64: str
    mime_type: str = "image/jpeg"


class CandidateDocumentsRequest(BaseModel):
    aadhaar_front_base64: Optional[str] = None
    aadhaar_front_mime: Optional[str] = "image/jpeg"
    aadhaar_back_base64: Optional[str] = None
    aadhaar_back_mime: Optional[str] = "image/jpeg"
    pan_card_base64: Optional[str] = None
    pan_card_mime: Optional[str] = "image/jpeg"


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
            "aadhaar": bool(data.aadhaar_number),
            "pan": bool(data.pan_number),
            "photo": False,
            "educational_certificates": False,
            "previous_exp_letter": False,
            "bank_details": False,
            "address_proof": False,
        },
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


# ----------- OCR helpers -----------


async def _gemini_vision_extract(prompt: str, files: list) -> dict:
    """Run Gemini OCR via emergentintegrations and parse JSON output."""
    from emergentintegrations.llm.chat import LlmChat, UserMessage, FileContentWithMimeType
    chat = LlmChat(
        api_key=os.environ.get("EMERGENT_LLM_KEY"),
        session_id=f"ocr-{uuid.uuid4()}",
        system_message="You are an OCR assistant for Indian KYC documents. Extract information precisely and return only valid JSON.",
    ).with_model("gemini", "gemini-2.5-flash")
    file_contents = []
    temp_paths = []
    try:
        for b64, mime in files:
            suffix = ".jpg" if "jpeg" in mime else (".png" if "png" in mime else ".jpg")
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
                f.write(base64.b64decode(b64))
                temp_paths.append(f.name)
                file_contents.append(FileContentWithMimeType(file_path=f.name, mime_type=mime))
        response = await chat.send_message(UserMessage(text=prompt, file_contents=file_contents))
    finally:
        for p in temp_paths:
            try:
                os.unlink(p)
            except Exception:
                pass
    json_match = re.search(r'\{.*\}', response, re.DOTALL)
    if json_match:
        try:
            return json.loads(json_match.group())
        except Exception:
            return {"raw_response": response}
    return {"raw_response": response}


# ----------- Pre-save OCR (during Add Candidate flow) -----------


@router.post("/ocr/aadhaar")
async def ocr_aadhaar_preview(data: AadhaarOCRRequest, current_user: dict = Depends(get_current_user)):
    """Extract Aadhaar details from front and/or back images. Used during Add Candidate flow."""
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    if not data.front_image_base64 and not data.back_image_base64:
        raise HTTPException(status_code=400, detail="Provide at least one Aadhaar image (front or back).")
    files = []
    if data.front_image_base64:
        files.append((data.front_image_base64, data.front_mime_type))
    if data.back_image_base64:
        files.append((data.back_image_base64, data.back_mime_type))
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
        "Rules: If a field is absent, use an empty string. Never invent values. "
        "The Aadhaar number is 12 digits, often shown as 'XXXX XXXX XXXX' on the front. "
        "Address, S/O & pincode are usually on the back side."
    )
    try:
        extracted = await _gemini_vision_extract(prompt, files)
    except Exception as e:
        msg = str(e)
        if "INVALID_ARGUMENT" in msg or "Unable to process input image" in msg:
            raise HTTPException(status_code=422, detail="Could not read the Aadhaar image — please retry with a clearer photo.")
        raise HTTPException(status_code=500, detail=f"OCR failed: {msg}")

    # Normalize fields
    def _clean(v):
        if not isinstance(v, str):
            return v
        return v.strip()
    for k in list(extracted.keys()):
        extracted[k] = _clean(extracted[k])
    aadhaar_no = (extracted.get("aadhaar_number") or "")
    aadhaar_no = re.sub(r"\D", "", aadhaar_no)
    if len(aadhaar_no) == 12:
        extracted["aadhaar_number"] = aadhaar_no
    pincode = re.sub(r"\D", "", extracted.get("pincode") or "")
    if len(pincode) == 6:
        extracted["pincode"] = pincode
    return {"success": True, "data": extracted}


@router.post("/ocr/pan")
async def ocr_pan_preview(data: PANOCRRequest, current_user: dict = Depends(get_current_user)):
    """Extract PAN details from PAN card image."""
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    if not data.image_base64:
        raise HTTPException(status_code=400, detail="PAN image is required.")
    prompt = (
        "I am providing an image of an Indian PAN card. "
        "Return ONLY a single valid JSON object (no markdown, no commentary) with these exact keys:\n"
        '{"pan_number":"10-character alphanumeric PAN (e.g. ABCDE1234F)",'
        '"name":"name of the cardholder as printed",'
        '"father_name":"father\'s name as printed",'
        '"dob":"date of birth in DD/MM/YYYY"}\n'
        "Rules: PAN format is 5 letters + 4 digits + 1 letter. "
        "If a field is absent or unreadable, use empty string. Do not invent values."
    )
    try:
        extracted = await _gemini_vision_extract(prompt, [(data.image_base64, data.mime_type)])
    except Exception as e:
        msg = str(e)
        if "INVALID_ARGUMENT" in msg or "Unable to process input image" in msg:
            raise HTTPException(status_code=422, detail="Could not read the PAN image — please retry with a clearer photo.")
        raise HTTPException(status_code=500, detail=f"OCR failed: {msg}")
    pan_no = (extracted.get("pan_number") or "").upper().strip()
    pan_no = re.sub(r"[^A-Z0-9]", "", pan_no)
    if re.match(r"^[A-Z]{5}[0-9]{4}[A-Z]$", pan_no):
        extracted["pan_number"] = pan_no
    return {"success": True, "data": extracted}


# ----------- Document storage (after candidate creation) -----------


@router.post("/{cand_id}/documents")
async def upload_documents(
    cand_id: str,
    data: CandidateDocumentsRequest,
    current_user: dict = Depends(get_current_user),
):
    """Save Aadhaar front, Aadhaar back, and PAN card images for a candidate."""
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    cand = await db.candidates.find_one({"_id": ObjectId(cand_id)})
    if not cand:
        raise HTTPException(status_code=404, detail="Candidate not found")

    update = {"candidate_id": cand_id, "updated_at": datetime.now(timezone.utc).isoformat()}
    saved_keys = []
    if data.aadhaar_front_base64:
        update["aadhaar_front"] = {"data": data.aadhaar_front_base64, "mime": data.aadhaar_front_mime}
        saved_keys.append("aadhaar_front")
    if data.aadhaar_back_base64:
        update["aadhaar_back"] = {"data": data.aadhaar_back_base64, "mime": data.aadhaar_back_mime}
        saved_keys.append("aadhaar_back")
    if data.pan_card_base64:
        update["pan_card"] = {"data": data.pan_card_base64, "mime": data.pan_card_mime}
        saved_keys.append("pan_card")
    if not saved_keys:
        raise HTTPException(status_code=400, detail="No documents provided.")

    await db.candidate_documents.update_one(
        {"candidate_id": cand_id},
        {"$set": update, "$setOnInsert": {"created_at": datetime.now(timezone.utc).isoformat()}},
        upsert=True,
    )

    # Mirror checklist flags onto candidate
    checklist = cand.get("documents_checklist", {}) or {}
    if "aadhaar_front" in saved_keys or "aadhaar_back" in saved_keys:
        checklist["aadhaar"] = True
    if "pan_card" in saved_keys:
        checklist["pan"] = True
    await db.candidates.update_one(
        {"_id": ObjectId(cand_id)},
        {"$set": {"documents_checklist": checklist, "updated_at": datetime.now(timezone.utc).isoformat()}},
    )
    return {"success": True, "saved": saved_keys}


@router.get("/{cand_id}/documents")
async def get_documents_meta(cand_id: str, current_user: dict = Depends(get_current_user)):
    """Get info about which documents exist (without binary)."""
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    doc = await db.candidate_documents.find_one({"candidate_id": cand_id})
    if not doc:
        return {"candidate_id": cand_id, "aadhaar_front": False, "aadhaar_back": False, "pan_card": False}
    return {
        "candidate_id": cand_id,
        "aadhaar_front": bool(doc.get("aadhaar_front")),
        "aadhaar_back": bool(doc.get("aadhaar_back")),
        "pan_card": bool(doc.get("pan_card")),
    }


@router.get("/{cand_id}/documents/{doc_type}")
async def get_document_binary(
    cand_id: str,
    doc_type: str,
    current_user: dict = Depends(get_current_user),
):
    """Stream a document image. doc_type: aadhaar_front | aadhaar_back | pan_card."""
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    if doc_type not in {"aadhaar_front", "aadhaar_back", "pan_card"}:
        raise HTTPException(status_code=400, detail="Invalid document type")
    doc = await db.candidate_documents.find_one({"candidate_id": cand_id})
    if not doc or not doc.get(doc_type):
        raise HTTPException(status_code=404, detail="Document not found")
    asset = doc[doc_type]
    try:
        binary = base64.b64decode(asset["data"])
    except Exception:
        raise HTTPException(status_code=500, detail="Unable to decode document.")
    return Response(
        content=binary,
        media_type=asset.get("mime", "image/jpeg"),
        headers={"Cache-Control": "private, max-age=300"},
    )


# ----------- Legacy endpoint kept for compatibility (single-image OCR after creation) -----------


@router.post("/{cand_id}/aadhaar-ocr")
async def aadhaar_ocr_for_candidate(cand_id: str, data: AadhaarOCRRequest, current_user: dict = Depends(get_current_user)):
    """Run Aadhaar OCR for an existing candidate and persist extracted data on the candidate document."""
    result = await ocr_aadhaar_preview(data, current_user)
    extracted = result.get("data", {})
    update = {
        "aadhaar_data": extracted,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    # Auto-fill known top-level fields if blank
    pass_through = ["dob", "gender", "father_or_husband_name", "aadhaar_number", "address", "city", "state", "pincode"]
    cand = await db.candidates.find_one({"_id": ObjectId(cand_id)})
    if not cand:
        raise HTTPException(status_code=404, detail="Candidate not found")
    for key in pass_through:
        if extracted.get(key) and not cand.get(key):
            update[key] = extracted[key]
    await db.candidates.update_one({"_id": ObjectId(cand_id)}, {"$set": update})
    return {"success": True, "data": extracted}


@router.get("/meta/next-employee-id")
async def next_employee_id(current_user: dict = Depends(get_current_user)):
    """Suggest the next available Employee ID by scanning Employees + Candidates."""
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    import re as _re
    used = set()
    async for e in db.employees.find({"employee_id": {"$exists": True, "$ne": None}}, {"employee_id": 1, "_id": 0}):
        if e.get("employee_id"):
            used.add(str(e["employee_id"]).upper())
    async for c in db.candidates.find({"employee_id": {"$exists": True, "$ne": None}}, {"employee_id": 1, "_id": 0}):
        if c.get("employee_id"):
            used.add(str(c["employee_id"]).upper())
    max_num = 0
    pattern = _re.compile(r"^RMF(\d+)$", _re.IGNORECASE)
    for eid in used:
        m = pattern.match(eid)
        if m:
            try:
                max_num = max(max_num, int(m.group(1)))
            except Exception:
                pass
    suggestion = f"RMF{(max_num + 1):04d}"
    return {"suggestion": suggestion, "used_count": len(used)}


@router.get("/{cand_id}/joining-kit")
async def joining_kit_pdf(cand_id: str, current_user: dict = Depends(get_current_user)):
    """Generate a pre-filled Joining Kit PDF for a selected candidate."""
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    cand = await db.candidates.find_one({"_id": ObjectId(cand_id)})
    if not cand:
        raise HTTPException(status_code=404, detail="Candidate not found")
    if cand.get("status") != "selected":
        raise HTTPException(status_code=400, detail="Joining kit can only be generated for selected candidates.")
    if not cand.get("expected_joining_date"):
        raise HTTPException(status_code=400, detail="Set a tentative joining date before generating the kit.")
    if not cand.get("employee_id"):
        raise HTTPException(status_code=400, detail="Set an Employee ID before generating the kit.")

    docs = await db.candidate_documents.find_one({"candidate_id": cand_id}) or {}
    company = await db.app_settings.find_one({"key": "company"}) or {}

    cand_safe = {k: v for k, v in cand.items() if k != "_id"}
    company_safe = {k: v for k, v in company.items() if k not in ("_id", "key")}

    from services.joining_kit_pdf import build_joining_kit_pdf
    pdf_bytes = build_joining_kit_pdf(
        cand_safe,
        company=company_safe,
        has_aadhaar_doc=bool(docs.get("aadhaar_front") or docs.get("aadhaar_back")),
        has_pan_doc=bool(docs.get("pan_card")),
    )
    safe_name = f"{(cand.get('first_name') or '').replace(' ', '_')}_{(cand.get('last_name') or '').replace(' ', '_')}".strip("_") or "candidate"
    filename = f"JoiningKit_{safe_name}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.put("/{cand_id}/documents-checklist")
async def update_checklist(cand_id: str, checklist: dict, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    await db.candidates.update_one(
        {"_id": ObjectId(cand_id)},
        {"$set": {"documents_checklist": checklist, "updated_at": datetime.now(timezone.utc).isoformat()}},
    )
    return {"message": "Checklist updated"}
