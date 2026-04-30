from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional
from database import db
from auth_utils import get_current_user
from datetime import datetime, timezone, date, timedelta
from bson import ObjectId

router = APIRouter()

LEAVE_TYPES = ["CL", "SL", "EL", "Maternity", "Paternity", "Marriage", "Comp-Off", "LWP"]

LEAVE_BALANCE_TEMPLATE = {
    "CL":       {"total": 7,  "used": 0, "remaining": 7},
    "SL":       {"total": 15, "used": 0, "remaining": 15},
    "EL":       {"total": 0,  "used": 0, "remaining": 0},
    "Marriage": {"total": 5,  "used": 0, "remaining": 5},
}


def leave_to_dict(l):
    l["id"] = str(l.pop("_id"))
    return l


def calc_days(start_str: str, end_str: str) -> int:
    start = date.fromisoformat(start_str)
    end = date.fromisoformat(end_str)
    return max(1, (end - start).days + 1)


async def validate_leave_application(data, employee: dict):
    """Enforce all 10 company leave policy rules."""
    days = calc_days(data.start_date, data.end_date)
    today = date.today()
    start = date.fromisoformat(data.start_date)
    end = date.fromisoformat(data.end_date)

    # Rule 1: Marriage leave — 5 days max, once per employment, own marriage
    if data.leave_type == "Marriage":
        if days > 5:
            raise HTTPException(400, "Marriage leave cannot exceed 5 days.")
        existing = await db.leave_applications.count_documents({
            "employee_id": data.employee_id,
            "leave_type": "Marriage",
            "status": {"$ne": "rejected"},
        })
        if existing > 0:
            raise HTTPException(400, "Marriage leave can only be availed once during employment.")

    # Rule 2: CL max 2 days at a time
    if data.leave_type == "CL" and days > 2:
        raise HTTPException(
            400,
            "Casual Leave (CL) cannot exceed 2 consecutive days at a time. "
            "Additional days will be treated as Earned Leave (EL) or unauthorised leave."
        )

    # Rule 4: SL > 2 consecutive days requires medical certificate
    if data.leave_type == "SL" and days > 2 and not data.medical_certificate:
        raise HTTPException(
            400,
            "A medical certificate is mandatory for Sick Leave (SL) exceeding 2 consecutive days. "
            "Please upload the certificate before submitting."
        )

    # Rule 5: SL and CL cannot be clubbed together
    if data.leave_type in ["SL", "CL"]:
        other_type = "CL" if data.leave_type == "SL" else "SL"
        window_start = (start - timedelta(days=1)).isoformat()
        window_end = (end + timedelta(days=1)).isoformat()
        conflict = await db.leave_applications.count_documents({
            "employee_id": data.employee_id,
            "leave_type": other_type,
            "status": {"$ne": "rejected"},
            "start_date": {"$lte": window_end},
            "end_date": {"$gte": window_start},
        })
        if conflict > 0:
            raise HTTPException(
                400,
                f"SL and CL cannot be clubbed together under any circumstances. "
                f"You have an existing {other_type} application adjacent to or overlapping these dates."
            )

    # Rule 6: EL accrual starts after 6 months of employment
    if data.leave_type == "EL":
        joining_str = employee.get("joining_date") or employee.get("salary", {}).get("joining_date")
        if joining_str:
            try:
                joining = date.fromisoformat(joining_str)
                eligible_from = joining + timedelta(days=183)  # 6 months
                if today < eligible_from:
                    remaining_days = (eligible_from - today).days
                    raise HTTPException(
                        400,
                        f"Earned Leave (EL) starts accruing after 6 months of employment. "
                        f"You will be eligible in {remaining_days} more day(s) "
                        f"(from {eligible_from.strftime('%d %b %Y')})."
                    )
            except (ValueError, TypeError):
                pass
        # Rule 10: No EL during approved maternity leave period
        maternity_leaves = await db.leave_applications.find({
            "employee_id": data.employee_id,
            "leave_type": "Maternity",
            "status": "approved",
        }).to_list(100)
        for ml in maternity_leaves:
            ml_start = date.fromisoformat(ml["start_date"])
            ml_end = date.fromisoformat(ml["end_date"])
            if start <= ml_end and end >= ml_start:
                raise HTTPException(
                    400,
                    "Earned Leave (EL) cannot be availed during the maternity leave period as per company policy."
                )

    # Rule 8: Paternity — 15 days advance notice, max 2 times
    if data.leave_type == "Paternity":
        notice = (start - today).days
        if notice < 15:
            raise HTTPException(
                400,
                f"Paternity leave requires at least 15 days advance notice. "
                f"Please apply at least 15 days before your expected start date."
            )
        count = await db.leave_applications.count_documents({
            "employee_id": data.employee_id,
            "leave_type": "Paternity",
            "status": {"$ne": "rejected"},
        })
        if count >= 2:
            raise HTTPException(400, "Paternity leave can only be availed up to 2 times during employment.")

    # Rule 9: Maternity — 30 days advance notice, max 2 times
    if data.leave_type == "Maternity":
        notice = (start - today).days
        if notice < 30:
            raise HTTPException(
                400,
                f"Maternity leave requires at least 30 days advance notice. "
                f"Please apply at least 30 days before your expected start date."
            )
        count = await db.leave_applications.count_documents({
            "employee_id": data.employee_id,
            "leave_type": "Maternity",
            "status": {"$ne": "rejected"},
        })
        if count >= 2:
            raise HTTPException(400, "Maternity leave can only be availed up to 2 times during employment.")


