"""
Generate a professional payslip PDF matching the Radhya Micro Finance payslip template.
Uses ReportLab (same stack as joining_kit_pdf.py).
"""
import calendar as _calendar
import os
from io import BytesIO
from typing import Optional

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable
)
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT

# ── Colours ──────────────────────────────────────────────────────────────────
NAVY   = colors.HexColor("#1E2A47")
ORANGE = colors.HexColor("#E85B1E")
LGRAY  = colors.HexColor("#F8F9FA")
MGRAY  = colors.HexColor("#E2E8F0")
DGRAY  = colors.HexColor("#64748B")
WHITE  = colors.white
BLACK  = colors.black

# ── Fonts ─────────────────────────────────────────────────────────────────────
_FONT_DIR = os.path.join(os.path.dirname(__file__), "fonts")
_DEVANAGARI = os.path.join(_FONT_DIR, "NotoSansDevanagari-Regular.ttf")
try:
    if os.path.exists(_DEVANAGARI):
        pdfmetrics.registerFont(TTFont("Hindi", _DEVANAGARI))
except Exception:
    pass

BODY_FONT = "Helvetica"
BOLD_FONT = "Helvetica-Bold"

# ── Helpers ───────────────────────────────────────────────────────────────────
_MONTH_NAMES = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"]

def _inr(val) -> str:
    """Format as Indian currency string without ₹ symbol (for table cells)."""
    try:
        v = float(val or 0)
        if v == 0:
            return "-"
        s = f"{v:,.2f}"
        # Convert to Indian format: last 3 before decimal, then groups of 2
        parts = s.split(".")
        intpart = parts[0].replace(",", "")
        paise = parts[1] if len(parts) > 1 else "00"
        if len(intpart) <= 3:
            return f"{intpart}.{paise}"
        result = intpart[-3:]
        intpart = intpart[:-3]
        while intpart:
            result = intpart[-2:] + "," + result
            intpart = intpart[:-2]
        return result.lstrip(",") + "." + paise
    except Exception:
        return str(val or "-")

def _fmt(val, default="-") -> str:
    return str(val or default).strip() or default


