"""Traccar Client (OsmAnd protocol) endpoint.

Field staff install the free Traccar Client app (Play Store / App Store) which
provides reliable background GPS tracking even when the phone is locked —
something a PWA fundamentally cannot do.

Each employee is issued a unique device identifier of the form
`<employee_id>:<secret>` (e.g. `RMF0001:a4f2...`). The app pings:

  GET /api/tracker/osmand?id=<identifier>&lat=..&lon=..&timestamp=..&accuracy=..

The endpoint is intentionally public (no JWT) because Traccar Client cannot
send bearer tokens. Authentication is via the secret embedded in the identifier.
Pings with unknown/invalid identifiers are silently ignored (still 200 OK so
scanners get no signal).
"""
from fastapi import APIRouter, HTTPException, Depends, Request, Response
from database import db
from auth_utils import get_current_user
from datetime import datetime, timezone
import secrets

router = APIRouter()


# ──────────────────────────────────────────────────────────────
#  Public endpoint — accepts Traccar Client pings
# ──────────────────────────────────────────────────────────────

@router.api_route("/osmand", methods=["GET", "POST"])
async def traccar_ping(request: Request):
    """OsmAnd-protocol ping from Traccar Client / TS Background Geolocation.
    Accepts:
      - GET with query string (Traccar Client default on older Android)
      - POST with query string body (Traccar Client default)
      - POST with form-encoded body
      - POST with JSON body (Transistorsoft Background Geolocation)
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

        # Try JSON body (Transistorsoft sends JSON by default)
        try:
            body = await request.json()
            if isinstance(body, dict):
                _flatten_json(body, qp)
            elif isinstance(body, list) and body:
                # TS sends an array of location objects — process each, use first for identifier
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
    Also maps common Transistorsoft field names to our expected names.
    """
    for k, v in obj.items():
        key = (prefix + k).lower()
        if isinstance(v, dict):
            _flatten_json(v, out, prefix=f"{key}.")
        elif isinstance(v, list):
            continue  # skip arrays inside fields
        else:
            out.setdefault(key, v)

    # Map TS-specific nested paths to our expected flat keys
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
            # TS sends battery.level as 0.0-1.0 → convert to percentage
            if src == "battery.level" and isinstance(val, (int, float)) and 0 <= val <= 1:
                val = round(val * 100, 1)
            out[dst] = val


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
    except (ValueError, TypeError):
        pass

    date_str = ts.strftime("%Y-%m-%d")

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
        "source": "traccar",
    }
    await db.location_logs.insert_one(log)

    await db.employee_trackers.update_one(
        {"employee_id": emp_id},
        {"$set": {
            "last_ping_at": ts.isoformat(),
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


@router.get("/devices")
async def list_devices(current_user: dict = Depends(get_current_user)):
    """List all configured Traccar devices with freshness status.
    Works independent of attendance so admins can diagnose silent devices."""
    if current_user.get("role") not in ["hr_admin", "management", "managers"]:
        raise HTTPException(status_code=403, detail="Access denied")

    tracker_q = {}
    if current_user.get("role") == "managers":
        from services.hierarchy import get_descendant_employee_ids
        me_id = current_user.get("employee_id")
        scope = list(await get_descendant_employee_ids(me_id)) if me_id else []
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
         "designation": 1, "department": 1, "role": 1, "status": 1, "phone": 1},
    ).to_list(2000)
    emp_map = {e["employee_id"]: e for e in employees}

    now = datetime.now(timezone.utc)
    out = []
    for t in trackers:
        emp = emp_map.get(t["employee_id"]) or {}
        last_ping = t.get("last_ping_at")
        minutes_ago = None
        freshness = "never"
        if last_ping:
            try:
                dt = datetime.fromisoformat(last_ping.replace("Z", "+00:00"))
                minutes_ago = int((now - dt).total_seconds() / 60)
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
        })
    # Sort: live > recent > stale > silent > never, then by name
    order = {"live": 0, "recent": 1, "stale": 2, "silent": 3, "never": 4}
    out.sort(key=lambda x: (order.get(x["freshness"], 5), x["name"]))
    return out


@router.get("/config/{employee_id}")
async def get_tracker_config(employee_id: str, current_user: dict = Depends(get_current_user)):
    """Return the Traccar Client setup details for an employee.
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
