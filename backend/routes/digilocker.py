"""DigiLocker document download via Perfios API.

Flow:
1. POST /initiate       → call Perfios /link, store session, return DigiLocker redirect URL
2. (User authorises on DigiLocker, comes back to /digilocker/callback in frontend)
3. POST /fetch-and-store/{session_id} → get document list + download all → persist in KYC
4. GET  /session/{session_id}/status  → check completion (used by callback page)
"""

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional
from database import db
from auth_utils import get_current_user
from datetime import datetime, timezone
import os
import uuid
import httpx

router = APIRouter()

PERFIOS_BASE = "https://hub.perfios.com/api/kyc/v3/digilocker"

# DigiLocker document-type → our storage key mapping
# URI examples: "in.gov.pan-PANCR-ABCDE1234F", "in.gov.uid-ADHAR-123456789012"
_DL_TYPE_MAP = {
    "PANCR":  "pan_card",
    "ADHAR":  "aadhaar_front",
    "DRVLC":  "driving_license_front",
    "VOTERC": "voter_id_front",
    "10CBSE": "edu_10th",
    "12CBSE": "edu_12th",
    "DEGREE": "edu_graduation",
    "MGRCER": "edu_post_graduation",
}

def _map_doc_type(uri: str, name: str) -> Optional[str]:
    """Guess our storage key from a DigiLocker URI / name string."""
    upper = (uri + " " + name).upper()
    for token, key in _DL_TYPE_MAP.items():
        if token in upper:
            return key
    # Loose fallbacks
    if "PAN" in upper:
        return "pan_card"
    if "AADHAAR" in upper or "AADHAR" in upper or "ADHAR" in upper:
        return "aadhaar_front"
    if "DRIVING" in upper or "DL" in upper:
        return "driving_license_front"
    if "VOTER" in upper:
        return "voter_id_front"
    return None


class InitiateRequest(BaseModel):
    context_type: str   # "candidate" or "employee"
    context_id: str     # candidate ObjectId string OR employee_id (RMFXXXX)


@router.post("/initiate")
async def initiate_digilocker(
    body: InitiateRequest,
    current_user: dict = Depends(get_current_user),
):
    """Step 1: Create a Perfios DigiLocker session and return the redirect URL."""
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")

    if body.context_type not in ("candidate", "employee"):
        raise HTTPException(status_code=400, detail="context_type must be 'candidate' or 'employee'")

    api_key = os.environ.get("PERFIOS_API_KEY", "")
    if not api_key:
        raise HTTPException(status_code=500, detail="Perfios API key not configured")

    frontend_url = os.environ.get("FRONTEND_URL", "").rstrip("/")
    session_id = str(uuid.uuid4())
    redirect_url = f"{frontend_url}/digilocker/callback"

    payload = {
        "redirectUrl": redirect_url,
        "oAuthState": session_id,
        "aadhaarFlowRequired": False,
        "pinlessAuth": True,
        "customDocList": "",   # empty = all available documents
        "consent": "Y",
        "clientData": {"caseId": f"{body.context_type[:3]}_{body.context_id}"},
    }

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{PERFIOS_BASE}/link",
                json=payload,
                headers={"x-auth-key": api_key, "Content-Type": "application/json"},
            )
        raw = resp.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Perfios API unreachable: {e}")

    # Perfios returns accessRequestId + a URL to open DigiLocker
    access_request_id = (
        raw.get("accessRequestId")
        or raw.get("requestId")
        or raw.get("result", {}).get("accessRequestId")
    )
    digilocker_url = (
        raw.get("redirectUrl")
        or raw.get("url")
        or raw.get("authUrl")
        or raw.get("result", {}).get("redirectUrl")
    )

    if not access_request_id or not digilocker_url:
        # Surface a clean Perfios error message if present
        perfios_error = raw.get("error") or raw.get("message") or raw.get("errorMessage")
        perfios_status = raw.get("status") or raw.get("statusCode")
        if perfios_error:
            raise HTTPException(
                status_code=502,
                detail=f"Perfios DigiLocker error (status {perfios_status}): {perfios_error}",
            )
        raise HTTPException(
            status_code=502,
            detail=f"Unexpected Perfios response — missing accessRequestId or redirectUrl. Raw: {str(raw)[:200]}",
        )

    await db.digilocker_sessions.insert_one({
        "session_id": session_id,
        "access_request_id": access_request_id,
        "context_type": body.context_type,
        "context_id": body.context_id,
        "status": "pending",
        "created_by": current_user.get("employee_id") or current_user.get("username"),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "raw_init": raw,
    })

    return {
        "session_id": session_id,
        "digilocker_url": digilocker_url,
        "access_request_id": access_request_id,
    }


