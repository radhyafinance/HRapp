"""Location ingestion endpoint (OsmAnd protocol).
The Radhya HR Android app's built-in background GPS tracker posts location
fixes here every few minutes while an employee is punched in — even when the
phone is locked or the app is closed. It uses the simple OsmAnd query format so
the endpoint stays generic (any OsmAnd-compatible client works too).
Each employee has a unique device identifier of the form
`<employee_id>:<secret>` (e.g. `RMF0001:a4f2...`). The app pings:
  GET /api/tracker/osmand?id=<identifier>&lat=..&lon=..&timestamp=..&accuracy=..
The endpoint is intentionally public (no JWT) because these background pings
can't carry bearer tokens. Authentication is via the secret embedded in the
identifier. Pings with unknown/invalid identifiers are silently ignored (still
200 OK so scanners get no signal).
"""
from fastapi import APIRouter, HTTPException, Depends, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional
from database import db
from auth_utils import get_current_user
from datetime import datetime, timezone, timedelta
import secrets
import math
import io
router = APIRouter()
# ──────────────────────────────────────────────────────────────
#  Public endpoint — accepts background location pings
# ──────────────────────────────────────────────────────────────
@router.api_route("/osmand", methods=["GET", "POST"])
async def ingest_ping(request: Request):
    """OsmAnd-protocol location ping from the app's background tracker.
    Accepts (for compatibility with any OsmAnd-style client):
      - GET with query string
      - POST with query string body
      - POST with form-encoded body
      - POST with JSON body (nested location objects)
    Identifier param is accepted as `id` OR `device_id` OR `deviceid`.
    GPS coords accepted as `lat`/`lon` OR inside a nested `location.coords.latitude`.
    Returns 200 on success or silent-drop.
    """
    # Start with URL query params
    qp = {k.lower(): v for k, v in request.query_params.items()}
    # Try form-encoded body
    if request.method == "POST":
        try:
            form = await request.form()
            for k, v in form.items():
                qp.setdefault(k.lower(), str(v))
        except Exception:
            pass
        # Try JSON body (some OsmAnd-style clients send JSON)
        try:
            body = await request.json()
            if isinstance(body, dict):
                _flatten_json(body, qp)
            elif isinstance(body, list) and body:
                # some clients send an array of location objects — process each
                for item in body:
                    if isinstance(item, dict):
                        local = dict(qp)
                        _flatten_json(item, local)
                        await _process_ping(local, request)
                return Response(status_code=200)
        except Exception:
            pass
    await _process_ping(qp, request)
    return Response(status_code=200)
def _flatten_json(obj: dict, out: dict, prefix: str = ""):
    """Flatten nested JSON into flat lowercase keys.
    Also maps common nested GPS field names to our flat keys.
    """
    for k, v in obj.items():
        key = (prefix + k).lower()
        if isinstance(v, dict):
            _flatten_json(v, out, prefix=f"{key}.")
        elif isinstance(v, list):
            continue  # skip arrays inside fields
        else:
            out.setdefault(key, v)
    # Map nested coord paths to our expected flat keys
    mappings = {
        "coords.latitude": "lat",
        "coords.longitude": "lon",
        "coords.accuracy": "accuracy",
        "coords.altitude": "altitude",
        "coords.speed": "speed",
        "coords.heading": "bearing",
        "location.coords.latitude": "lat",
        "location.coords.longitude": "lon",
        "location.coords.accuracy": "accuracy",
        "battery.level": "batt",
        "device_id": "id",
        "deviceid": "id",
    }
    for src, dst in mappings.items():
        if src in out and dst not in out:
            val = out[src]
            # some clients send battery.level as 0.0-1.0 → convert to percentage
            if src == "battery.level" and isinstance(val, (int, float)) and 0 <= val <= 1:
                val = round(val * 100, 1)
            out[dst] = val

# ── on-duty gating ────────────────────────────────────────────────────────────
# Asia/Kolkata. Punch times are stored as IST-local ISO strings; the ping clock is
# UTC. Everything below compares in IST so the two line up.
IST = timezone(timedelta(hours=5, minutes=30))


def _parse_punch(v) -> Optional[datetime]:
    """Punch timestamp -> aware datetime in IST. None if unparseable."""
    if not v:
        return None
    try:
        dt = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    # Naive values are IST wall-clock, which is how attendance records them.
    return dt.replace(tzinfo=IST) if dt.tzinfo is None else dt.astimezone(IST)


async def _is_on_duty(employee_id: str, ts_utc: datetime) -> bool:
    """Was this employee punched in at this moment?

    Location is recorded ONLY between punch-in and punch-out. Before this existed
    every ping was stored unconditionally, so staff were tracked through evenings,
    weekends and days off. Off-duty pings are now discarded outright rather than
    stored-and-hidden: the only certain answer to "were we tracking them at home"
    is that it was never written down.

    A forgotten punch-out ends the window at midnight IST rather than running on
    into the next day.
    """
    ts = ts_utc.astimezone(IST)
    date_str = ts.strftime("%Y-%m-%d")
    att = await db.attendance_records.find_one(
        {"employee_id": employee_id, "date": date_str})
    if not att:
        return False                       # no attendance record = not at work

    # Multi-session days (punch out for lunch and back in) are the normal shape;
    # older records carry a single pair at the top level.
    sessions = att.get("sessions") or []
    if not sessions:
        sessions = [{"punch_in_time": att.get("punch_in_time"),
                     "punch_out_time": att.get("punch_out_time")}]

    midnight = ts.replace(hour=23, minute=59, second=59, microsecond=999999)
    for s in sessions:
        start = _parse_punch(s.get("punch_in_time"))
        if not start:
            continue
        end = _parse_punch(s.get("punch_out_time")) or midnight
        if start <= ts <= end:
            return True
    return False


