"""Employee document storage endpoints.

Stores arbitrary KYC / joining-kit documents per employee in `employee_documents`
collection (one mongo doc per employee, fields keyed by doc_type, base64-encoded).
"""
from fastapi import APIRouter, HTTPException, Depends, Response
from pydantic import BaseModel
from typing import Optional
from database import db
from auth_utils import get_current_user
from datetime import datetime, timezone
import base64

router = APIRouter()

# Allowed doc keys (joining kit checklist + KYC + joining kit PDF)
ALLOWED_DOC_TYPES = {
    # KYC
    "aadhaar_front", "aadhaar_back", "aadhaar_digilocker", "pan_card",
    # Joining Kit checklist items
    "cancelled_cheque", "passport_photo",
    "voter_id_front", "voter_id_back",
    "driving_license_front", "driving_license_back",
    "edu_10th", "edu_12th", "edu_graduation", "edu_post_graduation",
    "edu_phd", "edu_other",
    "bike_rc", "bike_puc_insurance",
    "police_verification",
    "pf_proof", "esic_proof",
    # Generated
    "joining_kit_pdf",
    # Free-form: signed copy upload of the kit, medical form, etc.
    "signed_joining_kit", "medical_form",
}

DOC_LABELS = {
    "aadhaar_front": "Aadhaar Card — Front",
    "aadhaar_back": "Aadhaar Card — Back",
    "aadhaar_digilocker": "Aadhaar (DigiLocker Verified)",
    "pan_card": "PAN Card",
    "cancelled_cheque": "Cancelled Cheque / Passbook",
    "passport_photo": "Passport-size Photograph",
    "voter_id_front": "Voter ID — Front",
    "voter_id_back": "Voter ID — Back",
    "driving_license_front": "Driving License — Front",
    "driving_license_back": "Driving License — Back",
    "edu_10th": "10th Standard Certificate",
    "edu_12th": "12th Standard Certificate",
    "edu_graduation": "Graduation Certificate",
    "edu_post_graduation": "Post-Graduation Certificate",
    "edu_phd": "Ph.D Certificate",
    "edu_other": "Other Qualification",
    "bike_rc": "Bike Registration Certificate (RC)",
    "bike_puc_insurance": "Bike PUC / Insurance",
    "police_verification": "Police Verification Report",
    "pf_proof": "PF Proof Document",
    "esic_proof": "ESIC Proof Document",
    "joining_kit_pdf": "Joining Kit PDF (generated / signed)",
    "signed_joining_kit": "Signed Joining Kit (uploaded back by employee)",
    "medical_form": "Employee Medical Form",
}


class UploadDocumentRequest(BaseModel):
    doc_type: str
    data_base64: str
    mime_type: str = "application/octet-stream"
    file_name: Optional[str] = None


