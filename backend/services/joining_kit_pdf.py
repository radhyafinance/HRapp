"""Generate a pre-filled joining kit PDF for a selected candidate.
Mirrors the structure of the bank's `Joining Kit Online.docx` template.
"""
from io import BytesIO
from datetime import datetime
from typing import Optional

from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, KeepTogether
)
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY


# ----- Styles ---------------------------------------------------------------

_styles = getSampleStyleSheet()

H1 = ParagraphStyle("H1", parent=_styles["Heading1"], fontSize=14, leading=18,
                    textColor=colors.HexColor("#1E2A47"), spaceBefore=8, spaceAfter=4)
H2 = ParagraphStyle("H2", parent=_styles["Heading2"], fontSize=11, leading=14,
                    textColor=colors.HexColor("#1E2A47"), spaceBefore=8, spaceAfter=4)
TITLE = ParagraphStyle("TITLE", parent=_styles["Heading1"], fontSize=18, leading=22,
                       alignment=TA_CENTER, textColor=colors.HexColor("#1E2A47"),
                       spaceBefore=4, spaceAfter=4)
SUBTITLE = ParagraphStyle("SUBTITLE", parent=_styles["Normal"], fontSize=10, leading=12,
                          alignment=TA_CENTER, textColor=colors.HexColor("#6B7280"),
                          spaceAfter=8)
BODY = ParagraphStyle("BODY", parent=_styles["BodyText"], fontSize=9, leading=12,
                      alignment=TA_JUSTIFY)
SMALL = ParagraphStyle("SMALL", parent=_styles["BodyText"], fontSize=8, leading=10,
                       textColor=colors.HexColor("#374151"))
NOTE = ParagraphStyle("NOTE", parent=_styles["Italic"], fontSize=8, leading=10,
                      textColor=colors.HexColor("#6B7280"))
LABEL = ParagraphStyle("LABEL", parent=_styles["BodyText"], fontSize=9, leading=12,
                       textColor=colors.HexColor("#1E2A47"))


_TABLE_HEADER_BG = colors.HexColor("#1E2A47")
_TABLE_HEADER_FG = colors.HexColor("#FFFFFF")
_TABLE_ALT_BG = colors.HexColor("#F8FAFC")
_BORDER = colors.HexColor("#9CA3AF")


def _hbox_table(rows, col_widths=None):
    """Two-column key/value table."""
    table = Table(rows, colWidths=col_widths or [55 * mm, 110 * mm])
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("TEXTCOLOR", (0, 0), (0, -1), colors.HexColor("#1E2A47")),
        ("BACKGROUND", (0, 0), (0, -1), _TABLE_ALT_BG),
        ("BOX", (0, 0), (-1, -1), 0.5, _BORDER),
        ("INNERGRID", (0, 0), (-1, -1), 0.3, _BORDER),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return table


def _grid_table(headers, rows, col_widths=None, repeat_header=True):
    data = [headers] + rows
    table = Table(data, colWidths=col_widths, repeatRows=1 if repeat_header else 0)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), _TABLE_HEADER_BG),
        ("TEXTCOLOR", (0, 0), (-1, 0), _TABLE_HEADER_FG),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (0, 0), (-1, 0), "CENTER"),
        ("BOX", (0, 0), (-1, -1), 0.6, _BORDER),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, _BORDER),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return table


def _empty_rows(template_row, count):
    """Create N copies of a row with empty values for the data columns."""
    return [list(template_row) for _ in range(count)]


def _checkbox(checked: bool) -> str:
    return "[ X ]" if checked else "[   ]"


def _fmt_date(value: Optional[str]) -> str:
    if not value:
        return ""
    try:
        # Accept YYYY-MM-DD or DD/MM/YYYY
        if "-" in value and len(value) >= 10:
            d = datetime.strptime(value[:10], "%Y-%m-%d")
            return d.strftime("%d/%m/%Y")
        if "/" in value:
            return value
    except Exception:
        pass
    return str(value)


