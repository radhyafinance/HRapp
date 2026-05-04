from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional
from database import db
from auth_utils import get_current_user
from datetime import datetime, timezone, date
from bson import ObjectId

router = APIRouter()

NOTICE_PERIODS = {
    "probation_to_sm": 30,
    "probation_above_agm": 60,
    "confirmed_to_se": 60,
    "confirmed_above_se": 90,
}


def exit_to_dict(e):
    e["id"] = str(e.pop("_id"))
    return e


def calc_notice_period(emp: dict) -> int:
    status = emp.get("status", "probation")
    designation = emp.get("designation", "").lower()
    if status == "probation":
        if "agm" in designation or "gm" in designation or "director" in designation:
            return 60
        return 30
    else:
        senior = ["manager", "agm", "gm", "director", "head"]
        if any(s in designation for s in senior):
            return 90
        return 60


class ResignationRequest(BaseModel):
    employee_id: str
    resignation_date: str
    reason: str
    last_working_date: Optional[str] = None
    notice_period_waiver: bool = False


class ApproveExitRequest(BaseModel):
    action: str  # approve / reject
    remarks: Optional[str] = None


class ClearanceUpdateRequest(BaseModel):
    it_cleared: Optional[bool] = None
    finance_cleared: Optional[bool] = None
    admin_cleared: Optional[bool] = None
    hr_cleared: Optional[bool] = None


