from fastapi import APIRouter, HTTPException, Depends, Response
from pydantic import BaseModel
from typing import Optional, List
from database import db
from auth_utils import get_current_user
from datetime import datetime, timezone

def get_financial_year() -> int:
    d = datetime.now(timezone.utc)
    return d.year if d.month >= 4 else d.year - 1
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
    last_name: Optional[str] = ""
    mobile: str
    email: str
    position: str
    department: str
    interview_date: Optional[str] = None
    interview_time: Optional[str] = None  # HH:MM (24-hour)
    interviewer: Optional[str] = None
    interviewer_ids: Optional[List[str]] = None  # employee_ids of assigned interviewers
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
    interviewer_ids: Optional[List[str]] = None
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
    else:
        # By default, hide converted candidates (they are now employees)
        query["status"] = {"$ne": "converted"}
    if search:
        query["$or"] = [
            {"first_name": {"$regex": search, "$options": "i"}},
            {"last_name": {"$regex": search, "$options": "i"}},
            {"mobile": {"$regex": search, "$options": "i"}},
        ]
    candidates = await db.candidates.find(query).sort("created_at", -1).to_list(1000)
    return [cand_to_dict(c) for c in candidates]


from routes.notifications import create_notification as _notify


async def _notify_interviewers(candidate: dict, interviewer_ids: List[str], event: str):
    """Send an in-app notification to each assigned interviewer.
    `event` ∈ {'scheduled', 'updated'}."""
    if not interviewer_ids:
        return
    cand_name = f"{candidate.get('first_name','')} {candidate.get('last_name','')}".strip() or "Candidate"
    position = candidate.get("position", "")
    date_str = candidate.get("interview_date") or "(date TBD)"
    time_str = candidate.get("interview_time") or ""
    cand_id = str(candidate.get("_id") or candidate.get("id") or "")
    title = (
        "Interview Assigned" if event == "scheduled" else "Interview Updated"
    )
    msg = f"{cand_name} ({position}) on {date_str}" + (f" at {time_str}" if time_str else "")
    for emp_id in interviewer_ids:
        await _notify(
            employee_id=emp_id,
            title=title,
            message=msg,
            type="interview",
            link=f"/candidates?open={cand_id}",
            meta={
                "candidate_id": cand_id,
                "candidate_name": cand_name,
                "position": position,
                "interview_date": candidate.get("interview_date"),
                "interview_time": candidate.get("interview_time"),
                "meet_link": candidate.get("meet_link"),
            },
        )


@router.get("/check-unique")
async def check_unique_field(
    field: str,
    value: str,
    exclude_candidate_id: Optional[str] = None,
    exclude_employee_id: Optional[str] = None,
):
    """Public endpoint — checks if a field value is already in use across candidates + employees."""
    ALLOWED = {"mobile", "email", "aadhaar_number", "pan_number"}
    if field not in ALLOWED:
        raise HTTPException(status_code=400, detail="Invalid field")

    val = value.strip()
    if not val:
        return {"exists": False}

    # Normalize
    if field == "email":
        val = val.lower()
    elif field == "pan_number":
        val = val.upper()

    # Check employees first
    emp_q = {field: val}
    if exclude_employee_id:
        emp_q["employee_id"] = {"$ne": exclude_employee_id}
    emp = await db.employees.find_one(emp_q, {"_id": 0, "employee_id": 1, "first_name": 1, "last_name": 1})
    if emp:
        name = f"{emp.get('first_name', '')} {emp.get('last_name', '')}".strip() or emp.get("employee_id", "Employee")
        return {"exists": True, "conflict_in": "employee", "conflict_name": name, "conflict_id": emp.get("employee_id", "")}

    # Check candidates
    cand_q = {field: val}
    if exclude_candidate_id:
        try:
            cand_q["_id"] = {"$ne": ObjectId(exclude_candidate_id)}
        except Exception:
            pass
    cand = await db.candidates.find_one(cand_q, {"_id": 1, "first_name": 1, "last_name": 1})
    if cand:
        name = f"{cand.get('first_name', '')} {cand.get('last_name', '')}".strip() or "Candidate"
        return {"exists": True, "conflict_in": "candidate", "conflict_name": name, "conflict_id": str(cand["_id"])}

    return {"exists": False}