async def _process_ping(qp: dict, request: Request):
    """Persist a single ping given flattened params."""
    raw_id = str(qp.get("id") or qp.get("deviceid") or qp.get("device_id") or "").strip()
    # Diagnostic log — stored in `tracker_ping_log` (capped to last 500).
    try:
        await db.tracker_ping_log.insert_one({
            "raw_id": raw_id[:80],
            "has_lat": bool(qp.get("lat")),
            "has_lon": bool(qp.get("lon")),
            "ip": request.client.host if request.client else None,
            "method": request.method,
            "received_at": datetime.now(timezone.utc).isoformat(),
        })
        cnt = await db.tracker_ping_log.estimated_document_count()
        if cnt > 550:
            old = await db.tracker_ping_log.find({}, {"_id": 1}).sort("received_at", 1).limit(cnt - 500).to_list(1000)
            if old:
                await db.tracker_ping_log.delete_many({"_id": {"$in": [d["_id"] for d in old]}})
    except Exception:
        pass
    if not raw_id or ":" not in raw_id:
        return
    emp_id, _, secret = raw_id.partition(":")
    emp_id = emp_id.strip().upper()
    secret = secret.strip()
    if not emp_id or not secret:
        return
    tracker = await db.employee_trackers.find_one({"employee_id": emp_id, "secret": secret})
    if not tracker or not tracker.get("active", True):
        return
    try:
        lat = float(qp.get("lat", 0))
        lon = float(qp.get("lon", 0))
    except (ValueError, TypeError):
        return
    if lat == 0 and lon == 0:
        return
    accuracy = _safe_float(qp.get("accuracy")) or _safe_float(qp.get("hdop"))
    ts = datetime.now(timezone.utc)
    try:
        raw_ts = qp.get("timestamp") or qp.get("time")
        if raw_ts:
            raw_ts = str(raw_ts)
            # Accept unix seconds or ISO string
            if raw_ts.replace(".", "").replace("-", "").isdigit():
                ts = datetime.fromtimestamp(float(raw_ts), tz=timezone.utc)
            else:
                ts = datetime.fromisoformat(raw_ts.replace("Z", "+00:00"))
    # OverflowError/OSError matter as much as ValueError here: a garbage
    # timestamp that escapes this block 500s the endpoint, and the app treats a
    # non-2xx as "still offline" and re-queues. Since the queue stops at its
    # first failure, one poisoned ping at the head would block that phone's
    # entire backlog until it aged out seven days later.
    except (ValueError, TypeError, OverflowError, OSError):
        ts = datetime.now(timezone.utc)
    # Normalise, then refuse the future. Both matter for the forward-only guard
    # below: a naive or non-UTC datetime would make its ISO string sort wrong,
    # and a phone whose clock runs fast would stamp last_ping_at ahead of real
    # time — after which every honest ping is older, fails the guard, and the
    # device is frozen "Live" at a stale position with no way back.
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    # Whole seconds, always. The guard below compares ISO STRINGS, and "+" (0x2B)
    # sorts before "." (0x2E) — so "10:00:00+00:00" compares as EARLIER than
    # "10:00:00.5+00:00". Mixing the two (the app sends whole seconds, the
    # server-time fallback carries microseconds) would let a fallback ping lock
    # out the next real one for the rest of that second.
    ts = ts.astimezone(timezone.utc).replace(microsecond=0)
    _now = datetime.now(timezone.utc).replace(microsecond=0)
    if ts > _now + timedelta(minutes=10):
        ts = _now
    # Off duty -> discard. Nothing is written, not even a flagged row.
    if not await _is_on_duty(emp_id, ts):
        return

    date_str = ts.astimezone(IST).strftime("%Y-%m-%d")
    log = {
        "employee_id": emp_id,
        "date": date_str,
        "latitude": lat,
        "longitude": lon,
        "accuracy": accuracy,
        "altitude": _safe_float(qp.get("altitude")),
        "speed": _safe_float(qp.get("speed")),
        "bearing": _safe_float(qp.get("bearing")),
        "battery": _safe_float(qp.get("batt")),
        "timestamp": ts.isoformat(),
        "source": "app",
    }
    await db.location_logs.insert_one(log)
    # The track itself is written unconditionally above — every fix is a real
    # point wherever it arrives in the order. This summary is different: it is
    # "last known", and it must only ever move FORWARD.
    #
    # The app now buffers fixes while it is out of coverage and replays them on
    # reconnect, so backdated pings are normal. Overwriting unconditionally made
    # a phone look MORE stale the moment it came back: the replayed backlog is
    # older than the live fix that arrived with it, so the last write won and
    # Freshness went backwards. Repeat the precondition inside the filter rather
    # than reading-then-writing, so concurrent pings can't interleave past it.
    ts_iso = ts.isoformat()
    await db.employee_trackers.update_one(
        {"employee_id": emp_id,
         # $lte, not $lt: timestamps are whole seconds, so two fixes can share
         # one. Refusing a tie would drop a live ping in favour of a replayed
         # one from the same second; last-write-wins on a tie is the safer end.
         "$or": [{"last_ping_at": {"$lte": ts_iso}},
                 {"last_ping_at": None},
                 {"last_ping_at": {"$exists": False}}]},
        {"$set": {
            "last_ping_at": ts_iso,
            "last_lat": lat,
            "last_lon": lon,
            "last_accuracy": accuracy,
            "last_battery": _safe_float(qp.get("batt")),
        }},
    )
def _safe_float(v):
    if v is None:
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        return None
# ──────────────────────────────────────────────────────────────
#  Admin endpoints — manage employee tracker config
# ──────────────────────────────────────────────────────────────
def _new_secret() -> str:
    return secrets.token_urlsafe(12)


def _has_left(emp: dict, today: str) -> bool:
    """Has this employee finished working here?

    Two independent signals, because they arrive at different times: `status`
    flips to "exited" when HR completes the exit formalities, which can be days
    or weeks after the person actually stopped coming in, while
    `last_working_day` is known up front. Either one is enough.

    An employee with no record at all (a tracker row whose employee was deleted)
    counts as gone — there is nobody left to track.

    The comparison is a plain string compare on YYYY-MM-DD, which is safe
    because both sides are zero-padded ISO dates; `last_working_day` may carry a
    time component ("2026-07-31T00:00:00") so only the date part is taken.
    """
    if not emp:
        return True
    if (emp.get("status") or "").lower() == "exited":
        return True
    lwd = emp.get("last_working_day")
    if not lwd:
        return False
    lwd = str(lwd).split("T")[0].split(" ")[0].strip()
    if len(lwd) != 10:
        # Unrecognised format — keep the person visible. Hiding a working
        # employee because a date failed to parse is the worse mistake.
        return False
    return lwd < today
