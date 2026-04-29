"""
Generate a professional payslip PDF matching the Radhya Micro Finance payslip template.
Uses ReportLab with FreeSans (supports ₹ symbol) and the company logo.
"""
import calendar as _calendar
import os
from io import BytesIO

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable, Image as RLImage
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

# ── Font paths ────────────────────────────────────────────────────────────────
_FREE_SANS        = "/usr/share/fonts/truetype/freefont/FreeSans.ttf"
_FREE_SANS_BOLD   = "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf"
_LOGO_PATH        = os.path.join(os.path.dirname(__file__), "logos", "radhya_logo_pdf.png")

# ── Register FreeSans (full Unicode including ₹ = U+20B9) ────────────────────
try:
    pdfmetrics.registerFont(TTFont("FreeSans",     _FREE_SANS))
    pdfmetrics.registerFont(TTFont("FreeSansBold", _FREE_SANS_BOLD))
    pdfmetrics.registerFontFamily("FreeSans", normal="FreeSans", bold="FreeSansBold")
    BODY_FONT = "FreeSans"
    BOLD_FONT = "FreeSansBold"
except Exception:
    BODY_FONT = "Helvetica"
    BOLD_FONT = "Helvetica-Bold"

# ── Helpers ───────────────────────────────────────────────────────────────────
_MONTH_NAMES = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"]


def _inr(val) -> str:
    """Format as Indian currency with ₹ symbol."""
    try:
        v = float(val or 0)
        if v == 0:
            return "–"
        # Indian grouping: last 3 digits, then groups of 2
        intpart = str(int(round(v)))
        if len(intpart) <= 3:
            formatted = intpart
        else:
            result = intpart[-3:]
            remainder = intpart[:-3]
            while remainder:
                result = remainder[-2:] + "," + result
                remainder = remainder[:-2]
            formatted = result.lstrip(",")
        return f"\u20b9{formatted}"   # ₹ symbol (U+20B9)
    except Exception:
        return str(val or "–")


def _fmt(val, default="–") -> str:
    return str(val or default).strip() or default


