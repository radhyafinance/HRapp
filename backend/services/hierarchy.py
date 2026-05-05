"""
Reporting-tree hierarchy helpers.

A "manager" can see the full sub-tree of employees who report to them
— directly OR indirectly (e.g. their reports' reports, etc.).

These helpers walk `employees.reporting_to` breadth-first and return the
full set of employee IDs in the sub-tree rooted at a given manager.
"""
from database import db


async def get_descendant_employee_ids(root_employee_id: str, max_depth: int = 10) -> set:
    """Return the full sub-tree of employees reporting (transitively) to
    `root_employee_id`. The root itself is NOT included.

    `max_depth` is a safety cap to prevent infinite loops on bad data
    (e.g. circular reporting). 10 is plenty for a 40-person org.
    """
    if not root_employee_id:
        return set()

    descendants: set[str] = set()
    frontier: set[str] = {root_employee_id}

    for _ in range(max_depth):
        if not frontier:
            break
        rows = await db.employees.find(
            {"reporting_to": {"$in": list(frontier)}},
            {"_id": 0, "employee_id": 1},
        ).to_list(2000)
        next_frontier: set[str] = set()
        for r in rows:
            eid = r.get("employee_id")
            if eid and eid not in descendants and eid != root_employee_id:
                descendants.add(eid)
                next_frontier.add(eid)
        frontier = next_frontier

    return descendants


async def get_visible_employee_ids(role: str, employee_id: str) -> set | None:
    """Convenience wrapper used by routes for hierarchical scoping.

    Returns:
      - None  → caller has unrestricted access (hr_admin / management).
                Routes should treat None as "no scope filter — see everyone".
      - set() → caller is a manager whose sub-tree is empty. Caller will
                still be able to see their own data; routes should add
                the manager's own employee_id back if relevant.
      - {ids} → the full sub-tree (descendants only — does NOT include
                the manager themselves; add it back where appropriate).
    """
    if role in ("hr_admin", "management"):
        return None
    if role == "managers" and employee_id:
        return await get_descendant_employee_ids(employee_id)
    return set()
