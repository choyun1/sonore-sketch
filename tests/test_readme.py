"""The README's Contents box, as in sonore's README (its tests/test_docs.py)."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _github_anchor(heading: str) -> str:
    return re.sub(r"[^\w\- ]", "", heading.strip().lower()).replace(" ", "-")


def test_readme_contents_matches_its_sections():
    """The Contents box links every top-level README section, in order, and
    every link lands on a real heading. Entries are numbered group.item, as in
    a wiki: groups count up from 1 and items restart at 1 in each group."""
    readme = (ROOT / "README.md").read_text()
    prose = re.sub(r"^```.*?^```", "", readme, flags=re.S | re.M)
    sections = re.findall(r"^## (.+)$", prose, flags=re.M)
    anchors = {_github_anchor(h) for h in re.findall(r"^#{1,6} (.+)$", prose, flags=re.M)}
    contents = prose.split("<b>Contents</b>", 1)[1].split("</small>", 1)[0]
    numbered = re.findall(r"(\d+)\.(\d+)&ensp;\[(.+?)\]\(#(.+?)\)", contents)
    assert numbered
    expected, group, item = [], 0, 0
    for g, *_ in numbered:
        group, item = (group, item + 1) if int(g) == group else (group + 1, 1)
        expected.append((group, item))
    assert [(int(g), int(i)) for g, i, _, _ in numbered] == expected
    for _, _, _, anchor in numbered:
        assert anchor in anchors, f"Contents links #{anchor}, which is not a README heading"
    assert [title for _, _, title, _ in numbered] == sections


def test_readme_images_exist():
    """Every local image the README shows is in the repository."""
    readme = (ROOT / "README.md").read_text()
    for path in re.findall(r'(?:src|srcset)="((?:docs|app)/[^"]+)"', readme):
        assert (ROOT / path).is_file(), path
