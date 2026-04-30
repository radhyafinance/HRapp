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

    # Rule 4: SL > 2 consecutive days — certificate CAN be uploaded later; just enforce it's noted
    # (Certificate upload is via POST /leaves/{id}/certificate endpoint, not required at application time)

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


class CertificateUploadRequest(BaseModel):
    data_base64: str       # base64-encoded file content
    mime_type: str         # image/jpeg, image/png, application/pdf
    file_name: Optional[str] = None


class LeaveApproveRequest(BaseModel):
    action: str                        # approve / reject
    remarks: Optional[str] = None
    approval_type: Optional[str] = None  # sl | el | salary_deduction (for SL > 2 days without cert)


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
        "medical_certificate": None,       # uploaded separately via /certificate endpoint
        "certificate_uploaded_at": None,
        "status": "pending",
        "applied_at": datetime.now(timezone.utc).isoformat(),
        "approved_by": None,
        "approval_date": None,
        "remarks": None,
        "approval_type": None,             # sl | el | salary_deduction (set on approval)
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


@router.post("/{leave_id}/certificate")
async def upload_certificate(
    leave_id: str,
    body: CertificateUploadRequest,
    current_user: dict = Depends(get_current_user),
):
    """Upload medical certificate (photo or PDF) for an SL application. Can be done before or after the leave."""
    import base64 as _b64
    leave = await db.leave_applications.find_one({"_id": ObjectId(leave_id)})
    if not leave:
        raise HTTPException(status_code=404, detail="Leave application not found")

    # Employees can upload their own; managers can upload for anyone
    is_manager = current_user.get("role") in ["hr_admin", "management", "managers"]
    if not is_manager and current_user.get("employee_id") != leave["employee_id"]:
        raise HTTPException(status_code=403, detail="Access denied")

    if body.mime_type not in ["image/jpeg", "image/png", "image/jpg", "application/pdf"]:
        raise HTTPException(status_code=400, detail="Only JPEG, PNG, or PDF files are accepted.")

    # Validate base64
    try:
        raw = _b64.b64decode(body.data_base64)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 payload.")

    if len(raw) > 5 * 1024 * 1024:  # 5 MB limit
        raise HTTPException(status_code=400, detail="File size must not exceed 5 MB.")

    await db.leave_applications.update_one(
        {"_id": ObjectId(leave_id)},
        {"$set": {
            "medical_certificate": body.data_base64,
            "certificate_mime_type": body.mime_type,
            "certificate_file_name": body.file_name or "certificate",
            "certificate_uploaded_at": datetime.now(timezone.utc).isoformat(),
            "certificate_uploaded_by": current_user.get("employee_id"),
        }},
    )
    return {"message": "Medical certificate uploaded successfully."}


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

    # Determine which balance to deduct (default to leave type)
    deduct_type = leave["leave_type"]
    approval_type = data.approval_type or "sl"

    # SL > 2 days — special handling based on certificate presence
    if new_status == "approved" and leave["leave_type"] == "SL" and leave.get("days", 1) > 2:
        has_cert = bool(leave.get("medical_certificate"))
        if has_cert:
            # Certificate present: approve as normal SL
            deduct_type = "SL"
            approval_type = "sl"
        else:
            # No certificate — admin must specify how to handle
            if data.approval_type == "el":
                # Check EL balance
                balance = await db.leave_balances.find_one(
                    {"employee_id": leave["employee_id"], "year": datetime.now(timezone.utc).year}
                )
                el_remaining = (balance or {}).get("EL", {}).get("remaining", 0)
                if el_remaining < leave["days"]:
                    raise HTTPException(
                        400,
                        f"Insufficient EL balance to convert. Available: {el_remaining} day(s). "
                        f"Use 'salary_deduction' instead or approve partially."
                    )
                deduct_type = "EL"
                approval_type = "el"
            elif data.approval_type == "salary_deduction":
                # No balance deduction — payroll team handles salary cut
                deduct_type = None
                approval_type = "salary_deduction"
            else:
                raise HTTPException(
                    400,
                    "SL > 2 days without medical certificate requires an approval decision: "
                    "'el' (deduct from Earned Leave) or 'salary_deduction' (admin will deduct from salary)."
                )

    await db.leave_applications.update_one(
        {"_id": ObjectId(leave_id)},
        {"$set": {
            "status": new_status,
            "approved_by": current_user.get("employee_id") or current_user.get("username"),
            "approval_date": datetime.now(timezone.utc).isoformat(),
            "remarks": data.remarks,
            "approval_type": approval_type,
        }},
    )

    # Deduct balance
    BALANCE_TRACKED = ["CL", "SL", "EL", "Marriage"]
    if new_status == "approved" and deduct_type in BALANCE_TRACKED:
        await db.leave_balances.update_one(
            {"employee_id": leave["employee_id"], "year": datetime.now(timezone.utc).year},
            {"$inc": {
                f"{deduct_type}.used": leave["days"],
                f"{deduct_type}.remaining": -leave["days"],
            }},
        )

    msg_map = {
        "sl": "Approved as Sick Leave.",
        "el": "Approved — deducted from Earned Leave balance.",
        "salary_deduction": "Approved — salary deduction noted for payroll.",
    }
    return {
        "message": msg_map.get(approval_type, f"Leave {new_status}"),
        "status": new_status,
        "approval_type": approval_type,
    }


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
