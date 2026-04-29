from fastapi import APIRouter, HTTPException, Depends, UploadFile, File
from pydantic import BaseModel
from typing import Optional, List
from database import db
from auth_utils import get_current_user, hash_password
from datetime import datetime, timezone
from bson import ObjectId
import csv
import io

router = APIRouter()

ROLES = ["hr_admin", "management", "branch_manager", "employee", "field_agent"]

DEPARTMENTS = [
    "Accounts",
    "Administration",
    "Compliance",
    "Human Resources",
    "IT",
    "Operations",
    "Risk and Credit",
]

# Field Team
FIELD_DESIGNATIONS = [
    "Divisional Manager",
    "Area Manager",
    "Senior Branch Manager",
    "Branch Manager",
    "Senior Field Officer",
    "Field Officer",
]

# Risk Team (reports to management)
RISK_DESIGNATIONS = [
    "Audit Manager",
    "Credit Officer",
]

# Head Office
HO_DESIGNATIONS = [
    "Chief Executive Officer",
    "Chief Operating Officer",
    "Company Secretary",
    "HR Manager",
    "Accounts Manager",
    "Senior Manager",
    "Manager",
    "Senior Executive",
    "Executive",
    "Assistant",
]

DESIGNATIONS = HO_DESIGNATIONS + FIELD_DESIGNATIONS + RISK_DESIGNATIONS

DESIGNATION_GROUPS = {
    "Head Office": HO_DESIGNATIONS,
    "Field Team": FIELD_DESIGNATIONS,
    "Risk Team": RISK_DESIGNATIONS,
}


def emp_to_dict(emp):
    emp["id"] = str(emp.pop("_id"))
    return emp


async def get_next_employee_id():
    last = await db.employees.find_one({}, sort=[("employee_id", -1)])
    if not last:
        return "RMF0001"
    last_id = last.get("employee_id", "RMF0000")
    try:
        num = int(last_id.replace("RMF", "")) + 1
        return f"RMF{num:04d}"
    except Exception:
        return "RMF0001"


class EmployeeCreate(BaseModel):
    first_name: str
    last_name: str
    email: str
    mobile: str
    department: str
    designation: str
    role: str
    reporting_to: Optional[str] = None
    joining_date: str
    basic: float
    hra: float
    special_allowance: float = 0
    canteen_allowance: float = 0
    conveyance_allowance: float = 0
    bank_name: Optional[str] = None
    account_number: Optional[str] = None
    ifsc_code: Optional[str] = None
    address_current: Optional[str] = None
    address_permanent: Optional[str] = None
    aadhaar_number: Optional[str] = None
    pan_number: Optional[str] = None
    emergency_contact_name: Optional[str] = None
    emergency_contact_mobile: Optional[str] = None
    date_of_birth: Optional[str] = None
    gender: Optional[str] = None
    blood_group: Optional[str] = None
    uan_number: Optional[str] = None
    esi_number: Optional[str] = None
    create_user_account: bool = True
    password: Optional[str] = None


