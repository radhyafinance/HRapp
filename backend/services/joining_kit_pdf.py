"""Generate a pre-filled joining kit PDF for a selected candidate.
Mirrors the structure of `Joining Kit Online.docx` 1:1 including bilingual (English + Hindi) labels.
"""
from io import BytesIO
from datetime import datetime
from typing import Optional
import os

from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, Image as RLImage
)
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont


# ----- Devanagari font registration (one-shot at import) --------------------
_FONT_DIR = os.path.join(os.path.dirname(__file__), "fonts")
# Nirmala UI (original doc font) is proprietary; NotoSans Devanagari Medium is
# the closest open-source match for body text, SemiBold for bold/heading text.
_HINDI_MED_PATH  = os.path.join(_FONT_DIR, "NotoSansDevanagari-Medium.ttf")
_HINDI_SEMI_PATH = os.path.join(_FONT_DIR, "NotoSansDevanagari-SemiBold.ttf")
_HINDI_FONT = "Helvetica"
try:
    if os.path.exists(_HINDI_MED_PATH):
        pdfmetrics.registerFont(TTFont("Hindi", _HINDI_MED_PATH))
        _HINDI_FONT = "Hindi"
        # Register SemiBold as the bold variant so H1/H2 headings (which inherit
        # bold from Heading1/Heading2) render all Devanagari glyphs consistently.
        if os.path.exists(_HINDI_SEMI_PATH):
            pdfmetrics.registerFont(TTFont("HindiB", _HINDI_SEMI_PATH))
        else:
            pdfmetrics.registerFont(TTFont("HindiB", _HINDI_MED_PATH))  # fallback
        pdfmetrics.registerFontFamily(
            "Hindi",
            normal="Hindi",
            bold="HindiB",
            italic="Hindi",
            boldItalic="HindiB",
        )
    else:
        # Fallback chain: Sans Regular → Helvetica
        _SANS_PATH = os.path.join(_FONT_DIR, "NotoSansDevanagari-Regular.ttf")
        if os.path.exists(_SANS_PATH):
            pdfmetrics.registerFont(TTFont("Hindi", _SANS_PATH))
            pdfmetrics.registerFontFamily("Hindi", normal="Hindi", bold="Hindi", italic="Hindi", boldItalic="Hindi")
            _HINDI_FONT = "Hindi"
except Exception:
    pass


# --- Devanagari rendering via HarfBuzz shaping --------------------------------
# ReportLab cannot shape Devanagari — conjunct ligatures (त्र, क्ष, श्र…) don't
# form and the short-i matra misplaces. So each Hindi word is shaped with
# HarfBuzz and embedded as an inline, baseline-aligned image. Word-by-word images
# let ReportLab wrap normally at spaces. Falls back to plain text if the shaping
# libraries are missing (the PDF still builds).
import re as _re
import hashlib as _hashlib
import tempfile as _tempfile

try:
    import uharfbuzz as _hb
    import freetype as _ft
    from PIL import Image as _PILImage, ImageDraw as _PILImageDraw
    _HB_OK = True
except Exception:
    _HB_OK = False

_TICK_CACHE = {}


def _tick_img(pt: float = 8.5) -> str:
    """A drawn check-mark as an inline image (no reliably-available font has a
    tick glyph). Returns an <img> tag for use inside a table-cell Paragraph;
    falls back to 'X' if imaging is unavailable."""
    if not _HB_OK:
        return "X"
    key = round(pt, 1)
    if key not in _TICK_CACHE:
        try:
            os_ = _HB_OVERSAMPLE
            sz = int(pt * os_ * 1.1)
            img = _PILImage.new("RGBA", (sz, sz), (255, 255, 255, 0))
            d = _PILImageDraw.Draw(img)
            lw = max(2, int(sz * 0.12))
            d.line([(sz * 0.16, sz * 0.52), (sz * 0.42, sz * 0.78)], fill=(0, 0, 0, 255), width=lw)
            d.line([(sz * 0.42, sz * 0.78), (sz * 0.86, sz * 0.22)], fill=(0, 0, 0, 255), width=lw)
            path = os.path.join(_HB_DIR, f"tick_{key}.png")
            img.save(path)
            _TICK_CACHE[key] = (path, sz / os_, sz / os_, -1.0)
        except Exception:
            return "X"
    path, w, h, va = _TICK_CACHE[key]
    return f'<img src="{path}" width="{w:.2f}" height="{h:.2f}" valign="{va:.2f}"/>'

_HB_DIR = _tempfile.mkdtemp(prefix="jk_hindi_")
_HB_FONTS = {}      # font_path -> (hb.Face, hb.Font, freetype.Face)
_HB_CACHE = {}      # (text, pt, bold) -> (img_path, w_pt, h_pt, valign_pt)
_HB_OVERSAMPLE = 4  # rasterise at 4x point size for crisp print output


def _has_devanagari(s: str) -> bool:
    return any(0x0900 <= ord(c) <= 0x097F for c in (s or ""))


def _hb_font(path):
    if path not in _HB_FONTS:
        blob = _hb.Blob.from_file_path(path)
        face = _hb.Face(blob)
        _HB_FONTS[path] = (face, _hb.Font(face), _ft.Face(path))
    return _HB_FONTS[path]


_CONTENT_W_PT = 182 * mm   # A4 content width (210 − 14 − 14 mm margins)


def _hb_shape_img(text: str, pt: float, bold: bool = False):
    """Shape `text` with HarfBuzz and return (PIL RGBA image, baseline_from_top_px,
    width_px, height_px). Returns (None, 0, 0, 0) if there is nothing to draw."""
    fpath = _HINDI_SEMI_PATH if (bold and os.path.exists(_HINDI_SEMI_PATH)) else _HINDI_MED_PATH
    face, font, ftf = _hb_font(fpath)
    px = pt * _HB_OVERSAMPLE
    scale = px / face.upem
    ftf.set_char_size(int(round(px * 64)))
    buf = _hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    _hb.shape(font, buf)
    penx = 0.0
    glyphs = []
    min_x = min_y = max_x = max_y = 0.0
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        ftf.load_glyph(info.codepoint, _ft.FT_LOAD_RENDER)
        g = ftf.glyph
        bmp = g.bitmap
        gx = penx + pos.x_offset * scale + g.bitmap_left
        gy = -(pos.y_offset * scale) - g.bitmap_top
        if bmp.width and bmp.rows:
            glyphs.append((bytes(bmp.buffer), bmp.width, bmp.rows, gx, gy))
            min_x = min(min_x, gx); max_x = max(max_x, gx + bmp.width)
            min_y = min(min_y, gy); max_y = max(max_y, gy + bmp.rows)
        penx += pos.x_advance * scale
    if not glyphs:
        return (None, 0.0, 0.0, 0.0)
    pad = int(px * 0.06)
    W = int(max_x - min_x) + pad * 2
    H = int(max_y - min_y) + pad * 2
    ox, oy = pad - min_x, pad - min_y
    img = _PILImage.new("RGBA", (W, H), (255, 255, 255, 0))
    for buf_bytes, gw, gh, gx, gy in glyphs:
        alpha = _PILImage.frombytes("L", (gw, gh), buf_bytes)
        img.paste(_PILImage.new("RGBA", (gw, gh), (0, 0, 0, 255)),
                  (int(gx + ox), int(gy + oy)), alpha)
    return (img, oy, W, H)


def _hb_raster(text: str, pt: float, bold: bool = False):
    """One shaped run → (img_path, width_pt, height_pt, valign_pt), cached.
    valign aligns the text baseline with the surrounding line."""
    key = (text, round(pt, 2), bold)
    if key in _HB_CACHE:
        return _HB_CACHE[key]
    try:
        img, base_px, W, H = _hb_shape_img(text, pt, bold)
        if img is None:
            res = ("", 0.0, 0.0, 0.0)
        else:
            fname = os.path.join(_HB_DIR, _hashlib.md5(f"{text}|{pt}|{bold}".encode()).hexdigest() + ".png")
            img.save(fname)
            w_pt, h_pt = W / _HB_OVERSAMPLE, H / _HB_OVERSAMPLE
            res = (fname, w_pt, h_pt, -(h_pt - base_px / _HB_OVERSAMPLE))
    except Exception:
        res = ("", 0.0, 0.0, 0.0)
    _HB_CACHE[key] = res
    return res


