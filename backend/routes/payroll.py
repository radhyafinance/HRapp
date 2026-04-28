from fastapi import APIRouter, HTTPException, Depends, Response
from pydantic import BaseModel
from typing import Optional, List
from database import db
from auth_utils import get_current_user
from datetime import datetime, timezone
from bson import ObjectId
import io

router = APIRouter()


def calc_payroll_components(emp: dict, working_days: int = 26, present_days: int = 26):
    salary = emp.get("salary", {})
    basic = salary.get("basic", 0)
    hra = salary.get("hra", 0)
    special = salary.get("special_allowance", 0)
    canteen = salary.get("canteen_allowance", 0)
    conveyance = salary.get("conveyance_allowance", 0)
    gross = basic + hra + special + canteen + conveyance

    # Pro-rata if absent
    if present_days < working_days and working_days > 0:
        gross_payable = round(gross * present_days / working_days, 2)
        basic_payable = round(basic * present_days / working_days, 2)
    else:
        gross_payable = gross
        basic_payable = basic

    # EPF: 12% of Basic (no cap as per company policy)
    epf_employee = round(basic_payable * 0.12, 2)
    epf_employer = round(basic_payable * 0.12, 2)

    # ESIC: applicable for gross <= 21000
    if gross <= 21000:
        esic_employee = round(gross_payable * 0.0075, 2)
        esic_employer = round(gross_payable * 0.0325, 2)
    else:
        esic_employee = 0
        esic_employer = 0

    # Gratuity provision (monthly)
    gratuity_monthly = round((basic * 15) / (26 * 12), 2)

    # CTC components
    ctc_monthly = gross + epf_employer + esic_employer + gratuity_monthly

    net_salary = round(gross_payable - epf_employee - esic_employee, 2)

    return {
        "basic": basic_payable,
        "hra": round(hra * present_days / working_days, 2) if present_days < working_days else hra,
        "special_allowance": round(special * present_days / working_days, 2) if present_days < working_days else special,
        "canteen_allowance": round(canteen * present_days / working_days, 2) if present_days < working_days else canteen,
        "conveyance_allowance": round(conveyance * present_days / working_days, 2) if present_days < working_days else conveyance,
        "gross_salary": gross,
        "gross_payable": gross_payable,
        "epf_employee": epf_employee,
        "epf_employer": epf_employer,
        "esic_employee": esic_employee,
        "esic_employer": esic_employer,
        "gratuity_monthly": gratuity_monthly,
        "ctc_monthly": ctc_monthly,
        "net_salary": net_salary,
        "working_days": working_days,
        "present_days": present_days,
    }


def pay_to_dict(p):
    p["id"] = str(p.pop("_id"))
    return p


class ProcessPayrollRequest(BaseModel):
    month: int
    year: int
    employee_ids: Optional[List[str]] = None  # None = process all active


class PayrollUpdateRequest(BaseModel):
    tds: Optional[float] = 0
    other_deductions: Optional[float] = 0
    other_additions: Optional[float] = 0
    remarks: Optional[str] = None


