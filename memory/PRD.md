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
- EPF Employee = 12% of Basic
- EPF Employer = 12% of Basic
- ESIC Employee = 0.75% of Gross (if Gross ≤ ₹21,000)
- ESIC Employer = 3.25% of Gross (if Gross ≤ ₹21,000)
- Monthly Gratuity = (Basic × 15) / (26 × 12)
- Monthly CTC = Gross + EPF Employer + ESIC Employer + Monthly Gratuity
- Net = Gross - EPF Employee - ESIC Employee - TDS - Other Deductions

## P0 Backlog (Next Phase)
- [x] NEFT sheet custom format (RMF0001 8-column bank format) ✅ Apr 2026
- [ ] Payslip PDF download
- [ ] Letter PDFs (Offer / Appointment / Warning etc.) with company letterhead
- [ ] Employee confirmation letter after probation
- [ ] Monthly salary register export
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