@router.get("/devices")
async def list_devices(current_user: dict = Depends(get_current_user)):
    """List all configured tracker devices with freshness status.
    Works independent of attendance so admins can diagnose silent devices."""
    # _scope_ids carries the whole access rule — role, grant and manager scope —
    # so the device list can never drift out of step with the distance report.
    scope = await _scope_ids(current_user)
    tracker_q = {}
    if scope is not None:
        if not scope:
            return []
        tracker_q["employee_id"] = {"$in": scope}
    trackers = await db.employee_trackers.find(tracker_q, {"_id": 0}).to_list(2000)
    if not trackers:
        return []
    emp_ids = [t["employee_id"] for t in trackers]
    employees = await db.employees.find(
        {"employee_id": {"$in": emp_ids}},
        {"_id": 0, "employee_id": 1, "first_name": 1, "last_name": 1,
         "designation": 1, "department": 1, "role": 1, "status": 1, "phone": 1,
         "branch": 1, "last_platform": 1, "last_app_version": 1,
         "location_permission": 1, "location_permission_at": 1,
         "tracker_battery_optimised": 1, "tracker_exact_alarms": 1,
         "tracker_service_dead": 1, "tracker_health_at": 1,
         "tracker_queued_pings": 1, "last_working_day": 1},
    ).to_list(2000)
    emp_map = {e["employee_id"]: e for e in employees}
    now = datetime.now(timezone.utc)
    out = []
    today_ist = _today()
    for t in trackers:
        emp = emp_map.get(t["employee_id"]) or {}
        # Anyone who has finished their last working day drops off this list.
        # A tracker row outlives the employment, so leavers used to sit here
        # forever as permanently "Silent" devices — noise that grows every month
        # and buries the people HR can still do something about. Someone serving
        # notice stays visible until the day itself has passed; they are still
        # working, and their tracking still matters.
        if _has_left(emp, today_ist):
            continue
        last_ping = t.get("last_ping_at")
        minutes_ago = None
        freshness = "never"
        if last_ping:
            try:
                dt = datetime.fromisoformat(last_ping.replace("Z", "+00:00"))
                minutes_ago = int((now - dt).total_seconds() / 60)
                # A clock-skewed device can still carry a future last_ping_at
                # from before the clamp existed; without max(0, ...) it reads
                # "Live, just now" forever, which is the single most misleading
                # thing this table could say about a dead phone.
                minutes_ago = max(0, minutes_ago)
                if minutes_ago <= 5:
                    freshness = "live"
                elif minutes_ago <= 30:
                    freshness = "recent"
                elif minutes_ago <= 24 * 60:
                    freshness = "stale"
                else:
                    freshness = "silent"
            except Exception:
                pass
        out.append({
            "employee_id": t["employee_id"],
            "name": f"{emp.get('first_name','')} {emp.get('last_name','')}".strip(),
            "designation": emp.get("designation", ""),
            "department": emp.get("department", ""),
            "role": emp.get("role", ""),
            "employee_status": emp.get("status", ""),
            "phone": emp.get("phone", ""),
            "active": t.get("active", True),
            "interval_seconds": t.get("interval_seconds", 60),
            "last_ping_at": last_ping,
            "minutes_ago": minutes_ago,
            "freshness": freshness,
            "last_lat": t.get("last_lat"),
            "last_lon": t.get("last_lon"),
            "last_battery": t.get("last_battery"),
            "branch": emp.get("branch", ""),
            # Permission is a SEPARATE axis from freshness: a device can be
            # "Allowed always" and still Silent (OEM battery killer, phone off),
            # or "Denied" and still Live (someone left the app open). HR needs
            # both columns to tell those apart.
            "last_platform": emp.get("last_platform"),
            "app_version": emp.get("last_app_version"),
            "location_permission": emp.get("location_permission"),
            "location_permission_at": emp.get("location_permission_at"),
            # Tracker health (APK v1.5.0+). None = this build never reported it,
            # which the UI must show as unknown rather than as healthy.
            "battery_optimised": emp.get("tracker_battery_optimised"),
            "exact_alarms": emp.get("tracker_exact_alarms"),
            "service_dead": emp.get("tracker_service_dead"),
            "queued_pings": emp.get("tracker_queued_pings"),
            "health_at": emp.get("tracker_health_at"),
        })
    # Distance covered TODAY only. The Active Today tab is a live view of the day in
    # progress, so a running total from any other period would be misleading there.
    # Deliberately after the loop so one slow lookup can't stall the whole list.
    today = _today()
    for row in out:
        try:
            row["distance_km_today"] = await _gps_distance_km(row["employee_id"], today)
        except Exception:
            row["distance_km_today"] = None

    # Sort: live > recent > stale > silent > never, then by name
    order = {"live": 0, "recent": 1, "stale": 2, "silent": 3, "never": 4}
    out.sort(key=lambda x: (order.get(x["freshness"], 5), x["name"]))
    return out
@router.get("/config/{employee_id}")
async def get_tracker_config(employee_id: str, current_user: dict = Depends(get_current_user)):
    """Return the tracking setup details (identifier) for an employee.
    Creates a tracker config lazily on first fetch."""
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    emp = await db.employees.find_one(
        {"employee_id": employee_id},
        {"_id": 0, "employee_id": 1, "first_name": 1, "last_name": 1, "phone": 1}
    )
    if not emp:
        raise HTTPException(status_code=404, detail="Employee not found")
    tracker = await db.employee_trackers.find_one({"employee_id": employee_id}, {"_id": 0})
    if not tracker:
        tracker = {
            "employee_id": employee_id,
            "secret": _new_secret(),
            "interval_seconds": 60,
            "active": True,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "last_ping_at": None,
        }
        await db.employee_trackers.insert_one(tracker)
        tracker.pop("_id", None)
    identifier = f"{employee_id}:{tracker['secret']}"
    return {
        "employee_id": employee_id,
        "employee_name": f"{emp.get('first_name','')} {emp.get('last_name','')}".strip(),
        "employee_phone": emp.get("phone", ""),
        "identifier": identifier,
        "interval_seconds": tracker.get("interval_seconds", 60),
        "active": tracker.get("active", True),
        "last_ping_at": tracker.get("last_ping_at"),
        "last_lat": tracker.get("last_lat"),
        "last_lon": tracker.get("last_lon"),
        "last_accuracy": tracker.get("last_accuracy"),
        "last_battery": tracker.get("last_battery"),
    }
