from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional
from database import db
from auth_utils import get_current_user
from services.face_match import compare_face_with_reference, DEFAULT_TOLERANCE
from services.shift_rules import (
    compute_punch_in_status_with_shift,
    compute_status_after_punch_out_with_shift,
    resolve_shift_for,
)
from datetime import datetime, timezone, date, timedelta
import asyncio
import math
import os
import logging
from concurrent.futures import ThreadPoolExecutor

logger = logging.getLogger(__name__)
router = APIRouter()

# Thread pool for CPU-bound face matching so the async event loop is never blocked.
# dlib releases the GIL during HOG face detection, so multiple threads run in parallel.
_FACE_EXECUTOR = ThreadPoolExecutor(max_workers=4, thread_name_prefix="face_match")

OFFICE_LOCATIONS_CACHE = []

# Asia/Kolkata fixed offset — used for interpreting HR-entered HH:MM regularisation times
IST_TZ = timezone(timedelta(hours=5, minutes=30))


def haversine_distance(lat1, lon1, lat2, lon2):
    R = 6371000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


async def check_geofence(lat: float, lon: float):
    locations = await db.office_locations.find({}).to_list(100)
    for loc in locations:
        dist = haversine_distance(lat, lon, loc["latitude"], loc["longitude"])
        radius = loc.get("radius_meters", 10)
        if dist <= radius:
            return True, loc["name"], dist
    return False, None, None


async def _is_face_match_strict() -> bool:
    """Read the global face-match strict flag from settings (default False = warn-but-allow)."""
    settings = await db.app_settings.find_one({"key": "face_match"}) or {}
    return bool(settings.get("strict", False))


# ──────────────────────────────────────────────────────────────
#  Face-mismatch photo retention policy
# ──────────────────────────────────────────────────────────────
FACE_PHOTO_RETENTION_DAYS = 45


async def purge_old_face_mismatch_photos() -> dict:
    """Strip face-mismatch selfies from attendance records older than the retention window.

    Photos are only stored when face match fails (see punch_in / punch_out logic).
    Once 45 days have passed, the photo's audit value drops to near zero — but the
    metadata (matched flag, distance, warning, location) stays for compliance.
    Idempotent: subsequent calls do nothing once cleared.
    """
    cutoff_date = (date.today() - timedelta(days=FACE_PHOTO_RETENTION_DAYS)).isoformat()

    # Top-level photos (legacy single-session schema + mirror fields on multi-session records)
    res_top = await db.attendance_records.update_many(
        {
            "date": {"$lt": cutoff_date},
            "$or": [
                {"punch_in_photo": {"$nin": [None, ""]}},
                {"punch_out_photo": {"$nin": [None, ""]}},
            ],
        },
        {"$unset": {"punch_in_photo": "", "punch_out_photo": ""}},
    )

    # Per-session photos inside the sessions[] array
    res_sessions = await db.attendance_records.update_many(
        {
            "date": {"$lt": cutoff_date},
            "$or": [
                {"sessions.punch_in_photo": {"$nin": [None, ""]}},
                {"sessions.punch_out_photo": {"$nin": [None, ""]}},
            ],
        },
        {"$set": {
            "sessions.$[].punch_in_photo": None,
            "sessions.$[].punch_out_photo": None,
        }},
    )

    return {
        "cutoff_date": cutoff_date,
        "retention_days": FACE_PHOTO_RETENTION_DAYS,
        "top_level_records_purged": res_top.modified_count,
        "session_records_purged": res_sessions.modified_count,
    }


async def _verify_face(employee_id: str, selfie_b64: Optional[str]) -> dict:
    """Compare selfie against the employee's passport_photo.

    Runs the CPU-intensive dlib face matching in a thread-pool executor so the
    async event loop is never blocked.  Times out after 25 s to prevent a single
    slow comparison from holding up the whole server.

    Returns a dict: {
        ok: bool,             # True if the request can proceed
        matched: bool|None,   # True / False / None (no reference)
        distance: float|None,
        reason: str|None,     # populated when ok=False or match failed
        strict: bool,
    }
    """
    strict = await _is_face_match_strict()
    docs = await db.employee_documents.find_one({"employee_id": employee_id}) or {}
    passport = docs.get("passport_photo")
    # passport is stored as {"data": <base64>, "mime": ..., ...}
    reference = passport.get("data") if isinstance(passport, dict) else passport

    # Per requirement: block punch if no passport_photo on file.
    if not reference:
        return {
            "ok": False,
            "matched": None,
            "distance": None,
            "reason": "Face verification not possible — no passport-size photo on file. Ask HR to upload it under Employees → Documents.",
            "strict": strict,
        }
    if not selfie_b64:
        return {
            "ok": False,
            "matched": None,
            "distance": None,
            "reason": "Selfie required for punch.",
            "strict": strict,
        }

    # Run blocking dlib call in thread pool — keeps event loop free for other requests
    try:
        loop = asyncio.get_running_loop()
        matched, distance, reason = await asyncio.wait_for(
            loop.run_in_executor(
                _FACE_EXECUTOR,
                compare_face_with_reference,
                selfie_b64,
                reference,
                DEFAULT_TOLERANCE,
            ),
            timeout=25.0,
        )
    except asyncio.TimeoutError:
        logger.error("[face_match] timeout for employee %s", employee_id)
        # In non-strict mode allow the punch through with a flag so attendance
        # is not lost; in strict mode block to prevent impersonation.
        if strict:
            return {"ok": False, "matched": None, "distance": None,
                    "reason": "Face verification timed out. Please retry or contact HR.", "strict": strict}
        return {"ok": True, "matched": None, "distance": None,
                "reason": "Face verification timed out; punch allowed with flag.", "strict": strict}
    except Exception as exc:
        logger.error("[face_match] unexpected error for %s: %s", employee_id, exc)
        if strict:
            return {"ok": False, "matched": None, "distance": None,
                    "reason": "Face verification failed. Please retry or contact HR.", "strict": strict}
        return {"ok": True, "matched": None, "distance": None,
                "reason": "Face verification error; punch allowed with warning.", "strict": strict}

    if reason and not matched:
        # Couldn't run match (no face detected, decode error, etc.)
        if strict:
            return {"ok": False, "matched": False, "distance": distance, "reason": reason, "strict": strict}
        # Warn-but-allow mode: still let punch through but flag it
        return {"ok": True, "matched": False, "distance": distance, "reason": reason, "strict": strict}

    if not matched and strict:
        return {
            "ok": False,
            "matched": False,
            "distance": distance,
            "reason": f"Face does not match passport photo on file (distance {distance}). Contact HR.",
            "strict": strict,
        }

    return {
        "ok": True,
        "matched": matched,
        "distance": distance,
        "reason": None if matched else f"Face match weak (distance {distance}); HR will review.",
        "strict": strict,
    }


