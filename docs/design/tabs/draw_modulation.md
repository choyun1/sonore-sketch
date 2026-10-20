# The Modulation tab, and the Blobs primitive

The fourth tab of the app proposed in `../app.md` ("Modulation blobs" in its
table; the page labels it **Modulation**): place Gaussian blobs on a
modulation spectrum (temporal rate × spectral density) and hear a sound
whose envelopes have that spectrum. The shapes, handles and dragging are the
**Blobs** primitive (`../app.md`, "Drawing primitives"); this document
designs both. Its internal tab id was `blobs`, as the Spectrogram tab's was
`painted` (both renamed on 2026-10-20: now `draw_modulation` and
`draw_spectrogram`).

On 2026-10-06 Cho renamed the tab "Draw modulation" on the page; this document
keeps its earlier names.

Status: decided (2026-10-05). Cho accepted every recommendation (B1–B9).
Built: all three steps of the order of work below (steps 1 and 2 together,
so the tab arrived audible; then the measured result and iterations). A
recording as carrier is not built: the page's recording (Edit modulation,
Filter recording) is a source to edit, not a carrier here.
Band-limiting the sound with drawn bands is designed in `bands.md`; the
measured result (B7) is built with it, under the plane.

This project is AI-assisted: the document and `tools/measure_draw_modulation.py` were
drafted by Claude (Claude Code), for Cho to review.

## Why

The Speech tab draws a voice's parameters and the Spectrogram tab draws the
spectrogram. A modulation spectrum is one step further from the waveform:
it says how fast the spectrogram's envelope changes in time (rate, Hz) and
across frequency (density, cycles/octave), and in which direction things
sweep. It is the view most people have never *heard*. A blob at 4 Hz and
0 cyc/oct is a syllable-rate flutter; move it to 1 cyc/oct and it becomes
ripples sweeping down; flip the rate's sign and they sweep up. Dragging a
blob and pressing Play is the quickest way to learn what the axes mean.

## How the claims are verified

