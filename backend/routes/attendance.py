from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional
from database import db
from auth_utils import get_current_user
from services.face_match import (compare_face_with_reference, compare_with_encoding,
                                 encode_reference, DEFAULT_TOLERANCE, MODEL_VERSION)
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


# ── stay detection ────────────────────────────────────────────────────────
#
# Measured on production: half of all fixes are proper GPS (8-30 m) and a
# quarter are 300 m or worse — cell-tower or wifi positions, not GPS. Across
# phones, a median of ~75% of apparent hops are SMALLER than the combined
# accuracy of the two fixes involved. In other words most "movement" on the map
# was never movement; it was a coarse fix drawn as a confident dot.
#
# The previous algorithm made that worse in two ways. It ignored `accuracy`
# entirely, and it measured every point against the FIRST point of the cluster
# rather than a running centre — so a single wild fix ended the stop and started
# a new one, splitting one visit to one village into three "stops" a few minutes
# apart. That is exactly the "is he at 1 location or 10" problem.
_TRUST_ACCURACY_M = 100     # worse than this is not a position, it is an area
_STAY_RADIUS_M = 60         # base radius; widened per-point by its own accuracy
_STAY_MIN_MIN = 15          # a stop worth showing, unchanged from before
_STAY_MERGE_M = 150         # two stays this close are the same place...
_STAY_MERGE_GAP_MIN = 12    # ...if the gap between them is this short


def _pt_time(p):
    try:
        return datetime.fromisoformat(str(p.get("timestamp")).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def _detect_stays(logs):
    """(stays, trusted_points, dropped_count) from a day's location logs.

    Returns stays newest-last, each numbered, plus the points good enough to
    draw. A fix the phone itself says is +/-400 m cannot support a 60 m stay,
    so it is excluded from BOTH the path and the clustering — but counted, so
    the UI can say so instead of silently showing less.
    """
    trusted, dropped = [], 0
    for p in logs:
        if p.get("latitude") is None or p.get("longitude") is None:
            dropped += 1
            continue
        acc = p.get("accuracy")
        if acc is not None and acc > _TRUST_ACCURACY_M:
            dropped += 1
            continue
        if _pt_time(p) is None:
            dropped += 1
            continue
        trusted.append(p)

    stays = []
    i, n = 0, len(trusted)
    while i < n:
        members = [trusted[i]]
        c_lat, c_lon = trusted[i]["latitude"], trusted[i]["longitude"]
        j = i + 1
        while j < n:
            p = trusted[j]
            # Radius widens to the point's own uncertainty: a 90 m fix sitting
            # 80 m from the centre is not evidence of having moved.
            tol = max(_STAY_RADIUS_M, p.get("accuracy") or 0)
            if haversine_distance(c_lat, c_lon, p["latitude"], p["longitude"]) > tol:
                break
            members.append(p)
            # Recentre as it grows, so the stay tracks the true middle rather
            # than being anchored to whichever fix happened to be first.
            c_lat = sum(m["latitude"] for m in members) / len(members)
            c_lon = sum(m["longitude"] for m in members) / len(members)
            j += 1
        if len(members) > 1:
            t0, t1 = _pt_time(members[0]), _pt_time(members[-1])
            if t0 and t1:
                stays.append({
                    "latitude": round(c_lat, 6), "longitude": round(c_lon, 6),
                    "start": members[0]["timestamp"], "end": members[-1]["timestamp"],
                    "_t0": t0, "_t1": t1, "points": len(members),
                })
        i = max(j, i + 1)

    # Merge stays that are the same place split by a bad fix or a short step out.
    merged = []
    for s in stays:
        if merged:
            prev = merged[-1]
            gap_min = (s["_t0"] - prev["_t1"]).total_seconds() / 60
            if (haversine_distance(prev["latitude"], prev["longitude"],
                                   s["latitude"], s["longitude"]) <= _STAY_MERGE_M
                    and 0 <= gap_min <= _STAY_MERGE_GAP_MIN):
                w1, w2 = prev["points"], s["points"]
                prev["latitude"] = round((prev["latitude"] * w1 + s["latitude"] * w2) / (w1 + w2), 6)
                prev["longitude"] = round((prev["longitude"] * w1 + s["longitude"] * w2) / (w1 + w2), 6)
                prev["end"], prev["_t1"] = s["end"], s["_t1"]
                prev["points"] = w1 + w2
                continue
        merged.append(s)

    out = []
    for s in merged:
        mins = (s["_t1"] - s["_t0"]).total_seconds() / 60
        if mins < _STAY_MIN_MIN:
            continue
        s.pop("_t0"); s.pop("_t1")
        s["duration_minutes"] = round(mins, 1)
        s["index"] = len(out) + 1      # 1,2,3… so the map can number the pins
        out.append(s)
    return out, trusted, dropped


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


# ──────────────────────────────────────────────────────────────
#  Forgotten / failed punch-outs
# ──────────────────────────────────────────────────────────────
AUTO_CLOSE_LOOKBACK_DAYS = 7


def _ist_today() -> date:
    return (datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)).date()


