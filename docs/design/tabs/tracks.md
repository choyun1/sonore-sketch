# The Tracks tab: drawing speech parameters (TrackDraw)

The Klatt tab of the app proposed in `../app.md`: draw formant, F0 and
amplitude tracks with a mouse, pen or finger, and hear the speech they
describe, as Track-Draw (Assmann et al., 1994) did. This document sets out
the original, what sonore already provides and what is missing, the checks
behind each number, a proposed interface and data model, and the decisions
for this tab.

On 2026-10-06 Cho renamed the tab "Draw speech" on the page; this document
keeps its earlier names.

Status: accepted with `../app.md` on 2026-10-05; steps 1 and 2 of the
order of work below are built, and from step 3 the bandwidth strips and the
time stretch (the duration). Noise sources, value scaling, copy synthesis
and sine-wave speech (the rest of step 3, steps 4 and 5) are not built. Written 2026-10-03 as the design for TrackDraw alone;
on 2026-10-04 Cho broadened the project to a general drawing front end for
sonore, so this became one tab of it. Platform, synthesis location,
repository, generality and pinning (D2, D3, D7, D8, D9 below) now belong
to the whole app and are decided in `../app.md`.

This project is AI-assisted: the document and the scripts in `tools/` were
drafted by Claude (Claude Code) from Cho's handoff brief, for Cho to review.

## Why

Cho's own words about the 2016 attempt: "the trick of course was dealing
with a graphical interface to specify formants." That is still the point.
In 1994 and in 2016 most of the code went into synthesis; sonore 0.4.0 now
has a Klatt (1980) synthesizer whose every parameter is a number or a
`(times, values)` pair, which is exactly what a drawn track is. What is left
is the part that was always hard: an interface where drawing a track is
quick, precise enough, and immediately audible.

TrackDraw is a separate distribution rather than a sonore module because
it meets `philosophy.md`'s test on two counts: it needs a user interface
(a web front end, or a GUI toolkit) that sonore should not depend on, and
it has a different audience (people who want to make and hear a stimulus,
not write code) and release cadence.

## How the claims are verified

Every number below is tagged:

- **[paper]**: read from Assmann, Ballard, Bornstein & Paschall (1994),
  quoted or paraphrased (the PDF is in the project files).
- **[check]**: printed by `tools/check_trackdraw_claims.py`, which uses only
  NumPy and SciPy and shares no code with sonore or TrackDraw.
- **[measure]**: printed by a script that runs sonore 0.4.0 to measure it
  (`tools/measure_sine_wave_route.py`, `tools/measure_pyodide_latency.py`);
  the docstrings say so.
- **[estimate]**: not measured; the basis is given.

Numbers come from Python 3.11.15, NumPy 2.4.6, SciPy 1.17.1 and sonore
0.4.0 on a 4-core Linux cloud container.

## The original (1994) in brief [paper]

Track-Draw was three MATLAB 4 programs sharing one synthesizer:

- **SYNTH**: tracks drawn with the mouse on an empty time-frequency grid:
  F1–F5 in the main window, and F0, AV and B1–B5 each in a window of its own.
  Two drawing modes: *point-draw* (left button) sets one time window;
  *line-draw* (right button held from one end to the other) sets every time window
  between two endpoints by linear interpolation; the middle button (or
  Escape) ends drawing. Time windows are 5 ms (`nmspf`, changeable). Buttons
  for track selection, synthesize, play, restart and exit. Synthesis shows a
  "schematic spectrogram" as it runs, then the waveform. A command-line mode
  scales or shifts tracks (formants scaled, F0 up an octave) and changes the
  duration, which stretches the tracks by cubic spline. Tracks are saved as
  MAT or ASCII files.
- **SPECSYNTH**: copy synthesis. The tracks are drawn over an FFT
  spectrogram of a recording; F0 starts from a sliding cepstral estimate and
  AV from a sliding RMS, and both can then be edited. Plays the original or
  the synthesis. With no input, a 200 ms neutral vowel.