class EmployeeUpdate(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[str] = None
    mobile: Optional[str] = None
    department: Optional[str] = None
    designation: Optional[str] = None
    role: Optional[str] = None
    reporting_to: Optional[str] = None
    joining_date: Optional[str] = None
    date_of_birth: Optional[str] = None
    gender: Optional[str] = None
    father_or_husband_name: Optional[str] = None
    aadhaar_number: Optional[str] = None
    pan_number: Optional[str] = None
    blood_group: Optional[str] = None
    emergency_contact_name: Optional[str] = None
    emergency_contact_mobile: Optional[str] = None
    basic: Optional[float] = None
    hra: Optional[float] = None
    special_allowance: Optional[float] = None
    canteen_allowance: Optional[float] = None
    conveyance_allowance: Optional[float] = None
    ctc_monthly: Optional[float] = None
    bank_name: Optional[str] = None
    account_number: Optional[str] = None
    ifsc_code: Optional[str] = None
    address_current: Optional[str] = None
    address_permanent: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    pincode: Optional[str] = None
    joining_location: Optional[str] = None
    status: Optional[str] = None
    uan_number: Optional[str] = None
    esi_number: Optional[str] = None
    epf_employee: Optional[float] = None


@router.get("/next-id")
async def next_employee_id(current_user: dict = Depends(get_current_user)):
    return {"next_id": await get_next_employee_id()}


@router.get("/designations")
async def get_designations(current_user: dict = Depends(get_current_user)):
    return {
        "departments": DEPARTMENTS,
        "groups": DESIGNATION_GROUPS,
        "all": DESIGNATIONS,
    }


@router.get("")
async def list_employees(
    status: str = "all",
    department: str = None,
    role: str = None,
    search: str = None,
    current_user: dict = Depends(get_current_user),
):
    query = {}
    if status and status != "all":
        query["status"] = status
    if department:
        query["department"] = department
    if role:
        query["role"] = role
    if search:
        query["$or"] = [
            {"first_name": {"$regex": search, "$options": "i"}},
            {"last_name": {"$regex": search, "$options": "i"}},
            {"employee_id": {"$regex": search, "$options": "i"}},
            {"email": {"$regex": search, "$options": "i"}},
        ]
    emps = await db.employees.find(query).sort("employee_id", 1).to_list(1000)
    return [emp_to_dict(e) for e in emps]


@router.post("")
async def create_employee(data: EmployeeCreate, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    existing = await db.employees.find_one({"email": data.email.lower()})
    if existing:
        raise HTTPException(status_code=400, detail="Employee with this email already exists")
    employee_id = await get_next_employee_id()
    gross = data.basic + data.hra + data.special_allowance + data.canteen_allowance + data.conveyance_allowance
    emp_doc = {
        "employee_id": employee_id,
        "first_name": data.first_name,
        "last_name": data.last_name,
        "email": data.email.lower(),
        "mobile": data.mobile,
        "department": data.department,
        "designation": data.designation,
        "role": data.role,
        "reporting_to": data.reporting_to,
        "joining_date": data.joining_date,
        "status": "probation",
        "salary": {
            "basic": data.basic,
            "hra": data.hra,
            "special_allowance": data.special_allowance,
            "canteen_allowance": data.canteen_allowance,
            "conveyance_allowance": data.conveyance_allowance,
            "gross": gross,
            "epf_employee": data.epf_employee,
        },
        "bank_details": {
            "bank_name": data.bank_name,
            "account_number": data.account_number,
            "ifsc_code": data.ifsc_code,
        },
        "address": {"current": data.address_current, "permanent": data.address_permanent},
        "aadhaar_number": data.aadhaar_number,
        "pan_number": data.pan_number,
        "emergency_contact": {"name": data.emergency_contact_name, "mobile": data.emergency_contact_mobile},
        "date_of_birth": data.date_of_birth,
        "gender": data.gender,
        "blood_group": data.blood_group,
        "uan_number": data.uan_number,
        "esi_number": data.esi_number,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "created_by": current_user.get("employee_id"),
    }
    result = await db.employees.insert_one(emp_doc)
    # Initialize leave balance
    await db.leave_balances.insert_one({
        "employee_id": employee_id,
        "year": datetime.now(timezone.utc).year,
        "CL": {"total": 7, "used": 0, "remaining": 7},
        "SL": {"total": 15, "used": 0, "remaining": 15},
        "EL": {"total": 12, "used": 0, "remaining": 12},
    })
    if data.create_user_account:
        password = data.password or "Welcome@123"
        user_doc = {
            "email": data.email.lower(),
            "password_hash": hash_password(password),
            "name": f"{data.first_name} {data.last_name}",
            "role": data.role,
            "employee_id": employee_id,
            "is_active": True,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        await db.users.insert_one(user_doc)
    emp_doc["id"] = str(result.inserted_id)
    emp_doc.pop("_id", None)
    return emp_doc


@router.get("/{employee_id}")
async def get_employee(employee_id: str, current_user: dict = Depends(get_current_user)):
    emp = await db.employees.find_one({"employee_id": employee_id})
    if not emp:
        raise HTTPException(status_code=404, detail="Employee not found")
    return emp_to_dict(emp)


@router.put("/{employee_id}")
async def update_employee(employee_id: str, data: EmployeeUpdate, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    emp = await db.employees.find_one({"employee_id": employee_id})
    if not emp:
        raise HTTPException(status_code=404, detail="Employee not found")
    update_data = {k: v for k, v in data.model_dump().items() if v is not None}

    # Validate IFSC
    if update_data.get("ifsc_code"):
        import re as _re_ifsc
        ifsc = update_data["ifsc_code"].upper().strip()
        if not _re_ifsc.match(r"^[A-Z]{4}0[A-Z0-9]{6}$", ifsc):
            raise HTTPException(status_code=400, detail="Invalid IFSC code. Format: 4 letters + 0 + 6 alphanumeric.")
        update_data["ifsc_code"] = ifsc

    # Validate reporting_to
    if update_data.get("reporting_to"):
        rep = update_data["reporting_to"].strip().upper()
        if rep == employee_id:
            raise HTTPException(status_code=400, detail="An employee cannot report to themselves.")
        rep_emp = await db.employees.find_one({"employee_id": rep})
        if not rep_emp:
            raise HTTPException(status_code=400, detail=f"Reporting To: no employee with ID {rep} found.")
        update_data["reporting_to"] = rep

    # Validate email uniqueness if changed
    if update_data.get("email"):
        new_email = update_data["email"].lower().strip()
        if new_email != emp.get("email"):
            if await db.employees.find_one({"email": new_email, "employee_id": {"$ne": employee_id}}):
                raise HTTPException(status_code=400, detail=f"Email {new_email} is already in use.")
            update_data["email"] = new_email
            # Update the linked user account too
            await db.users.update_one({"employee_id": employee_id}, {"$set": {"email": new_email}})

    # Salary recalculation (or auto-distribute from CTC)
    salary_keys = ["basic", "hra", "special_allowance", "canteen_allowance", "conveyance_allowance", "epf_employee"]
    salary_changed = any(k in update_data for k in salary_keys) or "ctc_monthly" in update_data
    if salary_changed:
        salary = emp.get("salary", {}) or {}
        for k in salary_keys:
            if k in update_data:
                salary[k] = update_data.pop(k)
        if "ctc_monthly" in update_data:
            ctc = update_data.pop("ctc_monthly") or 0
            salary["ctc_monthly"] = ctc
            salary["ctc_annual"] = round(ctc * 12, 2)
            update_data["ctc_monthly"] = ctc
            update_data["ctc_annual"] = round(ctc * 12, 2)
        gross_keys = ["basic", "hra", "special_allowance", "canteen_allowance", "conveyance_allowance"]
        salary["gross"] = sum(salary.get(k, 0) or 0 for k in gross_keys)
        if not salary.get("ctc_monthly"):
            salary["ctc_monthly"] = salary["gross"]
            salary["ctc_annual"] = round(salary["gross"] * 12, 2)
        update_data["salary"] = salary

    # Bank consolidation
    bank_keys = ["bank_name", "account_number", "ifsc_code"]
    if any(k in update_data for k in bank_keys):
        bank = emp.get("bank_details", {}) or {}
        for k in bank_keys:
            if k in update_data:
                bank[k] = update_data.pop(k)
        update_data["bank_details"] = bank

    # Address consolidation
    addr_keys = ["address_current", "address_permanent"]
    if any(k in update_data for k in addr_keys):
        addr = emp.get("address", {}) or {}
        for k in addr_keys:
            if k in update_data:
                addr[k.replace("address_", "")] = update_data.pop(k)
        update_data["address"] = addr

    # Emergency contact consolidation
    if "emergency_contact_name" in update_data or "emergency_contact_mobile" in update_data:
        ec = emp.get("emergency_contact", {}) or {}
        if "emergency_contact_name" in update_data:
            ec["name"] = update_data.pop("emergency_contact_name")
        if "emergency_contact_mobile" in update_data:
            ec["mobile"] = update_data.pop("emergency_contact_mobile")
        update_data["emergency_contact"] = ec

    # If role changes, sync user account too
    if "role" in update_data:
        await db.users.update_one({"employee_id": employee_id}, {"$set": {"role": update_data["role"]}})

    update_data["updated_at"] = datetime.now(timezone.utc).isoformat()
    await db.employees.update_one({"employee_id": employee_id}, {"$set": update_data})
    emp = await db.employees.find_one({"employee_id": employee_id})
    return emp_to_dict(emp)


@router.post("/bulk-upload")
async def bulk_upload(file: UploadFile = File(...), current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin"]:
        raise HTTPException(status_code=403, detail="Access denied")
    content = await file.read()
    reader = csv.DictReader(io.StringIO(content.decode("utf-8-sig")))
    created, skipped, errors = 0, 0, []
    for row in reader:
        try:
            email = row.get("email", "").lower().strip()
            if not email:
                continue
            existing = await db.employees.find_one({"email": email})
            if existing:
                skipped += 1
                continue
            employee_id = row.get("employee_id", "").strip() or await get_next_employee_id()
            basic = float(row.get("basic", 0))
            hra = float(row.get("hra", 0))
            special = float(row.get("special_allowance", 0))
            canteen = float(row.get("canteen_allowance", 0))
            conveyance = float(row.get("conveyance_allowance", 0))
            gross = basic + hra + special + canteen + conveyance
            emp_doc = {
                "employee_id": employee_id,
                "first_name": row.get("first_name", ""),
                "last_name": row.get("last_name", ""),
                "email": email,
                "mobile": row.get("mobile", ""),
                "department": row.get("department", ""),
                "designation": row.get("designation", ""),
                "role": row.get("role", "employee"),
                "reporting_to": row.get("reporting_to", "").strip() or None,
                "joining_date": row.get("joining_date", ""),
                "status": row.get("status", "active"),
                "salary": {"basic": basic, "hra": hra, "special_allowance": special,
                           "canteen_allowance": canteen, "conveyance_allowance": conveyance, "gross": gross},
                "bank_details": {"bank_name": row.get("bank_name", ""),
                                 "account_number": row.get("account_number", ""),
                                 "ifsc_code": row.get("ifsc_code", "")},
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
            await db.employees.insert_one(emp_doc)
            await db.leave_balances.insert_one({
                "employee_id": employee_id,
                "year": datetime.now(timezone.utc).year,
                "CL": {"total": 7, "used": 0, "remaining": 7},
                "SL": {"total": 15, "used": 0, "remaining": 15},
                "EL": {"total": 12, "used": 0, "remaining": 12},
            })
            password = row.get("password", "Welcome@123")
            await db.users.update_one(
                {"email": email},
                {"$setOnInsert": {
                    "email": email,
                    "password_hash": hash_password(password),
                    "name": f"{row.get('first_name', '')} {row.get('last_name', '')}",
                    "role": row.get("role", "employee"),
                    "employee_id": employee_id,
                    "is_active": True,
                    "created_at": datetime.now(timezone.utc).isoformat(),
                }},
                upsert=True,
            )
            created += 1
        except Exception as e:
            errors.append(f"Row {email}: {str(e)}")
    return {"created": created, "skipped": skipped, "errors": errors}
