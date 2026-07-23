"""pdfkit.py — a minimal, pure-stdlib PDF writer for KasaKeeper's generated
documents. No dependencies: hand-rolls the PDF object model (objects, an xref
table, a trailer) and simple content-stream operators for text/rects/lines,
using the same low-level-primitives technique as docs/arch_gen.py's branded
output (shared brand tokens, hand-built drawing helpers) — but emitting real
PDF bytes directly instead of HTML for a headless-browser print step, since
the add-on has no browser available to it.

Not a general-purpose PDF library: just enough for a cover page, tables and a
totals block, with automatic pagination. Text uses the built-in Helvetica
base-14 fonts (no embedding) via WinAnsiEncoding, so only Windows-1252-safe
characters render — anything else is replaced with '?'.
"""

A4_W, A4_H = 595.28, 841.89   # points
MARGIN = 44


def rgb(hexcolor):
    """'#RRGGBB' -> (r, g, b) floats 0-1, for PDF's rg/RG color operators."""
    h = hexcolor.lstrip('#')
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def _pdf_str(s):
    """Escape + cp1252-clip a string for a PDF literal string, '(' ... ')'."""
    s = str(s if s is not None else '')
    try:
        b = s.encode('cp1252', 'replace')
    except Exception:
        b = s.encode('latin-1', 'replace')
    s = b.decode('latin-1')  # 1:1 char<->byte so the final latin-1 encode round-trips
    return s.replace('\\', r'\\').replace('(', r'\(').replace(')', r'\)')


def _charw(c):
    """Rough Helvetica advance width (per 1000 em) — good enough to fit/wrap text
    into fixed columns without needing the real AFM metrics table."""
    if c == ' ': return 278
    if c in 'ijl.,:;!\'|': return 230
    if c in 'mwMW@': return 800
    if c.isupper(): return 680
    if c.isdigit(): return 556
    return 520


def text_width(s, size, bold=False):
    w = sum(_charw(c) for c in str(s)) * size / 1000
    return w * (1.06 if bold else 1.0)


def fit(s, max_w, size, bold=False):
    """Truncate s with an ellipsis so it renders within max_w points."""
    s = str(s if s is not None else '')
    if text_width(s, size, bold) <= max_w:
        return s
    lo, hi = 0, len(s)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if text_width(s[:mid] + '…', size, bold) <= max_w:
            lo = mid
        else:
            hi = mid - 1
    return (s[:lo] + '…') if lo < len(s) else s


