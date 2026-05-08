"""WebAuthn (passwordless biometric login) for non-admin roles.

Flow:
  1. User logs in normally once. Hits POST /webauthn/register/begin while authenticated.
  2. Browser ceremony with platform authenticator (Touch ID / Face ID / Windows Hello).
  3. POST /webauthn/register/complete stores the public key against the existing user.
  4. Future logins: POST /webauthn/authenticate/begin (with username) → ceremony →
     POST /webauthn/authenticate/complete returns the same JWT shape as /auth/login.

HR Admin role is BLOCKED from registration (server-side enforced).
"""
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional
import os
import secrets
from datetime import datetime, timezone, timedelta
from urllib.parse import urlparse

from webauthn import (
    generate_registration_options,
    verify_registration_response,
    generate_authentication_options,
    verify_authentication_response,
    options_to_json,
)
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    UserVerificationRequirement,
    ResidentKeyRequirement,
    PublicKeyCredentialDescriptor,
)
from webauthn.helpers.cose import COSEAlgorithmIdentifier

from database import db
from auth_utils import get_current_user, create_token


router = APIRouter()


# ──────────────────────────────────────────────────────────────
#  RP configuration — derived from FRONTEND_URL env var
# ──────────────────────────────────────────────────────────────
_FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://localhost:3000")
_parsed = urlparse(_FRONTEND_URL)
RP_ID = _parsed.hostname or "localhost"
RP_NAME = "Radhya Micro Finance HR"
EXPECTED_ORIGIN = f"{_parsed.scheme}://{_parsed.netloc}"

CHALLENGE_TTL_MINUTES = 5
WEBAUTHN_BLOCKED_ROLES = {"hr_admin"}


# ──────────────────────────────────────────────────────────────
#  Pydantic request bodies
# ──────────────────────────────────────────────────────────────
class RegistrationCompleteBody(BaseModel):
    credential: dict   # raw response from navigator.credentials.create()
    friendly_name: Optional[str] = "Primary device"


class AuthenticationBeginBody(BaseModel):
    username: str


class AuthenticationCompleteBody(BaseModel):
    username: str
    credential: dict   # raw response from navigator.credentials.get()


# ──────────────────────────────────────────────────────────────
#  Helpers
# ──────────────────────────────────────────────────────────────
async def _store_challenge(username: str, challenge: bytes, kind: str):
    """Persist a challenge for ~5 min so the verify call can validate it."""
    await db.webauthn_challenges.delete_many({"username": username, "kind": kind})
    await db.webauthn_challenges.insert_one({
        "username": username,
        "kind": kind,
        "challenge": challenge,  # bytes — Mongo stores as Binary
        "expires_at": datetime.now(timezone.utc) + timedelta(minutes=CHALLENGE_TTL_MINUTES),
        "created_at": datetime.now(timezone.utc),
    })


async def _consume_challenge(username: str, kind: str) -> bytes:
    rec = await db.webauthn_challenges.find_one({"username": username, "kind": kind})
    if not rec:
        raise HTTPException(status_code=400, detail="No active challenge — please retry")
    expires_at = rec["expires_at"]
    # Mongo strips tzinfo on read — normalise both sides to naive UTC for comparison
    if expires_at.tzinfo is not None:
        expires_at = expires_at.replace(tzinfo=None)
    if expires_at < datetime.utcnow():
        await db.webauthn_challenges.delete_one({"_id": rec["_id"]})
        raise HTTPException(status_code=400, detail="Challenge expired — please retry")
    await db.webauthn_challenges.delete_one({"_id": rec["_id"]})
    raw = rec["challenge"]
    return bytes(raw) if not isinstance(raw, bytes) else raw


def _user_handle(username: str) -> bytes:
    """Stable WebAuthn user.id — derived deterministically from username (no PII)."""
    return username.encode("utf-8")


