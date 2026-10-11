"""Draw the README's banner: sonore's logo lines beside the wordmark "sonore-sketch".

It is sonore's own banner (sonore's docs/logo/make_logo.py) with the longer name, so the lines,
colours, font and placement come from that script, and the two stay alike when sonore's logo
changes. The wordmark is set in Spectral SemiBold (SIL Open Font License) as outlines, so the
files need no font. The banner is two images side by side, the lines and the wordmark, so the README can link the
lines to sonore's gallery and the name to this app. Run from the repository root with sonore's
script and the font file:

    python tools/make_banner.py path/to/sonore/docs/logo/make_logo.py path/to/Spectral-SemiBold.ttf

(the font is at https://fonts.google.com/specimen/Spectral). It writes
docs/logo/sonore-sketch-lines-light.svg and -dark.svg, and docs/logo/sonore-sketch-name-light.svg
and -dark.svg, all the same height. The page itself uses sonore's small mark,
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


def svg(view, label, body):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view}" role="img" aria-label="{label}">'
        f"<title>{label}</title>{body}</svg>\n"
    )


def banner(logo, font, theme):
    """sonore's banner() with NAME in place of "sonore", cut in two between the lines and the
    name: the lines, and the name."""
    ink, accent = logo.COLORS[theme]
    size = 98
    baseline = logo.ROW + font["OS/2"].sxHeight / font["head"].unitsPerEm * size / 2
    start = 140
    word, right = logo.wordmark(font, NAME, size, start, baseline, ink)
    left, top, bottom = -33, logo.ROW - 54, logo.ROW + 44
    cut = start - 15  # past the lines' round ends, short of the name
    lines = svg(
        f"{left} {top} {cut - left} {bottom - top}", "sonore", logo.lines(ink, accent)
    )
    name = svg(f"{cut} {top} {right + 6 - cut:.0f} {bottom - top}", NAME, word)
    return lines, name


if __name__ == "__main__":
    logo, font = load(sys.argv[1]), TTFont(sys.argv[2])
    OUT.mkdir(parents=True, exist_ok=True)
    for theme in logo.COLORS:
        lines, name = banner(logo, font, theme)
        (OUT / f"{NAME}-lines-{theme}.svg").write_text(lines)
        (OUT / f"{NAME}-name-{theme}.svg").write_text(name)
