"""Holidays & Working-Day Calendar.

Manages the company holiday list (calendar year scope), the Sunday rule
(off for all roles), and the 1st/3rd Saturday rule (off only for role
`employee`). Provides utility helpers used by attendance, leave, and
comp-off systems.
"""
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field
from typing import Optional, List
from database import db
from auth_utils import get_current_user
from datetime import datetime, timezone, date as DateType, timedelta
from bson import ObjectId

router = APIRouter()

HOLIDAY_TYPES = ("national", "festival", "company", "regional")


class HolidayBody(BaseModel):
    date: str                       # YYYY-MM-DD
    name: str = Field(..., min_length=1, max_length=80)
    type: str = "festival"          # national | festival | company | regional
    description: Optional[str] = None


def _holiday_to_dict(h: dict) -> dict:
    return {
        "id": str(h["_id"]),
        "date": h.get("date"),
        "name": h.get("name"),
        "type": h.get("type", "festival"),
        "description": h.get("description"),
        "year": h.get("year"),
    }


def is_first_or_third_saturday(d: DateType) -> bool:
    """Return True if `d` is the 1st or 3rd Saturday of its month."""
    if d.weekday() != 5:  # 5 = Saturday
        return False
    week_in_month = (d.day - 1) // 7 + 1   # 1, 2, 3, 4, 5
    return week_in_month in (1, 3)


def is_non_working_saturday(d: DateType, role: str) -> bool:
    """Per company policy: Only role `employee` gets 1st & 3rd Saturday off."""
    return role == "employee" and is_first_or_third_saturday(d)


async def get_holiday_dates(year: int) -> set:
    """Set of YYYY-MM-DD strings for holidays in the given calendar year."""
    cursor = db.holidays.find(
        {"year": year}, {"_id": 0, "date": 1}
    )
    return {h["date"] async for h in cursor}


async def is_working_day(d: DateType, role: str = "employee") -> bool:
    """True if the date is a normal working day for the given role."""
    if d.weekday() == 6:           # Sunday → off for all
        return False
    if is_non_working_saturday(d, role):
        return False
    holidays = await get_holiday_dates(d.year)
    if d.isoformat() in holidays:
        return False
    return True


# ──────────────────────────────────────────────────────────────
#  CRUD
# ──────────────────────────────────────────────────────────────

@router.get("")
async def list_holidays(year: Optional[int] = None, current_user: dict = Depends(get_current_user)):
    """List all holidays. Optional ?year=YYYY filter (calendar year)."""
    q = {}
    if year:
        q["year"] = year
    cursor = db.holidays.find(q).sort("date", 1)
    out = []
    async for h in cursor:
        out.append(_holiday_to_dict(h))
    return out