- **SWSYNTH**: as SPECSYNTH, but sine-wave speech (Remez, Rubin, Pisoni &
  Carrell, 1981): one FM and AM sinusoid per formant, at the formant's
  frequency, with amplitude |S(F_k)|. A time window set below 30 Hz drops that
  tone, so a single glissando is possible.

Synthesis is a frequency-domain Klatt cascade for voiced speech only
(Equations 1–3): harmonics of F0 summed with amplitudes and phases from
S(f) = G(f) V(f) R(f); G a resonator at 0 Hz, 100 Hz wide; R lip radiation,
+6 dB per octave; V the cascade of F1–F5; then an antiresonance at 1.5 kHz,
6 kHz wide, described as a low-pass. Default sampling rate 8 kHz.

## Cho's 2016 attempt

`choyun1/TrackDraw` (the history of this repository, removed from its tree
on 2026-10-05; Adrian Y. Cho and Daniel R Guest, MIT
license, last commit July 2016) has about 1,000 lines of Python: PyQt5 and
matplotlib in a model/view/controller split, its own Klatt resonators, a
temporary sine-wave synthesizer (`controller/synth/sine.py`), and 40 fixed
points per track that are edited by clicking near a point and dragging. The
nearest of five formants at the clicked time is the one that moves
(`model.updateTrackClick`). Bandwidths, F0 and duration are sliders, not
tracks. What it shows: a fixed grid of points makes every edit local but
makes a smooth transition tedious, and choosing a track by proximity breaks
down where formants come close (F2 and F3 in /r/, F1 and F2 in /a/).

## What sonore provides, and what is missing

| Track-Draw piece | sonore 0.4.0 | Missing |
|---|---|---|
| Cascade synthesis from F0, AV, F1–F5, B1–B5 | `so.klatt_synthesize(duration, fs, params)`; every parameter a number or `(times, values)` pair, linear to every sample, held past the ends | Nothing; differences in C1 |
| Fricatives, aspiration, nasals | AH, AF, AB, A1–A6, FNP/BNP/FNZ/BNZ in the same call | Nothing (beyond the paper) |
| Duration change by spline | — | Scaling breakpoint times does it exactly (C3); app-side |
| Spectrogram for copy synthesis | `so.GaborFrame(win_dur, hop, n_fft)`; wideband 5 ms and narrowband 33.3 ms Hann, as on the Seeing speech page | Rendering to the page; app-side |
| F0 seed for copy synthesis | `so.f0_track` (and `so.Cepstrum`, the paper's method) | — |
| AV seed for copy synthesis | `Sound.rms` on the whole sound only | A sliding RMS in dB; a few lines app-side, or upstream if wanted (D6) |
| Sine-wave speech | `so.harmonic_complex(..., harmonics=[1])` gives the carrier exactly (M1) | Tone levels (M3), Nyquist fade (M2), the drop rule (M4): a small function, upstream (D6) |
| Formant tracking | none | Out of scope: copy synthesis is by tracing, as in the paper |
| Audio in and out | `so.load`, `Sound.save`, `Sound.play` | In a browser: Web Audio playback and file input; app-side |

## Claims and measurements

**C1. sonore's default voicing source is the paper's, minus a small
antiresonance.** [check] With `SS = 1`, sonore's voiced source is harmonics
with amplitudes |RGP(kF0)| followed by a first difference, which is the
paper's G(f) R(f): a slope of −5.2 dB per octave from 400 to 3200 Hz at
8 kHz (−5.4 from 400 to 6400 Hz at 16 kHz), against the nominal −12 + 6.
sonore leaves out the antiresonance (Klatt's RGZ, 1.5 kHz, 6 kHz wide).
Computed from Klatt's antiresonator formula (the exact inverse of his
resonator), it is not a low-pass: relative to 100 Hz it *raises* 1 kHz by
0.12 dB and 3 kHz by 1.0 dB at 8 kHz (0.36 and 3.2 dB at 16 kHz). The paper
calls it a low-pass; I could not tell from the paper whether its code
differed from Klatt's formula (inferred, not checked against the original
M-files, which are not available). Either way the difference from sonore is
at most about 3 dB below 3 kHz, so TrackDraw can use `SS = 1` and say so.