def _addr_line(c: dict) -> str:
    parts = [c.get("address"), c.get("city"), c.get("state"), c.get("pincode")]
    return ", ".join([p for p in parts if p])


# ----- Section builders -----------------------------------------------------


def _header(story, candidate, company):
    company_name = company.get("company_name") or "Radhya Micro Finance Private Limited"
    company_addr = company.get("address") or "MIG-29, Ram Ganga Vihar, Vistar, Moradabad, UP - 244001"
    story.append(Paragraph(company_name, TITLE))
    story.append(Paragraph(company_addr, SUBTITLE))
    story.append(Paragraph("JOINING KIT — Version 1.1 (For official use only)", H2))
    story.append(Paragraph("(To be filled in CAPITAL LETTERS)", NOTE))

    full_name = f"{candidate.get('first_name', '')} {candidate.get('last_name', '')}".strip().upper()
    rows = [
        ["1. Employee Name", full_name],
        ["2. Employee Code", "(To be assigned by HR)"],
        ["3. Mobile No.", candidate.get("mobile", "")],
        ["4. Date of Joining", _fmt_date(candidate.get("expected_joining_date"))],
        ["5. Designation", candidate.get("position", "")],
        ["6. Department", candidate.get("department", "")],
        ["7. Joining Location", candidate.get("joining_location") or company.get("joining_location") or "Head Office, Moradabad"],
    ]
    story.append(_hbox_table(rows))
    story.append(Spacer(1, 6))


def _documents_checklist(story, candidate, has_aadhaar, has_pan):
    story.append(Paragraph("DOCUMENTS CHECKLIST FOR NEW JOINERS", H2))
    items = [
        ("Joining Kit — 1(a) Offer Letter", False, ""),
        ("1(B) Appointment Letter", False, ""),
        ("1(C) Employee Information Sheet", True, "Pre-filled below"),
        ("1(D) Staff Undertaking", True, "Included below"),
        ("1(E) Employee Medical Form", False, ""),
        ("1(F) Gratuity Form (Form F)", True, "Included below"),
        ("1(G) PF Form (Form 2 + Form 11)", True, "Included below"),
        ("1(H) ESIC Form", True, "Included below"),
        ("Cancelled cheque / Passbook copy", False, "To submit (Compulsory)"),
        ("Passport size photographs (2 copies)", False, "To submit"),
        ("ID Proof — Aadhaar Card Copy", has_aadhaar, "Already provided" if has_aadhaar else "To submit (Compulsory)"),
        ("Address Proof — Aadhaar / Voter ID / DL", has_aadhaar, "Aadhaar on file" if has_aadhaar else "To submit (Compulsory)"),
        ("10th Std. Certificate (Self attested)", False, "To submit"),
        ("12th Std. Certificate (Self attested)", False, "To submit"),
        ("Graduation Certificate (Self attested)", False, "To submit"),
        ("Post-Graduation (if applicable)", False, "To submit"),
        ("PAN Card Copy", has_pan, "Already provided" if has_pan else "To submit"),
        ("Bike RC + PUC + Insurance (if applicable)", False, "To submit"),
        ("Online Police Verification Report", False, "Pending HR verification"),
    ]
    rows = [[str(i + 1), p, _checkbox(checked), remark] for i, (p, checked, remark) in enumerate(items)]
    story.append(_grid_table(
        ["Sr.", "Particular", "Checked", "Remark"],
        rows,
        col_widths=[10 * mm, 90 * mm, 18 * mm, 47 * mm],
    ))
    story.append(Spacer(1, 4))
    story.append(Paragraph("Check &amp; Verified — Team HR", LABEL))
    story.append(Spacer(1, 6))