@router.post("")
async def create_holiday(body: HolidayBody, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    if body.type not in HOLIDAY_TYPES:
        raise HTTPException(status_code=400, detail=f"type must be one of {HOLIDAY_TYPES}")
    try:
        d = datetime.strptime(body.date, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")

    existing = await db.holidays.find_one({"date": body.date})
    if existing:
        raise HTTPException(status_code=409, detail=f"A holiday already exists on {body.date}: {existing.get('name')}")

    doc = {
        "date": body.date,
        "name": body.name.strip(),
        "type": body.type,
        "description": (body.description or "").strip() or None,
        "year": d.year,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "created_by": current_user.get("employee_id") or current_user.get("username"),
    }
    res = await db.holidays.insert_one(doc)
    doc["_id"] = res.inserted_id
    return _holiday_to_dict(doc)


@router.put("/{holiday_id}")
async def update_holiday(holiday_id: str, body: HolidayBody, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    if body.type not in HOLIDAY_TYPES:
        raise HTTPException(status_code=400, detail=f"type must be one of {HOLIDAY_TYPES}")
    try:
        d = datetime.strptime(body.date, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")

    res = await db.holidays.update_one(
        {"_id": ObjectId(holiday_id)},
        {"$set": {
            "date": body.date,
            "name": body.name.strip(),
            "type": body.type,
            "description": (body.description or "").strip() or None,
            "year": d.year,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "updated_by": current_user.get("employee_id") or current_user.get("username"),
        }},
    )
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Holiday not found")
    h = await db.holidays.find_one({"_id": ObjectId(holiday_id)})
    return _holiday_to_dict(h)


@router.delete("/{holiday_id}")
async def delete_holiday(holiday_id: str, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    res = await db.holidays.delete_one({"_id": ObjectId(holiday_id)})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Holiday not found")
    return {"deleted": True}


# ──────────────────────────────────────────────────────────────
#  Calendar view
# ──────────────────────────────────────────────────────────────

@router.get("/calendar")
async def calendar_view(
    year: int,
    role: str = "employee",
    current_user: dict = Depends(get_current_user),
):
    """Return every non-working day in the given calendar year for the
    given role. Used by the Calendar page to render an at-a-glance view."""
    if year < 2020 or year > 2100:
        raise HTTPException(status_code=400, detail="Unreasonable year")

    holidays = await db.holidays.find({"year": year}, {"_id": 0}).sort("date", 1).to_list(500)
    holiday_map = {h["date"]: h for h in holidays}

    out = []
    d = DateType(year, 1, 1)
    end = DateType(year, 12, 31)
    while d <= end:
        info = None
        iso = d.isoformat()
        if iso in holiday_map:
            h = holiday_map[iso]
            info = {"type": "holiday", "label": h["name"], "subtype": h.get("type"),
                    "description": h.get("description")}
        elif d.weekday() == 6:
            info = {"type": "sunday", "label": "Sunday Off"}
        elif is_non_working_saturday(d, role):
            info = {"type": "saturday_off", "label": "1st/3rd Saturday Off",
                    "subtype": "Applicable to Employee role only"}
        if info:
            info["date"] = iso
            info["weekday"] = d.strftime("%A")
            out.append(info)
        d += timedelta(days=1)
    return out


# ──────────────────────────────────────────────────────────────
#  Seed default Indian holidays
# ──────────────────────────────────────────────────────────────

# Source: Government of India gazetted holidays + common festival dates.
# Dates are FIXED for fixed-date holidays; for variable-date festivals
# (like Diwali, Holi) we provide the most-cited date for each year.
_DEFAULT_HOLIDAYS = {
    2025: [
        ("2025-01-26", "Republic Day", "national"),
        ("2025-03-14", "Holi", "festival"),
        ("2025-03-31", "Eid-ul-Fitr", "festival"),
        ("2025-04-14", "Dr. Ambedkar Jayanti", "national"),
        ("2025-04-18", "Good Friday", "festival"),
        ("2025-05-01", "Labour Day", "national"),
        ("2025-08-15", "Independence Day", "national"),
        ("2025-08-27", "Ganesh Chaturthi", "festival"),
        ("2025-10-02", "Gandhi Jayanti", "national"),
        ("2025-10-21", "Diwali", "festival"),
        ("2025-11-05", "Guru Nanak Jayanti", "festival"),
        ("2025-12-25", "Christmas", "festival"),
    ],
    2026: [
        ("2026-01-26", "Republic Day", "national"),
        ("2026-03-04", "Holi", "festival"),
        ("2026-03-21", "Eid-ul-Fitr", "festival"),
        ("2026-04-03", "Good Friday", "festival"),
        ("2026-04-14", "Dr. Ambedkar Jayanti", "national"),
        ("2026-05-01", "Labour Day", "national"),
        ("2026-08-15", "Independence Day", "national"),
        ("2026-09-15", "Ganesh Chaturthi", "festival"),
        ("2026-10-02", "Gandhi Jayanti", "national"),
        ("2026-11-08", "Diwali", "festival"),
        ("2026-11-24", "Guru Nanak Jayanti", "festival"),
        ("2026-12-25", "Christmas", "festival"),
    ],
    2027: [
        ("2027-01-26", "Republic Day", "national"),
        ("2027-02-22", "Holi", "festival"),
        ("2027-03-11", "Eid-ul-Fitr", "festival"),
        ("2027-03-26", "Good Friday", "festival"),
        ("2027-04-14", "Dr. Ambedkar Jayanti", "national"),
        ("2027-05-01", "Labour Day", "national"),
        ("2027-08-15", "Independence Day", "national"),
        ("2027-09-04", "Ganesh Chaturthi", "festival"),
        ("2027-10-02", "Gandhi Jayanti", "national"),
        ("2027-10-29", "Diwali", "festival"),
        ("2027-11-14", "Guru Nanak Jayanti", "festival"),
        ("2027-12-25", "Christmas", "festival"),
    ],
}


@router.post("/seed-defaults")
async def seed_defaults(year: int, current_user: dict = Depends(get_current_user)):
    """One-click seed of the default Indian holiday list for the given calendar year.
    Skips dates that already exist."""
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    presets = _DEFAULT_HOLIDAYS.get(year)
    if not presets:
        raise HTTPException(
            status_code=400,
            detail=f"No default holiday template for year {year}. Add holidays manually.",
        )

    inserted, skipped = 0, 0
    changed_by = current_user.get("employee_id") or current_user.get("username")
    for d_str, name, htype in presets:
        existing = await db.holidays.find_one({"date": d_str})
        if existing:
            skipped += 1
            continue
        await db.holidays.insert_one({
            "date": d_str,
            "name": name,
            "type": htype,
            "description": None,
            "year": year,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "created_by": changed_by,
        })
        inserted += 1
    return {
        "year": year,
        "inserted": inserted,
        "skipped_existing": skipped,
        "message": f"Seeded {inserted} default holiday(s) for {year} ({skipped} already existed).",
    }
