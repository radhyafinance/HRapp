"""Remove the now-ignored 'Comp-Off' delta field from all leave_balances docs."""
import asyncio
from database import db

async def main():
    res = await db.leave_balances.update_many(
        {"Comp-Off": {"$exists": True}}, {"$unset": {"Comp-Off": ""}})
    print(f"Cleared Comp-Off override on {res.modified_count} leave_balance doc(s).")

if __name__ == "__main__":
    asyncio.run(main())