@router.post("/regenerate/{employee_id}")
async def regenerate_secret(employee_id: str, current_user: dict = Depends(get_current_user)):
    """Rotate the tracker secret — old device stops working."""
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    emp = await db.employees.find_one({"employee_id": employee_id}, {"_id": 0, "employee_id": 1})
    if not emp:
        raise HTTPException(status_code=404, detail="Employee not found")
    new_secret = _new_secret()
    await db.employee_trackers.update_one(
        {"employee_id": employee_id},
        {"$set": {
            "secret": new_secret,
            "active": True,
            "rotated_at": datetime.now(timezone.utc).isoformat(),
            "rotated_by": current_user.get("employee_id") or current_user.get("username"),
        }, "$setOnInsert": {
            "employee_id": employee_id,
            "interval_seconds": 60,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }},
        upsert=True,
    )
    return {
        "employee_id": employee_id,
        "identifier": f"{employee_id}:{new_secret}",
        "message": "Tracker secret rotated. Old device will stop sending pings.",
    }
def _has_open_session(att: dict) -> bool:
    """True if the employee is currently punched in (a session with no punch-out)."""
    if not att:
        return False
    sessions = att.get("sessions") or []
    if not sessions and att.get("punch_in_time"):
        # legacy single-session record (no sessions[] array)
        return not att.get("punch_out_time")
    for s in sessions:
        if s.get("punch_in_time") and not s.get("punch_out_time"):
            return True
    return False
@router.get("/my-config")
async def get_my_tracker_config(current_user: dict = Depends(get_current_user)):
    """Self-service tracker config for the logged-in field employee.
    Used by the Android app to (a) obtain its own OsmAnd identifier and
    (b) learn whether it should currently be tracking — tracking runs only
    between punch-in and punch-out. Lazily provisions a tracker on first call.
    """
    emp_id = current_user.get("employee_id")
    if not emp_id:
        # Admin / management accounts aren't field-tracked
        raise HTTPException(status_code=400, detail="No employee linked to this account")
    tracker = await db.employee_trackers.find_one({"employee_id": emp_id}, {"_id": 0})
    if not tracker:
        tracker = {
            "employee_id": emp_id,
            "secret": _new_secret(),
            "interval_seconds": 60,
            "active": True,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "last_ping_at": None,
        }
        await db.employee_trackers.insert_one(dict(tracker))
    # UTC ON PURPOSE — do not "fix" this to _today() (IST).
    #
    # This reads attendance_records, and punch_in writes that collection's
    # `date` with datetime.now(timezone.utc) (routes/attendance.py). The lookup
    # has to use the convention the rows were WRITTEN with, not the one the rest
    # of this file uses for GPS buckets. Switching it to IST looks tidier and
    # silently breaks tracking every day between 00:00 and 05:30 IST, when the
    # two dates differ: the record is filed under the UTC date and an IST lookup
    # misses it, so should_track comes back False and the app stops tracking.
    #
    # (_is_on_duty has the mirror-image mismatch — it converts to IST before
    # looking up the same collection. Pre-existing, and it only bites for pings
    # taken 00:00-05:30 IST, but it is the same trap from the other side.)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    att = await db.attendance_records.find_one({"employee_id": emp_id, "date": today})
    return {
        "employee_id": emp_id,
        "identifier": f"{emp_id}:{tracker['secret']}",
        "interval_seconds": tracker.get("interval_seconds", 60),
        "active": tracker.get("active", True),
        "should_track": _has_open_session(att),
    }
@router.get("/my-enforcement")
async def my_location_enforcement(current_user: dict = Depends(get_current_user)):
    """Must this employee have "Allow all the time" location switched on?

    Read by the app's PlatformGate to decide whether to hold someone on the
    "Location access required" screen. Two properties are the whole point of
    this endpoint existing separately, and must survive later edits:

    1. READ-ONLY. It creates nothing. /my-config lazily provisions a tracker
       row with active=True, so a gate built on that would answer "yes, block"
       for whoever merely opened the app — the exact opposite of an opt-in.
    2. OPT-IN. False unless HR has explicitly marked this person as field
       staff. A missing flag, a missing employee record and an admin account
       with no employee linked all come out False, i.e. nobody is blocked.
    """
    emp_id = current_user.get("employee_id")
    if not emp_id:
        return {"field_staff": False}
    emp = await db.employees.find_one(
        {"employee_id": emp_id}, {"_id": 0, "field_staff": 1})
    return {"field_staff": bool(emp and emp.get("field_staff"))}


async def _is_tracking_viewer(current_user: dict) -> bool:
    """Has this person been granted read-only tracking access?

    A per-person flag on the employee record, deliberately NOT a role. Roles are
    checked inline all over this codebase — including nine places that gate on
    `role in ("employee", "field_agent")` to show someone their own payslip,
    leave and attendance — so inventing a role to carry one permission would
    silently drop that person out of their own records.

    Grants READ ONLY. Every write on this router stays hr_admin/management:
    a control function that can switch off the tracking it reviews, or rotate
    the device secret feeding it, is not a control.
    """
    emp_id = current_user.get("employee_id")
    if not emp_id:
        return False
    emp = await db.employees.find_one(
        {"employee_id": emp_id}, {"_id": 0, "tracking_viewer": 1})
    return bool(emp and emp.get("tracking_viewer"))


@router.get("/my-access")
async def my_tracking_access(current_user: dict = Depends(get_current_user)):
    """What this account may see of tracking — read by the nav and the page.

    Read-only and provisions nothing. `scope` is "all" for everyone tracked,
    "team" for a manager's own reporting line, "none" for no access.
    `can_admin` drives whether the page renders its toggles at all; the server
    refuses them regardless, this only stops showing buttons that would 403.
    """
    role = current_user.get("role")
    if role in ("hr_admin", "management"):
        return {"can_view": True, "scope": "all", "can_admin": True, "via": "role"}
    if await _is_tracking_viewer(current_user):
        return {"can_view": True, "scope": "all", "can_admin": False, "via": "grant"}
    if role == "managers":
        return {"can_view": True, "scope": "team", "can_admin": False, "via": "role"}
    return {"can_view": False, "scope": "none", "can_admin": False, "via": None}


