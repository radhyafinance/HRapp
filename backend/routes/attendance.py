from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional
from database import db
from auth_utils import get_current_user
from services.face_match import compare_face_with_reference, DEFAULT_TOLERANCE
from datetime import datetime, timezone, date
import math
import os
import logging

logger = logging.getLogger(__name__)
router = APIRouter()

OFFICE_LOCATIONS_CACHE = []


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


async def _verify_face(employee_id: str, selfie_b64: Optional[str]) -> dict:
    """Compare selfie against the employee's passport_photo.

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

    matched, distance, reason = compare_face_with_reference(selfie_b64, reference, tolerance=DEFAULT_TOLERANCE)
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


@router.post("/punch-in")
async def punch_in(data: PunchRequest, current_user: dict = Depends(get_current_user)):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    existing = await db.attendance_records.find_one(
        {"employee_id": data.employee_id, "date": today}
    )
    if existing and existing.get("punch_in_time"):
        raise HTTPException(status_code=400, detail="Already punched in today")
    in_fence, location_name, distance = await check_geofence(data.latitude, data.longitude)

    # Face match (skipped for management role)
    face_result = {"ok": True, "matched": None, "distance": None, "reason": None, "strict": False}
    if current_user.get("role") != "management":
        face_result = await _verify_face(data.employee_id, data.photo_base64)
        if not face_result["ok"]:
            raise HTTPException(status_code=400, detail=face_result["reason"])

    now = datetime.now(timezone.utc)
    # Only persist the selfie if face match failed/flagged — saves DB space when matched
    keep_photo = data.photo_base64 if face_result.get("matched") == False else None
    record = {
        "employee_id": data.employee_id,
        "date": today,
        "punch_in_time": now.isoformat(),
        "punch_in_location": {"lat": data.latitude, "lon": data.longitude, "name": location_name},
        "punch_in_photo": keep_photo,
        "punch_in_face_matched": face_result.get("matched"),
        "punch_in_face_distance": face_result.get("distance"),
        "punch_in_face_warning": face_result.get("reason") if face_result.get("matched") == False else None,
        "geofence_verified": in_fence,
        "distance_from_office": round(distance, 2) if distance else None,
        "location_name": location_name,
        "status": "present",
        "punch_out_time": None,
    }
    if existing:
        await db.attendance_records.update_one({"_id": existing["_id"]}, {"$set": record})
    else:
        await db.attendance_records.insert_one(record)
    return {
        "success": True,
        "geofence_verified": in_fence,
        "location_name": location_name,
        "distance_meters": round(distance, 2) if distance else None,
        "punch_in_time": now.isoformat(),
        "face_matched": face_result.get("matched"),
        "face_distance": face_result.get("distance"),
        "face_warning": face_result.get("reason") if face_result.get("matched") == False else None,
        "message": f"Punched in {'within geofence' if in_fence else 'OUTSIDE geofence'}" + (f" at {location_name}" if location_name else ""),
    }


@router.post("/punch-out")
async def punch_out(data: PunchRequest, current_user: dict = Depends(get_current_user)):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    record = await db.attendance_records.find_one(
        {"employee_id": data.employee_id, "date": today}
    )
    if not record:
        raise HTTPException(status_code=400, detail="No punch-in found for today")
    if record.get("punch_out_time"):
        raise HTTPException(status_code=400, detail="Already punched out today")
    in_fence, location_name, distance = await check_geofence(data.latitude, data.longitude)

    # Face match (skipped for management role)
    face_result = {"ok": True, "matched": None, "distance": None, "reason": None, "strict": False}
    if current_user.get("role") != "management":
        face_result = await _verify_face(data.employee_id, data.photo_base64)
        if not face_result["ok"]:
            raise HTTPException(status_code=400, detail=face_result["reason"])

    now = datetime.now(timezone.utc)
    punch_in_time = datetime.fromisoformat(record["punch_in_time"])
    hours_worked = (now - punch_in_time).total_seconds() / 3600
    keep_photo = data.photo_base64 if face_result.get("matched") == False else None
    await db.attendance_records.update_one(
        {"_id": record["_id"]},
        {"$set": {
            "punch_out_time": now.isoformat(),
            "punch_out_location": {"lat": data.latitude, "lon": data.longitude, "name": location_name},
            "punch_out_photo": keep_photo,
            "punch_out_face_matched": face_result.get("matched"),
            "punch_out_face_distance": face_result.get("distance"),
            "punch_out_face_warning": face_result.get("reason") if face_result.get("matched") == False else None,
            "hours_worked": round(hours_worked, 2),
        }},
    )
    return {
        "success": True,
        "hours_worked": round(hours_worked, 2),
        "punch_out_time": now.isoformat(),
        "message": f"Punched out. Total hours: {round(hours_worked, 2)}",
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
    records = await db.attendance_records.find({"date": today}).to_list(1000)
    total_employees = await db.employees.count_documents({"status": {"$in": ["active", "probation"]}})
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
    records = await db.attendance_records.find({"date": today, "punch_in_time": {"$exists": True}}).to_list(1000)
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
    current_user: dict = Depends(get_current_user),
):
    query = {}
    if employee_id:
        query["employee_id"] = employee_id
    elif current_user.get("role") in ["employee", "field_agent"]:
        query["employee_id"] = current_user.get("employee_id")
    if date_from:
        query["date"] = {"$gte": date_from}
    if date_to:
        query.setdefault("date", {})["$lte"] = date_to
    records = await db.attendance_records.find(query).sort("date", -1).to_list(500)
    return [att_to_dict(r) for r in records]


# --------------------------------------------------------------------
# Regularisation — admin can edit / create attendance; employees can request
# --------------------------------------------------------------------

HR_ROLES = ("hr_admin", "management")
VALID_STATUSES = {"present", "absent", "half_day", "leave", "weekly_off", "holiday"}


class RegulariseEditBody(BaseModel):
    # All optional — only the fields the admin wants to change
    punch_in_time: Optional[str] = None       # ISO timestamp or "HH:MM"
    punch_out_time: Optional[str] = None
    status: Optional[str] = None
    hours_worked: Optional[float] = None
    reason: str                                # required — why this change


class RegulariseCreateBody(BaseModel):
    employee_id: str
    date: str                                  # YYYY-MM-DD
    punch_in_time: Optional[str] = None
    punch_out_time: Optional[str] = None
    status: str = "present"
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
    """Accept 'HH:MM', 'HH:MM:SS' or full ISO; return ISO string anchored to date_str."""
    if not time_str:
        return None
    time_str = time_str.strip()
    # If already ISO-looking
    try:
        dt = datetime.fromisoformat(time_str.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.isoformat()
    except ValueError:
        pass
    # Otherwise treat as HH:MM[:SS]
    try:
        t = datetime.strptime(time_str, "%H:%M:%S") if time_str.count(":") == 2 else datetime.strptime(time_str, "%H:%M")
        d = datetime.strptime(date_str, "%Y-%m-%d")
        combined = datetime(d.year, d.month, d.day, t.hour, t.minute, t.second, tzinfo=timezone.utc)
        return combined.isoformat()
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Could not parse time '{time_str}'. Use HH:MM or full ISO.")


async def _apply_regularisation(
    record_id: Optional[str],
    employee_id: str,
    date_str: str,
    changes: dict,
    reason: str,
    acted_by: dict,
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
        inserted = await db.attendance_records.insert_one(doc)
        result = await db.attendance_records.find_one({"_id": inserted.inserted_id})

    # Audit log
    after = {k: result.get(k) for k in ["punch_in_time", "punch_out_time", "status", "hours_worked"]}
    await db.attendance_regularisations.insert_one({
        "employee_id": employee_id,
        "date": date_str,
        "before": before,
        "after": after,
        "reason": reason,
        "acted_by_username": acted_by.get("username"),
        "acted_by_name": acted_by.get("name"),
        "acted_at": datetime.now(timezone.utc).isoformat(),
        "type": "direct_edit",
    })
    return att_to_dict(result)


@router.patch("/records/{record_id}")
async def regularise_edit(record_id: str, body: RegulariseEditBody, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in HR_ROLES:
        raise HTTPException(status_code=403, detail="Only HR / Management can regularise attendance")
    from bson import ObjectId
    rec = await db.attendance_records.find_one({"_id": ObjectId(record_id)})
    if not rec:
        raise HTTPException(status_code=404, detail="Attendance record not found")
    changes = {k: v for k, v in body.model_dump().items() if v is not None and k != "reason"}
    if not changes:
        raise HTTPException(status_code=400, detail="No changes provided")
    return await _apply_regularisation(
        record_id=record_id, employee_id=rec["employee_id"], date_str=rec["date"],
        changes=changes, reason=body.reason, acted_by=current_user,
    )


@router.post("/records")
async def regularise_create(body: RegulariseCreateBody, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in HR_ROLES:
        raise HTTPException(status_code=403, detail="Only HR / Management can regularise attendance")
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
    if current_user.get("role") in ["employee", "field_agent"]:
        query["employee_id"] = current_user.get("employee_id")
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
