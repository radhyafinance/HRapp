"""Employee Exit Management — Full Workflow
Covers: Resignation → Sequential Approvals → LWD → NOC Clearances → F&F Documents
"""
from fastapi import APIRouter, HTTPException, Depends, UploadFile, File, Form
from fastapi.responses import Response as FastAPIResponse
from pydantic import BaseModel
from typing import Optional, List
from database import db
from auth_utils import get_current_user
from datetime import datetime, timezone, date, timedelta
from bson import ObjectId
import base64

router = APIRouter()

# ──────────────────────────────────────────────────────────────
#  NOC sections configuration (mirrors the physical NOC form)
# ──────────────────────────────────────────────────────────────
NOC_SECTIONS = {
    "branch_manager": {
        "label": "Branch / Reporting Manager Clearance",
        "items": [
            "ID Card Handover",
            "Portfolio Scanning",
            "Keys (if any)",
            "Bag Handover",
            "Knowledge Transfer",
            "Handing over Records",
            "CUG SIM Card Submitted (if any)"
        ]
    },
    "accounts": {
        "label": "Accounts Clearance",
        "items": [
            "Petty Cash Settlement",
            "Branch Advance Clearance",
            "Any Other Dues"
        ]
    },
    "it": {
        "label": "IT Clearance",
        "items": [
            "Laptop / Desktop / Charger Received",
            "Mail ID Deactivation",
            "SIM Card Submitted"
        ]
    },
    "audit": {
        "label": "Audit & Risk Clearance",
        "items": [
            "Audit Clearance",
            "Others (Please Specify)"
        ]
    },
    "admin": {
        "label": "HR Clearance",
        "items": [
            "Notice Period Served",
            "Recovery (if any)",
            "Staff Advance Balance"
        ]
    }
}


def calc_notice_period(emp: dict) -> int:
    status = emp.get("status", "probation")
    designation = (emp.get("designation") or "").lower()
    if status == "probation":
        if any(x in designation for x in ["agm", "gm", "director", "manager"]):
            return 60
        return 30
    else:
        if any(s in designation for s in ["manager", "agm", "gm", "director", "head"]):
            return 90
        return 60


def add_timeline_event(timeline: list, event: str, actor: str, description: str) -> list:
    timeline.append({
        "event": event,
        "actor": actor,
        "description": description,
        "timestamp": datetime.now(timezone.utc).isoformat()
    })
    return timeline


def exit_to_dict(e: dict) -> dict:
    e = dict(e)
    e["id"] = str(e.pop("_id"))
    # Strip binary file data — return only metadata
    if e.get("resignation_letter") and isinstance(e["resignation_letter"], dict):
        if "data_base64" in e["resignation_letter"]:
            e["resignation_letter"] = {
                "has_file": True,
                "file_name": e["resignation_letter"].get("file_name", "")
            }
    fd = e.get("final_documents") or {}
    e["final_documents"] = {
        "fnf_sheet": {"has_file": True, "file_name": (fd["fnf_sheet"] or {}).get("file_name", "")} if fd.get("fnf_sheet") else None,
        "relieving_letter": {"has_file": True, "file_name": (fd["relieving_letter"] or {}).get("file_name", "")} if fd.get("relieving_letter") else None,
    }
    return e


