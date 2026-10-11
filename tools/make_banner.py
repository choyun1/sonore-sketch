"""Draw the README's banner: sonore's logo lines beside the wordmark "sonore-sketch".

It is sonore's own banner (sonore's docs/logo/make_logo.py) with the longer name, so the lines,
colours, font and placement come from that script, and the two stay alike when sonore's logo
changes. The wordmark is set in Spectral SemiBold (SIL Open Font License) as outlines, so the
files need no font. Run from the repository root with sonore's script and the font file:

    python tools/make_banner.py path/to/sonore/docs/logo/make_logo.py path/to/Spectral-SemiBold.ttf

(the font is at https://fonts.google.com/specimen/Spectral). It writes
docs/logo/sonore-sketch-banner-light.svg and -dark.svg. The page itself uses sonore's small mark,
copied as app/logo.svg.
"""

import importlib.util
import sys
from pathlib import Path

from fontTools.ttLib import TTFont

NAME = "sonore-sketch"
OUT = Path(__file__).resolve().parent.parent / "docs" / "logo"


def load(path):
    spec = importlib.util.spec_from_file_location("make_logo", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def banner(logo, font, theme):
    """sonore's banner() with NAME in place of "sonore"."""
    ink, accent = logo.COLORS[theme]
    size = 98
    baseline = logo.ROW + font["OS/2"].sxHeight / font["head"].unitsPerEm * size / 2
    word, right = logo.wordmark(font, NAME, size, 140, baseline, ink)
    left, top, bottom = -33, logo.ROW - 54, logo.ROW + 44
    view = f"{left} {top} {right - left + 6:.0f} {bottom - top}"
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view}" role="img" aria-label="{NAME}">'
        f"<title>{NAME}</title>{logo.lines(ink, accent)}{word}</svg>\n"
    )


if __name__ == "__main__":
    logo, font = load(sys.argv[1]), TTFont(sys.argv[2])
    OUT.mkdir(parents=True, exist_ok=True)
    for theme in logo.COLORS:
        (OUT / f"{NAME}-banner-{theme}.svg").write_text(banner(logo, font, theme))