@router.post("/tracking-viewer/toggle/{employee_id}")
async def toggle_tracking_viewer(employee_id: str, current_user: dict = Depends(get_current_user)):
    """Grant or revoke read-only tracking access for one person.

    Records who granted it and when: this opens up every field employee's
    location history to someone outside their reporting line, so "who decided
    this?" needs an answer that does not depend on anyone's memory.
    """
    if current_user.get("role") not in ("hr_admin", "management"):
        raise HTTPException(status_code=403, detail="Access denied")
    # employee_id stays in the projection so an employee with no flag yet comes
    # back as {} rather than None — the same trap as the toggles below.
    emp = await db.employees.find_one(
        {"employee_id": employee_id},
        {"_id": 0, "employee_id": 1, "tracking_viewer": 1},
    )
    if emp is None:
        raise HTTPException(status_code=404, detail="Employee not found")
    new_state = not bool(emp.get("tracking_viewer"))
    await db.employees.update_one(
        {"employee_id": employee_id},
        {"$set": {
            "tracking_viewer": new_state,
            "tracking_viewer_at": datetime.now(timezone.utc).isoformat(),
            "tracking_viewer_by": current_user.get("employee_id") or current_user.get("username"),
        }},
    )
    return {"employee_id": employee_id, "tracking_viewer": new_state}


@router.post("/field-staff/toggle/{employee_id}")
async def toggle_field_staff(employee_id: str, current_user: dict = Depends(get_current_user)):
    """Mark/unmark an employee as field staff.

    This is the ONLY thing that switches location enforcement on for someone,
    so it records who flipped it and when — a locked-out employee's first
    question is "who decided this?".
    """
    if current_user.get("role") not in ("hr_admin", "management"):
        raise HTTPException(status_code=403, detail="Access denied")
    # employee_id is in the projection so an existing employee with no
    # field_staff field yet comes back as {} rather than None — see the same
    # note on the odometer toggle below.
    emp = await db.employees.find_one(
        {"employee_id": employee_id},
        {"_id": 0, "employee_id": 1, "field_staff": 1},
    )
    if emp is None:
        raise HTTPException(status_code=404, detail="Employee not found")
    new_state = not bool(emp.get("field_staff"))
    await db.employees.update_one(
        {"employee_id": employee_id},
        {"$set": {
            "field_staff": new_state,
            "field_staff_at": datetime.now(timezone.utc).isoformat(),
            "field_staff_by": current_user.get("employee_id") or current_user.get("username"),
        }},
    )
    return {"employee_id": employee_id, "field_staff": new_state}
@router.post("/toggle/{employee_id}")
async def toggle_active(employee_id: str, current_user: dict = Depends(get_current_user)):
    """Enable or disable a tracker device without rotating the secret."""
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    tracker = await db.employee_trackers.find_one({"employee_id": employee_id})
    if not tracker:
        raise HTTPException(status_code=404, detail="Tracker not configured yet")
    new_state = not tracker.get("active", True)
    await db.employee_trackers.update_one(
        {"employee_id": employee_id},
        {"$set": {"active": new_state}},
    )
    return {"employee_id": employee_id, "active": new_state}
# ══════════════════════════════════════════════════════════════════
#  Distance travelled + odometer (reimbursement)
# ══════════════════════════════════════════════════════════════════
# GPS straight-line distance thresholds (jitter filtering)
_MIN_MOVE_M = 30        # sub-30 m hops = GPS jitter while stationary → ignore
_MAX_ACCURACY_M = 100   # drop fixes worse than 100 m
_MAX_SPEED_MS = 42.0    # ~150 km/h; faster-implied segments are bad fixes
def _today() -> str:
    """Today's date in IST.

    Must match the basis pings are stored under (_process_ping buckets by IST).
    This used to be UTC, which disagreed with the stored date between 00:00 and
    05:30 IST -- so an early-morning lookup read the previous day's data.
    """
    return datetime.now(IST).strftime("%Y-%m-%d")
def _haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))
def _ts_seconds(ts):
    if not ts:
        return None
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()
    except Exception:
        return None
async def _gps_distance_km(employee_id: str, date_str: str) -> float:
    """Filtered straight-line distance (km) from the day's location pings."""
    cur = db.location_logs.find(
        {"employee_id": employee_id, "date": date_str},
        {"_id": 0, "latitude": 1, "longitude": 1, "accuracy": 1, "timestamp": 1},
    ).sort("timestamp", 1)
    total = 0.0
    prev = None  # (lat, lon, secs)
    async for d in cur:
        lat, lon = d.get("latitude"), d.get("longitude")
        if lat is None or lon is None:
            continue
        acc = d.get("accuracy")
        if acc is not None and acc > _MAX_ACCURACY_M:
            continue
        secs = _ts_seconds(d.get("timestamp"))
        if prev is not None:
            seg = _haversine_m(prev[0], prev[1], lat, lon)
            if seg < _MIN_MOVE_M:
                continue  # stationary jitter — keep the previous anchor
            if secs is not None and prev[2] is not None:
                dt = secs - prev[2]
                if dt > 0 and (seg / dt) > _MAX_SPEED_MS:
                    continue  # implausible jump — skip this fix, keep the anchor
            total += seg
        prev = (lat, lon, secs)
    return round(total / 1000.0, 2)
async def _att_punch_state(employee_id: str, date_str: str):
    """(punched_in_today, punched_out_today) from the attendance record."""
    att = await db.attendance_records.find_one({"employee_id": employee_id, "date": date_str})
    if not att:
        return (False, False)
    sessions = att.get("sessions") or []
    if not sessions and att.get("punch_in_time"):
        return (True, bool(att.get("punch_out_time")))
    has_in = any(s.get("punch_in_time") for s in sessions)
    has_out = any(s.get("punch_out_time") for s in sessions)
    return (has_in, has_out)
async def _odo_reading(employee_id: str, date_str: str, kind: str):
    return await db.odometer_readings.find_one(
        {"employee_id": employee_id, "date": date_str, "kind": kind}, {"_id": 0, "photo": 0})
async def _odo_day(employee_id: str, date_str: str):
    """Return (start_doc, end_doc, distance_km_or_None)."""
    start = await _odo_reading(employee_id, date_str, "start")
    end = await _odo_reading(employee_id, date_str, "end")
    dist = None
    if start and end and start.get("reading_km") is not None and end.get("reading_km") is not None:
        d = end["reading_km"] - start["reading_km"]
        dist = round(d, 1) if d >= 0 else None
    return start, end, dist
async def _scope_ids(current_user: dict):
    """None => sees everyone; else the list of employee_ids a manager may see."""
    role = current_user.get("role")
    if role in ("hr_admin", "management"):
        return None
    # A granted tracking viewer sees everyone tracked. Checked BEFORE the
    # managers branch: the grant is the wider scope, and a manager who is also
    # granted must not be narrowed back to their own reporting line.
    if await _is_tracking_viewer(current_user):
        return None
    if role == "managers":
        from services.hierarchy import get_descendant_employee_ids
        me = current_user.get("employee_id")
        return list(await get_descendant_employee_ids(me)) if me else []
    raise HTTPException(status_code=403, detail="Access denied")
