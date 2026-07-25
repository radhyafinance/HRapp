from fastapi import APIRouter, HTTPException, Depends
from database import db
from auth_utils import get_current_user
from services.shift_rules import (fallback_shift_for_role, is_working_day,
                                  resolve_shift_for)
from datetime import datetime, timezone, date, timedelta

router = APIRouter()

IST = timezone(timedelta(hours=5, minutes=30))

# A day is accounted for if the record says so. Only "absent" -- and a missing
# record -- leave a day unexplained. The old code looked at present/half_day
# only, so a day HR had marked weekly_off, holiday or leave still counted as an
# absence unless something else happened to rescue it.
_COVERED_STATUSES = {"present", "half_day", "leave", "weekly_off", "holiday"}


def _ist_today() -> date:
    """Attendance is an Indian business fact; UTC's date is wrong before 05:30 IST."""
    return (datetime.now(timezone.utc) + IST.utcoffset(None)).date()


def _as_date(v):
    try:
        return date.fromisoformat(str(v)[:10])
    except (TypeError, ValueError):
        return None


async def _leave_dates(emp_id: str, lo: date, hi: date) -> set:
    """Approved-leave dates in [lo, hi].

    Queries both schemas: leaves.py normalises legacy `from_date`/`to_date` to
    `start_date`/`end_date` when reading, but the stored documents keep whichever
    they were written with.
    """
    rows = await db.leave_applications.find({
        "employee_id": emp_id, "status": "approved",
        "$or": [
            {"start_date": {"$lte": hi.isoformat()}, "end_date": {"$gte": lo.isoformat()}},
            {"from_date": {"$lte": hi.isoformat()}, "to_date": {"$gte": lo.isoformat()}},
        ],
    }, {"_id": 0, "start_date": 1, "end_date": 1, "from_date": 1, "to_date": 1}).to_list(200)
    out = set()
    for lv in rows:
        s = _as_date(lv.get("start_date") or lv.get("from_date"))
        e = _as_date(lv.get("end_date") or lv.get("to_date"))
        if not s or not e:
            continue
        cur, stop = max(s, lo), min(e, hi)
        while cur <= stop:
            out.add(cur.isoformat())
            cur += timedelta(days=1)
    return out


async def _absent_days(emp_id: str, month_start: date, until: date) -> dict:
    """The dates this employee is counted absent for, and why the window is what it is.

    One implementation behind both the dashboard card and its drilldown, so the
    number and the list it opens can never disagree.
    """
    emp = await db.employees.find_one(
        {"employee_id": emp_id},
        {"_id": 0, "joining_date": 1, "role": 1, "status": 1, "last_working_day": 1}) or {}

    lo, hi = month_start, until
    notes = []
    # Someone cannot be absent before they joined. Without this a mid-month
    # joiner shows every working day since the 1st as an absence.
    jd = _as_date(emp.get("joining_date"))
    if jd and jd > lo:
        lo, _ = jd, notes.append(f"counted from joining date {jd.isoformat()}")
    # ...nor after they left.
    lwd = _as_date(emp.get("last_working_day"))
    if lwd and lwd < hi:
        hi, _ = lwd, notes.append(f"counted up to last working day {lwd.isoformat()}")
    if lo > hi:
        return {"dates": [], "notes": notes, "saturday_rule": None}

    shift = await resolve_shift_for(emp.get("role"), emp_id, db) \
        or fallback_shift_for_role(emp.get("role"))
    sat_rule = (shift or {}).get("saturday_rule", "all_working")

    att = await db.attendance_records.find(
        {"employee_id": emp_id, "date": {"$gte": lo.isoformat(), "$lte": hi.isoformat()}},
        {"_id": 0, "date": 1, "status": 1, "punch_in_time": 1}).to_list(400)
    covered = {r["date"] for r in att
               if r.get("punch_in_time") or r.get("status") in _COVERED_STATUSES}

    leave_dates = await _leave_dates(emp_id, lo, hi)

    holidays = await db.holidays.find(
        {"date": {"$gte": lo.isoformat(), "$lte": hi.isoformat()}},
        {"_id": 0, "date": 1}).to_list(200)
    holiday_dates = {h["date"] for h in holidays}

    dates, cur = [], lo
    while cur <= hi:
        iso = cur.isoformat()
        if (is_working_day(cur, sat_rule) and iso not in holiday_dates
                and iso not in covered and iso not in leave_dates):
            dates.append({"date": iso, "weekday": cur.strftime("%A")})
        cur += timedelta(days=1)
    return {"dates": dates, "notes": notes, "saturday_rule": sat_rule,
            "window": {"from": lo.isoformat(), "to": hi.isoformat()}}


