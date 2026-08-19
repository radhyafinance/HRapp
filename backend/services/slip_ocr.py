"""
Read an amount off a bank deposit slip.

WHAT THIS IS FOR, AND WHAT IT IS NOT
------------------------------------
A Branch Manager photographs the slip for the cash they banked; this proposes
the amount so they are correcting a number rather than typing one at 9pm.

**Nothing here is authoritative.** The extracted figure is a suggestion the BM
must confirm, and the day is reconciled against the CONFIRMED value, never this
one. That is not caution for its own sake: OCR was removed from the odometer
flow six weeks ago because it was wrong too often, and that was a distance
reading nobody banks. This is cash, per branch, per night.

WHY EXTRACTION AND NOT VERIFICATION
-----------------------------------
The first design asked the model a much easier question -- "does this slip show
Rs 1,54,702?" -- because the MIS already tells us what the branch owes.
Verification against a known figure is far more reliable than open-ended
reading. That went away when it turned out branches make MULTIPLE deposits a
day across any of four banks: no single slip matches a known total any more, so
each one has to be genuinely read.

What survives is a check at the sum level -- the confirmed slips for a branch
must add up to what the day owes, less whatever cash is still in hand. That
catches a misread; it does not prevent one. Hence the BM's confirmation being
the primary control rather than a formality.

THE PAPER IS THE HARD PART
--------------------------
These are largely BC/merchant receipts, PNB included, not bank counterfoils:
thermal print, varied layouts, no standard field positions, photographed in
poor light. So the prompt asks for the figure in BOTH digits and words -- Indian
slips usually carry both -- and disagreement between them is reported rather
than resolved. A model that cannot read the slip must say so, not guess.
"""

import asyncio
import base64
import binascii
import json
import logging
import os
import re
import tempfile
import uuid
from datetime import date as date_cls, timedelta

logger = logging.getLogger(__name__)

MODEL = "gemini-2.5-flash"

# How many slips may be read at once.
#
# Not a performance knob -- a guard on the gateway and on memory. Each read holds
# a worker thread and a decoded image for a few seconds; four covers a branch
# emptying its pocket at 21:00 without letting a stuck queue open twenty
# connections at once.
OCR_CONCURRENCY = 4
_slots = None


def _ocr_slots():
    """The semaphore, created on first use rather than at import.

    A module-level asyncio.Semaphore() binds to whichever loop is running when
    it is constructed, and this module is imported at startup -- before the
    server's loop exists on some versions. Created here, it is always born on
    the loop that will actually await it.
    """
    global _slots
    if _slots is None:
        _slots = asyncio.Semaphore(OCR_CONCURRENCY)
    return _slots

# 12 MB of base64 is roughly a 9 MB photo. Above that it is a screenshot of a
# video or a scan nobody needs at that size, and it costs a slow upload on a
# field phone.
MAX_B64_CHARS = 12 * 1024 * 1024

ALLOWED_MIME = {"image/jpeg", "image/jpg", "image/png", "image/webp", "application/pdf"}

# What we actually keep and actually send to the model. The browser already
# shrinks before upload, but that is the CLIENT deciding how big our database
# rows are — a stale app version, a different browser, or anyone calling the API
# directly would put a full 8 MB camera frame into a Mongo document and into
# every OCR request. So the server re-encodes regardless of what arrived.
#
# 1600px on the long edge is comfortably enough to read a thermal receipt: the
# digits on a Fino slip are ~40px tall at that size. Larger costs upload time on
# a 2G village connection and buys nothing.
STORE_MAX_PX = 1600
STORE_QUALITY = 80