# ── Feature A: GPS distance report ────────────────────────────────
@router.get("/distance")
async def distance_report(date_str: str = None, current_user: dict = Depends(get_current_user)):
    """Per-employee distance for one day: GPS estimate + odometer (if tracked)."""
    scope = await _scope_ids(current_user)
    date_str = date_str or _today()
    ping_q = {"date": date_str}
    if scope is not None:
        ping_q["employee_id"] = {"$in": scope}
    gps_ids = await db.location_logs.distinct("employee_id", ping_q)
    odo_q = {"odometer_required": True}
    if scope is not None:
        odo_q["employee_id"] = {"$in": scope}
    odo_ids = await db.employees.distinct("employee_id", odo_q)
    emp_ids = sorted(set(gps_ids) | set(odo_ids))
    if not emp_ids:
        return {"date": date_str, "total_gps_km": 0, "rows": []}
    emps = await db.employees.find(
        {"employee_id": {"$in": emp_ids}},
        {"_id": 0, "employee_id": 1, "first_name": 1, "last_name": 1, "designation": 1, "odometer_required": 1},
    ).to_list(4000)
    emap = {e["employee_id"]: e for e in emps}
    rows, total = [], 0.0
    for eid in emp_ids:
        gps = await _gps_distance_km(eid, date_str)
        total += gps
        e = emap.get(eid, {})
        required = bool(e.get("odometer_required"))
        start, end, odo = await _odo_day(eid, date_str)
        has_in, _ = await _att_punch_state(eid, date_str)
        if not required:
            status = "n/a"
        elif start and end:
            status = "complete"
        elif not has_in:
            status = "not_on_duty"
        else:
            status = "missing"
        rows.append({
            "employee_id": eid,
            "name": f"{e.get('first_name','')} {e.get('last_name','')}".strip() or eid,
            "designation": e.get("designation", ""),
            "gps_km": gps,
            "odometer_required": required,
            "odo_start_km": start.get("reading_km") if start else None,
            "odo_end_km": end.get("reading_km") if end else None,
            "odo_km": odo,
            "odo_status": status,
        })
    rows.sort(key=lambda r: r["gps_km"], reverse=True)
    return {"date": date_str, "total_gps_km": round(total, 2), "rows": rows}
@router.get("/distance/export")
async def distance_export(from_date: str, to_date: str, current_user: dict = Depends(get_current_user)):
    """Excel export of daily GPS + odometer distance over a date range."""
    scope = await _scope_ids(current_user)
    try:
        d0 = datetime.strptime(from_date, "%Y-%m-%d").date()
        d1 = datetime.strptime(to_date, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="Dates must be YYYY-MM-DD")
    if d1 < d0:
        d0, d1 = d1, d0
    if (d1 - d0).days > 92:
        raise HTTPException(status_code=400, detail="Range too large (max 92 days)")
    dates = [(d0 + timedelta(days=i)).strftime("%Y-%m-%d") for i in range((d1 - d0).days + 1)]
    # Which employees to include: anyone with pings in range, or odometer-required.
    ping_q = {"date": {"$in": dates}}
    if scope is not None:
        ping_q["employee_id"] = {"$in": scope}
    gps_ids = await db.location_logs.distinct("employee_id", ping_q)
    odo_q = {"odometer_required": True}
    if scope is not None:
        odo_q["employee_id"] = {"$in": scope}
    odo_ids = await db.employees.distinct("employee_id", odo_q)
    emp_ids = sorted(set(gps_ids) | set(odo_ids))
    emps = await db.employees.find(
        {"employee_id": {"$in": emp_ids}},
        {"_id": 0, "employee_id": 1, "first_name": 1, "last_name": 1, "odometer_required": 1},
    ).to_list(4000)
    emap = {e["employee_id"]: e for e in emps}
    from openpyxl import Workbook
    wb = Workbook()
    daily = wb.active
    daily.title = "Daily"
    daily.append(["Employee ID", "Name", "Date", "GPS km (est.)", "Odometer km", "Odometer status"])
    summary_rows = {}  # eid -> [gps_total, odo_total]
    for eid in emp_ids:
        e = emap.get(eid, {})
        name = f"{e.get('first_name','')} {e.get('last_name','')}".strip() or eid
        required = bool(e.get("odometer_required"))
        summary_rows[eid] = [0.0, 0.0, name]
        for ds in dates:
            gps = await _gps_distance_km(eid, ds)
            start, end, odo = await _odo_day(eid, ds)
            has_in, _ = await _att_punch_state(eid, ds)
            if not required:
                status = ""
            elif start and end:
                status = "complete"
            elif not has_in:
                status = ""
            else:
                status = "MISSING"
            if gps == 0 and odo is None and not has_in:
                continue  # skip empty non-working days
            daily.append([eid, name, ds, gps, odo if odo is not None else "", status])
            summary_rows[eid][0] += gps
            summary_rows[eid][1] += (odo or 0.0)
    summ = wb.create_sheet("Summary")
    summ.append(["Employee ID", "Name", "Total GPS km", "Total Odometer km"])
    for eid in emp_ids:
        g, o, name = summary_rows[eid]
        summ.append([eid, name, round(g, 2), round(o, 1)])
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    fname = f"distance_{from_date}_to_{to_date}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )
# ── Feature B: odometer capture + reminders ───────────────────────
class OdometerReadingIn(BaseModel):
    kind: str                      # "start" | "end"
    reading_km: float
    ocr_text: Optional[str] = None
    photo: Optional[str] = None    # base64 (audit proof)
@router.post("/odometer/reading")
async def submit_odometer_reading(body: OdometerReadingIn, current_user: dict = Depends(get_current_user)):
    """Field employee submits a confirmed odometer reading (start/end of day)."""
    emp_id = current_user.get("employee_id")
    if not emp_id:
        raise HTTPException(status_code=400, detail="No employee linked to this account")
    if body.kind not in ("start", "end"):
        raise HTTPException(status_code=400, detail="kind must be 'start' or 'end'")
    date_str = _today()
    await db.odometer_readings.update_one(
        {"employee_id": emp_id, "date": date_str, "kind": body.kind},
        {"$set": {
            "employee_id": emp_id,
            "date": date_str,
            "kind": body.kind,
            "reading_km": float(body.reading_km),
            "ocr_text": body.ocr_text,
            "photo": body.photo,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }},
        upsert=True,
    )
    _, _, dist = await _odo_day(emp_id, date_str)
    return {"ok": True, "distance_km": dist}
