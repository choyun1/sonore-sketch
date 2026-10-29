"""The picture of a recording while it is being made (docs/design/streaming.md, L6).

The page records from the microphone in blocks (Web Audio) and hands each
block to :class:`LiveSpectrogram`, which runs sonore's streamed STFT on it:
each block gives the time windows it completed, as columns of 8-bit levels
the page draws as they come. Joined, the columns are the STFT of the whole
recording, window for window (sonore's streams equal the batch analysis).
The levels are on a fixed scale, dB below a full-scale sine, since the
loudest moment of a recording is not known until it ends.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import sonore as so

# As the result's spectrogram (page.WINDOW_S): wideband, 5 ms Hann windows,
# here every 10 ms, which is 3000 columns for the page's longest 30 s.
WINDOW_S = 0.005
HOP_S = 0.01
F_MAX = 8000.0  # the page's sounds are made at 16 kHz
FLOOR_DB = -70.0  # below a full-scale sine


class LiveSpectrogram:
    """sonore's streamed STFT of a recording at ``fs``, block by block."""

    def __init__(self, fs: float):
        self.fs = float(fs)
        self.frame = so.GaborFrame(WINDOW_S, HOP_S)
        self.state = self.frame.start(self.fs)
        sine = np.sin(2 * np.pi * 1000.0 * np.arange(round(0.05 * self.fs)) / self.fs)
        self.reference = float(np.abs(self.frame.analyze(so.Sound(sine, self.fs)).data).max())
        self.windows = 0  # columns given so far

    def step(self, samples: Any) -> dict[str, Any] | None:
        """The columns this block (little-endian float32 samples, as bytes or,
        from the page's worker, a JavaScript Uint8Array) completed, or None."""
        if hasattr(samples, "to_bytes"):  # a Pyodide JsProxy
            samples = samples.to_bytes()
        block = so.Sound(np.frombuffer(samples, dtype="<f4").astype(float), self.fs)
        self.state, part = self.frame.step(self.state, block)
        return self._columns(part)

    def finish(self) -> dict[str, Any] | None:
        """The last columns, which needed the end of the recording."""
        return self._columns(self.frame.finish(self.state))

    def _columns(self, part: so.STFT) -> dict[str, Any] | None:
        n_windows = part.data.shape[-1]
        if n_windows == 0:
            return None
        rows = np.asarray(part.f) <= F_MAX
        magnitude = np.abs(part.data[0][rows])
        level = 20 * np.log10(np.maximum(magnitude, 1e-12) / self.reference)
        scaled = np.round(255 * (1 - np.clip(level, FLOOR_DB, 0) / FLOOR_DB))
        first = self.windows
        self.windows += n_windows
        return {
            "data": np.ascontiguousarray(scaled, dtype=np.uint8).tobytes(),
            "n_freqs": int(magnitude.shape[0]),
            "n_windows": int(n_windows),
            "first": first,
            "f_max": float(np.asarray(part.f)[rows][-1]),
            "t_step": HOP_S,
            "floor_db": FLOOR_DB,
        }
