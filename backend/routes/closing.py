"""
Daily cash closing — the collections half.

WHAT PROBLEM THIS SOLVES
------------------------
Field officers keep collecting until 21:00-23:00. Head Office shuts at 19:00.
Whoever pulls the MIS report at 7pm and totals it by hand writes down a number
that is still moving: measured across July, 9.9% of the month's value posted
after 19:00, and on 21 July it was Rs 63,180 -- 17% of that day. So the figure
HO closes on is wrong by an amount nobody can know until the day is over.

This polls the MIS and keeps each branch's figures current on their own. By the
time anyone looks -- 9pm from a phone, or 8am the next morning -- the number has
finished moving.

WHAT IT DELIVERS, AND WHAT IT DOES NOT
--------------------------------------
It produces the TARGET: what each branch should have banked.

    cash to deposit = Mobile App + MIS postings   (75.9% of collections in July)
    UPI is already in a bank and is never deposited

It does NOT tell you whether the money actually reached a bank. That needs the
deposit slips, which is a separate piece of work. Nothing here should be read as
"the day is closed" -- only as "this is what the day owes".

DESIGN NOTES
------------
* THE CADENCE IS ADAPTIVE. Polling every three minutes around the clock is ~300
  logins a day against a legacy box for a figure that changes a few times an
  hour. We poll slowly through the day and quickly through the evening window
  when the close is actually happening.

* AN UNCHANGED REPORT IS NOT WRITTEN. The workbook is hashed; an identical pull
  updates the heartbeat and nothing else. Otherwise the audit trail fills with
  hundreds of identical revisions and a real late change becomes hard to see.

* SILENCE IS RECORDED, NOT ASSUMED. The tracking watchdog taught this the hard
  way: an in-process asyncio task that dies leaves no trace, and every screen
  downstream keeps showing yesterday's numbers as if they were today's. So every
  run -- success or failure -- stamps a state document, and /status reports it.
"""

import asyncio
import hashlib
import json
import os
import math
import logging
import uuid
from datetime import datetime, timedelta, date as date_cls
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel

from auth_utils import get_current_user
from database import db
from services.mis_client import today_ist, IST
from services.mis_parse import (parse_demand_collection, check_expected_branches,
                                storage_conflicts, MISParseError)

logger = logging.getLogger(__name__)
router = APIRouter()

COLL = "daily_collections"
STATE = "closing_state"
STATE_KEY = "mis_fetcher"
SLIPS = "deposit_slips"
DAYS = "closing_days"

# A branch-day walks these in order. Nothing skips: a day cannot be approved
# without having been submitted, because approval means "I checked the bank
# against what the branch said it banked", and there has to be a claim to check.
ST_AWAITING = "awaiting"     # BM has not submitted yet
ST_DEPOSITED = "deposited"   # BM submitted slips + cash count; awaiting Accounts
ST_APPROVED = "approved"     # Accounts saw the credit in the bank

# Rupees. Cash is counted in whole notes and the MIS reports whole rupees, so a
# tolerance here would only ever hide a real difference.
TOLERANCE = 0.0

# Hard ceiling on what a client may send, checked before any decoding or model
# call. The image is then re-encoded down to ~1600px regardless (see
# services/slip_ocr.normalise_image), so a stored slip is a few hundred KB, not
# the 8 MB a modern phone camera produces. Slips live inside Mongo documents and
# the BSON limit is 16 MB per document — this keeps three orders of magnitude of
# headroom rather than relying on the browser to be well behaved.
MAX_UPLOAD_B64 = 14 * 1024 * 1024

# No branch holds a crore in a drawer. A ceiling turns a typo into a rejected
# entry instead of a figure that quietly poisons the carry-forward.
MAX_CASH = 10_000_000.0

# The branches we bank for. Used only to notice when one goes MISSING from the
# report -- the fetcher asks for branch checkboxes by index without being able to
# see them, so a branch that stops being requested yields a valid report that is
# simply short. See mis_client's module docstring.
EXPECTED_BRANCHES = {"CHANDPUR", "NAJIBABAD", "CHANDAUSI", "BUDAUN"}

# Evening window (IST) — when collections are actually landing and someone is
# waiting on the number.
#
# 10 minutes, not 3. The tail is a trickle, not a firehose: the 21:00 hour held
# 36 transactions across the whole of July, roughly one a day. Polling every 3
# minutes bought a freshness nobody could perceive and cost 196 pulls a day
# against a legacy box; at 10 it is 98, and the figure is still never more than
# ten minutes behind during the only window that matters.
# On-demand fetching, not a schedule. A pull happens because somebody opened the
# screen or pressed Submit -- never because a clock struck. The floor is global:
# five branch managers tapping at 21:00 is one fetch, not five, and the vendor
# sees a handful of requests an evening instead of ninety-eight a day.
PULL_FLOOR_S = 5 * 60
# A request nobody collected within this long is dropped rather than served: by
# then the person who tapped has given up, and it would otherwise wedge the queue
# for that day for ever -- rotate the token on the Worker's side only and every
# heartbeat 401s, while /request-pull answers "already queued" six hours later.
REQUEST_TTL_MIN = 15
# The Worker budgets ninety seconds end to end and allows thirty more for the
# ingest POST, so anything under about two minutes of silence is a run IN
# PROGRESS, not a run lost. Four minutes is the honest threshold; below it we
# would be calling a slow evening a failure.
FETCHER_SILENT_ALARM_S = 4 * 60
MAX_QUEUE = 20
# The furthest back the queue may ever ask for. Bounded because a request spends
# a login against somebody else's production MIS.
MAX_BACKFILL_DAYS = 90



def _roles_ok(user: dict, allowed) -> bool:
    return user.get("role") in allowed


def _live_queue(st: dict, now) -> list:
    """The queue with anything past its TTL dropped."""
    out = []
    for q in (st.get("pull_queue") or [])[:MAX_QUEUE]:
        try:
            if (now - datetime.fromisoformat(q["at"])).total_seconds() / 60 <= REQUEST_TTL_MIN:
                out.append(q)
        except Exception:
            continue
    return out


def _run_for(st: dict, day_str: str) -> dict:
    """The last attempt AT THIS DAY, not the last attempt at anything."""
    return st.get(f"run_{day_str}") or {}


def _updated_at_for(st: dict, day_str: str):
    """When THIS day last landed. Never another day's timestamp."""
    return _run_for(st, day_str).get("ok_at")


def _unanswered_seconds(st: dict, day_str: str):
    """A fetch was handed out for this day and nothing came back. How long ago?

    None when nothing is outstanding. This is the silent case: the request was
    consumed, so it is not in the queue, and no run was recorded, so it is not in
    the failure log either. Without this it is invisible from both ends.
    """
    served = st.get(f"served_{day_str}")
    if not served:
        return None
    run_at = (_run_for(st, day_str) or {}).get("at")
    try:
        if run_at and datetime.fromisoformat(run_at) >= datetime.fromisoformat(served):
            return None                       # answered, well or badly
        return int((datetime.now(IST) - datetime.fromisoformat(served)).total_seconds())
    except Exception:
        return None


def _pending_seconds(st: dict, day_str: str):
    """How long a queued request for this day has been waiting, or None.

    Shown so a manager can tell "the fetcher has not picked this up" from "the
    fetcher is working on it" -- the two look identical from a spinner, and one
    of them means nobody is coming.
    """
    now = datetime.now(IST)
    for q in _live_queue(st, now):
        if q.get("date") == day_str:
            try:
                return int((now - datetime.fromisoformat(q["at"])).total_seconds())
            except Exception:
                return 0
    return None


async def _may_see_closing(user: dict, approver: bool = None) -> bool:
    """Can this person open the Daily Closing screen?

    ONE definition, used by /day and /request-pull alike. They used to disagree:
    /day required an approver or hr_admin/management/managers, while
    /request-pull required only a valid token — so a field officer who got a 403
    from the screen itself could still queue MIS fetches, and combined with the
    date-alternation floor bypass could drive them in a loop. The set who may
    make this app talk to a third party's production system must not be larger
    than the set who may look at the result.
    """
    if approver is None:
        approver = await _is_closing_approver(user)
    return bool(approver or _roles_ok(user, {"hr_admin", "management", "managers"}))


def _content_digest(report) -> str:
    """Hash what the report SAYS, not the bytes it arrived in.

    Hashing the raw .xlsx looked obvious and was wrong. Three pulls of the same
    unchanged day, minutes apart, came back at an identical 53,061 bytes with
    three DIFFERENT SHA-256s: an .xlsx is a zip, and every entry carries the
    moment it was generated. The bytes change on every pull even when not one
    rupee has moved.

    So a raw-byte digest never matches, `changed` is True on all 98 pulls a day,
    and the one thing the digest exists to tell us -- has anything actually
    happened since the last look -- is exactly the thing it cannot say.
    """
    payload = sorted((b.as_dict() for b in report.branches),
                     key=lambda d: (d["branch_code"], d["branch_name"]))
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()