def _employee_info_sheet(story, c):
    story.append(PageBreak())
    story.append(Paragraph("EMPLOYEE INFORMATION SHEET", H1))
    story.append(Paragraph("(Attach passport size photograph)", NOTE))

    full_name = f"{c.get('first_name', '')} {c.get('last_name', '')}".strip()
    rows = [
        ["1. Employee Name", full_name],
        ["2. Father's / Spouse Name", c.get("father_or_husband_name", "")],
        ["3. Mother's Name", ""],
        ["4. Aadhaar Card No.", c.get("aadhaar_number", "")],
        ["5. Voter ID No.", ""],
        ["6. PAN Card No.", c.get("pan_number", "")],
        ["7. Driving License No.", ""],
        ["8. Date of Birth", c.get("dob", "")],
        ["9. Mobile No.", c.get("mobile", "")],
        ["10. Emergency Mobile No.", ""],
        ["11. Relationship with Emergency Contact", ""],
        ["12. Parents Mobile No. (Father / Mother)", ""],
        ["13. E-mail ID", c.get("email", "")],
        ["14. Marital Status", ""],
        ["15. Nationality", "Indian"],
        ["16. Religion", ""],
        ["17. Category (Gen / OBC / SC / ST)", ""],
        ["18. Blood Group", ""],
        ["19. Permanent Address (As per Aadhaar)", _addr_line(c)],
        ["20. Correspondence Address", _addr_line(c)],
    ]
    story.append(_hbox_table(rows))
    story.append(Spacer(1, 6))

    # 21. Education
    story.append(Paragraph("21. Educational Qualification", H2))
    edu_rows = [
        ["SC / 10th Standard", "", "", ""],
        ["HSC / 12th Standard", "", "", ""],
        ["Graduation (BA / B.Com / B.Sc / BE / Other)", "", "", ""],
        ["Post-Graduation / Diploma", "", "", ""],
        ["Any other qualification", "", "", ""],
    ]
    story.append(_grid_table(
        ["School / Degree", "Institute / Board Name", "Marks / Grade", "Passing Year"],
        edu_rows,
        col_widths=[55 * mm, 60 * mm, 25 * mm, 25 * mm],
    ))
    story.append(Spacer(1, 6))

    # 22. Employment History
    story.append(Paragraph("22. Employment History (most recent first)", H2))
    story.append(_grid_table(
        ["Company Name", "Position Held", "Period (From — To)", "Reason for Leaving"],
        _empty_rows(["", "", "", ""], 3),
        col_widths=[45 * mm, 45 * mm, 40 * mm, 35 * mm],
    ))
    story.append(Spacer(1, 6))

    # 23. Relatives
    story.append(Paragraph("23. Details of Relatives / Known Persons working at Radhya Micro Finance", H2))
    story.append(_grid_table(
        ["Name", "Relationship", "Designation", "Posted At"],
        _empty_rows(["", "", "", ""], 2),
        col_widths=[45 * mm, 35 * mm, 40 * mm, 45 * mm],
    ))
    story.append(Spacer(1, 6))

    # 24. References
    story.append(Paragraph("24. Two References (other than relatives)", H2))
    story.append(_grid_table(
        ["Name", "Company Name", "Position", "Phone No."],
        _empty_rows(["", "", "", ""], 2),
        col_widths=[45 * mm, 50 * mm, 35 * mm, 35 * mm],
    ))
    story.append(Spacer(1, 8))


