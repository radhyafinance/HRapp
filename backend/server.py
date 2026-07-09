from dotenv import load_dotenv
load_dotenv()

import asyncio
import bcrypt
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
from datetime import datetime, timezone, timedelta
from auth_utils import hash_password

from routes import auth, employees, candidates, attendance, leaves, payroll
from routes import performance, exit_routes, letters, locations, dashboard, gratuity, settings as app_settings
from routes import employee_documents, tracker, holidays, comp_offs, notifications, shifts, webauthn

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Radhya HR System", version="1.0.0")

FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://localhost:3000")

# CORS — supports comma-separated list via CORS_ORIGINS env, or "*" for any origin.
# Falls back to FRONTEND_URL if CORS_ORIGINS is not set.
_cors_env = os.environ.get("CORS_ORIGINS", FRONTEND_URL).strip()
if _cors_env == "*":
    _cors_kwargs = {
        "allow_origin_regex": ".*",
        "allow_credentials": True,
    }
else:
    _origins = [o.strip() for o in _cors_env.split(",") if o.strip()]
    # Always include localhost dev + the FRONTEND_URL
    for extra in ("http://localhost:3000", FRONTEND_URL):
        if extra and extra not in _origins:
            _origins.append(extra)
    _cors_kwargs = {
        "allow_origins": _origins,
        "allow_credentials": True,
    }

app.add_middleware(
    CORSMiddleware,
    allow_methods=["*"],
    allow_headers=["*"],
    **_cors_kwargs,
)

mongo_client = AsyncIOMotorClient(os.environ["MONGO_URL"])
db_instance = mongo_client[os.environ["DB_NAME"]]

# Inject DB into routes database module
import database
database.client = mongo_client
database.db = db_instance

app.include_router(auth.router, prefix="/api/auth", tags=["Auth"])
app.include_router(webauthn.router, prefix="/api/auth/webauthn", tags=["WebAuthn"])
app.include_router(employees.router, prefix="/api/employees", tags=["Employees"])
app.include_router(employee_documents.router, prefix="/api/employees", tags=["Employee Documents"])
app.include_router(candidates.router, prefix="/api/candidates", tags=["Candidates"])
app.include_router(attendance.router, prefix="/api/attendance", tags=["Attendance"])
app.include_router(leaves.router, prefix="/api/leaves", tags=["Leaves"])
app.include_router(payroll.router, prefix="/api/payroll", tags=["Payroll"])
app.include_router(performance.router, prefix="/api/performance", tags=["Performance"])
app.include_router(exit_routes.router, prefix="/api/exit", tags=["Exit"])
app.include_router(letters.router, prefix="/api/letters", tags=["Letters"])
app.include_router(locations.router, prefix="/api/locations", tags=["Locations"])
app.include_router(dashboard.router, prefix="/api/dashboard", tags=["Dashboard"])
app.include_router(gratuity.router, prefix="/api/gratuity", tags=["Gratuity"])
app.include_router(app_settings.router, prefix="/api/settings", tags=["Settings"])
app.include_router(tracker.router, prefix="/api/tracker", tags=["Tracker"])
app.include_router(holidays.router, prefix="/api/holidays", tags=["Holidays"])
app.include_router(comp_offs.router, prefix="/api/comp-offs", tags=["Comp-Offs"])
app.include_router(notifications.router, prefix="/api/notifications", tags=["Notifications"])
app.include_router(shifts.router, prefix="/api/shifts", tags=["Shifts"])

from routes import candidate_invites
app.include_router(candidate_invites.router, prefix="/api/candidate-invites", tags=["Candidate Invites"])
app.include_router(candidate_invites.public_router, prefix="/api/public/candidate-invite", tags=["Public Candidate Invite"])

from routes import digilocker
app.include_router(digilocker.router, prefix="/api/digilocker", tags=["DigiLocker"])

from routes import cic_converter
app.include_router(cic_converter.router, prefix="/api/cic", tags=["CIC Converter"])


@app.get("/api")
async def root():
    return {"message": "Radhya HR System API", "status": "running"}


# ──────────────────────────────────────────────────────────────
#  Background scheduler — runs face-photo purge daily at 02:00 IST
# ──────────────────────────────────────────────────────────────
IST_OFFSET = timedelta(hours=5, minutes=30)


def _seconds_until_next_ist(hour: int, minute: int = 0) -> float:
    """Return seconds from 'now' until the next occurrence of HH:MM IST."""
    now_utc = datetime.now(timezone.utc)
    now_ist = now_utc + IST_OFFSET
    target_ist = now_ist.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if target_ist <= now_ist:
        target_ist += timedelta(days=1)
    return (target_ist - now_ist).total_seconds()


