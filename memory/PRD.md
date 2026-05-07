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

## What's Implemented (Feb 2026)
### ✅ Phase 1 Complete
1. **Authentication** - JWT login, role-based access, user management
2. **Employee Management** - CRUD, bulk CSV upload, salary components
3. **Candidate Onboarding** - Add candidates, Aadhaar OCR (Gemini AI), status tracking
4. **Attendance** - Selfie capture, GPS geofencing (10m), punch in/out
5. **Leave Management** - CL/SL/EL/Maternity/Paternity, balance tracking, approval workflow
6. **Payroll** - EPF 12%, ESIC 0.75%/3.25%, Gratuity provision, NEFT Excel export
7. **Performance Management** - Half-yearly reviews, self/manager assessment, CTC increase
8. **Exit Management** - Resignation, 3-level approval, Full & Final Settlement
9. **Letter Generation** - Appointment, Offer, Promotion, Warning, Experience, Relieving, Increment
10. **Gratuity** - Eligibility check (5yr), calculation, monthly provision
11. **Settings** - 5 office locations (Moradabad HO, Chandpur, Najibabad, Budaun, Chandausi)

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

## P0 Backlog (Next Phase)
- [x] NEFT sheet custom format (RMF0001 8-column bank format) ✅ Apr 2026
- [x] Payslip PDF download ✅ Apr 2026
- [x] UAN Number and ESI Number fields on employees ✅ Apr 2026
- [x] Admin Leave Balance Management — Initialize, Manual Edit, Bulk Excel Upload, Audit Log ✅ Apr 2026
- [x] Monthly Salary Register export ✅ Apr 2026
- [x] Holiday Calendar (CRUD + India defaults seed) + Sun/1st-3rd-Sat rules + Comp-Off (auto-detect, HR approve, 90-day expiry) ✅ May 2026
- [x] Payroll Deductions column + LOP-day deduction with auto pro-rata ✅ Feb 2026
- [x] PWA Mobile-friendly UI: Bottom navigation bar, larger touch targets, modal z-index fix, Emergent badge overlap fix ✅ May 2026
- [x] Unique field validation: Aadhaar, PAN, Mobile, Email instantly checked across candidates + employees in all forms (AddCandidate, EmployeeEdit, CandidateApply) ✅ May 2026
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

- [ ] Employee confirmation letter after probation
- [ ] Leave encashment calculation

## P1 Backlog
- [ ] GPS location map view for field agent tracking
- [ ] Mobile-optimized attendance view
- [ ] WhatsApp/email notifications for leave approvals
- [ ] Bulk performance review creation

## P2 Backlog
- [ ] Employee self-portal for document upload
- [ ] Training records module
- [ ] Asset management integration
- [ ] Integration with statutory compliance (PF portal, ESIC portal)
