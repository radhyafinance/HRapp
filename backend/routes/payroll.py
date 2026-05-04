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

    # EPF: only deduct if epf_employee is explicitly set to a value > 0.
    # If null/not set or 0 — employee is EPF-exempt.
    # Capped at ₹1800 for both employee and employer side.
    EPF_CAP = 1800
    stored_epf = salary.get("epf_employee")
    if stored_epf is not None and float(stored_epf) > 0:
        raw_epf_emp = float(stored_epf) * present_days / working_days if present_days < working_days else float(stored_epf)
        epf_employee = round(min(raw_epf_emp, EPF_CAP), 2)
        epf_employer = min(round(basic_payable * 0.12, 2), EPF_CAP)
    else:
        epf_employee = 0
        epf_employer = 0

    # ESIC: applicable when basic <= 21000, calculated on basic salary
    if basic <= 21000:
        esic_employee = round(basic_payable * 0.0075, 2)
        esic_employer = round(basic_payable * 0.0325, 2)
    else:
        esic_employee = 0
        esic_employer = 0

    # Gratuity provision (monthly): (Basic × 15 / 26) / 12
    # 15/26 of basic = annual gratuity per year of service; divide by 12 for monthly accrual.
    # Directors are excluded from gratuity (per company policy).
    designation = (emp.get("designation") or "").strip().lower()
    if designation == "director":
        gratuity_monthly = 0
    else:
        gratuity_monthly = round((basic_payable * 15) / 26 / 12)  # rounded to nearest rupee

    # CTC components
    ctc_monthly = round(gross + epf_employer + esic_employer + gratuity_monthly)  # rounded to nearest rupee

    net_salary = round(gross_payable - epf_employee - esic_employee)  # rounded to nearest rupee

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
        leave_days = sum(lv.get("days", 0) for lv in approved_leaves)
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