class LeaveApplyRequest(BaseModel):
    employee_id: str
    leave_type: str
    start_date: str
    end_date: str
    reason: str
    medical_certificate: Optional[str] = None  # base64 or URL; required for SL > 2 days


class LeaveApproveRequest(BaseModel):
    action: str  # approve / reject
    remarks: Optional[str] = None


class EncashmentRequest(BaseModel):
    employee_id: str
    days_to_encash: int
    remarks: Optional[str] = None


@router.post("")
async def apply_leave(data: LeaveApplyRequest, current_user: dict = Depends(get_current_user)):
    if data.leave_type not in LEAVE_TYPES:
        raise HTTPException(status_code=400, detail=f"Invalid leave type. Allowed: {LEAVE_TYPES}")

    # Fetch employee for joining date (Rule 6) and other checks
    emp_id = data.employee_id or current_user.get("employee_id")
    employee = await db.employees.find_one({"employee_id": emp_id}) or {}

    # Run all policy validations
    await validate_leave_application(data, employee)

    days = calc_days(data.start_date, data.end_date)

    # Balance check for quota-tracked types
    if data.leave_type not in ["Maternity", "Paternity", "LWP", "Comp-Off"]:
        balance = await db.leave_balances.find_one(
            {"employee_id": emp_id, "year": datetime.now(timezone.utc).year}
        )
        if balance and data.leave_type in balance:
            remaining = balance[data.leave_type].get("remaining", 0)
            if days > remaining:
                raise HTTPException(
                    status_code=400,
                    detail=f"Insufficient {data.leave_type} balance. Remaining: {remaining} day(s)."
                )

    doc = {
        "employee_id": emp_id,
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
        return LEAVE_BALANCE_TEMPLATE
    balance = await db.leave_balances.find_one(
        {"employee_id": emp_id, "year": datetime.now(timezone.utc).year}
    )
    if not balance:
        return LEAVE_BALANCE_TEMPLATE
    balance.pop("_id", None)
    return balance


@router.get("/balance/{employee_id}")
async def get_leave_balance(employee_id: str, current_user: dict = Depends(get_current_user)):
    balance = await db.leave_balances.find_one(
        {"employee_id": employee_id, "year": datetime.now(timezone.utc).year}
    )
    if not balance:
        return {"employee_id": employee_id, **LEAVE_BALANCE_TEMPLATE}
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
    # Deduct balance for quota-tracked types on approval
    BALANCE_TRACKED = ["CL", "SL", "EL", "Marriage"]
    if new_status == "approved" and leave["leave_type"] in BALANCE_TRACKED:
        await db.leave_balances.update_one(
            {"employee_id": leave["employee_id"], "year": datetime.now(timezone.utc).year},
            {"$inc": {
                f"{leave['leave_type']}.used": leave["days"],
                f"{leave['leave_type']}.remaining": -leave["days"],
            }},
        )
    return {"message": f"Leave {new_status}", "status": new_status}


@router.post("/admin/credit-halfyear")
async def credit_halfyear_leaves(current_user: dict = Depends(get_current_user)):
    """
    Rule 3: SL and CL credited on half-yearly basis.
    HR Admin triggers this on Jan 1 (H1) and Jul 1 (H2) each year.
    Credits 3.5 CL and 7.5 SL per half-year to all active employees.
    """
    if current_user.get("role") != "hr_admin":
        raise HTTPException(status_code=403, detail="HR Admin only")

    today = datetime.now(timezone.utc)
    year = today.year
    half = "H1" if today.month <= 6 else "H2"
    flag_key = f"credited_{half}_{year}"

    employees = await db.employees.find(
        {"status": {"$in": ["active", "probation"]}},
        {"employee_id": 1, "_id": 0}
    ).to_list(1000)

    credited = 0
    skipped = 0
    for emp in employees:
        emp_id = emp["employee_id"]
        balance = await db.leave_balances.find_one(
            {"employee_id": emp_id, "year": year}
        )
        if not balance:
            continue
        if balance.get(flag_key):
            skipped += 1
            continue
        await db.leave_balances.update_one(
            {"employee_id": emp_id, "year": year},
            {"$inc": {
                "CL.total": 3,   # 3 CL per half (total 6 + 1 carry = 7 approx)
                "CL.remaining": 3,
                "SL.total": 7,   # 7 SL per half (total 14 + 1 = 15 approx)
                "SL.remaining": 7,
            }, "$set": {flag_key: True}},
        )
        credited += 1

    return {
        "message": f"{half} {year} leave credit completed.",
        "credited": credited,
        "skipped_already_credited": skipped,
    }


@router.post("/encashment-request")
async def request_el_encashment(data: EncashmentRequest, current_user: dict = Depends(get_current_user)):
    """
    Rule 7: EL encashment after 3 years of service, min 30 EL accumulated.
    Request must be submitted within 30 days from end of financial year.
    """
    if current_user.get("role") not in ["hr_admin", "management", "managers"]:
        if current_user.get("employee_id") != data.employee_id:
            raise HTTPException(status_code=403, detail="Access denied")

    employee = await db.employees.find_one({"employee_id": data.employee_id})
    if not employee:
        raise HTTPException(status_code=404, detail="Employee not found")

    # Check 3 years of service
    joining_str = employee.get("joining_date")
    if joining_str:
        joining = date.fromisoformat(joining_str)
        three_years = joining + timedelta(days=3 * 365)
        if date.today() < three_years:
            raise HTTPException(
                400,
                f"EL encashment is only allowed after 3 years of service. "
                f"Eligible from {three_years.strftime('%d %b %Y')}."
            )

    # Check minimum 30 EL balance
    balance = await db.leave_balances.find_one(
        {"employee_id": data.employee_id, "year": datetime.now(timezone.utc).year}
    )
    el_remaining = (balance or {}).get("EL", {}).get("remaining", 0)
    if el_remaining < 30:
        raise HTTPException(
            400,
            f"Minimum 30 EL required for encashment. Current EL balance: {el_remaining} days."
        )
    if data.days_to_encash > el_remaining:
        raise HTTPException(400, f"Cannot encash more than available EL balance ({el_remaining} days).")

    doc = {
        "employee_id": data.employee_id,
        "type": "EL_encashment",
        "days_to_encash": data.days_to_encash,
        "remarks": data.remarks,
        "status": "pending",
        "requested_at": datetime.now(timezone.utc).isoformat(),
        "processed_by": None,
        "processed_at": None,
    }
    result = await db.leave_applications.insert_one(doc)
    doc["id"] = str(result.inserted_id)
    doc.pop("_id", None)
    return doc


@router.get("/{leave_id}")
async def get_leave(leave_id: str, current_user: dict = Depends(get_current_user)):
    leave = await db.leave_applications.find_one({"_id": ObjectId(leave_id)})
    if not leave:
        raise HTTPException(status_code=404, detail="Not found")
    return leave_to_dict(leave)
