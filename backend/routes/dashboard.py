from fastapi import APIRouter, HTTPException, Depends
from database import db
from auth_utils import get_current_user
from datetime import datetime, timezone

router = APIRouter()


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
        from services.hierarchy import get_descendant_employee_ids
        scope = list(await get_descendant_employee_ids(me_id)) if me_id else []
        if me_id:
            scope.append(me_id)
        scope = scope or ["__none__"]
        emp_query["employee_id"] = {"$in": scope}
        att_query["employee_id"] = {"$in": scope}
        leave_today_query["employee_id"] = {"$in": scope}
        pending_leave_query["employee_id"] = {"$in": scope}

    total_employees = await db.employees.count_documents(emp_query)
    present_today = await db.attendance_records.count_documents(att_query)
    on_leave_today = await db.leave_applications.count_documents(leave_today_query)
    pending_leaves = await db.leave_applications.count_documents(pending_leave_query)
    total_candidates = await db.candidates.count_documents({})
    pending_candidates = await db.candidates.count_documents({"status": "pending"})
    exit_requests = await db.exit_requests.count_documents({"status": {"$in": ["pending", "approved"]}})
    now = datetime.now(timezone.utc)
    period = f"{now.year}-{now.month:02d}"
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
    # Recent attendance
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    att = await db.attendance_records.find({"date": today}).sort("punch_in_time", -1).to_list(5)
    for a in att:
        activities.append({
            "type": "attendance",
            "message": f"{a.get('employee_id')} punched in",
            "time": a.get("punch_in_time", ""),
        })
    # Recent leave applications
    leaves = await db.leave_applications.find({}).sort("applied_at", -1).to_list(5)
    for l in leaves:
        activities.append({
            "type": "leave",
            "message": f"{l.get('employee_id')} applied for {l.get('leave_type')} leave",
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