def _staff_undertaking(story, c):
    story.append(PageBreak())
    story.append(Paragraph("STAFF UNDERTAKING", H1))
    full_name = f"{c.get('first_name', '')} {c.get('last_name', '')}".strip()
    para = (
        f"I, <b>{full_name or '_______________'}</b>, S/o or D/o or W/o "
        f"<b>{c.get('father_or_husband_name', '_______________')}</b>, "
        f"residing at <b>{_addr_line(c) or '_______________'}</b>, "
        "do hereby affirm on oath that:"
    )
    story.append(Paragraph(para, BODY))
    bullets = [
        "The information regarding my academic qualifications and work experience mentioned in my bio-data is true and accurate.",
        "There have never been any legal proceedings initiated against me, nor have I been involved in any misconduct, fraud or embezzlement of cash in any previous employment.",
        "I declare the above statements to be true. Any statement found to be false or deliberately misleading may make me liable for dismissal without prior notice.",
        "I will familiarise myself with my Job Description and the Company's Credit Policy.",
        "I will carry out my responsibilities with care, diligence and thoroughness, and obey the Staff & Office Rules.",
        "I will supervise subordinate staff (if any) systematically and ensure all instructions are carried out as per the Operations Manual.",
        "I will be honest and sincere in all my work and do nothing that would detract from the goodwill of the Company.",
    ]
    for b in bullets:
        story.append(Paragraph(f"• {b}", BODY))
    story.append(Spacer(1, 10))
    story.append(_hbox_table([
        ["Joining Location", c.get("joining_location") or "Head Office, Moradabad"],
        ["Date of Joining", _fmt_date(c.get("expected_joining_date"))],
        ["Employee Signature", ""],
    ]))
    story.append(Spacer(1, 6))


def _insurance_form(story, c):
    story.append(PageBreak())
    story.append(Paragraph("EMPLOYEE INSURANCE FORM", H1))
    story.append(Paragraph("(Group Medical Insurance, Group Personal Accident &amp; Group Term Life)", NOTE))
    story.append(Paragraph(
        "I hereby undertake that I wish to become a member of the Employee's Insurance Policy. "
        "I am providing the requisite particulars below.", BODY))
    story.append(Spacer(1, 4))

    full_name = f"{c.get('first_name', '')} {c.get('last_name', '')}".strip()
    story.append(Paragraph("Member Enrolment Form", H2))
    story.append(_grid_table(
        ["Employee Name", "Employee Code", "DOB", "Gender", "Age"],
        [[full_name, "", c.get("dob", ""), c.get("gender", ""), ""]],
        col_widths=[55 * mm, 30 * mm, 30 * mm, 25 * mm, 25 * mm],
    ))
    story.append(Spacer(1, 6))

    story.append(Paragraph("Dependent Details", H2))
    story.append(_grid_table(
        ["Relation", "Name", "DOB", "Gender", "Age"],
        [["Father", "", "", "", ""], ["Mother", "", "", "", ""], ["Spouse", "", "", "", ""],
         ["1st Child", "", "", "", ""], ["2nd Child", "", "", "", ""]],
        col_widths=[30 * mm, 60 * mm, 25 * mm, 25 * mm, 25 * mm],
    ))
    story.append(Spacer(1, 6))

    story.append(Paragraph(
        "In case of my death (or any other mishap), I request the Company to provide the insurance "
        "coverage amount to the nominee given below.", BODY))
    story.append(_grid_table(
        ["Nominee Name", "Relationship", "Share (%)", "Permanent Address with Pincode"],
        _empty_rows(["", "", "", ""], 2),
        col_widths=[45 * mm, 30 * mm, 20 * mm, 70 * mm],
    ))
    story.append(Spacer(1, 4))
    story.append(Paragraph(
        "I understand that this undertaking is irrevocable for the payment of premium amount by the Company "
        "during my service period and shall inform the Company in writing of any change to the nominee.", BODY))
    story.append(Spacer(1, 8))
    story.append(_hbox_table([["Date", ""], ["Employee Signature", ""]]))