_INGEST_LOCKS = {}


def _ingest_lock(day_str: str):
    """One lock per day, so two pulls of the same day cannot interleave."""
    lock = _INGEST_LOCKS.get(day_str)
    if lock is None:
        lock = _INGEST_LOCKS[day_str] = asyncio.Lock()
        # Unbounded growth would be a slow leak on a process that runs for
        # months. Only today and a few neighbours are ever contended.
        if len(_INGEST_LOCKS) > 32:
            for k in sorted(_INGEST_LOCKS)[:-8]:
                if not _INGEST_LOCKS[k].locked():
                    _INGEST_LOCKS.pop(k, None)
    return lock


async def _flag_post_approval_drift(day_str: str, report) -> list:
    """Did this pull change a branch-day that Accounts has already approved?

    It is not an error and must not be refused: a genuine 21:14 posting against
    a day approved the next morning is real money and belongs in the record. But
    it means someone signed off a figure that has since moved, and the ONE thing
    that must not happen is for that to pass unremarked.

    So: the approved ledger stays as approved (see /day), the difference is
    recorded on the day document, and the approvers are told. Whether the
    approval should have locked the day at all is a question for the business,
    not something to decide silently here.
    """
    out = []
    for b in report.branches:
        doc = await db[DAYS].find_one(
            {"date": day_str, "branch_code": b.branch_code},
            {"_id": 0, "state": 1, "approved_snapshot": 1}) or {}
        if doc.get("state") != ST_APPROVED:
            continue
        was = float(((doc.get("approved_snapshot") or {}).get("ledger") or {})
                    .get("expected_deposit") or 0)
        now = float(b.expected_deposit or 0)
        if abs(now - was) < 0.01:
            continue
        msg = (f"{b.branch_name}: collections changed by Rs {now - was:,.2f} AFTER "
               f"Accounts approved {day_str} (approved against Rs {was:,.2f}, "
               f"the MIS now says Rs {now:,.2f})")
        out.append(msg)
        await db[DAYS].update_one(
            {"date": day_str, "branch_code": b.branch_code},
            {"$set": {"collections_changed_after_approval": {
                "approved_expected_deposit": was,
                "current_expected_deposit": now,
                "difference": round(now - was, 2),
                "noticed_at": datetime.now(IST).isoformat(),
            }}})
        logger.error("closing: %s", msg)
    if out:
        await _alert_approvers(
            "A day you approved has changed",
            "; ".join(out) + ". The approved figures are unchanged on screen — "
            "reopen the day if the difference needs to be banked.")
    return out


def _gap_hours(ts, now) -> float:
    """Hours since `ts`, or a large number if it cannot be read."""
    if not ts:
        return 1e9
    try:
        return (now - datetime.fromisoformat(ts)).total_seconds() / 3600.0
    except Exception:
        return 1e9


async def _alert_approvers(title: str, msg: str):
    try:
        from services.fcm import send_to_employee
        emps = await db.employees.find(
            {"$or": [{"role": {"$in": ["hr_admin", "management"]}},
                     {"closing_approver": True}]},
            {"_id": 0, "employee_id": 1}).to_list(20)
        if not emps:
            logger.error("closing: '%s' and NOBODY could be alerted", title)
            return
        for e in emps:
            await send_to_employee(e.get("employee_id"), title, msg)
    except Exception:
        logger.warning("closing: could not send approver alert", exc_info=True)


async def _cross_pull_conflicts(report, day_str: str) -> list:
    """Would this pull collide with what an EARLIER pull of the same day stored?

    `storage_conflicts` only ever sees one report, so two pulls that are each
    internally clean can still collide. Both directions matter and only one of
    them used to be checked:

      same CODE, new NAME  -- "002 - CHANDPUR" this morning, "002 - Chandpur"
                              this evening. One code, two names.
      same NAME, new CODE  -- the `Branch` cell arrives without its "002 - "
                              prefix, so the code parses as "". The code check
                              cannot see this: "002" and "" are different keys,
                              so nothing collides and the upsert writes a SECOND
                              row for Chandpur beside the first.

    The second is the dangerous one, because nothing refuses it and nothing warns.
    /closing/day sums both rows: Chandpur's cash reads 309,404 against 154,702 of
    real money, the BM is told to bank twice what they hold, and reports a
    154,702 shortfall that does not exist. Both pulls answer {"ok": true}.
    """
    out = []
    try:
        existing = await db[COLL].find(
            {"date": day_str}, {"_id": 0, "branch_code": 1, "branch_name": 1}).to_list(50)
    except Exception:
        # Not being able to check is not permission to overwrite.
        logger.warning("closing: could not check stored branch names", exc_info=True)
        return ["could not verify today's stored branches — not overwriting"]
    by_code, by_name = {}, {}
    for e in existing:
        by_code.setdefault(e.get("branch_code"), set()).add(e.get("branch_name"))
        by_name.setdefault((e.get("branch_name") or "").upper().strip(),
                           set()).add(e.get("branch_code"))
    for b in report.branches:
        names = by_code.get(b.branch_code, set()) | {b.branch_name}
        if len(names) > 1:
            out.append(
                f"branch code {b.branch_code!r} is already stored today under a "
                f"different name ({', '.join(sorted(str(n) for n in names))}) — not overwriting")
        codes = by_name.get((b.branch_name or "").upper().strip(), set()) | {b.branch_code}
        if len(codes) > 1:
            out.append(
                f"branch {b.branch_name!r} is already stored today under a different "
                f"code ({', '.join(sorted(str(c) for c in codes))}) — storing this "
                f"would count the branch twice")
    return out


async def _stamp_run(key: str, day: str, ok: bool, detail: str, kind: str = None,
                     changed: bool = False, warnings: list = None,
                     source: str = None):
    """The single place a fetch attempt is written down.

    There used to be two of these -- one for the in-process poller and one for
    the Worker -- writing the same fields to the same document with different
    rules, and the differences were all bugs:

    * only one of them stamped `failing_since`, so a failure recorded by the
      other left it unset and `_alert_fetch_failure` returned early forever. The
      30-minute sustained alert could not fire at all.
    * `last_success_at` was stamped whichever DAY succeeded, so a backfill of
      last Friday reset today's failure clock and turned the health strip green
      while today's figures sat frozen. `last_success_date` now travels with it
      and /status compares it to the day being asked about.
    """
    now = datetime.now(IST)
    upd = {
        "last_run_at": now.isoformat(),
        "last_run_ok": ok,
        "last_run_detail": detail,
        "last_run_date": day,
    }
    if kind is not None:
        upd["last_run_kind"] = kind
    if source is not None:
        upd["last_run_source"] = source
    # Only write warnings when this run actually produced a verdict on the day.
    # An unconditional $set meant one network blip erased "the report contained
    # no collection rows at all" -- leaving a branch showing Rs 0 with nothing
    # to say why, which is the single state this field exists to prevent.
    if warnings is not None:
        upd[f"warnings_{day}"] = list(warnings)

    prev = await db[STATE].find_one({"_id": key}) or {}
    run = dict(prev.get(f"run_{day}") or {})

    # PER DAY, NOT GLOBAL. The flags used to be one set for the whole document,
    # so a backfill and today's fetch overwrote each other's verdicts. Both
    # directions were wrong, and the second is dangerous:
    #
    #   a failed backfill of 20-Jul painted "the MIS fetch failed" over today's
    #   fresh figures on every branch manager's screen;
    #
    #   and today's AUTH FAILURE followed by a successful backfill left today
    #   reading last_attempt_failed:false with no timestamp at all -- a wrong
    #   password, invisible, while the screen showed frozen figures and the
    #   client spun out its whole wait with nothing to report.
    run.update({"ok": ok, "detail": detail, "at": now.isoformat()})
    if ok:
        run["ok_at"] = now.isoformat()
        upd["last_success_at"] = now.isoformat()
        upd["last_success_date"] = day
        # The failure clock is per day too. A success on THIS day ends THIS
        # day's episode and says nothing about any other.
        run["failing_since"] = None
    elif not run.get("failing_since"):
        run["failing_since"] = now.isoformat()
    upd[f"run_{day}"] = run

    if changed:
        upd["last_change_at"] = now.isoformat()
    try:
        await db[STATE].update_one({"_id": key}, {"$set": upd}, upsert=True)
    except Exception:
        logger.warning("closing: could not record run state", exc_info=True)


