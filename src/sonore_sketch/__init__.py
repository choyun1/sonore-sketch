"""sonore-sketch: draw on a picture of sound and hear the result.

Each tab of the page is one of sonore's routes back to sound. This package is
the Python half: one function per tab that turns the tab's state into a
``sonore.Sound``, run by the page under Pyodide and usable in a notebook, so a
saved drawing gives the same sound in both.
"""

from . import (
    draw_modulation, draw_path, draw_room, draw_spectrogram, draw_speech, draw_voice, erase_modulation, erase_spectrogram, match_texture, page, quilt_sound,
    scatter_events,
)

__version__ = "0.1.0.dev0"
__all__ = [
    "draw_modulation", "draw_path", "draw_room", "draw_spectrogram", "draw_speech", "draw_voice", "erase_modulation", "erase_spectrogram", "match_texture",
    "page", "quilt_sound", "scatter_events",
]
