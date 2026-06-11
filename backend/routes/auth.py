from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from database import db
from auth_utils import hash_password, verify_password, create_token, get_current_user
from services.email_service import send_otp_email, send_forgot_password_otp_email, send_admin_reset_notification
from datetime import datetime, timezone, timedelta
from bson import ObjectId
import secrets
import logging

import re

logger = logging.getLogger(__name__)
router = APIRouter()

# OTP config
OTP_TTL_MINUTES = 10
OTP_COOLDOWN_SECONDS = 60
OTP_MAX_ATTEMPTS = 5

PASSWORD_POLICY = "at least 8 characters, 1 uppercase letter, and 1 number"
_PWD_RE = re.compile(r'^(?=.*[A-Z])(?=.*\d).{8,}$')


def _validate_password(pwd: str) -> None:
    """Raise HTTPException 400 if password doesn't meet the strength policy."""
    if not pwd or not _PWD_RE.match(pwd):
        raise HTTPException(
            status_code=400,
            detail=f"Password must have {PASSWORD_POLICY}.",
        )


class LoginRequest(BaseModel):
    username: str
    password: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


class ForcedPasswordChangeRequest(BaseModel):
    new_password: str


class ResetPasswordRequest(BaseModel):
    new_password: str


class CreateUserRequest(BaseModel):
    username: str
    password: str
    name: str
    role: str
    employee_id: str = None
    email: str = None


class OtpRequestPayload(BaseModel):
    username: str


class OtpVerifyPayload(BaseModel):
    username: str
    otp: str


class ForgotPasswordVerifyPayload(BaseModel):
    username: str
    otp: str
    new_password: str


def _mask_email(email: str) -> str:
    if not email or "@" not in email:
        return email or ""
    local, domain = email.split("@", 1)
    if len(local) <= 2:
        masked = local[0] + "*"
    else:
        masked = local[0] + "*" * (len(local) - 2) + local[-1]
    return f"{masked}@{domain}"


async def _resolve_user_email(user: dict) -> str | None:
    """Return the canonical email to send OTP to. For employees, prefer the email on the
    employees collection (kept up-to-date when HR edits); fall back to user.email."""
    emp_id = user.get("employee_id")
    if emp_id:
        emp = await db.employees.find_one({"employee_id": emp_id}, {"email": 1, "status": 1})
        if emp and emp.get("email"):
            return emp["email"]
    return user.get("email")


@router.post("/otp/request")
async def request_otp(data: OtpRequestPayload):
    """Generate a 6-digit OTP for the given username and email it to the user."""
    username = data.username.strip()
    user = await db.users.find_one({"username": username}) \
        or await db.users.find_one({"username": username.lower()}) \
        or await db.users.find_one({"username": username.upper()})
    if not user:
        raise HTTPException(status_code=404, detail="No account found for that username.")
    if not user.get("is_active", True):
        raise HTTPException(status_code=403, detail="Account is inactive. Contact HR.")
    # Block exited employees
    if user.get("employee_id"):
        emp = await db.employees.find_one({"employee_id": user["employee_id"]}, {"status": 1})
        if emp and emp.get("status") == "exited":
            raise HTTPException(status_code=403, detail="Account disabled — employee has exited the organization.")
    email = await _resolve_user_email(user)
    if not email:
        raise HTTPException(status_code=400, detail="No email address on file. Ask HR to update your record.")

    # Cooldown: 1 OTP request per 60s per username
    now = datetime.now(timezone.utc)
    recent = await db.otp_codes.find_one({"username": user["username"]}, sort=[("created_at", -1)])
    if recent:
        last_at = recent.get("created_at")
        if isinstance(last_at, str):
            try:
                last_at = datetime.fromisoformat(last_at.replace("Z", "+00:00"))
            except Exception:
                last_at = None
        elif isinstance(last_at, datetime) and last_at.tzinfo is None:
            last_at = last_at.replace(tzinfo=timezone.utc)
        if last_at and (now - last_at).total_seconds() < OTP_COOLDOWN_SECONDS:
            wait = int(OTP_COOLDOWN_SECONDS - (now - last_at).total_seconds())
            raise HTTPException(status_code=429, detail=f"Please wait {wait}s before requesting another OTP.")

    otp = f"{secrets.randbelow(1_000_000):06d}"
    expires_at = now + timedelta(minutes=OTP_TTL_MINUTES)
    # Replace any prior un-used OTP for this user
    await db.otp_codes.delete_many({"username": user["username"]})
    await db.otp_codes.insert_one({
        "username": user["username"],
        "otp_hash": hash_password(otp),
        "attempts": 0,
        "used": False,
        "created_at": now,
        "expires_at": expires_at,
    })

    try:
        await send_otp_email(email, otp, name=user.get("name"))
    except Exception as e:
        logger.error(f"OTP send failed for {username}: {e}")
        # If sending fails, remove the OTP so the user can retry without cooldown
        await db.otp_codes.delete_many({"username": user["username"]})
        raise HTTPException(status_code=502, detail="Failed to send OTP email. Please try again or use password login.")

    return {
        "message": "OTP sent",
        "email_masked": _mask_email(email),
        "expires_in_seconds": OTP_TTL_MINUTES * 60,
    }


