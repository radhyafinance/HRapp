"""CIC Data Converter — generates 4 CDF files (CIBIL, CRIF, Equifax, Experian)
from a HighMark-format Excel sheet.

Access: restricted to employee IDs RMF0007, RMF0003, OR role hr_admin.

Download flow (avoids blob-URL / user-gesture browser restrictions):
  1. POST /api/cic/generate  → processes Excel, stores files in memory, returns {download_token}
  2. GET  /api/cic/download/{token}?cic=<key>  → streams the file (no auth needed; token is the secret)
"""
import io
import uuid
import zipfile
from datetime import datetime, timedelta, timezone

import openpyxl
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.responses import JSONResponse, StreamingResponse

from auth_utils import get_current_user

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

# In-memory download cache: {token: {zip, cibil, crif, equifax, experian, expires_at, ...}}
DOWNLOAD_CACHE: dict = {}
TOKEN_TTL_SECONDS = 300  # 5 minutes


def _cell_to_str(val) -> str:
    if val is None:
        return ""
    if isinstance(val, datetime):
        return val.strftime("%d%m%Y")
    if isinstance(val, float):
        return str(int(val)) if val == int(val) else str(val)
    return str(val)


def _build_cdf(rows: list, from_date: str, to_date: str, cic_key: str) -> bytes:
    cfg = CIC_CONFIGS[cic_key]
    header = cfg["header_prefix"] + from_date + to_date + cfg["header_suffix"]
    content = "\n".join([header] + rows + [cfg["footer"]])
    return content.encode("utf-8")


def _evict_expired():
    """Remove tokens older than TTL."""
    now = datetime.now(timezone.utc)
    expired = [k for k, v in DOWNLOAD_CACHE.items() if now > v["expires_at"]]
    for k in expired:
        del DOWNLOAD_CACHE[k]


@router.post("/generate")
async def generate_cdf(
    file: UploadFile = File(...),
    from_date: str = Form(...),      # DDMMYYYY  e.g. "11062026"  (Date of Data)
    to_date: str = Form(...),        # DDMMYYYY  e.g. "13062026"  (Date of Upload)
    excluded_uids: str = Form(""),   # newline/comma-separated 12-digit UIDs
    current_user: dict = Depends(get_current_user),
):
    """Process Excel → store generated CDFs in memory → return download_token."""
    emp_id = current_user.get("employee_id")
    role = current_user.get("role")
    if emp_id not in CIC_ALLOWED_EMPLOYEE_IDS and role != "hr_admin":
        raise HTTPException(status_code=403, detail="Access restricted to authorised personnel only.")

    for label, d in [("Date of Data", from_date), ("Date of Upload", to_date)]:
        if len(d) != 8 or not d.isdigit():
            raise HTTPException(status_code=422, detail=f"{label} must be in DDMMYYYY format (e.g. 11062026).")

    excluded = {u.strip() for u in excluded_uids.replace(",", "\n").splitlines() if u.strip()}

    content = await file.read()
    try:
        wb = openpyxl.load_workbook(io.BytesIO(content), data_only=True)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid Excel file. Please upload a valid .xlsx file.")
    ws = wb.active

    rows = []
    skipped = 0
    for row in ws.iter_rows(min_row=2, values_only=True):
        cells = list(row)
        if not any(cells):
            continue
        uid = _cell_to_str(cells[UID_COL_INDEX]) if len(cells) > UID_COL_INDEX else ""
        if uid and uid in excluded:
            skipped += 1
            continue
        if len(cells) > DATE_ACC_INFO_INDEX:
            cells[DATE_ACC_INFO_INDEX] = from_date
        rows.append("|".join(_cell_to_str(c) for c in cells))

    # Build all 4 CDFs
    cdf_files = {}
    for cic_key, cfg in CIC_CONFIGS.items():
        cdf_files[cic_key] = {
            "data": _build_cdf(rows, from_date, to_date, cic_key),
            "filename": cfg["filename"](from_date, to_date),
        }

    # Build ZIP
    zip_buf = io.BytesIO()
    with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for key, item in cdf_files.items():
            zf.writestr(item["filename"], item["data"].decode("utf-8"))
    zip_data = zip_buf.getvalue()

    # Store in cache
    _evict_expired()
    token = str(uuid.uuid4())
    DOWNLOAD_CACHE[token] = {
        **cdf_files,
        "zip": {
            "data": zip_data,
            "filename": f"CIC_CDF_{from_date}_{to_date}.zip",
        },
        "expires_at": datetime.now(timezone.utc) + timedelta(seconds=TOKEN_TTL_SECONDS),
    }

    return JSONResponse({
        "download_token": token,
        "record_count": len(rows),
        "skipped_count": skipped,
        "expires_in_seconds": TOKEN_TTL_SECONDS,
    })


@router.get("/download/{token}")
async def download_file(token: str, cic: str = ""):
    """Stream a previously generated CDF or ZIP file. No JWT needed — token is the secret."""
    _evict_expired()
    entry = DOWNLOAD_CACHE.get(token)
    if not entry:
        raise HTTPException(status_code=404, detail="Download link not found or expired. Please regenerate.")

    key = cic.lower().strip() if cic and cic.lower().strip() in CIC_CONFIGS else "zip"
    item = entry[key]

    media_type = "application/zip" if key == "zip" else "application/octet-stream"
    return StreamingResponse(
        io.BytesIO(item["data"]),
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{item["filename"]}"'},
    )


@router.get("/access-check")
async def check_access(current_user: dict = Depends(get_current_user)):
    emp_id = current_user.get("employee_id")
    role = current_user.get("role")
    allowed = emp_id in CIC_ALLOWED_EMPLOYEE_IDS or role == "hr_admin"
    return {"allowed": allowed}