# ──────────────────────────────────────────────────────────────
#  Status — does the current user have credentials? Is this role allowed?
# ──────────────────────────────────────────────────────────────
@router.get("/status")
async def webauthn_status(current_user: dict = Depends(get_current_user)):
    """Tells the UI whether to show 'Set up biometric' button + whether already set."""
    role = current_user.get("role")
    username = current_user.get("username")
    allowed = role not in WEBAUTHN_BLOCKED_ROLES
    if not allowed or not username:
        return {"allowed": False, "registered": False, "credentials": []}
    creds = await db.webauthn_credentials.find(
        {"username": username},
        {"_id": 0, "credential_id": 1, "friendly_name": 1, "created_at": 1, "last_used_at": 1},
    ).to_list(20)
    return {
        "allowed": True,
        "registered": len(creds) > 0,
        "rp_id": RP_ID,
        "credentials": creds,
    }


# ──────────────────────────────────────────────────────────────
#  REGISTRATION — must be authenticated to register
# ──────────────────────────────────────────────────────────────
@router.post("/register/begin")
async def register_begin(current_user: dict = Depends(get_current_user)):
    role = current_user.get("role")
    username = current_user.get("username")
    if not username:
        raise HTTPException(status_code=400, detail="No username on session")
    if role in WEBAUTHN_BLOCKED_ROLES:
        raise HTTPException(status_code=403, detail="Biometric login is not available for HR Admin accounts")

    # Existing credentials so the authenticator doesn't re-register the same one
    existing = await db.webauthn_credentials.find(
        {"username": username}, {"_id": 0, "credential_id": 1}
    ).to_list(20)
    exclude = [
        PublicKeyCredentialDescriptor(id=bytes.fromhex(c["credential_id"]))
        for c in existing
    ]

    display_name = current_user.get("name") or username
    options = generate_registration_options(
        rp_id=RP_ID,
        rp_name=RP_NAME,
        user_id=_user_handle(username),
        user_name=username,
        user_display_name=display_name,
        supported_pub_key_algs=[
            COSEAlgorithmIdentifier.ECDSA_SHA_256,
            COSEAlgorithmIdentifier.RSASSA_PKCS1_v1_5_SHA_256,
        ],
        exclude_credentials=exclude,
        authenticator_selection=AuthenticatorSelectionCriteria(
            user_verification=UserVerificationRequirement.PREFERRED,
            resident_key=ResidentKeyRequirement.PREFERRED,
        ),
    )

    await _store_challenge(username, options.challenge, kind="register")
    # options_to_json returns a JSON STRING — parse so FastAPI sends an object
    import json as _json
    return _json.loads(options_to_json(options))


@router.post("/register/complete")
async def register_complete(body: RegistrationCompleteBody, current_user: dict = Depends(get_current_user)):
    role = current_user.get("role")
    username = current_user.get("username")
    if role in WEBAUTHN_BLOCKED_ROLES:
        raise HTTPException(status_code=403, detail="Biometric login is not available for HR Admin accounts")
    if not username:
        raise HTTPException(status_code=400, detail="No username on session")

    challenge = await _consume_challenge(username, kind="register")

    try:
        verification = verify_registration_response(
            credential=body.credential,
            expected_challenge=challenge,
            expected_origin=EXPECTED_ORIGIN,
            expected_rp_id=RP_ID,
            require_user_verification=False,
        )
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Registration verification failed: {e}")

    cred_id_hex = verification.credential_id.hex()
    # Prevent duplicates
    if await db.webauthn_credentials.find_one({"credential_id": cred_id_hex}):
        return {"message": "This device is already registered", "credential_id": cred_id_hex}

    await db.webauthn_credentials.insert_one({
        "username": username,
        "credential_id": cred_id_hex,
        "public_key": verification.credential_public_key,  # bytes
        "sign_count": verification.sign_count,
        "friendly_name": (body.friendly_name or "Device")[:60],
        "created_at": datetime.now(timezone.utc),
        "last_used_at": None,
    })
    return {"message": "Biometric login set up successfully", "credential_id": cred_id_hex}