def _hpara(text: str, style=None, pt: float = 9.0, width_pt: float = None,
           align: str = "left", bold: bool = False, leading_mult: float = 1.55):
    """A pure-Devanagari PARAGRAPH rendered as a HarfBuzz-shaped, word-wrapped
    image flowable. ReportLab can't wrap inline images, so we break lines
    ourselves to fit `width_pt`. Falls back to a plain Paragraph on any problem."""
    if not _HB_OK or not _has_devanagari(text):
        return _para(text, style if style is not None else BODY)
    try:
        os_ = _HB_OVERSAMPLE
        if width_pt is None:
            width_pt = _CONTENT_W_PT
        max_w = width_pt * os_
        space_px = pt * 0.30 * os_
        words = text.split()
        meta = {w: _hb_shape_img(w, pt, bold) for w in set(words)}
        # greedy line wrap by shaped word width
        lines, cur, cur_w = [], [], 0.0
        for w in words:
            ww = meta[w][2]
            add = ww + (space_px if cur else 0)
            if cur and cur_w + add > max_w:
                lines.append(cur); cur, cur_w = [w], ww
            else:
                cur.append(w); cur_w += add
        if cur:
            lines.append(cur)
        asc = max((meta[w][1] for w in words), default=pt * os_)
        desc = max(((meta[w][3] - meta[w][1]) for w in words), default=0)
        lead_px = pt * leading_mult * os_
        total_h = int(lead_px * len(lines) + desc + 2)
        total_w = int(max_w)
        canvas = _PILImage.new("RGBA", (total_w, total_h), (255, 255, 255, 0))
        for i, ln in enumerate(lines):
            line_w = sum(meta[w][2] for w in ln) + space_px * (len(ln) - 1)
            x0 = 0 if align == "left" else (total_w - line_w) / 2
            base_y = asc + lead_px * i
            x = x0
            for w in ln:
                im, bpx, W, H = meta[w]
                if im is not None:
                    canvas.paste(im, (int(x), int(base_y - bpx)), im)
                x += W + space_px
        fname = os.path.join(_HB_DIR, _hashlib.md5(f"P|{text}|{pt}|{width_pt}|{align}|{bold}".encode()).hexdigest() + ".png")
        canvas.save(fname)
        img = RLImage(fname, width=canvas.width / os_, height=canvas.height / os_)
        img.hAlign = "LEFT" if align == "left" else "CENTER"
        img.spaceBefore = 3
        img.spaceAfter = 3
        return img
    except Exception:
        return _para(text, style if style is not None else BODY)


def _hi(text: str, pt: float = 9.0, bold: bool = False) -> str:
    """Render Devanagari as inline HarfBuzz-shaped word images (correct conjuncts
    and matras); English/punctuation pass through as text. Falls back to plain
    text if shaping is unavailable."""
    if not _HB_OK or not _has_devanagari(text):
        return text
    out = []
    for tok in _re.split(r"(\s+)", text):
        if tok and _has_devanagari(tok):
            path, w, h, va = _hb_raster(tok, pt, bold)
            out.append(
                f'<img src="{path}" width="{w:.2f}" height="{h:.2f}" valign="{va:.2f}"/>'
                if path else tok
            )
        else:
            out.append(tok)
    return "".join(out)


# ----- Styles ---------------------------------------------------------------

_styles = getSampleStyleSheet()

H1 = ParagraphStyle("H1", parent=_styles["Heading1"], fontSize=13, leading=16,
                    textColor=colors.black, alignment=TA_CENTER, spaceBefore=4, spaceAfter=4)
H2 = ParagraphStyle("H2", parent=_styles["Heading2"], fontSize=11, leading=14,
                    textColor=colors.black, spaceBefore=6, spaceAfter=4)
TITLE = ParagraphStyle("TITLE", parent=_styles["Heading1"], fontSize=14, leading=18,
                       alignment=TA_CENTER, textColor=colors.black,
                       spaceBefore=2, spaceAfter=2)
SUBTITLE = ParagraphStyle("SUBTITLE", parent=_styles["Normal"], fontSize=9, leading=11,
                          alignment=TA_CENTER, textColor=colors.black, spaceAfter=4)
BODY = ParagraphStyle("BODY", parent=_styles["BodyText"], fontSize=9, leading=11,
                      spaceBefore=0, spaceAfter=2, alignment=TA_JUSTIFY)
BODYL = ParagraphStyle("BODYL", parent=_styles["BodyText"], fontSize=9, leading=11,
                       spaceBefore=0, spaceAfter=2, alignment=TA_LEFT)
SMALL = ParagraphStyle("SMALL", parent=_styles["BodyText"], fontSize=8, leading=10,
                       textColor=colors.black)
NOTE = ParagraphStyle("NOTE", parent=_styles["Italic"], fontSize=8, leading=10,
                      textColor=colors.HexColor("#6B7280"))
CENTER_BOLD = ParagraphStyle("CB", parent=_styles["Normal"], fontSize=10, leading=12,
                             alignment=TA_CENTER, fontName="Helvetica-Bold")

# Dedicated Hindi heading styles: fontName set directly → no Helvetica-Bold inheritance
# so ALL Devanagari glyphs render with a consistent weight (SemiBold for headings).
HINDI_H1    = ParagraphStyle("HH1", fontName="HindiB", fontSize=13, leading=18,
                              textColor=colors.black, alignment=TA_CENTER, spaceBefore=4, spaceAfter=4)
HINDI_H2    = ParagraphStyle("HH2", fontName="HindiB", fontSize=11, leading=16,
                              textColor=colors.black, spaceBefore=6, spaceAfter=4)
HINDI_SUB   = ParagraphStyle("HSUB", fontName="Hindi", fontSize=9, leading=12,
                              alignment=TA_CENTER, textColor=colors.black, spaceAfter=4)


_BORDER = colors.black


def _hindi_heading_image(text: str, font_size: int = 14, width_mm: float = 170.0) -> RLImage:
    """Render a Hindi heading as a crisp HarfBuzz-shaped image, centred on the
    page (proper conjunct/matra shaping that ReportLab can't do)."""
    if _HB_OK:
        path, w_pt, h_pt, _va = _hb_raster(text, float(font_size), bold=True)
        if path:
            rl_img = RLImage(path, width=w_pt, height=h_pt)
            rl_img.hAlign = "CENTER"
            return rl_img
    # Fallback: plain paragraph (may not shape, but the PDF still builds)
    return Paragraph(f'<font name="HindiB">{text}</font>',
                     ParagraphStyle("_hfb", fontName="HindiB", fontSize=font_size,
                                    leading=font_size + 4, alignment=TA_CENTER,
                                    textColor=colors.black))


# Vertical padding added to rows a person fills in by hand. 2.5pt of default
# padding leaves a ~4mm line; this takes it to roughly 9mm, which is writable
# with a ballpoint without the sheet running to a third page.
_HAND_PAD = 11
# Signature blocks need a taller box than a written line -- people sign large.
_SIGN_PAD = 16
# Items 21-24 get a page to themselves, so their tables can be roomier still.
_HAND_PAD_LG = 16


def _kv_table(rows, label_w=60 * mm, value_w=110 * mm):
    """Numbered key/value table matching docx style: thin black border, no zebra."""
    t = Table(rows, colWidths=[label_w, value_w])
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("BOX", (0, 0), (-1, -1), 0.6, _BORDER),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, _BORDER),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 2.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
    ]))
    return t


def _grid_table(headers, rows, col_widths=None, repeat_header=True, header_bold=True,
                font_size=8.5, body_pad=None):
    """Bordered grid.

    `body_pad` adds vertical padding to the BODY rows only, to leave room for
    handwriting. Padding rather than a fixed row height on purpose: a fixed height
    would clip a pre-filled value that wraps to two lines (addresses do), whereas
    padding sets a floor and still lets the row grow.
    """
    # Wrap header cells in centered Paragraphs so long headers wrap INSIDE the
    # cell instead of overflowing (plain strings don't wrap in ReportLab tables).
    _hdr_style = ParagraphStyle(
        "_gridhdr",
        fontName="Helvetica-Bold" if header_bold else "Helvetica",
        fontSize=font_size, leading=font_size + 1.5,
        alignment=TA_CENTER, textColor=colors.black,
    )
    wrapped_headers = [
        h if hasattr(h, "wrap") else Paragraph(str(h), _hdr_style)
        for h in headers
    ]
    # Wrap non-empty body cells too, so long values (e.g. a degree list) wrap
    # inside the cell instead of spilling into the next column.
    _body_style = ParagraphStyle(
        "_gridbody", fontName="Helvetica", fontSize=font_size,
        leading=font_size + 1.5, textColor=colors.black,
    )
    wrapped_rows = [
        [
            c if hasattr(c, "wrap")
            else (Paragraph(str(c), _body_style) if str(c).strip() else "")
            for c in row
        ]
        for row in rows
    ]
    data = [wrapped_headers] + wrapped_rows
    t = Table(data, colWidths=col_widths, repeatRows=1 if repeat_header else 0)
    style = [
        ("FONTSIZE", (0, 0), (-1, -1), font_size),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (0, 0), (-1, 0), "CENTER"),
        ("BOX", (0, 0), (-1, -1), 0.6, _BORDER),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, _BORDER),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 2.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
    ]
    if body_pad:
        style += [("TOPPADDING", (0, 1), (-1, -1), body_pad),
                  ("BOTTOMPADDING", (0, 1), (-1, -1), body_pad)]
    t.setStyle(TableStyle(style))
    return t