@router.get("/my-stats")
async def my_dashboard_stats(current_user: dict = Depends(get_current_user)):
    """Personal dashboard data — for the logged-in employee only.
    Returns: absent_this_month, pending_leaves, pending_regularisations, today_status."""
    emp_id = current_user.get("employee_id")
    if not emp_id:
        raise HTTPException(status_code=400, detail="No employee_id on user")

    today_d = _ist_today()
    today_iso = today_d.isoformat()
    month_start = today_d.replace(day=1)

    # 1. Today's punch status
    today_rec = await db.attendance_records.find_one({"employee_id": emp_id, "date": today_iso}) or {}
    sessions = today_rec.get("sessions") or []
    last_session = sessions[-1] if sessions else None
    has_open_session = bool(last_session and last_session.get("punch_in_time") and not last_session.get("punch_out_time"))
    today_status = {
        "has_punched_in": bool(today_rec.get("punch_in_time")),
        "has_punched_out": bool(today_rec.get("punch_out_time")) and not has_open_session,
        "punch_in_time": today_rec.get("punch_in_time"),
        "punch_out_time": today_rec.get("punch_out_time"),
        "hours_worked": today_rec.get("hours_worked"),
        "session_count": len(sessions),
        "has_open_session": has_open_session,
        "status": today_rec.get("status"),
    }

    # 2. Pending leaves (mine)
    pending_leaves = await db.leave_applications.count_documents({
        "employee_id": emp_id, "status": "pending"
    })

    # 3. Pending regularisation requests (mine)
    pending_regs = await db.attendance_reg_requests.count_documents({
        "employee_id": emp_id, "status": "pending"
    })

    # 4. Absent days this month — working days from month start through yesterday
    #    with nothing to account for them. Shared with the drilldown below.
    yesterday = today_d - timedelta(days=1)
    absent = ({"dates": []} if yesterday < month_start
              else await _absent_days(emp_id, month_start, yesterday))

    return {
        "today_status": today_status,
        "pending_leaves": pending_leaves,
        "pending_regularisations": pending_regs,
        "absent_this_month": len(absent["dates"]),
        "month_label": today_d.strftime("%B %Y"),
    }


@router.get("/drilldown/my-absent-days")
async def drilldown_my_absent_days(current_user: dict = Depends(get_current_user)):
    """The exact dates behind the "Absent This Month" card.

    Same helper as the card, so the list always explains the number rather than
    offering a second opinion on it.
    """
    emp_id = current_user.get("employee_id")
    if not emp_id:
        raise HTTPException(status_code=400, detail="No employee_id on user")
    today_d = _ist_today()
    month_start = today_d.replace(day=1)
    yesterday = today_d - timedelta(days=1)
    if yesterday < month_start:
        return {"items": [], "count": 0, "note": "The month has only just started."}

    rep = await _absent_days(emp_id, month_start, yesterday)
    note = "; ".join(rep["notes"]) or None
    return {
        "count": len(rep["dates"]),
        "items": [{"name": d["date"], "detail": d["weekday"]} for d in rep["dates"]],
        "note": note,
        "saturday_rule": rep.get("saturday_rule"),
        "window": rep.get("window"),
    }