# The in-process poller and refresh_day USED to live here and are deleted.
#
# They could not work: this pod has no route to radhyamfin.com. Worse, the loop
# started on every boot whenever MIS_USERNAME/MIS_PASSWORD were set, failed every
# fifteen minutes, and stamped that failure onto the SAME state document the
# Cloudflare Worker writes to -- painting "The MIS fetch failed" over figures that
# had arrived three minutes earlier and were correct, wiping the day's warnings,
# and holding /status permanently unhealthy.
#
# That is precisely the failure that removing the /refresh button was meant to
# end, arriving on a timer instead of a tap. Deleted rather than guarded: an
# environment variable nobody documented as load-bearing is not a safety
# mechanism. Fetching happens in the Worker and arrives through /ingest.

@router.get("/day")
async def closing_day(
    date: str = Query(None, description="YYYY-MM-DD, defaults to today (IST)"),
    current_user: dict = Depends(get_current_user),
):
    """Per-branch collections and the cash each branch owes the bank."""
    # Approvers must be able to OPEN this screen, not merely POST to it. The
    # Accounts Manager who signs off cash is role=employee and qualifies through
    # the grant, so a role-only gate locked the one person whose approval is the
    # entire control out of the page they approve on — while the sidebar happily
    # showed them the link.
    approver = await _is_closing_approver(current_user)
    if not await _may_see_closing(current_user, approver):
        raise HTTPException(status_code=403, detail="Not permitted")
    day_str = date or today_ist().isoformat()
    rows = await db[COLL].find({"date": day_str}, {"_id": 0}).to_list(50)
    notice = ""

    # Branch managers see their own branch only. HO sees everything.
    #
    # THIS FAILS CLOSED, and the earlier version did not. It filtered only when
    # a branch key could be derived, so a `managers` user with a blank branch saw
    # every branch's cash. That is not a corner case: the employee form ships an
    # explicit "— Not Assigned —" option, branch is free text, and auth_utils
    # AUTO-UPGRADES any employee who has a direct report to role `managers` — so
    # a senior field officer with one junior silently gained the whole company's
    # collection figures. Showing nothing is the only safe default.
    # An approver sees every branch — that is the job. Checked before the branch
    # filter, because an Accounts Manager who happens to have a direct report is
    # auto-upgraded to `managers` by auth_utils and would otherwise be filtered
    # down to their own (Head Office) branch, i.e. to nothing.
    if current_user.get("role") == "managers" and not approver:
        emp = await db.employees.find_one({"employee_id": current_user.get("employee_id")})
        branch = ((emp or {}).get("branch") or "").strip()
        # HRapp stores "Chandpur Branch"; the MIS says "CHANDPUR".
        key = branch.upper().replace("BRANCH", "").strip()
        if not key:
            rows = []
            notice = ("Your employee record has no branch set, so no figures can be "
                      "shown. Ask HR to set your branch.")
        else:
            matched = [r for r in rows if r.get("branch_name", "").upper().strip() == key]
            if not matched and rows:
                # An unmatched branch name must not look like a quiet zero day —
                # a BM would read "no collections" and bank nothing. Say which
                # name failed to match so HR can fix the spelling.
                notice = (f"Your branch ({branch}) could not be matched to any branch in "
                          "the MIS report. Ask HR to check the spelling on your record.")
            rows = matched

    totals = {
        "cash": round(sum(r.get("cash", 0) for r in rows), 2),
        "upi": round(sum(r.get("upi", 0) for r in rows), 2),
        "collected": round(sum(r.get("collected", 0) for r in rows), 2),
        "expected_deposit": round(sum(r.get("expected_deposit", 0) for r in rows), 2),
        # Demand is what was DUE, not what came in. It plays no part in the cash
        # reconciliation and must never be confused with the deposit target --
        # it is here so a branch can see collection against what was raised.
        "demand": round(sum(r.get("demand", 0) for r in rows), 2),
        "demand_cds": round(sum(r.get("demand_cds", 0) for r in rows), 2),
    }
    # Warnings come from the state document as well as the rows, because a day
    # that parsed to zero branches has no rows to carry them — and that is
    # precisely the day someone needs to be told something went wrong.
    st = await db[STATE].find_one({"_id": STATE_KEY}) or {}
    warnings = sorted(
        {w for r in rows for w in (r.get("warnings") or [])}
        | set(st.get(f"warnings_{day_str}") or [])
    )
    if notice:
        warnings = [notice] + warnings

    # Attach the deposit side to each branch, so one call drives the whole screen.
    for r in rows:
        code = r.get("branch_code")
        d = await db[DAYS].find_one({"date": day_str, "branch_code": code}, {"_id": 0}) or {}
        slips = await _slips_for(day_str, code)
        deposited = round(sum(float(s.get("amount") or 0) for s in slips
                              if s.get("status") == "confirmed"), 2)
        opening = float(d.get("opening_hold") if d.get("opening_hold") is not None
                        else await _opening_hold(day_str, code))
        # An APPROVED day shows the ledger that was APPROVED, not a fresh one.
        #
        # Recomputing live meant a collection posted after approval silently
        # reopened a balanced day: the screen showed a shortfall, the permanent
        # `approved_snapshot` still said it balanced, and nothing could reconcile
        # them because approved days refuse edits. A branch was left showing a
        # hole it had no way to close. The signed figure is the one that shows;
        # the drift is surfaced separately, as its own fact.
        snap = d.get("approved_snapshot") or {}
        live = _ledger(float(r.get("expected_deposit") or 0), opening,
                       deposited, d.get("cash_counted"))
        r["closing"] = {
            "state": d.get("state") or ST_AWAITING,
            "cash_counted": d.get("cash_counted"),
            "reject_reason": d.get("reject_reason"),
            "submitted_at": d.get("submitted_at"),
            "approved_at": d.get("approved_at"),
            "approved_by": d.get("approved_by"),
            "slips": slips,
            "ledger": (snap.get("ledger") if d.get("state") == ST_APPROVED and snap.get("ledger")
                       else live),
            "collections_changed_after_approval": d.get("collections_changed_after_approval"),
        }

    # Freshness belongs on this response, not only on the admin-only /status.
    # The branch manager working at 21:00 is the person who most needs to know
    # whether the figure in front of them is four minutes or four hours old, and
    # they cannot see /status at all.
    return {"date": day_str, "branches": rows, "totals": totals, "warnings": warnings,
            "can_approve": await _is_closing_approver(current_user),
            # ALL DAY-SCOPED. These used to mix: `updated_at` was per day while
            # the failure flags were global, so one day's verdict was shown
            # against another day's figures -- in the worst direction, today's
            # wrong-password failure vanished the moment a backfill succeeded.
            "updated_at": _updated_at_for(st, day_str),
            "pull_pending": _pending_seconds(st, day_str) is not None,
            "pull_waiting_seconds": _pending_seconds(st, day_str),
            "fetcher_silent_seconds": _unanswered_seconds(st, day_str),
            "fetcher_silent": (_unanswered_seconds(st, day_str) or 0) >= FETCHER_SILENT_ALARM_S,
            "last_attempt_failed": _run_for(st, day_str).get("ok") is False,
            "last_attempt_detail": (_run_for(st, day_str).get("detail")
                                    if _run_for(st, day_str).get("ok") is False
                                    else None)}