def att_to_dict(a):
    a["id"] = str(a.pop("_id"))
    return a


class PunchRequest(BaseModel):
    employee_id: str
    latitude: float
    longitude: float
    photo_base64: Optional[str] = None
    accuracy: Optional[float] = None


class LocationUpdateRequest(BaseModel):
    employee_id: str
    latitude: float
    longitude: float
    accuracy: Optional[float] = None


@router.post("/admin/purge-old-face-photos")
async def admin_purge_old_face_photos(current_user: dict = Depends(get_current_user)):
    """Manually trigger the 45-day face-mismatch photo cleanup. HR Admin only."""
    if current_user.get("role") != "hr_admin":
        raise HTTPException(status_code=403, detail="HR Admin only")
    return await purge_old_face_mismatch_photos()


@router.post("/punch-in")
async def punch_in(data: PunchRequest, current_user: dict = Depends(get_current_user)):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    existing = await db.attendance_records.find_one(
        {"employee_id": data.employee_id, "date": today}
    )

    # Multi-session attendance — opt-in per employee
    emp_doc = await db.employees.find_one(
        {"employee_id": data.employee_id},
        {"_id": 0, "multi_session_attendance": 1},
    ) or {}
    multi_session = bool(emp_doc.get("multi_session_attendance"))

    sessions = list((existing or {}).get("sessions") or [])

    # Migrate legacy records: punch_in_time stored flat (no sessions array).
    # Reconstruct sessions from top-level fields so is_first_session is correct
    # and the grace-period check is never applied to a 2nd/3rd punch-in.
    if not sessions and existing and existing.get("punch_in_time"):
        sessions = [{
            "punch_in_time": existing.get("punch_in_time"),
            "punch_in_location": existing.get("punch_in_location"),
            "punch_in_face_matched": existing.get("punch_in_face_matched"),
            "punch_in_face_distance": existing.get("punch_in_face_distance"),
            "punch_in_face_warning": existing.get("punch_in_face_warning"),
            "punch_in_photo": existing.get("punch_in_photo"),
            "geofence_verified": existing.get("geofence_verified"),
            "distance_from_office": existing.get("distance_from_office"),
            "location_name": existing.get("location_name"),
            "punch_out_time": existing.get("punch_out_time"),
            "punch_out_location": existing.get("punch_out_location"),
            "punch_out_face_matched": existing.get("punch_out_face_matched"),
            "punch_out_face_distance": existing.get("punch_out_face_distance"),
            "punch_out_face_warning": existing.get("punch_out_face_warning"),
            "punch_out_photo": existing.get("punch_out_photo"),
            "hours_worked": existing.get("hours_worked"),
        }]

    last_session_open = bool(sessions and not sessions[-1].get("punch_out_time"))

    if existing and existing.get("punch_in_time"):
        if not multi_session:
            raise HTTPException(status_code=400, detail="Already punched in today")
        if last_session_open:
            raise HTTPException(status_code=400, detail="A session is already open. Punch out first.")

    in_fence, location_name, distance = await check_geofence(data.latitude, data.longitude)

    # Face match (skipped for management role)
    face_result = {"ok": True, "matched": None, "distance": None, "reason": None, "strict": False}
    if current_user.get("role") != "management":
        face_result = await _verify_face(data.employee_id, data.photo_base64)
        if not face_result["ok"]:
            raise HTTPException(status_code=400, detail=face_result["reason"])

    now = datetime.now(timezone.utc)
    punch_in_iso = now.isoformat()
    # is_first_session = True only when there is genuinely no previous punch today
    is_first_session = not sessions

    # Auto status from shift rules — skip if HR has already locked the day via regularisation.
    # Late-rule is evaluated against the FIRST punch-in of the day only.
    locked_by_hr = bool(existing and existing.get("regularised"))
    if locked_by_hr:
        auto_status = existing.get("status") or "present"
        late_minutes = existing.get("late_minutes", 0)
        auto_reason = existing.get("auto_status_reason")
        shift_used = None
    elif not is_first_session:
        # Subsequent session — only carry forward the "late_punch_in" lock from session 1.
        # "short_hours" is an intermediate state set at punch-out; it should not
        # penalise the employee when they open a new session (more hours are coming).
        # Grace-period (late_punch_in) is the only permanent penalty.
        existing_status = existing.get("status") or "present"
        existing_reason = existing.get("auto_status_reason")
        if existing_status == "half_day" and existing_reason == "late_punch_in":
            auto_status = "half_day"
            late_minutes = existing.get("late_minutes", 0)
            auto_reason = "late_punch_in"
        else:
            # Reset to present — punch-out will recompute from total hours
            auto_status = "present"
            late_minutes = 0
            auto_reason = None
        shift_used = None
    else:
        shift_used = await resolve_shift_for(current_user.get("role"), data.employee_id, db)
        rule = compute_punch_in_status_with_shift(shift_used, punch_in_iso, today)
        auto_status = rule["status"]
        late_minutes = rule["late_minutes"]
        auto_reason = rule["reason"]

    # Only persist the selfie if face match failed/flagged — saves DB space when matched
    keep_photo = data.photo_base64 if face_result.get("matched") == False else None

    new_session = {
        "punch_in_time": punch_in_iso,
        "punch_in_location": {"lat": data.latitude, "lon": data.longitude, "name": location_name},
        "punch_in_face_matched": face_result.get("matched"),
        "punch_in_face_distance": face_result.get("distance"),
        "punch_in_face_warning": face_result.get("reason") if face_result.get("matched") == False else None,
        "punch_in_photo": keep_photo,
        "geofence_verified": in_fence,
        "distance_from_office": round(distance, 2) if distance else None,
        "location_name": location_name,
        "punch_out_time": None,
    }
    sessions.append(new_session)

    record_set = {
        "sessions": sessions,
        # Top-level mirrors first session's punch-in (and is reset on day re-open)
        "punch_in_time": sessions[0]["punch_in_time"],
        "punch_in_location": sessions[0]["punch_in_location"],
        "punch_in_photo": sessions[0]["punch_in_photo"],
        "punch_in_face_matched": sessions[0]["punch_in_face_matched"],
        "punch_in_face_distance": sessions[0]["punch_in_face_distance"],
        "punch_in_face_warning": sessions[0]["punch_in_face_warning"],
        "geofence_verified": sessions[0]["geofence_verified"],
        "distance_from_office": sessions[0]["distance_from_office"],
        "location_name": sessions[0]["location_name"],
        "status": auto_status,
        "late_minutes": late_minutes,
        "auto_status_reason": auto_reason,
        "punch_out_time": None,  # day re-opened
        "session_count": len(sessions),
    }
    if is_first_session:
        record_set["shift_id"] = (shift_used or {}).get("id") if not locked_by_hr else (existing or {}).get("shift_id")
        record_set["shift_name"] = (shift_used or {}).get("name") if not locked_by_hr else (existing or {}).get("shift_name")
        record_set["employee_id"] = data.employee_id
        record_set["date"] = today

    if existing:
        await db.attendance_records.update_one({"_id": existing["_id"]}, {"$set": record_set})
    else:
        await db.attendance_records.insert_one(record_set)

    half_day_msg = ""
    if auto_status == "half_day" and auto_reason == "late_punch_in":
        half_day_msg = f" — marked Half Day (late by {late_minutes} min)"
    elif not is_first_session:
        half_day_msg = f" — session #{len(sessions)} started"
    return {
        "success": True,
        "geofence_verified": in_fence,
        "location_name": location_name,
        "distance_meters": round(distance, 2) if distance else None,
        "punch_in_time": now.isoformat(),
        "session_count": len(sessions),
        "status": auto_status,
        "late_minutes": late_minutes,
        "auto_status_reason": auto_reason,
        "face_matched": face_result.get("matched"),
        "face_distance": face_result.get("distance"),
        "face_warning": face_result.get("reason") if face_result.get("matched") == False else None,
        "message": f"Punched in {'within geofence' if in_fence else 'OUTSIDE geofence'}" + (f" at {location_name}" if location_name else "") + half_day_msg,
    }