@router.get("/odometer/my-status")
async def my_odometer_status(current_user: dict = Depends(get_current_user)):
    """Tells the app whether the employee owes a start/end odometer photo today."""
    emp_id = current_user.get("employee_id")
    if not emp_id:
        return {"required": False}
    emp = await db.employees.find_one({"employee_id": emp_id}, {"_id": 0, "odometer_required": 1})
    if not (emp and emp.get("odometer_required")):
        return {"required": False}
    date_str = _today()
    has_in, has_out = await _att_punch_state(emp_id, date_str)
    start, end, dist = await _odo_day(emp_id, date_str)
    return {
        "required": True,
        "date": date_str,
        "punched_in": has_in,
        "punched_out": has_out,
        "start_done": bool(start),
        "end_done": bool(end),
        "start_km": start.get("reading_km") if start else None,
        "end_km": end.get("reading_km") if end else None,
        "distance_km": dist,
    }
@router.get("/odometer/employees")
async def odometer_employees(current_user: dict = Depends(get_current_user)):
    """Admin list of employees with their per-person field flags (for Settings).

    The path says "odometer" for historical reasons — it now backs the whole
    Field Staff settings tab, odometer flag and field_staff flag together.
    """
    if current_user.get("role") not in ("hr_admin", "management"):
        raise HTTPException(status_code=403, detail="Access denied")
    emps = await db.employees.find(
        {"status": {"$ne": "exited"}},
        {"_id": 0, "employee_id": 1, "first_name": 1, "last_name": 1, "designation": 1,
         "odometer_required": 1, "field_staff": 1,
         "tracking_viewer": 1, "tracking_viewer_at": 1, "tracking_viewer_by": 1},
    ).sort("employee_id", 1).to_list(4000)
    return [{
        "employee_id": e["employee_id"],
        "name": f"{e.get('first_name','')} {e.get('last_name','')}".strip() or e["employee_id"],
        "designation": e.get("designation", ""),
        "odometer_required": bool(e.get("odometer_required")),
        "field_staff": bool(e.get("field_staff")),
        "tracking_viewer": bool(e.get("tracking_viewer")),
        "tracking_viewer_at": e.get("tracking_viewer_at"),
        "tracking_viewer_by": e.get("tracking_viewer_by"),
    } for e in emps]
@router.post("/odometer/toggle/{employee_id}")
async def toggle_odometer(employee_id: str, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ("hr_admin", "management"):
        raise HTTPException(status_code=403, detail="Access denied")
    # Include employee_id in the projection so the result is never an empty {}
    # for an existing employee who has no odometer_required field yet, and use
    # `is None` (not a falsy check) so that {} is not mistaken for "not found".
    emp = await db.employees.find_one(
        {"employee_id": employee_id},
        {"_id": 0, "employee_id": 1, "odometer_required": 1},
    )
    if emp is None:
        raise HTTPException(status_code=404, detail="Employee not found")
    new_state = not bool(emp.get("odometer_required"))
    await db.employees.update_one({"employee_id": employee_id}, {"$set": {"odometer_required": new_state}})
    return {"employee_id": employee_id, "odometer_required": new_state}
@router.get("/odometer/day/{employee_id}")
async def odometer_day(employee_id: str, date_str: str = None, current_user: dict = Depends(get_current_user)):
    """Full odometer detail incl. photos for a day (audit view).

    Admins and granted tracking viewers only — deliberately NOT the manager
    scope, which has never had access to odometer photos and is not being
    widened here.
    """
    if (current_user.get("role") not in ("hr_admin", "management")
            and not await _is_tracking_viewer(current_user)):
        raise HTTPException(status_code=403, detail="Access denied")
    date_str = date_str or _today()
    start = await db.odometer_readings.find_one(
        {"employee_id": employee_id, "date": date_str, "kind": "start"}, {"_id": 0})
    end = await db.odometer_readings.find_one(
        {"employee_id": employee_id, "date": date_str, "kind": "end"}, {"_id": 0})
    dist = None
    if start and end and start.get("reading_km") is not None and end.get("reading_km") is not None:
        d = end["reading_km"] - start["reading_km"]
        dist = round(d, 1) if d >= 0 else None
    return {"employee_id": employee_id, "date": date_str, "start": start, "end": end, "distance_km": dist}
async def _notify_hr_admins(emp_id: str, date_str: str, has_start: bool, has_end: bool):
    from routes.notifications import create_notification
    emp = await db.employees.find_one({"employee_id": emp_id}, {"_id": 0, "first_name": 1, "last_name": 1})
    name = (f"{emp.get('first_name','')} {emp.get('last_name','')}".strip() if emp else emp_id) or emp_id
    missing = "start & end" if (not has_start and not has_end) else ("start" if not has_start else "end")
    admins = await db.employees.find(
        {"role": {"$in": ["hr_admin", "management"]}, "status": {"$ne": "exited"}},
        {"_id": 0, "employee_id": 1},
    ).to_list(200)
    for a in admins:
        await create_notification(
            a["employee_id"], "Odometer missing",
            f"{name} ({emp_id}) has not submitted odometer ({missing}) for {date_str}.",
            type="warning", link="/field-tracking",
        )
async def run_odometer_reminders():
    """Hourly during work hours: remind employees, escalate to HR after 19:00 IST.
    Invoked by the scheduler loop in server.py."""
    from routes.notifications import create_notification
    now_ist = datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)
    if now_ist.hour < 8 or now_ist.hour >= 22:
        return
    date_str = _today()
    escalate = now_ist.hour >= 19
    emps = await db.employees.find(
        {"odometer_required": True, "status": {"$ne": "exited"}},
        {"_id": 0, "employee_id": 1},
    ).to_list(4000)
    for e in emps:
        eid = e["employee_id"]
        has_in, has_out = await _att_punch_state(eid, date_str)
        if not has_in:
            continue  # not on duty today — nothing owed
        start = await _odo_reading(eid, date_str, "start")
        end = await _odo_reading(eid, date_str, "end")
        if not start:
            await create_notification(
                eid, "Odometer photo needed",
                "Please capture your START-of-day odometer photo in the Radhya HR app.",
                type="warning", link="/dashboard")
        if has_out and not end:
            await create_notification(
                eid, "Odometer photo needed",
                "Please capture your END-of-day odometer photo in the Radhya HR app.",
                type="warning", link="/dashboard")
        if escalate and (not start or (has_out and not end)):
            flagged = await db.odometer_readings.find_one(
                {"employee_id": eid, "date": date_str, "kind": "_hr_flag"})
            if not flagged:
                await db.odometer_readings.insert_one(
                    {"employee_id": eid, "date": date_str, "kind": "_hr_flag",
                     "created_at": datetime.now(timezone.utc).isoformat()})
                await _notify_hr_admins(eid, date_str, bool(start), bool(end))
