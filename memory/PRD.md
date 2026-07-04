# Radhya Micro Finance HR System - PRD

## Problem Statement
HR management system for Radhya Micro Finance Private Limited (NBFC-MFI) with 40+ employees.

## Architecture
- **Frontend**: React 18 + Tailwind CSS + Shadcn UI
- **Backend**: FastAPI + MongoDB (radhya_hr_db)
- **Auth**: JWT Bearer Token
- **AI**: Google Gemini (Aadhaar OCR)

## User Roles
- `hr_admin`: HR Admin - Full access
- `management`: CEO/COO - Approvals + reports
- `branch_manager`: DM/AM/BM - Team management
- `employee`: HO staff - Self-service
- `field_agent`: FO/Field - Mobile attendance

## What's Implemented (Updated Jul 2026)
### ✅ Phase 1 Complete
1. **Authentication** - JWT login, role-based access, user management
2. **Employee Management** - CRUD, bulk CSV upload, salary components
3. **Candidate Onboarding** - Add candidates, Aadhaar OCR (Gemini AI), status tracking
4. **Attendance** - Selfie capture, GPS geofencing (10m), punch in/out
5. **Leave Management** - CL/SL/EL/Maternity/Paternity, balance tracking, approval workflow
6. **Payroll** - EPF 12%, ESIC 0.75%/3.25%, Gratuity provision, NEFT Excel export
7. **Performance Management** - Half-yearly reviews, self/manager assessment, CTC increase
8. **Exit Management** — Full workflow with exit type classification, Direct Exit, change-exit-type log
9. **Letter Generation** - Appointment, Offer, Promotion, Warning, Experience, Relieving, Increment

### ✅ Phase 6 (Jul 2026) — Visibility, Dashboard & Exit Type Enhancements
- **Exit Final Status (Exit/Absconding/Terminated)**: Admin must choose exit type during final approval. Status can be changed later with comment and full change log. Absconding/Terminated can bypass resignation workflow via "Direct Exit" button.
- **HO Attendance Visibility (role=employee excluded from managers)**: Managers (BMs/DMs) cannot see HO staff attendance, leaves, regularisation requests, or dashboard stats. `get_manager_scope_excluding_ho()` added to hierarchy.py.
- **Dashboard Tiles Clickable**: Total Employees→/employees, Present/Absent/OnLeave→drilldown modal (with live employee list), Pending Leaves→/leaves, Exit Requests→/exit.
- **Branch-wise Attendance**: Branch filter tabs on team attendance page (admin/management/managers). `GET /api/attendance/branches` endpoint returns branches visible to current user.
- **Punch Out Time Display**: Now shown in Today's Summary list items and Roster cards (was missing).
- **Biometric Login Removed**: Fingerprint login button and WebAuthn setup card fully removed from UI.
- **Files**: `/app/backend/routes/exit_routes.py`, `/app/backend/routes/attendance.py`, `/app/backend/routes/leaves.py`, `/app/backend/routes/dashboard.py`, `/app/backend/services/hierarchy.py`, `/app/frontend/src/pages/Login.js`, `/app/frontend/src/pages/Dashboard.js`, `/app/frontend/src/pages/ExitManagement.js`, `/app/frontend/src/pages/Attendance.js`

### ✅ Phase 5 (Jun 2026) — Regularisation + Comp-Off Improvements
- **Regularisation + Leave Integration**: When HR marks attendance as `leave` during regularisation (Add Record / Edit Record), a "Leave Type" dropdown appears (CL/SL/EL/Marriage/Comp-Off/etc.) and 1 day is **automatically deducted** from the selected leave balance. Works for both PATCH and POST regularisation endpoints. Stores `leave_type` on the attendance record. For Comp-Off, deducts from manual balance first, then oldest approved grant.
- **Comp-Off Editing in Leave Balance Modal**: `Leaves > All Employees > Edit` now includes a Comp-Off row (Total / Used / Remaining). HR can manually override the Comp-Off balance — stored as `Comp-Off` key in `leave_balances`. Displayed consistently across all 3 balance endpoints (`/balances/all`, `/balance/my`, `/balance/{employee_id}`).
- **Approval Type Bug Fix**: `PUT /api/leaves/{id}/approve` no longer defaults `approval_type` to hardcoded `"sl"` — now defaults to the leave's actual type (e.g. CL→`"cl"`, EL→`"el"`).
- **Edit Approved Leaves**: Admin/Management can now edit any approved leave record via `PUT /api/leaves/{leave_id}/admin-edit`. Editable fields: leave_type, reason, remarks, approval_type (for SL). Balance is auto-adjusted when leave type or approval type changes (old deduction reversed, new deduction applied). Edit button added to every row in "All Approved Leaves" tab.
- **Type Column Fix**: Approved leaves table "Type" column now stacks badges vertically — both the leave type badge (e.g. SL) and the approval type badge (e.g. "Salary Deduction", "Converted to EL") are fully visible even when combined.
- **Files**: `/app/backend/routes/attendance.py`, `/app/backend/routes/leaves.py` (LeaveAdminEditRequest, admin_edit_approved_leave added), `/app/frontend/src/components/attendance/Regularisation.js`, `/app/frontend/src/pages/Leaves.js`


### ✅ Phase 4 (Jun 2026) — Full Exit Management Overhaul
- **Resignation with optional letter upload** (PDF/image/Excel)
- **Sequential approval chain**: Direct Reporting Manager → Manager's Manager (if active/exists) → HR Admin
- **Admin sets Last Working Day** on final approval — triggers NOC process
- **5-section NOC clearances** from NOC form PDF: Branch Manager (7 items), Accounts (3 items), IT (3 items), Audit (2 items), HR (3 items)
- **Auto-assign NOC owners**: Accounts Manager by designation, IT by department, RMF0022 for audit, reporting manager for branch
- **Employee-visible status** only (not individual NOC items) for privacy
- **Final documents upload**: F&F Settlement Sheet + Relieving Letter (PDF/Excel)
- **Auto-disable login** when Last Working Day passes (checked at login time)
- **Full audit timeline** with all events recorded
- **Files**: `/app/backend/routes/exit_routes.py` (complete rewrite), `/app/frontend/src/pages/ExitManagement.js` (mobile-first complete rewrite), `/app/backend/routes/auth.py` (LWD auto-disable added)
- **Exit pending badge**: `GET /api/exit/my-pending-count` endpoint + red badge on sidebar Exit nav item (polls every 60s) + dashboard alert card that breaks down approvals/NOC/docs pending + mobile "More" button badge. Files: `Layout.js`, `Dashboard.js`
10. **Gratuity** - Eligibility check (5yr), calculation, monthly provision
11. **Settings** - 5 office locations (Moradabad HO, Chandpur, Najibabad, Budaun, Chandausi)