**C2. Bandwidths matter even in sine-wave speech.** [check] Each SWSYNTH
tone's amplitude is |S(F_k)|, which includes the formant's own peak gain.
At 16 kHz Klatt's resonator gains at their own frequency are 18.5 dB
(500 Hz, 60 Hz wide), 24.7 dB (1500, 90) and 25.2 dB (2500, 150). So the
B1–B5 tracks still set the relative tone levels, and a sine-wave mode should
compute levels from the full parameter set, not from formant frequencies
alone.

**C3. Breakpoints stretch exactly; splined time windows overshoot.** [check] A
line-drawn F2 transition (1200 Hz held, 40 ms up to 1700 Hz, held), sampled
in 5 ms time windows and stretched ×1.5 with a not-a-knot cubic spline (MATLAB's
`spline`; the paper does not say which spline), overshoots 1700 Hz and
undershoots 1200 Hz by 5.3 Hz each. Scaling the breakpoint times instead
gives the stretched line to 2e-13 Hz. A breakpoint track model (D4) makes
duration change exact and needs no spline.

**M1. `harmonic_complex(harmonics=[1])` is the sine-wave carrier, to
rounding.** [measure] On a drawn F2 track (800 → 1700 → 1100 Hz, five
breakpoints, 0.6 s at 16 kHz), it equals cos of the trapezoid-rule running
phase to 2.2e-16. The paper's Equation 3 is the rectangle rule; the two
phases differ by π (F − F_start) / fs at most, 0.18 rad here, a slowly
drifting offset with the same instantaneous frequency. This is not an
audible difference (inferred: a constant phase offset of one sinusoid does
not change what it sounds like; no listening test).

**M2. The carrier fades near Nyquist unless `f_max` is raised.** [measure]
`harmonic_complex` fades harmonics between 0.9 and 1.0 times `f_max`
(default 0.45 fs) to keep a moving F0 from aliasing. For a formant that
matters: at the paper's 8 kHz, a 3500 Hz F4 tone comes out 15.0 dB down; at
10 kHz a 4500 Hz tone is gone (−308 dB). With `f_max = fs / 2` neither is
faded. At 16 kHz, 3500 Hz is unaffected either way.

**M3. Tone levels are lost.** [measure] Every call is normalized to RMS 1,
so a tone asked for at amplitude 0.01 comes out at the same RMS as one at
1.0 (0 dB apart). A time-varying amplitude function `a(t, f)` survives as a
shape (the normalized result matches a(t) cos(phase) to 2.2e-16), but
summing one call per formant loses their relative levels. Sine-wave speech
therefore needs either one call returning all tones with their levels, or a
small function of its own (D6).

**M4. sonore drops a tone where the track is 0, not below 30 Hz, and a
single 0 reaches halfway to its neighbors.** [measure] A breakpoint at
0 Hz silences the tone (RMS 0 around it); one at 20 Hz still sounds (RMS
1.07), where the paper's rule would drop it. With voiced breakpoints 0.1 s
either side, a single 0 breakpoint silences 0.095 s: from halfway to each
neighbor, less the 5 ms ramps. For drawing, "no tone here" is better stored
as an explicit gap (two breakpoints bounding it) than as a value (D4).

**M5. Synthesis speed, native Python.** [measure] `so.klatt_synthesize` at
16 kHz, cold (first call) and warm (median of the next three), with F0, AV
and F1–F3 drawn as five-breakpoint tracks, and with every parameter
constant; then three sine-wave carriers:

| Case | 1 s cold | 1 s warm | 3 s cold | 3 s warm |
|---|---|---|---|---|
| Klatt, drawn tracks | 0.075 s | 0.077 s | 0.289 s | 0.298 s |
| Klatt, constant parameters | 0.055 s | 0.053 s | 0.199 s | 0.198 s |
| Three sine-wave tones | 0.004 s | 0.004 s | 0.011 s | 0.011 s |

Most of the time goes to the voiced source (70 to 80 harmonics below 7.2 kHz,
each with its amplitude function evaluated per sample), not to the
per-sample resonator loop: moving formants add only 0.02–0.10 s.