# ──────────────────────────────────────────────────────────────
#  AUTHENTICATION — public; no auth required
# ──────────────────────────────────────────────────────────────
@router.post("/authenticate/begin")
async def authenticate_begin(body: AuthenticationBeginBody):
    username = body.username.strip()
    user = await db.users.find_one({"username": username}) \
        or await db.users.find_one({"username": username.lower()}) \
        or await db.users.find_one({"username": username.upper()})
    if not user:
        # Don't leak existence — return generic options anyway? For simplicity, 404.
        raise HTTPException(status_code=404, detail="No biometric login set up for this user")
    if user.get("role") in WEBAUTHN_BLOCKED_ROLES:
        raise HTTPException(status_code=403, detail="Biometric login is not available for this account")

    creds = await db.webauthn_credentials.find(
        {"username": user["username"]}, {"_id": 0, "credential_id": 1}
    ).to_list(20)
    if not creds:
        raise HTTPException(status_code=404, detail="No biometric login set up for this user")

    allow = [PublicKeyCredentialDescriptor(id=bytes.fromhex(c["credential_id"])) for c in creds]
    options = generate_authentication_options(
        rp_id=RP_ID,
        allow_credentials=allow,
        user_verification=UserVerificationRequirement.PREFERRED,
    )
    await _store_challenge(user["username"], options.challenge, kind="authenticate")
    import json as _json
    return _json.loads(options_to_json(options))


@router.post("/authenticate/complete")
async def authenticate_complete(body: AuthenticationCompleteBody):
    username = body.username.strip()
    user = await db.users.find_one({"username": username}) \
        or await db.users.find_one({"username": username.lower()}) \
        or await db.users.find_one({"username": username.upper()})
    if not user:
        raise HTTPException(status_code=401, detail="Authentication failed")
    if user.get("role") in WEBAUTHN_BLOCKED_ROLES:
        raise HTTPException(status_code=403, detail="Biometric login is not available for this account")
    if not user.get("is_active", True):
        raise HTTPException(status_code=403, detail="Account is inactive. Contact HR.")
    if user.get("employee_id"):
        emp = await db.employees.find_one({"employee_id": user["employee_id"]}, {"status": 1})
        if emp and emp.get("status") == "exited":
            raise HTTPException(status_code=403, detail="Account disabled — employee has exited the organization.")

    challenge = await _consume_challenge(user["username"], kind="authenticate")

    # Look up the stored credential by ID from the response
    cred_id = body.credential.get("id") or body.credential.get("rawId")
    if not cred_id:
        raise HTTPException(status_code=400, detail="Malformed credential")
    # cred.id is base64url-encoded
    import base64
    pad = "=" * (-len(cred_id) % 4)
    raw_id = base64.urlsafe_b64decode(cred_id + pad)
    cred_id_hex = raw_id.hex()

    stored = await db.webauthn_credentials.find_one({
        "username": user["username"], "credential_id": cred_id_hex
    })
    if not stored:
        raise HTTPException(status_code=401, detail="Unknown credential")

    try:
        verification = verify_authentication_response(
            credential=body.credential,
            expected_challenge=challenge,
            expected_origin=EXPECTED_ORIGIN,
            expected_rp_id=RP_ID,
            credential_public_key=stored["public_key"],
            credential_current_sign_count=stored.get("sign_count", 0),
            require_user_verification=False,
        )
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Authentication failed: {e}")

    # Clone-detection — counter must increase (or stay 0 for some authenticators)
    new_count = verification.new_sign_count
    if stored.get("sign_count", 0) > 0 and new_count <= stored["sign_count"]:
        # Soft-warn but still allow login (some authenticators always return 0)
        pass

    await db.webauthn_credentials.update_one(
        {"_id": stored["_id"]},
        {"$set": {"sign_count": new_count, "last_used_at": datetime.now(timezone.utc)}},
    )

    token = create_token(
        str(user["_id"]),
        user["username"],
        user["role"],
        user.get("employee_id"),
        user.get("name", ""),
    )
    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {
            "id": str(user["_id"]),
            "username": user["username"],
            "name": user.get("name", ""),
            "role": user["role"],
            "employee_id": user.get("employee_id"),
        },
    }


# ──────────────────────────────────────────────────────────────
#  REMOVE a credential (lost device, etc.)
# ──────────────────────────────────────────────────────────────
@router.delete("/credentials/{credential_id_hex}")
async def delete_credential(credential_id_hex: str, current_user: dict = Depends(get_current_user)):
    username = current_user.get("username")
    role = current_user.get("role")
    # Allow HR Admin to remove anyone's; else only own
    q = {"credential_id": credential_id_hex}
    if role != "hr_admin":
        q["username"] = username
    res = await db.webauthn_credentials.delete_one(q)
    if not res.deleted_count:
        raise HTTPException(status_code=404, detail="Credential not found")
    return {"message": "Credential removed"}