async def _daily_face_photo_purge_loop():
    """Run face-mismatch photo cleanup once a day at 02:00 IST. Survives errors."""
    from routes.attendance import purge_old_face_mismatch_photos
    while True:
        try:
            wait = _seconds_until_next_ist(2, 0)
            logger.info(f"Face-photo purge scheduler: next run in {wait/3600:.1f}h (02:00 IST)")
            await asyncio.sleep(wait)
            result = await purge_old_face_mismatch_photos()
            purged = result["top_level_records_purged"] + result["session_records_purged"]
            logger.info(f"Daily face-photo purge: {purged} records (cutoff={result['cutoff_date']})")
        except asyncio.CancelledError:
            logger.info("Face-photo purge scheduler stopped")
            raise
        except Exception as e:
            logger.error(f"Daily face-photo purge failed: {e} — retrying tomorrow")
            # Sleep ~24h before retrying so a recurring failure doesn't tight-loop
            await asyncio.sleep(24 * 3600)


async def _daily_auto_exit_loop():
    """Mark employees as exited once their LWD passes. Runs daily at 00:05 IST."""
    from routes.exit_routes import auto_exit_employees_past_lwd
    while True:
        try:
            wait = _seconds_until_next_ist(0, 5)
            logger.info(f"Auto-exit scheduler: next run in {wait/3600:.1f}h (00:05 IST)")
            await asyncio.sleep(wait)
            result = await auto_exit_employees_past_lwd()
            if result["exited_count"]:
                logger.info(f"Auto-exit: {result['exited_count']} employee(s) marked exited: {result['exited_employees']}")
        except asyncio.CancelledError:
            logger.info("Auto-exit scheduler stopped")
            raise
        except Exception as e:
            logger.error(f"Auto-exit scheduler failed: {e} — retrying tomorrow")
            await asyncio.sleep(24 * 3600)


async def _odometer_reminder_loop():
    """Hourly nudge for employees who owe an odometer photo; escalates to HR
    after 19:00 IST. The reminder function itself gates on work hours."""
    from routes.tracker import run_odometer_reminders
    while True:
        try:
            await asyncio.sleep(3600)  # hourly
            await run_odometer_reminders()
        except asyncio.CancelledError:
            logger.info("Odometer reminder scheduler stopped")
            raise
        except Exception as e:
            logger.error(f"Odometer reminder scheduler failed: {e}")
            await asyncio.sleep(3600)