def _blank_rows(num_cols, count):
    return [[""] * num_cols for _ in range(count)]


def _checkbox(checked: bool) -> str:
    return f"[ {_tick_img()} ]" if checked else "[   ]"


def _fmt_date(value):
    if not value:
        return ""
    try:
        if "-" in str(value) and len(str(value)) >= 10:
            d = datetime.strptime(str(value)[:10], "%Y-%m-%d")
            return d.strftime("%d/%m/%Y")
        if "/" in str(value):
            return str(value)
    except Exception:
        pass
    return str(value)


def _addr_line(c):
    parts = [c.get("address"), c.get("city"), c.get("state"), c.get("pincode")]
    return ", ".join([p for p in parts if p])


def _full_name(c):
    return f"{c.get('first_name', '')} {c.get('last_name', '')}".strip()


def _para(text, style=BODY):
    return Paragraph(text, style)


# ----- Section builders -----------------------------------------------------


def _section_1(story, c, company):
    """Page 1 of docx: header + 7 numbered fields + documents checklist."""
    story.append(_para("Joining Kit - Version - 1.1", TITLE))
    story.append(_para("For official use only", SUBTITLE))
    story.append(_para("(TO BE FILLED IN CAPITAL LETTERS)", NOTE))
    story.append(Spacer(1, 4))

    # 7-field block — docx uses single-column numbered rows
    name = _full_name(c).upper()
    rows = [
        [_para("<b>1. Employee Name</b>", BODYL), _para(name, BODYL)],
        [_para("<b>2. Employee Code</b>", BODYL), _para(c.get("employee_id") or "", BODYL)],
        [_para("<b>3. Mobile No</b>", BODYL), _para(c.get("mobile", ""), BODYL)],
        [_para("<b>4. Date of Joining</b>", BODYL), _para(_fmt_date(c.get("expected_joining_date")), BODYL)],
        [_para("<b>5. Designation</b>", BODYL), _para(c.get("position", ""), BODYL)],
        [_para("<b>6. Department</b>", BODYL), _para(c.get("department", ""), BODYL)],
        [_para("<b>7. Joining Location</b>", BODYL), _para(c.get("joining_location") or company.get("address") or "Head Office, Moradabad", BODYL)],
    ]
    story.append(_kv_table(rows))
    story.append(Spacer(1, 8))

    # Documents Checklist
    story.append(_para("DOCUMENTS CHECKLIST FOR NEW JOINERS", H2))
    has_aadhaar = bool(c.get("aadhaar_number") or c.get("_has_aadhaar_doc"))
    has_pan = bool(c.get("pan_number") or c.get("_has_pan_doc"))
    items = [
        ("1", "Joining Kit — 1(a) Offer Letter", False, ""),
        ("", "1(B) Appointment Letter", False, ""),
        ("", "1(c) Employee Information Sheet", True, "Pre-filled below"),
        ("", "1(D) Staff Undertaking", True, "Included below"),
        ("", "1(E) Employee Medical Form", False, ""),
        ("", "1(F) Gratuity Form", True, "Included below"),
        ("", "1(G) PF Form", True, "Included below"),
        ("", "1(H) ESIC Form", True, "Included below"),
        ("2", "One cancelled cheque / Passbook copy (Any Bank) — Compulsory", False, ""),
        ("3", "Passport size photographs (2 copies)", False, ""),
        ("4", "ID Proof — Aadhaar Card Copy (Compulsory)", has_aadhaar, "Already provided" if has_aadhaar else ""),
        ("5", "Address Proof — 5(A) Aadhaar Card Copy", has_aadhaar, "Aadhaar on file" if has_aadhaar else ""),
        ("", "5(B) Voter ID Card", False, ""),
        ("", "5(c) Driving License", False, ""),
        ("6", "Educational Certificates — 6(A) 10th Std.", False, ""),
        ("", "6(B) 12th Std.", False, ""),
        ("", "6(c) Graduation", False, ""),
        ("", "6(D) Post-Graduation", False, ""),
        ("", "6(E) Ph.D (if applicable)", False, ""),
        ("", "6(F) Any Other Qualification", False, ""),
        ("7", "Bike RC Number", False, ""),
        ("8", "Bike PUC / Insurance", False, ""),
        ("9", "Online Police Verification Report", False, ""),
        # PF Proof and ESIC Proof dropped; the Consent Form line went with the
        # consent page itself, so nothing here points at a page that is gone.
        ("10", "PAN Card Copy", has_pan, "Already provided" if has_pan else ""),
        ("11", "POSH Declaration &amp; BGV Consent Form", True, "Included below"),
    ]
    rows = [[sr, p, _checkbox(checked), remark] for sr, p, checked, remark in items]
    story.append(_grid_table(
        ["Sr No", "Particular", "Checked By HR Team", "Remark"],
        rows,
        col_widths=[12 * mm, 95 * mm, 28 * mm, 35 * mm],
    ))
    story.append(Spacer(1, 6))
    story.append(_para("<b>Check &amp; Verified — Team HR</b>", BODYL))


def _section_2_employee_info(story, c):
    story.append(PageBreak())
    story.append(_para("EMPLOYEE INFORMATION SHEET", H1))
    story.append(_para("Attached / Paste Passport Size Photograph", NOTE))

    name = _full_name(c)
    rows = [
        ["1", "Employee Name", name],
        ["2", "Father's / Spouse Name", c.get("father_or_husband_name", "")],
        ["3", "Mother's Name", ""],
        ["4", "Aadhaar Card No.", c.get("aadhaar_number", "")],
        ["5", "Voter ID No.", ""],
        ["6", "PAN Card No.", c.get("pan_number", "")],
        ["7", "Driving License No.", ""],
        ["8", "Date of Birth", c.get("dob", "")],
        ["9", "Mobile No.", c.get("mobile", "")],
        ["10", "Emergency Mobile No.", ""],
        ["11", "Relationship with Emergency Contact", ""],
        ["12", "Parents Mobile No. (Father / Mother)", ""],
        ["13", "E-mail ID", c.get("email", "")],
        ["14", "Marital Status", ""],
        ["15", "Nationality", "Indian"],
        ["16", "Religion", ""],
        ["17", "Category (Gen / OBC / SC / ST)", ""],
        ["18", "Blood Group", ""],
        ["19", "Permanent Address (As per Aadhaar)", _addr_line(c)],
        ["20", "Correspondence Address", _addr_line(c)],
    ]
    story.append(_grid_table(
        ["Sr.", "Particular", "Details"],
        rows,
        col_widths=[10 * mm, 60 * mm, 100 * mm],
        font_size=9,
        body_pad=_HAND_PAD,
    ))

    # 21 onwards starts a fresh page. Items 1-20 now have writing room, which
    # fills page one on its own; the tables below need a full page between them.
    story.append(PageBreak())

    # 21. Education
    story.append(_para(f"<b>21. Educational Qualification</b> &nbsp;&nbsp; {_hi('शैक्षणिक योग्यता')}", BODYL))
    edu_rows = [
        ["1", "SC / 10th Standard", "", "", ""],
        ["2", "HSC / 12th Standard", "", "", ""],
        ["3", "Graduation (BA / B.Com / B.Sc / BE / B.Pharma / Other)", "", "", ""],
        ["4", "Post-Graduation / Diploma", "", "", ""],
        ["5", "Any other Qualification", "", "", ""],
    ]
    story.append(_grid_table(
        ["Sr. No.", "School / Degree", "Institute / Board Name", "Marks / Grade", "Passing Year"],
        edu_rows,
        body_pad=_HAND_PAD_LG,
        col_widths=[14 * mm, 60 * mm, 50 * mm, 25 * mm, 22 * mm],
    ))
    story.append(Spacer(1, 6))

    # 22. Employment History
    story.append(_para(
        f"<b>22. Employment History (Starting with the most recent one)</b> &nbsp;&nbsp; "
        f"{_hi('रोज़गार विवरण (वर्तमान संस्था से शुरू कर)')}", BODYL))
    story.append(_grid_table(
        ["Sr. No.", "Company Name", "Position Held", "Employment Period (From-To)", "Reason for Leaving"],
        [["1", "", "", "", ""], ["2", "", "", "", ""], ["3", "", "", "", ""]],
        body_pad=_HAND_PAD_LG,
        col_widths=[14 * mm, 45 * mm, 35 * mm, 40 * mm, 36 * mm],
    ))
    story.append(Spacer(1, 6))

    # 23. Relatives
    story.append(_para(
        f"<b>23. Details of Relatives / Known Persons (if any) Working in RADHYA MICROFINANCE</b> &nbsp;&nbsp; "
        f"{_hi('कंपनी में कोई संबंधी अथवा पहचान वाले का विवरण')}", BODYL))
    story.append(_grid_table(
        ["Sr. No.", "Name", "Relationship", "Designation", "Posted At"],
        [["1", "", "", "", ""], ["2", "", "", "", ""]],
        body_pad=_HAND_PAD_LG,
        col_widths=[14 * mm, 45 * mm, 35 * mm, 40 * mm, 36 * mm],
    ))
    story.append(Spacer(1, 6))

    # 24. References
    story.append(_para(
        f"<b>24. GIVE TWO REFERENCES (OTHER THAN RELATIVES)</b> &nbsp;&nbsp; "
        f"{_hi('ऐसे दो लोगों का नाम जो आपका परिचय दे सकें, परंतु वो आपके परिवार के सदस्य नहीं होने चाहिए')}", BODYL))
    story.append(_grid_table(
        ["Sr. No.", "Name", "Company Name", "Position", "Phone No."],
        [["1", "", "", "", ""], ["2", "", "", "", ""]],
        body_pad=_HAND_PAD_LG,
        col_widths=[14 * mm, 45 * mm, 45 * mm, 30 * mm, 36 * mm],
    ))


