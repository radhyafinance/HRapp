from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional
from database import db
from auth_utils import get_current_user
from datetime import datetime, timezone
import re


router = APIRouter()


COMPANY_KEY = "company"


class CompanySettings(BaseModel):
    company_name: Optional[str] = "Radhya Micro Finance Private Limited"
    company_short_code: Optional[str] = "RMF0001"
    debit_account_no: Optional[str] = ""
    debit_account_ifsc: Optional[str] = ""
    debit_bank_name: Optional[str] = ""
    transaction_type: Optional[str] = "NFT"  # NFT, RTG, IFC, WIB
    address: Optional[str] = ""
    cin: Optional[str] = ""
    phone: Optional[str] = ""
    email: Optional[str] = ""
    website: Optional[str] = ""


@router.get("/company")
async def get_company(current_user: dict = Depends(get_current_user)):
    """HR and management only — this document carries the company's bank details.

    It holds debit_account_no, debit_account_ifsc and debit_bank_name, which are
    the account salaries are paid FROM. Until this gate existed the endpoint was
    open to anyone with a login, so every field officer could read them with a
    single API call. The Settings page is the only caller and the sidebar already
    restricts it to hr_admin, but the route itself has no guard — typing the URL
    was enough, and an API client did not even need that.
    """
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    doc = await db.app_settings.find_one({"key": COMPANY_KEY})
    if not doc:
        defaults = CompanySettings().model_dump()
        defaults["key"] = COMPANY_KEY
        defaults["created_at"] = datetime.now(timezone.utc).isoformat()
        await db.app_settings.insert_one(defaults)
        doc = await db.app_settings.find_one({"key": COMPANY_KEY})
    doc.pop("_id", None)
    return doc


