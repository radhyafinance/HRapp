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
import re

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
    """Build sequential approval chain from employee hierarchy. Skips inactive/exited approvers."""
    chain = []
    reporting_to = emp.get("reporting_to")
    if reporting_to:
        mgr = await db.employees.find_one({"employee_id": reporting_to}, {"_id": 0})
        mgr_user = await db.users.find_one({"employee_id": reporting_to}, {"is_active": 1}) if mgr else None
        # Only add if manager is still active
        if mgr and mgr.get("status") not in ("exited",) and (not mgr_user or mgr_user.get("is_active", True)):
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
                senior_user = await db.users.find_one({"employee_id": mgr_mgr}, {"is_active": 1}) if senior else None
                if senior and senior.get("status") not in ("exited",) and (not senior_user or senior_user.get("is_active", True)):
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
    final_exit_type: Optional[str] = None  # "exit" | "absconding" | "terminated" — required on final approval


class UpdateExitTypeRequest(BaseModel):
    final_exit_type: str  # "exit" | "absconding" | "terminated"
    comment: str


class DirectExitRequest(BaseModel):
    employee_id: str
    final_exit_type: str  # "absconding" | "terminated"
    reason: str
    last_working_day: Optional[str] = None


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
    target_emp_id = (target_emp_id or "").strip()
    if not target_emp_id:
        raise HTTPException(status_code=400, detail="No employee ID found for current user")
    # Match exactly first; fall back to case-insensitive so "rmf0010" / "RMF0010 " still resolve.
    emp = await db.employees.find_one({"employee_id": target_emp_id})
    if not emp:
        emp = await db.employees.find_one(
            {"employee_id": {"$regex": f"^{re.escape(target_emp_id)}$", "$options": "i"}}
        )
    if not emp:
        raise HTTPException(status_code=404, detail="Employee not found")
    # Use the canonical stored ID from here on.
    target_emp_id = emp.get("employee_id", target_emp_id)
    if emp.get("status") == "exited":
        raise HTTPException(status_code=400, detail="Cannot submit resignation for an already-exited employee")

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