@router.get("/{employee_id}/documents")
async def list_documents(employee_id: str, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    doc = await db.employee_documents.find_one({"employee_id": employee_id})
    out = {}
    for dtype in ALLOWED_DOC_TYPES:
        if doc and isinstance(doc.get(dtype), dict):
            asset = doc[dtype]
            out[dtype] = {
                "label": DOC_LABELS.get(dtype, dtype),
                "uploaded": True,
                "file_name": asset.get("file_name"),
                "mime": asset.get("mime"),
                "size": asset.get("size"),
                "uploaded_at": asset.get("uploaded_at"),
                "source": asset.get("source"),
                "digilocker_verified": asset.get("digilocker_verified", False),
                "aadhaar_data": asset.get("aadhaar_data"),
            }
        else:
            out[dtype] = {"label": DOC_LABELS.get(dtype, dtype), "uploaded": False}
    return {"employee_id": employee_id, "documents": out}


@router.post("/{employee_id}/documents")
async def upload_document(
    employee_id: str,
    body: UploadDocumentRequest,
    current_user: dict = Depends(get_current_user),
):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    if body.doc_type not in ALLOWED_DOC_TYPES:
        raise HTTPException(status_code=400, detail=f"Invalid document type {body.doc_type}.")

    emp = await db.employees.find_one({"employee_id": employee_id})
    if not emp:
        raise HTTPException(status_code=404, detail="Employee not found")

    try:
        raw = base64.b64decode(body.data_base64)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 payload.")
    size_bytes = len(raw)
    # Hard cap 5 MB per document (frontend should compress before)
    if size_bytes > 5 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large. Please keep documents under 5 MB.")

    asset = {
        "data": body.data_base64,
        "mime": body.mime_type,
        "file_name": body.file_name,
        "size": size_bytes,
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
        "uploaded_by": current_user.get("employee_id"),
    }
    await db.employee_documents.update_one(
        {"employee_id": employee_id},
        {
            "$set": {body.doc_type: asset, "updated_at": datetime.now(timezone.utc).isoformat()},
            "$setOnInsert": {"employee_id": employee_id, "created_at": datetime.now(timezone.utc).isoformat()},
        },
        upsert=True,
    )
    return {"success": True, "doc_type": body.doc_type, "size": size_bytes}


@router.get("/document-completeness/all")
async def document_completeness_all(current_user: dict = Depends(get_current_user)):
    """Return a map of employee_id -> {uploaded, total, percent} for all employees."""
    if current_user.get("role") not in ["hr_admin", "management", "managers"]:
        raise HTTPException(status_code=403, detail="Access denied")
    # DigiLocker Aadhaar is an optional supplement to the manual Aadhaar upload, not a separate requirement
    countable = ALLOWED_DOC_TYPES - {"aadhaar_digilocker"}
    total = len(countable)
    out = {}
    async for d in db.employee_documents.find({}):
        emp_id = d.get("employee_id")
        if not emp_id:
            continue
        uploaded = sum(1 for k in countable if isinstance(d.get(k), dict))
        out[emp_id] = {"uploaded": uploaded, "total": total, "percent": round(uploaded * 100 / total)}
    return {"total_doc_types": total, "completeness": out}


@router.get("/{employee_id}/joining-kit")
async def generate_employee_joining_kit(employee_id: str, current_user: dict = Depends(get_current_user)):
    """Build the bilingual joining kit PDF on-demand from the employee's current data."""
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    emp = await db.employees.find_one({"employee_id": employee_id})
    if not emp:
        raise HTTPException(status_code=404, detail="Employee not found")
    docs = await db.employee_documents.find_one({"employee_id": employee_id}) or {}
    company = await db.app_settings.find_one({"key": "company"}) or {}

    # Map employee fields to the candidate-shaped dict the PDF builder expects.
    addr_obj = emp.get("address", {}) if isinstance(emp.get("address"), dict) else {}
    cand_like = {
        "first_name": emp.get("first_name", ""),
        "last_name": emp.get("last_name", ""),
        "email": emp.get("email", ""),
        "mobile": emp.get("mobile", ""),
        "position": emp.get("designation", ""),
        "department": emp.get("department", ""),
        "expected_joining_date": emp.get("joining_date") or "",
        "joining_location": emp.get("joining_location") or "Head Office, Moradabad",
        "employee_id": emp.get("employee_id", ""),
        "dob": emp.get("date_of_birth", ""),
        "gender": emp.get("gender", ""),
        "father_or_husband_name": emp.get("father_or_husband_name", ""),
        "aadhaar_number": emp.get("aadhaar_number", ""),
        "pan_number": emp.get("pan_number", ""),
        "address": addr_obj.get("permanent") or addr_obj.get("current") or "",
        "city": emp.get("city", ""),
        "state": emp.get("state", ""),
        "pincode": emp.get("pincode", ""),
    }
    company_safe = {k: v for k, v in company.items() if k not in ("_id", "key")}

    from services.joining_kit_pdf import build_joining_kit_pdf
    pdf_bytes = build_joining_kit_pdf(
        cand_like,
        company=company_safe,
        has_aadhaar_doc=bool(docs.get("aadhaar_front") or docs.get("aadhaar_back")),
        has_pan_doc=bool(docs.get("pan_card")),
    )
    safe_name = f"{(emp.get('first_name') or '').replace(' ', '_')}_{(emp.get('last_name') or '').replace(' ', '_')}".strip("_") or "employee"
    filename = f"JoiningKit_{employee_id}_{safe_name}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.delete("/{employee_id}/documents/{doc_type}")
async def delete_document(employee_id: str, doc_type: str, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    if doc_type not in ALLOWED_DOC_TYPES:
        raise HTTPException(status_code=400, detail="Invalid document type.")
    await db.employee_documents.update_one(
        {"employee_id": employee_id},
        {"$unset": {doc_type: ""}, "$set": {"updated_at": datetime.now(timezone.utc).isoformat()}},
    )
    return {"success": True, "doc_type": doc_type}


@router.get("/{employee_id}/documents/{doc_type}/file")
async def download_document(
    employee_id: str,
    doc_type: str,
    as_attachment: bool = False,
    current_user: dict = Depends(get_current_user),
):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    if doc_type not in ALLOWED_DOC_TYPES:
        raise HTTPException(status_code=400, detail="Invalid document type.")
    doc = await db.employee_documents.find_one({"employee_id": employee_id})
    if not doc or not doc.get(doc_type):
        raise HTTPException(status_code=404, detail="Document not found")
    asset = doc[doc_type]
    try:
        binary = base64.b64decode(asset["data"])
    except Exception:
        raise HTTPException(status_code=500, detail="Failed to decode document.")
    file_name = asset.get("file_name") or f"{doc_type}.bin"
    disposition = "attachment" if as_attachment else "inline"
    return Response(
        content=binary,
        media_type=asset.get("mime", "application/octet-stream"),
        headers={
            "Content-Disposition": f'{disposition}; filename="{file_name}"',
            "Cache-Control": "private, max-age=300",
        },
    )