@router.post("/fetch-and-store/{session_id}")
async def fetch_and_store(
    session_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Step 3: After DigiLocker callback — fetch document list, download all, persist in KYC."""
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")

    session = await db.digilocker_sessions.find_one({"session_id": session_id})
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if session.get("status") == "completed":
        stored = session.get("stored_docs", [])
        return {"success": True, "already_done": True, "stored": stored, "failed": [], "message": "Already completed"}

    api_key = os.environ.get("PERFIOS_API_KEY", "")
    access_request_id = session["access_request_id"]
    context_type = session["context_type"]
    context_id = session["context_id"]
    case_id = f"{context_type[:3]}_{context_id}"

    # ── Step A: Fetch document list ──────────────────────────────────────────
    docs_payload = {
        "accessRequestId": access_request_id,
        "consent": "Y",
        "clientData": {"caseId": case_id},
    }
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            dr = await client.post(
                f"{PERFIOS_BASE}/documents",
                json=docs_payload,
                headers={"x-auth-key": api_key, "Content-Type": "application/json"},
            )
        docs_raw = dr.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch DigiLocker document list: {e}")

    # Extract list — Perfios nests differently based on version
    available = (
        docs_raw.get("documents")
        or docs_raw.get("result", {}).get("documents")
        or docs_raw.get("data", {}).get("documents")
        or []
    )

    if not available:
        await db.digilocker_sessions.update_one(
            {"session_id": session_id},
            {"$set": {"status": "no_documents", "raw_docs": docs_raw}},
        )
        return {
            "success": False,
            "message": "No documents found in DigiLocker — the user may not have any linked documents.",
            "documents": [],
            "stored": [],
            "failed": [],
        }

    # ── Step B: Download all available documents ─────────────────────────────
    download_payload = {
        "accessRequestId": access_request_id,
        "files": [
            {
                "uri": (d.get("uri") or d.get("docUri") or ""),
                "pdfB64": True,
                "parsed": False,
            }
            for d in available
            if d.get("uri") or d.get("docUri")
        ],
        "consent": "Y",
        "clientData": {"caseId": case_id},
    }

    if not download_payload["files"]:
        return {"success": False, "message": "Document URIs missing in DigiLocker list", "stored": [], "failed": []}

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            dlr = await client.post(
                f"{PERFIOS_BASE}/download",
                json=download_payload,
                headers={"x-auth-key": api_key, "Content-Type": "application/json"},
            )
        dl_raw = dlr.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to download DigiLocker documents: {e}")

    # ── Step C: Parse response and store ─────────────────────────────────────
    # Perfios response might be list or dict keyed by URI
    dl_files = (
        dl_raw.get("files")
        or dl_raw.get("documents")
        or dl_raw.get("result", {}).get("files")
        or dl_raw.get("result", {}).get("documents")
        or []
    )
    if isinstance(dl_files, dict):
        dl_files = [{"uri": k, **v} for k, v in dl_files.items()]

    stored = []
    failed = []
    now = datetime.now(timezone.utc).isoformat()
    actor = current_user.get("employee_id") or current_user.get("username")

    for item in dl_files:
        uri = item.get("uri", "")
        name = item.get("name", item.get("docType", ""))
        b64_data = item.get("pdfB64") or item.get("data") or item.get("content")

        if not b64_data:
            failed.append({"uri": uri, "reason": "no data in response"})
            continue

        doc_key = _map_doc_type(uri, name)
        if not doc_key:
            failed.append({"uri": uri, "name": name, "reason": "unrecognised document type"})
            continue

        asset = {
            "data": b64_data,
            "mime": "application/pdf",
            "file_name": f"{doc_key}_digilocker.pdf",
            "size": len(b64_data),
            "uploaded_at": now,
            "uploaded_by": actor,
            "source": "digilocker",
            "digilocker_verified": True,
            "digilocker_uri": uri,
        }

        collection = db.employee_documents if context_type == "employee" else db.candidate_documents
        pk_field = "employee_id" if context_type == "employee" else "candidate_id"

        await collection.update_one(
            {pk_field: context_id},
            {
                "$set": {doc_key: asset, "updated_at": now},
                "$setOnInsert": {pk_field: context_id, "created_at": now},
            },
            upsert=True,
        )
        stored.append(doc_key)

    # Mark session complete
    await db.digilocker_sessions.update_one(
        {"session_id": session_id},
        {"$set": {
            "status": "completed" if stored else "failed",
            "stored_docs": stored,
            "failed_docs": failed,
            "completed_at": now,
        }},
    )

    return {
        "success": bool(stored),
        "stored": stored,
        "failed": failed,
        "total_available": len(available),
        "message": (
            f"Downloaded and stored {len(stored)} document(s) from DigiLocker."
            if stored else
            "DigiLocker authorization succeeded but no recognised documents could be stored."
        ),
    }


@router.get("/session/{session_id}/status")
async def session_status(
    session_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Check status of a DigiLocker session (used by callback page)."""
    session = await db.digilocker_sessions.find_one({"session_id": session_id}, {"_id": 0, "raw_init": 0, "raw_docs": 0})
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session
