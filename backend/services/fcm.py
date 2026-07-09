"""Firebase Cloud Messaging sender for Android push notifications.
Credentials come from the FCM_SERVICE_ACCOUNT_JSON environment variable, which
must contain the full service-account key JSON (kept as a secret, never in git).
If the variable is missing, push is silently disabled so the app still works.
"""
import os
import json
import asyncio
import logging
from typing import List, Optional

log = logging.getLogger("fcm")

_app = None
_init_tried = False


def _get_app():
    global _app, _init_tried
    if _app is not None:
        return _app
    if _init_tried:
        return None
    _init_tried = True
    raw = os.environ.get("FCM_SERVICE_ACCOUNT_JSON")
    if not raw:
        log.warning("FCM_SERVICE_ACCOUNT_JSON not set — push notifications disabled")
        return None
    try:
        import firebase_admin
        from firebase_admin import credentials
        info = json.loads(raw)
        _app = firebase_admin.initialize_app(credentials.Certificate(info), name="rmf-fcm")
        log.info("FCM initialised for project %s", info.get("project_id"))
    except Exception as e:  # noqa: BLE001
        log.warning("FCM init failed: %s", e)
        _app = None
    return _app


def _send_sync(tokens: List[str], title: str, body: str, data: Optional[dict]) -> List[str]:
    """Send to all tokens; return the tokens that are dead and should be pruned."""
    app = _get_app()
    if not app or not tokens:
        return []
    from firebase_admin import messaging
    message = messaging.MulticastMessage(
        tokens=tokens,
        notification=messaging.Notification(title=title, body=body),
        data={k: str(v) for k, v in (data or {}).items() if v is not None},
        android=messaging.AndroidConfig(priority="high"),
    )
    dead: List[str] = []
    try:
        resp = messaging.send_each_for_multicast(message, app=app)
        for i, r in enumerate(resp.responses):
            if not r.success:
                name = type(r.exception).__name__ if r.exception else ""
                if name in ("UnregisteredError", "SenderIdMismatchError"):
                    dead.append(tokens[i])
                else:
                    log.warning("FCM token %s… failed: %s", tokens[i][:12], name)
    except Exception as e:  # noqa: BLE001
        log.warning("FCM send failed: %s", e)
    return dead


async def send_push(tokens: List[str], title: str, body: str, data: Optional[dict] = None) -> List[str]:
    """Async wrapper. Returns dead tokens to prune. Never raises."""
    if not tokens:
        return []
    try:
        return await asyncio.to_thread(_send_sync, tokens, title, body, data)
    except Exception as e:  # noqa: BLE001
        log.warning("send_push error: %s", e)
        return []
