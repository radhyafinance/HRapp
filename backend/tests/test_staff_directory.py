"""Tests for GET /api/staff/directory (the Radhya Dashboard's staff list).

Covers:
- missing, wrong and unconfigured STAFF_DIRECTORY_TOKEN are all refused (401)
- the closing token does not open the directory, and vice versa
- exited staff are left out; active, probation and notice_period are listed
- exactly employee_id, name, email, department, designation, branch, status come
  back -- nothing sensitive leaks even though the stored record holds it
- email is lowercased and trimmed; generated_at and count are present

Runs in-process against a fake db.employees, so it needs no server or Mongo.
"""
import os

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "test_staff_directory")

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from auth_utils import shared_secret_ok
from routes import staff_directory

TOKEN = "test-staff-directory-token"
URL = "/api/staff/directory"
EXPECTED_FIELDS = {"employee_id", "name", "email", "department",
                   "designation", "branch", "status"}

EMPLOYEES = [
    {"_id": "a1", "employee_id": "RMF0057", "name": "Asha Verma",
     "email": "  Asha.Verma@RadhyaFinance.com ", "department": "Operations",
     "designation": "Branch Manager", "branch": "CHANDPUR", "status": "active",
     "role": "managers", "phone": "9876543210", "aadhaar_number": "123412341234",
     "pan_number": "ABCDE1234F", "bank_account": "0011223344", "ifsc": "SBIN0000001",
     "salary": {"gross": 30000}, "date_of_birth": "1990-01-01",
     "address": "1 Main Road", "documents": {"aadhaar": "base64..."}},
    {"_id": "a2", "employee_id": "RMF0101", "name": "Ravi Kumar",
     "email": "ravi.kumar@radhyafinance.com", "department": "Field",
     "designation": "Field Officer", "branch": "BUDAUN", "status": "probation",
     "phone": "9000000001", "salary": {"gross": 15000}},
    {"_id": "a3", "employee_id": "RMF0042", "name": "Neha Singh",
     "email": "neha@radhyafinance.com", "department": "Accounts",
     "designation": "Accountant", "branch": "NAJIBABAD", "status": "notice_period"},
    {"_id": "a4", "employee_id": "RMF0009", "name": "Gone Person",
     "email": "gone@radhyafinance.com", "department": "Field",
     "designation": "Field Officer", "branch": "CHANDAUSI", "status": "exited"},
]


class _Cursor:
    def __init__(self, docs):
        self._docs = list(docs)

    def __aiter__(self):
        self._it = iter(self._docs)
        return self

    async def __anext__(self):
        try:
            return next(self._it)
        except StopIteration:
            raise StopAsyncIteration


class _FakeEmployees:
    """Applies the {"status": {"$in": [...]}} filter and an inclusion projection
    the way Mongo would, and records what it was asked for."""

    def __init__(self, docs):
        self.docs = docs
        self.calls = []

    def find(self, query, projection):
        self.calls.append((query, projection))
        allowed = query["status"]["$in"]
        keep = [k for k, v in projection.items() if v and k != "_id"]
        out = []
        for d in self.docs:
            if d.get("status") in allowed:
                row = {k: d[k] for k in keep if k in d}
                if projection.get("_id", 1):
                    row["_id"] = d["_id"]
                out.append(row)
        return _Cursor(out)


class _FakeDB:
    def __init__(self, docs):
        self.employees = _FakeEmployees(docs)


@pytest.fixture
def fake_db(monkeypatch):
    db = _FakeDB(EMPLOYEES)
    monkeypatch.setattr(staff_directory, "db", db)
    return db


@pytest.fixture
def client(fake_db, monkeypatch):
    monkeypatch.setenv("STAFF_DIRECTORY_TOKEN", TOKEN)
    app = FastAPI()
    app.include_router(staff_directory.router, prefix="/api/staff")
    return TestClient(app)


# ── Authentication ────────────────────────────────────────────

def test_missing_token_is_refused(client, fake_db):
    res = client.get(URL)
    assert res.status_code == 401, res.text
    assert fake_db.employees.calls == [], "must not query before authenticating"


def test_wrong_token_is_refused(client, fake_db):
    res = client.get(URL, headers={"X-Ingest-Token": TOKEN + "x"})
    assert res.status_code == 401, res.text
    assert fake_db.employees.calls == []


def test_unset_secret_refuses_every_request(client, fake_db, monkeypatch):
    monkeypatch.delenv("STAFF_DIRECTORY_TOKEN", raising=False)
    for headers in ({}, {"X-Ingest-Token": ""}, {"X-Ingest-Token": TOKEN}):
        res = client.get(URL, headers=headers)
        assert res.status_code == 401, (headers, res.text)
    assert fake_db.employees.calls == []


def test_blank_secret_refuses_every_request(client, monkeypatch):
    monkeypatch.setenv("STAFF_DIRECTORY_TOKEN", "   ")
    assert client.get(URL).status_code == 401
    assert client.get(URL, headers={"X-Ingest-Token": "x"}).status_code == 401