# ══════════════════════════════════════════════════════════════════
#  App vs PWA adoption tracking
# ══════════════════════════════════════════════════════════════════
# The tracker only works with background ("Allow all the time") location. These
# are the states the app reports; anything else is ignored so junk can't land.
_LOCATION_PERMISSION_STATES = {"always", "in_use", "denied", "prompt", "unknown"}


class ClientInfoIn(BaseModel):
    platform: str                 # "app" | "pwa"
    os: Optional[str] = None
    standalone: Optional[bool] = None
    version: Optional[str] = None  # APK version — reported once a future APK provides it
    # Reported by the native app only (v1.4.0+). "always" = Allow all the time,
    # "in_use" = foreground only (tracker dies when the screen locks), "denied",
    # "prompt" = not yet asked. Older APKs send nothing → stays unknown.
    location_permission: Optional[str] = None
    # Tracker health, reported by the native app only (v1.5.0+). Permission and
    # battery percentage both look healthy on a phone whose tracking has been
    # dead for six hours, so these carry the reasons that column cannot express.
    # True means Android may doze the app — the usual cause of a silent device.
    battery_optimised: Optional[bool] = None
    # False means exact alarms are barred, so fixes fall back to inexact ones
    # that Doze can defer for hours.
    exact_alarms: Optional[bool] = None
    # True once the foreground service was found dead while tracking was on —
    # i.e. an OEM cleaner reaped it and only the worker is still delivering.
    service_dead: Optional[bool] = None
    # Fixes taken out of coverage and buffered on the phone, still waiting to
    # upload. Not a fault — it means the buffer is working — but it separates
    # "no coverage, catching up" from "this phone stopped tracking".
    queued_pings: Optional[int] = None
@router.post("/client-info")
async def record_client_info(body: ClientInfoIn, current_user: dict = Depends(get_current_user)):
    """Called by the frontend on login to record whether the employee is on the
    Android app or the PWA (and the APK version, once the app reports one).
    No-op for accounts without a linked employee."""
    emp_id = current_user.get("employee_id")
    if not emp_id:
        return {"ok": True}
    platform = "app" if body.platform == "app" else "pwa"
    now = datetime.now(timezone.utc).isoformat()
    update = {
        "last_platform": platform,
        "last_platform_os": (body.os or "")[:40],
        "last_platform_at": now,
        "last_platform_standalone": bool(body.standalone),
        ("app_seen_at" if platform == "app" else "pwa_seen_at"): now,
    }
    if platform == "app" and body.version:
        update["last_app_version"] = str(body.version)[:20]
    # Permission is an app-only concept; a PWA login must not overwrite the last
    # known app permission with a meaningless value, so gate on platform + range.
    perm = (body.location_permission or "").strip().lower()
    if platform == "app" and perm in _LOCATION_PERMISSION_STATES:
        update["location_permission"] = perm
        update["location_permission_at"] = now
    # Health is app-only and, like permission, must never be overwritten by a
    # PWA login. `None` means "this build doesn't report it" (any APK before
    # v1.5.0), which is NOT the same as False — so test against None, not falsy.
    if platform == "app":
        health_at = False
        for field, value in (
            ("tracker_battery_optimised", body.battery_optimised),
            ("tracker_exact_alarms", body.exact_alarms),
            ("tracker_service_dead", body.service_dead),
        ):
            if value is not None:
                update[field] = bool(value)
                health_at = True
        if body.queued_pings is not None:
            try:
                # Clamped, not just floored at 0. Pydantic hands over an
                # arbitrary-precision int, so int() never raises and the failure
                # would land in Mongo instead ("can only handle up to 8-byte
                # ints") as an unhandled 500. Every other free-form field on
                # this handler is bounded; this one has to be too.
                update["tracker_queued_pings"] = min(max(0, int(body.queued_pings)), 100000)
                health_at = True
            except (TypeError, ValueError, OverflowError):
                pass
        if health_at:
            update["tracker_health_at"] = now
    await db.employees.update_one({"employee_id": emp_id}, {"$set": update})
    return {"ok": True}
@router.get("/adoption")
async def adoption_report(current_user: dict = Depends(get_current_user)):
    """Per-employee App/PWA status + summary counts. HR/management only."""
    if current_user.get("role") not in ("hr_admin", "management"):
        raise HTTPException(status_code=403, detail="Access denied")
    emps = await db.employees.find(
        {"status": {"$ne": "exited"}},
        {"_id": 0, "employee_id": 1, "first_name": 1, "last_name": 1, "designation": 1,
         "last_platform": 1, "last_platform_os": 1, "last_platform_at": 1,
         "app_seen_at": 1, "pwa_seen_at": 1, "last_app_version": 1},
    ).sort("employee_id", 1).to_list(4000)
    counts = {"app": 0, "pwa": 0, "never": 0}
    rows = []
    for e in emps:
        lp = e.get("last_platform")
        status = "app" if lp == "app" else "pwa" if lp == "pwa" else "never"
        counts[status] += 1
        rows.append({
            "employee_id": e["employee_id"],
            "name": f"{e.get('first_name','')} {e.get('last_name','')}".strip() or e["employee_id"],
            "designation": e.get("designation", ""),
            "status": status,
            "os": e.get("last_platform_os", ""),
            "last_seen": e.get("last_platform_at"),
            "ever_app": bool(e.get("app_seen_at")),
            "version": e.get("last_app_version") or "",
        })
    # Chase list first: PWA, then never, then app; by name within each group.
    order = {"pwa": 0, "never": 1, "app": 2}
    rows.sort(key=lambda r: (order.get(r["status"], 3), r["name"]))
    return {"counts": counts, "rows": rows}