async def _get_noc_assignments(reporting_to: str) -> dict:
    """Auto-assign NOC owners from the employee database."""
    # Accounts Manager
    acc_emp = await db.employees.find_one(
        {"designation": {"$regex": "accounts manager", "$options": "i"},
         "status": {"$in": ["active", "probation"]}},
        {"employee_id": 1, "first_name": 1, "last_name": 1}
    )
    accounts_id = acc_emp["employee_id"] if acc_emp else None
    accounts_name = (f"{acc_emp.get('first_name','')} {acc_emp.get('last_name','')}".strip()
                     if acc_emp else "Accounts Manager")

    # IT person (single person in IT department)
    it_emp = await db.employees.find_one(
        {"department": "IT", "status": {"$in": ["active", "probation"]}},
        {"employee_id": 1, "first_name": 1, "last_name": 1}
    )
    it_id = it_emp["employee_id"] if it_emp else None
    it_name = (f"{it_emp.get('first_name','')} {it_emp.get('last_name','')}".strip()
               if it_emp else "IT Team")

    # Reporting manager name
    mgr_name = "Reporting Manager"
    if reporting_to:
        mgr_emp = await db.employees.find_one({"employee_id": reporting_to}, {"first_name": 1, "last_name": 1})
        if mgr_emp:
            mgr_name = f"{mgr_emp.get('first_name','')} {mgr_emp.get('last_name','')}".strip()

    # Audit/Risk — hardcoded RMF0022
    audit_emp = await db.employees.find_one({"employee_id": "RMF0022"}, {"first_name": 1, "last_name": 1})
    audit_name = (f"{audit_emp.get('first_name','')} {audit_emp.get('last_name','')}".strip()
                  if audit_emp else "Risk & Credit Manager")

    return {
        "branch_manager": {"id": reporting_to, "name": mgr_name},
        "accounts":       {"id": accounts_id,  "name": accounts_name},
        "it":             {"id": it_id,         "name": it_name},
        "audit":          {"id": "RMF0022",     "name": audit_name},
        "admin":          {"id": None,           "name": "HR Admin"},  # any hr_admin
    }


async def _build_approval_chain(emp: dict) -> list:
    """Build sequential approval chain from employee hierarchy."""
    chain = []
    reporting_to = emp.get("reporting_to")
    if reporting_to:
        mgr = await db.employees.find_one({"employee_id": reporting_to}, {"_id": 0})
        if mgr:
            chain.append({
                "level": 1,
                "approver_id": reporting_to,
                "approver_name": f"{mgr.get('first_name','')} {mgr.get('last_name','')}".strip(),
                "approver_designation": mgr.get("designation", ""),
                "status": "pending",
                "remarks": None,
                "timestamp": None
            })
            mgr_mgr = mgr.get("reporting_to")
            if mgr_mgr:
                senior = await db.employees.find_one({"employee_id": mgr_mgr}, {"_id": 0})
                if senior:
                    chain.append({
                        "level": 2,
                        "approver_id": mgr_mgr,
                        "approver_name": f"{senior.get('first_name','')} {senior.get('last_name','')}".strip(),
                        "approver_designation": senior.get("designation", ""),
                        "status": "pending",
                        "remarks": None,
                        "timestamp": None
                    })
    chain.append({
        "level": len(chain) + 1,
        "approver_id": "admin",
        "approver_name": "Admin",
        "approver_designation": "HR Admin",
        "status": "pending",
        "remarks": None,
        "timestamp": None
    })
    return chain


# ──────────────────────────────────────────────────────────────
#  Pydantic models
# ──────────────────────────────────────────────────────────────
class ApproveExitRequest(BaseModel):
    action: str  # "approve" | "reject"
    remarks: Optional[str] = None
    last_working_day: Optional[str] = None  # required when admin gives final approval


class NOCItemUpdate(BaseModel):
    name: str
    done: bool
    remarks: Optional[str] = ""


class NOCSectionSubmit(BaseModel):
    items: List[NOCItemUpdate]
    overall_remarks: Optional[str] = ""


class UpdateLWDRequest(BaseModel):
    last_working_day: str


