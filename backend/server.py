from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
from datetime import datetime, timezone
from auth_utils import hash_password

from routes import auth, employees, candidates, attendance, leaves, payroll
from routes import performance, exit_routes, letters, locations, dashboard, gratuity

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Radhya HR System", version="1.0.0")

FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://localhost:3000")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_URL, "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

mongo_client = AsyncIOMotorClient(os.environ["MONGO_URL"])
db_instance = mongo_client[os.environ["DB_NAME"]]

# Inject DB into routes database module
import database
database.client = mongo_client
database.db = db_instance

app.include_router(auth.router, prefix="/api/auth", tags=["Auth"])
app.include_router(employees.router, prefix="/api/employees", tags=["Employees"])
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


@app.get("/api")
async def root():
    return {"message": "Radhya HR System API", "status": "running"}


@app.on_event("startup")
async def startup():
    db = db_instance
    # Create indexes
    await db.users.create_index("email", unique=True)
    try:
        await db.employees.create_index("employee_id", unique=True)
        await db.employees.create_index("email", unique=True)
    except Exception:
        pass
    await db.attendance_records.create_index([("employee_id", 1), ("date", -1)])
    await db.leave_applications.create_index([("employee_id", 1), ("status", 1)])
    await db.payroll_records.create_index([("employee_id", 1), ("period", -1)])

    # Seed admin user
    admin_email = os.environ.get("ADMIN_EMAIL", "admin@radhyamfi.com")
    admin_password = os.environ.get("ADMIN_PASSWORD", "Admin@123")
    existing = await db.users.find_one({"email": admin_email})
    if not existing:
        await db.users.insert_one({
            "email": admin_email,
            "password_hash": hash_password(admin_password),
            "name": "HR Admin",
            "role": "hr_admin",
            "employee_id": None,
            "is_active": True,
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
        logger.info(f"Admin user created: {admin_email}")
    elif not __import__('bcrypt').checkpw(admin_password.encode(), existing["password_hash"].encode()):
        await db.users.update_one({"email": admin_email}, {"$set": {"password_hash": hash_password(admin_password)}})

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
    mongo_client.close()
