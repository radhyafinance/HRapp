from fastapi import APIRouter, HTTPException, Depends
from database import db
from auth_utils import get_current_user
from datetime import date

router = APIRouter()


def _parse_joining_date(value):
    """Parse joining_date robust to either pure ISO 'YYYY-MM-DD' or
    Excel-imported 'YYYY-MM-DD HH:MM:SS' / 'YYYY-MM-DDTHH:MM:SS' strings."""
    if not value:
        return None
    if not isinstance(value, str):
        return None
    cleaned = value.strip().split(" ")[0].split("T")[0]
    try:
        return date.fromisoformat(cleaned)
    except ValueError:
        return None


def _is_director(emp: dict) -> bool:
    return (emp.get("designation") or "").strip().lower() == "director"


@router.get("/{employee_id}")
async def calc_gratuity(employee_id: str, current_user: dict = Depends(get_current_user)):
    emp = await db.employees.find_one({"employee_id": employee_id})
    if not emp:
        raise HTTPException(status_code=404, detail="Employee not found")
    joining_date_str = emp.get("joining_date", "")
    if not joining_date_str:
        raise HTTPException(status_code=400, detail="Joining date not set")
    today = date.today()
    joining_date = _parse_joining_date(joining_date_str)
    if not joining_date:
        raise HTTPException(status_code=400, detail=f"Invalid joining date format: '{joining_date_str}'")
    total_days = (today - joining_date).days
    years_of_service = total_days / 365.25
    basic = emp.get("salary", {}).get("basic", 0)
    is_director = _is_director(emp)
    eligible = years_of_service >= 5 and not is_director
    gratuity_amount = round((basic * 15 * years_of_service) / 26, 2) if eligible else 0
    monthly_provision = 0 if is_director else round((basic * 15) / (26 * 12), 2)
    return {
        "employee_id": employee_id,
        "employee_name": f"{emp.get('first_name', '')} {emp.get('last_name', '')}",
        "designation": emp.get("designation", ""),
        "joining_date": joining_date_str,
        "as_of_date": today.isoformat(),
        "years_of_service": round(years_of_service, 2),
        "eligible": eligible,
        "last_basic_salary": basic,
        "gratuity_amount": gratuity_amount,
        "monthly_provision": monthly_provision,
        "formula": "Basic × 15 × Years / 26",
        "note": (
            "Directors are not eligible for gratuity per company policy."
            if is_director else
            "Minimum 5 years of continuous service required for eligibility (except death during service)"
        ),
    }


@router.get("")
async def all_gratuity(current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    employees = await db.employees.find({"status": {"$in": ["active", "probation"]}}).to_list(1000)
    today = date.today()
    result = []
    for emp in employees:
        joining_date_str = emp.get("joining_date", "")
        if not joining_date_str:
            continue
        try:
            jd = _parse_joining_date(joining_date_str)
            if not jd:
                continue
            years = (today - jd).days / 365.25
            basic = emp.get("salary", {}).get("basic", 0)
            is_director = _is_director(emp)
            eligible = years >= 5 and not is_director
            gratuity = round((basic * 15 * years) / 26, 2) if eligible else 0
            monthly = 0 if is_director else round((basic * 15) / (26 * 12), 2)
            result.append({
                "employee_id": emp.get("employee_id"),
                "name": f"{emp.get('first_name', '')} {emp.get('last_name', '')}",
                "designation": emp.get("designation", ""),
                "joining_date": joining_date_str,
                "years_of_service": round(years, 2),
                "eligible": eligible,
                "gratuity_amount": gratuity,
                "monthly_provision": monthly,
                "is_director": is_director,
            })
        except Exception:
            continue
    return result