def test_closing_token_does_not_open_directory(client, monkeypatch):
    monkeypatch.setenv("CLOSING_INGEST_TOKEN", "closing-only-token")
    res = client.get(URL, headers={"X-Ingest-Token": "closing-only-token"})
    assert res.status_code == 401, res.text


def test_high_byte_header_is_401_not_500(client):
    res = client.get(URL, headers={"X-Ingest-Token": "caf\xe9".encode("latin-1")})
    assert res.status_code == 401, res.text


def test_correct_token_is_accepted(client):
    res = client.get(URL, headers={"X-Ingest-Token": TOKEN})
    assert res.status_code == 200, res.text


# ── The shared helper ─────────────────────────────────────────

def test_shared_secret_ok_reads_only_the_named_secret(monkeypatch):
    monkeypatch.setenv("CLOSING_INGEST_TOKEN", "closing-secret")
    monkeypatch.setenv("STAFF_DIRECTORY_TOKEN", "staff-secret")
    assert shared_secret_ok("closing-secret", "CLOSING_INGEST_TOKEN")
    assert shared_secret_ok(" closing-secret ", "CLOSING_INGEST_TOKEN")
    assert not shared_secret_ok("staff-secret", "CLOSING_INGEST_TOKEN")
    assert shared_secret_ok("staff-secret", "STAFF_DIRECTORY_TOKEN")
    assert not shared_secret_ok("closing-secret", "STAFF_DIRECTORY_TOKEN")
    assert not shared_secret_ok(None, "STAFF_DIRECTORY_TOKEN")
    assert not shared_secret_ok("", "STAFF_DIRECTORY_TOKEN")
    monkeypatch.delenv("STAFF_DIRECTORY_TOKEN")
    assert not shared_secret_ok("", "STAFF_DIRECTORY_TOKEN")
    assert not shared_secret_ok("anything", "STAFF_DIRECTORY_TOKEN")


# ── What comes back ───────────────────────────────────────────

def _get(client):
    res = client.get(URL, headers={"X-Ingest-Token": TOKEN})
    assert res.status_code == 200, res.text
    return res.json()


def test_exited_staff_are_left_out(client):
    data = _get(client)
    ids = [s["employee_id"] for s in data["staff"]]
    assert "RMF0009" not in ids
    assert sorted(ids) == ["RMF0042", "RMF0057", "RMF0101"]
    assert {s["status"] for s in data["staff"]} == {"active", "probation", "notice_period"}


def test_exactly_the_listed_fields_come_back(client):
    data = _get(client)
    assert set(data) == {"generated_at", "count", "staff"}
    for row in data["staff"]:
        assert set(row) == EXPECTED_FIELDS, row


def test_query_is_one_projection_over_employees(client, fake_db):
    _get(client)
    assert len(fake_db.employees.calls) == 1
    query, projection = fake_db.employees.calls[0]
    assert query == {"status": {"$in": ["active", "probation", "notice_period"]}}
    assert projection == {"_id": 0, **{f: 1 for f in EXPECTED_FIELDS}}


def test_email_is_lowercased_and_trimmed(client):
    rows = {s["employee_id"]: s for s in _get(client)["staff"]}
    assert rows["RMF0057"]["email"] == "asha.verma@radhyafinance.com"


def test_count_and_generated_at(client):
    data = _get(client)
    assert data["count"] == len(data["staff"]) == 3
    assert data["generated_at"].endswith("+00:00")


def test_missing_fields_come_back_as_null(client, fake_db):
    fake_db.employees.docs = [{"_id": "x", "employee_id": "RMF0200",
                               "name": "No Email", "status": "active"}]
    row = _get(client)["staff"][0]
    assert set(row) == EXPECTED_FIELDS
    assert row["email"] is None and row["branch"] is None


# ── The closing endpoints still authenticate as before ────────

def test_closing_token_check_unchanged(monkeypatch):
    closing = pytest.importorskip("routes.closing")
    monkeypatch.setenv("CLOSING_INGEST_TOKEN", "closing-secret")
    monkeypatch.setenv("STAFF_DIRECTORY_TOKEN", "staff-secret")
    assert closing._ingest_token_ok("closing-secret")
    assert closing._ingest_token_ok("  closing-secret\t")
    assert not closing._ingest_token_ok("staff-secret")
    assert not closing._ingest_token_ok("closing-secre")
    assert not closing._ingest_token_ok(None)
    assert not closing._ingest_token_ok("")
    assert not closing._ingest_token_ok("caf\xe9")
    monkeypatch.delenv("CLOSING_INGEST_TOKEN")
    assert not closing._ingest_token_ok("closing-secret")


def test_closing_pending_pull_still_refuses_without_token(monkeypatch):
    closing = pytest.importorskip("routes.closing")
    monkeypatch.setenv("CLOSING_INGEST_TOKEN", "closing-secret")
    app = FastAPI()
    app.include_router(closing.router, prefix="/api/closing")
    c = TestClient(app)
    assert c.get("/api/closing/pending-pull").status_code == 401
    assert c.get("/api/closing/pending-pull",
                 headers={"X-Ingest-Token": "staff-secret"}).status_code == 401
