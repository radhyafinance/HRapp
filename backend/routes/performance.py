"""Performance Management System.

Two instruments, mirroring the FY26 appraisal workbooks:

  * PE grid   -- role-specific weighted parameters summing to 100. Everyone gets one.
  * Narrative -- 7 questions, self answer + 1-5 rating, manager comment + 1-5 rating.
                 EVERYONE answers these. Q7 differs field vs head-office. (The FOs'
                 copies were on paper -- the scanned "FO Self" forms -- which is why
                 they have no tab in the assessment workbook.)

The Field Officer form is BILINGUAL: every parameter and question carries a Hindi
twin shown under the English, because that is the language the FOs actually filled
their paper forms in.

VISIBILITY: the reporting manager's scores, comments, grade and notes are for HR,
management and the manager who wrote them. An employee sees their own answers and,
once assessed, only that the review is Completed -- see _redact().

The GRADE comes from the REPORTING MANAGER's total only, never the average of self
and manager. In the source workbooks every single employee self-scored 100/100, so
averaging inflated every grade by ~20 points (a manager score of 58 -- "Good" --
became 79, "Very Good"). The sheet's own grade formula quietly read the manager
column for exactly this reason; the "Avg. of Assessment" column it displayed was
never used. Self scores are captured and shown, but they do not move the grade.

Eligibility follows policy 7.2 and decides who gets a form at all:
  H2 (Oct-Mar), reviewed in April:   joined <= 30 Sep -> full | 1 Oct-31 Dec -> pro-rata | after -> none
  H1 (Apr-Sep), reviewed in October: joined <= 31 Mar -> full | 1 Apr-30 Jun -> pro-rata | after -> none
The band is stored on the review so the increment step can use it later.
"""

import calendar as _cal
from datetime import date, datetime, timezone
from typing import List, Optional

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth_utils import get_current_user
from database import db
from services.pe_templates import (NARRATIVE_QUESTIONS, NARRATIVE_QUESTIONS_HI,
                                   PE_TEMPLATES, grade_for)

router = APIRouter()

_TEMPLATE_BY_KEY = {t["key"]: t for t in PE_TEMPLATES}
# (designation, department) -> template. Built once; the seed asserts no collisions.
_TEMPLATE_BY_ROLE = {
    (a["designation"], a["department"]): t
    for t in PE_TEMPLATES for a in t["applies_to"]
}

# Employees who get a review. Exiting staff are left out: the forms feed increments,
# which someone on their way out will not receive.
_REVIEWABLE = ["active", "probation"]

HALVES = {
    # half: (start_month, label_fmt) -- H1 is Apr-Sep, H2 is Oct-Mar (spans new year)
    "H1": 4,
    "H2": 10,
}


def _admin(user: dict):
    if user.get("role") not in ("hr_admin", "management"):
        raise HTTPException(status_code=403, detail="Access denied")


def pe_to_dict(p: dict) -> dict:
    p["id"] = str(p.pop("_id"))
    return p


def template_for(emp: dict) -> Optional[dict]:
    """Resolve an employee's PE template.

    An explicit pe_template_key on the employee wins -- that is the escape hatch for
    roles the designation list cannot express. Otherwise match on (designation,
    department); designation alone is ambiguous (two "Assistant Manager"s in
    different functions need different forms).
    """
    key = (emp.get("pe_template_key") or "").strip()
    if key:
        return _TEMPLATE_BY_KEY.get(key)
    return _TEMPLATE_BY_ROLE.get(
        ((emp.get("designation") or "").strip(), (emp.get("department") or "").strip())
    )


def cycle_dates(half: str, year: int) -> tuple:
    """(start, end, prorata_cutoff) for a cycle.

    `year` is the calendar year the cycle STARTS in, so H2/2025 is Oct-25 to Mar-26.
    The pro-rata cutoff is the last day of the cycle's third month (31 Dec / 30 Jun).
    """
    if half not in HALVES:
        raise HTTPException(status_code=400, detail="Half must be H1 or H2")
    m = HALVES[half]
    start = date(year, m, 1)
    end_m, end_y = (m + 5, year) if m == 4 else (3, year + 1)
    end = date(end_y, end_m, _cal.monthrange(end_y, end_m)[1])
    cut_m, cut_y = (m + 2, year) if m == 4 else (12, year)
    cutoff = date(cut_y, cut_m, _cal.monthrange(cut_y, cut_m)[1])
    return start, end, cutoff