@router.get("/interviewers/options")
async def list_interviewer_options(current_user: dict = Depends(get_current_user)):
    """Return the pool of users eligible to be assigned as interviewers.
    Includes active employees with role in (managers, management, hr_admin)."""
    if current_user.get("role") not in ["hr_admin", "management", "managers"]:
        raise HTTPException(status_code=403, detail="Access denied")
    cursor = db.employees.find(
        {
            "status": {"$in": ["active", "probation", "notice_period"]},
            "role": {"$in": ["managers", "management", "hr_admin"]},
        },
        {"_id": 0, "employee_id": 1, "first_name": 1, "last_name": 1, "designation": 1, "role": 1, "department": 1},
    ).sort("first_name", 1)
    out = []
    async for e in cursor:
        out.append({
            "employee_id": e["employee_id"],
            "name": f"{e.get('first_name','')} {e.get('last_name','')}".strip() or e["employee_id"],
            "designation": e.get("designation", ""),
            "department": e.get("department", ""),
            "role": e.get("role", ""),
        })
    return out


@router.get("/my-interviews")
async def my_interviews(
    include_past_days: int = 1,
    current_user: dict = Depends(get_current_user),
):
    """Interviews assigned to the current user — upcoming + recent past.
    Used by the Dashboard widget."""
    me = current_user.get("employee_id") or current_user.get("username")
    if not me:
        return []
    from datetime import date as DateType, timedelta
    cutoff = (DateType.today() - timedelta(days=max(0, include_past_days))).isoformat()
    q = {
        "interviewer_ids": me,
        "interview_date": {"$gte": cutoff},
    }
    cursor = db.candidates.find(q, {
        "_id": 1, "first_name": 1, "last_name": 1, "position": 1, "department": 1,
        "mobile": 1, "email": 1,
        "interview_date": 1, "interview_time": 1, "meet_link": 1,
        "status": 1, "interviewer_ids": 1,
    }).sort([("interview_date", 1), ("interview_time", 1)])
    out = []
    async for c in cursor:
        out.append({
            "id": str(c["_id"]),
            "name": f"{c.get('first_name','')} {c.get('last_name','')}".strip(),
            "position": c.get("position"),
            "department": c.get("department"),
            "mobile": c.get("mobile"),
            "email": c.get("email"),
            "interview_date": c.get("interview_date"),
            "interview_time": c.get("interview_time"),
            "meet_link": c.get("meet_link"),
            "status": c.get("status"),
        })
    return out


