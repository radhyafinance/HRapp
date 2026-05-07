"""Compensatory Off (Comp-Off) Management.

Auto-detects when an employee punches in on a non-working day (Sunday,
holiday, or 1st/3rd Saturday for `employee` role) and surfaces those days
as candidates pending HR approval. On approval, the employee receives
a +1 Comp-Off credit valid for 90 days from the date earned.
Expired and used credits are tracked individually.

Each `comp_off_grants` doc has its own expiry — that's why this is a
separate collection and not part of `leave_balances` (those are bucketed
totals/used/remaining).

Status lifecycle: pending → approved → (used | expired) | rejected.
"""
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional
from database import db
from auth_utils import get_current_user
from datetime import datetime, timezone, date as DateType, timedelta
from bson import ObjectId
from routes.holidays import is_non_working_saturday, get_holiday_dates

router = APIRouter()

EXPIRY_DAYS = 90


async def _notify_compoff_decision(grant: dict, status: str, remarks: str = None):
    """Notify the employee when their comp-off is approved or rejected."""
    try:
        from routes.notifications import create_notification as _notify
        title = "Comp-Off Approved" if status == "approved" else "Comp-Off Rejected"
        msg = f"{grant.get('earn_reason', 'Worked on a non-working day')} — {grant.get('earn_date')}"
        if status == "approved" and grant.get("expiry_date"):
            msg += f". Use by {grant['expiry_date']}."
        if remarks:
            msg += f" · Note: {remarks}"
        await _notify(
            employee_id=grant["employee_id"],
            title=title,
            message=msg,
            type="comp_off",
            link="/leaves",
            meta={"grant_id": str(grant.get("_id") or ""), "status": status},
        )
    except Exception:
        pass


class CompOffApproveBody(BaseModel):
    remarks: Optional[str] = None


class CompOffRejectBody(BaseModel):
    remarks: str


def _to_dict(g: dict) -> dict:
    return {
        "id": str(g["_id"]),
        "employee_id": g.get("employee_id"),
        "earn_date": g.get("earn_date"),
        "earn_reason": g.get("earn_reason"),
        "status": g.get("status"),
        "source": g.get("source", "punch_in"),  # "punch_in" | "regularisation"
        "expiry_date": g.get("expiry_date"),
        "approved_at": g.get("approved_at"),
        "approved_by": g.get("approved_by"),
        "rejected_at": g.get("rejected_at"),
        "rejected_by": g.get("rejected_by"),
        "remarks": g.get("remarks"),
        "used_on": g.get("used_on"),
    }


async def _classify_non_working(d: DateType, role: str) -> Optional[str]:
    """Return 'sunday' | 'saturday_off' | 'holiday:<name>' | None."""
    if d.weekday() == 6:
        return "Sunday"
    if is_non_working_saturday(d, role):
        return "1st/3rd Saturday Off"
    holiday = await db.holidays.find_one({"date": d.isoformat()}, {"_id": 0, "name": 1})
    if holiday:
        return f"Holiday: {holiday['name']}"
    return None


async def _expire_old_grants():
    """Mark approved comp-offs that crossed expiry as 'expired'. Idempotent."""
    today = DateType.today().isoformat()
    await db.comp_off_grants.update_many(
        {"status": "approved", "expiry_date": {"$lt": today}},
        {"$set": {"status": "expired"}},
    )


# ──────────────────────────────────────────────────────────────
#  Scan for candidates
# ──────────────────────────────────────────────────────────────

