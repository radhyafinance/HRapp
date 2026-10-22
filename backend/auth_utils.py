import os
import jwt
import bcrypt
from datetime import datetime, timezone, timedelta
from fastapi import HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

security = HTTPBearer()
JWT_ALGORITHM = "HS256"


def get_jwt_secret():
    return os.environ.get("JWT_SECRET", "fallback-secret-key")


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())


def create_token(user_id: str, username: str, role: str, employee_id: str = None, name: str = "") -> str:
    payload = {
        "sub": user_id,
        "username": username,
        "role": role,
        "employee_id": employee_id,
        "name": name,
        "exp": datetime.now(timezone.utc) + timedelta(hours=24),
    }
    return jwt.encode(payload, get_jwt_secret(), algorithm=JWT_ALGORITHM)


async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)):
    try:
        payload = jwt.decode(credentials.credentials, get_jwt_secret(), algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

    # Auto-upgrade role to "managers" if this user actually has direct reports.
    # Protects against DB drift where a manager's stored role is "employee".
    # Only run the lookup for non-privileged roles to keep hot-path cost low.
    role = payload.get("role")
    if role in (None, "employee", "field_agent"):
        from services.hierarchy import has_direct_reports
        if await has_direct_reports(payload.get("employee_id")):
            payload["role"] = "managers"
    return payload


def require_roles(*roles):
    async def checker(current_user: dict = Depends(get_current_user)):
        if current_user.get("role") not in roles:
            raise HTTPException(status_code=403, detail="Access denied")
        return current_user
    return checker



def shared_secret_ok(supplied, env_var: str) -> bool:
    """Constant-time compare of a header value against the secret in `env_var`.

    For machine callers (the dashboard Worker) that send a shared secret instead
    of a user's JWT. An unset or blank secret refuses everything: there is no
    default token, so forgetting to configure one locks the endpoint rather than
    opening it.

    `secrets.compare_digest` rather than `==`: a plain comparison returns as soon
    as it finds a differing byte, which leaks the length of the shared prefix to
    anyone willing to time it.
    """
    import secrets as _secrets
    expected = (os.environ.get(env_var) or "").strip()
    if not expected or not supplied:
        return False
    # compare_digest raises TypeError on a str containing a byte above 0x7F, and
    # Starlette decodes headers as latin-1 -- so any high byte in the header
    # produced an UNAUTHENTICATED 500 instead of a 401. Compare bytes.
    try:
        return _secrets.compare_digest(supplied.strip().encode("utf-8", "surrogateescape"),
                                       expected.encode("utf-8", "surrogateescape"))
    except Exception:
        return False


HR_ADMIN = "hr_admin"
MANAGEMENT = "management"
MANAGERS = "managers"
EMPLOYEE = "employee"
FIELD_AGENT = "field_agent"

ALL_ROLES = [HR_ADMIN, MANAGEMENT, MANAGERS, EMPLOYEE, FIELD_AGENT]
MANAGER_ROLES = [HR_ADMIN, MANAGEMENT, MANAGERS]
