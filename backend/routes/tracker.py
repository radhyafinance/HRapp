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
    """OsmAnd-protocol ping from Traccar Client.
    Traccar Client sends POST by default but some variants use GET — accept both.
    Returns 200 on success or silent-drop.
    """
    # Merge query params + form body (OsmAnd sends params in URL even on POST)
    qp = {k.lower(): v for k, v in request.query_params.items()}
    try:
        if request.method == "POST":
            form = await request.form()
            for k, v in form.items():
                qp.setdefault(k.lower(), str(v))
    except Exception:
        pass

    # Diagnostic log — captures raw identifier so HR can debug mis-typed setups.
    # Stored in `tracker_ping_log` (capped-ish — auto-trimmed to last 500).
    try:
        raw_id = qp.get("id") or qp.get("deviceid") or ""
        await db.tracker_ping_log.insert_one({
            "raw_id": raw_id[:80],
            "has_lat": bool(qp.get("lat")),
            "has_lon": bool(qp.get("lon")),
            "ip": request.client.host if request.client else None,
            "method": request.method,
            "received_at": datetime.now(timezone.utc).isoformat(),
        })
        # Trim to last 500 rows
        cnt = await db.tracker_ping_log.estimated_document_count()
        if cnt > 550:
            old = await db.tracker_ping_log.find({}, {"_id": 1}).sort("received_at", 1).limit(cnt - 500).to_list(1000)
            if old:
                await db.tracker_ping_log.delete_many({"_id": {"$in": [d["_id"] for d in old]}})
    except Exception:
        pass
    identifier = (qp.get("id") or "").strip()
    if not identifier or ":" not in identifier:
        return Response(status_code=200)

    emp_id, _, secret = identifier.partition(":")
    emp_id = emp_id.strip().upper()
    secret = secret.strip()
    if not emp_id or not secret:
        return Response(status_code=200)

    # Verify identifier against stored tracker config
    tracker = await db.employee_trackers.find_one({"employee_id": emp_id, "secret": secret})
    if not tracker or not tracker.get("active", True):
        # Silent drop — don't leak whether the ID exists
        return Response(status_code=200)

    # Parse coordinates
    try:
        lat = float(qp.get("lat", 0))
        lon = float(qp.get("lon", 0))
    except (ValueError, TypeError):
        return Response(status_code=200)
    if lat == 0 and lon == 0:
        return Response(status_code=200)

    accuracy = None
    for k in ("accuracy", "hdop"):
        if qp.get(k):
            try:
                accuracy = float(qp[k])
                break
            except (ValueError, TypeError):
                pass

    # Timestamp — Traccar sends unix seconds; fall back to server time
    ts = datetime.now(timezone.utc)
    try:
        raw_ts = qp.get("timestamp")
        if raw_ts:
            ts = datetime.fromtimestamp(float(raw_ts), tz=timezone.utc)
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

    # Update last-seen on the tracker config for UI display
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

    return Response(status_code=200)


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

    trackers = await db.employee_trackers.find({}, {"_id": 0}).to_list(2000)
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
    if current_user.get("role") not in ["hr_admin", "management", "managers"]:
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