def _shift_end_utc(shift: Optional[dict], date_str: str) -> Optional[datetime]:
    """The shift's end time on `date_str`, as UTC.

    Mirrors `shift_start_ist` in services.shift_rules: shift hours are IST
    wall-clock, punch times are stored as UTC.
    """
    if not shift:
        return None
    try:
        d = datetime.strptime(date_str, "%Y-%m-%d")
    except (ValueError, TypeError):
        return None
    try:
        end_ist = datetime(d.year, d.month, d.day,
                           int(shift.get("end_hour", 18)),
                           int(shift.get("end_minute", 0)), tzinfo=IST_TZ)
    except ValueError:
        return None
    return end_ist.astimezone(timezone.utc)


async def _last_seen_utc(employee_id: str, date_str: str) -> Optional[datetime]:
    """Latest location ping for that employee on that day, if any.

    This is the strongest evidence we have of when someone was still working.
    Only field staff ping, so office staff fall through to the shift end.
    """
    try:
        rows = await db.location_logs.find(
            {"employee_id": employee_id, "date": date_str}, {"_id": 0, "timestamp": 1}
        ).to_list(5000)
    except Exception:
        return None
    latest = None
    for r in rows:
        ts = r.get("timestamp")
        if not ts:
            continue
        try:
            dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        except ValueError:
            continue
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        if latest is None or dt > latest:
            latest = dt
    return latest