As in `draw_spectrogram.md`, every number is tagged **[measure]** (printed by
`tools/measure_draw_modulation.py`, which runs sonore 0.5.0 natively at 16 kHz,
100–6400 Hz, on a 4-core Linux cloud container, so it is not an independent
check), **[read]** (read from sonore's source, file named) or
**[estimate]** (basis given).

## What sonore provides

All in `sonore/views/modulation.py` [read]:

- `ModulationBlob(rate, density, rate_width=0.5, density_width=0.25,
  level=0.0)`: a Gaussian bump. `rate_width` is a standard deviation in
  **octaves of rate**, `density_width` in cycles/octave, `level` the peak
  power in dB relative to the other blobs. Positive rate and density sweep
  down, a negative rate sweeps up. A rate of 0 is refused ("a blob needs a
  nonzero rate (its width is in octaves of rate)").
- `ModulationSpectrum.from_blobs(blobs, duration, f_lo=250, f_hi=8000,
  bands_per_octave=12, env_fs=1000, rms_depth=0.2)`: the target, on the
  grid `octave` would measure for that duration. Rates run ±500 Hz in steps
  of 1/duration; densities 0 to about 5.9 cyc/oct at 12 bands per octave.
  It takes 3 ms at 1 s and 26 ms at 10 s [measure: a one-off timing, not in
  the script].
- `.to_sound(carrier="tones"|"noise"|Sound, fs, rng, iterations=0)`: the
  sound, RMS 1. The carrier supplies the missing phases; `iterations`
  searches for a sound whose own envelopes come closer to the target, as
  Griffin & Lim do, at one analysis and one synthesis per iteration.
- `rms_depth` sets how deep the modulation is. A draw that would need
  envelopes below zero is refused with a message naming the largest depth
  that fits, e.g. "at most 0.342 fits it (or draw again with another rng)".
- `ModulationSpectrum.octave(sound, f_lo, f_hi)`: the analysis, for showing
  what came out.

## Measurements

**B-M1. Speed: fine behind Play without iterations; iterations are slow.**
[measure] Warm median of three, two blobs:

| Case | 1 s | 3 s | 10 s |
|---|---|---|---|
| tones, 0 iterations | 0.07 s | 0.24 s | 0.85 s |
| noise, 0 iterations | 0.41 s | 0.76 s | 2.07 s |
| tones, 5 iterations | 2.98 s | 5.47 s | 15.0 s |
| analysis of the result (`octave`) | 0.26 s | 0.48 s | 1.09 s |

By the Pyodide factor of 1.3–1.7 measured for Klatt (`../app.md`, M1)
[estimate], 10 s on noise plus its analysis would take about 4–5 s in the
browser, and 5 iterations at 10 s about 20–25 s. Iterations need a
"working" note and a way to give up on a long call (B4).

**B-M2. The energy lands where the blob is, at the grid's resolution.**
[measure] Peak of the result's measured spectrum near each blob, tones
carrier:

| Duration | Rate step | Blob (4 Hz, 0) | Blob (8 Hz, 1 cyc/oct) |
|---|---|---|---|
| 0.6 s | 1.67 Hz | 5.00 Hz, 0.00 | 10.00 Hz, 1.35 |
| 1 s | 1.00 Hz | 5.00 Hz, 0.00 | 6.00 Hz, 1.01 |
| 3 s | 0.33 Hz | 3.67 Hz, 0.00 | 6.33 Hz, 1.01 |
| 10 s | 0.10 Hz | 4.30 Hz, 0.00 | 7.90 Hz, 1.01 |

The peak of one random draw wanders within the blob's width (a
`rate_width` of 0.5 octave puts one standard deviation at 5.7–11.3 Hz for
an 8 Hz blob), so these are not errors. At 0.6 s (the page's default until
2026-10-14; it is now 2 s) the grid itself is coarse: there are only a few rate cells below 8 Hz (B8).

**B-M3. Depth: the default fits; much deeper does not.** [measure] At 3 s,
rng 1, the default `rms_depth` of 0.2 fits; the largest that fits is 0.342
for one blob and 0.252 for three. sonore's docstring gives about 0.28 for a
typical one-blob target [read].

**B-M4. How much of the drawing comes out depends on the carrier.**
[measure] At 3 s, the measured power in the cells the drawing puts within
6 dB of its peak, over the power in the cells it puts 30 dB or more below,
within |rate| ≤ 32 Hz and density ≤ 4 cyc/oct:

| Carrier | 0 iterations | 5 iterations |
|---|---|---|
| tones | 25.2 dB | 33.4 dB |
| noise | 14.6 dB | 21.7 dB |

Noise adds modulation of its own, as `to_sound`'s docstring says, so a
drawing is clearest on tones. That is worth showing, not hiding (B7).

## Proposed design

### Interface (sketch)

```
 Speech │ Spectrogram │ Filter recording │ Modulation │ Edit modulation   ▶ ■ ⤓ ⟲
 Place blobs on rate × density and hear sounds with that modulation.
┌───────────────────────────────────────────────────────┬────────────────┐
│ 6 ┤            ·                     ·                │ Blob           │
│   │                                                   │  rate   8 Hz   │
│ 4 ┤                                                   │  density 1.0   │
│   │                               ╭───╮               │  widths 0.5 oct│
│ 2 ┤                              ( ● ─┼─○ )           │         0.25   │
│   │                               ╰─○─╯               │  level −3 dB   │
│ 0 ┤          ( ● )         ┊         ( ● )            │  Delete        │
│   └──┬─────┬─────┬─────┬───┊───┬─────┬─────┬─────┬──  │ Sound          │
│    −64   −16    −4    −1   ┊   1     4    16    64 Hz │  carrier tones▾│
│      ← sweeps up           ┊         sweeps down →    │  depth 0.2     │
├───────────────────────────────────────────────────────┤  iterations 0  │
│ result: waveform, spectrogram, measured modulation    │  seed 1 New draw│
└───────────────────────────────────────────────────────┴────────────────┘
```

- The plane shows the drawn target (`level`, in dB) in magma, as the other
  tabs do, with each blob's outline (one standard deviation) and center on
  top. Rate is signed and logarithmic (B1); density is linear, 0–6 cyc/oct.
- Clicking empty space adds a blob there; dragging a center moves it;
  dragging the outline's handles changes the two widths; the side panel
  edits the selected blob's numbers and level; Delete or Backspace removes
  it. A drag that crosses the center seam flips the rate's sign. Undo and
  redo take whole gestures.
- Below, the shell's waveform and spectrogram, and the result's measured
  modulation spectrum on the same axes as the plane, so drawn and heard can
  be compared by eye (B7).

### The Blobs primitive

- **Shapes on a plane.** Each shape is a center, two widths and a level;
  it is drawn as an ellipse in screen space, with a center point and two
  width handles. Picking prefers handles, then the nearest center within a
  few pixels, then the inside of the smallest ellipse, so overlapping blobs
  stay reachable.
- **The picture.** The page computes the target's power itself, with
  sonore's formula (`ModulationBlob.power`, then `(p(r, d) + p(−r, −d)) / 2`
  as `from_blobs` does) [read], so the picture follows a drag at once
  instead of waiting for the worker. A test checks the page's picture
  against Python's `from_blobs(...).level` on the same grid.