@router.get("/my-pending-count")
async def get_my_pending_count(current_user: dict = Depends(get_current_user)):
    """Return count of exit-related actions pending for the current user."""
    role = current_user.get("role")
    emp_id = current_user.get("employee_id")

    if role not in ("hr_admin", "managers", "management"):
        return {"total": 0, "approvals": 0, "noc": 0, "docs": 0}

    exits = await db.exit_requests.find(
        {"status": {"$in": ["submitted", "noc_in_progress", "noc_complete"]}}
    ).to_list(500)

    approval_count = 0
    noc_count = 0
    docs_count = 0

    for e in exits:
        status = e.get("status")

        if status == "submitted":
            chain = e.get("approval_chain", [])
            pending = next((a for a in chain if a.get("status") == "pending"), None)
            if pending:
                is_mine = (
                    (pending.get("approver_id") == "admin" and role == "hr_admin") or
                    (pending.get("approver_id") == emp_id)
                )
                if is_mine:
                    approval_count += 1

        elif status == "noc_in_progress":
            for section_key, sec_data in (e.get("noc_clearances") or {}).items():
                if sec_data.get("status") == "cleared":
                    continue
                assignee_id = sec_data.get("assignee_id")
                is_mine = (
                    (section_key == "admin" and role == "hr_admin") or
                    (assignee_id and assignee_id == emp_id) or
                    role == "hr_admin"  # admin can fill any section
                )
                if is_mine:
                    noc_count += 1
                    break  # 1 per exit, not per section

        elif status == "noc_complete" and role == "hr_admin":
            docs_count += 1

    total = approval_count + noc_count + docs_count
    return {"total": total, "approvals": approval_count, "noc": noc_count, "docs": docs_count}


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
    if data.action not in ("approve", "reject"):
        raise HTTPException(status_code=422, detail="Action must be 'approve' or 'reject'")

    role = current_user.get("role")
    emp_id = current_user.get("employee_id")
    chain = exit_req.get("approval_chain", [])

    # Find the first pending item in the chain
    pending_item = next((item for item in chain if item["status"] == "pending"), None)
    if not pending_item:
        raise HTTPException(status_code=400, detail="No pending approvals in chain")

    # Check authorisation
    is_admin_level = pending_item["approver_id"] == "admin"
    is_hr_or_mgmt = role in ("hr_admin", "management")

    if is_admin_level and not is_hr_or_mgmt:
        raise HTTPException(status_code=403, detail="Only HR Admin or Management can give final approval")
    elif not is_admin_level and not is_hr_or_mgmt:
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
            if not data.final_exit_type or data.final_exit_type not in ("exit", "absconding", "terminated"):
                raise HTTPException(status_code=400, detail="Please choose a final exit type: exit, absconding, or terminated")
            updates["status"] = "noc_in_progress"
            updates["last_working_day"] = data.last_working_day
            updates["final_exit_type"] = data.final_exit_type
            updates["exit_type_log"] = [{
                "final_exit_type": data.final_exit_type,
                "comment": "Set during final approval",
                "changed_by": current_user.get("name", emp_id or "Admin"),
                "timestamp": now
            }]
            # Update employee status based on exit type
            emp_status = "notice_period"  # starts in notice period; auto-exit handles actual exit
            await db.employees.update_one(
                {"employee_id": exit_req["employee_id"]},
                {"$set": {"status": emp_status, "last_working_day": data.last_working_day, "final_exit_type": data.final_exit_type}}
            )
            add_timeline_event(
                timeline, "fully_approved", "System",
                f"Resignation fully approved. Exit type: {data.final_exit_type.title()}. Last working day set to {data.last_working_day}. NOC process initiated."
            )
            # Salary is held from acceptance onwards. Payroll runs after this point
            # create their records already held; this catches the narrow case where
            # a record for this month was processed EARLIER TODAY, before the
            # resignation was accepted. Salaries go out on the last day of the
            # month, so that window is hours — but the money has not left yet, and
            # this is the last chance to stop it.
            from routes.payroll import hold_payroll_for_exit
            swept = await hold_payroll_for_exit(
                exit_req["employee_id"],
                f"Resignation accepted — held pending exit clearance "
                f"(last working day {data.last_working_day})",
                current_user.get("employee_id") or current_user.get("name") or "Admin",
            )
            if swept:
                add_timeline_event(
                    timeline, "salary_held", "System",
                    f"Salary on hold: {swept} unpaid payroll record(s) held pending exit clearance."
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
        # Clearance done — held salaries become eligible for release. This does NOT
        # pay anyone: an admin still has to approve each release on the Payroll page.
        from routes.payroll import mark_exit_holds_eligible
        eligible = await mark_exit_holds_eligible(
            exit_req["employee_id"],
            current_user.get("employee_id") or current_user.get("name") or "Admin",
        )
        if eligible:
            add_timeline_event(
                timeline, "salary_release_eligible", "System",
                f"{eligible} held salary record(s) are now ready to release. "
                f"HR Admin must approve the release on the Payroll page before payment."
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


@router.put("/{exit_id}/change-exit-type")
async def change_exit_type(exit_id: str, data: UpdateExitTypeRequest, current_user: dict = Depends(get_current_user)):
    """Change the final exit type (exit/absconding/terminated) with a mandatory comment. HR Admin only."""
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Only HR Admin or Management can change exit type")
    if data.final_exit_type not in ("exit", "absconding", "terminated"):
        raise HTTPException(status_code=422, detail="final_exit_type must be: exit, absconding, or terminated")
    try:
        oid = ObjectId(exit_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid exit ID format")
    exit_req = await db.exit_requests.find_one({"_id": oid})
    if not exit_req:
        raise HTTPException(status_code=404, detail="Exit request not found")
    if exit_req.get("status") not in ("noc_in_progress", "noc_complete", "completed"):
        raise HTTPException(status_code=400, detail="Exit type can only be changed after final approval")

    now = datetime.now(timezone.utc).isoformat()
    log_entry = {
        "final_exit_type": data.final_exit_type,
        "comment": data.comment,
        "changed_by": current_user.get("name", current_user.get("username", "Admin")),
        "timestamp": now
    }
    timeline = exit_req.get("timeline", [])
    add_timeline_event(
        timeline, "exit_type_changed",
        current_user.get("name", "Admin"),
        f"Exit type changed to '{data.final_exit_type.title()}'. Comment: {data.comment}"
    )
    await db.exit_requests.update_one(
        {"_id": oid},
        {
            "$set": {"final_exit_type": data.final_exit_type, "timeline": timeline, "updated_at": now},
            "$push": {"exit_type_log": log_entry}
        }
    )
    await db.employees.update_one(
        {"employee_id": exit_req["employee_id"]},
        {"$set": {"final_exit_type": data.final_exit_type}}
    )
    return {"message": f"Exit type updated to '{data.final_exit_type}'", "final_exit_type": data.final_exit_type}


@router.post("/direct-exit")
async def direct_exit(data: DirectExitRequest, current_user: dict = Depends(get_current_user)):
    """HR Admin directly marks an employee as absconding or terminated — bypasses resignation workflow."""
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Only HR Admin or Management can perform a direct exit")
    if data.final_exit_type not in ("absconding", "terminated"):
        raise HTTPException(status_code=422, detail="Direct exit type must be: absconding or terminated")

    emp = await db.employees.find_one({"employee_id": data.employee_id})
    if not emp:
        raise HTTPException(status_code=404, detail="Employee not found")
    if emp.get("status") == "exited":
        raise HTTPException(status_code=400, detail="Employee has already exited")

    existing = await db.exit_requests.find_one({
        "employee_id": data.employee_id,
        "status": {"$nin": ["rejected", "completed"]}
    })
    if existing:
        raise HTTPException(status_code=400, detail="An active exit request already exists for this employee")

    now = datetime.now(timezone.utc).isoformat()
    lwd = data.last_working_day or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    timeline = []
    add_timeline_event(timeline, "submitted", current_user.get("name", "Admin"),
                       f"Direct exit marked by HR. Type: {data.final_exit_type.title()}. Reason: {data.reason}")
    add_timeline_event(timeline, "fully_approved", "System",
                       f"Direct exit — no approval chain required. Last working day: {lwd}.")

    doc = {
        "employee_id": data.employee_id,
        "employee_name": f"{emp.get('first_name','')} {emp.get('last_name','')}".strip(),
        "designation": emp.get("designation", ""),
        "department": emp.get("department", ""),
        "branch": emp.get("branch", ""),
        "joining_date": emp.get("joining_date", ""),
        "resignation_date": now[:10],
        "reason": data.reason,
        "resignation_letter": None,
        "notice_period_days": 0,
        "status": "completed",
        "approval_chain": [],
        "last_working_day": lwd,
        "final_exit_type": data.final_exit_type,
        "exit_type_log": [{"final_exit_type": data.final_exit_type, "comment": f"Direct exit. Reason: {data.reason}",
                           "changed_by": current_user.get("name", "Admin"), "timestamp": now}],
        "noc_assignments": {},
        "noc_clearances": {},
        "final_documents": {"fnf_sheet": None, "relieving_letter": None},
        "timeline": timeline,
        "created_at": now,
        "updated_at": now
    }
    result = await db.exit_requests.insert_one(doc)
    doc["id"] = str(result.inserted_id)
    doc.pop("_id", None)

    await db.employees.update_one(
        {"employee_id": data.employee_id},
        {"$set": {"status": "exited", "last_working_day": lwd, "final_exit_type": data.final_exit_type}}
    )
    await db.users.update_one(
        {"employee_id": data.employee_id},
        {"$set": {"is_active": False}}
    )
    return doc


async def auto_exit_employees_past_lwd() -> dict:
    """Mark employees as exited when their Last Working Day has passed.
    Safe to call repeatedly — idempotent."""
    from datetime import date as _date
    today = _date.today()
    employees_in_notice = await db.employees.find(
        {"status": "notice_period", "last_working_day": {"$exists": True, "$ne": None}},
        {"employee_id": 1, "last_working_day": 1, "_id": 0}
    ).to_list(1000)

    exited = []
    for emp in employees_in_notice:
        try:
            lwd_raw = emp.get("last_working_day", "")
            lwd_str = lwd_raw.split("T")[0].split(" ")[0]
            lwd_date = _date.fromisoformat(lwd_str)
            if lwd_date < today:
                await db.employees.update_one(
                    {"employee_id": emp["employee_id"]},
                    {"$set": {"status": "exited"}}
                )
                await db.users.update_one(
                    {"employee_id": emp["employee_id"]},
                    {"$set": {"is_active": False}}
                )
                exited.append(emp["employee_id"])
        except Exception:
            pass
    return {"exited_count": len(exited), "exited_employees": exited}


@router.post("/admin/run-auto-exit")
async def run_auto_exit(current_user: dict = Depends(get_current_user)):
    """Manually trigger auto-exit for all employees whose LWD has passed. HR Admin only."""
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    result = await auto_exit_employees_past_lwd()
    return {
        "message": f"Auto-exit complete. {result['exited_count']} employee(s) marked as exited.",
        **result
    }


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