# ──────────────────────────────────────────────────────────────
#  Endpoints
# ──────────────────────────────────────────────────────────────
@router.post("")
async def submit_resignation(
    reason: str = Form(...),
    resignation_date: str = Form(...),
    employee_id_override: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None),
    current_user: dict = Depends(get_current_user)
):
    """Employee submits resignation. HR can submit on behalf of an employee."""
    target_emp_id = (
        employee_id_override
        if employee_id_override and current_user.get("role") == "hr_admin"
        else current_user.get("employee_id")
    )
    if not target_emp_id:
        raise HTTPException(status_code=400, detail="No employee ID found for current user")

    emp = await db.employees.find_one({"employee_id": target_emp_id})
    if not emp:
        raise HTTPException(status_code=404, detail="Employee not found")

    existing = await db.exit_requests.find_one({
        "employee_id": target_emp_id,
        "status": {"$nin": ["rejected", "completed"]}
    })
    if existing:
        raise HTTPException(status_code=400, detail="An active exit request already exists for this employee")

    # File upload
    resignation_letter = None
    if file and file.filename:
        content = await file.read()
        resignation_letter = {
            "data_base64": base64.b64encode(content).decode(),
            "mime_type": file.content_type or "application/octet-stream",
            "file_name": file.filename
        }

    approval_chain = await _build_approval_chain(emp)
    assignments = await _get_noc_assignments(emp.get("reporting_to", ""))

    # Build initial NOC clearances
    noc_clearances = {}
    for section_key, section_info in NOC_SECTIONS.items():
        asn = assignments.get(section_key, {})
        noc_clearances[section_key] = {
            "assignee_id": asn.get("id"),
            "assignee_name": asn.get("name", ""),
            "status": "pending",
            "items": [{"name": item, "done": None, "remarks": ""} for item in section_info["items"]],
            "submitted_at": None,
            "overall_remarks": ""
        }

    timeline = []
    add_timeline_event(
        timeline, "submitted",
        current_user.get("name", target_emp_id),
        f"Resignation submitted with effect from {resignation_date}."
    )

    notice_days = calc_notice_period(emp)
    doc = {
        "employee_id": target_emp_id,
        "employee_name": f"{emp.get('first_name','')} {emp.get('last_name','')}".strip(),
        "designation": emp.get("designation", ""),
        "department": emp.get("department", ""),
        "branch": emp.get("branch", ""),
        "joining_date": emp.get("joining_date", ""),
        "resignation_date": resignation_date,
        "reason": reason,
        "resignation_letter": resignation_letter,
        "notice_period_days": notice_days,
        "status": "submitted",
        "approval_chain": approval_chain,
        "last_working_day": None,
        "noc_assignments": {k: v for k, v in assignments.items()},
        "noc_clearances": noc_clearances,
        "final_documents": {"fnf_sheet": None, "relieving_letter": None},
        "timeline": timeline,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat()
    }

    result = await db.exit_requests.insert_one(doc)
    doc["id"] = str(result.inserted_id)
    doc.pop("_id", None)
    if doc.get("resignation_letter"):
        doc["resignation_letter"] = {"has_file": True, "file_name": file.filename if file else ""}
    doc["final_documents"] = {"fnf_sheet": None, "relieving_letter": None}
    return doc


@router.get("")
async def list_exits(
    status: Optional[str] = None,
    current_user: dict = Depends(get_current_user)
):
    query = {}
    role = current_user.get("role")
    emp_id = current_user.get("employee_id")

    if role in ["employee", "field_agent"]:
        query["employee_id"] = emp_id
    elif role == "managers":
        from services.hierarchy import get_descendant_employee_ids
        descendants = await get_descendant_employee_ids(emp_id) if emp_id else set()
        allowed = list(descendants) + ([emp_id] if emp_id else [])
        query["employee_id"] = {"$in": allowed}
    # hr_admin, management: no filter

    if status:
        query["status"] = status

    exits = await db.exit_requests.find(query).sort("created_at", -1).to_list(500)
    return [exit_to_dict(e) for e in exits]


@router.get("/noc-sections")
async def get_noc_sections():
    return NOC_SECTIONS


@router.get("/{exit_id}")
async def get_exit(exit_id: str, current_user: dict = Depends(get_current_user)):
    exit_req = await db.exit_requests.find_one({"_id": ObjectId(exit_id)})
    if not exit_req:
        raise HTTPException(status_code=404, detail="Not found")
    role = current_user.get("role")
    emp_id = current_user.get("employee_id")
    if role in ["employee", "field_agent"] and exit_req["employee_id"] != emp_id:
        raise HTTPException(status_code=403, detail="Access denied")
    return exit_to_dict(exit_req)


