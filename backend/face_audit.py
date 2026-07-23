"""Face-check audit — READ ONLY. Writes nothing, changes nothing.

Answers one question: when the face check flags a punch, is it because the two
faces were compared and differed, or because no face was ever found in the selfie?

Those are completely different problems. A real mismatch is a threshold/model
question. "No face detected" is a *detector* failure -- nothing was compared, so
no threshold change can help it.

Two ways to run it, sharing one implementation so they cannot disagree:

  1. As a script, against whatever database the .env points at:

         cd backend && python face_audit.py 90

  2. As an HR-Admin-only endpoint, which is how you reach PRODUCTION data --
     the preview environment has its own database, so its attendance history is
     not the real one:

         https://hr.radhyafinance.com/api/face-audit?days=90&format=text

     Log in as HR Admin in the same browser first.

This is a temporary diagnostic. To remove it: delete this file and the two
`face_audit` lines in server.py.
"""
import asyncio
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import PlainTextResponse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from auth_utils import get_current_user  # noqa: E402
from database import db  # noqa: E402

router = APIRouter()

# Mirrors services.face_match.DEFAULT_TOLERANCE. Held here rather than imported
# so the script still runs on a machine where dlib is not installed.
TOLERANCE = 0.60


# ── data ─────────────────────────────────────────────────────────────────────
async def collect(days: int) -> list:
    """Every punch in the window that had a face check. Read-only."""
    today_ist = (datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)).date()
    since = (today_ist - timedelta(days=max(1, days))).isoformat()

    # Only the fields needed. Attendance records carry base64 selfies inline, so
    # an unprojected read of a few thousand rows would be gigabytes.
    proj = {
        "_id": 0, "employee_id": 1, "date": 1,
        "punch_in_face_matched": 1, "punch_in_face_distance": 1, "punch_in_face_warning": 1,
        "punch_out_face_matched": 1, "punch_out_face_distance": 1, "punch_out_face_warning": 1,
    }
    rows = await db.attendance_records.find({"date": {"$gte": since}}, proj).to_list(100000)

    punches = []
    for r in rows:
        for side in ("in", "out"):
            matched = r.get(f"punch_{side}_face_matched")
            if matched is None and r.get(f"punch_{side}_face_distance") is None \
                    and not r.get(f"punch_{side}_face_warning"):
                continue          # no punch on this side, or the check never ran
            punches.append({
                "employee_id": r.get("employee_id"),
                "date": r.get("date"),
                "side": side,
                "matched": matched,
                "distance": r.get(f"punch_{side}_face_distance"),
                "warning": r.get(f"punch_{side}_face_warning"),
            })
    return punches


# ── analysis (pure -- no database, no printing) ──────────────────────────────
def _kind(msg):
    """Collapse the embedded distance so all "Face match weak" rows group as one."""
    return re.sub(r"\(distance [0-9.]+\)", "(distance N)", msg or "")