async def auto_close_open_sessions(lookback_days: int = AUTO_CLOSE_LOOKBACK_DAYS) -> dict:
    """Close attendance sessions left open on a day that has already ended.

    A punch-out can fail for reasons that have nothing to do with the employee --
    a dropped connection, a backend restart, a phone that died. Without this the
    record stays open forever: hours are never computed and only HR can repair it,
    which means the failure is invisible until someone notices.

    Deliberately conservative:

    * **Only days strictly before today (IST).** Someone still at work is never
      closed out from under them.
    * **Status is never recomputed.** We do not know when they actually left, so
      running the short-hours rule on a guess could silently turn a full day into
      a half day. Whatever punch-in decided stands until a human looks.
    * **Hours are marked as an estimate**, never presented as measured.
    * Records HR has already regularised, or already auto-closed, are left alone,
      so this is safe to re-run.

    Every record it touches is flagged `needs_hr_review`, so the repair is queued
    rather than quietly applied.
    """
    today_ist = _ist_today()
    oldest = (today_ist - timedelta(days=max(1, lookback_days))).isoformat()
    newest = (today_ist - timedelta(days=1)).isoformat()

    candidates = await db.attendance_records.find({
        "date": {"$gte": oldest, "$lte": newest},
        "punch_in_time": {"$exists": True, "$ne": None},
        "regularised": {"$ne": True},
        "auto_closed": {"$ne": True},
    }).to_list(2000)

    closed = []
    for rec in candidates:
        sessions = list(rec.get("sessions") or [])
        if not sessions and rec.get("punch_in_time") and not rec.get("punch_out_time"):
            # Legacy single-session record — same migration shape punch_out uses.
            sessions = [{
                "punch_in_time": rec.get("punch_in_time"),
                "punch_in_location": rec.get("punch_in_location"),
                "punch_out_time": None,
            }]
        open_idx = None
        for i in range(len(sessions) - 1, -1, -1):
            if not sessions[i].get("punch_out_time"):
                open_idx = i
                break
        if open_idx is None:
            continue

        date_str = rec.get("date")
        emp_id = rec.get("employee_id")
        try:
            pin_dt = datetime.fromisoformat(str(sessions[open_idx].get("punch_in_time")))
            if pin_dt.tzinfo is None:
                pin_dt = pin_dt.replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            logger.warning("auto_close: unreadable punch_in_time for %s on %s", emp_id, date_str)
            continue

        # Best evidence first, then the shift's end time.
        source = "last_location_ping"
        est = await _last_seen_utc(emp_id, date_str)
        if est is None or est < pin_dt:
            emp = await db.employees.find_one({"employee_id": emp_id}, {"_id": 0, "role": 1}) or {}
            shift = await resolve_shift_for(emp.get("role"), emp_id, db)
            est = _shift_end_utc(shift, date_str)
            source = "shift_end"
        if est is None or est < pin_dt:
            # Nothing usable. Close at the punch-in itself rather than inventing
            # time worked -- zero hours is visibly wrong, which is the point.
            est = pin_dt
            source = "no_evidence"

        hours = round((est - pin_dt).total_seconds() / 3600, 2)
        sessions[open_idx]["punch_out_time"] = est.isoformat()
        sessions[open_idx]["hours_worked"] = hours
        sessions[open_idx]["auto_closed"] = True
        total = round(sum((s.get("hours_worked") or 0)
                          for s in sessions if s.get("punch_out_time")), 2)

        await db.attendance_records.update_one({"_id": rec["_id"]}, {"$set": {
            "sessions": sessions,
            "session_count": len(sessions),
            "punch_out_time": est.isoformat(),
            "hours_worked": total,
            "hours_worked_estimated": True,
            "auto_closed": True,
            "auto_closed_at": datetime.now(timezone.utc).isoformat(),
            "auto_closed_source": source,
            "needs_hr_review": True,
            # Status deliberately untouched -- see the docstring.
        }})
        closed.append({"employee_id": emp_id, "date": date_str,
                       "estimated_hours": hours, "source": source})

    return {"closed_count": len(closed), "closed": closed,
            "window": {"from": oldest, "to": newest}}


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
                {"punch_in_photo_original": {"$nin": [None, ""]}},
                {"punch_out_photo_original": {"$nin": [None, ""]}},
            ],
        },
        # `_original` holds the first attempt when an employee retook the photo.
        # It ages out on the same 45-day clock as any other mismatch selfie.
        {"$unset": {"punch_in_photo": "", "punch_out_photo": "",
                    "punch_in_photo_original": "", "punch_out_photo_original": ""}},
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