def eligibility_for(doj_str: str, half: str, year: int) -> tuple:
    """(band, reason) per policy 7.2. band is 'full' | 'pro_rata' | None."""
    start, _end, cutoff = cycle_dates(half, year)
    try:
        doj = date.fromisoformat(str(doj_str)[:10])
    except Exception:
        return None, "No valid joining date on record"
    if doj < start:
        return "full", f"Joined {doj:%d %b %Y}, before the cycle began"
    if doj <= cutoff:
        return "pro_rata", f"Joined {doj:%d %b %Y}, within the first half of the cycle"
    return None, f"Joined {doj:%d %b %Y}, after {cutoff:%d %b %Y} — not eligible this cycle"


def period_of(half: str, year: int) -> str:
    return f"{half}-{year}"


def label_of(half: str, year: int) -> str:
    start, end, _ = cycle_dates(half, year)
    return f"{start:%b %y} - {end:%b %y}"


async def _plan(half: str, year: int) -> dict:
    """Work out who is in this cycle and who is not, and why. Never silent."""
    employees = await db.employees.find({"status": {"$in": _REVIEWABLE}}).to_list(2000)
    included, excluded = [], []
    for emp in sorted(employees, key=lambda e: e.get("employee_id") or ""):
        name = f"{emp.get('first_name') or ''} {emp.get('last_name') or ''}".strip()
        row = {
            "employee_id": emp.get("employee_id"),
            "name": name,
            "designation": emp.get("designation") or "",
            "department": emp.get("department") or "",
        }
        band, reason = eligibility_for(emp.get("joining_date"), half, year)
        if not band:
            excluded.append({**row, "reason": reason})
            continue
        tpl = template_for(emp)
        if not tpl:
            excluded.append({**row, "reason":
                             f"No PE template for {row['designation'] or '(no designation)'}"
                             f" in {row['department'] or '(no department)'}"})
            continue
        included.append({**row, "eligibility": band, "eligibility_reason": reason,
                         "template_key": tpl["key"], "template_name": tpl["name"],
                         "reporting_to": emp.get("reporting_to") or ""})
    return {"included": included, "excluded": excluded}


# ── templates ────────────────────────────────────────────────────────────────
@router.get("/templates")
async def list_templates(current_user: dict = Depends(get_current_user)):
    _admin(current_user)
    return [{"key": t["key"], "name": t["name"], "narrative": t["narrative"],
             "applies_to": t["applies_to"], "parameter_count": len(t["parameters"]),
             "parameters": t["parameters"]} for t in PE_TEMPLATES]


# ── cycles ───────────────────────────────────────────────────────────────────
class CycleRequest(BaseModel):
    half: str          # H1 | H2
    year: int          # calendar year the cycle starts in (H2/2025 = Oct25-Mar26)


def _review_doc(row: dict, period: str, half: str, year: int, now: str, user: dict) -> dict:
    """Build one blank review.

    The template is SNAPSHOT in here rather than referenced. Editing a template later
    must not retroactively rewrite the weights a past appraisal was already graded on.
    """
    tpl = _TEMPLATE_BY_KEY[row["template_key"]]
    return {
        "period": period, "label": label_of(half, year),
        "half": half, "year": year,
        "employee_id": row["employee_id"], "employee_name": row["name"],
        "designation": row["designation"], "department": row["department"],
        "reporting_to": row["reporting_to"],
        "template_key": tpl["key"], "template_name": tpl["name"],
        "narrative_variant": tpl["narrative"],
        "bilingual": bool(tpl.get("bilingual")),
        "parameters": [{**p, "self_score": None, "manager_score": None}
                       for p in tpl["parameters"]],
        "narrative": [{"seq": i + 1, "question": q,
                       # Hindi twin, only on bilingual templates (Field Officers).
                       "question_hi": (NARRATIVE_QUESTIONS_HI.get(tpl["narrative"]) or [None] * 9)[i]
                                      if tpl.get("bilingual") else None,
                       "self_answer": None, "self_rating": None,
                       "manager_comment": None, "manager_rating": None}
                      for i, q in enumerate(NARRATIVE_QUESTIONS[tpl["narrative"]])]
        if tpl["narrative"] else [],
        "eligibility": row["eligibility"], "eligibility_reason": row["eligibility_reason"],
        "self_total": None, "manager_total": None, "grade": None, "grade_level": None,
        "status": "pending_self",
        "review_details": {},
        "created_at": now, "created_by": user.get("employee_id"),
    }


