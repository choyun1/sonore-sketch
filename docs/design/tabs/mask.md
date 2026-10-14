# The Filter recording tab: a mask painted on a recording's spectrogram

The third tab of the app (`../app.md`, D7; called "Mask" there): load a
recording, see its spectrogram, paint over parts of it to turn them down or
remove them (a band, a moment, one harmonic), and hear what is left. It
reuses the Paint primitive of `painted.md`, with a cell meaning a gain on the
recording rather than a level of a new sound, and it uses the recordings the
Edit modulation tab already opens (`edit.md`, E1, built in PR #33).

On 2026-10-06 Cho renamed the tab "Erase spectrogram" on the page; this document
keeps its first name, "Filter recording".

Status: decided 2026-10-06. Cho accepted every recommendation (F2 (b),
F4 (a), F5 (a)); F1, F3 and F6 were settled by the Edit modulation tab,
which built recordings in PR #33. Built in one PR.

This project is AI-assisted: the document and `tools/measure_mask.py` were
drafted by Claude (Claude Code), for Cho to review.

## Why

Erasing part of a spectrogram and hearing the result is the most direct
demonstration of what a spectrogram is, and of its limits: a short-time
Fourier transform cannot be edited freely, because neighboring
coefficients overlap, so the sound that comes back is the closest sound to
the edited picture, not the picture itself. Showing the result's own
spectrogram under the painting makes that visible, as `../app.md` asks
("drawn target vs what came out").

## How the claims are verified

As in `painted.md`: **[measure]** is printed by `tools/measure_mask.py`,
which runs sonore 0.5.0 natively at 16 kHz on a 4-core Linux cloud
container (not an independent check); **[read]** is read from sonore's
source or docstrings; **[estimate]** gives its basis.

## What sonore provides

- `so.GaborFrame(win_dur, hop_dur).analyze(sound)` gives an `STFT`, and
  `(stft * gains).to_sound()` the least-squares sound for masked
  coefficients [read: `STFT`'s docstring, "the least-squares signal for a
  modified one"]. `gains` may be a plain array of the coefficients' shape
  (frequencies × time windows) [measure: run in the script]. Nothing upstream is
  needed.
- `so.load(path)` reads audio files in Python, but in the browser the file
  is decoded by the browser (Web Audio's `decodeAudioData`), which reads
  WAV, MP3, OGG and, in most browsers, M4A, and the samples are sent to
  the worker [estimate: browser support, not tested here].

## Measurements

**F-M1. Speed is no concern.** [measure] Analysis, masking and
resynthesis of noise, hop a quarter window:

| Window | 1 s | 3 s | 10 s |
|---|---|---|---|
| 5 ms (wideband) | 0.041 s | 0.123 s | 0.418 s |
| 32 ms (narrowband) | 0.010 s | 0.023 s | 0.075 s |

(first call; the warm medians are within 10 %.)

**F-M2. Only a long window lets a painted cut come out as painted.**
[measure] A band of noise (1–2 kHz, 0.4 s) painted down; its level in the
result against the same band elsewhere:

| Window | painted −20 dB | painted −40 dB | removed |
|---|---|---|---|
| 5 ms | −18.6 dB | −30.0 dB | −32.0 dB |
| 32 ms | −19.6 dB | −39.6 dB | −89.8 dB |

With a 5 ms window, a removed band comes back at −32 dB: short windows
overlap so much in frequency that least squares refills the gap from its
edges. With 32 ms the cut is what was painted.

**F-M3. One harmonic can be taken out, partly.** [measure] The 10th
harmonic (1000 Hz) of a 100 Hz complex, removed over 970–1030 Hz for the
whole sound: −15.6 dB against its neighbors with a 32 ms window, −3.8 dB
with 5 ms. A 32 ms Hann window's main lobe is 125 Hz wide [read: 4 bins of
31.25 Hz], so a narrow cut leaves some of the harmonic; painting a wider
stroke removes more [inferred, not measured].

**F-M4. A mask fits easily in a link.** [measure] 256 × 256 cells
quantized to whole dB, deflated and base64-encoded: 112 characters with
nothing removed, 176 with a band and a harmonic removed. The recording
itself does not fit (F-M5).

**F-M5. A recording is too big for a link but fine in a saved file.**
[estimate] 10 s at 16 kHz as 16-bit samples is 320 000 bytes, about
427 000 characters as base64.

## Proposed design

### Interface (sketch)

```
┌ Speech │ Spectrogram │ Filter recording │ … ──────────── ▶ ■  ⤓ ⟲ ┐
│ Erase parts of a recording's spectrogram and hear what is left.     │
│ 8k ┤▓▓▒▒░░▓▓▒▒░░▓▓▒▒░░▓▓▒▒░░▓▓▒▒░░│ Source                  │
│    │▓▓▒▒░░▓▓▒▒████████▒▒░░▓▓▒▒░░▓▓│  [syllables ▾]          │
│ 4k ┤▓▓▒▒░░▓▓▒▒████████▒▒░░▓▓▒▒░░▓▓│  (Speech tab, hello.wav)│
│    │▒▒░░▓▓▒▒░░████████░░▓▓▒▒░░▓▓▒▒│  [Open audio file…]     │
│  0 ┤▓▓▒▒░░▓▓▒▒░░▓▓▒▒░░▓▓▒▒░░▓▓▒▒░░│ Brush                   │
│    0 s                       1.8 s│  ◉ Erase E ○ Restore R  │
├───────────────────────────────────┤  size, softness, Depth  │
│ result: waveform and spectrogram  │  [Clear]                │
└───────────────────────────────────┴─────────────────────────┘
```

- The recording's spectrogram (magma) fills the canvas; painted areas are
  shown darkened by the amount they are turned down, so the picture shows
  what should remain. The result's spectrogram below shows what did.
- Erase paints a cut down to its Depth (default −60 dB, removed);
  Restore paints 0 dB, and right-drag restores, as on Edit modulation.
  The brush, undo, Clear and the grid are the Paint primitive's.

### The grid

Rows are equal steps of frequency from 0 Hz to Nyquist (256 rows, 31.25 Hz
each at 16 kHz, the spacing of a 32 ms STFT's bins), columns equal
fractions of the duration (256), so the mask stretches with the duration
as a painting does. A cell is a gain in dB from 0 down to −60, where −60
means removed. Between cells the gain is read bilinearly, in amplitude, at
each STFT coefficient (as in `measure_mask.py`).

Changed 2026-10-06 (Cho, after the final check found erasures drifting):
a recording or the syllable train does not stretch with the duration, so
on those sources the erasures keep their seconds instead. A duration change
records in the section the time the columns cover (`span`); time past it
is not erased, and the next stroke puts the mask back on the duration's
columns. On the Speech sound, which does stretch, the mask stretches too.

### The recording

Built in PR #33 for Edit modulation, and reused unchanged: the page keeps
one `recording`, shared by the tabs that use one. The browser decodes the
file at the page's sampling rate, mixed to mono and cut to 30 s, and
opening it sets the page's duration to its length (the other tabs'
drawings stretch). It goes in saved files and never in links; a link whose
source was a file opens with a note asking for it again. Opening a file
on this tab makes it this tab's source; the Edit tab can then pick the same
recording from its Source list, and the other way round.

### Data model

```json
"mask": {
  "rows": 256, "columns": 256, "floor_db": -60, "window": 0.032,
  "source": "syllables" | "speech" | "file",
  "levels": "<base64 of deflated bytes, one per cell: 0 = 0 dB ... 60 = removed>"
}
```

and, at the page level of a saved file (never in a link):

```json
"recording": {"name": "hello.wav", "fs": 16000, "pcm16": "<base64 of 16-bit PCM>"}

(as now: the Edit tab's page-level recording).
```

### Python side

`src/sonore_sketch/mask.py`, `synthesize(state) -> so.Sound`, as the other
tabs: it takes the source from `sources.source` (the syllable train, the
Speech tab's sound or the recording), analyzes it with a `GaborFrame`, applies the
gains and resynthesizes. Tests: removing a band comes out at its painted
depth (F-M2, as a test); a blank mask gives back the source (an
unmodified STFT resynthesizes exactly [read: `STFT`'s docstring]); a
saved document gives the same samples in Python and from the page.

## Decisions

**F1, F3, F6. Recordings.** Settled by the Edit modulation tab (E1),
which took this document's recommendations and built them in PR #33: open
a file now, with the microphone and drag and drop in a later PR; keep a
recording in memory and in saved files, never in links; a recording sets
the page's duration to its length, up to 30 s.

**F2. The source before a file is opened.**
(a) the Speech tab's current sound, as first proposed;
(b) the Edit tab's three sources (syllable train, Speech tab, file) with
the syllable train as the default;
(c) (b) with the Speech tab as the default.
*Recommended:* (b). The Speech tab's default is a single 0.6 s vowel, so
there is little to erase on it; the syllable train has formants moving,
gaps and harmonics to take out, and the two recording tabs then work the
same way.

**F4. Frequency axis.**
(a) linear, 0 Hz to Nyquist, as the STFT the mask applies to;
(b) logarithmic, as the Spectrogram tab.
*Recommended:* (a). The mask acts on STFT bins, which are evenly spaced,
and harmonics are evenly spaced on it too, so taking out one harmonic is a
straight horizontal stroke. On a log axis the upper harmonics crowd
together.

**F5. The STFT's window.**
(a) 32 ms Hann, hop 8 ms;
(b) 5 ms;
(c) a choice between the two in the tab.
*Recommended:* (a). F-M2 and F-M3: with 5 ms a removed band comes back at
−32 dB and a removed harmonic at −3.8 dB, so the tab would not do what it
shows.

*As built:* the result's spectrogram is shown in the same 32 ms STFT as
the source's, on the same scale, rather than wideband (5 ms) as first
written here: at 5 ms an erased harmonic cannot be seen at all, so the
two pictures would not compare.

## Order of work

After the decisions, one PR for Cho, since recordings already exist: the
tab with its three sources, the grid, the background spectrogram, Erase
and Restore, `mask.py` and its tests, and the page check. The microphone
and drag and drop follow for both recording tabs together (F1).

## References

- sonore: `STFT` and `GaborFrame` (`src/sonore/frames/gabor.py`), `Mask`.
- `painted.md` (the Paint primitive), `../app.md` (D7, D8, D10).
- Griffin, D., & Lim, J. (1984). Signal estimation from modified short-time
  Fourier transform. *IEEE Transactions on Acoustics, Speech, and Signal
  Processing*, 32(2), 236–243. doi:10.1109/TASSP.1984.1164317. (The
  least-squares estimate from a modified STFT that `to_sound` computes.)
