from fastapi import APIRouter, HTTPException, Depends
from database import db
from auth_utils import get_current_user
from datetime import datetime, timezone, date, timedelta

router = APIRouter()


def _is_working_day(d: date) -> bool:
    """Mon-Sat are working; Sunday is not. (Saturday off rule applied separately at attendance level.)"""
    return d.weekday() != 6


@router.get("/my-stats")
async def my_dashboard_stats(current_user: dict = Depends(get_current_user)):
    """Personal dashboard data — for the logged-in employee only.
    Returns: absent_this_month, pending_leaves, pending_regularisations, today_status."""
    emp_id = current_user.get("employee_id")
    if not emp_id:
        raise HTTPException(status_code=400, detail="No employee_id on user")

    today_dt = datetime.now(timezone.utc)
    today_iso = today_dt.strftime("%Y-%m-%d")
    today_d = today_dt.date()
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
    #    that have NO present/half_day record AND NO approved leave covering that day
    yesterday = today_d - timedelta(days=1)
    if yesterday < month_start:
        absent_this_month = 0
    else:
        att_records = await db.attendance_records.find({
            "employee_id": emp_id,
            "date": {"$gte": month_start.isoformat(), "$lte": yesterday.isoformat()},
        }, {"_id": 0, "date": 1, "status": 1, "punch_in_time": 1}).to_list(100)
        present_dates = {r["date"] for r in att_records if r.get("status") in ("present", "half_day") or r.get("punch_in_time")}

        approved_leaves = await db.leave_applications.find({
            "employee_id": emp_id, "status": "approved",
            "$or": [
                {"start_date": {"$lte": yesterday.isoformat()}, "end_date": {"$gte": month_start.isoformat()}},
                {"from_date": {"$lte": yesterday.isoformat()}, "to_date": {"$gte": month_start.isoformat()}},
            ],
        }, {"_id": 0, "start_date": 1, "end_date": 1, "from_date": 1, "to_date": 1}).to_list(100)
        leave_dates = set()
        for lv in approved_leaves:
            s = lv.get("start_date") or lv.get("from_date")
            e = lv.get("end_date") or lv.get("to_date")
            if not s or not e:
                continue
            try:
                s_d = date.fromisoformat(s)
                e_d = date.fromisoformat(e)
            except (ValueError, TypeError):
                continue
            cur = max(s_d, month_start)
            stop = min(e_d, yesterday)
            while cur <= stop:
                leave_dates.add(cur.isoformat())
                cur += timedelta(days=1)

        # Holidays in the window
        holidays = await db.holidays.find({
            "date": {"$gte": month_start.isoformat(), "$lte": yesterday.isoformat()}
        }, {"_id": 0, "date": 1}).to_list(100)
        holiday_dates = {h["date"] for h in holidays}

        absent_this_month = 0
        cur = month_start
        while cur <= yesterday:
            iso = cur.isoformat()
            if _is_working_day(cur) and iso not in holiday_dates and iso not in present_dates and iso not in leave_dates:
                absent_this_month += 1
            cur += timedelta(days=1)

    return {
        "today_status": today_status,
        "pending_leaves": pending_leaves,
        "pending_regularisations": pending_regs,
        "absent_this_month": absent_this_month,
        "month_label": today_d.strftime("%B %Y"),
    }


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
        "absent_today": max(0, total_employees - present_today - on_leave_today),
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
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    role = current_user.get("role")
    me_id = current_user.get("employee_id")
    emp_q = {"status": {"$in": ["active", "probation"]}}
    if role == "managers":
        from services.hierarchy import get_manager_scope_excluding_ho
        scope = await get_manager_scope_excluding_ho(me_id)
        emp_q["employee_id"] = {"$in": scope}
    all_emps = await db.employees.find(emp_q, {"_id": 0, "employee_id": 1, "first_name": 1, "last_name": 1, "designation": 1, "department": 1, "branch": 1}).to_list(500)
    # Find who has punched in
    att_q = {"date": today, "punch_in_time": {"$exists": True, "$ne": None}}
    if role == "managers":
        att_q["employee_id"] = emp_q.get("employee_id", {"$exists": True})
    punched = {r["employee_id"] async for r in db.attendance_records.find(att_q, {"employee_id": 1, "_id": 0})}
    # Also those on approved leave
    leave_q = {"status": "approved", "start_date": {"$lte": today}, "end_date": {"$gte": today}}
    if role == "managers":
        leave_q["employee_id"] = emp_q.get("employee_id", {"$exists": True})
    on_leave = {l["employee_id"] async for l in db.leave_applications.find(leave_q, {"employee_id": 1, "_id": 0})}
    return [{
        "employee_id": e["employee_id"],
        "name": f"{e.get('first_name','')} {e.get('last_name','')}".strip(),
        "designation": e.get("designation", ""),
        "branch": e.get("branch", ""),
    } for e in all_emps if e["employee_id"] not in punched and e["employee_id"] not in on_leave]


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