- The Edit modulation tab will reuse the plane and its axes with the Paint
  primitive on it; blobs are particular to this tab.

### Data model

A section in the version-2 page document, as `painted` is:

```json
"draw_modulation": {
  "draw_modulation": 1, "f_lo": 100, "f_hi": 6400, "bands_per_octave": 12,
  "carrier": "tones", "iterations": 0, "rms_depth": 0.2, "seed": 1,
  "items": [
    {"rate": 4, "density": 0, "rate_width": 0.5, "density_width": 0.25, "level": 0},
    {"rate": 8, "density": 1, "rate_width": 0.5, "density_width": 0.25, "level": -3}
  ]
}
```

`"draw_modulation": 1` is the section's format number, as `"draw_spectrogram": 1` is. A few
numbers per blob keep links short. The duration is the page's; blobs do
not stretch with it (rate is in Hz), but the grid they are drawn on does.

### Python side

`src/sonore_sketch/draw_modulation.py` with `synthesize(state) -> so.Sound`,
registered in `page.TABS` and listed in `files.json`, the worker's module list. It
checks the state, builds the `ModulationBlob`s and calls `from_blobs` then
`to_sound`. The worker's answer gains the result's measured modulation
spectrum for this tab only. Tests: a blob's energy lands near it (B-M2, as
a test), the depth message is passed on (B4), no blobs is reported as
"add a blob to hear something", and a saved state gives the same samples in
Python and from the page.

## Decisions

**B1. The rate axis.**
(a) signed and logarithmic, 1 to 64 Hz on each side, upward sweeps on the
left;
(b) linear, −32 to 32 Hz, as sonore's modulation plots draw it.
*Recommended:* (a). A blob's rate width is in octaves, so on a log axis
every blob has the same width wherever it sits, and 1–4 Hz (syllables)
gets as much room as 16–64 Hz (roughness). Rate 0 cannot hold a blob
anyway. The seam at ±1 Hz is drawn as a thin gap. The measured result
below uses the same axis, so the two compare directly.

**B2. Editing blobs.**
*Recommended:* as in the sketch: click to add (default widths 0.5 octave
and 0.25 cyc/oct, level 0 dB), drag to move, handles for the widths, the
side panel for exact numbers and the level, Delete to remove, up to 8
blobs. Not proposed: rotated blobs (sonore's are axis-aligned), copying a
blob, snapping to a grid.

**B3. Carriers offered.**
*Recommended:* tones (default) and noise. A recording as carrier waits for
the Filter recording tab, which brings recordings in. B-M4 shows the
difference is worth hearing.

*Added (2026-10-05, Cho):* a harmonic carrier, a harmonic complex on F0
(default 100 Hz) whose fine structure in each band carries the drawn
envelopes, with the modulation phase drawn from the seed (`to_sound` with a
recording would take the phase from the steady complex itself). At 3 s, with
rate 0 left out (a harmonic complex has static spectral ripple of its own
there), the drawn blobs stand 21–24 dB above the rest on harmonics at
100–200 Hz, against 26 dB on tones and 15 dB on noise [measure: the B-M4
comparison, one-off]. Iterations are offered on it only with bands drawn
(`bands.md`, K-M5b). Under the plane, the
result's spectrogram (the shell's 5 ms STFT) is shown on a log-frequency
axis over 100–6400 Hz.