def analyse(punches: list, tolerance: float = TOLERANCE) -> dict:
    if not punches:
        return {"total": 0}

    ok      = [p for p in punches if p["matched"] is True]
    flagged = [p for p in punches if p["matched"] is False]
    unknown = [p for p in punches if p["matched"] is None]
    # THE KEY SPLIT: a flagged punch with no distance was never compared.
    no_face = [p for p in flagged if p["distance"] is None]
    real_mm = [p for p in flagged if p["distance"] is not None]

    per_emp = defaultdict(lambda: {"total": 0, "no_face": 0, "mismatch": 0})
    for p in punches:
        e = per_emp[p["employee_id"]]
        e["total"] += 1
        if p["matched"] is False:
            e["no_face" if p["distance"] is None else "mismatch"] += 1

    buckets = Counter()
    for p in real_mm:
        buckets[min(int(float(p["distance"]) * 20) / 20, 0.95)] += 1

    matched_d = sorted(float(p["distance"]) for p in ok if p["distance"] is not None)
    mm_d = sorted(float(p["distance"]) for p in real_mm)

    def stats(v):
        if not v:
            return None
        return {"n": len(v), "min": round(min(v), 3), "max": round(max(v), 3),
                "mean": round(sum(v) / len(v), 3),
                "median": round(v[len(v) // 2], 3)}

    worst = sorted(
        ({"employee_id": k, **v,
          "flag_rate": round(100 * (v["no_face"] + v["mismatch"]) / v["total"])}
         for k, v in per_emp.items() if v["no_face"] + v["mismatch"]),
        key=lambda d: -(d["no_face"] + d["mismatch"]))

    return {
        "tolerance": tolerance,
        "total": len(punches),
        "matched": len(ok),
        "flagged": len(flagged),
        "unverified_unflagged": len(unknown),
        "no_face_detected": len(no_face),
        "actually_compared": len(real_mm),
        "distance_buckets": {f"{e:.2f}-{e+0.05:.2f}": n for e, n in sorted(buckets.items())},
        "near_threshold": sum(1 for p in real_mm
                              if tolerance <= float(p["distance"]) < tolerance + 0.05),
        "matched_distances": stats(matched_d),
        "flagged_distances": stats(mm_d),
        "ranges_overlap": bool(matched_d and mm_d and max(matched_d) > min(mm_d)),
        "employees_total": len(per_emp),
        "employees_affected": len(worst),
        "worst_employees": worst[:20],
        "reasons": dict(Counter(_kind(p["warning"])
                                for p in flagged if p["warning"]).most_common(10)),
    }


# ── human-readable rendering ─────────────────────────────────────────────────
def _bar(n, total, width=40):
    if not total:
        return ""
    filled = int(round(width * n / total))
    return "#" * filled + "." * (width - filled)


def render(rep: dict, days: int) -> str:
    if not rep.get("total"):
        return f"No face-check data in the last {days} days. Nothing to report."

    t = rep["total"]
    L = ["=" * 66, f"FACE CHECK AUDIT — last {days} days", "=" * 66,
         "", f"Punches with a face check: {t}", ""]
    for label, n in (("Matched", rep["matched"]), ("Flagged", rep["flagged"]),
                     ("Unverified (no flag)", rep["unverified_unflagged"])):
        L.append(f"  {label:<22}{n:>6}  {100*n/t:5.1f}%  {_bar(n, t)}")
    if rep["unverified_unflagged"]:
        L += ["     ^ timeouts / errors. These are NOT flagged in the UI, so nobody",
              "       reviews them — an unverified punch that looks verified."]

    f = rep["flagged"]
    L += ["", f"--- Of the {f} flagged punches ---", ""]
    if not f:
        L += ["  No flags at all in this window.", "=" * 66]
        return "\n".join(L)
    L += [f"  NO FACE DETECTED      {rep['no_face_detected']:>6}  "
          f"{100*rep['no_face_detected']/f:5.1f}%  {_bar(rep['no_face_detected'], f)}",
          "     ^ never compared. A detector failure, not a mismatch.",
          "       No threshold or recognition-model change can fix these.",
          f"  Actually compared     {rep['actually_compared']:>6}  "
          f"{100*rep['actually_compared']/f:5.1f}%  {_bar(rep['actually_compared'], f)}"]

    if rep["distance_buckets"]:
        c = rep["actually_compared"]
        L += ["", f"--- Distance distribution ({c} compared, tolerance {rep['tolerance']}) ---", ""]
        for rng, n in rep["distance_buckets"].items():
            lo = float(rng.split("-")[0])
            mark = ("  <-- just over the line"
                    if rep["tolerance"] <= lo < rep["tolerance"] + 0.10 else "")
            L.append(f"  {rng}  {n:>5}  {_bar(n, c, 30)}{mark}")
        L += ["", f"  Within 0.05 of the threshold: {rep['near_threshold']} "
                  f"({100*rep['near_threshold']/c:.1f}% of compared)"]

    md, fd = rep["matched_distances"], rep["flagged_distances"]
    if md and fd:
        L += ["", "--- Separation ---", "",
              f"  Matched  n={md['n']:<6} min={md['min']:.3f}  median={md['median']:.3f}  max={md['max']:.3f}",
              f"  Flagged  n={fd['n']:<6} min={fd['min']:.3f}  median={fd['median']:.3f}  max={fd['max']:.3f}"]
        L.append("  Ranges OVERLAP — no single threshold separates them. Points at the model."
                 if rep["ranges_overlap"] else
                 "  Ranges are cleanly separated — the threshold is doing its job.")

    L += ["", "--- Who is affected ---", "",
          f"  {rep['employees_affected']} of {rep['employees_total']} employees have at least one flag.",
          "",
          f"  {'Employee':<12}{'punches':>9}{'no-face':>9}{'mismatch':>10}{'flag rate':>11}"]
    for e in rep["worst_employees"]:
        L.append(f"  {e['employee_id']:<12}{e['total']:>9}{e['no_face']:>9}"
                 f"{e['mismatch']:>10}{e['flag_rate']:>10}%")
    L += ["", "  Concentrated on a few people => their REFERENCE PHOTO is the problem.",
          "  Spread evenly across everyone => the DETECTOR is the problem."]

    L += ["", "--- Reasons given ---", ""]
    for reason, n in rep["reasons"].items():
        L.append(f"  {n:>5}  {reason[:80]}")
    L.append("=" * 66)
    return "\n".join(L)


# ── endpoint: the only way to see PRODUCTION data ────────────────────────────
@router.get("/face-audit")
async def face_audit_endpoint(days: int = 90, format: str = "text",
                              current_user: dict = Depends(get_current_user)):
    """Read-only. HR Admin / Management only.

    `format=text` renders the same report the CLI prints, so it is readable
    straight in a browser tab. Anything else returns the raw JSON.
    """
    if current_user.get("role") not in ("hr_admin", "management"):
        raise HTTPException(status_code=403, detail="HR Admin only")
    days = max(1, min(days, 730))
    rep = analyse(await collect(days))
    if format == "text":
        return PlainTextResponse(render(rep, days))
    return {"days": days, **rep}


# ── CLI ──────────────────────────────────────────────────────────────────────
async def _main():
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 90
    punches = await collect(days)
    print(render(analyse(punches), days))
    if punches:
        out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "face_audit.csv")
        with open(out, "w") as fh:
            fh.write("employee_id,date,side,matched,distance,warning\n")
            for p in punches:
                w = (p["warning"] or "").replace(",", ";").replace("\n", " ")
                fh.write(f'{p["employee_id"]},{p["date"]},{p["side"]},{p["matched"]},'
                         f'{p["distance"] if p["distance"] is not None else ""},"{w}"\n')
        print(f"\nRow-level detail written to {out}")


if __name__ == "__main__":
    asyncio.run(_main())
