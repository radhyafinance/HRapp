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
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")


def require_roles(*roles):
    async def checker(current_user: dict = Depends(get_current_user)):
        if current_user.get("role") not in roles:
            raise HTTPException(status_code=403, detail="Access denied")
        return current_user
    return checker


HR_ADMIN = "hr_admin"
MANAGEMENT = "management"
MANAGERS = "managers"
EMPLOYEE = "employee"
FIELD_AGENT = "field_agent"

ALL_ROLES = [HR_ADMIN, MANAGEMENT, MANAGERS, EMPLOYEE, FIELD_AGENT]
MANAGER_ROLES = [HR_ADMIN, MANAGEMENT, MANAGERS]