@router.post("/process")
async def process_payroll(data: ProcessPayrollRequest, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    query = {"status": {"$in": ["active", "probation"]}}
    if data.employee_ids:
        query["employee_id"] = {"$in": data.employee_ids}
    employees = await db.employees.find(query).to_list(1000)
    period = f"{data.year}-{data.month:02d}"
    processed = []
    for emp in employees:
        emp_id = emp["employee_id"]
        existing = await db.payroll_records.find_one({"employee_id": emp_id, "period": period})
        if existing:
            continue
        # Get attendance for the month
        att_records = await db.attendance_records.find(
            {"employee_id": emp_id, "date": {"$regex": f"^{period}"}}
        ).to_list(35)
        present_days = len([r for r in att_records if r.get("punch_in_time")])
        working_days = 26  # Standard working days
        if present_days == 0:
            present_days = working_days  # Default to full month if no attendance
        components = calc_payroll_components(emp, working_days, present_days)
        # Get approved leaves
        approved_leaves = await db.leave_applications.find({
            "employee_id": emp_id,
            "status": "approved",
            "start_date": {"$regex": f"^{period}"},
        }).to_list(100)
        leave_days = sum(l.get("days", 0) for l in approved_leaves)
        record = {
            "employee_id": emp_id,
            "employee_name": f"{emp.get('first_name', '')} {emp.get('last_name', '')}",
            "designation": emp.get("designation", ""),
            "department": emp.get("department", ""),
            "period": period,
            "month": data.month,
            "year": data.year,
            **components,
            "leave_days": leave_days,
            "tds": 0,
            "other_deductions": 0,
            "other_additions": 0,
            "bank_account": emp.get("bank_details", {}).get("account_number", ""),
            "ifsc_code": emp.get("bank_details", {}).get("ifsc_code", ""),
            "bank_name": emp.get("bank_details", {}).get("bank_name", ""),
            "status": "draft",
            "processed_at": datetime.now(timezone.utc).isoformat(),
            "processed_by": current_user.get("employee_id"),
        }
        await db.payroll_records.insert_one(record)
        processed.append(emp_id)
    return {"processed": len(processed), "employee_ids": processed, "period": period}


@router.get("")
async def list_payroll(
    period: str = None,
    employee_id: str = None,
    current_user: dict = Depends(get_current_user),
):
    query = {}
    if period:
        query["period"] = period
    if current_user.get("role") in ["employee", "field_agent"]:
        query["employee_id"] = current_user.get("employee_id")
    elif employee_id:
        query["employee_id"] = employee_id
    records = await db.payroll_records.find(query).sort("period", -1).to_list(500)
    return [pay_to_dict(r) for r in records]


@router.get("/employee/{employee_id}")
async def employee_payroll(employee_id: str, current_user: dict = Depends(get_current_user)):
    records = await db.payroll_records.find({"employee_id": employee_id}).sort("period", -1).to_list(50)
    return [pay_to_dict(r) for r in records]


@router.put("/{record_id}")
async def update_payroll(record_id: str, data: PayrollUpdateRequest, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    record = await db.payroll_records.find_one({"_id": ObjectId(record_id)})
    if not record:
        raise HTTPException(status_code=404, detail="Not found")
    tds = data.tds or 0
    other_ded = data.other_deductions or 0
    other_add = data.other_additions or 0
    gross_payable = record.get("gross_payable", 0)
    epf_employee = record.get("epf_employee", 0)
    esic_employee = record.get("esic_employee", 0)
    net_salary = round(gross_payable - epf_employee - esic_employee - tds - other_ded + other_add, 2)
    await db.payroll_records.update_one(
        {"_id": ObjectId(record_id)},
        {"$set": {
            "tds": tds,
            "other_deductions": other_ded,
            "other_additions": other_add,
            "net_salary": net_salary,
            "remarks": data.remarks,
            "status": "processed",
        }},
    )
    record = await db.payroll_records.find_one({"_id": ObjectId(record_id)})
    return pay_to_dict(record)


@router.post("/{record_id}/finalize")
async def finalize_payroll(record_id: str, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    await db.payroll_records.update_one(
        {"_id": ObjectId(record_id)},
        {"$set": {"status": "paid", "paid_at": datetime.now(timezone.utc).isoformat()}},
    )
    return {"message": "Payroll marked as paid"}


@router.get("/export/neft")
async def export_neft(period: str, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    records = await db.payroll_records.find({"period": period}).to_list(1000)
    try:
        import openpyxl
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = f"NEFT_{period}"
        headers = ["Sr No", "Employee ID", "Employee Name", "Bank Name", "Account Number", "IFSC Code", "Net Salary", "Remarks"]
        ws.append(headers)
        for i, r in enumerate(records, 1):
            ws.append([
                i, r.get("employee_id"), r.get("employee_name"),
                r.get("bank_name", ""), r.get("bank_account", ""),
                r.get("ifsc_code", ""), r.get("net_salary", 0), ""
            ])
        buffer = io.BytesIO()
        wb.save(buffer)
        buffer.seek(0)
        return Response(
            content=buffer.getvalue(),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="NEFT_{period}.xlsx"'},
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{record_id}")
async def get_payslip(record_id: str, current_user: dict = Depends(get_current_user)):
    record = await db.payroll_records.find_one({"_id": ObjectId(record_id)})
    if not record:
        raise HTTPException(status_code=404, detail="Not found")
    return pay_to_dict(record)