@router.post("/otp/verify")
async def verify_otp(data: OtpVerifyPayload):
    username = data.username.strip()
    user = await db.users.find_one({"username": username}) \
        or await db.users.find_one({"username": username.lower()}) \
        or await db.users.find_one({"username": username.upper()})
    if not user:
        raise HTTPException(status_code=401, detail="Invalid OTP or username.")
    if not user.get("is_active", True):
        raise HTTPException(status_code=403, detail="Account is inactive. Contact HR.")
    if user.get("employee_id"):
        emp = await db.employees.find_one({"employee_id": user["employee_id"]}, {"status": 1})
        if emp and emp.get("status") == "exited":
            raise HTTPException(status_code=403, detail="Account disabled — employee has exited the organization.")

    record = await db.otp_codes.find_one({"username": user["username"]})
    if not record or record.get("used"):
        raise HTTPException(status_code=401, detail="No active OTP. Request a new one.")
    expires_at = record.get("expires_at")
    if isinstance(expires_at, str):
        try:
            expires_at = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        except Exception:
            expires_at = None
    elif isinstance(expires_at, datetime) and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if not expires_at or datetime.now(timezone.utc) > expires_at:
        await db.otp_codes.delete_one({"_id": record["_id"]})
        raise HTTPException(status_code=401, detail="OTP expired. Request a new one.")
    if record.get("attempts", 0) >= OTP_MAX_ATTEMPTS:
        await db.otp_codes.delete_one({"_id": record["_id"]})
        raise HTTPException(status_code=429, detail="Too many wrong attempts. Request a new OTP.")

    if not verify_password(data.otp.strip(), record["otp_hash"]):
        await db.otp_codes.update_one({"_id": record["_id"]}, {"$inc": {"attempts": 1}})
        remaining = OTP_MAX_ATTEMPTS - (record.get("attempts", 0) + 1)
        raise HTTPException(status_code=401, detail=f"Wrong OTP. {max(remaining, 0)} attempts left.")

    # Success — burn the OTP
    await db.otp_codes.delete_one({"_id": record["_id"]})
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