_PROMPT = """You are reading a bank deposit receipt from an Indian bank or a
business-correspondent / merchant cash-deposit point (ICICI, PNB, Axis or Fino).
It may be a thermal-printed receipt, a stamped paper counterfoil, or a
screenshot from a banking app.

Return ONLY a JSON object with exactly these keys:

{
  "receipts_visible": how many SEPARATE deposit receipts are visible in this
                      image (count them; a single slip is 1),
  "is_deposit_receipt": true or false,
  "amount_digits": the deposited amount as a plain number, no commas, no currency
                   symbol, or null if you cannot read it,
  "amount_words": the amount as written in words on the slip, or null if absent,
  "deposit_date": "YYYY-MM-DD" or null,
  "bank_name": the bank as printed, or null,
  "account_last4": last 4 digits of the credited account, or null,
  "reference_no": transaction / journal / UTR / receipt number, or null,
  "legible": true if you could read the amount confidently, false if the image
             is blurred, cropped, glared or otherwise unclear,
  "notes": one short sentence on anything odd, or null
}

Rules you must follow:
- COUNT THE RECEIPTS FIRST. Branches sometimes photograph several receipts laid
  out on one page. If receipts_visible is more than 1, set amount_digits to null
  — do NOT return one of them and do NOT add them up.
- If this is NOT a cash deposit receipt (for example a withdrawal slip, a
  passbook page, a cheque, or an unrelated photo), set is_deposit_receipt to
  false and amount_digits to null.
- Report the amount CREDITED to the account. Ignore any balance, charges,
  or previous-balance figure printed alongside it.
- If you cannot read the amount, set amount_digits to null and legible to false.
  Do NOT guess a plausible number.
- DATES ON THESE SLIPS ARE DAY/MONTH/YEAR, which is how India writes them.
  "18/08/26" is the 18th of August 2026 -- it is NOT 2018, and it is NOT the
  26th. A two-digit year is 20xx. Convert to YYYY-MM-DD before returning it, and
  return null rather than guessing if the date is unclear or absent.
- Return the JSON only. No explanation, no markdown fence."""


class SlipOCRError(Exception):
    """The slip could not be processed. Never carries the image or the API key."""


# Anchored on purpose. The first version stripped every non-digit and kept the
# dot, so "Rs. 154702" became 0.154702 -- and because that IS a number, nothing
# flagged it: the BM's box was prefilled with Rs 0.15 at 9pm with no warning.
# Scraping digits out of arbitrary text cannot distinguish a misparse from a
# reading, so the whole string must match a shape we recognise or we return None.
_AMOUNT_RE = re.compile(
    r"^\s*(?:rs\.?|inr|₹)?\s*"          # optional currency prefix
    r"(\d{1,3}(?:,\d{2,3})*|\d+)"        # 1,54,702 / 154,702 / 154702
    r"(?:\.(\d{1,2}))?"                  # optional paise
    r"\s*(?:/-|only)?\s*$",              # optional Indian trailing forms
    re.IGNORECASE,
)


def _coerce_amount(v):
    """A number from whatever the model returned, or None.

    Returns None whenever it is not certain. That is the contract the rest of
    this module depends on: a None sets `needs_review` and puts the slip in front
    of the BM, while a confidently wrong number is silently accepted.

    bool is rejected explicitly — it is a subclass of int, so `True` would
    otherwise arrive as the amount 1.0.
    """
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        # NaN/inf are numbers to Python but not to a bank.
        f = float(v)
        return f if f == f and abs(f) != float("inf") else None
    if not isinstance(v, str):
        # A dict or list str()s into something digit-scrapable; refuse it.
        return None
    m = _AMOUNT_RE.match(v)
    if not m:
        return None
    whole = m.group(1).replace(",", "")
    frac = m.group(2) or "0"
    try:
        return float(f"{whole}.{frac}")
    except ValueError:
        return None