def _gratuity_form(story, c):
    story.append(PageBreak())
    story.append(Paragraph("FORM 'F' — Payment of Gratuity Act (Sub-rule 1 of Rule 6) — Nomination", H1))
    full_name = f"{c.get('first_name', '')} {c.get('last_name', '')}".strip()
    story.append(Paragraph(
        "To,<br/>Radhya Micro Finance Pvt Ltd<br/>"
        "MIG-29, Ram Ganga Vihar Vistar, Moradabad — 244001", BODY))
    story.append(Spacer(1, 4))
    story.append(Paragraph(
        f"Shri/Shrimati: <b>{full_name or '_______________'}</b>, "
        "whose particulars are given in the statement below.", BODY))
    story.append(Paragraph(
        "I hereby nominate the person(s) mentioned below to receive the gratuity payable after my death "
        "(also gratuity standing to my credit in the event of my death before payment), in the proportion indicated.", BODY))
    story.append(Spacer(1, 6))

    story.append(_grid_table(
        ["Nominee Name", "Relationship", "Age", "Share (%)", "Permanent Address with Pincode"],
        _empty_rows(["", "", "", "", ""], 2),
        col_widths=[40 * mm, 30 * mm, 15 * mm, 20 * mm, 60 * mm],
    ))
    story.append(Spacer(1, 6))

    story.append(Paragraph("Statement", H2))
    story.append(_grid_table(
        ["Name", "Sex", "Religion", "Marital Status", "Department", "Post Held", "Date of Appointment"],
        [[full_name, c.get("gender", ""), "", "", c.get("department", ""), c.get("position", ""),
          _fmt_date(c.get("expected_joining_date"))]],
        col_widths=[35 * mm, 12 * mm, 18 * mm, 22 * mm, 28 * mm, 28 * mm, 22 * mm],
    ))
    story.append(Spacer(1, 6))

    story.append(_hbox_table([
        ["Permanent Address", _addr_line(c)],
        ["Place", ""],
        ["Date", ""],
        ["Signature / Thumb Impression", ""],
    ]))
    story.append(Spacer(1, 6))
    story.append(Paragraph("Note: Strike out words / paragraphs not applicable.", NOTE))


def _epf_form(story, c):
    story.append(PageBreak())
    story.append(Paragraph("FORM 2 (Revised) — EPF & EPS Nomination & Declaration", H1))
    story.append(Paragraph("Para 33 & 61(1) EPF Scheme 1952 / Para 18 EPS 1995", NOTE))

    story.append(Paragraph("Part-A (EPF)", H2))
    story.append(Paragraph(
        "I hereby nominate the person(s) below to receive the amount standing to my credit in the EPF "
        "in the event of my death.", BODY))
    story.append(_grid_table(
        ["Name of Nominee", "Address", "Relationship", "Age / DOB", "Share (%)", "Guardian (if minor)"],
        _empty_rows(["", "", "", "", "", ""], 2),
        col_widths=[35 * mm, 45 * mm, 25 * mm, 22 * mm, 18 * mm, 25 * mm],
    ))
    story.append(Spacer(1, 4))

    story.append(Paragraph("Part-B (EPS)", H2))
    story.append(Paragraph(
        "I furnish the particulars of members of my family who would be eligible to receive widow / children "
        "pension in the event of my death.", BODY))
    story.append(_grid_table(
        ["Family Member", "Name", "Address", "DOB", "Relation"],
        [["Father", "", "", "", "Father"], ["Mother", "", "", "", "Mother"],
         ["Spouse", "", "", "", "Spouse"], ["Child 1", "", "", "", "Child"]],
        col_widths=[28 * mm, 35 * mm, 50 * mm, 22 * mm, 25 * mm],
    ))
    story.append(Spacer(1, 6))

    story.append(Paragraph("Form 11 — Declaration Form", H2))
    full_name = f"{c.get('first_name', '')} {c.get('last_name', '')}".strip()
    story.append(_hbox_table([
        ["1. Name of the Member", full_name],
        ["2. Father's / Spouse's Name", c.get("father_or_husband_name", "")],
        ["3. Date of Birth", c.get("dob", "")],
        ["4. Gender", c.get("gender", "")],
        ["5. Marital Status", ""],
        ["6. Email ID", c.get("email", "")],
        ["7. Mobile No.", c.get("mobile", "")],
        ["8. Earlier member of EPF Scheme 1952?", ""],
        ["9. Earlier member of EPS Scheme 1995?", ""],
        ["10(a). Universal Account Number (UAN)", ""],
        ["10(b). Previous PF Account Number", ""],
        ["10(c). Date of exit from previous employment", ""],
        ["11. International Worker?", "No"],
    ]))
    story.append(Spacer(1, 6))

    story.append(Paragraph("KYC Detail", H2))
    story.append(_hbox_table([
        ["12(a). Bank Name", ""],
        ["12(b). Bank Account Number", ""],
        ["12(c). IFSC Code", ""],
        ["12(d). Aadhaar Number", c.get("aadhaar_number", "")],
        ["12(e). PAN", c.get("pan_number", "")],
    ]))
    story.append(Spacer(1, 6))

    story.append(Paragraph(
        "I certify that the particulars are true to the best of my knowledge. I authorise EPFO to use my "
        "Aadhaar for verification / authentication / e-KYC purposes for service delivery.", BODY))
    story.append(Spacer(1, 8))
    story.append(_hbox_table([["Date", ""], ["Place", ""], ["Signature of Member", ""]]))