@router.get("/cycles")
async def list_cycles(current_user: dict = Depends(get_current_user)):
    _admin(current_user)
    cycles = await db.pe_cycles.find().sort("created_at", -1).to_list(50)
    out = []
    for c in cycles:
        c["id"] = str(c.pop("_id"))
        c["review_count"] = await db.pe_reviews.count_documents({"period": c["period"]})
        c["completed_count"] = await db.pe_reviews.count_documents(
            {"period": c["period"], "status": "completed"})
        out.append(c)
    return out


@router.post("/cycles/preview")
async def preview_cycle(data: CycleRequest, current_user: dict = Depends(get_current_user)):
    """Dry run. Shows exactly who would get a form and who would not, before anything
    is written. Run this first -- it is how you catch a missing template or a wrong
    designation while it is still free to fix."""
    _admin(current_user)
    plan = await _plan(data.half, data.year)
    return {"period": period_of(data.half, data.year),
            "label": label_of(data.half, data.year), **plan,
            "included_count": len(plan["included"]), "excluded_count": len(plan["excluded"])}


@router.post("/cycles")
async def open_cycle(data: CycleRequest, current_user: dict = Depends(get_current_user)):
    """Open a cycle and create a review for every eligible employee."""
    _admin(current_user)
    period = period_of(data.half, data.year)
    if await db.pe_cycles.find_one({"period": period}):
        raise HTTPException(status_code=400, detail=f"Cycle {period} already exists")

    start, end, _cut = cycle_dates(data.half, data.year)
    plan = await _plan(data.half, data.year)
    now = datetime.now(timezone.utc).isoformat()

    for row in plan["included"]:
        await db.pe_reviews.insert_one(
            _review_doc(row, period, data.half, data.year, now, current_user))

    await db.pe_cycles.insert_one({
        "period": period, "label": label_of(data.half, data.year),
        "half": data.half, "year": data.year,
        "start_date": start.isoformat(), "end_date": end.isoformat(),
        "status": "open",
        "excluded": plan["excluded"],   # kept so the omissions stay auditable
        "created_at": now, "created_by": current_user.get("employee_id"),
    })
    return {"period": period, "created": len(plan["included"]),
            "excluded": plan["excluded"], "excluded_count": len(plan["excluded"])}


@router.post("/cycles/{period}/sync")
async def sync_cycle(period: str, current_user: dict = Depends(get_current_user)):
    """Add forms for anyone eligible who hasn't got one in an already-open cycle.

    Needed because a cycle is a snapshot of a moving org: someone joins, a wrong
    designation gets corrected, a missing template gets added. Without this the only
    way to pick them up would be to delete the cycle and start again, throwing away
    everyone else's work.

    Purely additive and safe to re-run: existing reviews are never touched, so no
    self-assessment or score can be lost. Anyone still not eligible, or still with no
    template, comes back in `excluded` with the reason.
    """
    _admin(current_user)
    cycle = await db.pe_cycles.find_one({"period": period})
    if not cycle:
        raise HTTPException(status_code=404, detail="Cycle not found")

    plan = await _plan(cycle["half"], cycle["year"])
    have = {r["employee_id"] for r in
            await db.pe_reviews.find({"period": period}, {"employee_id": 1, "_id": 0}).to_list(2000)}
    now = datetime.now(timezone.utc).isoformat()

    added = []
    for row in plan["included"]:
        if row["employee_id"] in have:
            continue                      # never touch a review that already exists
        await db.pe_reviews.insert_one(
            _review_doc(row, period, cycle["half"], cycle["year"], now, current_user))
        added.append({"employee_id": row["employee_id"], "name": row["name"],
                      "template_name": row["template_name"]})

    await db.pe_cycles.update_one({"period": period}, {"$set": {
        "excluded": plan["excluded"],
        "last_synced_at": now,
        "last_synced_by": current_user.get("employee_id"),
    }})
    return {"period": period, "added": len(added), "added_employees": added,
            "excluded": plan["excluded"], "excluded_count": len(plan["excluded"])}