At 10 s, the app's longest duration (`../app.md`, D10), the same three
cases take 0.94, 0.65 and 0.04 s (warm, sonore's main branch at 451f99a;
`../app.md`, M2).

**M6. Synthesis speed in a browser.** [measure] Cho ran
`tools/measure_pyodide_latency.py` locally on 2026-10-03 (the cloud
container cannot reach the Pyodide CDN). Pyodide 314.0.7 (Python 3.14.2),
headless Chromium; the machine was not recorded, so these numbers are not
directly comparable with M5, which ran on the cloud container. Raw results:
`docs/design/measurements/pyodide-2026-10-03.json`.

| Page load | Load Pyodide | Install sonore | Import sonore | Total |
|---|---|---|---|---|
| Cold browser cache | 3.20 s | 8.60 s | 3.90 s | 15.7 s |
| Warm browser cache | 1.83 s | 2.59 s | 4.23 s | 8.6 s |

| Case | 1 s cold | 1 s warm | 3 s cold | 3 s warm |
|---|---|---|---|---|
| Klatt, drawn tracks | 0.13–0.22 s | 0.14–0.17 s | 0.37–0.46 s | 0.36–0.48 s |
| Klatt, constant parameters | 0.07–0.10 s | 0.10–0.15 s | 0.32–0.45 s | 0.26–0.35 s |
| Three sine-wave tones | 0.007–0.014 s | 0.006–0.015 s | 0.031–0.037 s | 0.021–0.025 s |

Each range spans the two page loads. Synthesis is fast enough: 1 s of
drawn speech takes under a quarter of a second, 3 s under half a second.
Loading is the cost. A warm reload still takes about 9 s, and about 4 s of
that is `import sonore` in both runs. It is probably the import of scipy and
matplotlib (inferred, not profiled). Both could be trimmed: the page needs
neither matplotlib nor most of scipy, so a lazy import in sonore would
help (a sonore question, D6).

What the decision needs from M6 [estimate, from interface practice, no
literature cited]: about 0.1 s from releasing a stroke to hearing sound
feels immediate, up to about 1 s is acceptable for a "synthesize" button,
and a first load of 10–20 s is tolerable once if the page says what it is
doing.

## Proposed design

### Interface (sketch)

```
┌──────────────────────────────────────────────────────────────┬──────────┐
│ kHz                                                          │ ▶ Play   │
│ 4 ┤    F4 ───────────────────────────────────────            │ ▶ Orig.  │
│ 3 ┤    F3 ────────╮__________╭──────────────────             │ Mode:    │
│ 2 ┤    F2 ──╮      ╲________╱                                │ ● Klatt  │
│ 1 ┤    F1 ──╯‾‾‾‾‾‾‾‾‾‾‾‾╲___________________                │ ○ Sine   │
│   ┼────────────────────────────────────────────── time       │ Tool:    │
│   (spectrogram of the synthesis or of a recording behind)    │ ◆ Point  │
├──────────────────────────────────────────────────────────────┤ ╱ Line   │
│ F0  ── 110 ──╮──── 125 ─────╲── 90   (Hz)                    │ ✎ Free   │
├──────────────────────────────────────────────────────────────┤ Track:   │
│ AV  ╱‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾╲ (dB)                       │ F2 ▾     │
├──────────────────────────────────────────────────────────────┤ Undo     │
│ B1–B5 (collapsed; open one at a time)                        │ Save/Open│
└──────────────────────────────────────────────────────────────┴──────────┘
```