**B4. Iterations.**
(a) not offered;
(b) a field from 0 (default) to 10.
*Recommended:* (b), with a "working" note while it runs; `to_sound` reports
no progress, so the page cannot count iterations, and Stop gives up by
restarting the worker [read: `to_sound` takes no callback]. It is the one setting that makes the result match the
drawing better (B-M4: 25 → 33 dB on tones), but it multiplies the time by
about the number of iterations (B-M1).

**B5. Depth.**
(a) an `rms_depth` field, and sonore's message when a draw cannot reach
it, with a button that sets the depth it names;
(b) the field, and the depth lowered silently to what fits;
(c) no field: always 0.2.
*Recommended:* (a). The depth is what makes the modulation audible, and
B-M3 shows the limit moves with the drawing, so hiding it or changing it
silently would confuse.

As built, the button offers a little less than the depth sonore names
(0.005 less, rounded down to hundredths): sonore prints it rounded, and the
limit moves by a few thousandths with the depth asked for (the page check
saw 0.27 named at 0.95, then "at most 0.261" at 0.27). A new draw can
also stop a depth from fitting; the refusal then offers one again.

**B6. Seed.**
*Recommended:* a seed field and a "New draw" button that adds 1 to it, the
seed saved with the page so a link plays the same sound. The modulation
phase is random (sonore draws it), so different seeds are different sounds
with the same spectrum, which is itself a lesson.

**B7. Showing what came out.**
(a) the measured modulation spectrum of the result below the plane, on
the same axes, computed in the same worker call;
(b) not shown.
*Recommended:* (a), as `../app.md` asks for each tab's own view of the
result. It costs one analysis (B-M1: 0.3–1.1 s natively) after each Play.

**B8. Short durations.**
The page's default 0.6 s (2 s since 2026-10-14) gives a rate step of 1.67 Hz, coarse below 8 Hz
(B-M2).
(a) leave it, since the drawn picture is on the same grid and shows the
coarseness;
(b) (a), plus a one-line note on this tab when the duration is under 2 s,
suggesting a longer one;
(c) lengthen the page to 3 s on entering this tab.
*Recommended:* (b). (c) would stretch the other tabs' drawings without
being asked.

**B9. Starting drawing.**
*Recommended:* the two blobs measured above, (4 Hz, 0 cyc/oct, 0 dB) and
(8 Hz, 1 cyc/oct, −3 dB), so Play works at once; Reset returns to them and
Clear removes all blobs. The frequency range is 100–6400 Hz at 12 bands
per octave, as on the Spectrogram tab, and not a setting in v1.
*Changed (2026-10-06, Cho):* the tab starts from one blob near the origin
in the upper-right quadrant, (2 Hz, 0.5 cyc/oct, 0 dB); it fits the default
depth on every carrier and seed 1–3. The measurements here and in
`bands.md` keep B9's two blobs (`sonore_sketch.draw_modulation.B9_ITEMS`).

## Order of work

After the decisions, each a PR for Cho:

1. The Blobs primitive on a silent Modulation tab: the plane, its axes,
   adding, dragging, handles, undo, the picture from the page's own
   formula, with JavaScript tests and a test against `from_blobs`.
2. `blobs.py` and its tests, the side panel's sound settings, playback,
   the depth message, and the page check (`tools/check_page.py`) adding a
   blob and hearing it.
3. The measured modulation spectrum below the plane, and iterations with
   their progress note.

## References

- sonore: `src/sonore/views/modulation.py` (`ModulationBlob`,
  `ModulationSpectrum.from_blobs`, `to_sound`, `octave`), and its design
  note `docs/design/views/modulation-targets.md` (C2, C6, C7).
- `../app.md` ("Candidate tabs", "Drawing primitives", M1).
- `draw_spectrogram.md` (the Spectrogram tab, whose page structure this follows).