@router.post("/login")
async def login(data: LoginRequest):
    username = data.username.strip()
    # Username lookup is case-insensitive for admin, case-insensitive (uppercase) for employee IDs
    user = await db.users.find_one({"username": username}) \
        or await db.users.find_one({"username": username.lower()}) \
        or await db.users.find_one({"username": username.upper()})
    if not user or not verify_password(data.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid username or password")
    if not user.get("is_active", True):
        raise HTTPException(status_code=403, detail="Account is inactive. Contact HR.")
    # Block exited employees
    if user.get("employee_id"):
        emp = await db.employees.find_one({"employee_id": user["employee_id"]}, {"status": 1})
        if emp and emp.get("status") == "exited":
            raise HTTPException(status_code=403, detail="Account disabled — employee has exited the organization.")
    # Effective role: auto-promote to "managers" if this user has direct reports,
    # regardless of the stored role. Keeps the UI / authz correct when DB role drifted.
    from services.hierarchy import compute_effective_role
    effective_role = await compute_effective_role(user["role"], user.get("employee_id"))
    token = create_token(
        str(user["_id"]),
        user["username"],
        effective_role,
        user.get("employee_id"),
        user.get("name", ""),
    )
    must_change = user.get("must_change_password", False)
    return {
        "access_token": token,
        "token_type": "bearer",
        "must_change_password": bool(must_change),
        "user": {
            "id": str(user["_id"]),
            "username": user["username"],
            "name": user.get("name", ""),
            "role": effective_role,
            "employee_id": user.get("employee_id"),
        },
    }


@router.get("/me")
async def get_me(current_user: dict = Depends(get_current_user)):
    user = await db.users.find_one({"_id": ObjectId(current_user["sub"])})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    from services.hierarchy import compute_effective_role
    effective_role = await compute_effective_role(user["role"], user.get("employee_id"))
    return {
        "id": str(user["_id"]),
        "username": user.get("username"),
        "name": user.get("name", ""),
        "role": effective_role,
        "employee_id": user.get("employee_id"),
    }


@router.post("/change-password")
async def change_password(data: ChangePasswordRequest, current_user: dict = Depends(get_current_user)):
    _validate_password(data.new_password)
    user = await db.users.find_one({"_id": ObjectId(current_user["sub"])})
    if not user or not verify_password(data.current_password, user["password_hash"]):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    await db.users.update_one(
        {"_id": user["_id"]},
        {"$set": {"password_hash": hash_password(data.new_password), "must_change_password": False}},
    )
    return {"message": "Password changed successfully"}


@router.post("/forced-password-change")
async def forced_password_change(data: ForcedPasswordChangeRequest, current_user: dict = Depends(get_current_user)):
    """For employees who must change password after an admin reset. No current password required."""
    _validate_password(data.new_password)
    user = await db.users.find_one({"_id": ObjectId(current_user["sub"])})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if not user.get("must_change_password"):
        raise HTTPException(status_code=400, detail="Password change not required")
    await db.users.update_one(
        {"_id": user["_id"]},
        {"$set": {"password_hash": hash_password(data.new_password), "must_change_password": False}},
    )
    return {"message": "Password updated successfully"}


@router.post("/employees/{employee_id}/reset-password")
async def reset_employee_password(
    employee_id: str,
    data: ResetPasswordRequest,
    current_user: dict = Depends(get_current_user),
):
    """HR Admin can reset any employee's password. Forces the employee to change password on next login.
    Sends a notification email to the admin inbox (mail@radhyafinance.com)."""
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Only HR Admin / Management can reset passwords")
    _validate_password(data.new_password)
    emp_id = employee_id.strip().upper()
    user = await db.users.find_one({"username": emp_id})
    if not user:
        user = await db.users.find_one({"employee_id": emp_id})
    if not user:
        raise HTTPException(status_code=404, detail=f"No login account found for employee {emp_id}")

    # Get employee name for display
    emp = await db.employees.find_one({"employee_id": emp_id}, {"first_name": 1, "last_name": 1})
    emp_name = f"{emp.get('first_name', '')} {emp.get('last_name', '')}".strip() if emp else emp_id

    await db.users.update_one(
        {"_id": user["_id"]},
        {"$set": {"password_hash": hash_password(data.new_password), "must_change_password": True}},
    )

    return {
        "message": f"Password reset for {emp_id}. Employee will be required to change password on next login.",
        "username": user.get("username", emp_id),
    }


@router.post("/create-user")
async def create_user(data: CreateUserRequest, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") != "hr_admin":
        raise HTTPException(status_code=403, detail="Only HR Admin can create users")
    username = data.username.strip()
    existing = await db.users.find_one({"username": username})
    if existing:
        raise HTTPException(status_code=400, detail="Username already exists")
    user_doc = {
        "username": username,
        "email": (data.email or "").lower().strip() or None,
        "password_hash": hash_password(data.password),
        "name": data.name,
        "role": data.role,
        "employee_id": data.employee_id,
        "is_active": True,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    result = await db.users.insert_one(user_doc)
    return {"id": str(result.inserted_id), "message": "User created successfully"}


@router.get("/users")
async def list_users(current_user: dict = Depends(get_current_user)):
    if current_user.get("role") != "hr_admin":
        raise HTTPException(status_code=403, detail="Access denied")
    users = await db.users.find({}, {"password_hash": 0}).to_list(1000)
    for u in users:
        u["_id"] = str(u["_id"])
    return users


@router.put("/users/{user_id}/toggle")
async def toggle_user(user_id: str, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") != "hr_admin":
        raise HTTPException(status_code=403, detail="Access denied")
    user = await db.users.find_one({"_id": ObjectId(user_id)})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    new_status = not user.get("is_active", True)
    await db.users.update_one({"_id": ObjectId(user_id)}, {"$set": {"is_active": new_status}})
    return {"is_active": new_status}



# ─────────────────────────────────────────────
#  Forgot Password — OTP-based reset (no login)
# ─────────────────────────────────────────────

@router.post("/forgot-password/request")
async def forgot_password_request(data: OtpRequestPayload):
    """Send an OTP to the user's registered email for password reset."""
    username = data.username.strip()
    user = await db.users.find_one({"username": username}) \
        or await db.users.find_one({"username": username.lower()}) \
        or await db.users.find_one({"username": username.upper()})
    if not user:
        raise HTTPException(status_code=404, detail="No account found for that username.")
    if not user.get("is_active", True):
        raise HTTPException(status_code=403, detail="Account is inactive. Contact HR.")
    if user.get("employee_id"):
        emp = await db.employees.find_one({"employee_id": user["employee_id"]}, {"status": 1})
        if emp and emp.get("status") == "exited":
            raise HTTPException(status_code=403, detail="Account disabled — employee has exited the organization.")

    email = await _resolve_user_email(user)
    # For the admin account, always send the OTP to the admin inbox
    if user.get("username", "").lower() == "admin":
        email = "mail@radhyafinance.com"
    elif not email:
        raise HTTPException(status_code=400, detail="No email address on file. Ask HR to update your record.")

    # Cooldown
    now = datetime.now(timezone.utc)
    otp_key = f"fp_{user['username']}"
    recent = await db.otp_codes.find_one({"username": otp_key}, sort=[("created_at", -1)])
    if recent:
        last_at = recent.get("created_at")
        if isinstance(last_at, str):
            try:
                last_at = datetime.fromisoformat(last_at.replace("Z", "+00:00"))
            except Exception:
                last_at = None
        elif isinstance(last_at, datetime) and last_at.tzinfo is None:
            last_at = last_at.replace(tzinfo=timezone.utc)
        if last_at and (now - last_at).total_seconds() < OTP_COOLDOWN_SECONDS:
            wait = int(OTP_COOLDOWN_SECONDS - (now - last_at).total_seconds())
            raise HTTPException(status_code=429, detail=f"Please wait {wait}s before requesting another OTP.")

    otp = f"{secrets.randbelow(1_000_000):06d}"
    expires_at = now + timedelta(minutes=OTP_TTL_MINUTES)
    await db.otp_codes.delete_many({"username": otp_key})
    await db.otp_codes.insert_one({
        "username": otp_key,
        "otp_hash": hash_password(otp),
        "attempts": 0,
        "used": False,
        "created_at": now,
        "expires_at": expires_at,
    })

    try:
        await send_forgot_password_otp_email(email, otp, name=user.get("name"))
    except Exception as e:
        logger.error(f"Forgot-password OTP send failed for {username}: {e}")
        await db.otp_codes.delete_many({"username": otp_key})
        raise HTTPException(status_code=502, detail="Failed to send OTP email. Please try again.")

    return {
        "message": "OTP sent",
        "email_masked": _mask_email(email),
        "expires_in_seconds": OTP_TTL_MINUTES * 60,
    }


@router.post("/forgot-password/verify")
async def forgot_password_verify(data: ForgotPasswordVerifyPayload):
    """Verify OTP and set a new password. Returns success — user must log in normally after."""
    _validate_password(data.new_password)
    username = data.username.strip()
    user = await db.users.find_one({"username": username}) \
        or await db.users.find_one({"username": username.lower()}) \
        or await db.users.find_one({"username": username.upper()})
    if not user:
        raise HTTPException(status_code=401, detail="Invalid OTP or username.")

    otp_key = f"fp_{user['username']}"
    record = await db.otp_codes.find_one({"username": otp_key})
    if not record or record.get("used"):
        raise HTTPException(status_code=401, detail="No active OTP. Request a new one.")

    expires_at = record.get("expires_at")
    if isinstance(expires_at, str):
        try:
            expires_at = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        except Exception:
            expires_at = None
    elif isinstance(expires_at, datetime) and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if not expires_at or datetime.now(timezone.utc) > expires_at:
        await db.otp_codes.delete_one({"_id": record["_id"]})
        raise HTTPException(status_code=401, detail="OTP expired. Request a new one.")
    if record.get("attempts", 0) >= OTP_MAX_ATTEMPTS:
        await db.otp_codes.delete_one({"_id": record["_id"]})
        raise HTTPException(status_code=429, detail="Too many wrong attempts. Request a new OTP.")

    if not verify_password(data.otp.strip(), record["otp_hash"]):
        await db.otp_codes.update_one({"_id": record["_id"]}, {"$inc": {"attempts": 1}})
        remaining = OTP_MAX_ATTEMPTS - (record.get("attempts", 0) + 1)
        raise HTTPException(status_code=401, detail=f"Wrong OTP. {max(remaining, 0)} attempts left.")

    # Success — burn OTP and update password
    await db.otp_codes.delete_one({"_id": record["_id"]})
    await db.users.update_one(
        {"_id": user["_id"]},
        {"$set": {"password_hash": hash_password(data.new_password), "must_change_password": False}},
    )
    return {"message": "Password updated successfully. You can now log in with your new password."}