@router.post("/request-pull")
async def request_pull(date: str = Query(None),
                       current_user: dict = Depends(get_current_user)):
    """Ask for a fresh pull from the MIS. Anyone who can see the screen may ask.

    THIS DOES NOT FETCH ANYTHING. It cannot: this pod has no outbound route to
    radhyamfin.com, which is why the fetcher lives in a Cloudflare Worker. All
    this does is add the day to a queue; the Worker drains it on a heartbeat.

    The old /refresh went straight at the MIS from here. It could not succeed
    after the fetcher moved out, and pressing it stamped a FAILURE over perfectly
    good data.

    Branch managers may ask. They are the ones working at 21:00 while Head Office
    left at 19:00, so gating this on role would leave the figure stale in exactly
    the hours it moves.
    """
    if not await _may_see_closing(current_user):
        raise HTTPException(status_code=403, detail="Not permitted")
    try:
        day = date_cls.fromisoformat(date) if date else today_ist()
    except ValueError:
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")
    # Bound what the queue can ever ask for. A request travels to another system
    # and spends a login against a third party's production MIS, so a
    # fat-fingered date in a picker must not become a fetch for the year 2099.
    today = today_ist()
    if day > today:
        raise HTTPException(status_code=400, detail="that day has not happened yet")
    if (today - day).days > MAX_BACKFILL_DAYS:
        raise HTTPException(
            status_code=400,
            detail=f"only the last {MAX_BACKFILL_DAYS} days can be refetched")

    day_str = day.isoformat()
    now = datetime.now(IST)
    st = await db[STATE].find_one({"_id": INGEST_STATE_KEY}) or {}
    queue = _live_queue(st, now)
    updated_at = _updated_at_for(st, day_str)

    # Already queued and not yet collected.
    if any(q["date"] == day_str for q in queue):
        pending = next(q for q in queue if q["date"] == day_str)
        waited = int((now - datetime.fromisoformat(pending["at"])).total_seconds())
        return {"queued": False, "already_queued": True,
                "requested_at": pending["at"], "waiting_seconds": waited,
                "updated_at": updated_at}

    # Fresh enough for THIS day. Not an error -- the caller is told when it last
    # updated and how long until asking again would do anything.
    if updated_at:
        age = (now - datetime.fromisoformat(updated_at)).total_seconds()
        if age < PULL_FLOOR_S:
            return {"queued": False, "fresh": True, "updated_at": updated_at,
                    "seconds_until_next": int(PULL_FLOOR_S - age)}

    # THE FLOOR IS GLOBAL, AND GLOBAL MEANS ACROSS DAYS TOO.
    #
    # It used to be consulted only when the request was for the same day that
    # last succeeded, so alternating today / yesterday queued ten fetches in ten
    # taps. That needs no malice: Head Office backfilling last Friday while the
    # branches work today does exactly that, and the vendor's login sees fifteen
    # attempts an hour instead of the handful this design exists to produce.
    last_req = st.get("last_pull_request_at")
    if last_req:
        try:
            since = (now - datetime.fromisoformat(last_req)).total_seconds()
        except Exception:
            since = PULL_FLOOR_S
        if since < PULL_FLOOR_S:
            return {"queued": False, "throttled": True, "updated_at": updated_at,
                    "seconds_until_next": int(PULL_FLOOR_S - since)}

    queue.append({"date": day_str, "at": now.isoformat(),
                  "by": current_user.get("employee_id")})
    await db[STATE].update_one(
        {"_id": INGEST_STATE_KEY},
        {"$set": {"pull_queue": queue, "last_pull_request_at": now.isoformat()}},
        upsert=True)
    logger.info("closing: %s asked for a pull of %s",
                current_user.get("employee_id"), day_str)
    return {"queued": True, "date": day_str, "updated_at": updated_at}


@router.get("/pending-pull")
async def pending_pull(x_ingest_token: str = Header(None)):
    """The Worker asking: does anybody want a fetch?

    Called on a heartbeat, so it must be cheap and must never do work. The
    heartbeat is a schedule that NEVER REACHES THE VENDOR -- the MIS is touched
    only when a person has asked, which is the whole point of the design.
    """
    if not _ingest_token_ok(x_ingest_token):
        raise HTTPException(status_code=401, detail="Not authorised")
    now = datetime.now(IST)

    # ATOMIC. Read-then-write was not.
    #
    # This used to be a find_one followed by an unconditional $set, which is a
    # check-then-act: two heartbeats -- and Cloudflare's cron can double-fire --
    # both read the same request and both returned wanted:true. One tap, two MIS
    # logins, two ingests. The same window also erased a request that arrived
    # between the read and the write, so a tap could vanish with "queued": true
    # already on the manager's screen and no record anywhere that they asked.
    #
    # find_one_and_update with $pop is one operation: exactly one caller can
    # remove a given entry, and nothing else is touched.
    for _ in range(MAX_QUEUE):      # bounded: drain stale entries, never spin
        prev = await db[STATE].find_one_and_update(
            {"_id": INGEST_STATE_KEY, "pull_queue.0": {"$exists": True}},
            {"$pop": {"pull_queue": -1}})
        if not prev:
            return {"wanted": False}
        entry = (prev.get("pull_queue") or [None])[0]
        if not entry or not entry.get("date"):
            continue
        # A request nobody collected for REQUEST_TTL_MIN is not worth acting on:
        # by then the manager has given up, and fetching against it spends a
        # login answering a question nobody is still asking.
        try:
            age_min = (now - datetime.fromisoformat(entry["at"])).total_seconds() / 60
        except Exception:
            age_min = 0
        if age_min > REQUEST_TTL_MIN:
            logger.warning("closing: dropped a stale pull request for %s (%d min old)",
                           entry["date"], age_min)
            continue
        # Record that we HANDED THIS OUT. Consumed-on-read means the request is
        # gone the moment it is read, so a fetcher that dies between reading and
        # reporting leaves no trace anywhere -- the tap simply never happened as
        # far as this system is concerned. The Worker found three paths that do
        # exactly that (a timeout mid-body, a dropped connection, a truncated
        # response), and none of them can report because the thing that would
        # report is what failed. This is the only end that can notice.
        await db[STATE].update_one(
            {"_id": INGEST_STATE_KEY},
            {"$set": {f"served_{entry['date']}": now.isoformat()}}, upsert=True)
        return {"wanted": True, "date": entry["date"], "requested_at": entry["at"]}
    return {"wanted": False}


@router.get("/status")
async def closing_status(current_user: dict = Depends(get_current_user)):
    """Is the fetcher alive, and when did it last actually change anything?

    Exists because an asyncio task that has died looks exactly like one with
    nothing to do. Without this, a fetcher that stopped on Monday would show
    Monday's numbers all week and nobody would know.
    """
    if not _roles_ok(current_user, {"hr_admin", "management"}):
        raise HTTPException(status_code=403, detail="Not permitted")
    st = await db[STATE].find_one({"_id": STATE_KEY}) or {}
    last = st.get("last_run_at")
    success = st.get("last_success_at")

    def _mins_since(ts):
        if not ts:
            return None
        try:
            return int((datetime.now(IST) - datetime.fromisoformat(ts)).total_seconds() / 60)
        except Exception:
            return None

    stale_min = _mins_since(last)
    since_success = _mins_since(success)

    # HEALTH MEANS "WE HAVE TODAY'S NUMBERS", NOT "THE LOOP IS SPINNING".
    #
    # This used to be `last_run_at is recent`, which reported healthy: true on a
    # poller that had never once succeeded and was timing out every cycle -- a
    # green strip over figures that did not exist. Running is not the same as
    # working, and the whole point of this endpoint is that a dead fetcher must
    # not look like a quiet one.
    # ...and "today's numbers", not "some day's numbers". A successful BACKFILL
    # of last Friday used to stamp last_success_at, clear the failure clock and
    # turn this green while today's figures sat frozen and nobody was told.
    today = today_ist().isoformat()
    success_day = st.get("last_success_date")
    success_is_today = success_day is None or success_day == today

    last_ok = bool(st.get("last_run_ok"))
    healthy = (last_ok
               and stale_min is not None and stale_min < 45
               and since_success is not None and since_success < 120
               and success_is_today)

    reason = None
    if last_ok and not success_is_today:
        reason = (f"the last successful fetch was for {success_day}, not today — "
                  "today's figures have not arrived")
    elif not last:
        reason = "the MIS poller has never run — is the backend restarted and are the credentials set?"
    elif not success:
        reason = ("the poller is running but has never successfully fetched: "
                  + (st.get("last_run_detail") or "no detail"))
    elif not last_ok:
        reason = "the last attempt failed: " + (st.get("last_run_detail") or "no detail")
    elif stale_min is not None and stale_min >= 45:
        reason = f"no attempt for {stale_min} minutes — the poller may have died"
    elif since_success is not None and since_success >= 120:
        reason = f"no successful fetch for {since_success} minutes"

    return {
        "last_run_at": last,
        "last_run_ok": st.get("last_run_ok"),
        "last_run_detail": st.get("last_run_detail"),
        "last_success_at": success,
        "last_change_at": st.get("last_change_at"),
        "minutes_since_last_run": stale_min,
        "minutes_since_last_success": since_success,
        "healthy": healthy,
        "unhealthy_reason": reason,
    }


# ══════════════════════════════════════════════════════════════════
#  Deposits — the other half of the reconciliation
# ══════════════════════════════════════════════════════════════════
#
# The MIS half says what a branch OWES the bank. This half is what the branch
# says it BANKED, and then what Accounts confirms actually arrived.
#
#     awaiting  --BM uploads slips, counts cash, submits-->  deposited
#     deposited --Accounts checks the bank, approves------>  approved
#     deposited --Accounts rejects------------------------>  awaiting
#
# THERE IS NO BANK FEED. Nobody chose one, deliberately: Accounts checks the
# statement themselves the next morning. So the approval is not a rubber stamp,
# it is the ONLY control that money actually arrived — a slip proves a deposit
# was attempted, not that it cleared. That is why the approval records who, when
# and the exact figures they were shown: if a deposit is later found missing,
# the question "what did the approver actually see?" has an answer.


class SlipConfirm(BaseModel):
    amount: float
    bank_name: Optional[str] = None
    reference_no: Optional[str] = None


class DaySubmit(BaseModel):
    date: str
    branch_code: str
    cash_counted: float


class DayDecision(BaseModel):
    date: str
    branch_code: str
    reason: Optional[str] = None
    reopen: bool = False           # only meaningful on /reject of an approved day