@router.post("/cycles/{period}/close")
async def close_cycle(period: str, current_user: dict = Depends(get_current_user)):
    _admin(current_user)
    res = await db.pe_cycles.update_one({"period": period}, {"$set": {
        "status": "closed", "closed_at": datetime.now(timezone.utc).isoformat()}})
    if not res.matched_count:
        raise HTTPException(status_code=404, detail="Cycle not found")
    return {"period": period, "status": "closed"}


@router.delete("/cycles/{period}")
async def delete_cycle(period: str, current_user: dict = Depends(get_current_user)):
    """Delete a cycle and its reviews. Refused the moment ANYONE has filled anything in.

    A self-assessment is 14 scores and 7 written answers -- as much real work as the
    manager's half, and just as gone if this runs. Guarding only the manager's input
    would protect the wrong person. To add people to a live cycle use /sync; it is
    additive and destroys nothing.
    """
    _admin(current_user)
    started = await db.pe_reviews.count_documents(
        {"period": period, "$or": [{"self_total": {"$ne": None}},
                                   {"manager_total": {"$ne": None}}]})
    if started:
        raise HTTPException(
            status_code=400,
            detail=f"{started} review(s) have already been filled in. Deleting would "
                   f"destroy that work. Use Sync to add missing people, or close the cycle.")
    r = await db.pe_reviews.delete_many({"period": period})
    await db.pe_cycles.delete_one({"period": period})
    return {"period": period, "deleted": r.deleted_count}


# ── reviews ──────────────────────────────────────────────────────────────────
@router.get("")
async def list_reviews(period: str = None, employee_id: str = None,
                       current_user: dict = Depends(get_current_user)):
    query = {}
    if period:
        query["period"] = period
    role = current_user.get("role")
    if role not in ("hr_admin", "management"):
        query["employee_id"] = current_user.get("employee_id")
    elif employee_id:
        query["employee_id"] = employee_id
    rows = await db.pe_reviews.find(query).sort([("period", -1), ("employee_id", 1)]).to_list(1000)
    return [_redact(pe_to_dict(r), current_user) for r in rows]


@router.get("/my")
async def my_reviews(current_user: dict = Depends(get_current_user)):
    rows = await db.pe_reviews.find(
        {"employee_id": current_user.get("employee_id")}).sort("period", -1).to_list(20)
    return [_redact(pe_to_dict(r), current_user) for r in rows]


@router.get("/to-review")
async def to_review(current_user: dict = Depends(get_current_user)):
    """Reviews waiting on me as the reporting manager."""
    rows = await db.pe_reviews.find({
        "reporting_to": current_user.get("employee_id"),
        "status": {"$in": ["pending_manager", "pending_self"]},
    }).sort("period", -1).to_list(200)
    return [_redact(pe_to_dict(r), current_user) for r in rows]


def _redact(review: dict, user: dict) -> dict:
    """Strip the manager's scoring before an employee sees their own review.

    The reporting manager's scores, comments, grade and notes are for management and
    HR only. The employee keeps everything they wrote themselves; once assessed they
    see only that the review is Completed. The manager who wrote it still sees it, as
    do HR/management.
    """
    if user.get("role") in ("hr_admin", "management"):
        return review
    if review.get("reporting_to") == user.get("employee_id"):
        # The manager sees their report's review -- but NOT an unsubmitted draft. Until
        # the employee submits, what they have typed is their own business; "Save draft"
        # must not quietly publish half-written answers to their boss.
        if review.get("status") == "pending_self":
            review.pop("self_total", None)
            for p in review.get("parameters", []):
                p.pop("self_score", None)
            for n in review.get("narrative", []):
                n.pop("self_answer", None)
                n.pop("self_rating", None)
        return review              # otherwise: the author of the assessment sees all
    for k in ("manager_total", "grade", "grade_level", "review_details",
              "manager_submitted_at"):
        review.pop(k, None)
    for p in review.get("parameters", []):
        p.pop("manager_score", None)
    for n in review.get("narrative", []):
        n.pop("manager_comment", None)
        n.pop("manager_rating", None)
    return review