def _section_3_undertaking(story, c):
    story.append(PageBreak())
    story.append(_para("Staff Undertaking", H1))

    name = _full_name(c) or "_______________"
    fhn = c.get("father_or_husband_name") or "_______________"
    addr = _addr_line(c) or "_______________"
    intro_en = (f"I, <b>{name}</b>, S/o or D/o or W/o Mr. <b>{fhn}</b>, aged about ____ years, "
                f"residing at village &amp; post Mandal District <b>{addr}</b>")
    story.append(_para(intro_en, BODY))
    story.append(_hpara("मैं पुत्र / पुत्री / पत्नी श्री ____ उम्र ____ वर्ष गाँव और पोस्ट मण्डल जिला ____ का निवासी हूँ।", BODY))
    story.append(_para(f"Do hereby affirm on oath that ({_hi('एतद् द्वारा शपथपूर्वक इसकी पुष्टि करता हूँ')})", BODYL))

    bullets = [
        ("The information regarding my academic qualifications and work experiences (if any) mentioned in my bio-data is true and accurate as per the record of my education and employment.",
         "मेरे बायोडाटा में दी गई सभी जानकारी सत्य है।"),
        ("There have never been any legal proceedings initiated against me, nor have I been involved in any misconduct / fraud / embezzlement of cash in any of my previous employments.",
         "मेरे खिलाफ कभी भी कोई कानूनी कार्यवाही नहीं हुई है और न ही मैं धोखाधड़ी / गबन आदि में शामिल रहा हूँ।"),
        ("I declare the above statements to be true in all respects. I acknowledge that any statement found to be false or deliberately misleading may make me liable to dismissal without any prior notice.",
         "मैं उपरोक्त सभी कथनों को सत्य घोषित करता हूँ। मैं स्वीकार करता हूँ कि कोई भी बयान, जो गलत या जान बूझकर गुमराह करने वाला पाया गया, मुझे बिना किसी पूर्व सूचना के बर्खास्त किया जा सकता है।"),
    ]
    for en, hi in bullets:
        story.append(_para(f"• {en}", BODY))
        story.append(_hpara(hi, BODY))

    story.append(Spacer(1, 4))
    story.append(_para(f"I further declare that — {_hi('मैं यह और भी घोषित करता हूँ —')}", BODYL))

    further = [
        ("Will familiarize myself with my Job Description and the Company's Credit Policy.",
         "मैं अपने काम के विवरण और कंपनी की क्रेडिट नीति के साथ स्वयं को परिचित हूँ।"),
        ("Will carry out my responsibilities with care, diligence and thoroughness, according to my Job Description and the Operations Manual, and will obey the Staff and Office Rules.",
         "अपने कार्य विवरण और संचालन नियमावली के अनुसार अपनी ज़िम्मेदारियों को सावधानी, परिश्रम और संपूर्णता से निभाऊँगा और अपने स्टाफ और कार्यालय नियमों का पालन करूँगा।"),
        ("Will supervise subordinate staff (if any) systematically and thoroughly to ensure that instructions are actually carried out, and in ways consistent with the procedures and internal controls outlined in the Operations Manual.",
         "मैं संचालन मैनुअल में उल्लिखित प्रक्रियाओं और आंतरिक नियंत्रणों के अनुरूप दिए गए निर्देशों को सुनिश्चित करने के लिए व्यवस्थित और अच्छी तरह से अधीनस्थ कर्मचारियों की निगरानी करूँगा।"),
        ("Will be honest and sincere in all my work, to set a good example so as to build the public image of the Company, and to do nothing that would detract from its goodwill.",
         "मैं अपने सभी कार्यों में ईमानदार रहूँगा, एक अच्छा उदाहरण स्थापित करूँगा ताकि कंपनी की सार्वजनिक छवि बने और ऐसा कुछ भी नहीं करूँगा जिससे इसकी ख्याति में कमी आए।"),
    ]
    for en, hi in further:
        story.append(_para(f"• {en}", BODY))
        story.append(_hpara(hi, BODY))

    story.append(Spacer(1, 10))
    story.append(_kv_table([
        [_para("<b>Joining Location :</b>", BODYL), _para(c.get("joining_location") or "Head Office, Moradabad", BODYL)],
        [_para("<b>Date of Joining :</b>", BODYL), _para(_fmt_date(c.get("expected_joining_date")), BODYL)],
        [_para("<b>Employee Signature :</b>", BODYL), _para("", BODYL)],
    ]))


