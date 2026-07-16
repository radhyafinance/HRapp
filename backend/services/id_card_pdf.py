"""Employee ID card PDF -- 50 x 82 mm portrait, front + back.

Page 1 is the employee's card face (photo, name, designation, employee ID, blood
group, emergency number, verification QR). Page 2 is the instructions/contact
back, which is identical for every employee so it can be pre-printed in bulk.

Both pages carry a hairline cut guide on the 50 x 82 mm trim edge.

Sizes below are derived from the approved mockup, which was laid out at
7.2 px per mm (a 360 px wide card = 50 mm). ``X()`` converts those px figures to
points, so the numbers here line up 1:1 with the mockup.
"""

import io
import os
from typing import Optional

from reportlab.lib.colors import HexColor
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

import qrcode
from qrcode.constants import ERROR_CORRECT_Q
from PIL import Image, ImageDraw

from services.id_card_assets import asset_path

# ── brand ────────────────────────────────────────────────────────────────────
NAVY = HexColor("#181831")       # Dark Knight
ORANGE = HexColor("#ff5a00")     # Maximum Orange
MUTED = HexColor("#6a6a7d")
CUT = HexColor("#a9a9b8")
WHITE = HexColor("#ffffff")

CARD_W, CARD_H = 50 * mm, 82 * mm

_PX_PER_MM = 7.2


def X(px: float) -> float:
    """Convert a mockup pixel value to points (the card is 360 px = 50 mm)."""
    return (px / _PX_PER_MM) * mm


PAD_TOP, PAD_SIDE, PAD_BOTTOM = X(20), X(12), X(14)
FOOT_H = X(26)

_HINDI_FONT = os.path.join(os.path.dirname(__file__), "fonts", "NotoSansDevanagari-SemiBold.ttf")

_FONTS_READY = False


def _fonts():
    """Register the brand fonts with ReportLab (idempotent)."""
    global _FONTS_READY
    if _FONTS_READY:
        return
    for name, fname in [
        ("Asterone", "Asterone-Regular.ttf"),
        ("Asterone-Bold", "Asterone-Bold.ttf"),
        ("Mont-Bold", "Montserrat-Bold.ttf"),
        ("Mont-Semi", "Montserrat-SemiBold.ttf"),
    ]:
        pdfmetrics.registerFont(TTFont(name, asset_path(fname)))
    _FONTS_READY = True


# ── small helpers ────────────────────────────────────────────────────────────
def _img(path_or_pil, ) -> ImageReader:
    return ImageReader(path_or_pil)


def _draw_img(c, src, x, y, w, h):
    c.drawImage(src, x, y, width=w, height=h, mask="auto")


def _tracked_width(c, text, font, size, char_space):
    """Width of `text` including letter-spacing (the trailing gap is not counted)."""
    return c.stringWidth(text, font, size) + char_space * max(len(text) - 1, 0)


def _text(c, x, y, text, font, size, color, char_space=0.0):
    """Draw text at x,y with optional letter-spacing.

    Letter-spacing lives on the text object, not the canvas. Note that the PDF
    `Tc` operator is *text state* and persists across BT/ET blocks, so the value
    is always set explicitly (including 0) -- otherwise tracking set on one
    string silently widens every string drawn after it.
    """
    t = c.beginText()
    t.setTextOrigin(x, y)
    t.setFont(font, size)
    t.setFillColor(color)
    t.setCharSpace(char_space)
    t.textOut(text)
    c.drawText(t)


def _centred(c, cx, y, text, font, size, color, char_space=0.0):
    w = _tracked_width(c, text, font, size, char_space)
    _text(c, cx - w / 2, y, text, font, size, color, char_space)