class Doc:
    """A paginated PDF being built. Draw top-down from Doc.y; ensure() breaks
    the page (and re-runs any header the caller wants repeated) when content
    would run past the bottom margin."""

    def __init__(self):
        self.pages = []   # list of list-of-content-stream-op-strings
        self._new_page()

    def _new_page(self):
        self.pages.append([])
        self.y = A4_H - MARGIN

    @property
    def _page(self):
        return self.pages[-1]

    def op(self, s):
        self._page.append(s)

    def ensure(self, h):
        """Break to a new page if h points won't fit above the bottom margin.
        Returns True if a new page was started."""
        if self.y - h < MARGIN:
            self._new_page()
            return True
        return False

    def text(self, x, y, s, size=10, bold=False, color=(0, 0, 0)):
        font = 'F2' if bold else 'F1'
        self.op(f"BT /{font} {size:.1f} Tf {color[0]:.3f} {color[1]:.3f} {color[2]:.3f} rg "
                f"{x:.2f} {y:.2f} Td ({_pdf_str(s)}) Tj ET")

    def rect(self, x, y, w, h, fill=None, stroke=None, lw=1):
        parts = []
        if fill is not None:
            parts.append(f"{fill[0]:.3f} {fill[1]:.3f} {fill[2]:.3f} rg")
        if stroke is not None:
            parts.append(f"{stroke[0]:.3f} {stroke[1]:.3f} {stroke[2]:.3f} RG {lw} w")
        mode = 'B' if (fill is not None and stroke is not None) else ('f' if fill is not None else ('S' if stroke is not None else ''))
        if mode:
            parts.append(f"{x:.2f} {y:.2f} {w:.2f} {h:.2f} re {mode}")
        if parts:
            self.op(' '.join(parts))

    def hline(self, x1, x2, y, color=(0, 0, 0), lw=1):
        self.op(f"{color[0]:.3f} {color[1]:.3f} {color[2]:.3f} RG {lw} w "
                f"{x1:.2f} {y:.2f} m {x2:.2f} {y:.2f} l S")

    def table(self, x, headers, col_widths, rows, size=9, row_h=18,
              header_fill=(0.9, 0.9, 0.9), header_color=(0, 0, 0),
              text_color=(0.2, 0.2, 0.2), line_color=(0.8, 0.8, 0.8)):
        """Draws a simple ruled table starting at self.y, paginating as needed
        and repeating the header row on every page it spans."""
        total_w = sum(col_widths)

        def header_row():
            self.ensure(row_h + 4)
            y0 = self.y
            self.rect(x, y0 - row_h, total_w, row_h, fill=header_fill)
            cx = x
            for htext, w in zip(headers, col_widths):
                self.text(cx + 6, y0 - row_h + 6, fit(htext, w - 10, size, True), size=size, bold=True, color=header_color)
                cx += w
            self.y = y0 - row_h

        header_row()
        for row in rows:
            broke = self.ensure(row_h)
            if broke:
                header_row()
            y0 = self.y
            cx = x
            for val, w in zip(row, col_widths):
                self.text(cx + 6, y0 - row_h + 6, fit(val, w - 10, size), size=size, color=text_color)
                cx += w
            self.hline(x, x + total_w, y0 - row_h, color=line_color, lw=0.6)
            self.y = y0 - row_h

    def build(self):
        """Serialize to PDF bytes: font objects, page/content objects, xref, trailer."""
        objs = [None]  # 1-indexed; objs[0] unused

        def alloc():
            objs.append(None)
            return len(objs) - 1

        def set_obj(num, body):
            objs[num] = body

        font_regular = alloc(); set_obj(font_regular, b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
        font_bold = alloc(); set_obj(font_bold, b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")
        pages_num = alloc()  # filled in once we know the Kids (Page objects reference it as Parent)

        page_nums = []
        for ops in self.pages:
            stream = ("\n".join(ops)).encode('latin-1', 'replace')
            cnum = alloc()
            set_obj(cnum, b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
            pnum = alloc()
            set_obj(pnum, (f"<< /Type /Page /Parent {pages_num} 0 R /MediaBox [0 0 {A4_W:.2f} {A4_H:.2f}] "
                            f"/Resources << /Font << /F1 {font_regular} 0 R /F2 {font_bold} 0 R >> >> "
                            f"/Contents {cnum} 0 R >>").encode('ascii'))
            page_nums.append(pnum)

        kids = " ".join(f"{n} 0 R" for n in page_nums)
        set_obj(pages_num, f"<< /Type /Pages /Kids [{kids}] /Count {len(page_nums)} >>".encode('ascii'))
        catalog_num = alloc()
        set_obj(catalog_num, f"<< /Type /Catalog /Pages {pages_num} 0 R >>".encode('ascii'))

        out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        offsets = [0] * len(objs)
        for i in range(1, len(objs)):
            offsets[i] = len(out)
            out += f"{i} 0 obj\n".encode('ascii')
            out += objs[i]
            out += b"\nendobj\n"
        xref_pos = len(out)
        out += f"xref\n0 {len(objs)}\n".encode('ascii')
        out += b"0000000000 65535 f \n"
        for i in range(1, len(objs)):
            out += f"{offsets[i]:010d} 00000 n \n".encode('ascii')
        out += (f"trailer\n<< /Size {len(objs)} /Root {catalog_num} 0 R >>\n"
                f"startxref\n{xref_pos}\n%%EOF").encode('ascii')
        return bytes(out)
