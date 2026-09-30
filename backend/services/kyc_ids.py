"""Aadhaar and PAN number rules shared by every place that reads or stores them.

One module so the self-onboarding link, the HR scan, manual entry and the KYC
gate cannot disagree about what counts as a usable Aadhaar number. They did: the
invite link blanked anything that was not 12 digits (silently), while the HR
scan kept whatever the model returned — so a masked "XXXXXXXX1234" could be
saved AS the Aadhaar number and printed on a joining kit.
"""
import re

# Verhoeff tables. UIDAI issues Aadhaar numbers with a Verhoeff check digit, so
# a single mistyped digit or a swap of two neighbours is always caught.
_D = (
    (0, 1, 2, 3, 4, 5, 6, 7, 8, 9), (1, 2, 3, 4, 0, 6, 7, 8, 9, 5),
    (2, 3, 4, 0, 1, 7, 8, 9, 5, 6), (3, 4, 0, 1, 2, 8, 9, 5, 6, 7),
    (4, 0, 1, 2, 3, 9, 5, 6, 7, 8), (5, 9, 8, 7, 6, 0, 4, 3, 2, 1),
    (6, 5, 9, 8, 7, 1, 0, 4, 3, 2), (7, 6, 5, 9, 8, 2, 1, 0, 4, 3),
    (8, 7, 6, 5, 9, 3, 2, 1, 0, 4), (9, 8, 7, 6, 5, 4, 3, 2, 1, 0),
)
_P = (
    (0, 1, 2, 3, 4, 5, 6, 7, 8, 9), (1, 5, 7, 6, 2, 8, 3, 0, 9, 4),
    (5, 8, 0, 3, 7, 9, 6, 1, 4, 2), (8, 9, 1, 6, 0, 4, 3, 5, 2, 7),
    (9, 4, 5, 3, 1, 2, 6, 8, 7, 0), (4, 2, 8, 6, 5, 7, 3, 9, 0, 1),
    (2, 7, 9, 3, 8, 0, 6, 4, 1, 5), (7, 0, 4, 6, 9, 1, 3, 2, 5, 8),
)


def verhoeff_ok(digits: str) -> bool:
    # ASCII only: str.isdigit() and \d also accept Devanagari and other digit
    # scripts, which the screen's check (and every other system) rejects.
    if not digits or not re.fullmatch(r"[0-9]+", digits):
        return False
    c = 0
    for i, ch in enumerate(reversed(digits)):
        c = _D[c][_P[i % 8][int(ch)]]
    return c == 0


def aadhaar_is_valid(value) -> bool:
    """12 digits, not starting with 0 or 1 (no Aadhaar does), valid check digit."""
    s = str(value or "")
    return bool(re.fullmatch(r"[2-9][0-9]{11}", s)) and verhoeff_ok(s)


PAN_RE = re.compile(r"^[A-Z]{5}[0-9]{4}[A-Z]$")


def pan_is_valid(value) -> bool:
    return bool(PAN_RE.match(str(value or "")))


AADHAAR_MESSAGES = {
    "ok": "",
    "masked": ("This is a masked Aadhaar — only the last 4 digits are printed. "
               "The full Aadhaar is needed."),
    "unreadable": ("The Aadhaar number couldn't be read reliably. Upload a clearer photo "
                   "of the full Aadhaar, or enter the number by hand."),
    "missing": ("No Aadhaar number was found on these images. Upload clear photos of the "
                "full Aadhaar, or enter the number by hand."),
}


# The same outcomes worded for the CANDIDATE on the self-onboarding page, who
# has no "enter by hand" option and must not be told to use one.
CANDIDATE_MESSAGES = {
    "masked": ("Your Aadhaar looks masked — only the last 4 digits are printed. Please upload "
               "photos of your full Aadhaar (front and back), not the masked version downloaded "
               "from UIDAI."),
    "unreadable": ("We couldn't read your Aadhaar number clearly. Please upload a sharper, "
                   "well-lit photo of the front of your full Aadhaar."),
    "missing": ("We couldn't find an Aadhaar number on these images. Please upload clear photos "
                "of the front and back of your full Aadhaar."),
}


def classify_aadhaar(raw, model_says_masked=False):
    """What a scan returned, turned into (number_to_store, status).

    Only a VALID number is ever returned for storing; everything else comes back
    as "" with a reason, so nothing downstream can mistake a masked or misread
    number for a real one.

    status: "ok" | "masked" | "unreadable" | "missing"
    """
    text = str(raw or "").strip()
    digits = re.sub(r"[^0-9]", "", text)
    # The scanner saying "masked" wins even over 12 digits that pass the check
    # digit. A scanner that ignores "never fill in masked digits" and invents
    # the first eight produces a check-valid number about one time in ten —
    # exactly the wrong-number-on-a-joining-kit this module exists to prevent.
    # If the card really was full, HR can still type the number by hand.
    if model_says_masked is True:
        return "", "masked"
    if aadhaar_is_valid(digits):
        return digits, "ok"
    # A masked card prints XXXX XXXX 1234 — letters or stars where digits
    # should be, or just the last 4 (or 8) digits once those are stripped.
    if re.search(r"[xX*•●]", text) or (digits and len(digits) in (4, 8)):
        return "", "masked"
    if not digits:
        return "", "missing"
    return "", "unreadable"      # e.g. 12 digits failing the check digit: a misread


def masked_flag(extracted: dict) -> bool:
    """The scanner's own yes/no on masking, however it chose to spell it."""
    v = (extracted or {}).get("aadhaar_masked")
    if isinstance(v, bool):
        return v
    return str(v or "").strip().lower() in ("true", "yes", "1")


AADHAAR_PROMPT_MASK_RULE = (
    '"aadhaar_masked":true if the Aadhaar number is printed masked (only the last 4 '
    'digits visible, e.g. XXXX XXXX 1234), otherwise false'
)