async def _is_closing_approver(user: dict) -> bool:
    """May this person confirm a day against the bank?

    Role alone cannot answer this. The Accounts Manager who does the checking is
    `designation: Accounts Manager` but `role: employee` — the same role as a
    field officer — so gating on role would either lock out the one person who
    needs it or hand cash approval to everyone. Same shape as the tracking grant:
    an explicit per-person flag, plus management who oversee it anyway.
    """
    if user.get("role") in ("hr_admin", "management"):
        return True
    emp = await db.employees.find_one(
        {"employee_id": user.get("employee_id")}, {"_id": 0, "closing_approver": 1})
    return bool(emp and emp.get("closing_approver"))


async def _my_branch(user: dict):
    """(branch_label, mis_key) for a branch manager, or (None, None)."""
    emp = await db.employees.find_one({"employee_id": user.get("employee_id")})
    label = ((emp or {}).get("branch") or "").strip()
    return label, label.upper().replace("BRANCH", "").strip()


async def _may_touch_branch(user: dict, branch_code: str, day: str):
    """Resolve the branch a write is aimed at, or refuse.

    Fails closed for the same reason the read path does: a `managers` user with
    no branch set must not be able to act on someone else's cash.
    """
    row = await db[COLL].find_one({"date": day, "branch_code": branch_code}, {"_id": 0})
    if not row:
        # NO ROW IS NOT A REASON TO REFUSE THE DEPOSIT.
        #
        # The MIS poller can be down (credentials revoked, site unreachable, a
        # parse failure, a branch dropped from the report). None of that changes
        # the fact that a BM is standing at a bank at 9pm holding cash. Refusing
        # here meant they could not photograph the slip OR record what they held,
        # and the next morning Accounts had nothing to check.
        #
        # So we fall back to the branch on the person's own employee record and
        # carry expected_deposit = 0, which the ledger surfaces as an unexplained
        # difference rather than silently balancing.
        if user.get("role") == "managers":
            label, key = await _my_branch(user)
            if key:
                # Fails closed here too, and it did not before. With no row for
                # today there is nothing to check `branch_code` against, so the
                # supplied code was taken on trust -- a BM could post their own
                # branch name against another branch's code and have the slips
                # filed under it. That is the same code/name split the storage
                # guards refuse a report for. Check it against history instead:
                # the branch has almost always been seen on some earlier day.
                seen = await db[COLL].find(
                    {}, {"_id": 0, "branch_code": 1, "branch_name": 1}
                ).sort("date", -1).to_list(200)
                mine = {r.get("branch_code") for r in seen
                        if (r.get("branch_name") or "").upper().strip() == key}
                if mine and branch_code not in mine:
                    raise HTTPException(status_code=403, detail="That is not your branch")
                return {"branch_code": branch_code, "branch_name": key,
                        "expected_deposit": 0.0, "collections_missing": True}
        raise HTTPException(
            status_code=404,
            detail=("No collections have been recorded for that branch and day, and "
                    "your account is not tied to a branch we can record against."))
    if user.get("role") in ("hr_admin", "management"):
        return row
    if user.get("role") != "managers":
        raise HTTPException(status_code=403, detail="Not permitted")
    _, key = await _my_branch(user)
    if not key:
        raise HTTPException(status_code=403,
                            detail="Your employee record has no branch set. Ask HR to set it.")
    if row.get("branch_name", "").upper().strip() != key:
        raise HTTPException(status_code=403, detail="That is not your branch")
    return row


async def _day_doc(day: str, row: dict) -> dict:
    """The closing_days document for a branch-day, created on first touch."""
    doc = await db[DAYS].find_one(
        {"date": day, "branch_code": row["branch_code"]}, {"_id": 0})
    if doc:
        return doc
    doc = {
        "date": day,
        "branch_code": row["branch_code"],
        "branch_name": row.get("branch_name", ""),
        "state": ST_AWAITING,
        "cash_counted": None,
        "created_at": datetime.now(IST).isoformat(),
    }
    await db[DAYS].update_one(
        {"date": day, "branch_code": row["branch_code"]}, {"$setOnInsert": doc}, upsert=True)
    return doc


def _require_open(doc: dict):
    """Slips may only change while the day is still the branch's to change.

    Blocking only on `approved` was not enough. Between submitting and being
    approved the day sits in `deposited` — and upload, confirm and void were all
    open in that window. A BM could submit a Rs 90,000 slip, void it, and the day
    would still approve: a permanent record that Rs 90,000 reached the bank with
    no slip behind it. Anything that changes the evidence has to go back through
    Accounts, so `deposited` is closed to edits too.
    """
    st = doc.get("state")
    if st == ST_APPROVED:
        raise HTTPException(status_code=409,
                            detail="This day has been approved. Ask Accounts to reopen it.")
    if st == ST_DEPOSITED:
        raise HTTPException(
            status_code=409,
            detail="This day is with Accounts. Ask them to return it before changing anything.")


async def _slips_for(day: str, branch_code: str) -> list:
    return await db[SLIPS].find(
        {"date": day, "branch_code": branch_code, "status": {"$ne": "void"}},
        {"_id": 0, "image_b64": 0},   # never ship the image in a list
    ).sort("uploaded_at", 1).to_list(100)


async def _opening_hold(day: str, branch_code: str) -> float:
    """Cash carried in from the last closed day.

    Not "yesterday": branches do not collect every day, and a Sunday between a
    Saturday count and a Monday morning must not reset the hold to zero. We take
    the most recent counted day before this one, and zero only when there has
    never been one — which is the agreed day-one convention.
    """
    prev = await db[DAYS].find_one(
        {"branch_code": branch_code, "date": {"$lt": day}, "cash_counted": {"$ne": None}},
        {"_id": 0, "cash_counted": 1}, sort=[("date", -1)])
    return float((prev or {}).get("cash_counted") or 0.0)


def _ledger(expected_cash: float, opening: float, deposited: float, counted):
    """opening + collected - deposited  ==  what should still be in the drawer."""
    should_hold = round(opening + expected_cash - deposited, 2)
    out = {
        "opening_hold": round(opening, 2),
        "cash_collected": round(expected_cash, 2),
        "deposited": round(deposited, 2),
        "should_hold": should_hold,
        "counted": None if counted is None else round(float(counted), 2),
        "difference": None,
        "balanced": None,
    }
    if counted is not None:
        diff = round(float(counted) - should_hold, 2)
        out["difference"] = diff
        out["balanced"] = abs(diff) <= TOLERANCE
    return out


@router.post("/slips")
async def upload_slip(payload: dict, current_user: dict = Depends(get_current_user)):
    """Upload one deposit slip. Reads it, but commits nothing.

    The extracted amount is a PROPOSAL. It is stored as `ocr` and the slip has no
    confirmed amount until a human sets one — see services/slip_ocr.py for why
    this cannot be trusted to close a day on its own.
    """
    from services.slip_ocr import extract_deposit_slip, normalise_image, SlipOCRError

    day = (payload or {}).get("date") or today_ist().isoformat()
    branch_code = (payload or {}).get("branch_code") or ""
    b64 = (payload or {}).get("image_b64") or ""
    mime = (payload or {}).get("mime") or "image/jpeg"

    row = await _may_touch_branch(current_user, branch_code, day)
    doc = await _day_doc(day, row)
    _require_open(doc)

    # Shrink FIRST, so the small version is what we store and what the model
    # sees. Order matters: normalising after OCR would still send a full camera
    # frame over the wire, and normalising after storage would keep it forever.
    if len(b64) > MAX_UPLOAD_B64:
        raise HTTPException(status_code=413,
                            detail="That image is too large — retake it at a lower quality")
    b64, mime, size_note = normalise_image(b64, mime)

    try:
        ocr = await extract_deposit_slip(b64, mime)
    except SlipOCRError as e:
        # A slip that cannot be read must still be storable — the BM is standing
        # at a bank at 9pm and the fallback is typing the amount, not giving up.
        ocr = {"amount": None, "needs_review": True, "review_reasons": [str(e)],
               "legible": False, "is_deposit_receipt": None}

    # A slip dated other than the day being closed is worth flagging, not
    # blocking: a real batch contained a 13-08 slip alongside 14-08 ones, and
    # yesterday's slip submitted against today's cash is precisely the mistake
    # nothing else in this pipeline would catch.
    slip_date = (ocr or {}).get("deposit_date")
    if slip_date and str(slip_date)[:10] != day:
        ocr = dict(ocr or {})
        ocr["needs_review"] = True
        ocr["review_reasons"] = list(ocr.get("review_reasons") or []) + [
            f"this slip is dated {slip_date}, but you are closing {day}"]

    slip = {
        "id": str(uuid.uuid4()),
        "date": day,
        "branch_code": branch_code,
        "branch_name": row.get("branch_name", ""),
        "uploaded_by": current_user.get("employee_id"),
        "uploaded_at": datetime.now(IST).isoformat(),
        "image_b64": b64,
        "mime": mime,
        "ocr": ocr,
        "size_note": size_note,
        "amount": None,           # set only when a human confirms
        "bank_name": ocr.get("bank_name"),
        "reference_no": ocr.get("reference_no"),
        "status": "pending",
    }
    await db[SLIPS].insert_one(dict(slip))
    slip.pop("image_b64", None)
    return slip