async def _absent_today_count(emp_query: dict, today: str) -> int:
    """Employees expected in today who have neither punched in nor got approved leave.

    Counted by identity, not arithmetic. The old form was
    `total - present - on_leave`, which had three faults: it knew nothing about
    weekly offs, so every Sunday reported the entire company absent; it knew
    nothing about public holidays; and anyone who was both on leave and punched
    in was subtracted twice.
    """
    d = _as_date(today)
    if d is None:
        return 0
    if await db.holidays.find_one({"date": today}):
        return 0

    employees = await db.employees.find(
        emp_query, {"_id": 0, "employee_id": 1, "role": 1, "shift_id": 1,
                    "joining_date": 1, "last_working_day": 1}).to_list(5000)
    if not employees:
        return 0

    # Saturday is a working day for some shifts and not others, so the rule has
    # to be resolved per employee -- but with two queries, not one per person.
    shifts = await db.shifts.find({"is_active": {"$ne": False}},
                                  {"_id": 0, "id": 1, "saturday_rule": 1}).to_list(200)
    by_id = {sh.get("id"): sh.get("saturday_rule") for sh in shifts}

    present = {r["employee_id"] for r in await db.attendance_records.find(
        {"date": today, "punch_in_time": {"$exists": True, "$ne": None}},
        {"_id": 0, "employee_id": 1}).to_list(5000)}
    on_leave = {r["employee_id"] for r in await db.leave_applications.find(
        {"status": "approved", "$or": [
            {"start_date": {"$lte": today}, "end_date": {"$gte": today}},
            {"from_date": {"$lte": today}, "to_date": {"$gte": today}},
        ]}, {"_id": 0, "employee_id": 1}).to_list(5000)}

    count = 0
    for e in employees:
        eid = e.get("employee_id")
        if eid in present or eid in on_leave:
            continue
        jd = _as_date(e.get("joining_date"))
        if jd and jd > d:
            continue                       # has not started yet
        lwd = _as_date(e.get("last_working_day"))
        if lwd and lwd < d:
            continue                       # already left
        sat_rule = by_id.get(e.get("shift_id")) \
            or (fallback_shift_for_role(e.get("role")) or {}).get("saturday_rule", "all_working")
        if is_working_day(d, sat_rule):
            count += 1
    return count


@router.get("/stats")
async def dashboard_stats(current_user: dict = Depends(get_current_user)):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    role = current_user.get("role")
    me_id = current_user.get("employee_id")

    emp_query = {"status": {"$in": ["active", "probation"]}}
    att_query = {"date": today, "punch_in_time": {"$exists": True, "$ne": None}}
    leave_today_query = {
        "status": "approved",
        "start_date": {"$lte": today},
        "end_date": {"$gte": today},
    }
    pending_leave_query = {"status": "pending"}

    if role == "managers":
        from services.hierarchy import get_manager_scope_excluding_ho
        scope = await get_manager_scope_excluding_ho(me_id)
        emp_query["employee_id"] = {"$in": scope}
        att_query["employee_id"] = {"$in": scope}
        leave_today_query["employee_id"] = {"$in": scope}
        pending_leave_query["employee_id"] = {"$in": scope}

    total_employees = await db.employees.count_documents(emp_query)
    present_today = await db.attendance_records.count_documents(att_query)
    on_leave_today = await db.leave_applications.count_documents(leave_today_query)
    absent_today = await _absent_today_count(emp_query, today)
    pending_leaves = await db.leave_applications.count_documents(pending_leave_query)
    # Exclude converted candidates (they are now employees) to match the Candidates tab.
    total_candidates = await db.candidates.count_documents({"status": {"$ne": "converted"}})
    pending_candidates = await db.candidates.count_documents({"status": "pending"})
    exit_requests = await db.exit_requests.count_documents({"status": {"$nin": ["completed", "rejected"]}})
    now = datetime.now(timezone.utc)
    period = f"{now.year}-{now.month:02d}"
    payroll_processed = None
    if role in ("hr_admin", "management"):
        payroll_processed = await db.payroll_records.count_documents({"period": period})
    return {
        "total_employees": total_employees,
        "present_today": present_today,
        "absent_today": absent_today,
        "on_leave_today": on_leave_today,
        "pending_leaves": pending_leaves,
        "total_candidates": total_candidates,
        "pending_candidates": pending_candidates,
        "exit_requests": exit_requests,
        "payroll_processed_this_month": payroll_processed,
    }


@router.get("/recent-activity")
async def recent_activity(current_user: dict = Depends(get_current_user)):
    activities = []
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    role = current_user.get("role")
    me_id = current_user.get("employee_id")

    att_q: dict = {"date": today}
    leave_q: dict = {}

    if role == "managers":
        from services.hierarchy import get_manager_scope_excluding_ho
        scope = await get_manager_scope_excluding_ho(me_id)
        att_q["employee_id"] = {"$in": scope}
        leave_q["employee_id"] = {"$in": scope}

    att = await db.attendance_records.find(att_q).sort("punch_in_time", -1).to_list(5)
    leaves = await db.leave_applications.find(leave_q).sort("applied_at", -1).to_list(5)

    # Batch-fetch employee names for all IDs referenced
    all_ids = list({a.get("employee_id") for a in att} | {l.get("employee_id") for l in leaves} - {None})
    emp_docs = await db.employees.find(
        {"employee_id": {"$in": all_ids}},
        {"_id": 0, "employee_id": 1, "first_name": 1, "last_name": 1},
    ).to_list(len(all_ids) + 1)
    name_map = {
        e["employee_id"]: f"{e.get('first_name', '')} {e.get('last_name', '')}".strip()
        for e in emp_docs
    }

    def _label(emp_id: str) -> str:
        name = name_map.get(emp_id, "")
        return f"{name} ({emp_id})" if name else emp_id

    for a in att:
        activities.append({
            "type": "attendance",
            "message": f"{_label(a.get('employee_id', ''))} punched in",
            "time": a.get("punch_in_time", ""),
        })

    for l in leaves:
        activities.append({
            "type": "leave",
            "message": f"{_label(l.get('employee_id', ''))} applied for {l.get('leave_type', '')} leave",
            "time": l.get("applied_at", ""),
        })

    activities.sort(key=lambda x: x.get("time", ""), reverse=True)
    return activities[:10]