def normalise_image(b64: str, mime: str) -> tuple:
    """Shrink and re-encode before anything else touches it. -> (b64, mime, note)

    Runs BEFORE storage and BEFORE the OCR call, so both get the small version.
    Doing it only in the browser would leave the size of a financial record --
    and of every model request -- up to whatever client happened to call us.

    PDFs pass through untouched: Pillow cannot rasterise them without poppler,
    which is not installed, and a bank's PDF e-receipt is small anyway. The
    length cap still applies to them.

    A file that cannot be decoded is returned unchanged rather than rejected.
    The BM is standing at a bank at 9pm; an unusual-but-valid image should reach
    a human, not a 400.
    """
    if mime == "application/pdf":
        return b64, mime, None
    try:
        import io
        from PIL import Image, ImageOps

        raw = base64.b64decode(b64)
        before = len(raw)
        img = Image.open(io.BytesIO(raw))
        # Phone cameras record rotation in EXIF rather than in the pixels. Without
        # this a slip photographed in portrait reaches the model on its side, and
        # a sideways thermal receipt is exactly what it reads worst.
        img = ImageOps.exif_transpose(img)
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        img.thumbnail((STORE_MAX_PX, STORE_MAX_PX), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=STORE_QUALITY, optimize=True)
        out = buf.getvalue()
        if len(out) >= before and mime == "image/jpeg":
            # Already smaller than our re-encode. Keep the original rather than
            # spending a generation of JPEG quality for nothing.
            return b64, mime, None
        note = f"resized {before // 1024}KB -> {len(out) // 1024}KB"
        return base64.b64encode(out).decode("ascii"), "image/jpeg", note
    except Exception:
        logger.warning("slip image could not be normalised; storing as received",
                       exc_info=True)
        return b64, mime, None


def _call_model(prompt: str, path: str, mime: str) -> str:
    """The model call, start to finish, ON A WORKER THREAD.

    EVERYTHING here happens inside the thread on purpose -- the client is built
    here too, not passed in, so the session it opens belongs to the same loop
    that will use it.

    WHY THIS IS NOT SIMPLY AWAITED
    ------------------------------
    `chat.send_message` is a coroutine whose insides block. A coroutine that
    never yields cannot be cancelled, and while it runs NOTHING else in the
    process runs: not another slip, not an attendance punch, not the dashboard.
    One branch manager photographing a receipt stalled the whole app.

    Measured on 19-Aug, from the stored read timings:

        14:27:44  BUDAUN     50.6s      <- two uploads, six seconds apart
        14:27:50  BUDAUN     never finished
        14:57:46  BUDAUN      5.9s      <- every slip uploaded ALONE
        15:46:59  NAJIBABAD   3.5s
        15:59:29  NAJIBABAD   5.6s

    Perfect correlation, and the 50.6s sailed straight past a 25-second
    asyncio.wait_for that therefore never fired. Concurrent uploads are the
    feature the deposit panel now invites, and they were the one thing that
    broke it.

    Running it here restores both halves: reads overlap, and the timeout in the
    caller can actually interrupt the wait.
    """
    from emergentintegrations.llm.chat import (LlmChat, UserMessage,
                                               FileContentWithMimeType)
    chat = LlmChat(
        api_key=os.environ.get("EMERGENT_LLM_KEY"),
        session_id=f"slip-{uuid.uuid4()}",
        system_message=("You read Indian bank deposit receipts. You are precise, "
                        "and you say when you cannot read something rather than "
                        "guessing. You return only valid JSON."),
    ).with_model("gemini", MODEL)
    return asyncio.run(chat.send_message(UserMessage(
        text=prompt,
        file_contents=[FileContentWithMimeType(file_path=path, mime_type=mime)],
    )))