@router.patch("/slips/{slip_id}")
async def confirm_slip(slip_id: str, body: SlipConfirm,
                       current_user: dict = Depends(get_current_user)):
    """Confirm (or correct) the amount on a slip. This is the figure that counts."""
    slip = await db[SLIPS].find_one({"id": slip_id}, {"_id": 0, "image_b64": 0})
    if not slip:
        raise HTTPException(status_code=404, detail="Slip not found")
    await _may_touch_branch(current_user, slip["branch_code"], slip["date"])
    doc = await _day_doc(slip["date"], slip)
    _require_open(doc)
    if body.amount is None or body.amount <= 0:
        raise HTTPException(status_code=400, detail="Enter the amount actually deposited")

    upd = {
        "amount": round(float(body.amount), 2),
        "status": "confirmed",
        "confirmed_by": current_user.get("employee_id"),
        "confirmed_at": datetime.now(IST).isoformat(),
        # Kept so a later audit can see whether the human agreed with the machine
        # or overrode it, and by how much.
        "amount_was_corrected": (slip.get("ocr") or {}).get("amount") is not None
                                and abs(((slip.get("ocr") or {}).get("amount") or 0)
                                        - float(body.amount)) >= 1,
    }
    if body.bank_name is not None:
        upd["bank_name"] = body.bank_name.strip()[:60]
    if body.reference_no is not None:
        upd["reference_no"] = body.reference_no.strip()[:60]
    await db[SLIPS].update_one({"id": slip_id}, {"$set": upd})
    return {**slip, **upd}


@router.delete("/slips/{slip_id}")
async def void_slip(slip_id: str, current_user: dict = Depends(get_current_user)):
    """Void a slip — a retake, a duplicate, or the wrong branch.

    Voided, never deleted. With multiple deposits a night, photographing the same
    receipt twice is a normal accident, and the record of the correction is worth
    more than a tidy collection.
    """
    slip = await db[SLIPS].find_one({"id": slip_id}, {"_id": 0, "image_b64": 0})
    if not slip:
        raise HTTPException(status_code=404, detail="Slip not found")
    await _may_touch_branch(current_user, slip["branch_code"], slip["date"])
    doc = await _day_doc(slip["date"], slip)
    _require_open(doc)
    await db[SLIPS].update_one({"id": slip_id}, {"$set": {
        "status": "void", "voided_by": current_user.get("employee_id"),
        "voided_at": datetime.now(IST).isoformat()}})
    return {"ok": True}


@router.get("/slips/{slip_id}/image")
async def slip_image(slip_id: str, current_user: dict = Depends(get_current_user)):
    """The photo itself. Separate from the list so images are never bulk-shipped."""
    slip = await db[SLIPS].find_one({"id": slip_id}, {"_id": 0})
    if not slip:
        raise HTTPException(status_code=404, detail="Slip not found")
    if not await _is_closing_approver(current_user):
        await _may_touch_branch(current_user, slip["branch_code"], slip["date"])
    return {"id": slip_id, "mime": slip.get("mime"), "image_b64": slip.get("image_b64")}


@router.post("/submit")
async def submit_day(body: DaySubmit, current_user: dict = Depends(get_current_user)):
    """BM: 'this is what I banked and this is what I am still holding.'"""
    row = await _may_touch_branch(current_user, body.branch_code, body.date)
    doc = await _day_doc(body.date, row)
    if doc.get("state") == ST_APPROVED:
        raise HTTPException(status_code=409, detail="This day has already been approved")
    # isfinite, not just >= 0. A number input accepts scientific notation and a
    # stuck key produces Infinity, which pydantic accepts and Mongo stores -- and
    # then FastAPI cannot serialise it, so every later read of this branch 500s
    # and _opening_hold carries inf into every following day. The write landed
    # before the response failed, so it bricked the branch silently.
    if (body.cash_counted is None or not math.isfinite(body.cash_counted)
            or body.cash_counted < 0 or body.cash_counted > MAX_CASH):
        raise HTTPException(status_code=400,
                            detail="Enter the cash you are holding as a plain amount (0 if none)")

    slips = await _slips_for(body.date, body.branch_code)
    unconfirmed = [s for s in slips if s.get("status") != "confirmed"]
    if unconfirmed:
        raise HTTPException(
            status_code=400,
            detail=f"{len(unconfirmed)} slip(s) still need their amount confirmed")

    deposited = round(sum(float(s.get("amount") or 0) for s in slips), 2)
    opening = await _opening_hold(body.date, body.branch_code)
    ledger = _ledger(float(row.get("expected_deposit") or 0), opening, deposited,
                     body.cash_counted)

    await db[DAYS].update_one(
        {"date": body.date, "branch_code": body.branch_code},
        {"$set": {
            "state": ST_DEPOSITED,
            "cash_counted": round(float(body.cash_counted), 2),
            "deposited": deposited,
            "opening_hold": opening,
            "ledger": ledger,
            "submitted_by": current_user.get("employee_id"),
            "submitted_at": datetime.now(IST).isoformat(),
            "reject_reason": None,
        }},
        upsert=True)
    return {"state": ST_DEPOSITED, "ledger": ledger, "slips": len(slips)}