def _centred_two_tone(c, cx, y, label, value, size, char_space=0.0):
    """Draw `LABEL — value` centred, label muted and value navy."""
    wl = _tracked_width(c, label, "Mont-Semi", size, char_space)
    wv = _tracked_width(c, value, "Mont-Bold", size, char_space)
    x = cx - (wl + char_space + wv) / 2
    _text(c, x, y, label, "Mont-Semi", size, MUTED, char_space)
    _text(c, x + wl + char_space, y, value, "Mont-Bold", size, NAVY, char_space)


def _cut_line(c):
    """Hairline on the trim edge -- cut here with scissors."""
    c.setStrokeColor(CUT)
    c.setLineWidth(0.25)
    c.rect(0.125, 0.125, CARD_W - 0.25, CARD_H - 0.25, stroke=1, fill=0)


def _footer(c):
    """Orange bar flush to the bottom edge, with the white R mark."""
    c.setFillColor(ORANGE)
    c.rect(0, 0, CARD_W, FOOT_H, stroke=0, fill=1)
    ih = X(13)
    _draw_img(c, asset_path("icon_white.png"), X(14), (FOOT_H - ih) / 2, ih, ih)


def _logo(c, top_y):
    """Draw the wordmark centred; returns the y of its bottom edge."""
    lw = X(334)
    lh = lw * (193.0 / 700.0)  # embedded logo aspect
    y = top_y - lh
    _draw_img(c, asset_path("logo_dark.png"), (CARD_W - lw) / 2, y, lw, lh)
    return y


