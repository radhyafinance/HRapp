"""Lightweight in-app notifications.
Each notification targets a specific employee (`employee_id`). The frontend
bell widget polls `/api/notifications` periodically. No push infra — the
optional browser Notification popup is fired client-side only when the tab
is focused.
"""
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional, List
from database import db
from auth_utils import get_current_user
from datetime import datetime, timezone
from bson import ObjectId

router = APIRouter()


def _to_dict(n: dict) -> dict:
    return {
        "id": str(n["_id"]),
        "employee_id": n.get("employee_id"),
        "type": n.get("type"),
        "title": n.get("title"),
        "message": n.get("message"),
        "link": n.get("link"),
        "meta": n.get("meta") or {},
        "read": bool(n.get("read", False)),
        "created_at": n.get("created_at"),
    }


async def create_notification(
    employee_id: str,
    title: str,
    message: str,
    type: str = "info",
    link: Optional[str] = None,
    meta: Optional[dict] = None,
):
    """Internal helper used by other routes (candidates, leaves, etc.)."""
    if not employee_id:
        return None
    doc = {
        "employee_id": employee_id,
        "type": type,
        "title": title,
        "message": message,
        "link": link,
        "meta": meta or {},
        "read": False,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.notifications.insert_one(doc)
    # Best-effort push to the employee's registered devices. Never break the caller.
    try:
        await _push_to_employee(employee_id, title, message, link, type)
    except Exception:
        pass
    return doc


async def _push_to_employee(employee_id: str, title: str, message: str,
                            link: Optional[str], ntype: Optional[str]):
    """Send an FCM push to every device registered to this employee."""
    from services.fcm import send_push
    docs = await db.device_tokens.find({"employee_id": employee_id}).to_list(20)
    tokens = [d["token"] for d in docs if d.get("token")]
    if not tokens:
        return
    dead = await send_push(tokens, title, message, {"link": link or "", "type": ntype or "info"})
    if dead:
        await db.device_tokens.delete_many({"token": {"$in": dead}})


class DeviceTokenIn(BaseModel):
    token: str
    platform: Optional[str] = "android"


@router.post("/register-device")
async def register_device(body: DeviceTokenIn, current_user: dict = Depends(get_current_user)):
    """Store/refresh an FCM device token for the current user (Android app)."""
    me = current_user.get("employee_id") or current_user.get("username")
    if not me or not body.token:
        raise HTTPException(status_code=400, detail="employee and token required")
    # Key by token so a device that logs in as a different user reassigns cleanly.
    await db.device_tokens.update_one(
        {"token": body.token},
        {"$set": {
            "token": body.token,
            "employee_id": me,
            "platform": body.platform or "android",
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }},
        upsert=True,
    )
    return {"ok": True}


@router.post("/unregister-device")
async def unregister_device(body: DeviceTokenIn, current_user: dict = Depends(get_current_user)):
    """Drop a device token (e.g. on logout)."""
    await db.device_tokens.delete_one({"token": body.token})
    return {"ok": True}


@router.get("")
async def list_my_notifications(
    limit: int = 50,
    unread_only: bool = False,
    current_user: dict = Depends(get_current_user),
):
    """List the current user's notifications, most recent first."""
    me = current_user.get("employee_id") or current_user.get("username")
    q = {"employee_id": me}
    if unread_only:
        q["read"] = False
    cursor = db.notifications.find(q).sort("created_at", -1).limit(max(1, min(limit, 200)))
    items = [_to_dict(n) async for n in cursor]
    unread = await db.notifications.count_documents({"employee_id": me, "read": False})
    return {"unread": unread, "items": items}


@router.post("/{notif_id}/read")
async def mark_read(notif_id: str, current_user: dict = Depends(get_current_user)):
    me = current_user.get("employee_id") or current_user.get("username")
    try:
        oid = ObjectId(notif_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid notification id")
    res = await db.notifications.update_one(
        {"_id": oid, "employee_id": me},
        {"$set": {"read": True, "read_at": datetime.now(timezone.utc).isoformat()}},
    )
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Notification not found")
    return {"ok": True}


@router.post("/read-all")
async def mark_all_read(current_user: dict = Depends(get_current_user)):
    me = current_user.get("employee_id") or current_user.get("username")
    res = await db.notifications.update_many(
        {"employee_id": me, "read": False},
        {"$set": {"read": True, "read_at": datetime.now(timezone.utc).isoformat()}},
    )
    return {"marked_read": res.modified_count}