@router.post("/approve")
async def approve_day(body: DayDecision, current_user: dict = Depends(get_current_user)):
    """Accounts: 'I have seen this money in the bank.'"""
    if not await _is_closing_approver(current_user):
        raise HTTPException(status_code=403, detail="Not permitted to approve closings")
    doc = await db[DAYS].find_one(
        {"date": body.date, "branch_code": body.branch_code}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Nothing submitted for that branch and day")
    if doc.get("state") != ST_DEPOSITED:
        raise HTTPException(status_code=409,
                            detail=f"That day is '{doc.get('state')}', not awaiting approval")

    slips = await _slips_for(body.date, body.branch_code)

    # Recompute the ledger NOW rather than reusing the one frozen at submit time.
    # /closing/day recomputes live, so a late collection posting after the BM
    # submitted meant the approver saw a red shortfall while the stored snapshot
    # said the day balanced -- the permanent record disagreeing with the screen it
    # claims to copy. With no bank feed this record is the whole audit trail.
    row = await db[COLL].find_one(
        {"date": body.date, "branch_code": body.branch_code}, {"_id": 0}) or {}
    deposited = round(sum(float(x.get("amount") or 0) for x in slips
                          if x.get("status") == "confirmed"), 2)
    opening = float(doc.get("opening_hold") or 0)
    live = _ledger(float(row.get("expected_deposit") or 0), opening, deposited,
                   doc.get("cash_counted"))

    now_iso = datetime.now(IST).isoformat()
    snapshot = {
        "ledger": live,
        "ledger_at_submit": doc.get("ledger"),
        "deposited": deposited,
        "cash_counted": doc.get("cash_counted"),
        "approved_by": current_user.get("employee_id"),
        "approved_at": now_iso,
        "slips": [{"id": x["id"], "amount": x.get("amount"),
                   "bank_name": x.get("bank_name"),
                   "reference_no": x.get("reference_no"),
                   "amount_was_corrected": x.get("amount_was_corrected")} for x in slips],
    }
    await db[DAYS].update_one(
        {"date": body.date, "branch_code": body.branch_code},
        {"$set": {
            "state": ST_APPROVED,
            "approved_by": current_user.get("employee_id"),
            "approved_at": now_iso,
            "approved_snapshot": snapshot,
        },
         # APPEND, never overwrite. A day can be returned and re-approved, and
         # $set alone erased the earlier approval completely: a Rs 90,000 sign-off
         # could be replaced by a Rs 10 one with nothing left to show the first
         # had ever happened.
         "$push": {"approval_history": snapshot}})
    return {"state": ST_APPROVED, "ledger": live}


@router.post("/reject")
async def reject_day(body: DayDecision, current_user: dict = Depends(get_current_user)):
    """Accounts: 'this does not match the bank.' Back to the BM with a reason."""
    if not await _is_closing_approver(current_user):
        raise HTTPException(status_code=403, detail="Not permitted to approve closings")
    if not (body.reason or "").strip():
        raise HTTPException(status_code=400,
                            detail="Give a reason — the BM has to know what to fix")
    doc = await db[DAYS].find_one(
        {"date": body.date, "branch_code": body.branch_code}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Nothing submitted for that branch and day")
    # Returning is for a day that is WITH Accounts. Without this check an already
    # approved day could be silently reopened, and a day that was never submitted
    # could be "rejected" -- both succeeded and neither means anything.
    # An approved day may be REOPENED, but only deliberately.
    #
    # It used to be flatly refused, which was right while the figures could not
    # move. They can: a collection posted after approval leaves a real difference
    # that has to be banked, and with no way back the branch was stuck showing a
    # hole it could not close. So an approver may reopen, the approval survives
    # in `approval_history`, and reopening is itself recorded.
    if doc.get("state") == ST_APPROVED:
        if not (body.reopen or doc.get("collections_changed_after_approval")):
            raise HTTPException(
                status_code=409,
                detail=("That day is approved. Reopening it discards the approval — "
                        "send reopen=true if that is what you mean."))
    elif doc.get("state") != ST_DEPOSITED:
        raise HTTPException(
            status_code=409,
            detail="That day has not been submitted, so there is nothing to return.")

    now_iso = datetime.now(IST).isoformat()
    upd = {
        "state": ST_AWAITING,
        "reject_reason": body.reason.strip()[:500],
        "rejected_by": current_user.get("employee_id"),
        "rejected_at": now_iso,
    }
    if doc.get("state") == ST_APPROVED:
        upd["reopened_from_approved_at"] = now_iso
        upd["approved_snapshot"] = None
        upd["collections_changed_after_approval"] = None
    await db[DAYS].update_one(
        {"date": body.date, "branch_code": body.branch_code}, {"$set": upd})

    # Tell the person who can fix it. Best effort: a failed push must not undo a
    # rejection that has already been recorded.
    try:
        from services.fcm import send_to_employee
        await send_to_employee(
            doc.get("submitted_by"),
            "Closing returned",
            f"{doc.get('branch_name')} {body.date}: {body.reason.strip()[:120]}")
    except Exception:
        logger.warning("closing: could not notify %s of rejection",
                       doc.get("submitted_by"), exc_info=True)
    return {"state": ST_AWAITING}


@router.get("/my-access")
async def my_closing_access(current_user: dict = Depends(get_current_user)):
    """Does this person hold the approval grant? Drives the nav item."""
    return {"can_approve": await _is_closing_approver(current_user)}


@router.post("/approvers/{employee_id}")
async def toggle_approver(employee_id: str, on: bool = Query(True),
                          current_user: dict = Depends(get_current_user)):
    """Grant or remove the closing-approval permission. HR Admin only.

    Exists because the person who does this job cannot be identified by role:
    the Accounts Manager is `role: employee`. Kept as an explicit per-person
    grant rather than a designation match, so nobody gains the ability to sign
    off cash by having their job title edited.
    """
    if not _roles_ok(current_user, {"hr_admin"}):
        raise HTTPException(status_code=403, detail="Not permitted")
    emp = await db.employees.find_one({"employee_id": employee_id}, {"_id": 0, "employee_id": 1})
    if not emp:
        raise HTTPException(status_code=404, detail="Employee not found")
    await db.employees.update_one({"employee_id": employee_id},
                                  {"$set": {"closing_approver": bool(on)}})
    logger.info("closing: approver grant for %s set to %s by %s",
                employee_id, bool(on), current_user.get("employee_id"))
    return {"employee_id": employee_id, "closing_approver": bool(on)}


@router.get("/approvers")
async def list_approvers(current_user: dict = Depends(get_current_user)):
    """Who can sign off a closing. Management and HR Admin always can."""
    if not _roles_ok(current_user, {"hr_admin", "management"}):
        raise HTTPException(status_code=403, detail="Not permitted")
    granted = await db.employees.find(
        {"closing_approver": True},
        {"_id": 0, "employee_id": 1, "first_name": 1, "last_name": 1,
         "designation": 1, "branch": 1}).to_list(50)
    return {"granted": granted,
            "note": "hr_admin and management can always approve; these are extra grants"}


# ══════════════════════════════════════════════════════════════════
#  Ingest — the MIS fetcher lives OUTSIDE this app
# ══════════════════════════════════════════════════════════════════
#
# The in-process poller cannot work here. This pod has no direct egress (raw TCP
# to radhyamfin.com:443 times out) and its only outbound route is a proxy that
# forwards to whitelisted LLM destinations, answering anything else with 405. So
# a Cloudflare Worker on the dashboard fetches the workbook and POSTs it here.
#
# WHY THE WORKER REPORTS FAILURES TOO, NOT JUST FILES
# ---------------------------------------------------
# If it only posted on success, this app could observe absence and nothing else —
# and "no data arrived" is indistinguishable from "there were genuinely no
# collections today". That ambiguity already cost a full day of debugging when
# the poller was in-process. Every run reports, so "unchanged", "failed" and
# "never ran" stay three different things.
#
# The alerting differs by kind because the urgency does. A wrong password is
# never transient and needs a human immediately; a connection blip at 17:03 does
# not deserve a push notification.
#
# ON THE FILE ITSELF: it carries member names, phone numbers, husbands' names,
# member IDs and loan numbers -- 35 columns of which this app reads 7. Sending
# the whole workbook was a deliberate decision, so this endpoint holds up the
# other end of it: the bytes are parsed in memory and dropped, never written
# anywhere, and no request body is logged at any level.

INGEST_STATE_KEY = "mis_fetcher"      # shares the state doc with /status
MAX_INGEST_BYTES = 25 * 1024 * 1024

# Kinds the Worker may report. Anything else is treated as "other".
#
# "bug" earns immediate alerting for the same reason "auth" does: it will never
# fix itself. The fetcher's first live run died on a TypeError in its own code
# and was reported as "network" -- which waits 30 minutes before telling anyone.
# A broken deploy at 17:00 would have been indistinguishable from a flaky line
# on the evening the figures mattered most.
_ALERT_NOW = {"auth", "blocked", "bug"}   # a human must act; never transient
_ALERT_IF_SUSTAINED_MIN = 30              # everything else


class IngestReport(BaseModel):
    status: str                        # "ok" | "error"
    date: Optional[str] = None         # YYYY-MM-DD; defaults to today IST
    file_b64: Optional[str] = None     # the .xlsx, when status == ok
    error: Optional[str] = None
    kind: Optional[str] = None         # auth|blocked|bug|network|shape|other
    source: Optional[str] = None       # e.g. "cloudflare-worker"
    # True when the fetcher could not read the date it was working on and had to
    # guess. It arises from the worst case on that side: a request consumed,
    # then the read fails mid-body, so the day being reported is salvaged or
    # assumed. Without this we would have to parse an English sentence to know
    # whether a failure is a fact about today or a shrug.
    date_uncertain: bool = False


def _ingest_token_ok(supplied: Optional[str]) -> bool:
    """Constant-time compare against CLOSING_INGEST_TOKEN.

    `secrets.compare_digest` rather than `==`: a plain comparison returns as soon
    as it finds a differing byte, which leaks the length of the shared prefix to
    anyone willing to time it. Cheap to get right, embarrassing to get wrong on
    the endpoint that accepts a financial feed.
    """
    import secrets as _secrets
    expected = os.environ.get("CLOSING_INGEST_TOKEN") or ""
    if not expected or not supplied:
        return False
    # compare_digest raises TypeError on a str containing a byte above 0x7F, and
    # Starlette decodes headers as latin-1 -- so any high byte in the header
    # produced an UNAUTHENTICATED 500 instead of a 401. Compare bytes.
    try:
        return _secrets.compare_digest(supplied.strip().encode("utf-8", "surrogateescape"),
                                       expected.strip().encode("utf-8", "surrogateescape"))
    except Exception:
        return False


async def _note_fetch_attempt(day: str, ok: bool, detail: str, kind: str = None,
                              changed: bool = False, warnings: list = None):
    """Record an external fetch attempt where /status can see it."""
    await _stamp_run(INGEST_STATE_KEY, day, ok, detail, kind=kind or "",
                     changed=changed, warnings=warnings, source="external")


async def _alert_fetch_failure(kind: str, detail: str, day: str):
    """Tell HO and Accounts, but only when it is worth telling them.

    `auth` and `blocked` need a person and will not fix themselves, so they go
    out on the first occurrence. Everything else waits until it has been failing
    for half an hour -- a blip during the evening window should not push a
    notification to four people.
    """
    st = await db[STATE].find_one({"_id": INGEST_STATE_KEY}) or {}
    if kind not in _ALERT_NOW:
        # THIS DAY's failure clock, and no reset for a long gap.
        #
        # The clock used to be global with a two-hour "new episode" rule, which
        # made sense for a poller running every ten minutes and is wrong now that
        # fetches happen when somebody taps. Three hours of a dead MIS with taps
        # at 18:00, 21:00 and 21:05 restarted the clock at 21:00 and alerted
        # NOBODY -- a gap between taps is a normal evening, not a quiet night.
        # And a stale clock left by a failed backfill made a later blip on a
        # different day read as "failing for 35 minutes" and page everyone.
        since = (st.get(f"run_{day}") or {}).get("failing_since")
        if not since:
            return
        try:
            mins = (datetime.now(IST) - datetime.fromisoformat(since)).total_seconds() / 60
        except Exception:
            return
        if mins < _ALERT_IF_SUSTAINED_MIN:
            return

    # Don't repeat the same alert every ten minutes for the rest of the evening.
    #
    # Throttled PER KIND. One global timestamp meant a sustained network alert at
    # 17:00 swallowed a genuine `auth` failure at 17:20 -- and auth/blocked/bug
    # are in _ALERT_NOW precisely because they must not wait. A blip cannot be
    # allowed to cancel the guarantee for the next hour.
    last = st.get(f"last_alert_at_{kind}") or (
        st.get("last_alert_at") if kind not in _ALERT_NOW else None)
    if last:
        try:
            if (datetime.now(IST) - datetime.fromisoformat(last)).total_seconds() < 3600:
                return
        except Exception:
            pass

    msg = {
        "auth": "The MIS rejected the collections login. Check the password for "
                "the read-only MIS account — today's figures have stopped.",
        "blocked": "The MIS is blocking the automated collections fetch. "
                   "Today's figures have stopped updating.",
        # Named as ours, not the vendor's. Whoever reads this at 17:05 should not
        # go and ring the MIS people about a mistake on our side.
        "bug": "The collections fetcher has crashed — this is a fault in our own "
               "code, not the MIS. Today's figures have stopped updating.",
    }.get(kind,f"Collections have not updated for {_ALERT_IF_SUSTAINED_MIN}+ minutes ({detail}).")

    try:
        from services.fcm import send_to_employee
        emps = await db.employees.find(
            {"$or": [{"role": {"$in": ["hr_admin", "management"]}},
                     {"closing_approver": True}]},
            {"_id": 0, "employee_id": 1}).to_list(20)
        if not emps:
            # An alert with no recipients is the same as no alert, and it would
            # look identical from here -- the send loop simply runs zero times.
            # Say so, loudly, rather than believing someone was told.
            logger.error("closing: fetcher failed (%s) and NOBODY could be alerted "
                         "— no hr_admin/management/approver found", kind)
            return
        for e in emps:
            await send_to_employee(e.get("employee_id"), "Daily closing", msg)
        logger.info("closing: alerted %d people about a %s failure", len(emps), kind)
        stamp = datetime.now(IST).isoformat()
        await db[STATE].update_one(
            {"_id": INGEST_STATE_KEY},
            {"$set": {"last_alert_at": stamp, f"last_alert_at_{kind}": stamp}},
            upsert=True)
    except Exception:
        logger.warning("closing: could not send fetch-failure alert", exc_info=True)


@router.post("/ingest")
async def ingest_report(body: IngestReport, x_ingest_token: str = Header(None)):
    """Receive a day's workbook — or a report that fetching it failed.

    Deliberately NOT behind get_current_user: the caller is a Worker, not a
    person. Auth is a shared secret in CLOSING_INGEST_TOKEN.
    """
    if not _ingest_token_ok(x_ingest_token):
        # Same answer whether the token is absent, wrong, or unconfigured — a
        # different message for each would let a caller map the surface.
        raise HTTPException(status_code=401, detail="Not authorised")

    try:
        day = date_cls.fromisoformat(body.date) if body.date else today_ist()
    except ValueError:
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")
    day_str = day.isoformat()

    # ---- the Worker is telling us it failed -------------------------------
    if (body.status or "").lower() != "ok":
        kind = (body.kind or "other").lower()
        detail = (body.error or "no detail")[:300]
        if body.date_uncertain:
            # Say so on the screen. Filing this as a plain fact about the day
            # would put "the MIS fetch failed" against figures that may be
            # perfectly current, for a day the fetcher was not even sure it was
            # working on.
            detail = f"{detail} (the fetcher could not confirm which day this was)"
        await _note_fetch_attempt(day_str, False, f"{kind}: {detail}", kind=kind)
        await _alert_fetch_failure(kind, detail, day_str)
        logger.warning("closing: fetcher reported %s for %s%s: %s", kind, day_str,
                       " (date uncertain)" if body.date_uncertain else "", detail)
        return {"ok": False, "recorded": True, "kind": kind,
                "date_uncertain": bool(body.date_uncertain)}

    if not body.file_b64:
        raise HTTPException(status_code=400, detail="status=ok requires file_b64")
    if len(body.file_b64) > MAX_INGEST_BYTES:
        raise HTTPException(status_code=413, detail="workbook too large")

    import base64 as _b64
    try:
        raw = _b64.b64decode(body.file_b64, validate=True)
    except Exception:
        await _note_fetch_attempt(day_str, False, "shape: file_b64 was not valid base64",
                                  kind="shape")
        raise HTTPException(status_code=400, detail="file_b64 is not valid base64")

    # The site answers an expired session with HTTP 200 and a login page, so a
    # fetcher that trusts status codes will happily post HTML. Check the bytes.
    if not raw.startswith(b"PK\x03\x04"):
        await _note_fetch_attempt(
            day_str, False, f"shape: not an .xlsx ({len(raw)} bytes)", kind="shape")
        raise HTTPException(
            status_code=400,
            detail=f"that is not an .xlsx — {len(raw)} bytes, no ZIP header. "
                   "An expired MIS session returns HTTP 200 with the login page.")

    try:
        report = parse_demand_collection(raw, expect_day=day)
    except MISParseError as e:
        await _note_fetch_attempt(day_str, False, f"parse failed: {e}", kind="shape")
        # A vendor column rename stops every figure in the system. Silence here
        # meant six consecutive failures pushed nothing to anybody, ever.
        await _alert_fetch_failure("shape", str(e), day_str)
        raise HTTPException(status_code=422, detail=str(e))
    digest = _content_digest(report)

    warnings = list(report.warnings) + check_expected_branches(report, EXPECTED_BRANCHES)
    conflicts = storage_conflicts(report, day) + await _cross_pull_conflicts(report, day_str)
    if conflicts:
        detail = "not stored: " + "; ".join(conflicts)
        await _note_fetch_attempt(day_str, False, detail, kind="shape",
                                  warnings=warnings + conflicts)
        await _alert_fetch_failure("shape", detail, day_str)
        logger.error("closing %s: %s", day_str, detail)
        # 409, not 200. A refusal to store answered with a success status, and a
        # caller that keys its retry and its own failure log on the HTTP status
        # would record a clean run for a day that stored nothing.
        raise HTTPException(status_code=409, detail=detail)

    # Serialised per day. The digest read, the row writes and the digest write
    # are a check-then-act: if a retried older body's rows landed after a fresher
    # body's digest, every later pull would answer "unchanged" against a digest
    # that was never written for the rows on disk, and the day would sit frozen
    # on a stale figure forever. This closes it within one process; a second
    # worker process would need the write to be conditional on the old digest.
    async with _ingest_lock(day_str):
        prev = await db[STATE].find_one({"_id": INGEST_STATE_KEY}) or {}
        if prev.get(f"digest_{day_str}") == digest:
            # Same figures as last time. Still a successful run -- recording it is
            # what keeps "nothing changed" apart from "the fetcher died".
            await _note_fetch_attempt(day_str, True, "unchanged", warnings=warnings)
            return {"ok": True, "changed": False, "date": day_str,
                    "branches": len(report.branches), "warnings": warnings}

        now_iso = datetime.now(IST).isoformat()
        for b in report.branches:
            doc = b.as_dict()
            doc["date"] = day_str      # the day asked for, never the row's own
            doc.update({"fetched_at": now_iso, "source": body.source or "worker",
                        "warnings": warnings})
            await db[COLL].update_one(
                {"date": day_str, "branch_code": doc["branch_code"],
                 "branch_name": doc["branch_name"]},
                {"$set": doc}, upsert=True)

        await db[STATE].update_one({"_id": INGEST_STATE_KEY},
                                   {"$set": {f"digest_{day_str}": digest}}, upsert=True)

    drifted = await _flag_post_approval_drift(day_str, report)
    await _note_fetch_attempt(day_str, True, f"stored {len(report.branches)} branch(es)",
                              changed=True, warnings=warnings + drifted)
    if warnings or drifted:
        logger.warning("closing %s: %s", day_str, "; ".join(warnings + drifted))

    # `raw` goes out of scope here and is never written anywhere. Only the
    # per-branch totals above and the digest survive this function.
    return {"ok": True, "changed": True, "date": day_str,
            "branches": len(report.branches), "cash": report.total_cash,
            "upi": report.total_upi, "warnings": warnings + drifted}
