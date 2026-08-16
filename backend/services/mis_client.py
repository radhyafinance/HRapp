"""
Fetch the Demand & Collection report out of the Radhya MIS (radhyamfin.com).

WHY THIS EXISTS
---------------
The MIS has no API. The only way to see a day's collections is a report a human
downloads from an ASP.NET WebForms page. Field officers keep collecting until
21:00-23:00 while Head Office shuts at 19:00, so whoever pulls that report at
7pm writes down a number that is still moving. Measured over July: 90.1% of the
month's value had posted by 19:00, meaning roughly one rupee in ten arrived
after HO had gone home. On 21 July it was Rs 63,180 -- 17% of the day.

So this module logs in and pulls the same file on a loop, and the day's figures
finish themselves.

HOW THE SITE WORKS (all of this was measured against the live site, not guessed)
------------------------------------------------------------------------------
  1. GET  /General/Welcome.aspx      -> login form (txtemployeeid/txtpassword)
  2. POST /General/Welcome.aspx      -> session cookies
  3. GET  /General/ChooseBranch.aspx -> branch / financial year / date / loan type
  4. POST /General/ChooseBranch.aspx -> sets BRANCHID, LGDATE, FINANCIALYEAR ...
  5. GET  /Report/demandncollectionexcel3.aspx  -> filter page
  6. POST the same URL with __EVENTTARGET set   -> the .xlsx bytes

Four things about this site cost real time to discover. They are the reason the
code below looks more defensive than a form post deserves:

* THE BRANCH CHECKBOXES ARE NOT IN THE SERVER'S HTML. The filter page ships only
  the funder checkbox; the branch list is injected client-side after the funder
  is chosen. A fetcher that parses the page and posts what it found submits ZERO
  branches and gets a valid-looking empty report. We post the indices directly
  instead -- the server accepts them without the intermediate round trip.

* BECAUSE WE POST INDICES BLIND, A NEW BRANCH IS INVISIBLE. Index 5 would simply
  never be requested and the report would quietly come back short. So the branch
  count is read from ChooseBranch (which IS server-rendered) rather than
  hardcoded, and the parser separately asserts the branches it expected are
  present. A missing branch has to be loud; a silently short day is worse than
  no day at all.

* A SUCCESSFUL DOWNLOAD IS NOT AN HTML PAGE. When the session has expired the
  server cheerfully returns 200 with the login page. Checking the status code
  proves nothing -- we check for the ZIP magic number and re-login once.

* THE DATE FORMAT IS dd-MMM-yyyy. strftime("%b") is locale-dependent, and this
  runs on a server whose locale we do not control, so the month names are
  spelled out explicitly below rather than trusted to the C library.

CREDENTIALS
-----------
Read from the environment at call time, never stored, never logged, and never
included in an exception message. MIS_USERNAME / MIS_PASSWORD.
"""

import logging
import os
from datetime import date, datetime
from typing import Optional
from zoneinfo import ZoneInfo

import httpx
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

IST = ZoneInfo("Asia/Kolkata")

DEFAULT_BASE_URL = "https://radhyamfin.com"

LOGIN_PATH = "/General/Welcome.aspx"
CHOOSE_BRANCH_PATH = "/General/ChooseBranch.aspx"
REPORT_PATH = "/Report/demandncollectionexcel3.aspx"

# Head Office sees every branch. 1 is HEAD OFFICE in ChooseBranch's DropDownList1.
HEAD_OFFICE_VALUE = "1"

# JLG. The other options (Indivisual / IndivisualJLG) are separate books; the
# daily cash close is the group-lending one.
LOAN_TYPE_JLG = "0"

# The report's own control names, from the live page.
FLD_DATE_FROM = "ctl00$MainContent$dd$DateFrom"
FLD_DATE_TO = "ctl00$MainContent$dd$DateTo"
FLD_FUNDER = "ctl00$MainContent$dd$ddlFunder$"
FLD_BRANCH = "ctl00$MainContent$dd$ddlBranch$"
BTN_PROCEED = "ctl00$MainContent$dd$btnProceed"

# ASP.NET's own hidden state. All of it has to be echoed back or the postback is
# rejected -- __EVENTVALIDATION in particular exists to stop exactly what we do.
_ASPX_HIDDEN = ("__VIEWSTATE", "__VIEWSTATEGENERATOR", "__EVENTVALIDATION",
                "__EVENTTARGET", "__EVENTARGUMENT", "__LASTFOCUS",
                "__VIEWSTATEENCRYPTED")

_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun",
           "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

_XLSX_MAGIC = b"PK\x03\x04"

# Generous: this is one request every few minutes against a slow legacy box, and
# a report that takes 40s to build is normal. Failing early just means retrying
# and making it build the report twice.
_TIMEOUT = httpx.Timeout(90.0, connect=20.0)


class MISError(Exception):
    """Anything that stopped us getting today's numbers.

    Deliberately never carries the password, the raw response body, or the
    session cookie: this message ends up in logs and in the closing UI.
    """