@router.put("/company")
async def update_company(data: CompanySettings, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    update = {k: v for k, v in data.model_dump().items() if v is not None}
    update["updated_at"] = datetime.now(timezone.utc).isoformat()
    await db.app_settings.update_one(
        {"key": COMPANY_KEY},
        {"$set": update, "$setOnInsert": {"key": COMPANY_KEY, "created_at": update["updated_at"]}},
        upsert=True,
    )
    doc = await db.app_settings.find_one({"key": COMPANY_KEY})
    doc.pop("_id", None)
    return doc


# ---------------- Face match settings ----------------

FACE_KEY = "face_match"


class FaceMatchSettings(BaseModel):
    strict: bool = False  # False = warn-but-allow (default); True = block punch on mismatch


@router.get("/face-match")
async def get_face_match(current_user: dict = Depends(get_current_user)):
    doc = await db.app_settings.find_one({"key": FACE_KEY}) or {"key": FACE_KEY, "strict": False}
    doc.pop("_id", None)
    return doc


@router.put("/face-match")
async def update_face_match(data: FaceMatchSettings, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    update = {**data.model_dump(), "updated_at": datetime.now(timezone.utc).isoformat()}
    await db.app_settings.update_one(
        {"key": FACE_KEY},
        {"$set": update, "$setOnInsert": {"key": FACE_KEY}},
        upsert=True,
    )
    doc = await db.app_settings.find_one({"key": FACE_KEY})
    doc.pop("_id", None)
    return doc


# ---------------- Android app version policy ----------------
# Which APK builds are still allowed in. Read by PlatformGate on every launch;
# lives here rather than as a constant in the frontend so retiring a build is a
# switch HR flips, not a code change and redeploy for every APK release.

APP_VERSION_KEY = "app_version"

# v1.4.0 is the first APK that tags its User-Agent ("RadhyaHRApp/1.4.0"), which
# is what makes any of this detectable. Used until HR saves something else.
DEFAULT_MIN_APP_VERSION = "1.4.0"

# [0-9] not \d, and \Z not $. Python's \d is Unicode-aware, so "\u0967.\u096c.\u0966"
# (Devanagari digits) matched — the PUT accepted it, the GET handed it to the
# phone, and JavaScript's ASCII-only \d then failed, which silently forced
# enforce=false and min_version back to the default on every handset. $ also
# matches before a trailing newline, so "1.4.0\n" survived the same way.
_VERSION_RE = re.compile(r"^[0-9]+(\.[0-9]+){0,3}\Z")


class AppVersionSettings(BaseModel):
    min_version: str = DEFAULT_MIN_APP_VERSION
    # False = a dismissible "please update" banner, app still works.
    # True  = older builds are held on a full-screen update screen.
    enforce: bool = False
    # ── In-app updates (v1.6.0+) ─────────────────────────────────────────────
    # The newest build available, and where the APK lives. Together these turn
    # the update screens from "contact the IT team" into a button.
    #
    # Kept SEPARATE from min_version on purpose. min_version is a retirement
    # policy — which builds are no longer allowed in — and raising it can stop
    # people punching in. latest_version is just "there is something newer",
    # which should nag without ever locking anyone out. Conflating them would
    # mean every release either blocks the whole field force or tells nobody.
    # None means "leave whatever is stored alone"; "" means "clear it". Every
    # other field on this model has a plain default, which means a partial PUT
    # silently overwrites what it omitted — a curl with just {"enforce": true}
    # would wipe the update link from all 36 phones with no error anywhere.
    latest_version: Optional[str] = None
    apk_url: Optional[str] = None


def _is_apk_url(url: str) -> bool:
    """A link the phone can actually download and install.

    https only, and it must end in .apk. Not pedantry: this value is typed by an
    HR admin into a settings box and then handed to Android's DownloadManager on
    every field phone, so it is the one place a typo turns into 36 broken
    updates. http:// is refused because the APK is an executable being installed
    on the whole field force's handsets — over plaintext it can be swapped in
    transit, and the phone cannot tell.
    """
    return _apk_url_error(url) is None


# 2000, not 500. An S3 presigned URL built from STS temporary credentials carries
# an X-Amz-Security-Token of 600-1000 characters, and a CloudFront signed URL
# carries a base64 policy plus signature — both are the normal way to publish a
# private APK, and both were being rejected by a rule whose own docstring says
# signed links must work.
_APK_URL_MAX = 2000


def _apk_url_error(url: str) -> Optional[str]:
    """None if usable, else the reason — so the caller can say which rule failed.

    A single "must be https and end in .apk" message for a length violation sent
    whoever was configuring this off mangling a URL that was already correct.
    """
    u = (url or "").strip()
    if not u.lower().startswith("https://"):
        return "APK link must start with https:// (an APK sent over plain http can be swapped in transit)"
    # Strip any query string before checking the extension — a signed download
    # link (S3, CloudFront) is normal and must not be rejected for it.
    path = u.split("?", 1)[0].split("#", 1)[0]
    if not path.lower().endswith(".apk"):
        return ("APK link must point at the file itself and end in .apk — a Drive or "
                "Dropbox sharing page will not work, because the phone downloads it directly")
    if len(u) > _APK_URL_MAX:
        return f"APK link is too long ({len(u)} characters, maximum {_APK_URL_MAX})"
    return None


def _version_tuple(v: str) -> tuple:
    """Dotted version as a comparable tuple, so 1.10.0 sorts above 1.9.0."""
    parts = []
    for chunk in str(v).split("."):
        try:
            parts.append(int(chunk))
        except ValueError:
            parts.append(0)
    # Pad so 1.6 and 1.6.0 compare equal rather than short-tuple-less-than.
    while len(parts) < 4:
        parts.append(0)
    return tuple(parts[:4])


def _app_version_defaults() -> dict:
    return {"key": APP_VERSION_KEY, "min_version": DEFAULT_MIN_APP_VERSION,
            "enforce": False, "latest_version": "", "apk_url": ""}


@router.get("/app-version")
async def get_app_version(current_user: dict = Depends(get_current_user)):
    """Every logged-in client reads this on launch, so it is open to all roles.

    Deliberately does NOT create the document — a read from an employee's phone
    should never write. Absent config just means the defaults.
    """
    doc = await db.app_settings.find_one({"key": APP_VERSION_KEY}) or {}
    out = _app_version_defaults()
    # WHITELIST, not "everything except _id". This endpoint is deliberately open
    # to every role, so copying the whole document through handed `updated_by` —
    # the employee_id of the HR admin who last changed the policy — to any field
    # employee who called it, along with anything else that ever lands in this
    # document later.
    for key in ("min_version", "enforce", "latest_version", "apk_url"):
        if doc.get(key) is not None:
            out[key] = doc[key]
    out.pop("key", None)
    # Never hand back something the client can't parse: a junk min_version with
    # enforce on would be a lockout nobody could explain.
    if not _VERSION_RE.match(str(out.get("min_version", ""))):
        out["min_version"] = DEFAULT_MIN_APP_VERSION
    out["enforce"] = bool(out.get("enforce"))
    # Same reasoning one level down: the phone turns these into a download
    # button, so anything it cannot act on is better sent as absent than as
    # junk. A malformed pair would otherwise surface as an "Update now" button
    # that fails on every tap.
    latest = str(out.get("latest_version") or "")
    url = str(out.get("apk_url") or "")
    ok_pair = bool(_VERSION_RE.match(latest)) and _apk_url_error(url) is None
    out["latest_version"] = latest if ok_pair else ""
    out["apk_url"] = url if ok_pair else ""
    return out


@router.put("/app-version")
async def update_app_version(data: AppVersionSettings, current_user: dict = Depends(get_current_user)):
    if current_user.get("role") not in ["hr_admin", "management"]:
        raise HTTPException(status_code=403, detail="Access denied")
    min_version = (data.min_version or "").strip()
    if not _VERSION_RE.match(min_version):
        raise HTTPException(
            status_code=400,
            detail="Minimum version must look like 1.4.0 (numbers and dots only)",
        )
    # None means the caller did not mention the field, so keep what is stored.
    # Only "" clears it. Without this, a client that PUT just min_version+enforce
    # would wipe the in-app update link off every phone and report success.
    stored = await db.app_settings.find_one({"key": APP_VERSION_KEY}) or {}
    latest_version = (stored.get("latest_version") or "").strip() \
        if data.latest_version is None else data.latest_version.strip()
    apk_url = (stored.get("apk_url") or "").strip() \
        if data.apk_url is None else data.apk_url.strip()
    if latest_version and not _VERSION_RE.match(latest_version):
        raise HTTPException(
            status_code=400,
            detail="Latest version must look like 1.6.0 (numbers and dots only)",
        )
    if apk_url:
        url_error = _apk_url_error(apk_url)
        if url_error:
            raise HTTPException(status_code=400, detail=url_error)
    # Rejecting the half-filled pair here rather than letting the phone discover
    # it: an "Update now" button with nowhere to download from, or a download
    # link with no version to compare against, both read as a broken app to the
    # employee and as a working setting to whoever saved it.
    if bool(latest_version) != bool(apk_url):
        raise HTTPException(
            status_code=400,
            detail="Set both the latest version and the APK link, or neither",
        )
    # A latest_version BELOW min_version would tell the field force to update to
    # a build the gate then rejects — a loop with no way out on the phone.
    if latest_version and _version_tuple(latest_version) < _version_tuple(min_version):
        raise HTTPException(
            status_code=400,
            detail="Latest version cannot be older than the minimum version",
        )
    now = datetime.now(timezone.utc).isoformat()
    update = {
        "min_version": min_version,
        "enforce": bool(data.enforce),
        "latest_version": latest_version,
        "apk_url": apk_url,
        "updated_at": now,
        # Turning enforcement on can stop staff punching in; record who did it.
        "updated_by": current_user.get("employee_id") or current_user.get("username"),
    }
    await db.app_settings.update_one(
        {"key": APP_VERSION_KEY},
        {"$set": update, "$setOnInsert": {"key": APP_VERSION_KEY, "created_at": now}},
        upsert=True,
    )
    doc = await db.app_settings.find_one({"key": APP_VERSION_KEY})
    doc.pop("_id", None)
    return doc