# ── photo ────────────────────────────────────────────────────────────────────
def _circular_photo(photo_bytes: Optional[bytes], px: int = 560) -> Image.Image:
    """Circular passport photo with the orange ring. Falls back to a silhouette.

    Built at 4x and downsampled: PIL's ellipse is not antialiased, so drawing at
    final size leaves a visibly jagged rim in print.
    """
    ss = 4
    s = px * ss
    size = (s, s)
    src = None

    if photo_bytes:
        try:
            src = Image.open(io.BytesIO(photo_bytes)).convert("RGB")
            # cover-crop to a square, then fill the circle
            w, h = src.size
            side = min(w, h)
            src = src.crop(((w - side) // 2, (h - side) // 2,
                            (w - side) // 2 + side, (h - side) // 2 + side))
            src = src.resize(size, Image.LANCZOS).convert("RGBA")
        except Exception:
            src = None

    if src is None:
        # placeholder: grey disc + person silhouette
        src = Image.new("RGBA", size, (238, 240, 243, 255))
        d = ImageDraw.Draw(src)
        cx = cy = s / 2
        u = s / 100.0
        d.ellipse([cx - 18 * u, cy - 30 * u, cx + 18 * u, cy + 6 * u], fill=(183, 186, 198, 255))
        d.ellipse([cx - 30 * u, cy + 2 * u, cx + 30 * u, cy + 62 * u], fill=(183, 186, 198, 255))

    out = Image.new("RGBA", size, (0, 0, 0, 0))
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).ellipse([0, 0, s - 1, s - 1], fill=255)
    out.paste(src, (0, 0), mask)

    # Orange ring. PIL strokes INWARD from the given box, so the box must be the
    # full circle -- insetting it leaves a rim of photo showing outside the ring.
    ring = max(2, round(s * 0.021))
    ImageDraw.Draw(out).ellipse([0, 0, s - 1, s - 1], outline=(255, 90, 0, 255), width=ring)
    return out.resize((px, px), Image.LANCZOS)


# ── QR ───────────────────────────────────────────────────────────────────────
def build_qr(url: str) -> Image.Image:
    """Verification QR.

    Error correction Q (not H) and a short URL keep this at a low version, so at
    15 mm each module stays ~0.37 mm -- above the ~0.33 mm that phone cameras
    need. Changing the URL length or the EC level shrinks the modules and can
    make printed cards unscannable, so don't tune these casually.
    """
    qr = qrcode.QRCode(version=None, error_correction=ERROR_CORRECT_Q,
                       box_size=16, border=2)
    qr.add_data(url)
    qr.make(fit=True)
    return qr.make_image(fill_color="#181831", back_color="white").convert("RGB")


def qr_module_mm(url: str, qr_mm: float = 15.0) -> float:
    """Printed size of one QR module, for sanity checks/tests."""
    qr = qrcode.QRCode(version=None, error_correction=ERROR_CORRECT_Q,
                       box_size=1, border=2)
    qr.add_data(url)
    qr.make(fit=True)
    return qr_mm / (qr.modules_count + 4)


# ── Hindi (ReportLab cannot shape Devanagari; HarfBuzz renders it to an image) ─
def _hindi_image(text: str, px_size: int = 96, oversample: int = 4) -> Optional[Image.Image]:
    try:
        import uharfbuzz as hb
        import freetype as ft
    except Exception:
        return None
    try:
        size = px_size * oversample
        with open(_HINDI_FONT, "rb") as fh:
            data = fh.read()
        face = hb.Face(data)
        font = hb.Font(face)
        upem = face.upem
        font.scale = (upem, upem)
        hb.ot_font_set_funcs(font)

        buf = hb.Buffer()
        buf.add_str(text)
        buf.guess_segment_properties()
        hb.shape(font, buf)

        scale = size / upem
        ftf = ft.Face(_HINDI_FONT)
        ftf.set_char_size(int(size * 64))

        total_w = sum(p.x_advance for p in buf.glyph_positions) * scale
        img = Image.new("RGBA", (max(1, int(total_w) + size), int(size * 2.0)), (0, 0, 0, 0))
        baseline = int(size * 1.25)
        pen_x = 0.0
        for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
            ftf.load_glyph(info.codepoint, ft.FT_LOAD_RENDER)
            bmp = ftf.glyph.bitmap
            if bmp.width and bmp.rows:
                glyph = Image.frombytes("L", (bmp.width, bmp.rows), bytes(bmp.buffer))
                col = Image.new("RGBA", glyph.size, (24, 24, 49, 255))
                col.putalpha(glyph)
                gx = int(pen_x + pos.x_offset * scale + ftf.glyph.bitmap_left)
                gy = int(baseline - ftf.glyph.bitmap_top - pos.y_offset * scale)
                img.alpha_composite(col, (max(gx, 0), max(gy, 0)))
            pen_x += pos.x_advance * scale
        return img.crop(img.getbbox()) if img.getbbox() else None
    except Exception:
        return None


# ── front ────────────────────────────────────────────────────────────────────
def _draw_front(c, emp: dict, verify_url: str, photo_bytes: Optional[bytes]):
    name = f"{(emp.get('first_name') or '').strip()} {(emp.get('last_name') or '').strip()}".strip()
    designation = (emp.get("designation") or "").strip()
    emp_id = (emp.get("employee_id") or "").strip()
    blood = (emp.get("blood_group") or "-").strip()
    emergency = (emp.get("emergency") or "").strip()

    y = _logo(c, CARD_H - PAD_TOP - X(2))

    # photo
    dia = X(140)
    y -= X(9) + dia
    photo = _circular_photo(photo_bytes)
    _draw_img(c, ImageReader(photo), (CARD_W - dia) / 2, y, dia, dia)

    # name
    y -= X(9)
    fs = X(21)
    y -= fs * 0.82
    _centred(c, CARD_W / 2, y, name.upper(), "Asterone-Bold", fs, NAVY, char_space=fs * 0.01)

    # designation
    ds = X(13)
    y -= X(7) + ds * 0.82
    _centred(c, CARD_W / 2, y, designation.upper(), "Asterone-Bold", ds, ORANGE, char_space=ds * 0.12)

    # orange rule
    y -= X(12) + X(2)
    c.setFillColor(ORANGE)
    c.rect((CARD_W - X(42)) / 2, y, X(42), X(2), stroke=0, fill=1)

    # facts
    fsz = X(17)
    y -= X(12)
    for label, value in (
        ("EMPLOYEE ID — ", emp_id),
        ("BLOOD GROUP — ", blood),
        ("EMERGENCY — ", emergency),
    ):
        y -= fsz * 0.82
        _centred_two_tone(c, CARD_W / 2, y, label, value, fsz, char_space=fsz * 0.01)
        y -= X(8)

    # QR -- pinned above the footer
    qr_side = X(108)
    qr_y = FOOT_H + X(10)
    _draw_img(c, ImageReader(build_qr(verify_url)), (CARD_W - qr_side) / 2, qr_y, qr_side, qr_side)

    _footer(c)
    _cut_line(c)


# ── back (identical on every card) ───────────────────────────────────────────
_ADDR_1 = "M.I.G. 29, RAM GANGA VIHAR VISTAR,"
_ADDR_2 = "MORADABAD – 244001, UTTAR PRADESH"
_PHONE = "+91 591 3511185"
_EMAIL = "MAIL@RADHYAFINANCE.COM"
_WEB = "WWW.RADHYAFINANCE.COM"
_TAGLINE_1 = "आपकी उन्नति"   # आपकी उन्नति
_TAGLINE_2 = "हमारा संकल्प"  # हमारा संकल्प


def _icon(c, kind, x, y, s):
    """Small line icons for the contact rows, drawn in a 24x24 space scaled to `s`."""
    c.setStrokeColor(NAVY)
    c.setFillColor(NAVY)
    c.setLineWidth(s * 0.09)
    c.setLineCap(1)
    c.setLineJoin(1)

    def P(vx, vy):  # SVG 24x24 (y down) -> PDF (y up)
        return x + vx * s / 24.0, y + (24 - vy) * s / 24.0

    if kind == "home":
        p = c.beginPath(); p.moveTo(*P(3, 10.5)); p.lineTo(*P(12, 3)); p.lineTo(*P(21, 10.5)); c.drawPath(p)
        p = c.beginPath(); p.moveTo(*P(5, 9.5)); p.lineTo(*P(5, 21)); p.lineTo(*P(19, 21)); p.lineTo(*P(19, 9.5)); c.drawPath(p)
        p = c.beginPath(); p.moveTo(*P(9.5, 21)); p.lineTo(*P(9.5, 15)); p.lineTo(*P(14.5, 15)); p.lineTo(*P(14.5, 21)); c.drawPath(p)
    elif kind == "phone":
        x0, y0 = P(7, 22); x1, y1 = P(17, 2)
        c.roundRect(x0, y0, x1 - x0, y1 - y0, s * 0.09, stroke=1, fill=0)
        p = c.beginPath(); p.moveTo(*P(10.5, 5)); p.lineTo(*P(13.5, 5)); c.drawPath(p)
        c.circle(*P(12, 19), s * 0.035, stroke=0, fill=1)
    elif kind == "mail":
        x0, y0 = P(3, 19); x1, y1 = P(21, 5)
        c.roundRect(x0, y0, x1 - x0, y1 - y0, s * 0.07, stroke=1, fill=0)
        p = c.beginPath(); p.moveTo(*P(3, 7)); p.lineTo(*P(12, 13)); p.lineTo(*P(21, 7)); c.drawPath(p)
    elif kind == "globe":
        c.circle(*P(12, 12), s * 9 / 24.0, stroke=1, fill=0)
        p = c.beginPath(); p.moveTo(*P(3, 12)); p.lineTo(*P(21, 12)); c.drawPath(p)
        cx, cy = P(12, 12)
        c.ellipse(cx - s * 4.5 / 24.0, cy - s * 9 / 24.0, cx + s * 4.5 / 24.0, cy + s * 9 / 24.0, stroke=1, fill=0)


def _draw_back(c):
    # Faint R watermark (opacity is baked into the PNG's alpha). Geometry mirrors
    # the approved mockup: 250px square, right edge 46px past the card edge, top
    # at 52% of the card height, CSS `rotate(-6deg)`.
    #
    # NOTE the sign: CSS rotates clockwise for positive angles (y grows downward),
    # PDF rotates counter-clockwise (y grows upward). So the mockup's -6deg is
    # +6 here. Using -6 tilts the mark the wrong way.
    wm = X(250)
    c.saveState()
    c.translate(X(281), X(158.4))   # centre of the mark
    c.rotate(6)
    _draw_img(c, asset_path("icon_watermark.png"), -wm / 2, -wm / 2, wm, wm)
    c.restoreState()

    y = _logo(c, CARD_H - PAD_TOP - X(2))

    # INSTRUCTIONS + underline
    hs = X(17)
    y -= X(14) + hs * 0.82
    _centred(c, CARD_W / 2, y, "INSTRUCTIONS", "Asterone-Bold", hs, NAVY, char_space=hs * 0.12)
    hw = _tracked_width(c, "INSTRUCTIONS", "Asterone-Bold", hs, hs * 0.12)
    c.setFillColor(ORANGE)
    c.rect((CARD_W - hw) / 2, y - X(5), hw, X(2), stroke=0, fill=1)

    # bullets
    bs = X(15)
    y -= X(16)
    bullets = [
        ["This ID is the legal property of Radhya", "Micro Finance Private Limited."],
        ["If found, please return to:"],
    ]
    for lines in bullets:
        y -= bs * 0.86
        c.setFillColor(ORANGE)
        c.circle(PAD_SIDE + X(3), y + bs * 0.28, X(3), stroke=0, fill=1)
        for i, ln in enumerate(lines):
            _text(c, PAD_SIDE + X(16), y - i * bs * 1.4, ln, "Mont-Bold", bs, NAVY)
        y -= (len(lines) - 1) * bs * 1.4 + X(11)

    # contact rows
    cs = X(14)
    icon_s = X(20)
    y -= X(4)
    rows = [
        ("home", [_ADDR_1, _ADDR_2]),
        ("phone", [_PHONE]),
        ("mail", [_EMAIL]),
        ("globe", [_WEB]),
    ]
    for kind, lines in rows:
        block_h = len(lines) * cs * 1.35
        y -= block_h
        _icon(c, kind, PAD_SIDE + X(4), y + block_h - icon_s, icon_s)
        tx = PAD_SIDE + X(4) + icon_s + X(11)
        for i, ln in enumerate(lines):
            _text(c, tx, y + block_h - cs * 0.9 - i * cs * 1.35, ln, "Mont-Bold", cs, NAVY)
        y -= X(12)

    # tagline block, sitting just above the footer
    tag_top = FOOT_H + X(52)
    c.setFillColor(ORANGE)
    c.rect((CARD_W - X(34)) / 2, tag_top, X(34), X(2), stroke=0, fill=1)

    ty = tag_top - X(10)
    for line in (_TAGLINE_1, _TAGLINE_2):
        img = _hindi_image(line)
        if img is None:
            continue
        h = X(16) * 1.05
        w = h * img.width / img.height
        ty -= h
        _draw_img(c, ImageReader(img), (CARD_W - w) / 2, ty, w, h)
        ty -= X(3)

    _footer(c)
    _cut_line(c)


# ── entry point ──────────────────────────────────────────────────────────────
def build_id_card_pdf(employee: dict, verify_url: str,
                      photo_bytes: Optional[bytes] = None) -> bytes:
    """Render the two-sided ID card.

    `employee` needs first_name, last_name, designation, employee_id,
    blood_group and `emergency` (the next-of-kin number the HR admin entered --
    NOT the employee's own mobile).
    """
    _fonts()
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(CARD_W, CARD_H))
    c.setTitle(f"ID Card {employee.get('employee_id') or ''}".strip())
    _draw_front(c, employee, verify_url, photo_bytes)
    c.showPage()
    _draw_back(c)
    c.showPage()
    c.save()
    return buf.getvalue()