@router.post("/punch-out")
async def punch_out(data: PunchRequest, current_user: dict = Depends(get_current_user)):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    record = await db.attendance_records.find_one(
        {"employee_id": data.employee_id, "date": today}
    )
    if not record:
        raise HTTPException(status_code=400, detail="No punch-in found for today")

    sessions = list(record.get("sessions") or [])
    # Migrate legacy single-session record into the new schema on the fly
    if not sessions and record.get("punch_in_time"):
        sessions = [{
            "punch_in_time": record.get("punch_in_time"),
            "punch_in_location": record.get("punch_in_location"),
            "punch_in_face_matched": record.get("punch_in_face_matched"),
            "punch_in_face_distance": record.get("punch_in_face_distance"),
            "punch_in_face_warning": record.get("punch_in_face_warning"),
            "punch_in_photo": record.get("punch_in_photo"),
            "geofence_verified": record.get("geofence_verified"),
            "distance_from_office": record.get("distance_from_office"),
            "location_name": record.get("location_name"),
            "punch_out_time": record.get("punch_out_time"),
            "punch_out_location": record.get("punch_out_location"),
            "punch_out_face_matched": record.get("punch_out_face_matched"),
            "punch_out_face_distance": record.get("punch_out_face_distance"),
            "punch_out_face_warning": record.get("punch_out_face_warning"),
            "punch_out_photo": record.get("punch_out_photo"),
            "hours_worked": record.get("hours_worked"),
        }]

    # Find the last open session (no punch_out_time)
    open_idx = None
    for i in range(len(sessions) - 1, -1, -1):
        if not sessions[i].get("punch_out_time"):
            open_idx = i
            break

    # Only block if the multi-session-disabled employee has already closed their single session.
    emp_doc = await db.employees.find_one(
        {"employee_id": data.employee_id},
        {"_id": 0, "multi_session_attendance": 1},
    ) or {}
    multi_session = bool(emp_doc.get("multi_session_attendance"))
    if open_idx is None:
        if multi_session:
            raise HTTPException(status_code=400, detail="No open session to punch out. Punch in first.")
        raise HTTPException(status_code=400, detail="Already punched out today")

    in_fence, location_name, distance = await check_geofence(data.latitude, data.longitude)

    # Face match (skipped for management role)
    face_result = {"ok": True, "matched": None, "distance": None, "reason": None, "strict": False}
    if current_user.get("role") != "management":
        face_result = await _verify_face(data.employee_id, data.photo_base64)
        if not face_result["ok"]:
            raise HTTPException(status_code=400, detail=face_result["reason"])

    now = datetime.now(timezone.utc)
    keep_photo = data.photo_base64 if face_result.get("matched") == False else None

    # Close the open session
    open_session = sessions[open_idx]
    try:
        sess_in_dt = datetime.fromisoformat(open_session["punch_in_time"])
    except (TypeError, ValueError):
        sess_in_dt = now
    session_hours = round((now - sess_in_dt).total_seconds() / 3600, 2)
    open_session["punch_out_time"] = now.isoformat()
    open_session["punch_out_location"] = {"lat": data.latitude, "lon": data.longitude, "name": location_name}
    open_session["punch_out_photo"] = keep_photo
    open_session["punch_out_face_matched"] = face_result.get("matched")
    open_session["punch_out_face_distance"] = face_result.get("distance")
    open_session["punch_out_face_warning"] = face_result.get("reason") if face_result.get("matched") == False else None
    open_session["hours_worked"] = session_hours
    sessions[open_idx] = open_session

    # Total hours = sum of every closed session
    total_hours = round(
        sum((s.get("hours_worked") or 0) for s in sessions if s.get("punch_out_time")),
        2,
    )

    # Recompute status — skipped if HR has regularised the day.
    locked_by_hr = bool(record.get("regularised"))
    if locked_by_hr:
        new_status = record.get("status") or "present"
        new_reason = record.get("auto_status_reason")
    else:
        shift_used = await resolve_shift_for(current_user.get("role"), data.employee_id, db)
        rule = compute_status_after_punch_out_with_shift(
            shift_used,
            current_status=record.get("status"),
            current_reason=record.get("auto_status_reason"),
            hours_worked=total_hours,
        )
        new_status = rule["status"]
        new_reason = rule["reason"]

    await db.attendance_records.update_one(
        {"_id": record["_id"]},
        {"$set": {
            "sessions": sessions,
            "session_count": len(sessions),
            "punch_out_time": now.isoformat(),
            "punch_out_location": {"lat": data.latitude, "lon": data.longitude, "name": location_name},
            "punch_out_photo": keep_photo,
            "punch_out_face_matched": face_result.get("matched"),
            "punch_out_face_distance": face_result.get("distance"),
            "punch_out_face_warning": face_result.get("reason") if face_result.get("matched") == False else None,
            "hours_worked": total_hours,
            "status": new_status,
            "auto_status_reason": new_reason,
        }},
    )

    msg_extra = ""
    if new_status == "half_day" and new_reason == "short_hours":
        msg_extra = " — marked Half Day (worked < min hours)"
    elif new_status == "half_day" and new_reason == "late_punch_in":
        msg_extra = " — marked Half Day (late punch-in)"
    if multi_session and len(sessions) > 1:
        msg_extra += f" · session #{open_idx + 1} of {len(sessions)} closed"
    return {
        "success": True,
        "hours_worked": total_hours,
        "session_hours": session_hours,
        "session_count": len(sessions),
        "punch_out_time": now.isoformat(),
        "status": new_status,
        "auto_status_reason": new_reason,
        "message": f"Punched out. Total hours: {total_hours}{msg_extra}",
        "face_matched": face_result.get("matched"),
        "face_distance": face_result.get("distance"),
        "face_warning": face_result.get("reason") if face_result.get("matched") == False else None,
    }


