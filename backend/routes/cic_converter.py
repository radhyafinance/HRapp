"""CIC Data Converter — generates 4 CDF files (CIBIL, CRIF, Equifax, Experian)
from a HighMark-format Excel sheet.

Access: restricted to employee IDs RMF0007, RMF0003, OR role hr_admin.
"""
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.responses import StreamingResponse
from auth_utils import get_current_user
import openpyxl
import zipfile
import io
from datetime import datetime

router = APIRouter()

CIC_ALLOWED_EMPLOYEE_IDS = {"RMF0007", "RMF0003"}

# Exact header prefix/suffix extracted from sample CDF files (spacing is significant)
CIC_CONFIGS = {
    "cibil": {
        "label": "CIBIL",
        "header_prefix": "HDRHMMFI1.9MF8361    RADHYAMF                                ",
        "header_suffix": "   Password1                                                                           FUTURE",
        "footer": "TRLHMMFI1.9MF8361",
        "filename": lambda f, t: f"MF8361_MFI_{f}_{t}_DailyData.CDF",
    },
    "crif": {
        "label": "CRIF",
        "header_prefix": "HDRHMMFI1.9NBF0005342RADHYA MICRO FINANCE PVT LTD            ",
        "header_suffix": "   HMcsv0911                     INHOUSE                                              INHOUSE",
        "footer": "TRLHMMFI1.9NBF0005342",
        "filename": lambda f, t: f"NBF0005342_MFI_DailyData_{f}_{t}.CDF",
    },
    "equifax": {
        "label": "Equifax",
        "header_prefix": "HDRHMMFI1.9NBF009FZ04381RADHYA MICRO FINANCE PVT LTD            ",
        "header_suffix": "   HMcsv0911                     INHOUSE                                              INHOUSE",
        "footer": "TRLHMMFI1.9NBF009FZ04381",
        "filename": lambda f, t: f"009FZ04381_MFI_DailyData_{f}_{t}.CDF",
    },
    "experian": {
        "label": "Experian",
        "header_prefix": "HDRHMMFI1.9NBF259263RADHYA MICRO FINANCE PVT LTD            ",
        "header_suffix": "   HMcsv0911                     INHOUSE                                              INHOUSE",
        "footer": "TRLHMMFI1.9NBF259263",
        "filename": lambda f, t: f"259263_{f}_{t}_MFI_DAILY.CDF",
    },
}

# Column indices (0-based) in the Excel sheet
UID_COL_INDEX = 28        # "UID" column (Aadhaar 12-digit)
DATE_ACC_INFO_INDEX = 69  # "Date of Account Information" — overwritten with from_date


def _cell_to_str(val) -> str:
    """Convert any Excel cell value to a CDF-safe string."""
    if val is None:
        return ""
    if isinstance(val, datetime):
        return val.strftime("%d%m%Y")  # DDMMYYYY
    if isinstance(val, float):
        return str(int(val)) if val == int(val) else str(val)
    return str(val)


def _build_cdf(rows: list, from_date: str, to_date: str, cic_key: str) -> str:
    cfg = CIC_CONFIGS[cic_key]
    header = cfg["header_prefix"] + from_date + to_date + cfg["header_suffix"]
    return "\n".join([header] + rows + [cfg["footer"]])


@router.post("/generate")
async def generate_cdf(
    file: UploadFile = File(...),
    from_date: str = Form(...),      # DDMMYYYY  e.g. "11062026"
    to_date: str = Form(...),        # DDMMYYYY  e.g. "13062026"
    excluded_uids: str = Form(""),   # newline/comma-separated 12-digit UIDs
    current_user: dict = Depends(get_current_user),
):
    """Upload HighMark Excel → download ZIP of 4 CDF files."""
    emp_id = current_user.get("employee_id")
    role = current_user.get("role")
    if emp_id not in CIC_ALLOWED_EMPLOYEE_IDS and role != "hr_admin":
        raise HTTPException(status_code=403, detail="Access restricted to authorised personnel only.")

    # Validate date format (DDMMYYYY)
    for label, d in [("From date", from_date), ("To date", to_date)]:
        if len(d) != 8 or not d.isdigit():
            raise HTTPException(status_code=422, detail=f"{label} must be in DDMMYYYY format (e.g. 11062026).")

    # Build exclusion set
    excluded = {u.strip() for u in excluded_uids.replace(",", "\n").splitlines() if u.strip()}

    # Read Excel
    content = await file.read()
    try:
        wb = openpyxl.load_workbook(io.BytesIO(content), data_only=True)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid Excel file. Please upload a valid .xlsx file.")
    ws = wb.active

    rows = []
    skipped = 0
    for row in ws.iter_rows(min_row=2, values_only=True):  # row 1 = header
        cells = list(row)
        if not any(cells):
            continue  # skip blank rows

        uid = _cell_to_str(cells[UID_COL_INDEX]) if len(cells) > UID_COL_INDEX else ""
        if uid and uid in excluded:
            skipped += 1
            continue

        # Overwrite Date of Account Information with user-chosen from_date
        if len(cells) > DATE_ACC_INFO_INDEX:
            cells[DATE_ACC_INFO_INDEX] = from_date

        rows.append("|".join(_cell_to_str(c) for c in cells))

    # Build ZIP with all 4 CDFs
    zip_buf = io.BytesIO()
    with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for cic_key, cfg in CIC_CONFIGS.items():
            cdf_text = _build_cdf(rows, from_date, to_date, cic_key)
            zf.writestr(cfg["filename"](from_date, to_date), cdf_text)

    zip_buf.seek(0)
    return StreamingResponse(
        zip_buf,
        media_type="application/zip",
        headers={
            "Content-Disposition": f"attachment; filename=CIC_CDF_{from_date}_{to_date}.zip",
            "X-Record-Count": str(len(rows)),
            "X-Skipped-Count": str(skipped),
        },
    )


@router.get("/access-check")
async def check_access(current_user: dict = Depends(get_current_user)):
    """Returns allowed: bool so the frontend can show/hide the tool."""
    emp_id = current_user.get("employee_id")
    role = current_user.get("role")
    allowed = emp_id in CIC_ALLOWED_EMPLOYEE_IDS or role == "hr_admin"
    return {"allowed": allowed}
