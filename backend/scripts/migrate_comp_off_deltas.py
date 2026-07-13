"""Convert legacy absolute Comp-Off overrides in leave_balances to deltas.
Idempotent. Run once after deploy:  python -m scripts.migrate_comp_off_deltas"""
import asyncio
import sys
import os

# Add backend dir to path so database import works
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from database import db


async def _grant_counts(employee_id):
    a = await db.comp_off_grants.count_documents({"employee_id": employee_id, "status": "approved"})
    u = await db.comp_off_grants.count_documents({"employee_id": employee_id, "status": "used"})
    return a, u


async def main():
    converted = skipped = 0
    async for doc in db.leave_balances.find({"Comp-Off": {"$exists": True}}):
        co = doc.get("Comp-Off")
        if not isinstance(co, dict) or "adj_total" in co or "adj_used" in co or not doc.get("employee_id"):
            skipped += 1
            continue
        gr, gu = await _grant_counts(doc["employee_id"])
        adj = {"adj_total": (co.get("total", 0) or 0) - (gr + gu),
               "adj_used": (co.get("used", 0) or 0) - gu}
        await db.leave_balances.update_one({"_id": doc["_id"]}, {"$set": {"Comp-Off": adj}})
        converted += 1
    print(f"Done. Converted {converted}, skipped {skipped}.")


if __name__ == "__main__":
    asyncio.run(main())