def _section_4_insurance(story, c):
    story.append(PageBreak())
    story.append(_para("EMPLOYEE'S INSURANCE FORM", H1))
    story.append(_hindi_heading_image("(कर्मचारी के बीमा पत्र)", font_size=10, width_mm=120.0))
    story.append(Spacer(1, 2))
    story.append(_para("(Group Medical Insurance, Group Personal Accident &amp; Group Term Life)", SUBTITLE))
    story.append(Spacer(1, 4))

    story.append(_para(
        f"I hereby undertake that I wish to become a member of the Employee's Insurance Policy. "
        f"{_hi('मैं कर्मचारी बीमा पॉलिसी का सदस्य बनना चाहता हूँ।')}", BODY))
    story.append(_para(
        f"I am providing you with the requisite particulars as under. "
        f"({_hi('मैं आवश्यक विवरणों को आपको निम्नानुसार प्रदान कर रहा हूँ')})", BODY))
    story.append(Spacer(1, 6))

    story.append(_para("MEMBER ENROLMENT FORM", H2))
    story.append(_para("(Group Medical Insurance, GTL &amp; GPA)", NOTE))
    name = _full_name(c)
    story.append(_grid_table(
        ["Employee Name", "Employee Code", "DOB", "Gender", "Age"],
        [[name, c.get("employee_id", ""), c.get("dob", ""), c.get("gender", ""), ""]],
        col_widths=[55 * mm, 30 * mm, 30 * mm, 25 * mm, 25 * mm],
        font_size=9,
    ))
    story.append(Spacer(1, 6))

    story.append(_para("Dependent details", H2))
    story.append(_grid_table(
        ["Relation", "Name", "DOB", "Gender", "Age"],
        [["Father", "", "", "", ""], ["Mother", "", "", "", ""], ["Spouse", "", "", "", ""],
         ["1st Child", "", "", "", ""], ["2nd Child", "", "", "", ""]],
        col_widths=[30 * mm, 60 * mm, 25 * mm, 25 * mm, 25 * mm],
        font_size=9,
    ))
    story.append(Spacer(1, 6))

    story.append(_para(
        "In case of my death (or any other mishap), I request you to provide the insurance coverage amount to the nominee given in the table below.",
        BODY))
    story.append(_hpara(
        "मेरी मृत्यु (या किसी अन्य दुर्घटना) के मामले में, मैं आपसे नीचे दी गई तालिका में दिए गए नामांकित व्यक्ति को बीमा कवरेज राशि प्रदान करने का अनुरोध करता हूँ।",
        BODY))
    story.append(_grid_table(
        ["Nominee Name", "Relationship", "PF share payable to each nominee", "Permanent Address with Pincode"],
        _blank_rows(4, 2),
        col_widths=[40 * mm, 30 * mm, 35 * mm, 60 * mm],
    ))
    story.append(Spacer(1, 4))
    story.append(_para(
        "I understand that this undertaking is irrevocable and applicable for the payment of premium amount by the Company "
        "during my service period. I further undertake to inform the Company as and when there is a change in the name of the "
        "nominee, and till my submission of the change in writing, no change may please be entertained by the Company.",
        BODY))
    story.append(Spacer(1, 8))
    story.append(_kv_table([
        [_para("<b>Date</b>", BODYL), _para("", BODYL)],
        [_para("<b>Employee Signature</b>", BODYL), _para("", BODYL)],
    ]))


def _section_5_gratuity(story, c):
    story.append(PageBreak())
    story.append(_para("FORM – 'F'", H1))
    story.append(_para("PAYMENT OF GRATUITY ACT &nbsp;&nbsp;[ SEE SUB-RULE (1) of Rule 6 ]", SUBTITLE))
    story.append(_para("NOMINATION", H2))
    story.append(_para("To,", BODYL))
    story.append(_para("Radhya Micro Finance Pvt Ltd<br/>MIG-29, Ramganga Vihar Vistar, Moradabad - 244001", BODY))
    story.append(_para("[I give here name or description of the establishment with full address.]", NOTE))
    story.append(Spacer(1, 4))

    name = _full_name(c) or "_______________"
    story.append(_para(f"Shri / Shrimati: <b>{name}</b> &nbsp; whose particulars are given in the statement below:", BODY))
    story.append(Spacer(1, 4))
    story.append(_para(
        "I hereby nominate the person(s) mentioned below to receive the gratuity payable after my death, as also the gratuity "
        "standing to my credit in the event of my death before the amount has become payable, or having become payable has not "
        "been paid, and direct that the said amount of gratuity shall be paid in the proportion indicated against the name(s) "
        "of the nominee(s).", BODY))
    story.append(Spacer(1, 4))
    story.append(_para(
        "02. I hereby certify that the person(s) mentioned is/are a member(s) of my family within the meaning of clause (h) of "
        "Section (2) of the Payment of Gratuity Act, 1972.", BODY))
    story.append(_para(
        "I hereby declare that I have no family within the meaning of clause (h) of Section (2) of the said Act.", BODY))
    story.append(_para("(a) My Father / Mother / Parents is/are not dependent on me.", BODYL))
    story.append(_para("(b) My husband's / Father / Mother / Parents is/are not dependent on my husband.", BODYL))
    story.append(_para(
        "05. I have excluded my Husband from my family by a notice dated ____ to the controlling authority in terms of the "
        "provision to clause (h) of Section (2) of the said Act.", BODY))
    story.append(_para("06. Nomination made herein invalidates my previous nomination.", BODY))
    story.append(Spacer(1, 6))

    story.append(_grid_table(
        ["Sr.", "Nominee's Name", "Relationship", "Age", "Gratuity share payable", "Permanent Address with Pincode"],
        _blank_rows(6, 2),
        col_widths=[10 * mm, 35 * mm, 28 * mm, 12 * mm, 30 * mm, 55 * mm],
    ))
    story.append(Spacer(1, 6))

    story.append(_para("<b>STATEMENT</b>", BODYL))
    story.append(_grid_table(
        ["Name (Full)", "Sex", "Religion", "Marital Status", "Department", "Post Held", "Date of Appointment"],
        [[name, c.get("gender", ""), "", "", c.get("department", ""), c.get("position", ""),
          _fmt_date(c.get("expected_joining_date"))]],
        col_widths=[35 * mm, 12 * mm, 18 * mm, 22 * mm, 25 * mm, 28 * mm, 25 * mm],
        font_size=8,
    ))
    story.append(Spacer(1, 4))
    story.append(_grid_table(
        ["Permanent Address", "Village/City", "Thana", "Sub-Division", "Post Office", "District", "State"],
        [[c.get("address", ""), c.get("city", ""), "", "", "", "", c.get("state", "")]],
        col_widths=[40 * mm, 25 * mm, 18 * mm, 22 * mm, 22 * mm, 22 * mm, 16 * mm],
        font_size=8,
    ))
    story.append(Spacer(1, 6))
    story.append(_grid_table(
        ["Place", "Date", "Signature / Thumb Impression of the employee"],
        _blank_rows(3, 1),
        col_widths=[30 * mm, 30 * mm, 105 * mm],
    ))
    story.append(Spacer(1, 6))

    story.append(_para("<b>Declaration by witnesses</b>", BODYL))
    story.append(_para("Nomination signed / Thumb impressed before me", BODYL))
    story.append(_grid_table(
        ["Full name and full address of witnesses", "Place", "Date", "Signature of witnesses"],
        _blank_rows(4, 2),
        col_widths=[70 * mm, 25 * mm, 25 * mm, 45 * mm],
    ))
    story.append(Spacer(1, 6))

    story.append(_para("<b>Certificate by the Employer</b>", BODYL))
    story.append(_para(
        "Certified that the particulars of the above nomination have been verified and recorded in this establishment.", BODY))
    story.append(_grid_table(
        ["Employer's Reference No (if any)", "Date", "Signature of Employer / Authorised Officer", "Designation", "Establishment / Stamp"],
        _blank_rows(5, 1),
        col_widths=[35 * mm, 22 * mm, 45 * mm, 28 * mm, 35 * mm],
        font_size=7.5,
    ))
    story.append(Spacer(1, 6))

    story.append(_para("<b>Acknowledgment by the Employee</b>", BODYL))
    story.append(_para(
        "Received the duplicate of the nomination in Form 'F' filled by me and duly certified by the employer.", BODY))
    story.append(_grid_table(
        ["Date", "Signature of the employee"],
        _blank_rows(2, 1),
        col_widths=[40 * mm, 125 * mm],
    ))
    story.append(_para("Note: Strike out words / paragraph not applicable", NOTE))


