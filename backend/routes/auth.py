from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from database import db
from auth_utils import hash_password, verify_password, create_token, get_current_user
from datetime import datetime, timezone
from bson import ObjectId

router = APIRouter()


class LoginRequest(BaseModel):
    username: str
    password: str


class ChangePasswordRequest(BaseModel):
    current_password: str
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


@router.get("/me")
async def get_me(current_user: dict = Depends(get_current_user)):
    user = await db.users.find_one({"_id": ObjectId(current_user["sub"])})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return {
        "id": str(user["_id"]),
        "username": user.get("username"),
        "name": user.get("name", ""),
        "role": user["role"],
        "employee_id": user.get("employee_id"),
    }


@router.post("/change-password")
async def change_password(data: ChangePasswordRequest, current_user: dict = Depends(get_current_user)):
    user = await db.users.find_one({"_id": ObjectId(current_user["sub"])})
    if not user or not verify_password(data.current_password, user["password_hash"]):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    await db.users.update_one(
        {"_id": user["_id"]},
        {"$set": {"password_hash": hash_password(data.new_password)}},
    )
    return {"message": "Password changed successfully"}


@router.post("/employees/{employee_id}/reset-password")
async def reset_employee_password(
    employee_id: str,
    data: ResetPasswordRequest,
    current_user: dict = Depends(get_current_user),
):
    """HR Admin can reset any employee's password. Returns the new password for HR to share."""
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Only HR Admin / Management can reset passwords")
    if not data.new_password or len(data.new_password) < 4:
        raise HTTPException(status_code=400, detail="Password must be at least 4 characters")
    emp_id = employee_id.strip().upper()
    user = await db.users.find_one({"username": emp_id})
    if not user:
        # fallback: legacy users keyed by employee_id field
        user = await db.users.find_one({"employee_id": emp_id})
    if not user:
        raise HTTPException(status_code=404, detail=f"No login account found for employee {emp_id}")
    await db.users.update_one(
        {"_id": user["_id"]},
        {"$set": {"password_hash": hash_password(data.new_password)}},
    )
    return {"message": f"Password reset for {emp_id}", "username": user.get("username", emp_id)}


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