def _can_see(review: dict, user: dict) -> bool:
    if user.get("role") in ("hr_admin", "management"):
        return True
    me = user.get("employee_id")
    return review.get("employee_id") == me or review.get("reporting_to") == me


@router.get("/{review_id}")
async def get_review(review_id: str, current_user: dict = Depends(get_current_user)):
    r = await db.pe_reviews.find_one({"_id": ObjectId(review_id)})
    if not r:
        raise HTTPException(status_code=404, detail="Not found")
    if not _can_see(r, current_user):
        raise HTTPException(status_code=403, detail="Access denied")
    return _redact(pe_to_dict(r), current_user)


class ParamScore(BaseModel):
    seq: int
    score: float


class NarrativeSelf(BaseModel):
    seq: int
    answer: str
    rating: int


class SelfSubmit(BaseModel):
    scores: List[ParamScore]
    narrative: Optional[List[NarrativeSelf]] = None


class NarrativeManager(BaseModel):
    seq: int
    comment: str
    rating: int


class ManagerSubmit(BaseModel):
    scores: List[ParamScore]
    narrative: Optional[List[NarrativeManager]] = None
    area_of_improvement: Optional[str] = None
    special_recommendations: Optional[str] = None
    remarks: Optional[str] = None


def _apply_scores(review: dict, scores: List[ParamScore], field: str) -> float:
    """Write scores onto the snapshot parameters, capped at each parameter's weight.

    The workbooks had no such cap -- nothing stopped a 20 going into a parameter
    worth 5, which silently breaks the out-of-100 total the grade depends on.
    """
    by_seq = {s.seq: s.score for s in scores}
    missing = [p["seq"] for p in review["parameters"] if p["seq"] not in by_seq]
    if missing:
        raise HTTPException(status_code=400,
                            detail=f"Score every parameter — missing {sorted(missing)}")
    total = 0.0
    for p in review["parameters"]:
        v = float(by_seq[p["seq"]])
        if v < 0 or v > p["weight"]:
            raise HTTPException(
                status_code=400,
                detail=f"'{p['name']}' is out of {p['weight']} — {v:g} is not a valid score.")
        p[field] = v
        total += v
    return round(total, 2)


class DraftSubmit(BaseModel):
    mode: str                                   # self | manager
    scores: Optional[List[ParamScore]] = None
    narrative: Optional[List[dict]] = None


@router.put("/{review_id}/draft")
async def save_draft(review_id: str, data: DraftSubmit,
                     current_user: dict = Depends(get_current_user)):
    """Save a part-finished form without submitting it.

    Deliberately does NOT validate or change status: a draft is allowed to be blank,
    incomplete, or over-weight. Validation belongs at submit. Someone writing seven
    answers should be able to stop halfway and come back, not lose the lot.
    """
    r = await db.pe_reviews.find_one({"_id": ObjectId(review_id)})
    if not r:
        raise HTTPException(status_code=404, detail="Not found")
    me = current_user.get("employee_id")
    is_admin = current_user.get("role") in ("hr_admin", "management")
    if data.mode == "self":
        if r["employee_id"] != me and not is_admin:
            raise HTTPException(status_code=403, detail="You can only edit your own form")
        if r.get("manager_total") is not None:
            raise HTTPException(status_code=400, detail="Already assessed — this can no longer be changed.")
        sfield, tfield, rfield = "self_score", "self_answer", "self_rating"
    elif data.mode == "manager":
        if r.get("reporting_to") != me and not is_admin:
            raise HTTPException(status_code=403, detail="Only their reporting manager can assess them")
        sfield, tfield, rfield = "manager_score", "manager_comment", "manager_rating"
    else:
        raise HTTPException(status_code=400, detail="mode must be 'self' or 'manager'")

    by_seq = {s.seq: s.score for s in (data.scores or [])}
    for p in r["parameters"]:
        if p["seq"] in by_seq and by_seq[p["seq"]] is not None:
            p[sfield] = by_seq[p["seq"]]
    nby = {n.get("seq"): n for n in (data.narrative or [])}
    for item in r.get("narrative") or []:
        got = nby.get(item["seq"])
        if not got:
            continue
        if got.get("text") is not None:
            item[tfield] = got["text"]
        if got.get("rating"):
            item[rfield] = got["rating"]

    await db.pe_reviews.update_one({"_id": r["_id"]}, {"$set": {
        "parameters": r["parameters"], "narrative": r.get("narrative") or [],
        "draft_saved_at": datetime.now(timezone.utc).isoformat(),
        "draft_saved_by": me,
    }})
    return {"saved": True, "saved_at": datetime.now(timezone.utc).isoformat()}