### ✅ Phase 3 Patch (Jun 2026) — Verification Lock + NEFT Filter
- **EPF/UAN field locked after verification**: UAN field in edit form is read-only with a lock icon when `uan_verification.verified = true`. Edit button shows confirmation warning before unlocking. Changing UAN number clears the EPF verification in the backend.
- **Bank fields locked after verification**: All bank fields (Bank Name, Account #, IFSC) are locked after `bank_details.verified = true`. Edit button shows confirmation. Changing any bank field clears the verification.
- **Employee list EPF + Bank columns**: Two new "EPF" and "Bank" columns with green ShieldCheck icons show verification status at a glance on the Employees page.
- **NEFT export skips unverified banks**: `GET /api/payroll/export/neft` now only includes employees whose `bank_details.verified == true`. Unverified employees are silently excluded from the NEFT sheet.
- **Employee edit duplicate check fix**: `useFieldUnique` no longer checks the candidates collection when editing an existing employee (`exclude_employee_id` is set). This fixes the false-positive "Duplicate — Fix Fields" shown for employees converted from candidates.


### ✅ Phase 3 Patch (Feb 2026) — Production Hierarchy Drift Fix
- **Auto-upgrade role to "managers"** when an employee has direct reports — protects against DB drift where someone's stored role got demoted to `employee` in production but they functionally manage a team (e.g. RMF0010 in prod).
  - New helpers in `/app/backend/services/hierarchy.py`: `has_direct_reports(employee_id)` and `compute_effective_role(role, employee_id)`.
  - Applied in `/api/auth/login` and `/api/auth/me` so the frontend (`auth_user` localStorage / sidebar / tabs) receives the upgraded role.
  - Applied in `get_current_user` dependency so existing JWT-authenticated sessions also get the upgrade without re-login.
- **Removed stray `@router.get("/me")` decorator** that was leaking onto the `login()` function, causing `GET /api/auth/me` to hit the POST login handler (the Pydantic "body required" error users saw when probing the endpoint).

### ✅ Phase 3 Patch (Feb 2026)
- **DigiLocker Aadhaar Save Bug — FIXED**: Defined missing `_map_doc_type` function in `/app/backend/routes/digilocker.py` (the function body was orphaned dead code after a `return []` inside `_extract_perfios_list`, causing a latent `NameError` for any DigiLocker doctype not explicitly listed in `_DL_TYPE_MAP`). Verified Aadhaar `parsedFile` → JSON payload (photo stripped) saves correctly to `employee_documents.aadhaar_front` via end-to-end simulation. Cleaned debug test artifacts (`test_field`, `aadhaar_test`) left on RMF0003.


### ✅ Phase 2 Complete (Apr 2026)
12. **NEFT Sheet (RMF0001 Bank Format)** - Exact 8-column bank format: Transaction Type, Amount, Debit Account No (12 digit, from settings), IFSC, Beneficiary Account, Beneficiary Name (cleaned uppercase, max 32, no special chars), Remarks for Client (max 21), Remarks for Beneficiary (max 30). Filename `NEFT_RMF0001_<period>.xlsx`. Locale-safe period label (e.g. `Apr26`).
13. **Company / Bank Settings Tab** - Company profile (name, CIN, address, contacts) + NEFT bank credentials (debit account, IFSC, transaction type) — used in NEFT export.
14. **Continuous GPS Tracking for Field Staff** - Frontend pings `/api/attendance/location-update` every 2 minutes between punch-in and punch-out (skipped for management role). Live "Tracking active" indicator on Attendance page.
15. **Field Tracking Map (Manager view)** - New page `/field-tracking` (HR Admin / Management / Manager only) with Leaflet + OpenStreetMap route map, polyline of full route, start/end markers, auto-fit bounds, and **stops > 15 min** detection (50m cluster) shown as orange markers + summary table with "Open in Maps" links.
16. **Management Role Attendance** - Management role bypasses selfie + geofence; gets a one-click "Mark Present" without camera. Selfie+geofence still mandatory for HR Admin / Manager / HO Staff / Field Staff.
17. **Aadhaar OCR (Front + Back) for Candidates** - Add Candidate flow now has Aadhaar Front + Back upload + "Extract" button (Gemini 2.5 Flash via emergentintegrations). Auto-fills first/last name, DOB, gender, father/husband name, full 12-digit Aadhaar #, address, city, state, pincode. Friendly 422 error for unreadable images.
18. **PAN OCR for Candidates** - PAN card upload + "Extract" button. Auto-fills 10-character PAN number (and falls back to populate name/DOB if Aadhaar didn't run).
19. **KYC Document Storage** - Aadhaar Front, Aadhaar Back, PAN Card images saved per candidate in `candidate_documents` Mongo collection; viewable in Candidate Detail with click-to-zoom (authenticated blob fetch).
20. **Interview Scheduling** - Each candidate has a Schedule/Reschedule button. Schedule modal accepts date + time + interviewer + Google Meet link (manual paste from Google Calendar). Auto-builds an invitation message and offers three one-click share actions: **WhatsApp** (`wa.me` deep link with mobile + pre-filled text), **Email** (`mailto:` with pre-filled subject + body), **Copy** to clipboard.
21. **Tentative Joining Date** - Visible in Candidate Detail when `status=selected`. Editable inline.
22. **Joining Kit PDF Generator** - Pre-filled bilingual joining kit PDF (16 pages) mirroring the company's `Joining Kit Online.docx` template **1:1**, including section numbering, layout, and Devanagari (Hindi) labels. Sections: Header + 7 fields, Documents Checklist (with Sr No / Particular / Checked By HR Team / Remark), Employee Information Sheet (20 fields + Education + Employment + Relatives + References — bilingual headings), Staff Undertaking (English + Hindi), Insurance Form (Member Enrolment + Dependents + Nominee), Gratuity Form 'F' (Statement, Declaration by witnesses, Certificate by Employer, Acknowledgement), EPF Form 2 (Part-A + Part-B + Certificate by Employer), New Form 11 Declaration (23-row table), ESI Temp Card, Notice-Period Declaration (English + Hindi `घोषणा पत्र`), Acknowledgement & Assets Declaration, Non-Disclosure Agreement (full legal text), Asset Declaration Form (20-row asset table). Uses bundled `NotoSansDevanagari-Regular.ttf` font.
23. **Employee ID Required Before PDF** - Added Employee ID + Joining Location fields in the Joining Kit panel (in Candidate Detail). Backend enforces presence of `employee_id` and `expected_joining_date` before allowing PDF generation. New endpoint `GET /api/candidates/meta/next-employee-id` suggests next available ID (RMFxxxx) based on used Employee IDs across both Employees and Candidates collections.
24. **Convert Candidate → Employee** - One-click promotion with hardened validations: **Monthly CTC** required (auto-distributes 50% Basic / 20% HRA / 30% Special; persists `ctc_monthly` and `ctc_annual` on the employee), **IFSC code validation** (regex `^[A-Z]{4}0[A-Z0-9]{6}$`, both client + server), **Bank account re-enter confirmation** (mismatch shown inline), **Reporting To live lookup** (debounced GET `/api/employees/{id}` shows the manager's name + designation + dept; rejects unknown IDs both client + server). Backend endpoint `POST /api/candidates/{id}/convert-to-employee` validates uniqueness, copies all KYC + Aadhaar/PAN images, creates `users` record with `Welcome@123` (or custom) password, initializes leave balances, marks candidate as `converted`.
25. **Employees Page — View / Edit / Documents (Apr 2026)** - Each row's action button now opens a **tabbed modal** with three tabs: **View** (full read-only profile incl. KYC, salary breakup, CTC, address, bank, emergency contact); **Edit** (full editable form for Personal, Job, Salary, Bank, Address, Emergency Contact — backend `PUT /api/employees/{id}` handles IFSC validation, reporting_to lookup, self-report rejection, email uniqueness + linked user-account email/role sync, salary recalculation, and CTC auto-distribution 50/20/30); **Documents** (23 doc slots across KYC, Education, Banking & Statutory, Other, and Joining Kit groups — Upload/Replace/View/**Download**/Delete; phone camera supported via `capture="environment"`; images auto-compressed under 1 MB; PDFs accepted up to 5 MB). Voter ID and Driving License have **separate Front + Back slots**. **Joining Kit (Generated)** row has a green **"Generate Now"** button that calls `GET /api/employees/{id}/joining-kit` to build a fresh 16-page bilingual PDF using the employee's current data and downloads it. Default Employees list filter changed from `active` → `all` so probation/converted employees show by default.

## Office Locations (Seeded)
- Head Office: Moradabad (28.880786, 78.746678)
- Chandpur: (29.132224, 78.283153)
- Najibabad: (29.59107, 78.335716)
- Budaun: (28.013857, 79.144776)
- Chandausi: (28.438212, 78.792448)

## Geofencing
- Radius: 10 meters (configurable per location)
- Method: Haversine formula

## Payroll Formula
- Gross = Basic + HRA + Special + Canteen + Conveyance
- EPF Employee = manual input (`epf_employee` field on employee); falls back to 12% of Basic if not set
- EPF Employer = 12% of Basic
- ESIC Employee = 0.75% of **Basic** (if Basic ≤ ₹21,000)
- ESIC Employer = 3.25% of **Basic** (if Basic ≤ ₹21,000)
- Monthly Gratuity provision = (Basic × 15) / (26 × 12)   ← monthly accrual; ×12 = annual gratuity per year of service
- Monthly CTC = Gross + EPF Employer + ESIC Employer + Monthly Gratuity
- Net = Gross - EPF Employee - ESIC Employee - TDS - Other Deductions

### ✅ Phase 3 (Feb 2026)
26. **Payslip PDF (ReportLab)** - `GET /api/payroll/{record_id}/payslip/pdf` returns ink-friendly payslip with Radhya logo and proper ₹ symbol via FreeSans font (`/app/backend/services/payslip_pdf.py`).
27. **Salary Breakup Form (Manual + Auto)** - Shared `SalaryBreakupForm.js` used in Add Candidate, Convert-to-Employee, and Edit Employee. Manual: CTC, Basic, HRA, Special, Canteen, Conveyance, EPF (employee). Auto-computed: ESIC employee/employer (0.75%/3.25% of **Basic**, only when Basic ≤ ₹21,000), monthly Gratuity provision = `Basic × 15 ÷ 26 ÷ 12`, EPF Employer (12% of Basic), Gross, Net Take-Home, Monthly CTC. Backend `payroll.py` keeps in lock-step.
28. **Payroll Adjustments + Mark as Paid** - Payslip modal exposes editable TDS, Other Deductions, Other Additions, Remarks for HR. Save → `PUT /api/payroll/{id}` (status flips draft → processed). Mark as Paid → `POST /api/payroll/{id}/finalize` (status flips to paid, locks record).

35. **Payroll Deductions Column + LOP-Day Pro-rata (Feb 2026)** - 
    - Payroll table now shows a **Deductions** column (between ESIC and Net Salary) summing EPF + ESIC + TDS + Other Deductions; backend exposes `total_deductions` on every payroll record via `pay_to_dict`.
    - Payslip modal adds an **LOP Days** input (supports half-days, step 0.5). When HR sets LOP, `PUT /api/payroll/{id}` calls `calc_payroll_components(emp, working_days, working_days - lop_days)` to **pro-rate Basic / HRA / Special / Canteen / Conveyance / EPF (capped ₹1,800) / ESIC** — Net Salary auto-recomputes.
    - Payslip PDF reads `lop_days` and renders fractional days correctly (`25.5` instead of `25`).
    - **Payroll Summary Card** (5-cell grid above the table when a period filter is selected): Total Net Payable, Total Deductions, Total LOP Days, Employer Cost, Total Monthly CTC.
    - **Salary Register Excel** column 10 renamed to **"LOP Days"**, prefers stored `lop_days`, renders fractional values (`0.##` format), and the bottom **TOTAL** row now sums LOP days too.

36. **Half-Year Leave Credit Fix (Feb 2026)** - Fixed `POST /api/leaves/admin/credit-halfyear` — now credits **+7.5 SL and +3.5 CL** per half (was incorrectly +7 / +3, which didn't match the documented policy of 15 SL + 7 CL per FY). Settings → Leave Management card labels updated to match. Idempotent via `credited_<H1|H2>_<fy>` flag.

37. **Branch Assignment for Employees (Feb 2026)** - New `branch` field on employees, sourced from Settings → Office Locations. Visible as a dropdown in:
    - **Add Employee** modal (Job section, after Joining Date)
    - **Edit Employee** modal (Job section, after Joining Location)
    - **View Employee** detail panel (under Joining Location)
    Backend `EmployeeCreate` and `EmployeeUpdate` accept optional `branch: str`. Frontend fetches `/api/locations` once and renders a sorted dropdown of location names with "— Not Assigned —" as default option.

38. **Leaves Page UX Cleanup + Calendar Bug Fix (Feb 2026)** -
    - **Admin/Management view**: Hides Apply Leave button, hides My Leaves tab and the personal balance cards; instead opens directly on Pending Approvals.
    - New **All Approved Leaves** tab for admin/management — `GET /api/leaves/approved` returns all approved leaves enriched with name, designation, department, and branch. Sorted by start date desc.
    - Pending Approvals + All Approved Leaves tables now render **Name, Designation, Branch** columns (in addition to Type / Dates / Days / Actions).
    - **Calendar bug fix**: `/api/leaves/calendar-overlay` was querying `from_date` / `to_date`, but most records use `start_date` / `end_date`. Now queries both via `$or` and emits both keys in the response. Also `leave_to_dict` normalizes legacy schema. Approved leaves on the Holiday Calendar now render correctly (verified RMF0008 SL 28-29 May appearing as expected).

39. **Manager-Scoped Leave Approval (Feb 2026)** -
    - `GET /api/leaves/pending` now scopes to the manager's direct reports for `managers` role (uses `reporting_to`); HR Admin / Management still see everything.
    - `PUT /api/leaves/{id}/approve` enforces the same scope server-side: a manager can only approve/reject leaves filed by employees who report to them. Cross-team attempts return HTTP 403.

40. **Hierarchical (Transitive) Visibility for Managers (Feb 2026)** -
    A manager (role `managers`) can now see the full sub-tree of employees reporting to them — direct reports + their reports' reports + ... (unlimited depth). HR Admin / Management remain unscoped.
    - New shared helper: `services/hierarchy.py::get_descendant_employee_ids()` walks `employees.reporting_to` breadth-first (max 10 levels) and returns the full sub-tree set.
    - **Applied to all manager-scoped endpoints**:
      - `GET /api/leaves/pending` (now transitive)
      - `GET /api/leaves/calendar-overlay` (now transitive)
      - `GET /api/attendance` (with or without `employee_id` filter)
      - `GET /api/attendance/today`
      - `GET /api/attendance/field-staff/active`
      - `GET /api/attendance/location-track/{employee_id}` (cross-team blocked 403)
      - `GET /api/tracker/devices` (sub-tree only)
      - `GET /api/dashboard/stats` (employee/attendance/leave counts scoped to sub-tree)
      - `GET /api/dashboard/field-agents-live`
    - **Approval rule (per Q3a + Admin)**: Only the **direct reporting manager** OR HR Admin / Management can approve a leave. Skip-level managers can VIEW but get HTTP 403 on approve attempts ("Only the direct reporting manager (or HR Admin) can approve this leave.").
    - **Verified end-to-end** with a 3-level test tree (Dhruv → Ankit Pal → Rajeev): skip-level sees+blocked-approve; direct manager approves OK; sibling manager sees nothing (403).

41. **Face-Mismatch Photo Review UI (Feb 2026)** -
    - New badge **⚠ FACE IN / FACE OUT** rendered on attendance rows where `punch_in_face_matched === false` or `punch_out_face_matched === false`.
    - Visible on: Today's Summary list, personal Attendance History, and the Manager/Admin Team Attendance table.
    - Click badge → opens a side-by-side review modal (`FaceMismatchModal`):
      - Captured punch selfie (loaded from `punch_in_photo` / `punch_out_photo` base64 — only persisted on flagged punches)
      - Reference passport photo from `/api/employees/{id}/documents/passport_photo/file`
      - Diagnostic panel: Status=Mismatch, distance score with explainer (0 exact / >0.40 mismatch), warning reason
      - "What to check" guidance explaining common false-positive causes (lighting, beard, glasses, old reference photo)
    - New file: `/app/frontend/src/components/attendance/FaceMismatch.js` — exports `FaceMismatchBadge` + `FaceMismatchModal`.

42. **Public Candidate Self-Onboarding via Invite Links (Feb 2026)** -
    HR generates a single-use, 7-day-expiry link from Candidates → "Invite Links" → "Generate Link". Link is auto-copied to clipboard for manual share (WhatsApp / phone). Candidate opens the link in any browser at `/apply/<token>` (no login required) and submits:
    - **Mobile + Email only** (no manual name)
    - Aadhaar front + back (JPG/PNG)
    - PAN card (JPG/PNG)
    - CV (PDF or image)
    Images are auto-compressed client-side to under 1 MB before upload (canvas resize + iterative JPEG quality steps). Server enforces a 1.1 MB hard cap and validates MIME types.
    On submit, server runs **Gemini OCR automatically** on Aadhaar (front + back combined) and PAN — no button needed. Name is **derived strictly from OCR** (Aadhaar first, fallback PAN); if OCR can't read the name, returns HTTP 422 with a "please retry with a clearer photo" message and the invite stays active.
    Documents are stored in the canonical `candidate_documents` collection (same place HR-uploaded docs live), so they appear in the existing **KYC Documents** panel of the candidate detail modal — now shown as a 4-up grid with **Aadhaar Front, Aadhaar Back, PAN Card, CV / Resume**. CV opens in a new browser tab.
    - Backend: `routes/candidate_invites.py`, plus updates to `routes/candidates.py` (cv added to documents meta + binary endpoints).
    - Frontend: new `/apply/:token` page (`pages/CandidateApply.js`) + HR-side modal (`components/candidates/CandidateInvitesModal.js`) + 4-up KYC grid in `CandidateDetailModal.js`.
    - Verified end-to-end: invite generated, public submit creates candidate (source=`self_onboarding`), invite marked `used`, re-submission returns HTTP 410. OCR-failure path tested → HTTP 422 with retry message; invite remains active.
29. **Username-based Login (Feb 2026)** - Login identifier changed from email to **`username`**. Admin = literal `admin` (not an employee). Employees = their Employee ID (e.g. `RMF0001`). Email-based login removed. Auto-migration on startup: legacy `admin@radhyamfi.com` → username `admin`; existing employee users get `username = employee_id`. Login blocks exited employees (HTTP 403) and inactive accounts. New endpoint `POST /api/auth/employees/{employee_id}/reset-password` — HR Admin can reset any employee's password from the Employee Edit modal's "Login Account" section.
30. **Email OTP Login (Feb 2026)** - Login page now has tabs: **Password** + **Email OTP**. Endpoints `POST /api/auth/otp/request` (lookup user by username, generate 6-digit OTP, store bcrypt hash + 10-min expiry, email via Resend) and `POST /api/auth/otp/verify` (verify OTP, issue JWT, burn). 60-second cooldown between requests, max 5 wrong attempts per code, returned email is masked (e.g. `t***********e@radhyamfi.com`). Branded HTML email template (Radhya navy + orange). Resend integration in `/app/backend/services/email_service.py`. SENDER_EMAIL configured to `noreply@updates.radhyafinance.com`. TTL index on `otp_codes.expires_at` auto-removes expired records.
31. **Face Match for Punch In/Out (Feb 2026)** - Each punch-in/out selfie is compared to the employee's `passport_photo` document (stored under `employee_documents`). Implemented with `face_recognition` (dlib) — no TF, no cloud calls. Service `/app/backend/services/face_match.py`. Default threshold 0.40 (balanced). **Strict mode toggle** in Settings → Attendance: OFF (default) = warn-but-allow with mismatch flagged on the record; ON = punch is rejected on mismatch. **No passport_photo on file → punch is blocked** with a clear message. Match status surfaced in punch UI ("Face verified" or "⚠ Face check…"). Per-record fields written: `punch_in_face_matched`, `punch_in_face_distance`, `punch_in_face_warning` (and `_out_` variants). **Punch photos are only persisted when the face check failed/flagged** — saves DB space for normal matched punches.
32. **Attendance Regularisation (Feb 2026)** - Two paths:
    - **Admin direct edit** (HR Admin / Management): Inline pencil on any attendance row in Today's Summary / Attendance History opens a modal to edit `punch_in_time`, `punch_out_time`, `status`, with a mandatory reason. "Add Record" button creates attendance for missing days. `PATCH /api/attendance/records/{id}` and `POST /api/attendance/records`.
    - **Employee request workflow**: Employees click "Request Regularisation" on their Attendance page → fill date + requested punch times/status + reason → HR sees them in the "Pending Employee Requests" panel and can Approve (applies the regularisation) or Reject (with remark). `POST /api/attendance/regularisation-requests`, `GET /api/attendance/regularisation-requests`, `PUT /api/attendance/regularisation-requests/{id}/action`.
    - **Audit trail**: Every change writes an entry in `attendance_regularisations` with before/after values, acted-by user, timestamp, and reason. `GET /api/attendance/regularisations` returns the log. Regularised records are flagged with `regularised: true` and marked "• REG" badge in the UI.

33. **Admin Leave Balance Management (Apr 2026)** - On Leaves page → "All Employees" tab, HR Admin / Management get four new controls:
    - **Initialize Missing** (`POST /api/leaves/admin/initialize-balances`) — creates default FY balances (CL 7 / SL 15 / EL 0 / Marriage 5) for any active/probation/notice-period employee who doesn't yet have one; idempotent.
    - **Per-row Edit** (`PUT /api/leaves/admin/balance/{employee_id}`) — modal with CL/SL/EL/Marriage Total + Used inputs; Remaining auto-calculated; **mandatory Reason**; validation (non-negative, used ≤ total); writes audit entry with before/after snapshot.
    - **Download Template** (`GET /api/leaves/admin/balances-template`) — Excel `.xlsx` pre-filled with all active employees' current balances + Instructions sheet.
    - **Bulk Upload** (`POST /api/leaves/admin/balances-upload`) — accepts the filled template; rows with blank Reason are skipped; unknown Employee IDs reported; each applied row writes an audit entry.
    - **Audit Log** (`GET /api/leaves/admin/balance-audit`) — modal listing all changes with source badge (manual / bulk_upload / initialize), before→after values per leave type, reason, changed_by, timestamp. Collection: `leave_balance_audit`.
## Refactoring (Apr 2026)
- Extracted `Candidates.js` (1430 lines) into 5 standalone components in `/src/components/candidates/`: `AddCandidateModal`, `CandidateDetailModal`, `JoiningKitPanel`, `ScheduleInterviewModal`, `DocUploadCard`
- Extracted `Employees.js` (1014 lines) into 5 standalone components in `/src/components/employees/`: `EmployeeModal`, `EmployeeDetailView`, `EmployeeEditForm`, `EmployeeDocumentsTab`, `DocCompletenessRing`, `ReportingManagerInput`
34. **Monthly Salary Register Export (Apr 2026)** - New button "Salary Register" on Payroll page (next to NEFT Sheet). Endpoint `GET /api/payroll/export/salary-register?period=YYYY-MM` returns a production-grade Excel workbook with:
    - Company header + period + generation timestamp
    - 10 grouped section headers (Identity / Attendance / Earnings / Gross / Deductions / Net Pay / Employer Cost / CTC / Statutory IDs / Bank Details) styled in navy & orange
    - 33 detail columns per employee: Sr, Employee ID, Name, Designation, Department, Joining Date, Status, Working/Paid/LOP days, Basic, HRA, Special, Canteen, Conveyance, Other Additions, Gross, EPF (Emp), ESIC (Emp), TDS, Other Deductions, Total Deductions, Net Salary, EPF (Empr), ESIC (Empr), Gratuity, Monthly CTC, PAN, UAN, ESI No., Bank Name, Account No., IFSC
    - Thousand-separator number formatting, frozen header panes (freeze at C5), auto-widths
    - **Totals row** at bottom summing all money columns
    - Filename `Salary_Register_YYYY-MM.xlsx`. Returns 404 if no payroll records exist for the period.
- Created `/src/components/shared/Modal.js` — reusable base modal
- Created `/src/utils/imageCompression.js` — canonical `compressImage`, `fileToBase64`, `fileToBase64String`
- Result: Candidates.js → 150 lines, Employees.js → 309 lines (1430 lines) into 5 standalone components in `/src/components/candidates/`: `AddCandidateModal`, `CandidateDetailModal`, `JoiningKitPanel`, `ScheduleInterviewModal`, `DocUploadCard`
- Extracted `Employees.js` (1014 lines) into 5 standalone components in `/src/components/employees/`: `EmployeeModal`, `EmployeeDetailView`, `EmployeeEditForm`, `EmployeeDocumentsTab`, `DocCompletenessRing`, `ReportingManagerInput`
- Created `/src/components/shared/Modal.js` — reusable base modal
- Created `/src/utils/imageCompression.js` — canonical `compressImage`, `fileToBase64`, `fileToBase64String`
- Result: Candidates.js → 150 lines, Employees.js → 309 lines

### ✅ Phase 4 (May 2026)
43. **DigiLocker Document Verification via Perfios (May 2026)** -
    HR can now fetch government-verified documents directly from DigiLocker for both Candidates and Employees.
    - **Flow**: HR clicks "Fetch Documents via DigiLocker" → backend initiates a Perfios DigiLocker session → popup opens with DigiLocker consent page → user authorises → callback page fetches+stores all available documents → main window refreshes with "DigiLocker Verified" badges.
    - **Backend** (`/app/backend/routes/digilocker.py`):
      - `POST /api/digilocker/initiate` — calls Perfios `/link`, stores session in `digilocker_sessions` collection, returns DigiLocker redirect URL.
      - `POST /api/digilocker/fetch-and-store/{session_id}` — fetches document list from Perfios, downloads all docs as base64 PDFs, stores in `employee_documents` / `candidate_documents` with `source:"digilocker"` + `digilocker_verified:true` flags.
      - `GET /api/digilocker/session/{session_id}/status` — session status check.
    - **Document type mapping**: PANCR→pan_card, ADHAR→aadhaar_front, DRVLC→driving_license_front, VOTERC→voter_id_front, 10CBSE→edu_10th, 12CBSE→edu_12th, DEGREE→edu_graduation.
    - **Frontend**:
      - New `DigiLockerButton` component (`/components/digilocker/DigiLockerButton.js`) — handles full flow with popup, message listener, loading/success/error states.
      - New `DigiLockerCallback` page (`/pages/DigiLockerCallback.js`) — handles the OAuth return, auto-downloads, posts `DIGILOCKER_DONE` to opener, closes self.
      - **Employee Documents Tab**: DigiLocker panel at top; verified docs show "DigiLocker Verified" shield badge in blue.
      - **Candidate Detail Modal**: DigiLocker panel added to KYC section; works same way.
    - **Security**: Only `hr_admin` and `management` roles can initiate; popup is same-origin so JWT flows naturally via localStorage.
    - **Note**: Requires active DigiLocker credits on the Perfios account. The API key is shared with bank verification. Current status: "Insufficient Credits" on the Perfios account — contact Perfios to enable DigiLocker service.

44. **CIC Data Converter (Jun 2026)** — Special tool for Company Secretary (RMF0007, RMF0003) and HR Admin.
    - Upload HighMark Excel (.xlsx) → generate 4 CDF files simultaneously (CIBIL, CRIF, Equifax, Experian)
    - Date range pickers: from_date / to_date in DDMMYYYY format update headers, file names, and "Date of Account Information" field in every record
    - UID exclusion: tag-based input — type a 12-digit Aadhaar UID and press Enter/comma to add; excluded records are removed from all 4 CDFs
    - Downloads a single ZIP containing all 4 correctly named CDF files
    - Access-gated: only employee_id in {RMF0007, RMF0003} or hr_admin can view/use
    - Backend: `/app/backend/routes/cic_converter.py` — POST `/api/cic/generate` + GET `/api/cic/access-check`
    - Frontend: `/app/frontend/src/pages/CICData.js` — route `/cic-data`

## P0 Backlog (Next Phase)
- [x] Payslip PDF download ✅ Apr 2026
- [x] UAN Number and ESI Number fields on employees ✅ Apr 2026
- [x] Admin Leave Balance Management — Initialize, Manual Edit, Bulk Excel Upload, Audit Log ✅ Apr 2026
- [x] Monthly Salary Register export ✅ Apr 2026
- [x] Holiday Calendar (CRUD + India defaults seed) + Sun/1st-3rd-Sat rules + Comp-Off (auto-detect, HR approve, 90-day expiry) ✅ May 2026
- [x] Payroll Deductions column + LOP-day deduction with auto pro-rata ✅ Feb 2026
- [x] PWA Mobile-friendly UI: Bottom navigation bar, larger touch targets, modal z-index fix, Emergent badge overlap fix ✅ May 2026
- [x] Unique field validation: Aadhaar, PAN, Mobile, Email instantly checked across candidates + employees in all forms (AddCandidate, EmployeeEdit, CandidateApply) ✅ May 2026
- [x] **EPF UAN Validation via Perfios** (POST `/api/employees/{id}/verify-uan`) — name match + employment history table ✅ Jun 2026
- [x] **Admin Apply Leave for Employee** — HR Admin/Management can apply leave on behalf of any employee with auto-approval + balance deduction + policy bypass ✅ Jun 2026
- [x] **Auto-exit after LWD** — Daily scheduler marks employees as exited when Last Working Day passes. Manual trigger: POST `/api/exit/admin/run-auto-exit`. Runs on startup + daily at 00:05 IST ✅ Jun 2026
- [ ] Letter PDFs (Offer / Appointment / Warning etc.) with company letterhead
35. **Background GPS Tracking via Traccar Client (May 2026)** - Field-staff background GPS tracking using the free open-source **Traccar Client** Android/iOS app (works 24/7 even when phone is locked — solving the fundamental PWA background-tracking limitation). New route `/app/backend/routes/tracker.py`:
    - `GET /api/tracker/osmand` — public OsmAnd-protocol endpoint accepting pings from Traccar Client. Validates `<emp_id>:<secret>` identifier against `employee_trackers` collection; unknown/invalid IDs silently dropped (still 200 OK). Writes to existing `location_logs` with `source:"traccar"` — admin field-tracking map automatically picks them up.
    - `GET /api/tracker/config/{employee_id}` — HR/management fetch setup info (lazily creates secret on first fetch).
    - `POST /api/tracker/regenerate/{employee_id}` — rotate secret (invalidates old device).
    - `POST /api/tracker/toggle/{employee_id}` — enable/disable without rotating.
    - **Frontend:** New "Tracker" tab on the Employee modal (`EmployeeTrackerTab.js`) with:
      - Status card: Last Ping (relative + absolute time), Battery %, configured interval
      - Copy-to-clipboard Server URL + Device Identifier
      - **QR code** (via `qrcode.react`) for one-scan setup in Traccar Client
      - **"Send setup via WhatsApp"** button (pre-filled message → employee's mobile number)
      - **Rotate Secret** action (destructive, confirms first)
      - Step-by-step install instructions incl. battery-optimisation disable guide
    - Default interval: 60s. Security: unique `secrets.token_urlsafe(12)` per employee, stored in `employee_trackers.secret`.

36. **Employee Calendar — Personal Leave & Absent Markers (Feb 2026)** - `HolidayCalendar.js` now overlays the logged-in employee's own data on top of the existing holiday grid:
    - Approved leaves render as a **full-cell tint** (per leave type: SL=rose, CL=amber, EL=violet, CO=teal, ML=pink, PL=indigo, LOP=slate) with a coloured pill in the top-right showing the leave code (e.g. `CL`, `EL`).
    - Days marked `absent` in `attendance_records` render as a **red tint** with an `ABS` pill.
    - Self markers take priority over base holiday/Sunday/Saturday-off styling, so the user immediately sees their gaps.
    - New "Your markers" legend section + "My approved leaves" side panel listing the visible month's leaves (start→end · days).
    - Stats card augments `non-working` count with personal "On Leave" and "Absent" day totals.
    - Manager/HR-Admin team-overlay (initials avatars) is preserved but filters out the user's own leaves to avoid double rendering.
    - Backend endpoints reused as-is: `GET /api/leaves/calendar-overlay` (already scopes per role) and `GET /api/attendance/my?month=&year=`.
    - HR Admin (no `employee_id`) gracefully shows team overlay only — personal sections are hidden.
    - **Mobile (PWA) polish (Feb 2026)**: cells now use `overflow-hidden`, responsive padding/text sizes, smaller pills (`text-[7px]` on mobile), `flex-shrink-0` on pills/avatars, hidden holiday text on mobile, single team initial + "+N" indicator on mobile (3 + "+N" on desktop), tap-to-toggle popover for touch users, `max-w-[90vw]` cap on hover popover.

37. **Auto Half-Day from Shift Rules (Feb 2026)** -
    Per-role office hours and automatic half-day computation now run on every punch:
    - **Field Staff (`field_agent`) + Managers (`managers`)** → 07:00 – 16:00 IST (default seed)
    - **Management + HO Staff (`employee`)** → 09:30 – 18:30 IST (default seed)
    - **HR Admin** → no shift; doesn't punch
    - **Half-Day triggers**:
      1. Punched in **> grace_minutes** after shift start → status `half_day` with reason `late_punch_in` (also stores `late_minutes`).
      2. Total `hours_worked` **< min_full_day_hours** at punch-out → status `half_day` with reason `short_hours`.
      3. Once a day is half-day for being late, it **cannot recover** to `present` — penalty stands even if the user later works ≥ min hours.
    - **HR override locks the day** — `_apply_regularisation` now sets `regularised: True`; subsequent `punch_in` / `punch_out` skip the auto-rule and preserve HR-edited status.
    - **API responses** for `/api/attendance/punch-in` and `/punch-out` now include `status`, `late_minutes`, `auto_status_reason` and a friendly suffix in `message` (e.g. *"— marked Half Day (late by 45 min)"*).
    - **Frontend** `<AttendanceStatusBadge>` (new component at `/app/frontend/src/components/attendance/StatusBadge.js`) shows the actual status pill (Present / Half Day / Outside Fence / Leave / etc.) plus a subtle reason chip — `Late 45m` (amber) for late half-day or `<6h` (orange) for short-hours half-day. Used in personal Attendance History, Today's Summary (managers), and the team attendance table.
    - **Test coverage**: 14 unit tests in `/app/backend/tests/test_shift_rules.py` + 9 dict-shift tests in `test_shift_rules_dict.py`. All pass.

38. **Configurable Shifts (Feb 2026)** -
    Hardcoded shift hours replaced with a CRUD-able `shifts` collection. Each shift has:
    `name`, `start_hour:start_minute`, `end_hour:end_minute`, `grace_minutes`, `min_full_day_hours`,
    `assigned_roles[]`, `is_default`, `is_active`. **A role can only be on ONE shift** — selecting it
    for shift B auto-removes it from shift A (via `$pullAll`). At most one shift can carry `is_default=true`.
    - **New route** `/app/backend/routes/shifts.py`: `GET/POST/PUT/DELETE /api/shifts` (HR-only for writes; soft-delete via `is_active=false` + cascading `$unset` on employee overrides), `GET /api/shifts/resolve/me`, `GET /api/shifts/resolve/{employee_id}` (HR/manager debug helper).
    - **Resolution priority** (`services/shift_rules.resolve_shift_for`): employee.shift_id → role-assigned shift → is_default shift → hard-coded legacy fallback. Used by both punch_in and punch_out.
    - **Auto-seed** on startup if collection is empty: 2 default shifts ("Field Shift" 7-16 IST → field_agent+managers; "HO Shift" 9:30-18:30 IST → management+employee + is_default).
    - **Snapshot on attendance**: every punch record now stores `shift_id` + `shift_name` for audit; HR-locked records preserve their original snapshot.
    - **Employee override**: new `shift_id` field on employees. PUT `/api/employees/{id}` accepts `shift_id` (set) or empty string (clears via `$unset`).
    - **Frontend Settings → Shifts tab** (`/app/frontend/src/pages/ShiftsTab.js`): card-based list with Edit/Delete; "New Shift" modal with start/end pickers, grace/min-hours, multi-select roles **with live conflict warning** ("Currently in Field Shift — will move here on save"), is_default toggle. Default shift renders a yellow "Default" badge.
    - **Employee Edit Form** new "Shift Override" dropdown (`edit-shift_id`) — listing all active shifts; "— Use role default —" clears the override.
    - **Tests**: 15 new pytest cases for the API + role-exclusivity + default-exclusivity + override clear behaviour. 23 existing rule-engine tests still pass. Total 38/38 green.

39. **Multi-Session Attendance (Feb 2026)** -
    Per-employee toggle to allow punching in/out multiple times in one day (e.g., field staff who leave for client visits and return).
    - **Data model**: `attendance_records.sessions: [{punch_in_time, punch_out_time, hours_worked, punch_in_location, punch_in_face_*, punch_out_location, punch_out_face_*}]` — top-level `punch_in_time` mirrors first session's in, `punch_out_time` mirrors last session's out, `hours_worked` = sum of every closed session.
    - **Per-employee toggle** `multi_session_attendance: bool` on the Employee model. Default `false` keeps the legacy single-session UX intact. PUT `/api/employees/{id}` honours the boolean.
    - **Backend** `routes/attendance.py`:
      - **punch-in**: rejects with 400 "Already punched in today" when flag is OFF; rejects with 400 "A session is already open. Punch out first." when flag is ON and last session is unclosed; otherwise appends a new session.
      - **punch-out**: closes the latest open session; recomputes total = sum of all closed sessions; re-evaluates short-hours rule against `min_full_day_hours`. Has a legacy migration path for pre-feature single-session records.
      - **Late-rule** evaluated against the FIRST punch-in only — subsequent sessions never downgrade `present` back to `half_day`.
    - **Frontend**:
      - `Attendance.js` fetches the flag via `/api/employees/{me}` on mount. Banner shows green "Punched In: 3:30 am · 3 sessions · MULTI-SESSION", a `<details>` with all sessions, and a hint "Multi-session is enabled — you can punch in again". The button label switches to **"Punch In Again"** while a session is closed.
      - New `<SessionsBadge>` component (`/components/attendance/SessionsBadge.js`) renders a violet `N sessions` pill next to the date in the attendance table that expands a popover listing each session's in/out/hours. Hidden for the common single-session case.
      - `EmployeeEditForm` has a new "Allow multiple punch in / out per day" checkbox (`edit-multi_session_attendance`) with a clear description.
    - **Tests**: 8 new pytest cases (`tests/test_multi_session_attendance.py`) covering flag persistence, OFF-mode rejection, ON-mode session append, "session already open" error, "no open session" error, top-level mirror correctness, late-locks survival across long total, and short-hours half-day on summed totals. 23 existing rule-engine tests still pass — total **31/31** green.

- [ ] Employee confirmation letter after probation
- [ ] Leave encashment calculation

43. **WebAuthn Biometric Login (Feb 2026)** -
    Single-tap passwordless login for non-admin roles using the device's platform authenticator (Face ID / Touch ID / Windows Hello / Android biometric).
    - **Backend** (`/app/backend/routes/webauthn.py`, prefix `/api/auth/webauthn`):
      - `GET /status` — tells UI whether role is allowed and lists registered devices
      - `POST /register/begin` + `/register/complete` (auth required) — bound to existing user
      - `POST /authenticate/begin` + `/authenticate/complete` (public) — issues same JWT as `/auth/login`
      - `DELETE /credentials/{credential_id_hex}` — remove a device
      - **HR Admin role hard-blocked** at every endpoint (403). Implementation: `WEBAUTHN_BLOCKED_ROLES = {"hr_admin"}`.
      - Stack: `webauthn==2.7.1` (py-webauthn). RP_ID derived from `FRONTEND_URL` env var, so preview vs production work without code changes.
      - Two collections: `webauthn_credentials` (cred_id hex, public_key bytes, sign_count, friendly_name) and `webauthn_challenges` (5-min TTL, single-use).
      - Standard ECDSA-P256 + RS256 algorithms; `userVerification=preferred`; clone-detection via signature counter.
    - **Frontend**:
      - `@simplewebauthn/browser@13.3.0` for ceremony helpers + base64url handling
      - `<WebAuthnSetupCard>` on the personal Dashboard — "Set up biometric login" button + list of registered devices with remove buttons. Hidden for HR Admin.
      - Login page — new violet "Sign in with Biometric" button under password Sign In (only when WebAuthn is supported by the browser AND a username has been entered).
      - Helper `/utils/webauthn.js` wraps `startRegistration` / `startAuthentication` with friendly error messages (cancelled, already registered, no biometric available).
    - **Verified**: Admin returns `allowed:false` and 403 on register; field staff returns valid `PublicKeyCredentialCreationOptions` with correct rp_id from env. ESLint clean, ruff clean, backend reload clean. Login page screenshot confirms the new button.
    - **Production note**: User registers once on each device they want to use. Re-registration needed if device biometric is reset (e.g., new fingerprint enrolled on iOS).

42. **Personal Dashboard for HO + Field Staff (Feb 2026)** -
    Dashboard now adapts to the user's role:
    - **HO Staff (`employee`) and Field Staff (`field_agent`)** see a **personal** dashboard:
      - Big "Today's Attendance" card (`<QuickPunchCard>`) with one-click Punch In / Punch Out — same camera + GPS flow as `/attendance`, embedded inline. Multi-session aware ("Punch In Again" when a session is closed).
      - 3 personal stat cards: **Absent This Month**, **Pending Leaves** (clickable → `/leaves`), **Pending Regularisations** (clickable → `/attendance`).
      - Quick Actions row: Attendance History / Apply Leave / View Payslip / Performance.
    - **HR Admin / Management / Managers** unchanged: company-wide stats grid, recent activity feed, My Interviews panel.
    - **New backend endpoint** `GET /api/dashboard/my-stats` returns `today_status` (punch_in/out times, session_count, has_open_session, hours_worked, status), `pending_leaves`, `pending_regularisations`, `absent_this_month`, `month_label`. Absent count excludes Sundays + holidays + days with present/half-day record + days covered by approved leave.
    - **Refactor**: Extracted `<CameraCapture>` from `Attendance.js` to `/components/attendance/CameraCapture.js` so the punch UI can be reused by the dashboard widget without code duplication.

42. **Manager Role — Employees Page Restrictions + Universal Salary ACL (Feb 2026)** -
    `managers` role can no longer Bulk Upload, download/upload templates, Add Employees, or view salary/CTC details of any employee (including their direct reports). Manager visibility now uses the full reporting **sub-tree** (transitive via `services/hierarchy.get_descendant_employee_ids`) — RMF0010 sees 25 employees including reports-of-reports. **Update (same session):** salary stripping is now universal — `/api/employees` list & `/api/employees/{id}` detail strip `salary`, `ctc_monthly`, `ctc_annual` for **everyone except** `hr_admin`, `management`, or the employee themselves. This closes the leak where any `employee` / `field_agent` could fetch any peer's salary via the detail endpoint.
    - **Backend** `/app/backend/routes/employees.py`: helper renamed `_strip_salary_unless_authorised(emp, current_user)`. Rule: HR Admin / Management → full access; self → full access; everyone else → salary stripped.
    - **Frontend** `/app/frontend/src/pages/Employees.js`: gated **Bulk Upload**, **Template**, **Add Employee** behind `canManageEmployees = ["hr_admin","management"]`.
    - **Frontend** `/app/frontend/src/components/employees/EmployeeModal.js`: **Edit** tab hidden for `managers`.
    - **Verified** via curl: admin sees salary on anyone; employee sees own; employee can't see peer's; manager sees own; manager can't see report's. Payroll endpoints (NEFT export, `/payroll/employee/{other}`) remain 403 for managers.

41. **Manager Self-Regularisation Bug Fix (Feb 2026)** -
    Users with role `managers` (e.g., RMF0017) were unable to request attendance regularisation for themselves because `Attendance.js` rendered the personal-history block only when `!isManager`, hiding the "Request Regularisation" button.
    - **Fix** in `/app/frontend/src/pages/Attendance.js`: split the previous ternary into two independent blocks. Personal "My Attendance History" with the **Request Regularisation** button + **MyRequestsList** now renders when `user?.employee_id && !canRegulariseAdmin` (so it shows for `managers`, `employee`, and `field_agent` — but stays hidden for `hr_admin`/`management` who use the admin "Add Record" panel instead). The "Team Attendance" block now renders independently when `isManager` is true, so managers see **both** sections.
    - **Backend was already correct** — `POST /api/attendance/regularisation-requests` accepts any caller with an `employee_id`. Verified end-to-end via curl as RMF0017 and via Playwright screenshot.

41. **Face-Mismatch Photo Retention (Feb 2026)** -
    Auto-purge attendance face-mismatch selfies older than **45 days** to control DB size.
    - **New helper** `purge_old_face_mismatch_photos()` in `routes/attendance.py` runs an `update_many` to clear top-level `punch_in_photo` / `punch_out_photo` and per-session `sessions[].punch_in_photo` / `sessions[].punch_out_photo` for records with `date < today - 45d`. Audit metadata (face_matched flag, distance, warning, geofence info) is **preserved** for compliance.
    - **Auto-runs on every backend startup** AND **daily at 02:00 IST** via an in-process `asyncio` scheduler in `server.py` (`_daily_face_photo_purge_loop`). The loop survives errors (24h backoff) and is cleanly cancelled on shutdown.
    - **Manual trigger** via `POST /api/attendance/admin/purge-old-face-photos` (HR Admin only) returns `{cutoff_date, retention_days, top_level_records_purged, session_records_purged}`.
    - **Verified** with seeded 60-day + 10-day test records: photos stripped only from the 60-day one, audit metadata intact. Scheduler verified via boot logs: `Face-photo purge scheduler: next run in 9.6h (02:00 IST)`.

40. **Joining Kit Word Download (Feb 2026)** -
    HR can now download the Joining Kit in editable `.docx` format alongside the existing PDF.
    - **New service** `/app/backend/services/joining_kit_docx.py` (~750 LOC) builds the same 14-section bilingual layout as `joining_kit_pdf.py`. Uses `python-docx==1.2.0`. Word natively shapes Devanagari (Nirmala UI) so no Pillow workaround needed.
    - **New endpoint** `GET /api/candidates/{cand_id}/joining-kit-docx` (HR / management only). Same pre-conditions as the PDF: `status=selected`, `employee_id` set, `expected_joining_date` set.
    - **Frontend** `JoiningKitPanel.js` — added a second blue "Download Joining Kit (Word)" button next to the orange PDF button. Disabled until Employee ID + Joining Date are saved. `data-testid="download-joining-kit-docx-btn"`.
    - **Verified** via curl: HTTP 200, mime `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, 44 KB output, 14 sections, 26 tables, Hindi text rendered.

## P1 Backlog
- [ ] **Letter Generation PDFs** — Offer / Appointment / Warning / Confirmation letters with company letterhead (P0 — next planned task)
- [ ] **"Punch In with Face"** — WebAuthn biometric login + 1-tap attendance punch-in
- [ ] GPS location map view for field agent tracking
- [ ] Mobile-optimized attendance view
- [ ] WhatsApp/email notifications for leave approvals
- [ ] Bulk performance review creation

## P2 Backlog
- [ ] Leave Encashment Calculation (EL/PL during payroll or exit)
- [ ] `hr_admin` self-regularisation UI (allow HR Admin to file via standard UI instead of Add Record bypass)
- [ ] Document Completeness — scope `/document-completeness/all` to manager's sub-tree (currently whole company)
- [ ] 15-Minute Ping system clarification + implementation (awaiting user input)
- [ ] JWT session timeout adjustment / sliding window (awaiting user input)
- [ ] Employee self-portal for document upload
- [ ] Training records module
- [ ] Asset management integration
- [ ] Integration with statutory compliance (PF portal, ESIC portal)

## Refactoring Backlog
- [x] ~~Extract duplicated Saturday-rule logic from `AttendanceRegisterTab.js` + `MonthlyAttendanceReport.js` into a shared `/app/frontend/src/utils/shiftRules.js` helper.~~ DONE (Feb 2026, as part of Monthly Report WO bug fix).

## Recent Iter-11 Regression Pass (Feb 2026)
- **34/34 backend tests pass** (`/app/backend/tests/test_iter11_regression.py`). Verified all 7 new features since iter-10: Bulk Salary Excel template + upload, `epf_employee` Pydantic field, email-mandatory / last_name-optional, `saturday_rule` shift field (now `Literal` validated), ACL hardening on documents / tracker / dashboard payroll-stats, manager hierarchy visibility, and full auth/employees/attendance/leaves/shifts regression.
- **Minor improvements applied** post-test: `shifts.saturday_rule` now strictly typed as `Literal["all_working","alt_1_3_off","alt_2_4_off","all_off"]` (422 on typos); `test_credentials.md` corrected (RMF0001 is `managers`, not `employee`).
- **Known minor (non-bugs, documented)**: `/api/attendance/monthly` does NOT exist server-side — frontend builds matrix client-side from `/attendance` + `/leaves` + `/holidays` + `/shifts`. Bulk-salary endpoints are `/employees/bulk-salary/template` and `/employees/bulk-salary/upload` (only `hr_admin` — by design). Dashboard `/stats` soft-gates `payroll_processed_this_month` to `None` for non-admin (by design).

## Bug Fix — Monthly Report & Matrix Saturday WO (Feb 2026)
Three compounded bugs caused 1st/3rd Saturdays (and even Sundays) to display as "Absent" instead of "Weekly Off" in IST browsers:
1. **TZ bug** — `Date.prototype.toISOString().split('T')[0]` returns UTC date strings, which lag by one day in IST evenings (and even at midnight for `new Date(year, month-1, 1)`). All date generation/comparison helpers in `MonthlyAttendanceReport.js` + `AttendanceRegisterTab.js` were affected — Saturdays computed dow=5 (Fri), Sundays dow=6 (Sat), so WO logic never fired correctly.
2. **Spread order bug** — `MonthlyAttendanceReport.js` passed `record={{ status, ...(rec || {}) }}` to `AttendanceStatusBadge`. Since spread came AFTER `status`, the record's original "absent"/"present" status overrode the computed `weekly_off`. Flipped to `{ ...(rec || {}), status }`.
3. **WO-override priority bug** — Regularised "present" records with NO `punch_in_time` were being treated as "positive attendance" and visually blocking the WO label. Refined the rule: only an **actual punch-in** (`!!rec.punch_in_time`) can override a Weekly-Off / Holiday cell. A regularised record without a real punch defers to calendar rules.

**Refactor delivered (P2 backlog item)**: Extracted shared date / Saturday-rule helpers into `/app/frontend/src/utils/shiftRules.js` (`toLocalDateStr`, `buildMonthDates`, `daysInMonth`, `getNthSaturday`, `saturdayIndex`, `isWeeklyOff`, `resolveEmpSatRule`). Both `MonthlyAttendanceReport.js` and `AttendanceRegisterTab.js` now import from this single source of truth.

**Verified** in Playwright with TZ-correct logic: HO Shift (`alt_1_3_off`) — May 2026:
- 2-May (1st Sat) = WO, 3-May (Sun) = WO
- 9-May (2nd Sat) = working/A, 10-May (Sun) = WO
- 16-May (3rd Sat, with overlapping SL leave) = WO (WO wins)
- 23-May (4th Sat) = working/A, 24-May (Sun) = WO
- 30-May (5th Sat) = WO, 31-May (Sun) = WO

Files changed: `/app/frontend/src/utils/shiftRules.js` (new), `/app/frontend/src/components/attendance/MonthlyAttendanceReport.js`, `/app/frontend/src/components/attendance/AttendanceRegisterTab.js`.

## LOP Saturday WO Gap Fix (Feb 2026)
`calculate_lop_days()` in `/app/backend/routes/payroll.py` previously only skipped Sundays — it counted 1st/3rd Saturdays (and any other non-working Saturday per the employee's shift `saturday_rule`) as LOP. For HO Shift staff (`alt_1_3_off`) with no manual punch on those Saturdays, the payroll was wrongly pro-rating salary down by 2 days/month.

**Fix**: Resolve each employee's effective shift via `services.shift_rules.resolve_shift_for(role, employee_id, db)`, extract `saturday_rule`, and skip non-working Saturdays in the LOP loop. New helper `_is_non_working_saturday(d, sat_rule)` mirrors the frontend `isWeeklyOff()` from `/app/frontend/src/utils/shiftRules.js`. Supports `all_working` / `alt_1_3_off` / `alt_2_4_off` / `all_off`.

**Verified**: Unit-tested all 5 Saturdays of May 2026 against `alt_1_3_off` rule (2, 16, 30 → WO ✓; 9, 23 → working ✓). RMF0009 May 2026 LOP recomputed: was previously over-counting 1st/3rd Saturdays → now 11 LOP days (correct).

## Bug Fix — Regularised attendance shown as Absent + Punch-Time TZ Mismatch (Feb 2026)
Three connected fixes:
1. **Mandatory punch times** — Previously, the Employee "Request Regularisation" modal sent `punch_in_time: null` always, and the Admin "Add Record" modal allowed saving Present/Half Day without any punch. With no punch time, the StatusBadge fell through to "Absent" rendering even though `status === "present"`. Now both modals require BOTH Punch-In and Punch-Out when status is `present` or `half_day`. Validated client-side AND on the backend via new `_enforce_punch_required()` helper across all three regularisation endpoints (`PATCH /attendance/records/{id}`, `POST /attendance/records`, `POST /attendance/regularisation-requests`).
2. **Timezone mismatch** — `_normalise_time()` previously interpreted HR-entered `HH:MM` as **UTC** and stored it as `+00:00`. The UI then displayed via `toLocaleTimeString("en-IN")` which converts UTC → IST, so typing `09:30` rendered back as `15:00` IST. Now manual HH:MM input is interpreted as **IST (Asia/Kolkata, +05:30)** so what HR types is what HR sees. Frontend `isoToTime()` switched from `getUTCHours()` to `getHours()` (local IST). Labels updated from "HH:MM UTC" → "Punch In (IST)" / "Punch Out (IST)".
3. **Defensive StatusBadge + Matrix fallback** — Added explicit `status === "present" || status === "full_day"` case in `StatusBadge.js` so any legacy regularised record without `punch_in_time` still renders as Present. AttendanceRegisterTab `cellInfo()` similarly returns `FD (regularised)` on working days for no-punch positive records.
4. **Data migration** — Re-anchored 6 legacy regularised records that were stored with `+00:00` offset to `+05:30` (preserving the wallclock value the HR originally typed) — affects RMF0001, RMF0008, RMF0009 records for Jan/Feb/May 2026 dates. Real-punch records (10 records using `datetime.now(timezone.utc)`) were left alone since they store TRUE UTC instants and convert correctly on display.

Files: `/app/backend/routes/attendance.py` (IST_TZ, `_normalise_time`, `_enforce_punch_required`), `/app/frontend/src/components/attendance/Regularisation.js`, `/app/frontend/src/components/attendance/StatusBadge.js`, `/app/frontend/src/components/attendance/AttendanceRegisterTab.js`.

Verified via curl:
- POST /records `{status:"present", reason:"..."}` → 400 "Punch-In time is mandatory…"
- POST /records `{status:"present", punch_in_time:"09:30"}` → 400 "Punch-Out time is mandatory…"
- POST /records `{status:"present", punch_in_time:"09:30", punch_out_time:"18:00"}` → 200, stored as `2026-04-15T09:30:00+05:30`
- POST /records `{status:"absent"}` → 200 (punch times not required for negative statuses)
- Round-trip: 09:30 IST input → en-IN display = "09:30 am" ✅

## TZ Sweep (Feb 2026)
Followed-up the WO bug fix by sweeping all remaining `new Date().toISOString().split('T')[0]` civil-date usages — these returned UTC dates in IST browsers, so "today" looked like yesterday for any IST user after 18:30 IST and date inputs / "max" attributes / history-default-dates were one day behind. Replaced with `toLocalDateStr()` from `/app/frontend/src/utils/shiftRules.js` across:
- `/app/frontend/src/pages/Attendance.js` (today_iso, thirty_days_ago, fetch-attendance today lookup, render-time today)
- `/app/frontend/src/pages/Dashboard.js` (My Interviews today/past comparison)
- `/app/frontend/src/pages/FieldTracking.js` (Live tab date selector, history date selector, date `max` constraints, "track today" quick-action)
- `/app/frontend/src/components/attendance/Regularisation.js` (Admin Add Record default date, Employee Request Regularisation date + max constraint)

Full-ISO timestamps (`queued_at`, `verified_at`, audit `created_at`) intentionally kept as `toISOString()` — those need UTC instants. `HolidayCalendar.js` already had its own `toLocalISO(y,m,d)` helper and is unaffected.


## Bug Fix: Bulk File Upload (Jun 2026)
- **Root Cause**: All file upload calls (Leaves, Employees, ExitManagement, CandidateApply) were manually setting `Content-Type: multipart/form-data` without the required `boundary` parameter. Production proxies (nginx) are stricter and reject boundary-less multipart requests.
- **Fix**: Added FormData detection in axios interceptor (`/app/frontend/src/utils/api.js`). When request body is FormData, Content-Type is deleted so the browser sets it automatically with the correct boundary. Removed all manual `Content-Type: multipart/form-data` overrides from: `Leaves.js`, `Employees.js` (×2), `ExitManagement.js` (×2), `CandidateApply.js`.
- **Files**: `/app/frontend/src/utils/api.js`


## Payslip Visibility Rule Change + Unpublished Banner (Jul 2026)
- **Change**: Employees now see payslips **only when status = `paid`** (previously `processed` was also sufficient). Draft and processed records are hidden from employees until HR explicitly marks them as paid.
- **"Mark All Paid" button** (was "Publish Payslips") — now promotes both `draft` AND `processed` records to `paid` for the selected month in one click.
- **Unpublished payslips banner** — amber warning banner appears at the top of the Payroll page for HR/management whenever past-period payroll records exist that are NOT marked as paid. Each flagged period shows a "Release [Month]" quick-action button.
- **Files**: `/app/backend/routes/payroll.py` (`_is_payslip_visible_to_employee`, `/publish` endpoint), `/app/frontend/src/pages/Payroll.js` (banner, button label)

## Bug Fix — Payslip Visibility + Publish Payslips (Jul 2026)
- **Root Cause**: Payroll records are created as `draft`. The gating rule `_is_payslip_visible_to_employee()` hides `draft` records from employees — only `processed` or `paid` records are shown. Previously HR had to open every single payslip modal and click "Save" to promote it to `processed`, one by one.
- **Also Fixed**: Period filter dropdown was hardcoded up to `2026-05` — months from June 2026 onward weren't selectable.
- **Fixes**:
  1. **New backend endpoint** `POST /api/payroll/publish?period=YYYY-MM` — bulk-promotes ALL `draft` records for the period to `processed` in one shot.
  2. **"Publish Payslips" button** added to the Payroll toolbar (indigo). HR selects the month → clicks Publish → all draft payslips become visible to employees immediately.
  3. **Period dropdown now dynamic** — built from 2025-01 up to the current month via `useMemo`; no hardcoded end.
- **Files**: `/app/backend/routes/payroll.py`, `/app/frontend/src/pages/Payroll.js`
