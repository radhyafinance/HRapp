"""
Staff directory for the Radhya Dashboard (dashboard.radhyafinance.com).

The dashboard decides which pages each person sees from their HRapp designation
and department. It reads this list about once an hour, so someone who exits
drops off it and loses dashboard access without anyone touching the dashboard.

The caller is a Worker, not a person, so this is not behind get_current_user.
It authenticates the way the closing endpoints do -- a shared secret in the
X-Ingest-Token header -- but with its own secret, STAFF_DIRECTORY_TOKEN, so a
leak of one does not open the other. If STAFF_DIRECTORY_TOKEN is unset, every
request is refused.

WHAT IT RETURNS
---------------
Only people who are still on staff, and only the seven fields below. The list
leaves HRapp, so nothing else goes in: no salary, documents, phone numbers,
bank details, ID numbers, addresses or dates of birth. Adding a field here
means it starts going out to the dashboard -- check that it should first.
"""

from datetime import datetime, timezone

from fastapi import APIRouter, Header, HTTPException

from auth_utils import shared_secret_ok
from database import db

router = APIRouter()

# Exited staff are left out; that is what removes their dashboard access.
LISTED_STATUSES = ["active", "probation", "notice_period"]

DIRECTORY_FIELDS = ("employee_id", "name", "email", "department",
                    "designation", "branch", "status")


def _directory_row(doc: dict) -> dict:
    row = {f: doc.get(f) for f in DIRECTORY_FIELDS}
    # The dashboard matches people by email, so normalise it here once rather
    # than trusting every write path to have done it.
    email = row["email"]
    row["email"] = email.strip().lower() if isinstance(email, str) and email.strip() else None
    return row


@router.get("/directory")
async def staff_directory(x_ingest_token: str = Header(None)):
    """Everyone on staff, with just enough to decide their dashboard pages."""
    if not shared_secret_ok(x_ingest_token, "STAFF_DIRECTORY_TOKEN"):
        # Same answer whether the token is absent, wrong, or unconfigured.
        raise HTTPException(status_code=401, detail="Not authorised")

    projection = {"_id": 0, **{f: 1 for f in DIRECTORY_FIELDS}}
    cursor = db.employees.find({"status": {"$in": LISTED_STATUSES}}, projection)
    staff = [_directory_row(doc) async for doc in cursor]
    staff.sort(key=lambda r: r["employee_id"] or "")
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "count": len(staff),
        "staff": staff,
    }
