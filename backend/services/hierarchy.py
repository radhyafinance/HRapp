"""
Reporting-tree hierarchy helpers.

A "manager" can see the full sub-tree of employees who report to them
— directly OR indirectly (e.g. their reports' reports, etc.).

These helpers walk the reporting field breadth-first and return the
full set of employee IDs in the sub-tree rooted at a given manager.

NOTE: The DB may use either "reporting_to" or "reports_to" depending on
how employees were onboarded.  Both fields are queried to stay robust.
"""
from database import db


async def get_descendant_employee_ids(root_employee_id: str, max_depth: int = 10) -> set:
    """Return the full sub-tree of employees reporting (transitively) to
    `root_employee_id`. The root itself is NOT included.

    Queries BOTH `reporting_to` and `reports_to` so the function works
    regardless of which field name was used during data entry.
    """
    if not root_employee_id:
        return set()

    descendants: set[str] = set()
    frontier: set[str] = {root_employee_id}

    for _ in range(max_depth):
        if not frontier:
            break
        frontier_list = list(frontier)
        rows = await db.employees.find(
            {
                "$or": [
                    {"reporting_to": {"$in": frontier_list}},
                    {"reports_to":   {"$in": frontier_list}},
                ]
            },
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


async def has_direct_reports(employee_id: str) -> bool:
    """True if at least one employee reports to `employee_id` (either field name)."""
    if not employee_id:
        return False
    found = await db.employees.find_one(
        {"$or": [
            {"reporting_to": employee_id},
            {"reports_to":   employee_id},
        ]},
        {"_id": 1},
    )
    return found is not None


async def compute_effective_role(role: str, employee_id: str) -> str:
    """Return the role to use for authorization decisions.

    Auto-upgrades non-managerial roles (employee / field_agent) to "managers"
    when the user actually has direct reports — protects against DB drift
    where someone's role was mis-set but they're functionally a manager.
    """
    if role in ("hr_admin", "management", "managers"):
        return role
    if await has_direct_reports(employee_id):
        return "managers"
    return role or "employee"


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


# Role that identifies HO (Head Office) staff — hidden from BM/DM managers
HO_STAFF_ROLE = "employee"


async def exclude_ho_staff_from_ids(employee_ids: set) -> set:
    """Remove HO staff (role='employee') from a set of employee IDs.
    Used so BMs/DMs cannot see HO employees' attendance, leaves, etc.
    """
    if not employee_ids:
        return set()
    ids_list = list(employee_ids)
    # Find employees in this set who are NOT HO staff
    non_ho = await db.employees.find(
        {"employee_id": {"$in": ids_list}, "role": {"$ne": HO_STAFF_ROLE}},
        {"_id": 0, "employee_id": 1},
    ).to_list(2000)
    return {e["employee_id"] for e in non_ho}


async def get_manager_scope_excluding_ho(me_id: str) -> list:
    """Return a list of employee IDs a manager can see, excluding HO staff (role='employee').
    Always includes the manager's own ID.
    """
    descendants = await get_descendant_employee_ids(me_id) if me_id else set()
    filtered = await exclude_ho_staff_from_ids(descendants)
    if me_id:
        filtered.add(me_id)
    return list(filtered) if filtered else ["__none__"]