@router.post("/scan-candidates")
async def scan_candidates(
    days_back: int = 60,
    current_user: dict = Depends(get_current_user),
):
    """Scan attendance records from the last N days and create 'pending'
    comp-off entries for anyone who punched in on a non-working day and
    doesn't already have a pending/approved comp-off for that date."""
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    if days_back <= 0 or days_back > 365:
        raise HTTPException(status_code=400, detail="days_back must be 1..365")

    since = (DateType.today() - timedelta(days=days_back)).isoformat()
    today_iso = DateType.today().isoformat()

    # Pull punch-in records in the window
    records = await db.attendance_records.find(
        {"date": {"$gte": since, "$lte": today_iso}, "punch_in_time": {"$ne": None}},
        {"_id": 0, "employee_id": 1, "date": 1, "punch_in_time": 1, "hours_worked": 1},
    ).to_list(5000)

    if not records:
        return {"candidates_created": 0, "message": "No punch-in records in scan window."}

    # Pull employee role map (drives the Saturday rule)
    emp_ids = list({r["employee_id"] for r in records})
    employees = await db.employees.find(
        {"employee_id": {"$in": emp_ids}}, {"_id": 0, "employee_id": 1, "role": 1}
    ).to_list(2000)
    role_map = {e["employee_id"]: e.get("role") or "employee" for e in employees}

    # Pre-fetch holiday dates per relevant year
    years = {DateType.fromisoformat(r["date"]).year for r in records}
    holiday_set = set()
    for y in years:
        holiday_set |= await get_holiday_dates(y)

    candidates_created = 0
    for r in records:
        emp_id = r["employee_id"]
        d_str = r["date"]
        try:
            d = DateType.fromisoformat(d_str)
        except ValueError:
            continue
        role = role_map.get(emp_id, "employee")

        # Determine non-working reason
        reason = None
        if d.weekday() == 6:
            reason = "Sunday"
        elif is_non_working_saturday(d, role):
            reason = "1st/3rd Saturday Off"
        elif d_str in holiday_set:
            h = await db.holidays.find_one({"date": d_str}, {"_id": 0, "name": 1})
            reason = f"Holiday: {h['name']}" if h else "Holiday"
        if not reason:
            continue

        # Skip if already tracked
        existing = await db.comp_off_grants.find_one({
            "employee_id": emp_id,
            "earn_date": d_str,
            "status": {"$in": ["pending", "approved", "used", "rejected"]},
        })
        if existing:
            continue

        await db.comp_off_grants.insert_one({
            "employee_id": emp_id,
            "earn_date": d_str,
            "earn_reason": reason,
            "hours_worked": r.get("hours_worked"),
            "status": "pending",
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
        candidates_created += 1

    return {
        "candidates_created": candidates_created,
        "scanned_records": len(records),
        "window_from": since,
    }


# ──────────────────────────────────────────────────────────────
#  Listing
# ──────────────────────────────────────────────────────────────

@router.get("/pending")
async def list_pending(current_user: dict = Depends(get_current_user)):
    """All pending comp-off candidates awaiting HR approval, with
    employee names attached for the UI."""
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    grants = await db.comp_off_grants.find(
        {"status": "pending"}
    ).sort("earn_date", -1).to_list(1000)
    if not grants:
        return []
    emp_ids = list({g["employee_id"] for g in grants})
    employees = await db.employees.find(
        {"employee_id": {"$in": emp_ids}},
        {"_id": 0, "employee_id": 1, "first_name": 1, "last_name": 1, "designation": 1},
    ).to_list(2000)
    emap = {e["employee_id"]: e for e in employees}
    out = []
    for g in grants:
        d = _to_dict(g)
        e = emap.get(g["employee_id"], {})
        d["employee_name"] = f"{e.get('first_name','')} {e.get('last_name','')}".strip() or g["employee_id"]
        d["designation"] = e.get("designation", "")
        d["hours_worked"] = g.get("hours_worked")
        out.append(d)
    return out


@router.get("/balance/{employee_id}")
async def employee_balance(employee_id: str, current_user: dict = Depends(get_current_user)):
    """Return all approved-and-not-yet-used comp-offs for the employee.
    Includes earn_date and expiry_date so the UI can show 'expires in N days'."""
    role = current_user.get("role")
    if role not in ["hr_admin", "management", "managers"] and current_user.get("employee_id") != employee_id:
        raise HTTPException(status_code=403, detail="Access denied")
    await _expire_old_grants()
    grants = await db.comp_off_grants.find(
        {"employee_id": employee_id, "status": "approved"}
    ).sort("expiry_date", 1).to_list(500)
    return [_to_dict(g) for g in grants]


@router.get("/all")
async def list_all_grants(
    employee_id: Optional[str] = None,
    status: Optional[str] = None,
    current_user: dict = Depends(get_current_user),
):
    """Audit-friendly listing of every comp-off entry with optional filters.
    HR/management only."""
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    await _expire_old_grants()
    q = {}
    if employee_id:
        q["employee_id"] = employee_id
    if status:
        q["status"] = status
    grants = await db.comp_off_grants.find(q).sort("earn_date", -1).limit(1000).to_list(1000)
    if not grants:
        return []
    emp_ids = list({g["employee_id"] for g in grants})
    employees = await db.employees.find(
        {"employee_id": {"$in": emp_ids}},
        {"_id": 0, "employee_id": 1, "first_name": 1, "last_name": 1},
    ).to_list(2000)
    emap = {e["employee_id"]: e for e in employees}
    out = []
    for g in grants:
        d = _to_dict(g)
        e = emap.get(g["employee_id"], {})
        d["employee_name"] = f"{e.get('first_name','')} {e.get('last_name','')}".strip() or g["employee_id"]
        out.append(d)
    return out


# ──────────────────────────────────────────────────────────────
#  Approve / Reject
# ──────────────────────────────────────────────────────────────

@router.put("/{grant_id}/approve")
async def approve_grant(
    grant_id: str,
    body: CompOffApproveBody,
    current_user: dict = Depends(get_current_user),
):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    g = await db.comp_off_grants.find_one({"_id": ObjectId(grant_id)})
    if not g:
        raise HTTPException(status_code=404, detail="Comp-off grant not found")
    if g.get("status") != "pending":
        raise HTTPException(status_code=400, detail=f"Grant is in status '{g.get('status')}', cannot approve.")

    earn = DateType.fromisoformat(g["earn_date"])
    expiry = (earn + timedelta(days=EXPIRY_DAYS)).isoformat()

    await db.comp_off_grants.update_one(
        {"_id": ObjectId(grant_id)},
        {"$set": {
            "status": "approved",
            "expiry_date": expiry,
            "approved_at": datetime.now(timezone.utc).isoformat(),
            "approved_by": current_user.get("employee_id") or current_user.get("username"),
            "remarks": (body.remarks or "").strip() or None,
        }},
    )
    g = await db.comp_off_grants.find_one({"_id": ObjectId(grant_id)})
    await _notify_compoff_decision(g, "approved", body.remarks)
    return _to_dict(g)


@router.put("/{grant_id}/reject")
async def reject_grant(
    grant_id: str,
    body: CompOffRejectBody,
    current_user: dict = Depends(get_current_user),
):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    if not body.remarks or not body.remarks.strip():
        raise HTTPException(status_code=400, detail="Reason is required when rejecting.")
    g = await db.comp_off_grants.find_one({"_id": ObjectId(grant_id)})
    if not g:
        raise HTTPException(status_code=404, detail="Comp-off grant not found")
    if g.get("status") != "pending":
        raise HTTPException(status_code=400, detail=f"Grant is in status '{g.get('status')}', cannot reject.")
    await db.comp_off_grants.update_one(
        {"_id": ObjectId(grant_id)},
        {"$set": {
            "status": "rejected",
            "rejected_at": datetime.now(timezone.utc).isoformat(),
            "rejected_by": current_user.get("employee_id") or current_user.get("username"),
            "remarks": body.remarks.strip(),
        }},
    )
    g = await db.comp_off_grants.find_one({"_id": ObjectId(grant_id)})
    await _notify_compoff_decision(g, "rejected", body.remarks)
    return _to_dict(g)


@router.post("/expire")
async def force_expire(current_user: dict = Depends(get_current_user)):
    """Manual trigger to expire approved comp-offs past their 90-day window."""
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    today = DateType.today().isoformat()
    res = await db.comp_off_grants.update_many(
        {"status": "approved", "expiry_date": {"$lt": today}},
        {"$set": {"status": "expired"}},
    )
    return {"expired": res.modified_count}
