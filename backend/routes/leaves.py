from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional
from database import db
from auth_utils import get_current_user
from datetime import datetime, timezone, date, timedelta
from bson import ObjectId

router = APIRouter()

LEAVE_TYPES = ["CL", "SL", "EL", "Maternity", "Paternity", "Marriage", "Comp-Off", "LWP"]


def leave_to_dict(l):
    l["id"] = str(l.pop("_id"))
    return l


def calc_days(start_str: str, end_str: str) -> int:
    start = date.fromisoformat(start_str)
    end = date.fromisoformat(end_str)
    return max(1, (end - start).days + 1)


class LeaveApplyRequest(BaseModel):
    employee_id: str
    leave_type: str
    start_date: str
    end_date: str
    reason: str
    medical_certificate: Optional[str] = None


class LeaveApproveRequest(BaseModel):
    action: str  # approve / reject
    remarks: Optional[str] = None


@router.post("")
async def apply_leave(data: LeaveApplyRequest, current_user: dict = Depends(get_current_user)):
    if data.leave_type not in LEAVE_TYPES:
        raise HTTPException(status_code=400, detail=f"Invalid leave type. Use: {LEAVE_TYPES}")
    days = calc_days(data.start_date, data.end_date)
    if data.leave_type not in ["Maternity", "Paternity", "LWP"]:
        balance = await db.leave_balances.find_one(
            {"employee_id": data.employee_id, "year": datetime.now(timezone.utc).year}
        )
        if balance and data.leave_type in balance:
            remaining = balance[data.leave_type].get("remaining", 0)
            if days > remaining:
                raise HTTPException(status_code=400, detail=f"Insufficient {data.leave_type} balance. Remaining: {remaining} days")
    doc = {
        "employee_id": data.employee_id,
        "leave_type": data.leave_type,
        "start_date": data.start_date,
        "end_date": data.end_date,
        "days": days,
        "reason": data.reason,
        "medical_certificate": data.medical_certificate,
        "status": "pending",
        "applied_at": datetime.now(timezone.utc).isoformat(),
        "approved_by": None,
        "approval_date": None,
        "remarks": None,
    }
    result = await db.leave_applications.insert_one(doc)
    doc["id"] = str(result.inserted_id)
    doc.pop("_id", None)
    return doc


@router.get("")
async def list_leaves(
    employee_id: str = None,
    status: str = None,
    current_user: dict = Depends(get_current_user),
):
    query = {}
    if current_user.get("role") in ["employee", "field_agent"]:
        query["employee_id"] = current_user.get("employee_id")
    elif employee_id:
        query["employee_id"] = employee_id
    if status:
        query["status"] = status
    leaves = await db.leave_applications.find(query).sort("applied_at", -1).to_list(1000)
    return [leave_to_dict(l) for l in leaves]


@router.get("/pending")
async def pending_leaves(current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management", "managers"]:
        raise HTTPException(status_code=403, detail="Access denied")
    leaves = await db.leave_applications.find({"status": "pending"}).sort("applied_at", -1).to_list(500)
    return [leave_to_dict(l) for l in leaves]


@router.get("/balance/my")
async def my_leave_balance(current_user: dict = Depends(get_current_user)):
    emp_id = current_user.get("employee_id")
    if not emp_id:
        return {"CL": {"total": 7, "used": 0, "remaining": 7},
                "SL": {"total": 15, "used": 0, "remaining": 15},
                "EL": {"total": 12, "used": 0, "remaining": 12}}
    balance = await db.leave_balances.find_one(
        {"employee_id": emp_id, "year": datetime.now(timezone.utc).year}
    )
    if not balance:
        return {"CL": {"total": 7, "used": 0, "remaining": 7},
                "SL": {"total": 15, "used": 0, "remaining": 15},
                "EL": {"total": 12, "used": 0, "remaining": 12}}
    balance.pop("_id", None)
    return balance


@router.get("/balance/{employee_id}")
async def get_leave_balance(employee_id: str, current_user: dict = Depends(get_current_user)):
    balance = await db.leave_balances.find_one(
        {"employee_id": employee_id, "year": datetime.now(timezone.utc).year}
    )
    if not balance:
        return {"employee_id": employee_id,
                "CL": {"total": 7, "used": 0, "remaining": 7},
                "SL": {"total": 15, "used": 0, "remaining": 15},
                "EL": {"total": 12, "used": 0, "remaining": 12}}
    balance.pop("_id", None)
    return balance


@router.put("/{leave_id}/approve")
async def approve_leave(leave_id: str, data: LeaveApproveRequest, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management", "managers"]:
        raise HTTPException(status_code=403, detail="Access denied")
    leave = await db.leave_applications.find_one({"_id": ObjectId(leave_id)})
    if not leave:
        raise HTTPException(status_code=404, detail="Leave application not found")
    if leave["status"] != "pending":
        raise HTTPException(status_code=400, detail="Leave is already processed")
    new_status = "approved" if data.action == "approve" else "rejected"
    await db.leave_applications.update_one(
        {"_id": ObjectId(leave_id)},
        {"$set": {
            "status": new_status,
            "approved_by": current_user.get("employee_id"),
            "approval_date": datetime.now(timezone.utc).isoformat(),
            "remarks": data.remarks,
        }},
    )
    if new_status == "approved" and leave["leave_type"] in ["CL", "SL", "EL"]:
        await db.leave_balances.update_one(
            {"employee_id": leave["employee_id"], "year": datetime.now(timezone.utc).year},
            {"$inc": {
                f"{leave['leave_type']}.used": leave["days"],
                f"{leave['leave_type']}.remaining": -leave["days"],
            }},
        )
    return {"message": f"Leave {new_status}", "status": new_status}


@router.get("/{leave_id}")
async def get_leave(leave_id: str, current_user: dict = Depends(get_current_user)):
    leave = await db.leave_applications.find_one({"_id": ObjectId(leave_id)})
    if not leave:
        raise HTTPException(status_code=404, detail="Not found")
    return leave_to_dict(leave)
