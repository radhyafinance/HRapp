from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional, List
from database import db
from auth_utils import get_current_user
from datetime import datetime, timezone
from bson import ObjectId

router = APIRouter()


def perf_to_dict(p):
    p["id"] = str(p.pop("_id"))
    return p


class PerformanceCreate(BaseModel):
    employee_id: str
    review_period: str  # e.g., "H1-2025" or "H2-2024"
    year: int


class SelfAssessmentRequest(BaseModel):
    achievements: str
    challenges: str
    skills_developed: Optional[str] = None
    goals_next_period: str
    self_rating: int  # 1-5
    additional_comments: Optional[str] = None


class ManagerAssessmentRequest(BaseModel):
    performance_rating: int  # 1-5
    strengths: str
    areas_for_improvement: str
    manager_comments: str
    recommended_rating: str  # Exceptional / Exceeds Expectations / Meets Expectations / Needs Improvement


class ApproveReviewRequest(BaseModel):
    ctc_increase_percentage: float
    effective_date: str
    management_comments: Optional[str] = None


@router.post("")
async def create_review(data: PerformanceCreate, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    existing = await db.performance_reviews.find_one(
        {"employee_id": data.employee_id, "review_period": data.review_period}
    )
    if existing:
        raise HTTPException(status_code=400, detail="Review already exists for this period")
    emp = await db.employees.find_one({"employee_id": data.employee_id})
    if not emp:
        raise HTTPException(status_code=404, detail="Employee not found")
    doc = {
        "employee_id": data.employee_id,
        "employee_name": f"{emp.get('first_name', '')} {emp.get('last_name', '')}",
        "designation": emp.get("designation", ""),
        "department": emp.get("department", ""),
        "review_period": data.review_period,
        "year": data.year,
        "current_ctc_monthly": emp.get("salary", {}).get("gross", 0),
        "current_basic": emp.get("salary", {}).get("basic", 0),
        "self_assessment": None,
        "manager_assessment": None,
        "ctc_increase_percentage": None,
        "new_ctc_monthly": None,
        "effective_date": None,
        "status": "pending_self_assessment",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "created_by": current_user.get("employee_id"),
    }
    result = await db.performance_reviews.insert_one(doc)
    doc["id"] = str(result.inserted_id)
    doc.pop("_id", None)
    return doc


@router.get("")
async def list_reviews(
    year: int = None,
    review_period: str = None,
    current_user: dict = Depends(get_current_user),
):
    query = {}
    if current_user.get("role") in ["employee", "field_agent"]:
        query["employee_id"] = current_user.get("employee_id")
    if year:
        query["year"] = year
    if review_period:
        query["review_period"] = review_period
    reviews = await db.performance_reviews.find(query).sort("created_at", -1).to_list(500)
    return [perf_to_dict(r) for r in reviews]


@router.get("/my")
async def my_reviews(current_user: dict = Depends(get_current_user)):
    emp_id = current_user.get("employee_id")
    reviews = await db.performance_reviews.find({"employee_id": emp_id}).sort("created_at", -1).to_list(20)
    return [perf_to_dict(r) for r in reviews]


@router.put("/{review_id}/self-assessment")
async def submit_self_assessment(review_id: str, data: SelfAssessmentRequest, current_user: dict = Depends(get_current_user)):
    review = await db.performance_reviews.find_one({"_id": ObjectId(review_id)})
    if not review:
        raise HTTPException(status_code=404, detail="Review not found")
    if review["employee_id"] != current_user.get("employee_id") and current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Can only submit your own self-assessment")
    await db.performance_reviews.update_one(
        {"_id": ObjectId(review_id)},
        {"$set": {
            "self_assessment": data.model_dump(),
            "status": "pending_manager_review",
            "self_submitted_at": datetime.now(timezone.utc).isoformat(),
        }},
    )
    return {"message": "Self-assessment submitted"}


@router.put("/{review_id}/manager-assessment")
async def submit_manager_assessment(review_id: str, data: ManagerAssessmentRequest, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management", "managers"]:
        raise HTTPException(status_code=403, detail="Access denied")
    await db.performance_reviews.update_one(
        {"_id": ObjectId(review_id)},
        {"$set": {
            "manager_assessment": data.model_dump(),
            "status": "pending_approval",
            "manager_submitted_at": datetime.now(timezone.utc).isoformat(),
            "manager_id": current_user.get("employee_id"),
        }},
    )
    return {"message": "Manager assessment submitted"}


@router.put("/{review_id}/approve")
async def approve_review(review_id: str, data: ApproveReviewRequest, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    review = await db.performance_reviews.find_one({"_id": ObjectId(review_id)})
    if not review:
        raise HTTPException(status_code=404, detail="Not found")
    current_ctc = review.get("current_ctc_monthly", 0)
    increase_pct = data.ctc_increase_percentage
    new_ctc = round(current_ctc * (1 + increase_pct / 100), 2)
    await db.performance_reviews.update_one(
        {"_id": ObjectId(review_id)},
        {"$set": {
            "ctc_increase_percentage": increase_pct,
            "new_ctc_monthly": new_ctc,
            "effective_date": data.effective_date,
            "management_comments": data.management_comments,
            "status": "approved",
            "approved_at": datetime.now(timezone.utc).isoformat(),
            "approved_by": current_user.get("employee_id"),
        }},
    )
    return {"message": "Review approved", "new_ctc_monthly": new_ctc, "increase_percentage": increase_pct}


@router.get("/{review_id}")
async def get_review(review_id: str, current_user: dict = Depends(get_current_user)):
    review = await db.performance_reviews.find_one({"_id": ObjectId(review_id)})
    if not review:
        raise HTTPException(status_code=404, detail="Not found")
    return perf_to_dict(review)