def _section_6_pf(story, c):
    story.append(PageBreak())
    story.append(_para("Form No. 2 (Revised) — Nomination &amp; Declaration Form", H1))
    story.append(_para("(For Unexempted / Exempted Establishments)", SUBTITLE))
    story.append(_para(
        "Declaration &amp; Nomination Form under the Employees' Provident Fund &amp; Employees' Pension Schemes "
        "(Paragraph 33 and 61(1) of EPF Scheme 1952 and Paragraph 18 of EPS 1995)", BODY))
    story.append(Spacer(1, 4))

    story.append(_para("PART-A (EPF)", H2))
    story.append(_para(
        "I hereby nominate the person(s) / cancel the nomination made by me previously and nominate the person(s) mentioned "
        "below to receive the amount standing to my credit in the Employees' Provident Fund in the event of my death.", BODY))
    story.append(_grid_table(
        ["Sr.", "Name of Nominee", "Address", "Relationship", "Age / DOB", "Share (%)", "Guardian (if minor)"],
        _blank_rows(7, 2),
        col_widths=[10 * mm, 32 * mm, 40 * mm, 24 * mm, 22 * mm, 16 * mm, 28 * mm],
        font_size=8,
    ))
    story.append(Spacer(1, 4))
    story.append(_para(
        "Certified that I have no family as in para 2(g) of the EPF Scheme 1952 and should I acquire a family hereafter the above "
        "nomination shall be deemed cancelled.", BODY))
    story.append(_para("Certified that my Father / Mother is / are dependent on me.", BODY))
    story.append(_kv_table([
        [_para("<b>Strike out whichever is not applicable</b>", BODYL), _para("Signature / Thumb impression of the subscriber", BODYL)],
        [_para("", BODYL), _para("", BODYL)],
    ]))
    story.append(Spacer(1, 6))

    story.append(_para("PART-B (EPS) — Para 18", H2))
    story.append(_para(
        "I hereby furnish the particulars of the members of my family who would be eligible to receive widow / children "
        "pension in the event of my premature death.", BODY))
    story.append(_grid_table(
        ["Family Member", "Name", "Address", "DOB", "Relation"],
        [["Father", "", "", "", ""], ["Mother", "", "", "", ""], ["Spouse", "", "", "", ""],
         ["1st Child", "", "", "", ""], ["2nd Child", "", "", "", ""]],
        col_widths=[28 * mm, 35 * mm, 50 * mm, 22 * mm, 25 * mm],
    ))
    story.append(Spacer(1, 4))
    story.append(_para(
        "Certified that I have no family as defined in para 2(vii) of the EPS 1995 and should I acquire family hereafter I shall "
        "furnish particulars in the above form.", BODY))
    story.append(_para(
        "I hereby nominate the following person for receiving the monthly widow pension (admissible under para 16(2)(a)(i) &amp; "
        "(ii)) in the event of my death without leaving any eligible family member for receiving pension.", BODY))
    story.append(_grid_table(
        ["Sr.", "Name", "Address", "DOB / Age", "Relation"],
        _blank_rows(5, 1),
        col_widths=[10 * mm, 35 * mm, 60 * mm, 25 * mm, 30 * mm],
    ))
    story.append(Spacer(1, 4))
    story.append(_grid_table(
        ["Date", "Strike out whichever is not applicable", "Signature / Thumb impression of the subscriber"],
        _blank_rows(3, 1),
        col_widths=[28 * mm, 60 * mm, 72 * mm],
    ))
    story.append(Spacer(1, 6))

    story.append(_para("<b>CERTIFICATE BY EMPLOYER</b>", BODYL))
    story.append(_para(
        "Certified that the above declaration and nomination has been signed / thumb impressed before me by ____ employed in my "
        "establishment after he has read the entry/entries been read over to him by me and got confirmed by him.", BODY))
    story.append(_grid_table(
        ["Place", "Date", "Signature of the Employer / Authorised Officer", "Designation"],
        _blank_rows(4, 1),
        col_widths=[28 * mm, 28 * mm, 65 * mm, 40 * mm],
    ))


def _section_7_form11(story, c):
    story.append(PageBreak())
    story.append(_para("New Form 11 — Declaration Form", H1))
    story.append(_para("(To be retained by the employer for future reference)", SUBTITLE))
    story.append(_para("EMPLOYEES' PROVIDENT FUND ORGANIZATION", CENTER_BOLD))
    story.append(_para(
        "Employees' Provident Fund Scheme, 1952 (Paragraphs 34 &amp; 57) &amp; Employees' Pension Scheme, 1995 (Paragraph 24). "
        "Declaration by a person taking up employment in any establishment to which the EPF Scheme is applicable.", BODY))
    story.append(Spacer(1, 6))

    rows = [
        ["1", "Name of the Member", _full_name(c)],
        ["2", "Father's / Spouse's Name", c.get("father_or_husband_name", "")],
        ["3", "Date of Birth (DD/MM/YYYY)", c.get("dob", "")],
        ["4", "Gender (Male / Female / Transgender)", c.get("gender", "")],
        ["5", "Marital Status (Married / Unmarried / Widow / Widower / Divorcee)", ""],
        ["6", "Email ID", c.get("email", "")],
        ["7", "Mobile No.", c.get("mobile", "")],
        ["8", "Whether earlier a member of EPF Scheme, 1952", ""],
        ["9", "Whether earlier a member of EPS Scheme, 1995", ""],
        ["10(a)", "Universal Account Number", ""],
        ["10(b)", "Previous PF Account Number", ""],
        ["10(c)", "Date of exit from previous employment (DD/MM/YYYY)", ""],
        ["10(d)", "Scheme Certificate Number (if issued)", ""],
        ["10(e)", "Pension Payment Order Number (if issued)", ""],
        ["11(a)", "International Worker", "No"],
        ["11(b)", "If Yes, Country of Origin", ""],
        ["11(c)", "Passport Number", ""],
        ["11(d)", "Validity of Passport (From — To)", ""],
        ["12(a)", "Bank Name", ""],
        ["12(b)", "Bank Account Number", ""],
        ["12(c)", "IFSC Code", ""],
        ["12(d)", "Aadhaar Number", c.get("aadhaar_number", "")],
        ["12(e)", "Permanent Account Number (PAN)", c.get("pan_number", "")],
    ]
    story.append(_grid_table(
        ["Sr.", "Particular", "Details"],
        rows,
        col_widths=[14 * mm, 80 * mm, 76 * mm],
        font_size=8.5,
    ))
    story.append(Spacer(1, 6))
    story.append(_para("<b>UNDERTAKING</b>", BODYL))
    story.append(_para(
        "Certified that the particulars are true to the best of my knowledge. I authorise EPFO to use my Aadhaar for "
        "verification / authentication / e-KYC purposes for service delivery. Kindly transfer the funds and service detail, "
        "if applicable, from the previous PF Account as declared above to the present PF Account. (The transfer would be "
        "possible only if the identified KYC details approved by the previous employer have been verified by the present "
        "employer using a Digital Signature Certificate.) In case of change in the above details, the same shall be intimated "
        "to the employer at the earliest.", BODY))
    story.append(Spacer(1, 6))
    story.append(_grid_table(
        ["Date", "Place", "Signature of Member"],
        _blank_rows(3, 1),
        col_widths=[40 * mm, 50 * mm, 80 * mm],
    ))


def _section_8_esi(story, c):
    story.append(PageBreak())
    story.append(_para("ESI Temp Card Details", H1))
    name = _full_name(c)
    rows = [
        ["1", "Employee Name", name],
        ["2", "Employee DOB", c.get("dob", "")],
        ["3", "Gender", c.get("gender", "")],
        ["4", "Marital Status", ""],
        ["5", "Aadhaar No.", c.get("aadhaar_number", "")],
        ["6", "Contact No.", c.get("mobile", "")],
        ["7", "Father Name", c.get("father_or_husband_name", "")],
        ["8", "Spouse Name (if married)", ""],
        ["9", "Correspondence Address", _addr_line(c)],
        ["10", "Permanent Address", _addr_line(c)],
        ["11", "ESI No. (if any)", ""],
        ["12", "Mention nearest ESI Dispensary", ""],
    ]
    story.append(_grid_table(
        ["Sr.", "Particular", "Details"],
        rows,
        col_widths=[12 * mm, 60 * mm, 98 * mm],
        font_size=9,
    ))
    story.append(Spacer(1, 6))
    story.append(_para("<b>Nominee Details</b>", BODYL))
    story.append(_grid_table(
        ["Nominee Name", "Relationship", "Contact No.", "Nominee Address"],
        _blank_rows(4, 1),
        col_widths=[40 * mm, 30 * mm, 30 * mm, 65 * mm],
    ))
    story.append(Spacer(1, 4))
    story.append(_para("<b>Family Details</b>", BODYL))
    story.append(_grid_table(
        ["Relationship", "Name", "DOB", "Aadhaar No."],
        [["Father", "", "", ""], ["Mother", "", "", ""], ["Spouse", "", "", ""],
         ["1st Child", "", "", ""], ["2nd Child", "", "", ""]],
        col_widths=[30 * mm, 60 * mm, 30 * mm, 45 * mm],
    ))