def _esi_form(story, c):
    story.append(PageBreak())
    story.append(Paragraph("ESI TEMP CARD DETAILS", H1))
    full_name = f"{c.get('first_name', '')} {c.get('last_name', '')}".strip()
    story.append(_hbox_table([
        ["1. Employee Name", full_name],
        ["2. DOB", c.get("dob", "")],
        ["3. Gender", c.get("gender", "")],
        ["4. Marital Status", ""],
        ["5. Aadhaar No.", c.get("aadhaar_number", "")],
        ["6. Contact No.", c.get("mobile", "")],
        ["7. Father's Name", c.get("father_or_husband_name", "")],
        ["8. Spouse Name (if married)", ""],
        ["9. Correspondence Address", _addr_line(c)],
        ["10. Permanent Address", _addr_line(c)],
        ["11. ESI No. (if any)", ""],
        ["12. Nearest ESI Dispensary", ""],
    ]))
    story.append(Spacer(1, 6))

    story.append(Paragraph("Nominee Details", H2))
    story.append(_grid_table(
        ["Nominee Name", "Relationship", "Contact No.", "Address"],
        _empty_rows(["", "", "", ""], 1),
        col_widths=[40 * mm, 30 * mm, 30 * mm, 65 * mm],
    ))
    story.append(Spacer(1, 4))
    story.append(Paragraph("Family Details", H2))
    story.append(_grid_table(
        ["Relationship", "Name", "DOB", "Aadhaar No."],
        [["Father", "", "", ""], ["Mother", "", "", ""], ["Spouse", "", "", ""],
         ["1st Child", "", "", ""], ["2nd Child", "", "", ""]],
        col_widths=[30 * mm, 60 * mm, 30 * mm, 45 * mm],
    ))


def _notice_period_declaration(story, c):
    story.append(PageBreak())
    story.append(Paragraph("DECLARATION — NOTICE PERIOD", H1))
    full_name = f"{c.get('first_name', '')} {c.get('last_name', '')}".strip()
    story.append(Paragraph(
        f"I, <b>{full_name or '_______________'}</b>, S/o or D/o or W/o "
        f"<b>{c.get('father_or_husband_name', '_______________')}</b>, residing at "
        f"<b>{_addr_line(c) or '_______________'}</b>, am joining Radhya Micro Finance Private Limited "
        f"on <b>{_fmt_date(c.get('expected_joining_date')) or '_______________'}</b> "
        f"in the role of <b>{c.get('position', '_______________')}</b>. "
        "I have been informed of the following notice-period requirement applicable on resignation:", BODY))
    story.append(Spacer(1, 4))
    story.append(_grid_table(
        ["Sr.", "Grade", "Notice Period"],
        [["1", "Trainee", "15 Days"], ["2", "Probation", "30 Days"],
         ["3", "Up to Sr. Officer", "60 Days"], ["4", "Asst. Manager & Above", "90 Days"]],
        col_widths=[15 * mm, 70 * mm, 80 * mm],
    ))
    story.append(Spacer(1, 6))
    story.append(Paragraph(
        "I have read the above and have been informed by the HR officer that, in the event the notice "
        "period is not duly served, the HR Department may take appropriate action.", BODY))
    story.append(Spacer(1, 8))
    story.append(_hbox_table([
        ["Employee Name", full_name],
        ["Employee Code", "(To be assigned by HR)"],
        ["Date of Joining", _fmt_date(c.get("expected_joining_date"))],
        ["Employee Signature", ""],
    ]))


