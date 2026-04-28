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
- [ ] NEFT sheet custom format (user to provide format)
- [ ] Payslip PDF download
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