def _section_9_notice(story, c):
    story.append(PageBreak())
    story.append(_hindi_heading_image("घोषणा पत्र", font_size=12))
    story.append(Spacer(1, 2))

    name = _full_name(c) or "_______________"
    fhn = c.get("father_or_husband_name") or "_______________"
    addr = _addr_line(c) or "_______________"
    role = c.get("position") or "_______________"
    doj = _fmt_date(c.get("expected_joining_date")) or "_______________"

    en_intro = (f"I, <b>{name}</b>, S/o or D/o or W/o <b>{fhn}</b>, residing at <b>{addr}</b>, am joining "
                f"Radhya Micro Finance Private Limited on <b>{doj}</b> in the role of <b>{role}</b>. "
                "I have been informed regarding resignation that I will have to complete my notice-period as per the "
                "details given below.")
    hi_intro = (
        f"मैं पुत्र / पुत्री / पत्नी ____, पता ____, थाना ____, जिला ____ का निवासी हूँ। मैं आज दिनांक "
        f"{doj or '____'} को राधा माइक्रो फाइनेंस प्राइवेट लिमिटेड में {role} के पद पर शामिल हो रहा हूँ, और मुझे "
        "त्याग पत्र के संदर्भ में यह भी बताया गया है कि मुझे अपने त्याग पत्र की अवधि पूरी करनी होगी, जिसका विवरण निम्नलिखित है।"
    )
    story.append(_para(en_intro, BODY))
    story.append(_hpara(hi_intro, BODY))
    story.append(Spacer(1, 4))

    story.append(_grid_table(
        ["Sr No", "Grade", "Notice Period"],
        [["1", "Trainee", "15 Days"],
         ["2", "Probation", "30 Days"],
         ["3", "Up to Sr. Officer", "60 Days"],
         ["4", "Asst. Manager & Above", "90 Days"]],
        col_widths=[20 * mm, 80 * mm, 70 * mm],
    ))
    story.append(Spacer(1, 6))
    story.append(_para(
        "I have read all the above statements, and I have also been explained by the HR officer that on failure to "
        "complete the notice period, the HR Department may take action on behalf of the Company.",
        BODY))
    story.append(_hpara(
        "उपरोक्त सभी कथन मैंने पढ़ लिए हैं, और मुझे HR अधिकारी द्वारा यह भी समझाया गया है कि नोटिस अवधि पूरी न करने पर "
        "कंपनी की तरफ से HR विभाग अपनी कार्यवाही करेगा।", BODY))
    story.append(Spacer(1, 8))
    story.append(_kv_table([
        [_para("<b>Employee Signature :</b>", BODYL), _para("", BODYL)],
        [_para("<b>Employee Name :</b>", BODYL), _para(name, BODYL)],
        [_para("<b>Employee Code :</b>", BODYL), _para(c.get("employee_id", ""), BODYL)],
        [_para("<b>Date of Joining :</b>", BODYL), _para(doj, BODYL)],
    ]))


def _section_10_assets(story, c):
    story.append(PageBreak())
    story.append(_para("ACKNOWLEDGEMENT AND ASSETS DECLARATION BY EMPLOYEE", H1))
    name = _full_name(c) or "Mr/Ms ____"
    story.append(_para(
        f"I, <b>{name}</b>, hereby acknowledge that I have received the above-mentioned assets along with the below conditions:",
        BODY))
    story.append(Spacer(1, 4))
    story.append(_para(
        "I understand that I am being issued a laptop / desktop as a tool to facilitate my work. I understand that I am responsible "
        "for the equipment issued to me and will care for it in such a manner as to prevent loss or damage. I further understand:",
        BODY))
    bullets = [
        "The laptop is a work tool and should not be carried outside office premises (in case of business requirement, MD / Vertical Head approval will be required and submitted to IT immediately).",
        "In the case of any damages or abuse of the laptop, or my failure to follow Company technology acceptable use policies (including this agreement), I shall be held responsible for payment of repairs or replacement. The Company reserves the right to withhold payment from my pay cheque if I fail to make appropriate payment.",
        "In the event of loss or theft of the laptop, I am responsible to obtain an incident-specific police report immediately and notify my Manager / IT Department for repair or replacement matters.",
        "The laptop / desktop and any accessories shall be returned to IT immediately upon termination of my employment.",
        "Any data corruption or configuration errors caused by the installation of unauthorised or illegal software may result in loss of all data due to a complete reload.",
        "No data of pornographic or communal nature may be stored on the laptop. Unauthorised or illegal software may not be installed.",
        "Failure to follow this may result in penalty and immediate seizure of laptop.",
        "I am responsible for backing up all data on the laptop / desktop. Data should be kept on the network shared drive only. The Company / IT is not liable for lost data and for any recovery of lost data.",
        "No USB storage / external network drive shall be used without IT authorisation.",
        "Use of this laptop is governed by the Information Technology Resource Usage Policy of Radhya Microfinance Pvt Ltd.",
    ]
    for b in bullets:
        story.append(_para(f"• {b}", BODY))
    story.append(Spacer(1, 6))
    story.append(_para(
        "I agree to the above terms and conditions and agree to fully cooperate with property loss reporting requirements and "
        "with property loss incident investigations. My signature below indicates I have thoroughly read and understood the "
        "above information.", BODY))
    story.append(Spacer(1, 8))
    story.append(_kv_table([
        [_para("<b>Employee Signature</b>", BODYL), _para("", BODYL)],
        [_para("<b>Date</b>", BODYL), _para("", BODYL)],
    ]))
    story.append(Spacer(1, 4))
    story.append(_para("I have received the following item(s) for my laptop computer and am responsible for replacing any lost items at the time the laptop is returned.", BODY))


def _section_11_nda(story, c, company):
    story.append(PageBreak())
    story.append(_para("Non-Disclosure Agreement", H1))
    name = _full_name(c) or "_______________"
    fhn = c.get("father_or_husband_name") or "_______________"
    addr = _addr_line(c) or "_______________"
    company_name = company.get("company_name") or "Radhya Micro Finance Private Limited"
    company_addr = company.get("address") or "MIG-29, Ram Ganga Vihar Vistar, Moradabad - 244001"

    story.append(_para(
        "This Non-Disclosure Agreement (\"Agreement\") is made and entered into as of the date of joining by and between:",
        BODY))
    story.append(_para(
        f"<b>{company_name}</b>, a Non-Banking Financial Company incorporated under the Companies Act, 2013, having its "
        f"registered office at {company_addr} (hereinafter referred to as the \"Company\"),", BODY))
    story.append(_para("AND", CENTER_BOLD))
    story.append(_para(
        f"The undersigned employee, <b>{name}</b>, Father / Spouse Name: <b>{fhn}</b>, Employee ID: "
        f"<b>{c.get('employee_id') or '_______________'}</b>, residing at <b>{addr}</b> "
        "(hereinafter referred to as the \"Employee\").", BODY))
    story.append(Spacer(1, 4))

    story.append(_para("<b>Purpose</b>", BODYL))
    story.append(_para(
        "The Employee acknowledges that during the course of employment with the Company, they may have access to, or be "
        "exposed to, confidential and proprietary information. This Agreement is intended to prevent the unauthorized "
        "disclosure and use of such information.", BODY))

    story.append(_para("<b>Definition of Confidential Information</b>", BODYL))
    story.append(_para('For the purposes of this Agreement, "Confidential Information" includes but is not limited to:', BODY))
    for it in [
        "Business plans and strategies",
        "Financial and operational data",
        "Client lists and information",
        "Technical data, software and systems",
        "Marketing and sales strategies",
        "Employee information",
        "Any non-public information related to the Company or its affiliates",
    ]:
        story.append(_para(f"• {it}", BODY))
    story.append(_para(
        "Confidential Information may be oral, written, digital, or in any other form, whether marked confidential or not.",
        BODY))

    story.append(_para("<b>Obligations of the Employee</b>", BODYL))
    for ob in [
        "(A) Hold the Confidential Information in strict confidence and exercise a reasonable degree of care to prevent disclosure to others.",
        "(B) Not reproduce the Confidential Information nor use it commercially or for any purpose other than the performance of duties.",
        "(C) Take all reasonable precautions to prevent any unauthorised use or disclosure.",
        "(D) Immediately notify Radhya of any unauthorised use or disclosure of Confidential Information.",
        "(E) In the event of any intentional, unintentional or mistaken leak or exposure of Confidential Information, the Employee shall immediately inform the Company and cooperate fully to mitigate any damage.",
    ]:
        story.append(_para(ob, BODY))

    story.append(_para("<b>Return of Property</b>", BODYL))
    story.append(_para(
        "Upon termination of employment or upon request by the Company, the Employee shall return all materials, assets, "
        "documents and other property containing or relating to the Confidential Information.", BODY))

    story.append(_para("<b>Term</b>", BODYL))
    story.append(_para(
        "This Agreement shall remain in effect during the term of the Employee's employment and shall continue for a period "
        "of two (2) years after termination of employment, regardless of the reason for such termination.", BODY))

    story.append(_para("<b>Remedies</b>", BODYL))
    story.append(_para(
        "Any unauthorised disclosure or use of Confidential Information may cause irreparable harm to the Company. The Company "
        "shall be entitled to seek injunctive relief or specific performance and such other relief as may be proper "
        "(including monetary damages if appropriate).", BODY))

    story.append(_para("<b>Governing Law and Jurisdiction</b>", BODYL))
    story.append(_para(
        "This Agreement shall be governed by and construed in accordance with the laws of India. Any disputes arising under "
        "or in connection with this Agreement shall be subject to the exclusive jurisdiction of the courts located in "
        "Moradabad, Uttar Pradesh.", BODY))

    story.append(Spacer(1, 8))
    story.append(_para(
        "IN WITNESS WHEREOF, the Parties have executed this Agreement as of the date below.", BODY))
    story.append(Spacer(1, 6))
    story.append(_grid_table(
        [f"For {company_name}", "Employee"],
        [["Signature : ____________________", "Signature : ____________________"],
         ["Name : Shivani Pathak", f"Name : {name}"],
         ["Designation : Asst. H.R. Manager", f"Designation : {c.get('position') or '_______________'}"],
         ["Date : ____________________", "Date : ____________________"]],
        col_widths=[85 * mm, 85 * mm],
        font_size=9,
        header_bold=True,
    ))


