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
    "aadhaar_front", "aadhaar_back", "pan_card",
    # Joining Kit checklist items
    "cancelled_cheque", "passport_photo",
    "voter_id", "driving_license",
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
    "pan_card": "PAN Card",
    "cancelled_cheque": "Cancelled Cheque / Passbook",
    "passport_photo": "Passport-size Photograph",
    "voter_id": "Voter ID",
    "driving_license": "Driving License",
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
    if current_user.get("role") not in ["hr_admin", "management", "branch_manager"]:
        # Employees can see their own
        if current_user.get("employee_id") != employee_id:
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
    current_user: dict = Depends(get_current_user),
):
    if current_user.get("role") not in ["hr_admin", "management", "branch_manager"]:
        if current_user.get("employee_id") != employee_id:
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
    return Response(
        content=binary,
        media_type=asset.get("mime", "application/octet-stream"),
        headers={
            "Content-Disposition": f'inline; filename="{file_name}"',
            "Cache-Control": "private, max-age=300",
        },
    )
