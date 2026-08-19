"""
render_pdf.py — turn a plain-text filing into a PDF the uploader will accept.

The product only accepts .pdf (backend/routes/documents.js rejects anything else), and
that constraint is deliberate rather than incidental: a real user of this system uploads
PDFs, so rendering the letters to PDF keeps docling on exactly the path it would take in
production. EDGAR serves these filings as HTML or text, so a conversion step is
unavoidable either way.

Layout is deliberately plain — one column, generous margins, no headers or footers.
Anything decorative would only become noise for docling to strip back out.

Unicode: fpdf2's built-in fonts are latin-1 only, and SEC letters routinely carry curly
quotes, em dashes and section symbols. A TrueType font is registered when one can be
found so the text survives intact; failing that the text is transliterated to ASCII,
which is lossy but never raises mid-corpus.

Used as a library by fetch_corresp.py. Run directly for a smoke test:
  .venv/Scripts/python.exe experiments/05-corresp/render_pdf.py
"""

from pathlib import Path

from fpdf import FPDF

# Windows ships these; the first that exists is registered as a Unicode TrueType font.
_FONT_CANDIDATES = [
    Path("C:/Windows/Fonts/arial.ttf"),
    Path("C:/Windows/Fonts/segoeui.ttf"),
    Path("C:/Windows/Fonts/calibri.ttf"),
]


def _pick_font() -> Path | None:
    return next((p for p in _FONT_CANDIDATES if p.exists()), None)


def _to_ascii(text: str) -> str:
    """Last-resort fallback when no TrueType font is available."""
    try:
        from unidecode import unidecode          # installed as an edgartools dependency
        return unidecode(text)
    except ModuleNotFoundError:
        return text.encode("ascii", "replace").decode("ascii")


def render(text: str, out_path: Path, title: str = "") -> Path:
    """Write `text` to `out_path` as a single-column PDF. Returns the path written."""
    out_path.parent.mkdir(parents=True, exist_ok=True)

    pdf = FPDF(format="letter", unit="mm")
    pdf.set_auto_page_break(auto=True, margin=18)
    pdf.set_margins(left=18, top=18, right=18)
    pdf.add_page()

    font_path = _pick_font()
    if font_path is not None:
        pdf.add_font("body", "", str(font_path))
        pdf.set_font("body", size=10)
        body = text
    else:
        pdf.set_font("Helvetica", size=10)
        body = _to_ascii(text)

    if title:
        pdf.set_font_size(13)
        pdf.multi_cell(w=0, h=7, text=title[:200])
        pdf.ln(3)
        pdf.set_font_size(10)

    # Very long unbroken tokens (URLs, accession numbers, table runs) would otherwise
    # overflow the line box and raise; wrap them hard rather than lose the document.
    safe = "\n".join(
        line if max((len(t) for t in line.split()), default=0) < 60
        else " ".join(t if len(t) < 60 else " ".join(t[i:i + 60] for i in range(0, len(t), 60))
                      for t in line.split())
        for line in body.splitlines()
    )

    pdf.multi_cell(w=0, h=5, text=safe)
    pdf.output(str(out_path))
    return out_path


if __name__ == "__main__":
    here = Path(__file__).resolve().parent
    sample = (
        "SMOKE TEST\n\n"
        "Comment 1: Please explain how segment assets were allocated under Note 4 — "
        "including the “stranded” corporate overhead treatment.\n\n"
        "Response: The Company allocates segment assets on a direct-attribution basis…\n"
        + ("Filler line to exercise page breaks. " * 40 + "\n") * 12
    )
    out = render(sample, here / "raw" / "_smoke.pdf", title="render_pdf smoke test")
    print(f"font: {_pick_font() or 'built-in Helvetica (ASCII fallback)'}")
    print(f"wrote {out}  ({out.stat().st_size:,} bytes)")