def _section_12_asset_form(story, c):
    story.append(PageBreak())
    story.append(_para("ASSET DECLARATION FORM", H1))
    rows = [
        ["1", "EMPLOYEE NAME", _full_name(c)],
        ["2", "EMPLOYEE CODE", c.get("employee_id", "")],
        ["3", "DEPARTMENT", c.get("department", "")],
        ["4", "DESIGNATION", c.get("position", "")],
        ["5", "JOINING LOCATION", c.get("joining_location") or "Head Office, Moradabad"],
    ]
    story.append(_grid_table(
        ["Sr.", "Particular", "Details"],
        rows,
        col_widths=[12 * mm, 60 * mm, 98 * mm],
        font_size=9,
    ))
    story.append(Spacer(1, 6))
    story.append(_para("<b>Dear Employee,</b>", BODYL))
    story.append(_para(
        "Please find the below asset(s) handed over to you to support you in carrying out your assignment in a most proficient manner.",
        BODY))
    story.append(Spacer(1, 4))

    asset_rows = [[str(i + 1), "", "", "", "", ""] for i in range(20)]
    story.append(_grid_table(
        ["Sr.", "Particular", "Asset Code", "Issuance Date", "Date of Return", "Remarks"],
        asset_rows,
        col_widths=[12 * mm, 50 * mm, 28 * mm, 28 * mm, 28 * mm, 24 * mm],
        font_size=8,
    ))
    story.append(Spacer(1, 8))
    # Three signatories, one column each: the employee receiving the assets, HR
    # approving the issue, and Administration actually handing them over. The old
    # four-column version paired two bare "Signature" cells with two department
    # names, which read as two blocks, not three.
    story.append(_grid_table(
        ["Employee's Signature", "Approved By HR Department",
         "Issued By Administration Department"],
        _blank_rows(3, 1),
        col_widths=[57 * mm, 57 * mm, 56 * mm],
        font_size=8.5,
        body_pad=_SIGN_PAD,
    ))


def _section_14_posh_bgv(story, c):
    """POSH Declaration + Background Verification Consent Form."""
    story.append(PageBreak())
    name = _full_name(c) or "_______________"
    emp_id = c.get("employee_id") or "_______________"
    designation = c.get("position") or "_______________"
    addr = _addr_line(c) or "_______________"

    # ---- POSH ----
    story.append(_para("POSH DECLARATION", H1))
    story.append(_para("(Prevention of Sexual Harassment at Workplace)", SUBTITLE))
    story.append(Spacer(1, 4))

    story.append(_para(f"I, <b>{name}</b>, hereby declare that:", BODY))
    posh_clauses = [
        "I have read and understood the company's POSH (Prevention of Sexual Harassment) Policy.",
        "I am aware of the members of the internal complaints committee and the process to report complaints.",
        "I agree to comply with the policy and maintain a respectful and safe workplace.",
        "I understand that any form of sexual harassment is strictly prohibited and may lead to disciplinary action.",
        "I will report any incident of harassment that I experience or witness, as per the company's guidelines.",
        "I agree to cooperate in any inquiry related to such complaints.",
        "I acknowledge that maintaining dignity, respect, and safety at the workplace is my responsibility.",
    ]
    for clause in posh_clauses:
        story.append(_para(f"• {clause}", BODY))
    story.append(Spacer(1, 8))

    story.append(_kv_table([
        [_para("<b>Employee Name</b>", BODYL), _para(name, BODYL)],
        [_para("<b>Employee ID</b>", BODYL), _para(emp_id, BODYL)],
        [_para("<b>Designation</b>", BODYL), _para(designation, BODYL)],
        [_para("<b>Signature</b>", BODYL), _para("", BODYL)],
        [_para("<b>Date</b>", BODYL), _para("", BODYL)],
    ]))
    story.append(Spacer(1, 14))

    # ---- BGV ----
    story.append(_para("BACKGROUND VERIFICATION CONSENT FORM", H1))
    story.append(Spacer(1, 4))

    story.append(_para(
        f"I, <b>{name}</b>, hereby give my consent to Radhya Micro Finance Pvt. Ltd. to conduct background "
        "verification as part of my employment.",
        BODY))
    story.append(Spacer(1, 4))
    story.append(_para("I understand and agree that the verification process may include:", BODYL))
    bgv_checks = [
        "Residence / House Verification (physical visit by company representative)",
        "Identity &amp; Address Verification",
        "Previous Employment Verification (if applicable)",
        "Police Verification (only if required under specific circumstances)",
        "Bank Statement or Financial Details (if required for official purposes)",
        "Any other verification deemed necessary by the company",
    ]
    for chk in bgv_checks:
        story.append(_para(f"• {chk}", BODY))
    story.append(Spacer(1, 4))

    story.append(_para("I further declare that:", BODYL))
    declarations = [
        "All information provided by me is true, correct, and complete.",
        "I authorise the company to verify my details through internal teams or third-party agencies.",
        "I understand that any false information, misrepresentation, or non-disclosure may result in withdrawal of the offer or termination of employment.",
        "I agree to cooperate fully during the verification process.",
        "All information collected will be kept confidential and used strictly for official purposes.",
        "I hereby release the company from any liability arising out of such verification process.",
    ]
    for d in declarations:
        story.append(_para(f"• {d}", BODY))
    story.append(Spacer(1, 8))

    story.append(_kv_table([
        [_para("<b>Employee Name</b>", BODYL), _para(name, BODYL)],
        [_para("<b>Employee ID</b>", BODYL), _para(emp_id, BODYL)],
        [_para("<b>Designation</b>", BODYL), _para(designation, BODYL)],
        [_para("<b>Current Address</b>", BODYL), _para(addr, BODYL)],
        [_para("<b>Signature</b>", BODYL), _para("", BODYL)],
        [_para("<b>Date</b>", BODYL), _para("", BODYL)],
    ]))


# ----- Public API -----------------------------------------------------------


def build_joining_kit_pdf(candidate: dict, company: dict | None = None,
                          has_aadhaar_doc: bool = False, has_pan_doc: bool = False) -> bytes:
    company = company or {}
    candidate = dict(candidate)  # shallow copy
    candidate["_has_aadhaar_doc"] = has_aadhaar_doc
    candidate["_has_pan_doc"] = has_pan_doc

    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=14 * mm, rightMargin=14 * mm,
        topMargin=12 * mm, bottomMargin=12 * mm,
        title=f"Joining Kit - {_full_name(candidate)}",
        author=company.get("company_name", "Radhya Micro Finance"),
    )
    story = []
    _section_1(story, candidate, company)
    _section_2_employee_info(story, candidate)
    _section_3_undertaking(story, candidate)
    _section_4_insurance(story, candidate)
    _section_5_gratuity(story, candidate)
    _section_6_pf(story, candidate)
    _section_7_form11(story, candidate)
    _section_8_esi(story, candidate)
    _section_9_notice(story, candidate)
    _section_10_assets(story, candidate)
    _section_11_nda(story, candidate, company)
    _section_12_asset_form(story, candidate)
    _section_14_posh_bgv(story, candidate)
    doc.build(story)
    buffer.seek(0)
    return buffer.getvalue()