def _asset_declaration(story, c):
    story.append(PageBreak())
    story.append(Paragraph("ACKNOWLEDGEMENT & ASSETS DECLARATION BY EMPLOYEE", H1))
    full_name = f"{c.get('first_name', '')} {c.get('last_name', '')}".strip()
    story.append(Paragraph(
        f"I, <b>{full_name or 'Mr./Ms. _______________'}</b>, hereby acknowledge that I have received the assets "
        "listed below along with the conditions stated. I understand that I am being issued the asset(s) "
        "as a tool to facilitate my work and I am responsible for them.", BODY))
    story.append(Paragraph(
        "I will care for the equipment in such a manner as to prevent loss or damage. The asset(s) shall not be "
        "carried outside the office without prior approval. In the event of damages or abuse — or my failure to "
        "follow Company technology acceptable use policies — I shall be held responsible for repairs or replacement. "
        "All asset(s) shall be returned to IT immediately upon termination of my employment. No unauthorised or "
        "illegal software shall be installed on the laptop and no pornographic / communal content shall be stored.", BODY))
    story.append(Spacer(1, 8))

    story.append(Paragraph("Asset Handover", H2))
    story.append(_grid_table(
        ["Sr.", "Particular", "Asset Code", "Issue Date", "Return Date", "Remarks"],
        _empty_rows(["", "", "", "", "", ""], 6),
        col_widths=[10 * mm, 50 * mm, 30 * mm, 25 * mm, 25 * mm, 35 * mm],
    ))
    story.append(Spacer(1, 6))
    story.append(_hbox_table([
        ["Employee Name", full_name],
        ["Employee Signature", ""],
        ["Date", ""],
    ]))