@router.put("/{exit_id}/approve")
async def approve_exit(exit_id: str, data: ApproveExitRequest, current_user: dict = Depends(get_current_user)):
    exit_req = await db.exit_requests.find_one({"_id": ObjectId(exit_id)})
    if not exit_req:
        raise HTTPException(status_code=404, detail="Exit request not found")
    if exit_req["status"] != "submitted":
        raise HTTPException(status_code=400, detail=f"Cannot approve/reject at current status: {exit_req['status']}")

    role = current_user.get("role")
    emp_id = current_user.get("employee_id")
    chain = exit_req.get("approval_chain", [])

    # Find the first pending item in the chain
    pending_item = next((item for item in chain if item["status"] == "pending"), None)
    if not pending_item:
        raise HTTPException(status_code=400, detail="No pending approvals in chain")

    # Check authorisation
    is_admin_level = pending_item["approver_id"] == "admin"
    if is_admin_level:
        if role != "hr_admin":
            raise HTTPException(status_code=403, detail="Only HR Admin can give final approval")
    else:
        if emp_id != pending_item["approver_id"]:
            raise HTTPException(status_code=403, detail="You are not the current approver for this request")

    now = datetime.now(timezone.utc).isoformat()
    pending_item["status"] = data.action
    pending_item["remarks"] = data.remarks
    pending_item["timestamp"] = now

    timeline = exit_req.get("timeline", [])
    action_label = "approved" if data.action == "approve" else "rejected"
    add_timeline_event(
        timeline, f"level_{pending_item['level']}_{action_label}",
        current_user.get("name", emp_id or "Admin"),
        f"Level {pending_item['level']} ({pending_item['approver_name']}) {action_label} the resignation."
        + (f" Remarks: {data.remarks}" if data.remarks else "")
    )

    updates = {"approval_chain": chain, "timeline": timeline, "updated_at": now}

    if data.action == "reject":
        updates["status"] = "rejected"
    else:
        all_approved = all(item["status"] == "approve" for item in chain)
        if all_approved:
            if not data.last_working_day:
                raise HTTPException(status_code=400, detail="Please set the Last Working Day when giving final approval")
            updates["status"] = "noc_in_progress"
            updates["last_working_day"] = data.last_working_day
            # Update employee status
            await db.employees.update_one(
                {"employee_id": exit_req["employee_id"]},
                {"$set": {"status": "notice_period", "last_working_day": data.last_working_day}}
            )
            add_timeline_event(
                timeline, "fully_approved", "System",
                f"Resignation fully approved. Last working day set to {data.last_working_day}. NOC process initiated."
            )
            updates["timeline"] = timeline
        # else: still "submitted", next approver becomes active

    await db.exit_requests.update_one({"_id": ObjectId(exit_id)}, {"$set": updates})
    return {"message": f"Resignation {data.action}d", "status": updates.get("status", exit_req["status"])}