# ──────────────────────────────────────────────────────────────
#  Cached reference embeddings
# ──────────────────────────────────────────────────────────────
async def _reference_encoding(employee_id: str):
    """Return (raw_reference_b64_or_None, cached_encoding_or_None).

    The passport photo does not change between punches, but the original flow
    re-read and re-embedded it on every single punch -- and it is the larger of
    the two images, so it was the more expensive half of the comparison. Worse,
    the read had no projection, so it dragged the employee's entire document
    wallet (Aadhaar, PAN, cheque, certificates -- all base64 inline) across the
    wire to reach one field.

    The cache is keyed on the photo's own `uploaded_at`, so the common path reads
    a single timestamp and nothing else. Re-uploading the photo changes that
    timestamp and the embedding is recomputed on the next punch -- no stale
    encoding can survive a photo change.
    """
    cached = await db.face_ref_cache.find_one({"employee_id": employee_id}, {"_id": 0}) or {}
    meta = await db.employee_documents.find_one(
        {"employee_id": employee_id},
        {"_id": 0, "passport_photo.uploaded_at": 1},
    ) or {}
    pp = meta.get("passport_photo")
    # Legacy records store the photo as a bare base64 string rather than a dict,
    # in which case there is no timestamp to key on.
    uploaded_at = pp.get("uploaded_at") if isinstance(pp, dict) else None

    # `uploaded_at` must be truthy to trust the cache. Without that check a
    # DELETED photo (uploaded_at gone -> None) would match a cache row that also
    # had None, and the punch would verify against a photo that no longer exists.
    if (uploaded_at
            and cached.get("encoding")
            and cached.get("model") == MODEL_VERSION
            and cached.get("photo_uploaded_at") == uploaded_at):
        return None, cached["encoding"]          # hit: the photo is never fetched

    # Miss. Fetch the photo itself -- still projected, so only this one field.
    doc = await db.employee_documents.find_one(
        {"employee_id": employee_id}, {"_id": 0, "passport_photo": 1}) or {}
    passport = doc.get("passport_photo")
    reference = passport.get("data") if isinstance(passport, dict) else passport
    if not reference:
        return None, None

    try:
        loop = asyncio.get_running_loop()
        enc = await asyncio.wait_for(
            loop.run_in_executor(_FACE_EXECUTOR, encode_reference, reference), timeout=25.0)
    except Exception as exc:
        # Never fail a punch because the cache could not be built -- fall back to
        # the uncached path, which decodes the reference inline as before.
        logger.warning("[face_match] reference encode failed for %s: %s", employee_id, exc)
        return reference, None

    if enc:
        await db.face_ref_cache.update_one(
            {"employee_id": employee_id},
            {"$set": {"employee_id": employee_id, "encoding": enc,
                      "photo_uploaded_at": uploaded_at, "model": MODEL_VERSION,
                      "computed_at": datetime.now(timezone.utc).isoformat()}},
            upsert=True,
        )
        return None, enc
    # No face in the passport photo. Return it raw so the existing code path
    # produces the same "no face in reference" message it always did.
    return reference, None


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
    reference, ref_encoding = await _reference_encoding(employee_id)

    # Per requirement: block punch if no passport_photo on file.
    if not (reference or ref_encoding):
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
        # With a cached embedding only the selfie is decoded and embedded; the
        # reference half of the work has already been done.
        if ref_encoding:
            fn, ref_arg = compare_with_encoding, ref_encoding
        else:
            fn, ref_arg = compare_face_with_reference, reference
        matched, distance, reason = await asyncio.wait_for(
            loop.run_in_executor(_FACE_EXECUTOR, fn, selfie_b64, ref_arg, DEFAULT_TOLERANCE),
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


# ──────────────────────────────────────────────────────────────
#  One-shot photo retake
# ──────────────────────────────────────────────────────────────
# Fails a face check -> asked to retake once, right then -> if it still fails,
# the punch stands and is flagged for HR. No time window: the retake is offered
# only in the moment (the prompt lives in transient page state, gone on refresh
# or navigation), and it can only ever touch TODAY's record, so "immediate, one
# retry, then flag" needs no minute-counter on top.
class RetakeRequest(BaseModel):
    employee_id: str
    side: str                       # "in" | "out"
    photo_base64: str


@router.post("/retake-photo")
async def retake_photo(data: RetakeRequest, current_user: dict = Depends(get_current_user)):
    """Re-run the face check on a punch that failed it, using a fresh selfie.

    The punch itself is never re-created, moved or undone -- only the face-check
    result attached to it changes. Times, hours and status are untouched.

    Deliberately narrow:

    * **Only a punch whose check actually failed.** A successful check cannot be
      replaced, or a good photo could be swapped for a different one.
    * **Once.** A second attempt is refused, so this is a retry, not an unlimited
      do-over.
    * **Today's record only** (the lookup is keyed on today's date).
    * **Your own record**, unless HR Admin.

    The first photo is kept in `punch_{side}_photo_original` and ages out on the
    same 45-day clock. If the original failure was a genuine mismatch, that image
    is the evidence -- discarding it on a successful retake would erase exactly
    the case worth looking at.
    """
    side = (data.side or "").lower()
    if side not in ("in", "out"):
        raise HTTPException(status_code=400, detail="side must be 'in' or 'out'")

    me = current_user.get("employee_id")
    is_admin = current_user.get("role") in ("hr_admin", "management")
    if data.employee_id != me and not is_admin:
        raise HTTPException(status_code=403, detail="You can only retake your own photo")

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    record = await db.attendance_records.find_one(
        {"employee_id": data.employee_id, "date": today})
    if not record:
        raise HTTPException(status_code=400, detail="No attendance record for today")

    if record.get(f"punch_{side}_face_matched") is not False:
        raise HTTPException(
            status_code=400,
            detail="Nothing to retake — this punch's face check did not fail.")
    if record.get(f"punch_{side}_face_retaken"):
        raise HTTPException(
            status_code=400,
            detail="You have already retaken this photo once. Contact HR if it is still wrong.")

    face_result = await _verify_face(data.employee_id, data.photo_base64)
    if not face_result["ok"]:
        # Same contract as the punch endpoints: a hard failure is reported and
        # nothing is written, so the record keeps its original flag.
        raise HTTPException(status_code=400, detail=face_result["reason"])

    matched = face_result.get("matched")
    now = datetime.now(timezone.utc).isoformat()
    # Keep the new photo only if it ALSO failed, mirroring punch_in/punch_out --
    # a verified selfie has no audit value and storing it would be gratuitous.
    keep_photo = data.photo_base64 if matched is False else None

    changes = {
        f"punch_{side}_face_matched": matched,
        f"punch_{side}_face_distance": face_result.get("distance"),
        f"punch_{side}_face_warning": face_result.get("reason") if matched is False else None,
        f"punch_{side}_photo": keep_photo,
        f"punch_{side}_face_retaken": True,
        f"punch_{side}_face_retaken_at": now,
    }
    if record.get(f"punch_{side}_photo") and not record.get(f"punch_{side}_photo_original"):
        changes[f"punch_{side}_photo_original"] = record.get(f"punch_{side}_photo")

    # Mirror onto the session the punch belongs to, so the per-session history
    # agrees with the top-level fields instead of quietly contradicting them.
    sessions = list(record.get("sessions") or [])
    idx = None
    for i in range(len(sessions) - 1, -1, -1):
        if sessions[i].get(f"punch_{side}_time"):
            idx = i
            break
    if idx is not None:
        sessions[idx][f"punch_{side}_face_matched"] = matched
        sessions[idx][f"punch_{side}_face_distance"] = face_result.get("distance")
        sessions[idx][f"punch_{side}_face_warning"] = changes[f"punch_{side}_face_warning"]
        sessions[idx][f"punch_{side}_photo"] = keep_photo
        sessions[idx][f"punch_{side}_face_retaken"] = True
        changes["sessions"] = sessions

    await db.attendance_records.update_one({"_id": record["_id"]}, {"$set": changes})

    return {
        "success": True,
        "side": side,
        "face_matched": matched,
        "face_distance": face_result.get("distance"),
        "face_warning": changes[f"punch_{side}_face_warning"],
        "message": ("Face verified — the flag on this punch has been cleared."
                    if matched else
                    "Still could not verify that photo. The punch stands and HR will review it."),
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
    # Same grant, same precedence as /field-staff/active. Without it a granted
    # viewer reaches the page and the list, then gets a 403 on every route map
    # for anyone outside their own reporting line.
    from routes.tracker import _is_tracking_viewer
    viewer = await _is_tracking_viewer(current_user)
    if not viewer and current_user.get("role") not in ["hr_admin", "management", "managers"]:
        raise HTTPException(status_code=403, detail="Access denied")
    # Manager scope: only employees in their sub-tree — unless granted.
    if current_user.get("role") == "managers" and not viewer:
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

    stops, trusted, dropped_low_accuracy = _detect_stays(logs)

    attendance = await db.attendance_records.find_one({"employee_id": employee_id, "date": today})
    if attendance:
        # Allow-list, not pop(). The two pops this replaces removed the
        # top-level selfies and missed the SAME images at
        # sessions[].punch_in_photo / .punch_out_photo and
        # punch_in_photo_original / punch_out_photo_original — the copies kept
        # only when the face check FAILED, i.e. the biometric-dispute evidence —
        # along with the face-match distances. Those were shipping in the
        # response, and the grant above has just opened this endpoint to people
        # outside the subject's reporting line, so it has to be tightened in the
        # same change rather than after it.
        #
        # Every name below is a field this collection actually stores, checked
        # against the live API response. A denylist over a raw Mongo document
        # leaks whatever the next migration adds.
        allowed = (
            "employee_id", "date", "status", "auto_status_reason", "regularised",
            "punch_in_time", "punch_out_time", "hours_worked",
            "hours_worked_estimated", "auto_closed", "late_minutes",
            "shift_id", "shift_name", "session_count",
            "punch_in_location", "punch_out_location", "location_name",
            "geofence_verified", "distance_from_office",
        )
        att = {k: attendance[k] for k in allowed if k in attendance}
        att["id"] = str(attendance.get("_id", ""))
        if attendance.get("sessions"):
            att["sessions"] = [
                {k: s.get(k) for k in ("punch_in_time", "punch_out_time", "status",
                                       "hours_worked", "auto_closed",
                                       "punch_in_location", "punch_out_location")
                 if k in s}
                for s in attendance["sessions"]
            ]
        attendance = att

    return {
        "employee_id": employee_id,
        "date": today,
        # `locations` stays the full raw set so nothing that reads it breaks.
        # `trusted_locations` is what the map should draw: fixes the phone itself
        # claims to within 100 m. `dropped_low_accuracy` exists so the UI can say
        # "42 low-accuracy fixes hidden" rather than quietly showing less.
        "trusted_locations": trusted,
        "dropped_low_accuracy": dropped_low_accuracy,
        "locations": logs,
        "stops": stops,
        "attendance": attendance,
    }


@router.get("/field-staff/active")
async def list_active_field_staff(current_user: dict = Depends(get_current_user)):
    """List employees who have punched in today and have location updates."""
    # The read-only tracking grant (`tracking_viewer` on the employee record).
    # Checked BEFORE the role gate and before the manager narrowing below,
    # because it is a WIDER scope than either — a granted manager narrowed back
    # to his own reporting line sees one person on the tab that matters most.
    # Imported inside the function, matching the existing `_gps_distance_km`
    # import below: routes.tracker has no module-scope routes.* imports, so
    # there is no cycle, and nothing new has to exist for this file to load.
    from routes.tracker import _is_tracking_viewer
    viewer = await _is_tracking_viewer(current_user)
    if not viewer and current_user.get("role") not in ["hr_admin", "management", "managers"]:
        raise HTTPException(status_code=403, detail="Access denied")
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    role = current_user.get("role")
    me_id = current_user.get("employee_id")
    rec_query = {"date": today, "punch_in_time": {"$exists": True}}
    if role == "managers" and not viewer:
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
            "last_battery": {"$first": "$battery"},
        }}
    ]).to_list(1000)
    loc_map = {s["_id"]: s for s in location_stats}

    # Reuse the tracker's GPS distance helper rather than a second implementation --
    # two ways of computing the same number is how they end up disagreeing.
    from routes.tracker import _gps_distance_km
    dist_map = {}
    for eid in emp_ids:
        try:
            dist_map[eid] = await _gps_distance_km(eid, today)
        except Exception:
            dist_map[eid] = None

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
            "branch": emp.get("branch", ""),
            # Distance covered TODAY only -- this tab is a live view of the day in
            # progress, so any longer-running total would misread as "today".
            "distance_km_today": dist_map.get(emp_id, 0.0),
            "last_battery": loc.get("last_battery") if loc else None,
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
    needs_review: bool = None,
    limit: int = 500,
    current_user: dict = Depends(get_current_user),
):
    """List attendance records.
    - hr_admin / management: full access; no scoping
    - managers (reporting manager): defaults to direct reports + own records (HO staff excluded)
    - employees / field_agent: only own records

    `needs_review=true` narrows to records auto-closed because the punch-out never
    landed. Filtered in the query rather than in the browser so the list is the
    whole set, not just whatever fitted in the last page of results.
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
    if needs_review:
        query["needs_hr_review"] = True

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


async def _auto_create_compoff_if_holiday(employee_id: str, date_str: str, status: str, acted_by: dict = None):
    """After a regularisation, if the date is a non-working day and the employee
    actually WORKED, ensure an APPROVED (credited) comp-off grant exists — the
    regularisation is itself an HR-vetted action, so it credits immediately.
    "Worked" is detected by present/half_day status OR a punch-in / hours on the
    record — so a worked holiday left labelled "Holiday"/"Weekly Off" still earns
    a comp-off. Idempotent: an existing pending grant (from a scan or the
    employee's own request) is approved instead of duplicated."""
    if status in ("absent", "leave"):
        return  # clearly did not work that day
    try:
        from routes.holidays import is_non_working_saturday
        from routes.comp_offs import EXPIRY_DAYS
        d = date.fromisoformat(date_str)
        # Did the employee actually work? present/half_day imply it; a worked
        # holiday/weekly_off is detected via punch-in / hours on the record.
        rec = await db.attendance_records.find_one(
            {"employee_id": employee_id, "date": date_str},
            {"_id": 0, "punch_in_time": 1, "hours_worked": 1},
        ) or {}
        worked = (
            status in ("present", "half_day")
            or bool(rec.get("punch_in_time"))
            or (rec.get("hours_worked") or 0) > 0
        )
        if not worked:
            return
        # Is the date a non-working day?
        reason = None
        if d.weekday() == 6:
            reason = "Sunday"
        else:
            emp = await db.employees.find_one({"employee_id": employee_id}, {"_id": 0, "role": 1}) or {}
            role = emp.get("role", "employee")
            if is_non_working_saturday(d, role):
                reason = "1st/3rd Saturday Off"
            else:
                holiday = await db.holidays.find_one({"date": date_str}, {"_id": 0, "name": 1})
                if holiday:
                    reason = f"Holiday: {holiday['name']}"
        if not reason:
            return  # regular working day — no comp-off
        now = datetime.now(timezone.utc).isoformat()
        actor = (acted_by or {}).get("employee_id") or (acted_by or {}).get("username") or "system"
        expiry = (d + timedelta(days=EXPIRY_DAYS)).isoformat()
        # Idempotent: one comp-off per earned day.
        existing = await db.comp_off_grants.find_one({
            "employee_id": employee_id,
            "earn_date": date_str,
            "status": {"$in": ["pending", "approved", "used"]},
        })
        if existing:
            # A pending grant (from a scan or the employee's request) → credit it now.
            if existing.get("status") == "pending":
                await db.comp_off_grants.update_one(
                    {"_id": existing["_id"]},
                    {"$set": {
                        "status": "approved",
                        "expiry_date": expiry,
                        "approved_at": now,
                        "approved_by": actor,
                    }},
                )
            return  # approved/used already credited
        await db.comp_off_grants.insert_one({
            "employee_id": employee_id,
            "earn_date": date_str,
            "earn_reason": reason,
            "hours_worked": rec.get("hours_worked"),
            "status": "approved",
            "source": "regularisation",
            "expiry_date": expiry,
            "approved_at": now,
            "approved_by": actor,
            "created_at": now,
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
    # A human has now set the real times, so the record leaves the review queue and
    # its hours stop being an estimate. Without this the badge would stick around
    # after the fix and the queue would never empty.
    changes["needs_hr_review"] = False
    changes["hours_worked_estimated"] = False

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

    # Auto-create (and credit) comp-off if this date is a non-working day and employee worked
    await _auto_create_compoff_if_holiday(employee_id, date_str, result.get("status", ""), acted_by)

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