def _nda(story, c, company):
    story.append(PageBreak())
    story.append(Paragraph("NON-DISCLOSURE AGREEMENT", H1))
    full_name = f"{c.get('first_name', '')} {c.get('last_name', '')}".strip()
    company_name = company.get("company_name") or "Radhya Micro Finance Private Limited"
    company_addr = company.get("address") or "MIG-29, Ram Ganga Vihar, Vistar, Moradabad — 244001"
    story.append(Paragraph(
        f"This Non-Disclosure Agreement (\"Agreement\") is made and entered into as of the date of joining, "
        f"by and between <b>{company_name}</b>, a Non-Banking Financial Company incorporated under the "
        f"Companies Act 2013 having its registered office at {company_addr} (the \"Company\"), AND "
        f"<b>{full_name or 'the undersigned employee'}</b>, "
        f"S/o or D/o or W/o <b>{c.get('father_or_husband_name', '_______________')}</b>, residing at "
        f"<b>{_addr_line(c) or '_______________'}</b> (the \"Employee\").", BODY))

    story.append(Paragraph("Purpose", H2))
    story.append(Paragraph(
        "The Employee acknowledges that during the course of employment they may have access to, or be exposed to, "
        "confidential and proprietary information. This Agreement is intended to prevent the unauthorised disclosure "
        "and use of such information.", BODY))

    story.append(Paragraph("Definition of Confidential Information", H2))
    items = [
        "Business plans and strategies",
        "Financial and operational data",
        "Client lists and information",
        "Technical data, software and systems",
        "Marketing and sales strategies",
        "Employee information",
        "Any non-public information related to the Company or its affiliates",
    ]
    for it in items:
        story.append(Paragraph(f"• {it}", BODY))
    story.append(Paragraph(
        "Confidential Information may be oral, written, digital or in any other form, whether marked confidential or not.", BODY))

    story.append(Paragraph("Obligations of the Employee", H2))
    obligations = [
        "(A) Hold the Confidential Information in strict confidence and exercise a reasonable degree of care to prevent disclosure to others.",
        "(B) Not reproduce the Confidential Information nor use it commercially or for any purpose other than the performance of duties.",
        "(C) Take all reasonable precautions to prevent any unauthorised use or disclosure.",
        "(D) Immediately notify Radhya of any unauthorised use or disclosure of Confidential Information.",
        "(E) In the event of any intentional, unintentional or mistaken leak or exposure, immediately inform the Company and cooperate fully to mitigate any damage.",
    ]
    for o in obligations:
        story.append(Paragraph(o, BODY))

    story.append(Paragraph("Return of Property", H2))
    story.append(Paragraph(
        "Upon termination of employment or upon request, the Employee shall return all materials, assets, "
        "documents and other property containing or relating to the Confidential Information.", BODY))

    story.append(Paragraph("Term", H2))
    story.append(Paragraph(
        "This Agreement shall remain in effect during the term of the Employee's employment and shall continue "
        "for a period of two (2) years after termination of employment, regardless of the reason.", BODY))

    story.append(Paragraph("Remedies", H2))
    story.append(Paragraph(
        "Any unauthorised disclosure or use of Confidential Information may cause irreparable harm to the Company. "
        "The Company shall be entitled to seek injunctive relief or specific performance and other appropriate relief, "
        "including monetary damages.", BODY))

    story.append(Paragraph("Governing Law and Jurisdiction", H2))
    story.append(Paragraph(
        "This Agreement shall be governed by the laws of India. Disputes shall be subject to the exclusive "
        "jurisdiction of the courts located in Moradabad, Uttar Pradesh.", BODY))

    story.append(Spacer(1, 12))
    story.append(_grid_table(
        [f"For {company_name}", "Employee"],
        [["Signature: _______________", "Signature: _______________"],
         ["Name: Shivani Pathak", f"Name: {full_name or '_______________'}"],
         ["Designation: Asst. HR Manager", f"Designation: {c.get('position') or '_______________'}"],
         ["Date: _______________", "Date: _______________"]],
        col_widths=[80 * mm, 80 * mm],
    ))


# ----- Public API -----------------------------------------------------------


def build_joining_kit_pdf(candidate: dict, company: dict | None = None,
                          has_aadhaar_doc: bool = False, has_pan_doc: bool = False) -> bytes:
    company = company or {}
    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=15 * mm, rightMargin=15 * mm,
        topMargin=12 * mm, bottomMargin=12 * mm,
        title=f"Joining Kit - {candidate.get('first_name', '')} {candidate.get('last_name', '')}".strip(),
        author=company.get("company_name", "Radhya Micro Finance"),
    )
    story = []
    _header(story, candidate, company)
    _documents_checklist(story, candidate, has_aadhaar_doc, has_pan_doc)
    _employee_info_sheet(story, candidate)
    _staff_undertaking(story, candidate)
    _insurance_form(story, candidate)
    _gratuity_form(story, candidate)
    _epf_form(story, candidate)
    _esi_form(story, candidate)
    _notice_period_declaration(story, candidate)
    _asset_declaration(story, candidate)
    _nda(story, candidate, company)
    doc.build(story)
    buffer.seek(0)
    return buffer.getvalue()