@router.put("/{exit_id}/lwd")
async def update_lwd(exit_id: str, data: UpdateLWDRequest, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") != "hr_admin":
        raise HTTPException(status_code=403, detail="Only HR Admin can update Last Working Day")
    exit_req = await db.exit_requests.find_one({"_id": ObjectId(exit_id)})
    if not exit_req:
        raise HTTPException(status_code=404, detail="Not found")
    if exit_req["status"] not in ["noc_in_progress", "noc_complete"]:
        raise HTTPException(status_code=400, detail="LWD can only be updated after admin approval")
    now = datetime.now(timezone.utc).isoformat()
    timeline = exit_req.get("timeline", [])
    add_timeline_event(timeline, "lwd_updated", current_user.get("name", "Admin"),
                       f"Last Working Day updated to {data.last_working_day}")
    await db.exit_requests.update_one(
        {"_id": ObjectId(exit_id)},
        {"$set": {"last_working_day": data.last_working_day, "timeline": timeline, "updated_at": now}}
    )
    await db.employees.update_one(
        {"employee_id": exit_req["employee_id"]},
        {"$set": {"last_working_day": data.last_working_day}}
    )
    return {"message": "Last Working Day updated", "last_working_day": data.last_working_day}


@router.post("/{exit_id}/noc/{section}")
async def submit_noc_section(
    exit_id: str,
    section: str,
    data: NOCSectionSubmit,
    current_user: dict = Depends(get_current_user)
):
    if section not in NOC_SECTIONS:
        raise HTTPException(status_code=400, detail=f"Invalid NOC section: {section}")

    exit_req = await db.exit_requests.find_one({"_id": ObjectId(exit_id)})
    if not exit_req:
        raise HTTPException(status_code=404, detail="Exit request not found")
    if exit_req["status"] not in ["noc_in_progress", "noc_complete"]:
        raise HTTPException(status_code=400, detail="NOC can only be submitted after full approval")

    role = current_user.get("role")
    emp_id = current_user.get("employee_id")
    noc_clearances = exit_req.get("noc_clearances", {})
    section_data = noc_clearances.get(section, {})
    assignee_id = section_data.get("assignee_id")

    # Authorisation: exact assignee OR hr_admin
    if role != "hr_admin":
        if section == "admin":
            raise HTTPException(status_code=403, detail="Only HR Admin can submit HR Clearance")
        if not assignee_id or emp_id != assignee_id:
            raise HTTPException(status_code=403, detail="You are not the assigned NOC owner for this section")

    now = datetime.now(timezone.utc).isoformat()
    section_data["items"] = [item.model_dump() for item in data.items]
    section_data["overall_remarks"] = data.overall_remarks
    section_data["status"] = "cleared"
    section_data["submitted_at"] = now
    section_data["submitted_by_id"] = emp_id or current_user.get("username")
    section_data["submitted_by_name"] = current_user.get("name", emp_id or "")
    noc_clearances[section] = section_data

    timeline = exit_req.get("timeline", [])
    add_timeline_event(
        timeline, f"noc_{section}_cleared",
        current_user.get("name", emp_id or ""),
        f"{NOC_SECTIONS[section]['label']} cleared by {current_user.get('name', emp_id or '')}"
    )

    all_cleared = all(noc_clearances.get(s, {}).get("status") == "cleared" for s in NOC_SECTIONS)
    new_status = "noc_complete" if all_cleared else "noc_in_progress"
    if all_cleared:
        add_timeline_event(timeline, "all_nocs_cleared", "System",
                           "All NOC clearances received. Please upload F&F Sheet and Relieving Letter.")

    await db.exit_requests.update_one(
        {"_id": ObjectId(exit_id)},
        {"$set": {"noc_clearances": noc_clearances, "status": new_status, "timeline": timeline, "updated_at": now}}
    )
    return {"message": f"{section} NOC submitted", "all_cleared": all_cleared, "status": new_status}


@router.post("/{exit_id}/final-docs")
async def upload_final_docs(
    exit_id: str,
    fnf_sheet: Optional[UploadFile] = File(None),
    relieving_letter: Optional[UploadFile] = File(None),
    current_user: dict = Depends(get_current_user)
):
    if current_user.get("role") != "hr_admin":
        raise HTTPException(status_code=403, detail="Only HR Admin can upload final documents")

    exit_req = await db.exit_requests.find_one({"_id": ObjectId(exit_id)})
    if not exit_req:
        raise HTTPException(status_code=404, detail="Not found")
    if exit_req["status"] not in ["noc_complete", "completed"]:
        raise HTTPException(status_code=400, detail="Final documents require all NOCs to be cleared first")

    now = datetime.now(timezone.utc).isoformat()
    final_docs = dict(exit_req.get("final_documents") or {})
    timeline = list(exit_req.get("timeline", []))

    if fnf_sheet and fnf_sheet.filename:
        content = await fnf_sheet.read()
        final_docs["fnf_sheet"] = {
            "data_base64": base64.b64encode(content).decode(),
            "mime_type": fnf_sheet.content_type or "application/octet-stream",
            "file_name": fnf_sheet.filename
        }
        add_timeline_event(timeline, "fnf_uploaded", current_user.get("name", "Admin"),
                           f"F&F Settlement Sheet uploaded: {fnf_sheet.filename}")

    if relieving_letter and relieving_letter.filename:
        content = await relieving_letter.read()
        final_docs["relieving_letter"] = {
            "data_base64": base64.b64encode(content).decode(),
            "mime_type": relieving_letter.content_type or "application/octet-stream",
            "file_name": relieving_letter.filename
        }
        add_timeline_event(timeline, "relieving_uploaded", current_user.get("name", "Admin"),
                           f"Relieving Letter uploaded: {relieving_letter.filename}")

    both_uploaded = bool(final_docs.get("fnf_sheet")) and bool(final_docs.get("relieving_letter"))
    new_status = "completed" if both_uploaded else exit_req["status"]

    if both_uploaded and exit_req["status"] != "completed":
        add_timeline_event(timeline, "completed", "System",
                           "Exit process completed. Employee can download their documents.")
        await db.employees.update_one(
            {"employee_id": exit_req["employee_id"]}, {"$set": {"status": "exited"}}
        )
        await db.users.update_one(
            {"employee_id": exit_req["employee_id"]}, {"$set": {"is_active": False}}
        )

    await db.exit_requests.update_one(
        {"_id": ObjectId(exit_id)},
        {"$set": {"final_documents": final_docs, "status": new_status, "timeline": timeline, "updated_at": now}}
    )
    return {"message": "Documents uploaded", "status": new_status}


@router.get("/{exit_id}/download/{doc_type}")
async def download_document(exit_id: str, doc_type: str, current_user: dict = Depends(get_current_user)):
    """Download: resignation_letter | fnf_sheet | relieving_letter"""
    exit_req = await db.exit_requests.find_one({"_id": ObjectId(exit_id)})
    if not exit_req:
        raise HTTPException(status_code=404, detail="Not found")

    role = current_user.get("role")
    emp_id = current_user.get("employee_id")
    if role in ["employee", "field_agent"] and exit_req["employee_id"] != emp_id:
        raise HTTPException(status_code=403, detail="Access denied")

    file_data = None
    if doc_type == "resignation_letter":
        file_data = exit_req.get("resignation_letter")
    elif doc_type == "fnf_sheet":
        file_data = (exit_req.get("final_documents") or {}).get("fnf_sheet")
    elif doc_type == "relieving_letter":
        file_data = (exit_req.get("final_documents") or {}).get("relieving_letter")
    else:
        raise HTTPException(status_code=400, detail="Invalid document type")

    if not file_data or not file_data.get("data_base64"):
        raise HTTPException(status_code=404, detail="Document not found")

    content = base64.b64decode(file_data["data_base64"])
    return FastAPIResponse(
        content=content,
        media_type=file_data.get("mime_type", "application/octet-stream"),
        headers={"Content-Disposition": f'attachment; filename="{file_data.get("file_name", doc_type)}"'}
    )


@router.get("/{exit_id}/ffs")
async def full_final_settlement(exit_id: str, current_user: dict = Depends(get_current_user)):
    exit_req = await db.exit_requests.find_one({"_id": ObjectId(exit_id)})
    if not exit_req:
        raise HTTPException(status_code=404, detail="Not found")
    emp = await db.employees.find_one({"employee_id": exit_req["employee_id"]})
    if not emp:
        raise HTTPException(status_code=404, detail="Employee not found")

    salary = emp.get("salary", {})
    gross = salary.get("gross", 0)
    basic = salary.get("basic", 0)
    joining_date_str = emp.get("joining_date", "")
    last_date_str = exit_req.get("last_working_day", "")

    years_of_service = 0
    if joining_date_str and last_date_str:
        try:
            jd = date.fromisoformat(joining_date_str.split(" ")[0].split("T")[0])
            ld = date.fromisoformat(last_date_str.split(" ")[0].split("T")[0])
            years_of_service = round((ld - jd).days / 365, 2)
        except Exception:
            pass

    balance = await db.leave_balances.find_one({"employee_id": exit_req["employee_id"], "year": date.today().year})
    el_remaining = (balance.get("EL", {}).get("remaining", 0) if balance else 0)
    el_encashment = round((gross / 26) * min(el_remaining, 30), 2)
    gratuity = round((basic * 15 * years_of_service) / 26, 2) if years_of_service >= 5 else 0

    return {
        "employee_id": exit_req["employee_id"],
        "employee_name": exit_req.get("employee_name"),
        "last_working_date": last_date_str,
        "years_of_service": years_of_service,
        "gross_salary": gross,
        "el_remaining_days": el_remaining,
        "el_encashment": el_encashment,
        "gratuity_eligible": years_of_service >= 5,
        "gratuity_amount": gratuity,
        "total_amount": round(el_encashment + gratuity, 2),
        "note": "Pending dues and deductions to be calculated by Accounts",
    }