@router.post("")
async def create_candidate(data: CandidateCreate, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    payload = data.model_dump()
    # Normalise interviewer_ids — drop empties and dedupe
    ivr_ids = [i.strip() for i in (payload.get("interviewer_ids") or []) if i and i.strip()]
    payload["interviewer_ids"] = list(dict.fromkeys(ivr_ids))  # dedupe preserving order
    doc = {
        **payload,
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
    # Send notifications to assigned interviewers
    if doc.get("interviewer_ids") and doc.get("interview_date"):
        await _notify_interviewers({**doc, "_id": result.inserted_id}, doc["interviewer_ids"], "scheduled")
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
    existing = await db.candidates.find_one({"_id": ObjectId(cand_id)})
    if not existing:
        raise HTTPException(status_code=404, detail="Candidate not found")

    update_data = {k: v for k, v in data.model_dump().items() if v is not None}
    if "interviewer_ids" in update_data:
        cleaned = [i.strip() for i in update_data["interviewer_ids"] if i and i.strip()]
        update_data["interviewer_ids"] = list(dict.fromkeys(cleaned))
    update_data["updated_at"] = datetime.now(timezone.utc).isoformat()
    await db.candidates.update_one({"_id": ObjectId(cand_id)}, {"$set": update_data})
    cand = await db.candidates.find_one({"_id": ObjectId(cand_id)})

    # Notify — newly added interviewers get "scheduled"; existing ones get "updated"
    # only when the date/time/link changed.
    new_ids = set(cand.get("interviewer_ids") or [])
    old_ids = set(existing.get("interviewer_ids") or [])
    newly_added = list(new_ids - old_ids)
    retained = list(new_ids & old_ids)
    schedule_changed = any(
        k in update_data and update_data[k] != existing.get(k)
        for k in ("interview_date", "interview_time", "meet_link")
    )
    if newly_added:
        await _notify_interviewers(cand, newly_added, "scheduled")
    if retained and schedule_changed:
        await _notify_interviewers(cand, retained, "updated")

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
        return {"candidate_id": cand_id, "aadhaar_front": False, "aadhaar_back": False, "pan_card": False, "cv": False}
    return {
        "candidate_id": cand_id,
        "aadhaar_front": bool(doc.get("aadhaar_front")),
        "aadhaar_back": bool(doc.get("aadhaar_back")),
        "pan_card": bool(doc.get("pan_card")),
        "cv": bool(doc.get("cv")),
        "cv_file_name": (doc.get("cv") or {}).get("file_name") if doc.get("cv") else None,
    }


@router.get("/{cand_id}/documents/{doc_type}")
async def get_document_binary(
    cand_id: str,
    doc_type: str,
    current_user: dict = Depends(get_current_user),
):
    """Stream a document. doc_type: aadhaar_front | aadhaar_back | pan_card | cv."""
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    if doc_type not in {"aadhaar_front", "aadhaar_back", "pan_card", "cv"}:
        raise HTTPException(status_code=400, detail="Invalid document type")
    doc = await db.candidate_documents.find_one({"candidate_id": cand_id})
    if not doc or not doc.get(doc_type):
        raise HTTPException(status_code=404, detail="Document not found")
    asset = doc[doc_type]
    try:
        binary = base64.b64decode(asset["data"])
    except Exception:
        raise HTTPException(status_code=500, detail="Unable to decode document.")
    headers = {"Cache-Control": "private, max-age=300"}
    if doc_type == "cv" and asset.get("file_name"):
        headers["Content-Disposition"] = f'inline; filename="{asset["file_name"]}"'
    return Response(
        content=binary,
        media_type=asset.get("mime", "image/jpeg"),
        headers=headers,
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


class ConvertToEmployeeRequest(BaseModel):
    role: Optional[str] = None  # field_agent, employee, branch_manager, etc.
    ctc_monthly: float = 0  # CTC per month (₹). When >0 and basic/hra=0, server auto-distributes.
    basic: float = 0
    hra: float = 0
    special_allowance: float = 0
    canteen_allowance: float = 0
    conveyance_allowance: float = 0
    epf_employee: Optional[float] = None
    bank_name: Optional[str] = None
    account_number: Optional[str] = None
    ifsc_code: Optional[str] = None
    reporting_to: Optional[str] = None
    password: Optional[str] = None  # default Welcome@123


@router.post("/{cand_id}/convert-to-employee")
async def convert_candidate_to_employee(
    cand_id: str,
    body: ConvertToEmployeeRequest,
    current_user: dict = Depends(get_current_user),
):
    """Promote a Selected candidate to an Employee.

    Copies KYC fields, employee_id, joining date, designation, department.
    Re-keys uploaded Aadhaar/PAN images to employee_documents.
    Creates a user account with the given (or default) password.
    Initializes leave balances.
    """
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    cand = await db.candidates.find_one({"_id": ObjectId(cand_id)})
    if not cand:
        raise HTTPException(status_code=404, detail="Candidate not found")
    if cand.get("status") != "selected":
        raise HTTPException(status_code=400, detail="Only selected candidates can be converted to employees.")
    if not cand.get("employee_id"):
        raise HTTPException(status_code=400, detail="Set an Employee ID in the Joining Kit panel before converting.")
    if not cand.get("expected_joining_date"):
        raise HTTPException(status_code=400, detail="Set a Tentative Joining Date before converting.")
    if not cand.get("email"):
        raise HTTPException(status_code=400, detail="Candidate email is required to create a user account.")

    employee_id = str(cand["employee_id"]).strip().upper()
    email = str(cand["email"]).lower().strip()

    # Uniqueness checks
    if await db.employees.find_one({"employee_id": employee_id}):
        raise HTTPException(status_code=400, detail=f"Employee ID {employee_id} is already taken.")
    if await db.employees.find_one({"email": email}):
        raise HTTPException(status_code=400, detail=f"An employee with email {email} already exists.")
    if await db.users.find_one({"email": email}):
        raise HTTPException(status_code=400, detail=f"A user account with email {email} already exists.")

    # Pick a sensible role based on the candidate's position
    designation = (cand.get("position") or "").strip()
    from routes.employees import FIELD_DESIGNATIONS, RISK_DESIGNATIONS, DEPARTMENTS
    if body.role:
        role = body.role
    elif designation in FIELD_DESIGNATIONS:
        role = "field_agent"
    elif designation in RISK_DESIGNATIONS:
        role = "employee"
    elif designation in {"Branch Manager", "Senior Branch Manager"}:
        role = "managers"
    else:
        role = "employee"

    department = (cand.get("department") or "").strip()
    if department not in DEPARTMENTS:
        # Best-effort: keep but warn (HR can fix in employee detail)
        pass

    # Validate reporting_to (must be an existing Employee ID, if provided)
    reporting_to_value = (body.reporting_to or "").strip().upper() or None
    if reporting_to_value:
        rep = await db.employees.find_one({"employee_id": reporting_to_value})
        if not rep:
            raise HTTPException(status_code=400, detail=f"Reporting To: no employee with ID {reporting_to_value} found.")

    # Validate IFSC if provided
    ifsc_value = (body.ifsc_code or "").strip().upper() or None
    if ifsc_value:
        import re as _re_ifsc
        if not _re_ifsc.match(r"^[A-Z]{4}0[A-Z0-9]{6}$", ifsc_value):
            raise HTTPException(status_code=400, detail="Invalid IFSC code. Format: 4 letters + 0 + 6 alphanumeric (e.g. HDFC0001234).")

    # Salary breakup: if HR passed basic/hra etc directly, use those; else if only CTC is given, auto-distribute.
    basic = body.basic
    hra = body.hra
    special = body.special_allowance
    canteen = body.canteen_allowance
    conveyance = body.conveyance_allowance
    gross = basic + hra + special + canteen + conveyance
    ctc_monthly = body.ctc_monthly if body.ctc_monthly > 0 else gross
    ctc_annual = round(ctc_monthly * 12, 2)
    full_addr = ", ".join([p for p in [cand.get("address"), cand.get("city"), cand.get("state"), cand.get("pincode")] if p])

    emp_doc = {
        "employee_id": employee_id,
        "first_name": cand.get("first_name", ""),
        "last_name": cand.get("last_name", ""),
        "email": email,
        "mobile": cand.get("mobile", ""),
        "department": department,
        "designation": designation,
        "role": role,
        "reporting_to": reporting_to_value,
        "joining_date": cand["expected_joining_date"],
        "status": "probation",
        "salary": {
            "basic": basic,
            "hra": hra,
            "special_allowance": special,
            "canteen_allowance": canteen,
            "conveyance_allowance": conveyance,
            "gross": gross,
            "ctc_monthly": ctc_monthly,
            "ctc_annual": ctc_annual,
            "epf_employee": body.epf_employee,
        },
        "ctc_monthly": ctc_monthly,
        "ctc_annual": ctc_annual,
        "bank_details": {
            "bank_name": body.bank_name,
            "account_number": body.account_number,
            "ifsc_code": ifsc_value,
        },
        "address": {"current": full_addr, "permanent": full_addr},
        "aadhaar_number": cand.get("aadhaar_number"),
        "pan_number": cand.get("pan_number"),
        "date_of_birth": cand.get("dob"),
        "gender": cand.get("gender"),
        "father_or_husband_name": cand.get("father_or_husband_name"),
        "city": cand.get("city"),
        "state": cand.get("state"),
        "pincode": cand.get("pincode"),
        "joining_location": cand.get("joining_location"),
        "source_candidate_id": str(cand["_id"]),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "created_by": current_user.get("employee_id"),
    }
    emp_result = await db.employees.insert_one(emp_doc)
    employee_db_id = str(emp_result.inserted_id)

    # Leave balance
    await db.leave_balances.insert_one({
        "employee_id": employee_id,
        "year": get_financial_year(),
        "CL":       {"total": 7,  "used": 0, "remaining": 7},
        "SL":       {"total": 15, "used": 0, "remaining": 15},
        "EL":       {"total": 0,  "used": 0, "remaining": 0},
        "Marriage": {"total": 5,  "used": 0, "remaining": 5},
    })

    # User account — login username = employee_id
    from auth_utils import hash_password
    password = body.password or "Welcome@123"
    await db.users.insert_one({
        "username": employee_id,
        "email": email,
        "password_hash": hash_password(password),
        "name": f"{cand.get('first_name', '')} {cand.get('last_name', '')}".strip(),
        "role": role,
        "employee_id": employee_id,
        "is_active": True,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })

    # Copy KYC documents (aadhaar + pan)
    cand_docs = await db.candidate_documents.find_one({"candidate_id": cand_id})
    if cand_docs:
        emp_doc_payload = {"employee_id": employee_id, "created_at": datetime.now(timezone.utc).isoformat()}
        for key in ("aadhaar_front", "aadhaar_back", "pan_card"):
            if cand_docs.get(key):
                emp_doc_payload[key] = cand_docs[key]
        await db.employee_documents.update_one(
            {"employee_id": employee_id},
            {"$set": emp_doc_payload},
            upsert=True,
        )

    # Mark candidate as converted
    await db.candidates.update_one(
        {"_id": ObjectId(cand_id)},
        {"$set": {
            "status": "converted",
            "converted_at": datetime.now(timezone.utc).isoformat(),
            "converted_by": current_user.get("employee_id"),
            "employee_db_id": employee_db_id,
        }},
    )

    return {
        "success": True,
        "employee_id": employee_id,
        "employee_db_id": employee_db_id,
        "default_password": password,
        "message": f"{cand.get('first_name', '')} {cand.get('last_name', '')} converted to Employee {employee_id}",
    }


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


@router.get("/{cand_id}/joining-kit-docx")
async def joining_kit_docx(cand_id: str, current_user: dict = Depends(get_current_user)):
    """Generate a pre-filled Joining Kit Word (.docx) document for a selected candidate."""
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

    from services.joining_kit_docx import build_joining_kit_docx
    docx_bytes = build_joining_kit_docx(
        cand_safe,
        company=company_safe,
        has_aadhaar_doc=bool(docs.get("aadhaar_front") or docs.get("aadhaar_back")),
        has_pan_doc=bool(docs.get("pan_card")),
    )
    safe_name = f"{(cand.get('first_name') or '').replace(' ', '_')}_{(cand.get('last_name') or '').replace(' ', '_')}".strip("_") or "candidate"
    filename = f"JoiningKit_{safe_name}.docx"
    return Response(
        content=docx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
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