class MISAuthError(MISError):
    """The credentials were rejected -- retrying will not help."""


def mis_date(d: date) -> str:
    """Format as the site wants it: 14-Aug-2026.

    Not strftime('%d-%b-%Y'): %b follows the process locale, and a server set to
    a non-English locale would silently post a month name the site cannot parse
    and get back an empty report rather than an error.
    """
    return f"{d.day:02d}-{_MONTHS[d.month - 1]}-{d.year}"


def today_ist() -> date:
    """The business day, in IST.

    The MIS is an Indian system and its dates are IST. A UTC 'today' would ask
    for the wrong day for the five and a half hours that matter most -- the
    evening, which is the entire point of this module.
    """
    return datetime.now(IST).date()


def _cfg() -> tuple[str, str, str]:
    """(base_url, username, password) from the environment.

    Read per call rather than at import so credentials can be rotated without a
    redeploy, and so importing this module on a box that has no MIS access does
    not explode at startup.
    """
    user = (os.environ.get("MIS_USERNAME") or "").strip()
    pwd = os.environ.get("MIS_PASSWORD") or ""
    base = (os.environ.get("MIS_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
    if not user or not pwd:
        raise MISError(
            "MIS credentials are not configured (set MIS_USERNAME and MIS_PASSWORD)"
        )
    return base, user, pwd


def hidden_fields(html: str) -> dict:
    """Every hidden ASP.NET field on the page, ready to be echoed back.

    Returned as a plain dict so callers can add their own fields and post it.
    Missing fields are simply absent -- ChooseBranch has no __LASTFOCUS, and
    inventing an empty one changes the payload the server validates.
    """
    soup = BeautifulSoup(html, "html.parser")
    out = {}
    for name in _ASPX_HIDDEN:
        el = soup.find("input", {"name": name})
        if el is not None:
            out[name] = el.get("value", "")
    return out


def branch_option_count(html: str) -> int:
    """How many branches the report's branch list will contain.

    Read from ChooseBranch's own dropdown, which IS rendered server-side, and
    used to decide how many checkbox indices to post on the report page -- whose
    branch list is NOT. Hardcoding 5 here would mean a fifth collecting branch
    opened one day and its money silently stopped appearing.
    """
    soup = BeautifulSoup(html, "html.parser")
    sel = soup.find("select", {"name": "DropDownList1"})
    if sel is None:
        raise MISError("branch dropdown not found on the branch-selection page")
    # Skip the "Select Branch" placeholder, which carries no value.
    return len([o for o in sel.find_all("option") if (o.get("value") or "").strip()])


def selected_option(html: str, field: str, default: str = "") -> str:
    """Whatever the page itself has selected for `field`.

    Used for the financial year. We were told to leave it alone, and the honest
    way to leave something alone is to send back what the page chose rather than
    to hardcode this year's value and quietly break every April.
    """
    soup = BeautifulSoup(html, "html.parser")
    sel = soup.find("select", {"name": field})
    if sel is None:
        return default
    opt = sel.find("option", selected=True) or sel.find("option")
    return (opt.get("value") if opt else default) or default


def looks_like_login_page(body: bytes) -> bool:
    """Did we get bounced back to the login screen?

    The session expiring does not produce a 401 or a redirect we can detect from
    the status line -- it produces 200 and the login form. Anything that decides
    success from the status code alone will happily store an HTML error page as
    today's collections.
    """
    head = body[:4096].lower()
    return b"txtpassword" in head or b"mis login" in head


class MISClient:
    """One login, reused for as many report pulls as the session survives.

    The caller is expected to keep an instance alive across polls: logging in
    once an evening rather than once every three minutes is gentler on a legacy
    box and avoids writing the password into a cookie 200 times a night.
    """

    def __init__(self, base_url: Optional[str] = None):
        self._base = (base_url or "").rstrip("/") or None
        self._client: Optional[httpx.AsyncClient] = None
        self._logged_in = False
        # The business day this session was established for. login() posts
        # lgdate into the MIS session, so a session held across IST midnight
        # carries YESTERDAY's date server-side while we ask for today's report —
        # a valid session quietly returning the wrong day.
        self._session_day: Optional[date] = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        await self.aclose()

    async def aclose(self):
        if self._client is not None:
            await self._client.aclose()
            self._client = None
        self._logged_in = False

    def _ensure_client(self, base: str) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=base,
                timeout=_TIMEOUT,
                follow_redirects=True,
                headers={
                    # A plain httpx UA on a legacy portal invites surprises; this
                    # is the same shape a staff browser sends.
                    "User-Agent": ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                                   "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"),
                    "Accept-Language": "en-IN,en;q=0.9",
                },
            )
        return self._client

    async def login(self) -> None:
        """Authenticate and select Head Office for the current business day."""
        base, user, pwd = _cfg()
        client = self._ensure_client(self._base or base)

        # -- 1/2: the login form -------------------------------------------------
        r = await client.get(LOGIN_PATH)
        if r.status_code != 200:
            raise MISError(f"login page returned HTTP {r.status_code}")
        payload = hidden_fields(r.text)
        payload.update({
            "txtemployeeid": user,
            "txtpassword": pwd,
            "Button1": "Login",
        })
        r = await client.post(LOGIN_PATH, data=payload)
        if r.status_code != 200:
            raise MISError(f"login POST returned HTTP {r.status_code}")
        if looks_like_login_page(r.content):
            # Still on the login form => rejected. Do not retry: a loop that
            # retries bad credentials every three minutes will lock the account.
            raise MISAuthError("MIS rejected the credentials")

        # -- 3/4: branch, financial year, date, loan type ------------------------
        r = await client.get(CHOOSE_BRANCH_PATH)
        if r.status_code != 200 or looks_like_login_page(r.content):
            raise MISError("could not reach the branch-selection page after login")
        html = r.text
        self._branch_count = branch_option_count(html)
        payload = hidden_fields(html)
        payload.update({
            "DropDownList1": HEAD_OFFICE_VALUE,
            # Send back whatever the page had selected. See selected_option().
            "DropDownList2": selected_option(html, "DropDownList2"),
            "lgdate": mis_date(today_ist()),
            "ddlLoanType": LOAN_TYPE_JLG,
            "Button1": "Go",
        })
        r = await client.post(CHOOSE_BRANCH_PATH, data=payload)
        if r.status_code != 200:
            raise MISError(f"branch selection returned HTTP {r.status_code}")

        self._logged_in = True
        self._session_day = today_ist()
        # Username is fine to log; it identifies which account is being used and
        # is not a secret. The password never appears anywhere.
        logger.info("MIS: logged in as %s, %d branches visible", user, self._branch_count)

    async def _download_once(self, day: date) -> bytes:
        client = self._client
        if client is None:
            raise MISError("client not started")

        r = await client.get(REPORT_PATH)
        if r.status_code != 200:
            raise MISError(f"report page returned HTTP {r.status_code}")
        if looks_like_login_page(r.content):
            raise MISAuthError("session expired")

        payload = hidden_fields(r.text)
        payload["__EVENTTARGET"] = BTN_PROCEED
        payload["__EVENTARGUMENT"] = ""
        payload[FLD_DATE_FROM] = mis_date(day)
        payload[FLD_DATE_TO] = mis_date(day)

        # Funder: parsed from the page, because unlike the branches it IS
        # rendered server-side, and a second funder appearing must not be
        # silently excluded from the day's cash.
        soup = BeautifulSoup(r.text, "html.parser")
        funders = soup.find_all("input", attrs={"name": lambda n: bool(n) and n.startswith(FLD_FUNDER)})
        if not funders:
            raise MISError("no funder options on the report page")
        for el in funders:
            payload[el["name"]] = el.get("value", "on")

        # Branches: posted blind by index. See the module docstring.
        count = getattr(self, "_branch_count", 0)
        if count <= 0:
            raise MISError("branch count unknown; cannot request all branches")
        for i in range(count):
            payload[f"{FLD_BRANCH}{i}"] = "on"

        r = await client.post(REPORT_PATH, data=payload)
        if r.status_code != 200:
            raise MISError(f"report download returned HTTP {r.status_code}")
        body = r.content
        if looks_like_login_page(body):
            raise MISAuthError("session expired during download")
        if not body.startswith(_XLSX_MAGIC):
            # Content-type is not trustworthy here either -- the site has served
            # HTML under a spreadsheet content-type when a filter was wrong.
            ctype = r.headers.get("content-type", "?")
            raise MISError(
                f"expected an .xlsx but got {len(body)} bytes of {ctype}"
            )
        return body

    async def fetch_report(self, day: Optional[date] = None) -> bytes:
        """The Demand & Collection workbook for one day, as bytes.

        Re-logins once if the session has lapsed, because a session that expires
        mid-evening is normal operation, not an error worth waking anyone for.
        """
        day = day or today_ist()
        # Re-login when the business day has rolled over, even though the session
        # is still valid — see _session_day. The evening poller runs straight
        # through IST midnight, so this fires in normal operation, not just at
        # the edges.
        if self._logged_in and self._session_day != today_ist():
            logger.info("MIS: business day changed, re-establishing the session")
            self._logged_in = False
        if not self._logged_in:
            await self.login()
        try:
            return await self._download_once(day)
        except MISAuthError:
            logger.info("MIS: session lapsed, logging in again")
            self._logged_in = False
            await self.login()
            # A second failure is real: either the credentials changed under us
            # or the site did. Let it propagate.
            return await self._download_once(day)


async def fetch_demand_collection(day: Optional[date] = None) -> bytes:
    """One-shot convenience wrapper. Prefer MISClient for repeated polling."""
    async with MISClient() as c:
        return await c.fetch_report(day)