# ─────────────────────────────────────────────────────────────────────────────
def build_payslip_pdf(record: dict, employee: dict) -> bytes:
    """
    Generate a payslip PDF and return bytes.
    :param record:   payroll_records document (_id already removed)
    :param employee: employees document (_id already removed)
    """
    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=12*mm, rightMargin=12*mm,
        topMargin=10*mm, bottomMargin=10*mm,
        title="Payslip",
    )

    # ── Period labels ─────────────────────────────────────────────────────────
    month_num     = int(record.get("month", 1))
    year_num      = int(record.get("year", 2026))
    month_name    = _MONTH_NAMES[month_num - 1]
    days_in_month = _calendar.monthrange(year_num, month_num)[1]   # actual calendar days

    present_days  = int(record.get("present_days", days_in_month))
    working_days  = int(record.get("working_days", 26))
    leave_days    = int(record.get("leave_days", 0))
    lop_days      = max(0, working_days - present_days)
    payable_days  = present_days

    # ── Salary components ─────────────────────────────────────────────────────
    basic      = float(record.get("basic", 0))
    hra        = float(record.get("hra", 0))
    conveyance = float(record.get("conveyance_allowance", 0))
    special    = float(record.get("special_allowance", 0))
    canteen    = float(record.get("canteen_allowance", 0))
    other_inc  = float(record.get("other_additions", 0))
    gross      = float(record.get("gross_payable", record.get("gross_salary", 0)))

    epf_emp    = float(record.get("epf_employee", 0))
    esi_emp    = float(record.get("esic_employee", 0))
    tds        = float(record.get("tds", 0))
    other_ded  = float(record.get("other_deductions", 0))
    total_ded  = epf_emp + esi_emp + tds + other_ded
    net_salary = float(record.get("net_salary", gross - total_ded))

    # ── Employee info ─────────────────────────────────────────────────────────
    emp_name    = f"{employee.get('first_name','').strip()} {employee.get('last_name','').strip()}".strip()
    emp_code    = _fmt(employee.get("employee_id"))
    department  = _fmt(employee.get("department"))
    designation = _fmt(employee.get("designation"))
    joining_dt  = _fmt(employee.get("joining_date"))
    pan         = _fmt(employee.get("pan_number"))
    uan         = _fmt(employee.get("uan_number"))
    esi_no      = _fmt(employee.get("esi_number"))
    bank_acc    = _fmt((employee.get("bank_details") or {}).get("account_number"))
    bank_name   = _fmt((employee.get("bank_details") or {}).get("bank_name"))
    ifsc        = _fmt((employee.get("bank_details") or {}).get("ifsc_code"))

    elements = []

    # ══════════════════════════════════════════════════════════════════════════
    # HEADER: Logo left  |  SALARY SLIP + period right
    # ══════════════════════════════════════════════════════════════════════════
    logo_img = ""
    if os.path.exists(_LOGO_PATH):
        # Fit logo in ~55mm wide x ~15mm tall (aspect ~3.6:1)
        logo_img = RLImage(_LOGO_PATH, width=55*mm, height=15*mm, kind="proportional")

    slip_title = Paragraph(
        f"SALARY SLIP<br/><font size='9' color='#94A3B8'>{month_name.upper()} {year_num}</font>",
        ParagraphStyle("hslip", fontName=BOLD_FONT, fontSize=12, textColor=WHITE, alignment=TA_RIGHT)
    )

    header_data = [[logo_img or Paragraph("RADHYA MICRO FINANCE", ParagraphStyle("hfall", fontName=BOLD_FONT, fontSize=11, textColor=WHITE)), slip_title]]
    header_tbl = Table(header_data, colWidths=["60%", "40%"])
    header_tbl.setStyle(TableStyle([
        ("BACKGROUND",    (0, 0), (-1, -1), NAVY),
        ("VALIGN",        (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING",   (0, 0), (-1, -1), 8),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 8),
        ("TOPPADDING",    (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    elements.append(header_tbl)
    elements.append(Spacer(1, 3*mm))

    # ══════════════════════════════════════════════════════════════════════════
    # EMPLOYEE INFO TABLE  (label | value | label | value)
    # ══════════════════════════════════════════════════════════════════════════
    lbl_s = ParagraphStyle("lbl", fontName=BOLD_FONT, fontSize=8,   textColor=DGRAY)
    val_s = ParagraphStyle("val", fontName=BODY_FONT, fontSize=8.5, textColor=BLACK)

    def L(t): return Paragraph(t, lbl_s)
    def V(t): return Paragraph(_fmt(t), val_s)

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
        ("ROWBACKGROUNDS", (0, 0), (-1, -1), [WHITE, LGRAY]),
        ("GRID",           (0, 0), (-1, -1), 0.4, MGRAY),
        ("VALIGN",         (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING",    (0, 0), (-1, -1), 6),
        ("RIGHTPADDING",   (0, 0), (-1, -1), 6),
        ("TOPPADDING",     (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING",  (0, 0), (-1, -1), 4),
        ("LINEBELOW",      (0, -1), (-1, -1), 1.2, NAVY),
        ("LINEABOVE",      (0,  0), (-1,  0), 1.2, NAVY),
    ]))
    elements.append(info_tbl)
    elements.append(Spacer(1, 4*mm))

    # ══════════════════════════════════════════════════════════════════════════
    # EARNINGS / DEDUCTIONS side-by-side table
    # ══════════════════════════════════════════════════════════════════════════
    num_s   = ParagraphStyle("num",  fontName=BODY_FONT, fontSize=8.5, alignment=TA_RIGHT, textColor=BLACK)
    numb_s  = ParagraphStyle("numb", fontName=BOLD_FONT, fontSize=9,   alignment=TA_RIGHT, textColor=BLACK)
    itm_s   = ParagraphStyle("itm",  fontName=BODY_FONT, fontSize=8.5, alignment=TA_LEFT,  textColor=BLACK)
    itmb_s  = ParagraphStyle("itmb", fontName=BOLD_FONT, fontSize=9,   alignment=TA_LEFT,  textColor=BLACK)
    hdr_s   = ParagraphStyle("hdr",  fontName=BOLD_FONT, fontSize=8,   textColor=WHITE, alignment=TA_CENTER)

    def N(v):  return Paragraph(_inr(v), num_s)
    def NB(v): return Paragraph(_inr(v), numb_s)
    def IT(t): return Paragraph(t, itm_s)
    def IB(t): return Paragraph(t, itmb_s)

    EARNINGS = [
        ("Basic Salary",         basic),
        ("HRA",                  hra),
        ("Conveyance Allowance", conveyance),
        ("Special Allowance",    special),
        ("Canteen Allowance",    canteen),
        ("Other Income",         other_inc),
    ]
    DEDUCTIONS = [
        ("EPF",              epf_emp),
        ("ESI",              esi_emp),
        ("TDS",              tds),
        ("Other Deductions", other_ded),
    ]

    max_len = max(len(EARNINGS), len(DEDUCTIONS))
    while len(EARNINGS)   < max_len: EARNINGS.append(("", 0))
    while len(DEDUCTIONS) < max_len: DEDUCTIONS.append(("", 0))

    ed_rows = [[
        Paragraph("EARNINGS",      hdr_s),
        Paragraph("AMOUNT",        hdr_s),
        Paragraph("DEDUCTIONS",    hdr_s),
        Paragraph("AMOUNT",        hdr_s),
    ]]
    for (el, ev), (dl, dv) in zip(EARNINGS, DEDUCTIONS):
        ed_rows.append([
            IT(el) if el else "",
            N(ev)  if el else "",
            IT(dl) if dl else "",
            N(dv)  if dl else "",
        ])
    total_row = len(ed_rows)
    ed_rows.append([IB("Gross Salary"), NB(gross), IB("Total Deductions"), NB(total_ded)])

    ed_tbl = Table(ed_rows, colWidths=["25%", "25%", "25%", "25%"])
    ed_tbl.setStyle(TableStyle([
        ("BACKGROUND",    (0, 0), (-1, 0), NAVY),
        ("TEXTCOLOR",     (0, 0), (-1, 0), WHITE),
        ("TOPPADDING",    (0, 0), (-1, 0), 5),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 5),
        ("ROWBACKGROUNDS", (0, 1), (-1, total_row - 1), [WHITE, LGRAY]),
        ("GRID",           (0, 0), (-1, -1), 0.4, MGRAY),
        ("LINEAFTER",      (1, 0), (1, -1), 1.0, NAVY),
        ("VALIGN",         (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING",    (0, 1), (-1, -1), 6),
        ("RIGHTPADDING",   (0, 1), (-1, -1), 6),
        ("TOPPADDING",     (0, 1), (-1, -1), 3),
        ("BOTTOMPADDING",  (0, 1), (-1, -1), 3),
        ("BACKGROUND",     (0, total_row), (-1, total_row), colors.HexColor("#EFF6FF")),
        ("FONTNAME",       (0, total_row), (-1, total_row), BOLD_FONT),
        ("LINEABOVE",      (0, total_row), (-1, total_row), 1.0, NAVY),
        ("LINEBELOW",      (0, total_row), (-1, total_row), 1.0, NAVY),
    ]))
    elements.append(ed_tbl)
    elements.append(Spacer(1, 4*mm))

    # ══════════════════════════════════════════════════════════════════════════
    # NET TAKE HOME SALARY
    # ══════════════════════════════════════════════════════════════════════════
    net_data = [[
        Paragraph("NET TAKE HOME SALARY",
                  ParagraphStyle("netlbl", fontName=BOLD_FONT, fontSize=11, textColor=WHITE)),
        Paragraph(_inr(net_salary),
                  ParagraphStyle("netamt", fontName=BOLD_FONT, fontSize=14, textColor=WHITE, alignment=TA_RIGHT)),
    ]]
    net_tbl = Table(net_data, colWidths=["60%", "40%"])
    net_tbl.setStyle(TableStyle([
        ("BACKGROUND",    (0, 0), (-1, -1), ORANGE),
        ("VALIGN",        (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING",   (0, 0), (-1, -1), 10),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 10),
        ("TOPPADDING",    (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
    ]))
    elements.append(net_tbl)
    elements.append(Spacer(1, 5*mm))

    # ══════════════════════════════════════════════════════════════════════════
    # EMPLOYER CONTRIBUTIONS FOOTNOTE
    # ══════════════════════════════════════════════════════════════════════════
    epf_er  = float(record.get("epf_employer", 0))
    esic_er = float(record.get("esic_employer", 0))
    grat    = float(record.get("gratuity_monthly", 0))
    ctc_m   = float(record.get("ctc_monthly", 0))
    fn_style = ParagraphStyle("fn", fontName=BODY_FONT, fontSize=7.5, textColor=DGRAY)
    elements.append(Paragraph(
        f"Employer contributions — EPF: {_inr(epf_er)}  |  ESIC: {_inr(esic_er)}  |  "
        f"Gratuity Provision: {_inr(grat)}  |  Monthly CTC: {_inr(ctc_m)}",
        fn_style
    ))
    elements.append(Spacer(1, 8*mm))

    # ══════════════════════════════════════════════════════════════════════════
    # FOOTER
    # ══════════════════════════════════════════════════════════════════════════
    elements.append(HRFlowable(width="100%", thickness=0.6, color=MGRAY))
    elements.append(Spacer(1, 6*mm))
    footer_data = [[
        Paragraph(
            "<i>This is a system-generated payslip and does not require a physical signature.</i>",
            ParagraphStyle("disc", fontName=BODY_FONT, fontSize=7.5, textColor=DGRAY)
        ),
        Paragraph(
            "Authorized Signatory<br/><br/>"
            "<font size='7' color='#94A3B8'>Radhya Micro Finance Pvt. Ltd.</font>",
            ParagraphStyle("sig", fontName=BOLD_FONT, fontSize=8.5, textColor=NAVY, alignment=TA_RIGHT)
        ),
    ]]
    footer_tbl = Table(footer_data, colWidths=["55%", "45%"])
    footer_tbl.setStyle(TableStyle([
        ("VALIGN",   (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING",  (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING",   (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING",(0, 0), (-1, -1), 0),
    ]))
    elements.append(footer_tbl)

    doc.build(elements)
    return buf.getvalue()
