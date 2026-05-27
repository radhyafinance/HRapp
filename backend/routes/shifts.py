"""CRUD for shift definitions.

Each shift can be assigned to multiple roles, but a role can be on at most ONE
shift — picking a role for shift B will auto-remove it from shift A on save.
"""

from datetime import datetime, timezone
from typing import List, Literal, Optional
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth_utils import get_current_user
from database import db
from services.shift_rules import resolve_shift_for

router = APIRouter()

ALLOWED_ROLES = {"hr_admin", "management", "managers", "employee", "field_agent"}
HR_ROLES = ("hr_admin", "management")


def _to_dict(s: dict) -> dict:
    s.pop("_id", None)
    return s


class ShiftIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    start_hour: int = Field(ge=0, le=23)
    start_minute: int = Field(ge=0, le=59)
    end_hour: int = Field(ge=0, le=23)
    end_minute: int = Field(ge=0, le=59)
    grace_minutes: int = Field(default=30, ge=0, le=240)
    min_full_day_hours: float = Field(default=6.0, ge=0.5, le=12.0)
    assigned_roles: List[str] = Field(default_factory=list)
    # saturday_rule controls which Saturdays are weekly off:
    #   "all_working"  – every Saturday is a working day (Field staff default)
    #   "alt_1_3_off"  – 1st & 3rd Saturdays are WO (HO staff)
    #   "alt_2_4_off"  – 2nd & 4th Saturdays are WO
    #   "all_off"      – every Saturday is WO
    saturday_rule: Literal["all_working", "alt_1_3_off", "alt_2_4_off", "all_off"] = Field(default="all_working")
    is_default: bool = False
    is_active: bool = True


def _validate_roles(roles: List[str]) -> List[str]:
    bad = [r for r in roles if r not in ALLOWED_ROLES]
    if bad:
        raise HTTPException(status_code=400, detail=f"Unknown roles: {bad}")
    # de-dupe, preserve order
    seen = set()
    out = []
    for r in roles:
        if r not in seen:
            seen.add(r)
            out.append(r)
    return out


def _require_hr(user: dict):
    if user.get("role") not in HR_ROLES:
        raise HTTPException(status_code=403, detail="Only HR Admin / Management can manage shifts")


@router.get("")
async def list_shifts(current_user: dict = Depends(get_current_user)):
    """Anyone authenticated can read shifts (used in employee edit form)."""
    docs = await db.shifts.find({"is_active": {"$ne": False}}).sort("name", 1).to_list(200)
    return [_to_dict(d) for d in docs]


@router.post("")
async def create_shift(body: ShiftIn, current_user: dict = Depends(get_current_user)):
    _require_hr(current_user)
    roles = _validate_roles(body.assigned_roles)

    # Enforce: one shift per role — pull the role off any other shift first.
    if roles:
        await db.shifts.update_many(
            {"assigned_roles": {"$in": roles}},
            {"$pullAll": {"assigned_roles": roles}},
        )

    # Enforce: at most one default shift.
    if body.is_default:
        await db.shifts.update_many({}, {"$set": {"is_default": False}})

    doc = body.model_dump()
    doc["assigned_roles"] = roles
    doc["id"] = str(uuid.uuid4())
    doc["created_at"] = datetime.now(timezone.utc).isoformat()
    doc["created_by"] = current_user.get("username")
    await db.shifts.insert_one(doc)
    return _to_dict(doc)