@router.post("")
async def submit_resignation(data: ResignationRequest, current_user: dict = Depends(get_current_user)):
    emp = await db.employees.find_one({"employee_id": data.employee_id})
    if not emp:
        raise HTTPException(status_code=404, detail="Employee not found")
    existing = await db.exit_requests.find_one(
        {"employee_id": data.employee_id, "status": {"$in": ["pending", "approved"]}}
    )
    if existing:
        raise HTTPException(status_code=400, detail="Exit request already in progress")
    notice_days = calc_notice_period(emp)
    resignation_date = date.fromisoformat(data.resignation_date)
    from datetime import timedelta
    lwd = data.last_working_date or (resignation_date + timedelta(days=notice_days)).isoformat()
    doc = {
        "employee_id": data.employee_id,
        "employee_name": f"{emp.get('first_name', '')} {emp.get('last_name', '')}",
        "designation": emp.get("designation", ""),
        "department": emp.get("department", ""),
        "resignation_date": data.resignation_date,
        "last_working_date": lwd,
        "notice_period_days": notice_days,
        "notice_period_waiver": data.notice_period_waiver,
        "reason": data.reason,
        "status": "pending",
        "approval_chain": [
            {"level": "Branch Manager", "status": "pending", "approver_id": None, "date": None, "remarks": None},
            {"level": "HR Admin", "status": "pending", "approver_id": None, "date": None, "remarks": None},
            {"level": "Management", "status": "pending", "approver_id": None, "date": None, "remarks": None},
        ],
        "clearance": {"it_cleared": False, "finance_cleared": False, "admin_cleared": False, "hr_cleared": False},
        "ffs_amount": None,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    result = await db.exit_requests.insert_one(doc)
    await db.employees.update_one(
        {"employee_id": data.employee_id},
        {"$set": {"status": "resigned", "resignation_date": data.resignation_date}},
    )
    doc["id"] = str(result.inserted_id)
    doc.pop("_id", None)
    return doc


@router.get("")
async def list_exits(
    status: str = None,
    current_user: dict = Depends(get_current_user),
):
    query = {}
    if current_user.get("role") in ["employee", "field_agent"]:
        query["employee_id"] = current_user.get("employee_id")
    if status:
        query["status"] = status
    exits = await db.exit_requests.find(query).sort("created_at", -1).to_list(200)
    return [exit_to_dict(e) for e in exits]


@router.put("/{exit_id}/approve")
async def approve_exit(exit_id: str, data: ApproveExitRequest, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management", "managers"]:
        raise HTTPException(status_code=403, detail="Access denied")
    exit_req = await db.exit_requests.find_one({"_id": ObjectId(exit_id)})
    if not exit_req:
        raise HTTPException(status_code=404, detail="Exit request not found")
    role = current_user.get("role")
    chain = exit_req.get("approval_chain", [])
    level_map = {"managers": "Branch Manager", "hr_admin": "HR Admin", "management": "Management"}
    level = level_map.get(role)
    updated = False
    for item in chain:
        if item["level"] == level and item["status"] == "pending":
            item["status"] = data.action
            item["approver_id"] = current_user.get("employee_id")
            item["date"] = datetime.now(timezone.utc).isoformat()
            item["remarks"] = data.remarks
            updated = True
            break
    if not updated:
        raise HTTPException(status_code=400, detail="No pending approval at your level")
    all_approved = all(item["status"] == "approve" for item in chain)
    any_rejected = any(item["status"] == "reject" for item in chain)
    new_status = "approved" if all_approved else ("rejected" if any_rejected else "pending")
    await db.exit_requests.update_one(
        {"_id": ObjectId(exit_id)},
        {"$set": {"approval_chain": chain, "status": new_status}},
    )
    return {"message": f"Exit request {data.action}d", "status": new_status}


@router.put("/{exit_id}/clearance")
async def update_clearance(exit_id: str, data: ClearanceUpdateRequest, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    update_data = {k: v for k, v in data.model_dump().items() if v is not None}
    clearance_update = {f"clearance.{k}": v for k, v in update_data.items()}
    exit_req = await db.exit_requests.find_one({"_id": ObjectId(exit_id)})
    clearance = exit_req.get("clearance", {})
    clearance.update(update_data)
    all_cleared = all(clearance.values())
    if all_cleared:
        clearance_update["status"] = "cleared"
    await db.exit_requests.update_one(
        {"_id": ObjectId(exit_id)},
        {"$set": clearance_update},
    )
    return {"message": "Clearance updated", "all_cleared": all_cleared}


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
    joining_date = emp.get("joining_date", "")
    last_date = exit_req.get("last_working_date", "")
    years_of_service = 0
    if joining_date and last_date:
        try:
            # Robust to Excel-imported 'YYYY-MM-DD HH:MM:SS' strings
            jd_str = joining_date.split(" ")[0].split("T")[0] if isinstance(joining_date, str) else ""
            ld_str = last_date.split(" ")[0].split("T")[0] if isinstance(last_date, str) else ""
            jd = date.fromisoformat(jd_str)
            ld = date.fromisoformat(ld_str)
            years_of_service = round((ld - jd).days / 365, 2)
        except Exception:
            pass
    # Salary for days worked in last month
    today = date.today()
    days_in_month = 26
    # EL encashment
    balance = await db.leave_balances.find_one(
        {"employee_id": exit_req["employee_id"], "year": today.year}
    )
    el_remaining = balance.get("EL", {}).get("remaining", 0) if balance else 0
    el_encashment = round((gross / 26) * min(el_remaining, 30), 2)
    # Gratuity (5 years+)
    gratuity = 0
    if years_of_service >= 5:
        gratuity = round((basic * 15 * years_of_service) / 26, 2)
    ffs = {
        "employee_id": exit_req["employee_id"],
        "employee_name": exit_req.get("employee_name"),
        "last_working_date": last_date,
        "years_of_service": years_of_service,
        "gross_salary": gross,
        "el_remaining_days": el_remaining,
        "el_encashment": el_encashment,
        "gratuity_eligible": years_of_service >= 5,
        "gratuity_amount": gratuity,
        "total_amount": round(el_encashment + gratuity, 2),
        "note": "Pending dues and deductions to be calculated by Accounts",
    }
    return ffs


@router.get("/{exit_id}")
async def get_exit(exit_id: str, current_user: dict = Depends(get_current_user)):
    exit_req = await db.exit_requests.find_one({"_id": ObjectId(exit_id)})
    if not exit_req:
        raise HTTPException(status_code=404, detail="Not found")
    return exit_to_dict(exit_req)