async def _gemini_vision(prompt: str, b64: str, mime: str) -> dict:
    """Same path candidates.py already uses for KYC OCR — proven in this app."""
    suffix = ".pdf" if mime == "application/pdf" else (".png" if "png" in mime else ".jpg")
    path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
            f.write(base64.b64decode(b64))
            path = f.name
        # The slot is released on cancellation too -- `async with` unwinds when
        # the caller's timeout fires. The THREAD cannot be killed and runs to
        # completion in the background; Python has no way to interrupt one. That
        # is accepted: it finishes, its answer is dropped, and the slip has
        # already been settled as unreadable so the BM types the amount.
        async with _ocr_slots():
            response = await asyncio.to_thread(_call_model, prompt, path, mime)
    finally:
        if path:
            try:
                os.unlink(path)
            except Exception:
                pass

    m = re.search(r"\{.*\}", response or "", re.DOTALL)
    if not m:
        raise SlipOCRError("the model did not return a readable result")
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError as e:
        raise SlipOCRError(f"the model's result could not be parsed: {e}") from e


async def extract_deposit_slip(b64: str, mime: str) -> dict:
    """Propose what this slip says. The caller must have a human confirm it.

    Returns a dict that always includes `amount` (float or None) and `needs_review`
    (bool). `needs_review` is True whenever anything is off — unreadable, not a
    deposit receipt, or digits and words disagreeing — so the UI can put those in
    front of the BM rather than letting them tap through.
    """
    mime = (mime or "").lower().strip()
    if mime == "image/jpg":
        mime = "image/jpeg"
    if mime not in ALLOWED_MIME:
        raise SlipOCRError(f"unsupported file type: {mime or 'unknown'}")
    if not b64:
        raise SlipOCRError("no image was received")
    if len(b64) > MAX_B64_CHARS:
        raise SlipOCRError("that image is too large — please retake it at a lower quality")
    try:
        base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError):
        raise SlipOCRError("the image could not be decoded")

    if not os.environ.get("EMERGENT_LLM_KEY"):
        # Explicit, because the alternative is a confusing library error and a
        # BM being told their slip is unreadable when nothing is wrong with it.
        raise SlipOCRError("slip reading is not configured (EMERGENT_LLM_KEY is unset)")

    try:
        raw = await _gemini_vision(_PROMPT, b64, mime)
    except SlipOCRError:
        raise
    except Exception as e:
        logger.warning("slip OCR failed", exc_info=True)
        raise SlipOCRError(f"could not read the slip ({type(e).__name__})") from e

    amount = _coerce_amount(raw.get("amount_digits"))
    words = raw.get("amount_words")
    legible = bool(raw.get("legible"))
    is_receipt = bool(raw.get("is_deposit_receipt"))

    reasons = []

    # MORE THAN ONE RECEIPT IN THE FRAME IS THE MOST DANGEROUS INPUT THIS
    # FUNCTION CAN GET, and the only one that fails silently. A real page of five
    # ICICI ATM receipts totalled Rs 95,900; asked for "the amount", a model
    # returns one of them, the BM confirms it, and the day is short by Rs 55,400
    # with every screen green. Branches are instructed to upload one slip at a
    # time -- this is here for when someone doesn't, because a process rule makes
    # the mistake rarer, not detectable.
    try:
        n_receipts = int(raw.get("receipts_visible") or 1)
    except (TypeError, ValueError):
        n_receipts = 1
    if n_receipts > 1:
        amount = None
        reasons.append(
            f"this photo shows {n_receipts} separate receipts — photograph and "
            "upload them one at a time so each amount is recorded")

    if not is_receipt:
        reasons.append("this does not look like a deposit receipt")
    if amount is None:
        reasons.append("the amount could not be read")
    if not legible:
        reasons.append("the image is unclear")
    if amount is not None and amount <= 0:
        reasons.append("the amount read is not a positive number")

    # Digits vs words. Indian slips normally carry both, and a mismatch is the
    # single most useful signal that a digit was misread — a 5 read as a 6 changes
    # the figure without making it look wrong.
    words_num = _words_to_number(words) if words else None
    if amount is not None and words_num is not None and abs(words_num - amount) >= 1:
        reasons.append(f"the figure ({amount:,.0f}) and the words ({words_num:,.0f}) disagree")

    return {
        "amount": amount,
        "receipts_visible": n_receipts,
        "amount_words": words,
        "deposit_date": _plausible_date(raw.get("deposit_date")),
        "bank_name": raw.get("bank_name"),
        "account_last4": raw.get("account_last4"),
        "reference_no": raw.get("reference_no"),
        "legible": legible,
        "is_deposit_receipt": is_receipt,
        "notes": raw.get("notes"),
        "needs_review": bool(reasons),
        "review_reasons": reasons,
    }