# ─────────────────────────────────────────────────────────────────────────────
def build_payslip_pdf(record: dict, employee: dict) -> bytes:
    """
    Generate a payslip PDF and return bytes.

    :param record:   payroll_records document (from MongoDB, _id removed)
    :param employee: employees document (from MongoDB, _id removed)
    """
    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=15*mm, rightMargin=15*mm,
        topMargin=12*mm, bottomMargin=12*mm,
        title="Payslip",
    )

    # ── Period labels ────────────────────────────────────────────────────────
    month_num  = int(record.get("month", 1))
    year_num   = int(record.get("year", 2026))
    month_name = _MONTH_NAMES[month_num - 1]
    days_in_month = _calendar.monthrange(year_num, month_num)[1]

    present_days  = int(record.get("present_days", days_in_month))
    working_days  = int(record.get("working_days", 26))
    leave_days    = int(record.get("leave_days", 0))
    lop_days      = max(0, working_days - present_days)
    payable_days  = present_days

    # ── Salary components from record ────────────────────────────────────────
    basic       = float(record.get("basic", 0))
    hra         = float(record.get("hra", 0))
    conveyance  = float(record.get("conveyance_allowance", 0))
    special     = float(record.get("special_allowance", 0))
    canteen     = float(record.get("canteen_allowance", 0))
    other_inc   = float(record.get("other_additions", 0))
    gross       = float(record.get("gross_payable", record.get("gross_salary", 0)))

    epf_emp     = float(record.get("epf_employee", 0))
    esi_emp     = float(record.get("esic_employee", 0))
    tds         = float(record.get("tds", 0))
    other_ded   = float(record.get("other_deductions", 0))
    total_ded   = epf_emp + esi_emp + tds + other_ded
    net_salary  = float(record.get("net_salary", gross - total_ded))

    # ── Employee fields ──────────────────────────────────────────────────────
    emp_name    = f"{employee.get('first_name','')} {employee.get('last_name','')}".strip()
    emp_code    = _fmt(employee.get("employee_id"))
    department  = _fmt(employee.get("department"))
    designation = _fmt(employee.get("designation"))
    joining_dt  = _fmt(employee.get("joining_date"))
    pan         = _fmt(employee.get("pan_number"))
    uan         = _fmt(employee.get("uan_number"))
    esi_no      = _fmt(employee.get("esi_number"))
    bank_acc    = _fmt(employee.get("bank_details", {}).get("account_number"))
    bank_name   = _fmt(employee.get("bank_details", {}).get("bank_name"))
    ifsc        = _fmt(employee.get("bank_details", {}).get("ifsc_code"))

    elements = []

    # ════════════════════════════════════════════════════════════════════════
    # HEADER: Company name + slip title
    # ════════════════════════════════════════════════════════════════════════
    header_data = [[
        Paragraph("<b>RADHYA MICRO FINANCE PRIVATE LIMITED</b>",
                  ParagraphStyle("hcmp", fontName=BOLD_FONT, fontSize=13, textColor=WHITE, alignment=TA_LEFT)),
        Paragraph(f"SALARY SLIP<br/><font size='9'>{month_name.upper()} {year_num}</font>",
                  ParagraphStyle("hslip", fontName=BOLD_FONT, fontSize=11, textColor=WHITE, alignment=TA_RIGHT)),
    ]]
    header_tbl = Table(header_data, colWidths=["60%", "40%"])
    header_tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), NAVY),
        ("VALIGN",     (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING",  (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING",   (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING",(0, 0), (-1, -1), 10),
    ]))
    elements.append(header_tbl)
    elements.append(Spacer(1, 3*mm))

    # ════════════════════════════════════════════════════════════════════════
    # EMPLOYEE INFO TABLE (two-column, label + value, label + value)
    # ════════════════════════════════════════════════════════════════════════
    lbl_style = ParagraphStyle("lbl", fontName=BOLD_FONT, fontSize=8, textColor=DGRAY)
    val_style = ParagraphStyle("val", fontName=BODY_FONT, fontSize=8.5, textColor=BLACK)
    title_style = ParagraphStyle("tbl_title", fontName=BOLD_FONT, fontSize=8, textColor=WHITE)

    def L(text): return Paragraph(text, lbl_style)
    def V(text): return Paragraph(_fmt(text), val_style)

    info_rows = [
        [L("Employee Name"),    V(emp_name),         L("Employee Code"),    V(emp_code)],
        [L("Department"),       V(department),        L("Designation"),      V(designation)],
        [L("Date of Joining"),  V(joining_dt),        L("PAN Number"),       V(pan)],
        [L("Bank Account No."), V(bank_acc),          L("Bank Name"),        V(bank_name)],
        [L("IFSC Code"),        V(ifsc),              L(""),                 V("")],
        [L("UAN Number"),       V(uan),               L("ESI Number"),       V(esi_no)],
        [L("Days in Month"),    V(str(days_in_month)),L("LOP Days"),         V(str(lop_days))],
        [L("Payable Days"),     V(str(payable_days)), L("Leave Days"),       V(str(leave_days))],
    ]

    info_tbl = Table(info_rows, colWidths=["20%", "30%", "20%", "30%"])
    info_tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), LGRAY),
        ("ROWBACKGROUNDS", (0, 0), (-1, -1), [WHITE, LGRAY]),
        ("GRID",       (0, 0), (-1, -1), 0.4, MGRAY),
        ("VALIGN",     (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING",  (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING",   (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING",(0, 0), (-1, -1), 4),
        ("LINEBELOW",  (0, -1), (-1, -1), 1.2, NAVY),
        ("LINEABOVE",  (0, 0),  (-1, 0),  1.2, NAVY),
    ]))
    elements.append(info_tbl)
    elements.append(Spacer(1, 4*mm))

    # ════════════════════════════════════════════════════════════════════════
    # EARNINGS / DEDUCTIONS side-by-side table
    # ════════════════════════════════════════════════════════════════════════
    num_style  = ParagraphStyle("num",  fontName=BODY_FONT, fontSize=8.5, alignment=TA_RIGHT, textColor=BLACK)
    num_bold   = ParagraphStyle("numb", fontName=BOLD_FONT, fontSize=9,   alignment=TA_RIGHT, textColor=BLACK)
    item_style = ParagraphStyle("item", fontName=BODY_FONT, fontSize=8.5, alignment=TA_LEFT,  textColor=BLACK)
    item_bold  = ParagraphStyle("itmb", fontName=BOLD_FONT, fontSize=9,   alignment=TA_LEFT,  textColor=BLACK)

    def N(text):  return Paragraph(_inr(text) if text != "-" else "-", num_style)
    def NB(text): return Paragraph(_inr(text) if text != "-" else "-", num_bold)
    def I(text):  return Paragraph(text, item_style)   # noqa: E743
    def IB(text): return Paragraph(text, item_bold)

    EARNINGS = [
        ("Basic Salary",         basic),
        ("HRA",                  hra),
        ("Conveyance Allowance", conveyance),
        ("Special Allowance",    special),
        ("Canteen Allowance",    canteen),
        ("Other Income",         other_inc),
    ]
    DEDUCTIONS = [
        ("EPF",             epf_emp),
        ("ESI",             esi_emp),
        ("TDS",             tds),
        ("Other Deductions", other_ded),
        ("", 0),
        ("", 0),
    ]
    # Pad so both lists are the same length
    max_len = max(len(EARNINGS), len(DEDUCTIONS))
    while len(EARNINGS) < max_len:
        EARNINGS.append(("", 0))
    while len(DEDUCTIONS) < max_len:
        DEDUCTIONS.append(("", 0))

    # Section header row
    ed_rows = [[
        Paragraph("EARNINGS", title_style), Paragraph("AMOUNT (₹)", title_style),
        Paragraph("DEDUCTIONS", title_style), Paragraph("AMOUNT (₹)", title_style),
    ]]
    for (el, ev), (dl, dv) in zip(EARNINGS, DEDUCTIONS):
        ed_rows.append([
            I(el) if el else "",
            N(ev) if el else "",
            I(dl) if dl else "",
            N(dv) if dl else "",
        ])
    # Gross / Total row
    ed_rows.append([
        IB("Gross Salary"), NB(gross),
        IB("Total Deductions"), NB(total_ded),
    ])

    n_cols = ["25%", "25%", "25%", "25%"]
    ed_tbl = Table(ed_rows, colWidths=n_cols)
    body_range = (0, 1, -1, len(ed_rows) - 2)  # noqa: F841
    total_row  = len(ed_rows) - 1
    ed_tbl.setStyle(TableStyle([
        # Header styling
        ("BACKGROUND",    (0, 0), (-1, 0), NAVY),
        ("TEXTCOLOR",     (0, 0), (-1, 0), WHITE),
        ("FONTNAME",      (0, 0), (-1, 0), BOLD_FONT),
        ("FONTSIZE",      (0, 0), (-1, 0), 8),
        ("ALIGN",         (0, 0), (-1, 0), "CENTER"),
        ("TOPPADDING",    (0, 0), (-1, 0), 5),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 5),
        # Body rows
        ("ROWBACKGROUNDS", (0, 1), (-1, total_row - 1), [WHITE, LGRAY]),
        ("GRID",           (0, 0), (-1, -1), 0.4, MGRAY),
        ("LINEAFTER",      (1, 0), (1, -1), 1.0, NAVY),   # vertical divider
        ("VALIGN",         (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING",    (0, 0), (-1, -1), 6),
        ("RIGHTPADDING",   (0, 0), (-1, -1), 6),
        ("TOPPADDING",     (0, 1), (-1, -1), 3),
        ("BOTTOMPADDING",  (0, 1), (-1, -1), 3),
        # Totals row
        ("BACKGROUND",     (0, total_row), (-1, total_row), colors.HexColor("#EFF6FF")),
        ("FONTNAME",       (0, total_row), (-1, total_row), BOLD_FONT),
        ("FONTSIZE",       (0, total_row), (-1, total_row), 9),
        ("LINEABOVE",      (0, total_row), (-1, total_row), 1.0, NAVY),
        ("LINEBELOW",      (0, total_row), (-1, total_row), 1.0, NAVY),
    ]))
    elements.append(ed_tbl)
    elements.append(Spacer(1, 4*mm))

    # ════════════════════════════════════════════════════════════════════════
    # NET TAKE HOME SALARY
    # ════════════════════════════════════════════════════════════════════════
    net_style = ParagraphStyle("netlbl", fontName=BOLD_FONT, fontSize=11, textColor=WHITE)
    net_amt   = ParagraphStyle("netamt", fontName=BOLD_FONT, fontSize=13, textColor=WHITE, alignment=TA_RIGHT)
    net_data  = [[
        Paragraph("NET TAKE HOME SALARY", net_style),
        Paragraph(f"₹ {_inr(net_salary)}", net_amt),
    ]]
    net_tbl = Table(net_data, colWidths=["60%", "40%"])
    net_tbl.setStyle(TableStyle([
        ("BACKGROUND",    (0, 0), (-1, -1), ORANGE),
        ("VALIGN",        (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING",   (0, 0), (-1, -1), 10),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 10),
        ("TOPPADDING",    (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
        ("ROUNDEDCORNERS", [4, 4, 4, 4]),
    ]))
    elements.append(net_tbl)
    elements.append(Spacer(1, 5*mm))

    # ════════════════════════════════════════════════════════════════════════
    # EMPLOYER CONTRIBUTIONS FOOTNOTE
    # ════════════════════════════════════════════════════════════════════════
    epf_er  = float(record.get("epf_employer", 0))
    esic_er = float(record.get("esic_employer", 0))
    grat    = float(record.get("gratuity_monthly", 0))
    ctc_m   = float(record.get("ctc_monthly", 0))
    footnote_style = ParagraphStyle("fn", fontName=BODY_FONT, fontSize=7.5, textColor=DGRAY, alignment=TA_LEFT)
    elements.append(Paragraph(
        f"Employer contributions — EPF: ₹{_inr(epf_er)}  |  ESIC: ₹{_inr(esic_er)}  |  "
        f"Gratuity Provision: ₹{_inr(grat)}  |  Monthly CTC: ₹{_inr(ctc_m)}",
        footnote_style
    ))
    elements.append(Spacer(1, 8*mm))

    # ════════════════════════════════════════════════════════════════════════
    # FOOTER: Authorized Signatory
    # ════════════════════════════════════════════════════════════════════════
    elements.append(HRFlowable(width="100%", thickness=0.6, color=MGRAY))
    elements.append(Spacer(1, 6*mm))
    footer_data = [[
        Paragraph(
            "<i>This is a system-generated payslip and does not require a physical signature.</i>",
            ParagraphStyle("disc", fontName=BODY_FONT, fontSize=7.5, textColor=DGRAY, alignment=TA_LEFT)
        ),
        Paragraph(
            "Authorized Signatory<br/><br/>"
            "<font size='7' color='#94A3B8'>Radhya Micro Finance Pvt. Ltd.</font>",
            ParagraphStyle("sig", fontName=BOLD_FONT, fontSize=8.5, textColor=NAVY, alignment=TA_RIGHT)
        ),
    ]]
    footer_tbl = Table(footer_data, colWidths=["55%", "45%"])
    footer_tbl.setStyle(TableStyle([
        ("VALIGN",        (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING",   (0, 0), (-1, -1), 0),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 0),
        ("TOPPADDING",    (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    elements.append(footer_tbl)

    doc.build(elements)
    return buf.getvalue()