One page, with the time axis shared by every panel, so F0, AV and the
bandwidths line up with the formants (the paper's separate windows did not).
The formant panel is the large one; the others are strips. A spectrogram
is drawn behind the formant panel: of the current synthesis in SYNTH mode
(the paper's "schematic spectrogram"), of the recording in copy-synthesis
mode.

Drawing (D10): the selected track is the one that is edited, so crossing
or close formants are never ambiguous; clicking a track's line or its label
selects it, which is the 2016 proximity rule used only for choosing, not
for editing.

- **Point**: press on the selected track to grab its nearest breakpoint, or
  add one, and drag it. A small tolerance in time snaps to an existing
  breakpoint.
- **Line**: press at one end, release at the other; the breakpoints between
  are replaced by the two ends. This is the paper's line-draw.
- **Freehand**: draw a stroke; it is simplified to the fewest breakpoints
  within a tolerance in Hz (Ramer–Douglas–Peucker), and those replace the
  breakpoints under it. This is the new piece: it makes a smooth transition
  one gesture.
- Every edit can be undone. Playback can start when a stroke ends: M6
  measures 0.1–0.2 s per second of speech.

Copy synthesis adds a file picker (or drag-and-drop), the spectrogram of the
recording, a seed F0 track from `so.f0_track`, a seed AV from a sliding RMS,
and "play original". Sine-wave mode changes only what Play synthesizes.

### Data model

A *document* holds a duration, a sampling rate, a mode (Klatt or sine-wave),
and a mapping from Klatt parameter names to either a number or a track. A
track is a list of breakpoints `(time, value)` sorted by time (D4), which is
exactly sonore's `(times, values)` pair. A gap in a formant (sine-wave mode)
or in voicing is two breakpoints at the edges of the gap with the value 0,
so it stays where it was drawn (M4). The duration is the page's setting, up to 10 s (`../app.md`, D10).
Operations: add or move a breakpoint,
replace a span (line and freehand), scale or shift values (the paper's
command line: F0 up an octave is ×2), and stretch time (scale every
breakpoint time and the duration, C3).

The document is plain data, and the Python half of TrackDraw is a small
module that turns a document into `so.klatt_synthesize(duration, fs,
params)` or the sine-wave function. The same module runs in the browser
under Pyodide and in a notebook, so a file drawn in the app is synthesized
identically in Python (D5).

### Architecture (if D2 and D3 go as recommended)

- A static page (HTML, CSS, JavaScript) for drawing and playback, on an SVG
  or canvas; Web Audio plays the samples. Hosted on GitHub Pages.
- Pyodide and sonore in a Web Worker, so the drawing never waits on
  synthesis; the worker receives a document and returns samples and a
  spectrogram image.
- `tracks.py` (document to parameters) shared by the worker and by Python
  users; tested with `python -m pytest` against sonore directly.

## Decisions

Each has options, a recommendation and the reason. The recommendations from
the sonore thread were starting points; where I change one, I say so.

**D1. Scope of v1.**
(a) all three programs; (b) SYNTH first, copy synthesis and sine-wave next;
(c) SYNTH and SPECSYNTH, sine-wave later. Separately, which parameters are
drawable: the paper's voiced set (F0, AV, F1–F5, B1–B5) or also sonore's
noise and nasal parameters.
*Recommended:* (a), all three, since sonore does the synthesis and the
three differ only in what is behind the canvas and what Play calls; but
ordered so SYNTH ships first (see Order). Drawable parameters: the paper's
voiced set in v1, with AH (aspiration) and AF (frication) as two more strips
behind a "show noise sources" toggle, and the rest (A1–A6, nasals, SS, RD)
editable as numbers, not tracks. The case for the paper's set only: fewer
panels and the original's scope. The case for more: sonore makes fricatives
nearly free, and /s/ or /h/ is the first thing users will try to draw.

**D2. Platform for the interface.** Moved to `../app.md` (D3 and D4); the measurements behind it stay above (M5, M6).

**D3. Where synthesis runs (in the browser).** Moved to `../app.md` (D4); the measurements behind it stay above (M5, M6).

**D4. Track model.**
(a) sparse breakpoints per parameter (sonore's `(times, values)`); (b) fixed
time windows every 5 ms, as in the paper and the 2016 code (40 points).
The case for (b): the paper's point-draw sets exactly one time window, edits are
always local, and Klatt's own tables are 5 ms time windows. For (a): what is drawn
is what is stored, files are small and readable, duration change is exact
(C3), and sonore takes it as-is.
*Recommended:* (a). Point adds or moves a breakpoint, line and freehand
replace a span. sonore interpolates linearly while the paper splined
time windows when stretching; with breakpoints there is nothing to spline. Gaps
are explicit pairs of zeros (M4).

**D5. File format.**
*Recommended:* JSON:
`{"trackdraw": 1, "sonore": "0.4.0", "duration": 0.8, "fs": 16000,
"mode": "klatt", "params": {"F1": [[0, 0.2, 0.8], [300, 650, 350]],
"B1": 60, ...}}`, with `[times, values]` or a number per parameter.
The test: `so.klatt_synthesize(duration, fs, params)` in Python reproduces
the app's samples exactly (same sonore version, same `rng` seed when noise
sources are on). Also export WAV, and import the paper's ASCII layout (one
column per track, 5 ms rows) as breakpoints, so old files and tables from
other programs come in.

**D6. What goes upstream into sonore.**
Each is a separate small sonore PR, discussed with Cho first:
(i) sine-wave speech, `so.sine_wave_speech(duration, fs, formants,
amplitudes=None)`: a sound made from parameters alone, so a plain function
by `philosophy.md`. M1 shows the phase is already right; it needs levels
kept across tones (M3), no fade below Nyquist (M2), and a stated drop rule
(M4). Default amplitudes |S(F_k)| from the Klatt parameters (C2).
(ii) A sliding RMS level in dB for the AV seed: small, and useful beyond
TrackDraw, but it could also stay app-side.
(iii) A faster `import sonore` under Pyodide. M6 measures about 4 s even
with a warm cache, probably because scipy and matplotlib load eagerly
(inferred). Deferring those imports until a function needs them would
shorten every page load.
*Recommended:* (i) upstream; (ii) app-side unless Cho wants it in sonore;
(iii) profile the import first, then decide.

**D7. Repository and name.** Moved to `../app.md` (D1).

**D8. Generality for later.** Moved to `../app.md` (D2).

**D9. Pinning sonore, and the link back.** Moved to `../app.md` (D5).

**D10. Drawing interaction.** (new; the hard part)
(a) the paper's point and line modes; (b) 2016's drag of fixed points, with
the track chosen by proximity; (c) the selected track only, with point,
line and freehand tools (above).
*Recommended:* (c). Selecting the track first removes the ambiguity where
formants meet, which 2016's proximity rule had; freehand is what a pen or a
finger does naturally; point and line keep the paper's precision. The
simplification tolerance (Hz) and the snapping tolerance (ms) are settings,
with defaults chosen by trying them (an estimate until then).

## Order of work

Within the app's order (`../app.md`), after the shell exists, each step a
PR for Cho:

1. The track model and `tracks.py` (D4, D5), with tests that a document
   synthesizes identically to a direct `so.klatt_synthesize` call.
2. SYNTH: the formant, F0 and AV panels, the three tools, play, save and
   open (D10).
3. Bandwidth strips, noise sources (D1), time stretch and value scaling.
4. Copy synthesis: load a recording, spectrogram, F0 and AV seeds, play the
   original.
5. Sine-wave speech: the sonore PR (D6), then the mode switch.

## References

- Assmann, P., Ballard, W., Bornstein, L., & Paschall, D. (1994).
  Track-Draw: A graphical interface for controlling the parameters of a
  speech synthesizer. *Behavior Research Methods, Instruments, & Computers*,
  26(4), 431–436. doi:10.3758/BF03204661.
- Klatt, D. H. (1980). Software for a cascade/parallel formant synthesizer.
  *JASA* 67(3), 971–995. doi:10.1121/1.383940.
- Klatt, D. H. (1982). Harsyn: An additive harmonic synthesizer. MIT RLE
  Speech Communication Group Working Papers, 47–60 (cited by Assmann et al.
  for the frequency-domain method; not read).
- Remez, R. E., Rubin, P. E., Pisoni, D. B., & Carrell, T. D. (1981). Speech
  perception without traditional speech cues. *Science*, 212, 947–950.
- Douglas, D. H., & Peucker, T. K. (1973). Algorithms for the reduction of
  the number of points required to represent a digitized line or its
  caricature. *The Canadian Cartographer*, 10(2), 112–122 (the freehand
  simplification; cited from memory, not checked).
- sonore 0.4.0: `docs/design/philosophy.md`, `docs/design/sources/klatt.md`,
  `src/sonore/sources/klatt.py`, `src/sonore/sources/waveforms.py`.