# How far back a slip's own date may sit before we stop believing we read it.
# A deposit slip being closed against is days old at most; a year of slack is
# generous and still rules out a century-scale misread.
_MAX_SLIP_AGE_DAYS = 400


def _plausible_date(value):
    """The slip's own date, or None when we clearly did not read it.

    A MISREAD DATE MUST NOT BECOME AN ACCUSATION. `/closing/slips` compares this
    against the day being closed and warns when they differ, which is a real and
    useful check -- yesterday's slip filed against today's cash is a mistake
    nothing else here would catch.

    But the model read the printed "18/08/26" as 2018-08-26, taking the day for a
    year, and produced:

        this slip is dated 2018-08-26, but you are closing 2026-08-18

    on a slip that was perfectly correct. Fired on every slip, that warning
    becomes wallpaper, and the one genuine instance disappears into it -- the
    same way the post-approval drift alarm did before it was fixed.

    The prompt now states the day/month/year convention. This is the second
    line: a date outside the range a deposit slip can sensibly carry is treated
    as unread rather than reported, because "no date" costs one silent check
    while a wrong date costs the credibility of all of them.
    """
    if not value:
        return None
    m = re.match(r"^\s*(\d{4})-(\d{2})-(\d{2})\s*$", str(value))
    if not m:
        return None
    try:
        d = date_cls(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None
    # Two days forward, because the server may be an hour behind IST and a slip
    # can be photographed just after midnight.
    today = date_cls.today()
    if d > today + timedelta(days=2) or d < today - timedelta(days=_MAX_SLIP_AGE_DAYS):
        logger.info("slip date %s is outside the plausible range; not reporting it", d)
        return None
    return d.isoformat()


_UNITS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
    "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16,
    "seventeen": 17, "eighteen": 18, "nineteen": 19, "twenty": 20,
    "thirty": 30, "forty": 40, "fourty": 40, "fifty": 50, "sixty": 60,
    "seventy": 70, "eighty": 80, "ninety": 90,
}
_SCALES = {"hundred": 100, "thousand": 1000, "lakh": 100000, "lac": 100000,
           "lakhs": 100000, "lacs": 100000, "crore": 10000000, "crores": 10000000}


def _words_to_number(text):
    """Best-effort Indian amount-in-words -> number, or None.

    ENGLISH ONLY, and that is a real gap: most handwritten PNB pay-in slips
    write the amount in Hindi ("चौबीस हजार एक सौ बीस"), so this returns None and
    the digits-vs-words cross-check -- the best defence against a misread digit --
    is simply unavailable on exactly the slips whose digits are hardest to read.
    It does work on PNB thermal receipts and ICICI ATM slips, which print English
    words. Returning None is the safe failure; a wrong reading would raise a
    false mismatch on a good slip.

    Only used to CONTRADICT the digits, never to replace them. So it must return
    None whenever it is unsure: a wrong reading here would raise a false mismatch
    on a perfectly good slip, and warnings that fire on good slips stop being read.
    """
    if not text:
        return None
    words = re.findall(r"[a-z]+", str(text).lower())
    words = [w for w in words if w not in ("rupees", "rupee", "only", "and", "rs", "inr")]
    if not words or any(w not in _UNITS and w not in _SCALES for w in words):
        return None
    total = 0
    current = 0
    for w in words:
        if w in _UNITS:
            current += _UNITS[w]
        else:
            scale = _SCALES[w]
            if scale == 100:
                current = (current or 1) * 100
            else:
                total += (current or 1) * scale
                current = 0
    return float(total + current) or None
