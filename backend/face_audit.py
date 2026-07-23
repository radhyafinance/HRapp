"""Face-check audit — READ ONLY. Writes nothing, changes nothing.

Answers one question: when the face check flags a punch, is it because the two
faces were compared and differed, or because no face was ever found in the selfie?

Those are completely different problems. A real mismatch is a threshold/model
question. "No face detected" is a *detector* failure -- nothing was compared, so
no threshold change can help it.

Run from the backend directory:

    python face_audit.py            # last 90 days
    python face_audit.py 30         # last 30 days

Prints a summary; writes a CSV alongside it if pandas-free output is wanted.
"""
import asyncio
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from database import db  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))
DAYS = int(sys.argv[1]) if len(sys.argv) > 1 else 90

# Mirrors services.face_match.DEFAULT_TOLERANCE. Read rather than imported so the
# script does not need dlib present just to report numbers.
TOLERANCE = 0.60


def bar(n, total, width=40):
    if not total:
        return ""
    filled = int(round(width * n / total))
    return "#" * filled + "." * (width - filled)


async def main():
    today_ist = (datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)).date()
    since = (today_ist - timedelta(days=DAYS)).isoformat()

    # Only the fields needed. These records carry base64 photos; pulling whole
    # documents for a few thousand rows would be gigabytes.
    proj = {
        "_id": 0, "employee_id": 1, "date": 1,
        "punch_in_face_matched": 1, "punch_in_face_distance": 1, "punch_in_face_warning": 1,
        "punch_out_face_matched": 1, "punch_out_face_distance": 1, "punch_out_face_warning": 1,
    }
    rows = await db.attendance_records.find(
        {"date": {"$gte": since}}, proj
    ).to_list(100000)

    # Flatten to one entry per punch side.
    punches = []
    for r in rows:
        for side in ("in", "out"):
            matched = r.get(f"punch_{side}_face_matched")
            if matched is None and r.get(f"punch_{side}_face_distance") is None \
                    and not r.get(f"punch_{side}_face_warning"):
                continue          # no punch on this side, or check never ran
            punches.append({
                "employee_id": r.get("employee_id"),
                "date": r.get("date"),
                "side": side,
                "matched": matched,
                "distance": r.get(f"punch_{side}_face_distance"),
                "warning": r.get(f"punch_{side}_face_warning"),
            })

    if not punches:
        print(f"No face-check data in the last {DAYS} days. Nothing to report.")
        return

    ok        = [p for p in punches if p["matched"] is True]
    flagged   = [p for p in punches if p["matched"] is False]
    unknown   = [p for p in punches if p["matched"] is None]
    # THE KEY SPLIT: a flagged punch with no distance was never compared.
    no_face   = [p for p in flagged if p["distance"] is None]
    real_mm   = [p for p in flagged if p["distance"] is not None]
    total     = len(punches)

    print("=" * 66)
    print(f"FACE CHECK AUDIT — last {DAYS} days (since {since})")
    print("=" * 66)
    print(f"\nPunches with a face check: {total}\n")
    print(f"  Matched                {len(ok):>6}  {100*len(ok)/total:5.1f}%  {bar(len(ok), total)}")
    print(f"  Flagged                {len(flagged):>6}  {100*len(flagged)/total:5.1f}%  {bar(len(flagged), total)}")
    print(f"  Unverified (no flag)   {len(unknown):>6}  {100*len(unknown)/total:5.1f}%  {bar(len(unknown), total)}")
    if unknown:
        print("     ^ timeouts / errors. These are NOT flagged in the UI today,")
        print("       so nobody reviews them -- an unverified punch that looks verified.")

    print(f"\n--- Of the {len(flagged)} flagged punches ---\n")
    if flagged:
        print(f"  NO FACE DETECTED       {len(no_face):>6}  {100*len(no_face)/len(flagged):5.1f}%  {bar(len(no_face), len(flagged))}")
        print("     ^ never compared. A detector failure, not a mismatch.")
        print("       Changing the threshold or the recognition model cannot fix these.")
        print(f"  Actually compared      {len(real_mm):>6}  {100*len(real_mm)/len(flagged):5.1f}%  {bar(len(real_mm), len(flagged))}")

    # Distance distribution for the ones genuinely compared.
    if real_mm:
        print(f"\n--- Distance distribution ({len(real_mm)} genuinely compared, tolerance {TOLERANCE}) ---\n")
        buckets = Counter()
        for p in real_mm:
            d = float(p["distance"])
            buckets[min(int(d * 20) / 20, 0.95)] += 1
        for edge in sorted(buckets):
            n = buckets[edge]
            marker = "  <-- just over the line" if TOLERANCE <= edge < TOLERANCE + 0.10 else ""
            print(f"  {edge:.2f}-{edge+0.05:.2f}  {n:>5}  {bar(n, len(real_mm), 30)}{marker}")
        near = [p for p in real_mm if TOLERANCE <= float(p["distance"]) < TOLERANCE + 0.05]
        print(f"\n  Within 0.05 of the threshold: {len(near)} "
              f"({100*len(near)/len(real_mm):.1f}% of compared)")
        print("  If that share is large, the threshold is cutting through the middle")
        print("  of your own staff and raising it would recover genuine punches.")

    # Also report matched distances -- the two distributions overlapping is the
    # real test of whether ANY threshold can separate them.
    matched_d = [float(p["distance"]) for p in ok if p["distance"] is not None]
    if matched_d and real_mm:
        mm_d = [float(p["distance"]) for p in real_mm]
        print(f"\n--- Separation ---\n")
        print(f"  Matched   n={len(matched_d):<5} min={min(matched_d):.3f}  "
              f"mean={sum(matched_d)/len(matched_d):.3f}  max={max(matched_d):.3f}")
        print(f"  Flagged   n={len(mm_d):<5} min={min(mm_d):.3f}  "
              f"mean={sum(mm_d)/len(mm_d):.3f}  max={max(mm_d):.3f}")
        if max(matched_d) > min(mm_d):
            print("  The two ranges OVERLAP -- no single threshold separates them cleanly.")
            print("  That points at the model, not the number.")
        else:
            print("  The two ranges are cleanly separated -- the threshold is doing its job.")

    # Is it concentrated on a few people? That would mean bad reference photos.
    if not flagged:
        print("\nNo flags at all in this window — nothing further to break down.")
        print("=" * 66)
        return
    print(f"\n--- Who is affected ---\n")
    per_emp = defaultdict(lambda: {"total": 0, "no_face": 0, "mismatch": 0})
    for p in punches:
        e = per_emp[p["employee_id"]]
        e["total"] += 1
        if p["matched"] is False:
            e["no_face" if p["distance"] is None else "mismatch"] += 1
    worst = sorted(per_emp.items(),
                   key=lambda kv: -(kv[1]["no_face"] + kv[1]["mismatch"]))[:15]
    affected = [k for k, v in per_emp.items() if v["no_face"] + v["mismatch"]]
    print(f"  {len(affected)} of {len(per_emp)} employees have at least one flag.\n")
    print(f"  {'Employee':<12}{'punches':>9}{'no-face':>9}{'mismatch':>10}{'flag rate':>11}")
    for eid, v in worst:
        bad = v["no_face"] + v["mismatch"]
        if not bad:
            continue
        print(f"  {eid:<12}{v['total']:>9}{v['no_face']:>9}{v['mismatch']:>10}"
              f"{100*bad/v['total']:>10.0f}%")
    print("\n  Flags concentrated on a few people => their REFERENCE PHOTO is the problem.")
    print("  Flags spread evenly across everyone => the detector/model is the problem.")

    # Reasons, verbatim.
    print(f"\n--- Reasons given ---\n")
    # Collapse the embedded distance so "Face match weak (distance 0.61)" and
    # "(distance 0.72)" group as one reason instead of one row each.
    def kind(msg):
        return re.sub(r"\(distance [0-9.]+\)", "(distance N)", msg or "")
    for reason, n in Counter(kind(p["warning"]) for p in flagged if p["warning"]).most_common(10):
        print(f"  {n:>5}  {reason[:80]}")

    # CSV for a closer look, without pulling in pandas.
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "face_audit.csv")
    with open(out, "w") as f:
        f.write("employee_id,date,side,matched,distance,warning\n")
        for p in punches:
            w = (p["warning"] or "").replace(",", ";").replace("\n", " ")
            f.write(f'{p["employee_id"]},{p["date"]},{p["side"]},'
                    f'{p["matched"]},{p["distance"] if p["distance"] is not None else ""},"{w}"\n')
    print(f"\nRow-level detail written to {out}")
    print("=" * 66)


if __name__ == "__main__":
    asyncio.run(main())