@router.delete("/period/{period}")
async def delete_payroll_period(period: str, current_user: dict = Depends(get_current_user)):
    """Delete all payroll records for a given period (YYYY-MM).
    Allowed only until the 15th of the following month
    (e.g. April 2026 records can be deleted up to and including 15-May-2026).
    HR Admin / Management only.
    """
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")

    # Parse and validate period
    try:
        y, m = period.split("-")
        period_year, period_month = int(y), int(m)
        if not (1 <= period_month <= 12) or period_year < 2000 or period_year > 2100:
            raise ValueError
    except (ValueError, AttributeError):
        raise HTTPException(status_code=400, detail="Period must be in YYYY-MM format")

    # Cutoff = 15th of the month AFTER the payroll period
    if period_month == 12:
        cutoff_year, cutoff_month = period_year + 1, 1
    else:
        cutoff_year, cutoff_month = period_year, period_month + 1
    cutoff = datetime(cutoff_year, cutoff_month, 15, 23, 59, 59, tzinfo=timezone.utc)

    now = datetime.now(timezone.utc)
    if now > cutoff:
        raise HTTPException(
            status_code=403,
            detail=f"Cannot delete payroll for {period}. The deletion window closed on "
                   f"{cutoff.strftime('%d %b %Y')}. Edit individual records instead.",
        )

    res = await db.payroll_records.delete_many({"period": period})
    return {
        "period": period,
        "deleted": res.deleted_count,
        "cutoff": cutoff.isoformat(),
    }


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
    settings_doc = await db.app_settings.find_one({"key": "company"}) or {}
    # NEFT debit account is fixed by company policy — always use 019005008108
    debit_account = "019005008108"
    txn_type = (settings_doc.get("transaction_type") or "NFT").strip()
    short_code = (settings_doc.get("company_short_code") or "RMF0001").strip()

    # Period -> "Apr26" (locale-independent)
    _MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    try:
        y, m = period.split("-")
        month_short = _MONTHS[int(m) - 1]
        period_label = f"{month_short.upper()}{y[-2:]}"  # e.g. "APR26" (uppercase, 2-digit year)
    except Exception:
        period_label = period

    remark_full = f"Salary {period_label}"  # per-employee ID prepended inside the loop
    remark_suffix = remark_full

    def clean_name(name: str) -> str:
        if not name:
            return ""
        # Allow letters and spaces only, uppercase, max 32 chars
        cleaned = "".join(ch for ch in name.upper() if ch.isalpha() or ch == " ")
        cleaned = " ".join(cleaned.split())
        return cleaned[:32]

    try:
        import openpyxl
        from openpyxl.styles import Font, Alignment, PatternFill, Border, Side
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = f"NEFT_{period}"
        headers = [
            "Transaction type \n(Within Bank (WIB)/\nNEFT (NFT)/\nRTGS (RTG)/\nIMPS (IFC))",
            "Amount (\u20b9)\n(Should not be more than 15 digit including decimals and paise)",
            "Debit Account no\nShould be exactly 12 digit",
            "IFSC (Always 11 character alphanumeric and 5th character always 0 (zero)) (For ICICI bank accounts keep it blank)",
            "Beneficiary Account No (Max length for other bank 34 character alphanumeric and for ICICI Bank 12 digit number )",
            "Beneficiary Name (Max length 32 Character) (No Special Character is allowed but Space is allowed)",
            "Remarks for Client\n(should not be more than 21 characters)",
            "Remarks for Beneficiary\n(should not be more than 30 characters)",
        ]
        ws.append(headers)
        # Header styling
        header_fill = PatternFill("solid", fgColor="1E2A47")
        header_font = Font(bold=True, color="FFFFFF", size=10)
        thin = Side(border_style="thin", color="CCCCCC")
        for cell in ws[1]:
            cell.fill = header_fill
            cell.font = header_font
            cell.alignment = Alignment(wrap_text=True, vertical="center", horizontal="center")
            cell.border = Border(left=thin, right=thin, top=thin, bottom=thin)
        ws.row_dimensions[1].height = 90
        widths = [22, 18, 18, 16, 26, 28, 22, 28]
        for i, w in enumerate(widths, 1):
            ws.column_dimensions[openpyxl.utils.get_column_letter(i)].width = w

        for r in records:
            net_amount = round(float(r.get("net_salary", 0) or 0), 2)
            beneficiary_acct = (r.get("bank_account") or "").strip()
            ifsc = (r.get("ifsc_code") or "").strip().upper()
            name = clean_name(r.get("employee_name", ""))
            emp_id = (r.get("employee_id") or "").strip()
            row_remark = f"{emp_id} {remark_suffix}"   # e.g. "RMF0001 Salary APR26"
            row_remark_client = row_remark[:21]
            row_remark_beneficiary = row_remark[:30]
            ws.append([
                txn_type,
                net_amount,
                debit_account,
                ifsc,
                beneficiary_acct,
                name,
                row_remark_client,
                row_remark_beneficiary,
            ])
        # Body styling
        for row in ws.iter_rows(min_row=2, max_row=ws.max_row, min_col=1, max_col=8):
            for cell in row:
                cell.alignment = Alignment(vertical="center", wrap_text=False)
                cell.border = Border(left=thin, right=thin, top=thin, bottom=thin)

        buffer = io.BytesIO()
        wb.save(buffer)
        buffer.seek(0)
        filename = f"NEFT_{short_code}_{period}.xlsx"
        return Response(
            content=buffer.getvalue(),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/export/salary-register")
async def export_salary_register(period: str, current_user: dict = Depends(get_current_user)):
    """Master Monthly Salary Register — comprehensive multi-column Excel summary
    of every processed payroll record for the period (YYYY-MM).
    Includes: Employee details, Paid/Leave days, Earnings breakup, Gross,
    Deductions breakup, Net Salary, Employer Contributions, Monthly CTC,
    and Bank details. A totals row is appended at the bottom."""
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")

    records = await db.payroll_records.find({"period": period}).sort("employee_id", 1).to_list(2000)
    if not records:
        raise HTTPException(status_code=404, detail=f"No payroll records found for period {period}.")

    # Enrich with employee master data (joining date, PAN, UAN, ESI)
    emp_ids = [r.get("employee_id") for r in records if r.get("employee_id")]
    employees = await db.employees.find(
        {"employee_id": {"$in": emp_ids}},
        {"_id": 0}
    ).to_list(2000)
    emp_map = {e["employee_id"]: e for e in employees}

    _MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    try:
        y, m = period.split("-")
        period_label = f"{_MONTHS[int(m)-1]} {y}"
    except Exception:
        period_label = period

    import openpyxl
    from openpyxl.styles import Font, Alignment, PatternFill, Border, Side
    from openpyxl.utils import get_column_letter

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = f"Salary Register {period}"

    # Styling helpers
    navy_fill = PatternFill("solid", fgColor="1E2A47")
    orange_fill = PatternFill("solid", fgColor="E85B1E")
    grey_fill = PatternFill("solid", fgColor="F1F5F9")
    header_font = Font(bold=True, color="FFFFFF", size=10)
    section_font = Font(bold=True, color="FFFFFF", size=11)
    title_font = Font(bold=True, color="1E2A47", size=14)
    subtitle_font = Font(italic=True, color="64748B", size=9)
    total_font = Font(bold=True, color="1E2A47", size=10)
    total_fill = PatternFill("solid", fgColor="FEF3E2")
    thin = Side(border_style="thin", color="CCCCCC")
    medium = Side(border_style="medium", color="1E2A47")
    border = Border(top=thin, bottom=thin, left=thin, right=thin)

    # Column layout (grouped):
    # Identity (1-7): Sr, Emp ID, Name, Designation, Department, DOJ, Status
    # Attendance (8-10): Working Days, Paid Days, LOP
    # Earnings (11-16): Basic, HRA, Special, Canteen, Conveyance, Other Add
    # Gross (17): Gross Salary
    # Deductions (18-22): EPF Emp, ESIC Emp, TDS, Other Ded, Total Ded
    # Net (23): Net Salary
    # Employer (24-26): EPF Empr, ESIC Empr, Gratuity
    # CTC (27): Monthly CTC
    # Statutory (28-30): PAN, UAN, ESI No
    # Bank (31-33): Bank Name, A/c No, IFSC
    group_headers = [
        ("Identity", 1, 7, navy_fill),
        ("Attendance", 8, 10, orange_fill),
        ("Earnings (₹)", 11, 16, navy_fill),
        ("Gross", 17, 17, orange_fill),
        ("Deductions (₹)", 18, 22, navy_fill),
        ("Net Pay", 23, 23, orange_fill),
        ("Employer Cost (₹)", 24, 26, navy_fill),
        ("CTC", 27, 27, orange_fill),
        ("Statutory IDs", 28, 30, navy_fill),
        ("Bank Details", 31, 33, orange_fill),
    ]
    col_headers = [
        "Sr", "Employee ID", "Name", "Designation", "Department", "Joining Date", "Status",
        "Working Days", "Paid Days", "LOP",
        "Basic", "HRA", "Special Allow.", "Canteen", "Conveyance", "Other Add.",
        "Gross Salary",
        "EPF (Emp)", "ESIC (Emp)", "TDS", "Other Ded.", "Total Ded.",
        "Net Salary",
        "EPF (Empr)", "ESIC (Empr)", "Gratuity",
        "Monthly CTC",
        "PAN", "UAN", "ESI No.",
        "Bank Name", "Account No.", "IFSC",
    ]
    n_cols = len(col_headers)  # 33

    # Title rows
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=n_cols)
    ws.cell(row=1, column=1, value=f"RADHYA MICRO FINANCE PRIVATE LIMITED — Monthly Salary Register").font = title_font
    ws.cell(row=1, column=1).alignment = Alignment(horizontal="center", vertical="center")
    ws.row_dimensions[1].height = 22

    ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=n_cols)
    ws.cell(row=2, column=1, value=f"Period: {period_label}  |  Generated: {datetime.now(timezone.utc).strftime('%d %b %Y %H:%M UTC')}  |  {len(records)} employees").font = subtitle_font
    ws.cell(row=2, column=1).alignment = Alignment(horizontal="center", vertical="center")

    # Group header row (row 3)
    for label, start, end, fill in group_headers:
        if start == end:
            cell = ws.cell(row=3, column=start, value=label)
        else:
            ws.merge_cells(start_row=3, start_column=start, end_row=3, end_column=end)
            cell = ws.cell(row=3, column=start, value=label)
        cell.fill = fill
        cell.font = section_font
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = border
    ws.row_dimensions[3].height = 20

    # Column header row (row 4)
    for i, h in enumerate(col_headers, 1):
        c = ws.cell(row=4, column=i, value=h)
        c.fill = grey_fill
        c.font = Font(bold=True, color="1E2A47", size=9)
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        c.border = border
    ws.row_dimensions[4].height = 30

    # Totals accumulator (money columns only)
    money_cols = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27]
    totals = {c: 0.0 for c in money_cols}

    # Data rows start at row 5
    r_idx = 5
    for sr, rec in enumerate(records, 1):
        emp = emp_map.get(rec.get("employee_id"), {})
        working = rec.get("working_days", 26) or 26
        paid = rec.get("present_days", working) or working
        lop = max(0, working - paid)
        gross = float(rec.get("gross_payable") or rec.get("gross_salary") or 0)
        epf_e = float(rec.get("epf_employee") or 0)
        esic_e = float(rec.get("esic_employee") or 0)
        tds = float(rec.get("tds") or 0)
        other_d = float(rec.get("other_deductions") or 0)
        other_a = float(rec.get("other_additions") or 0)
        total_ded = round(epf_e + esic_e + tds + other_d, 2)
        net = float(rec.get("net_salary") or 0)
        epf_r = float(rec.get("epf_employer") or 0)
        esic_r = float(rec.get("esic_employer") or 0)
        grat = float(rec.get("gratuity_monthly") or 0)
        ctc = float(rec.get("ctc_monthly") or 0)

        bank = emp.get("bank_details", {}) or {}
        row_values = [
            sr,
            rec.get("employee_id", ""),
            rec.get("employee_name", "").strip() or f"{emp.get('first_name','')} {emp.get('last_name','')}".strip(),
            rec.get("designation", "") or emp.get("designation", ""),
            rec.get("department", "") or emp.get("department", ""),
            emp.get("joining_date", ""),
            (emp.get("status", "") or "").replace("_", " ").title(),
            working, paid, lop,
            float(rec.get("basic") or 0),
            float(rec.get("hra") or 0),
            float(rec.get("special_allowance") or 0),
            float(rec.get("canteen_allowance") or 0),
            float(rec.get("conveyance_allowance") or 0),
            other_a,
            gross,
            epf_e, esic_e, tds, other_d, total_ded,
            net,
            epf_r, esic_r, grat,
            ctc,
            emp.get("pan_number", "") or "",
            emp.get("uan_number", "") or "",
            emp.get("esi_number", "") or "",
            bank.get("bank_name", "") or rec.get("bank_name", ""),
            bank.get("account_number", "") or rec.get("bank_account", ""),
            bank.get("ifsc_code", "") or rec.get("ifsc_code", ""),
        ]

        for col_idx, val in enumerate(row_values, 1):
            c = ws.cell(row=r_idx, column=col_idx, value=val)
            c.border = border
            c.alignment = Alignment(vertical="center", horizontal="right" if col_idx in money_cols else "left")
            if col_idx in money_cols:
                c.number_format = '#,##0'
                totals[col_idx] = round(totals.get(col_idx, 0) + float(val or 0), 2)
        r_idx += 1

    # Totals row
    totals_row = r_idx
    for col_idx in range(1, n_cols + 1):
        c = ws.cell(row=totals_row, column=col_idx)
        c.fill = total_fill
        c.border = Border(top=medium, bottom=medium, left=thin, right=thin)
        c.font = total_font
        if col_idx == 1:
            c.value = "TOTAL"
            c.alignment = Alignment(horizontal="center", vertical="center")
        elif col_idx in totals:
            c.value = round(totals[col_idx], 2)
            c.number_format = '#,##0'
            c.alignment = Alignment(horizontal="right", vertical="center")
    ws.row_dimensions[totals_row].height = 22

    # Column widths
    widths = [
        4, 12, 26, 20, 18, 12, 14,         # Identity
        9, 9, 7,                            # Attendance
        11, 10, 13, 11, 12, 11,             # Earnings
        12,                                 # Gross
        11, 11, 10, 11, 11,                 # Deductions
        12,                                 # Net
        11, 11, 10,                         # Employer
        13,                                 # CTC
        13, 14, 14,                         # Statutory IDs
        18, 18, 13,                         # Bank
    ]
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w

    # Freeze panes at data start
    ws.freeze_panes = "C5"

    buffer = io.BytesIO()
    wb.save(buffer)
    buffer.seek(0)
    filename = f"Salary_Register_{period}.xlsx"
    return Response(
        content=buffer.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/{record_id}/payslip/pdf")
async def download_payslip_pdf(record_id: str, current_user: dict = Depends(get_current_user)):
    record = await db.payroll_records.find_one({"_id": ObjectId(record_id)})
    if not record:
        raise HTTPException(status_code=404, detail="Payroll record not found")
    # Permission: HR/management can download any; employees/field_agents only their own
    if current_user.get("role") in ["employee", "field_agent"]:
        if record.get("employee_id") != current_user.get("employee_id"):
            raise HTTPException(status_code=403, detail="Access denied")
    employee = await db.employees.find_one({"employee_id": record.get("employee_id")})
    if not employee:
        raise HTTPException(status_code=404, detail="Employee not found")
    # Remove MongoDB _id before passing to PDF builder
    record.pop("_id", None)
    employee.pop("_id", None)
    try:
        from services.payslip_pdf import build_payslip_pdf
        pdf_bytes = build_payslip_pdf(record, employee)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"PDF generation failed: {str(e)}")
    emp_name = f"{employee.get('first_name','')}_{employee.get('last_name','')}".strip("_")
    period   = record.get("period", "unknown")
    filename = f"Payslip_{emp_name}_{period}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/{record_id}")
async def get_payslip(record_id: str, current_user: dict = Depends(get_current_user)):
    record = await db.payroll_records.find_one({"_id": ObjectId(record_id)})
    if not record:
        raise HTTPException(status_code=404, detail="Not found")
    return pay_to_dict(record)