@router.post("/location-update")
async def update_location(data: LocationUpdateRequest, current_user: dict = Depends(get_current_user)):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    record = await db.attendance_records.find_one(
        {"employee_id": data.employee_id, "date": today, "punch_in_time": {"$exists": True}}
    )
    if not record or record.get("punch_out_time"):
        raise HTTPException(status_code=400, detail="No active session found")
    log = {
        "employee_id": data.employee_id,
        "date": today,
        "latitude": data.latitude,
        "longitude": data.longitude,
        "accuracy": data.accuracy,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    await db.location_logs.insert_one(log)
    return {"success": True}


@router.get("/today")
async def today_attendance(current_user: dict = Depends(get_current_user)):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    role = current_user.get("role")
    me_id = current_user.get("employee_id")

    base_query = {"date": today}
    emp_query = {"status": {"$in": ["active", "probation"]}}

    if role == "managers":
        from services.hierarchy import get_manager_scope_excluding_ho
        scope_ids = await get_manager_scope_excluding_ho(me_id)
        base_query["employee_id"] = {"$in": scope_ids}
        emp_query["employee_id"] = {"$in": scope_ids}
    elif role not in ["hr_admin", "management"]:
        # Employee/field_agent — only own record
        base_query["employee_id"] = me_id
        emp_query["employee_id"] = me_id

    records = await db.attendance_records.find(base_query).to_list(1000)

    # Batch-enrich records with employee names
    emp_ids = list({r["employee_id"] for r in records})
    emps = await db.employees.find(
        {"employee_id": {"$in": emp_ids}},
        {"_id": 0, "employee_id": 1, "first_name": 1, "last_name": 1},
    ).to_list(1000)
    name_map = {e["employee_id"]: f"{e.get('first_name','')} {e.get('last_name','')}".strip() for e in emps}
    for r in records:
        r["employee_name"] = name_map.get(r["employee_id"], "")

    total_employees = await db.employees.count_documents(emp_query)
    present = len([r for r in records if r.get("punch_in_time")])
    punched_out = len([r for r in records if r.get("punch_out_time")])
    return {
        "date": today,
        "total_employees": total_employees,
        "present": present,
        "absent": total_employees - present,
        "punched_out": punched_out,
        "records": [att_to_dict(r) for r in records],
    }


import base64 as _b64
from fastapi.responses import Response as _Response

@router.get("/branches")
async def get_attendance_branches(current_user: dict = Depends(get_current_user)):
    """Return distinct branches visible to the current user for branch-tab filtering."""
    if current_user.get("role") not in ["hr_admin", "management", "managers"]:
        raise HTTPException(status_code=403, detail="Access denied")
    role = current_user.get("role")
    me_id = current_user.get("employee_id")
    emp_q: dict = {"status": {"$in": ["active", "probation", "notice_period"]}, "branch": {"$exists": True, "$ne": None, "$ne": ""}}
    if role == "managers":
        from services.hierarchy import get_manager_scope_excluding_ho
        scope = await get_manager_scope_excluding_ho(me_id)
        emp_q["employee_id"] = {"$in": scope}
    emps = await db.employees.find(emp_q, {"_id": 0, "branch": 1}).to_list(1000)
    branches = sorted(set(e["branch"] for e in emps if e.get("branch")))
    return branches


@router.get("/employee-photo/{employee_id}")
async def get_employee_passport_photo(
    employee_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Return the passport-size photo for an employee.
    Accessible to hr_admin, management, and managers (scoped to their team)."""
    role = current_user.get("role")
    if role not in ["hr_admin", "management", "managers"]:
        raise HTTPException(status_code=403, detail="Access denied")

    if role == "managers":
        from services.hierarchy import get_descendant_employee_ids
        me_id = current_user.get("employee_id")
        allowed = await get_descendant_employee_ids(me_id) if me_id else set()
        if me_id:
            allowed.add(me_id)
        if employee_id not in allowed:
            raise HTTPException(status_code=403, detail="Not in your team")

    doc = await db.employee_documents.find_one({"employee_id": employee_id})
    if not doc or not doc.get("passport_photo"):
        raise HTTPException(status_code=404, detail="No photo on file")

    asset = doc["passport_photo"]
    try:
        binary = _b64.b64decode(asset["data"])
    except Exception:
        raise HTTPException(status_code=500, detail="Failed to decode photo")

    return _Response(
        content=binary,
        media_type=asset.get("mime", "image/jpeg"),
        headers={"Cache-Control": "private, max-age=3600"},
    )


@router.get("/my")
async def my_attendance(
    month: int = None, year: int = None, current_user: dict = Depends(get_current_user)
):
    emp_id = current_user.get("employee_id")
    if not emp_id:
        # Admin / management have no linked employee — return empty history instead of erroring
        return []
    now = datetime.now(timezone.utc)
    m = month or now.month
    y = year or now.year
    prefix = f"{y}-{m:02d}"
    records = await db.attendance_records.find(
        {"employee_id": emp_id, "date": {"$regex": f"^{prefix}"}}
    ).sort("date", -1).to_list(100)
    return [att_to_dict(r) for r in records]


@router.get("/location-track/{employee_id}")
async def location_track(employee_id: str, date_str: str = None, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management", "managers"]:
        raise HTTPException(status_code=403, detail="Access denied")
    # Manager scope: only employees in their sub-tree
    if current_user.get("role") == "managers":
        from services.hierarchy import get_descendant_employee_ids
        me_id = current_user.get("employee_id")
        allowed = await get_descendant_employee_ids(me_id) if me_id else set()
        if employee_id not in allowed and employee_id != me_id:
            raise HTTPException(status_code=403, detail="Not allowed to view this employee's tracking data")
    today = date_str or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    logs = await db.location_logs.find(
        {"employee_id": employee_id, "date": today}
    ).sort("timestamp", 1).to_list(2000)
    for log in logs:
        log["id"] = str(log.pop("_id"))

    # Detect stops: cluster of consecutive points within 50m for >= 15 min
    STOP_RADIUS_M = 50
    STOP_DURATION_MIN = 15
    stops = []
    if logs:
        i = 0
        n = len(logs)
        while i < n:
            anchor = logs[i]
            j = i + 1
            while j < n:
                d = haversine_distance(
                    anchor["latitude"], anchor["longitude"],
                    logs[j]["latitude"], logs[j]["longitude"],
                )
                if d <= STOP_RADIUS_M:
                    j += 1
                else:
                    break
            cluster_end = j - 1
            if cluster_end > i:
                t_start = datetime.fromisoformat(anchor["timestamp"].replace("Z", "+00:00"))
                t_end = datetime.fromisoformat(logs[cluster_end]["timestamp"].replace("Z", "+00:00"))
                duration_min = (t_end - t_start).total_seconds() / 60
                if duration_min >= STOP_DURATION_MIN:
                    avg_lat = sum(p["latitude"] for p in logs[i:cluster_end + 1]) / (cluster_end - i + 1)
                    avg_lon = sum(p["longitude"] for p in logs[i:cluster_end + 1]) / (cluster_end - i + 1)
                    stops.append({
                        "latitude": round(avg_lat, 6),
                        "longitude": round(avg_lon, 6),
                        "start": anchor["timestamp"],
                        "end": logs[cluster_end]["timestamp"],
                        "duration_minutes": round(duration_min, 1),
                        "points": cluster_end - i + 1,
                    })
            i = cluster_end + 1

    attendance = await db.attendance_records.find_one({"employee_id": employee_id, "date": today})
    if attendance:
        attendance["id"] = str(attendance.pop("_id"))
        attendance.pop("punch_in_photo", None)
        attendance.pop("punch_out_photo", None)

    return {
        "employee_id": employee_id,
        "date": today,
        "locations": logs,
        "stops": stops,
        "attendance": attendance,
    }


@router.get("/field-staff/active")
async def list_active_field_staff(current_user: dict = Depends(get_current_user)):
    """List employees who have punched in today and have location updates."""
    if current_user.get("role") not in ["hr_admin", "management", "managers"]:
        raise HTTPException(status_code=403, detail="Access denied")
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    role = current_user.get("role")
    me_id = current_user.get("employee_id")
    rec_query = {"date": today, "punch_in_time": {"$exists": True}}
    if role == "managers":
        from services.hierarchy import get_manager_scope_excluding_ho
        scope = await get_manager_scope_excluding_ho(me_id)
        if scope == ["__none__"]:
            return []
        rec_query["employee_id"] = {"$in": scope}

    records = await db.attendance_records.find(rec_query).to_list(1000)
    if not records:
        return []

    emp_ids = [r["employee_id"] for r in records]

    # Batch fetch all employees in one query
    employees = await db.employees.find({"employee_id": {"$in": emp_ids}}, {"_id": 0}).to_list(1000)
    emp_map = {e["employee_id"]: e for e in employees}

    # Single aggregation for location stats (count + last log per employee)
    location_stats = await db.location_logs.aggregate([
        {"$match": {"date": today, "employee_id": {"$in": emp_ids}}},
        {"$sort": {"timestamp": -1}},
        {"$group": {
            "_id": "$employee_id",
            "count": {"$sum": 1},
            "last_timestamp": {"$first": "$timestamp"},
            "last_lat": {"$first": "$latitude"},
            "last_lon": {"$first": "$longitude"},
        }}
    ]).to_list(1000)
    loc_map = {s["_id"]: s for s in location_stats}

    out = []
    for r in records:
        emp_id = r["employee_id"]
        emp = emp_map.get(emp_id)
        if not emp:
            continue
        loc = loc_map.get(emp_id)
        out.append({
            "employee_id": emp_id,
            "name": f"{emp.get('first_name', '')} {emp.get('last_name', '')}".strip(),
            "designation": emp.get("designation", ""),
            "department": emp.get("department", ""),
            "role": emp.get("role", ""),
            "punch_in_time": r.get("punch_in_time"),
            "punch_out_time": r.get("punch_out_time"),
            "location_points": loc["count"] if loc else 0,
            "last_seen": loc["last_timestamp"] if loc else r.get("punch_in_time"),
            "last_lat": loc["last_lat"] if loc else (r.get("punch_in_location", {}) or {}).get("lat"),
            "last_lon": loc["last_lon"] if loc else (r.get("punch_in_location", {}) or {}).get("lon"),
        })
    return out


@router.get("")
async def list_attendance(
    employee_id: str = None,
    date_from: str = None,
    date_to: str = None,
    status: str = None,
    search: str = None,
    branch: str = None,
    limit: int = 500,
    current_user: dict = Depends(get_current_user),
):
    """List attendance records.
    - hr_admin / management: full access; no scoping
    - managers (reporting manager): defaults to direct reports + own records (HO staff excluded)
    - employees / field_agent: only own records
    """
    role = current_user.get("role")
    me_id = current_user.get("employee_id")

    query = {}

    if employee_id:
        # Explicit employee filter — only privileged roles can pick anyone else
        if role in ["hr_admin", "management"]:
            query["employee_id"] = employee_id
        elif role == "managers":
            from services.hierarchy import get_manager_scope_excluding_ho
            allowed = set(await get_manager_scope_excluding_ho(me_id))
            if employee_id not in allowed:
                raise HTTPException(status_code=403, detail="Not allowed to view this employee's attendance")
            query["employee_id"] = employee_id
        else:
            query["employee_id"] = me_id  # ignore the param, force own
    else:
        if role in ["hr_admin", "management"]:
            pass  # no scope — see everyone
        elif role == "managers":
            from services.hierarchy import get_manager_scope_excluding_ho
            scope_ids = await get_manager_scope_excluding_ho(me_id)
            query["employee_id"] = {"$in": scope_ids}
        else:
            query["employee_id"] = me_id

    if date_from:
        query["date"] = {"$gte": date_from}
    if date_to:
        query.setdefault("date", {})["$lte"] = date_to
    if status:
        query["status"] = status

    # Optional fuzzy name/id search — resolve to employee_id list
    if search and role in ["hr_admin", "management", "managers"]:
        s = search.strip()
        if s:
            emp_q = {
                "$or": [
                    {"employee_id": {"$regex": s, "$options": "i"}},
                    {"first_name": {"$regex": s, "$options": "i"}},
                    {"last_name": {"$regex": s, "$options": "i"}},
                ]
            }
            # Intersect with manager scope if applicable
            existing_emp_filter = query.get("employee_id")
            if isinstance(existing_emp_filter, dict) and "$in" in existing_emp_filter:
                emp_q["employee_id"] = existing_emp_filter
            elif isinstance(existing_emp_filter, str):
                emp_q["employee_id"] = existing_emp_filter
            matches = await db.employees.find(emp_q, {"employee_id": 1, "_id": 0}).to_list(500)
            ids = [m["employee_id"] for m in matches]
            if not ids:
                return []
            query["employee_id"] = {"$in": ids}

    # Branch filter — only for admin/management (managers see their own scope)
    if branch and role in ["hr_admin", "management", "managers"]:
        existing_emp_filter = query.get("employee_id")
        branch_q: dict = {"branch": branch}
        if isinstance(existing_emp_filter, dict) and "$in" in existing_emp_filter:
            branch_q["employee_id"] = existing_emp_filter
        elif isinstance(existing_emp_filter, str):
            branch_q["employee_id"] = existing_emp_filter
        branch_matches = await db.employees.find(branch_q, {"employee_id": 1, "_id": 0}).to_list(500)
        branch_ids = [m["employee_id"] for m in branch_matches]
        if not branch_ids:
            return []
        query["employee_id"] = {"$in": branch_ids}

    records = await db.attendance_records.find(query).sort("date", -1).limit(max(1, min(limit, 2000))).to_list(2000)

    # Enrich with employee name for the team view
    if records:
        emp_ids = list({r["employee_id"] for r in records})
        emps = await db.employees.find(
            {"employee_id": {"$in": emp_ids}},
            {"_id": 0, "employee_id": 1, "first_name": 1, "last_name": 1, "designation": 1, "department": 1, "branch": 1},
        ).to_list(2000)
        emap = {e["employee_id"]: e for e in emps}
        out = []
        for r in records:
            d = att_to_dict(r)
            e = emap.get(d.get("employee_id"), {})
            d["employee_name"] = f"{e.get('first_name','')} {e.get('last_name','')}".strip() or d.get("employee_id")
            d["designation"] = e.get("designation", "")
            d["department"] = e.get("department", "")
            d["branch"] = e.get("branch", "")
            out.append(d)
        return out
    return []


# --------------------------------------------------------------------
# Regularisation — admin can edit / create attendance; employees can request
# --------------------------------------------------------------------

HR_ROLES = ("hr_admin", "management")
VALID_STATUSES = {"present", "absent", "half_day", "leave", "weekly_off", "holiday"}
# Statuses that REQUIRE punch_in_time + punch_out_time to be provided.
STATUSES_REQUIRING_PUNCH = {"present", "half_day"}


def _get_fy() -> int:
    """Return the starting year of the current financial year (April–March)."""
    d = datetime.now(timezone.utc)
    return d.year if d.month >= 4 else d.year - 1


async def _deduct_leave_balance_for_regularisation(employee_id: str, leave_type: str) -> None:
    """Deduct 1 day from the employee's leave balance when regularisation marks attendance as 'leave'.
    Non-blocking — logs warning on error, never raises to the caller."""
    try:
        fy = _get_fy()
        BALANCE_TRACKED = ["CL", "SL", "EL", "Marriage"]
        if leave_type in BALANCE_TRACKED:
            await db.leave_balances.update_one(
                {"employee_id": employee_id, "year": fy},
                {"$inc": {f"{leave_type}.used": 1.0, f"{leave_type}.remaining": -1.0}},
            )
        elif leave_type == "Comp-Off":
            from routes.leaves import _deduct_comp_off
            await _deduct_comp_off(employee_id, fy, 1.0)
    except Exception as exc:
        logger.warning(f"_deduct_leave_balance_for_regularisation failed for {employee_id}/{leave_type}: {exc}")


def _enforce_punch_required(status: Optional[str], punch_in: Optional[str], punch_out: Optional[str]) -> None:
    """For positive attendance statuses, both punch_in and punch_out are mandatory."""
    if status in STATUSES_REQUIRING_PUNCH:
        if not punch_in or not str(punch_in).strip():
            raise HTTPException(
                status_code=400,
                detail=f"Punch-In time is mandatory when marking attendance as '{status}'.",
            )
        if not punch_out or not str(punch_out).strip():
            raise HTTPException(
                status_code=400,
                detail=f"Punch-Out time is mandatory when marking attendance as '{status}'.",
            )


class RegulariseEditBody(BaseModel):
    # All optional — only the fields the admin wants to change
    punch_in_time: Optional[str] = None       # ISO timestamp or "HH:MM"
    punch_out_time: Optional[str] = None
    status: Optional[str] = None
    hours_worked: Optional[float] = None
    leave_type: Optional[str] = None          # e.g. "CL","SL","EL","Marriage","Comp-Off" — auto-deducts balance when status="leave"
    reason: str                                # required — why this change


class RegulariseCreateBody(BaseModel):
    employee_id: str
    date: str                                  # YYYY-MM-DD
    punch_in_time: Optional[str] = None
    punch_out_time: Optional[str] = None
    status: str = "present"
    leave_type: Optional[str] = None          # e.g. "CL","SL","EL","Marriage","Comp-Off" — auto-deducts balance when status="leave"
    reason: str


class RegulariseRequestBody(BaseModel):
    # Employee-submitted request
    date: str                                  # YYYY-MM-DD
    requested_punch_in_time: Optional[str] = None
    requested_punch_out_time: Optional[str] = None
    requested_status: Optional[str] = None
    reason: str


class RegulariseActionBody(BaseModel):
    action: str                                # "approve" or "reject"
    admin_remark: Optional[str] = None


def _reg_to_dict(r: dict) -> dict:
    r["id"] = str(r.pop("_id"))
    return r


def _normalise_time(date_str: str, time_str: Optional[str]) -> Optional[str]:
    """Accept 'HH:MM', 'HH:MM:SS' or full ISO; return ISO string anchored to date_str.

    Manual HH:MM input is interpreted as **IST (Asia/Kolkata, +05:30)** — the only
    civil timezone Radhya operates in — so that what HR types in is what the user
    sees displayed (since every UI surface localises via `toLocaleTimeString("en-IN")`).
    """
    if not time_str:
        return None
    time_str = time_str.strip()
    # If already ISO-looking (has 'T' or explicit offset/Z) — trust the caller's tz
    if "T" in time_str or "Z" in time_str or "+" in time_str[10:] or "-" in time_str[10:]:
        try:
            dt = datetime.fromisoformat(time_str.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=IST_TZ)
            return dt.isoformat()
        except ValueError:
            pass
    # Otherwise treat as HH:MM[:SS] in IST
    try:
        t = datetime.strptime(time_str, "%H:%M:%S") if time_str.count(":") == 2 else datetime.strptime(time_str, "%H:%M")
        d = datetime.strptime(date_str, "%Y-%m-%d")
        combined = datetime(d.year, d.month, d.day, t.hour, t.minute, t.second, tzinfo=IST_TZ)
        return combined.isoformat()
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Could not parse time '{time_str}'. Use HH:MM or full ISO.")


async def _auto_create_compoff_if_holiday(employee_id: str, date_str: str, status: str):
    """After a regularisation, if the date is a non-working day and the employee
    worked (present/half_day), auto-create a pending comp-off grant — idempotent."""
    if status not in ("present", "half_day"):
        return
    try:
        from routes.holidays import is_non_working_saturday, get_holiday_dates
        d = date.fromisoformat(date_str)
        reason = None
        if d.weekday() == 6:
            reason = "Sunday"
        else:
            # Determine role for Saturday rule
            emp = await db.employees.find_one({"employee_id": employee_id}, {"_id": 0, "role": 1}) or {}
            role = emp.get("role", "employee")
            if is_non_working_saturday(d, role):
                reason = "1st/3rd Saturday Off"
            else:
                holiday = await db.holidays.find_one({"date": date_str}, {"_id": 0, "name": 1})
                if holiday:
                    reason = f"Holiday: {holiday['name']}"
        if not reason:
            return  # It's a regular working day — no comp-off needed
        # Idempotent: skip if already tracked for this employee/date
        existing = await db.comp_off_grants.find_one({
            "employee_id": employee_id,
            "earn_date": date_str,
            "status": {"$in": ["pending", "approved", "used"]},
        })
        if existing:
            return
        # Fetch hours_worked from the attendance record
        rec = await db.attendance_records.find_one(
            {"employee_id": employee_id, "date": date_str}, {"_id": 0, "hours_worked": 1}
        ) or {}
        await db.comp_off_grants.insert_one({
            "employee_id": employee_id,
            "earn_date": date_str,
            "earn_reason": reason,
            "hours_worked": rec.get("hours_worked"),
            "status": "pending",
            "source": "regularisation",
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
    except Exception as e:
        logger.warning(f"_auto_create_compoff_if_holiday failed for {employee_id}/{date_str}: {e}")


async def _apply_regularisation(
    record_id: Optional[str],
    employee_id: str,
    date_str: str,
    changes: dict,
    reason: str,
    acted_by: dict,
    leave_type: Optional[str] = None,
) -> dict:
    """Apply an edit/create to attendance_records and write an audit entry. Returns the new/updated record."""
    if changes.get("status") and changes["status"] not in VALID_STATUSES:
        raise HTTPException(status_code=400, detail=f"Invalid status. Allowed: {sorted(VALID_STATUSES)}")
    # Normalise time strings
    if "punch_in_time" in changes:
        changes["punch_in_time"] = _normalise_time(date_str, changes.get("punch_in_time"))
    if "punch_out_time" in changes:
        changes["punch_out_time"] = _normalise_time(date_str, changes.get("punch_out_time"))

    existing = None
    if record_id:
        from bson import ObjectId
        existing = await db.attendance_records.find_one({"_id": ObjectId(record_id)})
        if not existing:
            raise HTTPException(status_code=404, detail="Attendance record not found")
    else:
        existing = await db.attendance_records.find_one({"employee_id": employee_id, "date": date_str})

    # Compute hours_worked from in/out if both present and not explicitly set
    if "hours_worked" not in changes:
        new_in = changes.get("punch_in_time") or (existing or {}).get("punch_in_time")
        new_out = changes.get("punch_out_time") or (existing or {}).get("punch_out_time")
        if new_in and new_out:
            try:
                hours = (datetime.fromisoformat(new_out) - datetime.fromisoformat(new_in)).total_seconds() / 3600
                changes["hours_worked"] = round(hours, 2)
            except Exception:
                pass

    before = {k: (existing or {}).get(k) for k in ["punch_in_time", "punch_out_time", "status", "hours_worked"]}

    # Store leave_type on the attendance record when marking as leave
    if changes.get("status") == "leave" and leave_type:
        changes["leave_type"] = leave_type

    # Mark as HR-locked so subsequent auto-rules (punch-out, etc.) won't override.
    changes["regularised"] = True

    if existing:
        await db.attendance_records.update_one({"_id": existing["_id"]}, {"$set": changes})
        result = await db.attendance_records.find_one({"_id": existing["_id"]})
    else:
        doc = {
            "employee_id": employee_id,
            "date": date_str,
            "status": changes.get("status", "present"),
            "punch_in_time": changes.get("punch_in_time"),
            "punch_out_time": changes.get("punch_out_time"),
            "hours_worked": changes.get("hours_worked"),
            "regularised": True,
        }
        if changes.get("status") == "leave" and leave_type:
            doc["leave_type"] = leave_type
        inserted = await db.attendance_records.insert_one(doc)
        result = await db.attendance_records.find_one({"_id": inserted.inserted_id})

    # Audit log
    after = {k: result.get(k) for k in ["punch_in_time", "punch_out_time", "status", "hours_worked"]}
    audit_entry = {
        "employee_id": employee_id,
        "date": date_str,
        "before": before,
        "after": after,
        "reason": reason,
        "acted_by_username": acted_by.get("username"),
        "acted_by_name": acted_by.get("name"),
        "acted_at": datetime.now(timezone.utc).isoformat(),
        "type": "direct_edit",
    }
    if leave_type:
        audit_entry["leave_type"] = leave_type
    await db.attendance_regularisations.insert_one(audit_entry)

    # Auto-deduct leave balance when status is "leave" and leave_type is set
    if result.get("status") == "leave" and leave_type:
        await _deduct_leave_balance_for_regularisation(employee_id, leave_type)

    # Auto-create comp-off if this date is a non-working day and employee worked
    await _auto_create_compoff_if_holiday(employee_id, date_str, result.get("status", ""))

    return att_to_dict(result)


@router.patch("/records/{record_id}")
async def regularise_edit(record_id: str, body: RegulariseEditBody, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in HR_ROLES:
        raise HTTPException(status_code=403, detail="Only HR / Management can regularise attendance")
    from bson import ObjectId
    rec = await db.attendance_records.find_one({"_id": ObjectId(record_id)})
    if not rec:
        raise HTTPException(status_code=404, detail="Attendance record not found")
    # If status is positive, punch times are mandatory (use new values or fall back to existing)
    effective_status = body.status or rec.get("status")
    effective_in = body.punch_in_time or rec.get("punch_in_time")
    effective_out = body.punch_out_time or rec.get("punch_out_time")
    _enforce_punch_required(effective_status, effective_in, effective_out)
    changes = {k: v for k, v in body.model_dump().items() if v is not None and k not in ("reason", "leave_type")}
    if not changes:
        raise HTTPException(status_code=400, detail="No changes provided")
    return await _apply_regularisation(
        record_id=record_id, employee_id=rec["employee_id"], date_str=rec["date"],
        changes=changes, reason=body.reason, acted_by=current_user,
        leave_type=body.leave_type,
    )


@router.post("/records")
async def regularise_create(body: RegulariseCreateBody, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in HR_ROLES:
        raise HTTPException(status_code=403, detail="Only HR / Management can regularise attendance")
    # Mandatory punch times for positive attendance
    _enforce_punch_required(body.status, body.punch_in_time, body.punch_out_time)
    # Reject if a record already exists for that day
    existing = await db.attendance_records.find_one({"employee_id": body.employee_id, "date": body.date})
    if existing:
        raise HTTPException(status_code=400, detail=f"An attendance record already exists for {body.employee_id} on {body.date}. Edit it instead.")
    changes = {"status": body.status}
    if body.punch_in_time:
        changes["punch_in_time"] = body.punch_in_time
    if body.punch_out_time:
        changes["punch_out_time"] = body.punch_out_time
    return await _apply_regularisation(
        record_id=None, employee_id=body.employee_id, date_str=body.date,
        changes=changes, reason=body.reason, acted_by=current_user,
        leave_type=body.leave_type,
    )


@router.get("/regularisations")
async def list_regularisations(
    employee_id: Optional[str] = None,
    limit: int = 100,
    current_user: dict = Depends(get_current_user),
):
    query: dict = {}
    if current_user.get("role") in ["employee", "field_agent"]:
        query["employee_id"] = current_user.get("employee_id")
    elif employee_id:
        query["employee_id"] = employee_id
    docs = await db.attendance_regularisations.find(query).sort("acted_at", -1).to_list(limit)
    for d in docs:
        d["id"] = str(d.pop("_id"))
    return docs


# -------------- Employee-submitted requests (approval workflow) --------------

@router.post("/regularisation-requests")
async def create_reg_request(body: RegulariseRequestBody, current_user: dict = Depends(get_current_user)):
    emp_id = current_user.get("employee_id")
    if not emp_id:
        raise HTTPException(status_code=400, detail="Only employees can submit regularisation requests")
    # Mandatory punch times for positive attendance
    _enforce_punch_required(body.requested_status, body.requested_punch_in_time, body.requested_punch_out_time)
    # Reject duplicate pending request for the same day
    existing = await db.attendance_reg_requests.find_one(
        {"employee_id": emp_id, "date": body.date, "status": "pending"}
    )
    if existing:
        raise HTTPException(status_code=400, detail=f"You already have a pending regularisation request for {body.date}.")
    doc = {
        "employee_id": emp_id,
        "employee_name": current_user.get("name"),
        "date": body.date,
        "requested_punch_in_time": body.requested_punch_in_time,
        "requested_punch_out_time": body.requested_punch_out_time,
        "requested_status": body.requested_status,
        "reason": body.reason,
        "status": "pending",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    inserted = await db.attendance_reg_requests.insert_one(doc)
    return _reg_to_dict(await db.attendance_reg_requests.find_one({"_id": inserted.inserted_id}))


@router.get("/regularisation-requests")
async def list_reg_requests(
    status: Optional[str] = None,
    current_user: dict = Depends(get_current_user),
):
    query: dict = {}
    role = current_user.get("role")
    me_id = current_user.get("employee_id")
    if role in ["employee", "field_agent"]:
        query["employee_id"] = me_id
    elif role == "managers":
        from services.hierarchy import get_manager_scope_excluding_ho
        scope = await get_manager_scope_excluding_ho(me_id)
        query["employee_id"] = {"$in": scope}
    if status:
        query["status"] = status
    docs = await db.attendance_reg_requests.find(query).sort("created_at", -1).to_list(500)
    for d in docs:
        d["id"] = str(d.pop("_id"))
    return docs


@router.put("/regularisation-requests/{req_id}/action")
async def act_on_reg_request(req_id: str, body: RegulariseActionBody, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in HR_ROLES:
        raise HTTPException(status_code=403, detail="Only HR / Management can approve or reject")
    if body.action not in ("approve", "reject"):
        raise HTTPException(status_code=400, detail="action must be 'approve' or 'reject'")
    from bson import ObjectId
    req = await db.attendance_reg_requests.find_one({"_id": ObjectId(req_id)})
    if not req:
        raise HTTPException(status_code=404, detail="Request not found")
    if req.get("status") != "pending":
        raise HTTPException(status_code=400, detail=f"Request already {req.get('status')}")

    update = {
        "status": "approved" if body.action == "approve" else "rejected",
        "admin_remark": body.admin_remark,
        "acted_by_username": current_user.get("username"),
        "acted_by_name": current_user.get("name"),
        "acted_at": datetime.now(timezone.utc).isoformat(),
    }

    if body.action == "approve":
        # Apply the regularisation
        changes: dict = {}
        if req.get("requested_punch_in_time"):
            changes["punch_in_time"] = req["requested_punch_in_time"]
        if req.get("requested_punch_out_time"):
            changes["punch_out_time"] = req["requested_punch_out_time"]
        if req.get("requested_status"):
            changes["status"] = req["requested_status"]
        if not changes:
            raise HTTPException(status_code=400, detail="Request has no fields to apply.")
        reason = f"Approved employee request: {req.get('reason', '')}".strip()
        await _apply_regularisation(
            record_id=None, employee_id=req["employee_id"], date_str=req["date"],
            changes=changes, reason=reason, acted_by=current_user,
        )

    await db.attendance_reg_requests.update_one({"_id": req["_id"]}, {"$set": update})
    return _reg_to_dict(await db.attendance_reg_requests.find_one({"_id": req["_id"]}))