@router.put("/{review_id}/self")
async def submit_self(review_id: str, data: SelfSubmit,
                      current_user: dict = Depends(get_current_user)):
    r = await db.pe_reviews.find_one({"_id": ObjectId(review_id)})
    if not r:
        raise HTTPException(status_code=404, detail="Not found")
    if r["employee_id"] != current_user.get("employee_id") and \
            current_user.get("role") not in ("hr_admin", "management"):
        raise HTTPException(status_code=403, detail="You can only fill your own self-assessment")
    if r.get("manager_total") is not None:
        raise HTTPException(status_code=400,
                            detail="Your manager has already assessed this — it can no longer be changed.")

    total = _apply_scores(r, data.scores, "self_score")
    narrative = r.get("narrative") or []
    if narrative:
        by_seq = {n.seq: n for n in (data.narrative or [])}
        for item in narrative:
            got = by_seq.get(item["seq"])
            if not got or not (got.answer or "").strip():
                raise HTTPException(status_code=400,
                                    detail=f"Answer question {item['seq']} before submitting.")
            if not 1 <= got.rating <= 5:
                raise HTTPException(status_code=400, detail="Ratings must be between 1 and 5.")
            item["self_answer"] = got.answer.strip()
            item["self_rating"] = got.rating

    await db.pe_reviews.update_one({"_id": r["_id"]}, {"$set": {
        "parameters": r["parameters"], "narrative": narrative,
        "self_total": total, "status": "pending_manager",
        "self_submitted_at": datetime.now(timezone.utc).isoformat(),
    }})
    return {"self_total": total, "status": "pending_manager"}


@router.put("/{review_id}/manager")
async def submit_manager(review_id: str, data: ManagerSubmit,
                         current_user: dict = Depends(get_current_user)):
    """The reporting manager's assessment. This is what sets the grade."""
    r = await db.pe_reviews.find_one({"_id": ObjectId(review_id)})
    if not r:
        raise HTTPException(status_code=404, detail="Not found")
    is_admin = current_user.get("role") in ("hr_admin", "management")
    if r.get("reporting_to") != current_user.get("employee_id") and not is_admin:
        raise HTTPException(status_code=403,
                            detail="Only this employee's reporting manager can assess them")

    total = _apply_scores(r, data.scores, "manager_score")
    narrative = r.get("narrative") or []
    if narrative:
        by_seq = {n.seq: n for n in (data.narrative or [])}
        for item in narrative:
            got = by_seq.get(item["seq"])
            if not got or not (got.comment or "").strip():
                raise HTTPException(status_code=400,
                                    detail=f"Comment on question {item['seq']} before submitting.")
            if not 1 <= got.rating <= 5:
                raise HTTPException(status_code=400, detail="Ratings must be between 1 and 5.")
            item["manager_comment"] = got.comment.strip()
            item["manager_rating"] = got.rating

    # Grade off the manager total ONLY -- see the module docstring.
    grade, level = grade_for(total)
    reviewer = await db.employees.find_one({"employee_id": current_user.get("employee_id")}) or {}
    await db.pe_reviews.update_one({"_id": r["_id"]}, {"$set": {
        "parameters": r["parameters"], "narrative": narrative,
        "manager_total": total, "grade": grade, "grade_level": level,
        "status": "completed",
        "review_details": {
            "reviewed_by": f"{reviewer.get('first_name','')} {reviewer.get('last_name','')}".strip()
                           or current_user.get("employee_id"),
            "reviewer_employee_id": current_user.get("employee_id"),
            "reviewer_designation": reviewer.get("designation", ""),
            "date": date.today().isoformat(),
            "area_of_improvement": (data.area_of_improvement or "").strip(),
            "special_recommendations": (data.special_recommendations or "").strip(),
            "remarks": (data.remarks or "").strip(),
        },
        "manager_submitted_at": datetime.now(timezone.utc).isoformat(),
    }})
    return {"manager_total": total, "grade": grade, "grade_level": level, "status": "completed"}