@app.on_event("startup")
async def startup():
    db = db_instance
    # Create indexes
    # Drop legacy unique index on users.email (we now key by username; allow nullable email)
    try:
        existing_idxs = await db.users.list_indexes().to_list(50)
        for idx in existing_idxs:
            if idx.get("name") == "email_1" and idx.get("unique"):
                await db.users.drop_index("email_1")
                break
    except Exception:
        pass
    try:
        await db.users.create_index("username", unique=True, sparse=True)
        await db.users.create_index("email", sparse=True)
    except Exception:
        pass
    try:
        await db.employees.create_index("employee_id", unique=True)
        await db.employees.create_index("email", unique=True)
    except Exception:
        pass
    await db.attendance_records.create_index([("employee_id", 1), ("date", -1)])
    await db.leave_applications.create_index([("employee_id", 1), ("status", 1)])
    await db.payroll_records.create_index([("employee_id", 1), ("period", -1)])
    try:
        await db.candidate_documents.create_index("candidate_id", unique=True)
    except Exception:
        pass
    # OTP TTL — expired codes auto-removed by Mongo
    try:
        await db.otp_codes.create_index("expires_at", expireAfterSeconds=0)
        await db.otp_codes.create_index("username")
    except Exception:
        pass

    # Shifts — index + seed default shifts on first run
    try:
        await db.shifts.create_index("id", unique=True)
        await db.shifts.create_index("assigned_roles")
    except Exception:
        pass
    try:
        from routes.shifts import seed_default_shifts_if_empty
        seeded = await seed_default_shifts_if_empty()
        if seeded:
            logger.info(f"Seeded {seeded} default shifts")
    except Exception as e:
        logger.warning(f"Shift seeding skipped: {e}")

    # Purge face-mismatch attendance photos older than retention window (45 days)
    try:
        from routes.attendance import purge_old_face_mismatch_photos
        purge_result = await purge_old_face_mismatch_photos()
        purged = purge_result["top_level_records_purged"] + purge_result["session_records_purged"]
        if purged:
            logger.info(f"Face-mismatch photo cleanup: {purged} records purged (cutoff={purge_result['cutoff_date']})")
    except Exception as e:
        logger.warning(f"Face-mismatch photo cleanup skipped: {e}")

    # Start the daily 02:00 IST scheduler for ongoing photo cleanup
    app.state.face_photo_purge_task = asyncio.create_task(_daily_face_photo_purge_loop())

    # Hourly odometer-reminder scheduler
    try:
        await db.odometer_readings.create_index([("employee_id", 1), ("date", 1), ("kind", 1)], unique=True)
        await db.location_logs.create_index([("employee_id", 1), ("date", 1)])
    except Exception:
        pass
    app.state.odometer_reminder_task = asyncio.create_task(_odometer_reminder_loop())

    # Auto-exit: mark employees whose LWD has already passed on startup
    try:
        from routes.exit_routes import auto_exit_employees_past_lwd
        exit_result = await auto_exit_employees_past_lwd()
        if exit_result["exited_count"]:
            logger.info(f"Startup auto-exit: {exit_result['exited_count']} employee(s) marked exited: {exit_result['exited_employees']}")
    except Exception as e:
        logger.warning(f"Startup auto-exit skipped: {e}")

    # Start daily 00:05 IST scheduler for ongoing auto-exit checks
    app.state.auto_exit_task = asyncio.create_task(_daily_auto_exit_loop())

    # Seed / migrate admin user — login by username "admin" (no longer email-based)
    admin_username = os.environ.get("ADMIN_USERNAME", "admin")
    admin_password = os.environ.get("ADMIN_PASSWORD", "Admin@123")
    admin_email = os.environ.get("ADMIN_EMAIL", "admin@radhyamfi.com")
    legacy_admin_email = "admin@radhyamfi.com"

    # 1. If a legacy email-based admin exists, migrate it to username-based
    legacy = await db.users.find_one({"email": legacy_admin_email, "username": {"$exists": False}})
    if legacy:
        await db.users.update_one(
            {"_id": legacy["_id"]},
            {"$set": {"username": admin_username, "name": legacy.get("name") or "Admin", "role": "hr_admin"}},
        )
        logger.info(f"Migrated legacy admin {legacy_admin_email} → username '{admin_username}'")

    # 2. Ensure admin exists (idempotent)
    existing_admin = await db.users.find_one({"username": admin_username})
    if not existing_admin:
        await db.users.insert_one({
            "username": admin_username,
            "email": admin_email,
            "password_hash": hash_password(admin_password),
            "name": "Admin",
            "role": "hr_admin",
            "employee_id": None,
            "is_active": True,
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
        logger.info(f"Admin user created: username='{admin_username}'")
    else:
        # Ensure admin has an email on file (needed for OTP / forgot-password flow)
        if not existing_admin.get("email"):
            await db.users.update_one(
                {"_id": existing_admin["_id"]},
                {"$set": {"email": admin_email}},
            )

    # 3. One-shot migration: any user that has employee_id but no username → set username = employee_id
    async for u in db.users.find({"employee_id": {"$ne": None}, "username": {"$exists": False}}):
        if u.get("employee_id"):
            await db.users.update_one(
                {"_id": u["_id"]},
                {"$set": {"username": u["employee_id"]}},
            )

    # Seed office locations
    count = await db.office_locations.count_documents({})
    if count == 0:
        locations_data = [
            {"name": "Head Office - Moradabad", "address": "MIG 29, Ashiyana Colony, Moradabad, UP 244105",
             "latitude": 28.880786, "longitude": 78.746678, "radius_meters": 10, "location_type": "head_office"},
            {"name": "Chandpur Branch", "address": "24, Chandpur, Mehmoodpur Kasba, UP 246725",
             "latitude": 29.132224, "longitude": 78.283153, "radius_meters": 10, "location_type": "branch"},
            {"name": "Najibabad Branch", "address": "Chhaya Agro, Siddhbali vihar colony, Najibabad, UP 246763",
             "latitude": 29.59107, "longitude": 78.335716, "radius_meters": 10, "location_type": "branch"},
            {"name": "Budaun Branch", "address": "B/110, Shastri Nagar, Budaun, UP 243601",
             "latitude": 28.013857, "longitude": 79.144776, "radius_meters": 10, "location_type": "branch"},
            {"name": "Chandausi Branch", "address": "02, Sita Rd, Pathra, Chandausi, UP 244412",
             "latitude": 28.438212, "longitude": 78.792448, "radius_meters": 10, "location_type": "branch"},
        ]
        for loc in locations_data:
            loc["created_at"] = datetime.now(timezone.utc).isoformat()
            await db.office_locations.insert_one(loc)
        logger.info("Office locations seeded")

    logger.info("Radhya HR System startup complete")


@app.on_event("shutdown")
async def shutdown():
    for task_name in ("face_photo_purge_task", "auto_exit_task", "odometer_reminder_task"):
        task = getattr(app.state, task_name, None)
        if task and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
    mongo_client.close()