@router.put("/{shift_id}")
async def update_shift(shift_id: str, body: ShiftIn, current_user: dict = Depends(get_current_user)):
    _require_hr(current_user)
    existing = await db.shifts.find_one({"id": shift_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Shift not found")

    roles = _validate_roles(body.assigned_roles)
    if roles:
        # Strip these roles off any OTHER shift
        await db.shifts.update_many(
            {"assigned_roles": {"$in": roles}, "id": {"$ne": shift_id}},
            {"$pullAll": {"assigned_roles": roles}},
        )
    if body.is_default:
        await db.shifts.update_many({"id": {"$ne": shift_id}}, {"$set": {"is_default": False}})

    update = body.model_dump()
    update["assigned_roles"] = roles
    update["updated_at"] = datetime.now(timezone.utc).isoformat()
    update["updated_by"] = current_user.get("username")
    await db.shifts.update_one({"id": shift_id}, {"$set": update})
    return _to_dict(await db.shifts.find_one({"id": shift_id}))


@router.delete("/{shift_id}")
async def delete_shift(shift_id: str, current_user: dict = Depends(get_current_user)):
    """Soft-delete by flipping is_active=false (so historical records still resolve)."""
    _require_hr(current_user)
    existing = await db.shifts.find_one({"id": shift_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Shift not found")

    # Refuse to delete the only default shift if it's still default
    if existing.get("is_default"):
        raise HTTPException(
            status_code=400,
            detail="This is the default shift. Pick another default first, then delete.",
        )

    await db.shifts.update_one(
        {"id": shift_id},
        {"$set": {"is_active": False, "deleted_at": datetime.now(timezone.utc).isoformat()}},
    )
    # Detach any employee overrides pointing at this shift
    await db.employees.update_many({"shift_id": shift_id}, {"$unset": {"shift_id": ""}})
    return {"success": True}


@router.get("/resolve/me")
async def resolve_my_shift(current_user: dict = Depends(get_current_user)):
    """Useful for the Attendance UI to show "your shift starts at 7:00 AM"."""
    shift = await resolve_shift_for(
        current_user.get("role"), current_user.get("employee_id"), db
    )
    if shift is None:
        return None
    # Ensure no _id leak (fallback dict has no _id; db dict already has _id stripped via projection)
    shift = dict(shift)
    shift.pop("_id", None)
    return shift


@router.get("/resolve/{employee_id}")
async def resolve_employee_shift(employee_id: str, current_user: dict = Depends(get_current_user)):
    """HR/Management debug helper — what shift does this employee use?"""
    if current_user.get("role") not in ("hr_admin", "management", "managers"):
        raise HTTPException(status_code=403, detail="Access denied")
    emp = await db.employees.find_one({"employee_id": employee_id}, {"_id": 0, "role": 1})
    if not emp:
        raise HTTPException(status_code=404, detail="Employee not found")
    shift = await resolve_shift_for(emp.get("role"), employee_id, db)
    if shift is None:
        return None
    shift = dict(shift)
    shift.pop("_id", None)
    return shift


# -------------------------------------------------------------------------
# Seed migration — run once on app startup if `shifts` collection is empty.
# Called from server.py startup hook.
# -------------------------------------------------------------------------

DEFAULT_SHIFTS = [
    {
        "name": "Field Shift",
        "start_hour": 7, "start_minute": 0,
        "end_hour": 16,  "end_minute": 0,
        "grace_minutes": 30,
        "min_full_day_hours": 6.0,
        "assigned_roles": ["field_agent", "managers"],
        "saturday_rule": "all_working",
        "is_default": False,
        "is_active": True,
    },
    {
        "name": "HO Shift",
        "start_hour": 9, "start_minute": 30,
        "end_hour": 18,  "end_minute": 30,
        "grace_minutes": 30,
        "min_full_day_hours": 6.0,
        "assigned_roles": ["management", "employee"],
        "saturday_rule": "alt_1_3_off",
        "is_default": True,
        "is_active": True,
    },
]


async def seed_default_shifts_if_empty():
    """Idempotent — skipped if any shift already exists."""
    n = await db.shifts.count_documents({})
    if n > 0:
        return 0
    now = datetime.now(timezone.utc).isoformat()
    docs = []
    for s in DEFAULT_SHIFTS:
        docs.append({
            **s,
            "id": str(uuid.uuid4()),
            "created_at": now,
            "created_by": "system",
        })
    await db.shifts.insert_many(docs)
    return len(docs)