@router.get("/field-agents-live")
async def field_agents_live(current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management", "managers"]:
        raise HTTPException(status_code=403, detail="Access denied")
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    sess_query = {"date": today, "punch_in_time": {"$exists": True, "$ne": None}, "punch_out_time": None}
    if current_user.get("role") == "managers":
        from services.hierarchy import get_descendant_employee_ids
        me_id = current_user.get("employee_id")
        scope = list(await get_descendant_employee_ids(me_id)) if me_id else []
        if not scope:
            return []
        sess_query["employee_id"] = {"$in": scope}
    active_sessions = await db.attendance_records.find(sess_query).to_list(100)
    result = []
    for session in active_sessions:
        emp_id = session.get("employee_id")
        emp = await db.employees.find_one({"employee_id": emp_id})
        if emp and emp.get("role") in ["field_agent", "managers"]:
            last_loc = await db.location_logs.find_one(
                {"employee_id": emp_id, "date": today},
                sort=[("timestamp", -1)]
            )
            result.append({
                "employee_id": emp_id,
                "name": f"{emp.get('first_name', '')} {emp.get('last_name', '')}",
                "designation": emp.get("designation", ""),
                "punch_in_time": session.get("punch_in_time"),
                "last_location": {
                    "lat": last_loc.get("latitude") if last_loc else session.get("punch_in_location", {}).get("lat"),
                    "lon": last_loc.get("longitude") if last_loc else session.get("punch_in_location", {}).get("lon"),
                    "timestamp": last_loc.get("timestamp") if last_loc else session.get("punch_in_time"),
                } if (last_loc or session.get("punch_in_location")) else None,
            })
    return result


@router.get("/drilldown/present")
async def drilldown_present(current_user: dict = Depends(get_current_user)):
    """Return list of employees who have punched in today."""
    if current_user.get("role") not in ["hr_admin", "management", "managers"]:
        raise HTTPException(status_code=403, detail="Access denied")
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    role = current_user.get("role")
    me_id = current_user.get("employee_id")
    q = {"date": today, "punch_in_time": {"$exists": True, "$ne": None}}
    if role == "managers":
        from services.hierarchy import get_manager_scope_excluding_ho
        scope = await get_manager_scope_excluding_ho(me_id)
        q["employee_id"] = {"$in": scope}
    records = await db.attendance_records.find(q).to_list(500)
    emp_ids = [r["employee_id"] for r in records]
    emps = await db.employees.find({"employee_id": {"$in": emp_ids}},
        {"_id": 0, "employee_id": 1, "first_name": 1, "last_name": 1, "designation": 1, "department": 1, "branch": 1}).to_list(500)
    emap = {e["employee_id"]: e for e in emps}
    return [{
        "employee_id": r["employee_id"],
        "name": f"{emap.get(r['employee_id'], {}).get('first_name','')} {emap.get(r['employee_id'], {}).get('last_name','')}".strip(),
        "designation": emap.get(r["employee_id"], {}).get("designation", ""),
        "branch": emap.get(r["employee_id"], {}).get("branch", ""),
        "punch_in_time": r.get("punch_in_time"),
        "punch_out_time": r.get("punch_out_time"),
        "status": r.get("status"),
    } for r in records]


@router.get("/drilldown/absent")
async def drilldown_absent(current_user: dict = Depends(get_current_user)):
    """Return list of active employees who have NOT punched in today."""
    if current_user.get("role") not in ["hr_admin", "management", "managers"]:
        raise HTTPException(status_code=403, detail="Access denied")
    today = _ist_today().isoformat()
    role = current_user.get("role")
    me_id = current_user.get("employee_id")
    emp_q = {"status": {"$in": ["active", "probation"]}}
    if role == "managers":
        from services.hierarchy import get_manager_scope_excluding_ho
        scope = await get_manager_scope_excluding_ho(me_id)
        emp_q["employee_id"] = {"$in": scope}
    all_emps = await db.employees.find(emp_q, {"_id": 0, "employee_id": 1, "first_name": 1, "last_name": 1, "designation": 1, "department": 1, "branch": 1, "role": 1, "shift_id": 1, "joining_date": 1, "last_working_day": 1}).to_list(500)
    # Find who has punched in
    att_q = {"date": today, "punch_in_time": {"$exists": True, "$ne": None}}
    if role == "managers":
        att_q["employee_id"] = emp_q.get("employee_id", {"$exists": True})
    punched = {r["employee_id"] async for r in db.attendance_records.find(att_q, {"employee_id": 1, "_id": 0})}
    # Also those on approved leave. Both date schemas -- legacy documents store
    # from_date/to_date and were being missed, so people on approved leave were
    # listed as absent.
    leave_q = {"status": "approved", "$or": [
        {"start_date": {"$lte": today}, "end_date": {"$gte": today}},
        {"from_date": {"$lte": today}, "to_date": {"$gte": today}},
    ]}
    if role == "managers":
        leave_q["employee_id"] = emp_q.get("employee_id", {"$exists": True})
    on_leave = {l["employee_id"] async for l in db.leave_applications.find(leave_q, {"employee_id": 1, "_id": 0})}

    # Nobody is absent on a day they were not expected. Without this the list
    # named every employee on Sundays and public holidays.
    d = _as_date(today)
    if d is None or await db.holidays.find_one({"date": today}):
        return []
    shifts = await db.shifts.find({"is_active": {"$ne": False}},
                                  {"_id": 0, "id": 1, "saturday_rule": 1}).to_list(200)
    by_id = {sh.get("id"): sh.get("saturday_rule") for sh in shifts}

    def expected(e):
        jd = _as_date(e.get("joining_date"))
        if jd and jd > d:
            return False
        lwd = _as_date(e.get("last_working_day"))
        if lwd and lwd < d:
            return False
        rule = by_id.get(e.get("shift_id")) \
            or (fallback_shift_for_role(e.get("role")) or {}).get("saturday_rule", "all_working")
        return is_working_day(d, rule)

    return [{
        "employee_id": e["employee_id"],
        "name": f"{e.get('first_name','')} {e.get('last_name','')}".strip(),
        "designation": e.get("designation", ""),
        "branch": e.get("branch", ""),
    } for e in all_emps
        if e["employee_id"] not in punched and e["employee_id"] not in on_leave and expected(e)]


@router.get("/drilldown/on-leave")
async def drilldown_on_leave(current_user: dict = Depends(get_current_user)):
    """Return list of employees on approved leave today."""
    if current_user.get("role") not in ["hr_admin", "management", "managers"]:
        raise HTTPException(status_code=403, detail="Access denied")
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    role = current_user.get("role")
    me_id = current_user.get("employee_id")
    q = {"status": "approved", "start_date": {"$lte": today}, "end_date": {"$gte": today}}
    if role == "managers":
        from services.hierarchy import get_manager_scope_excluding_ho
        scope = await get_manager_scope_excluding_ho(me_id)
        q["employee_id"] = {"$in": scope}
    leaves = await db.leave_applications.find(q).to_list(500)
    emp_ids = list({l["employee_id"] for l in leaves})
    emps = await db.employees.find({"employee_id": {"$in": emp_ids}},
        {"_id": 0, "employee_id": 1, "first_name": 1, "last_name": 1, "designation": 1, "branch": 1}).to_list(500)
    emap = {e["employee_id"]: e for e in emps}
    return [{
        "employee_id": l["employee_id"],
        "name": f"{emap.get(l['employee_id'],{}).get('first_name','')} {emap.get(l['employee_id'],{}).get('last_name','')}".strip(),
        "designation": emap.get(l["employee_id"], {}).get("designation", ""),
        "branch": emap.get(l["employee_id"], {}).get("branch", ""),
        "leave_type": l.get("leave_type", ""),
        "start_date": l.get("start_date"),
        "end_date": l.get("end_date"),
    } for l in leaves]
