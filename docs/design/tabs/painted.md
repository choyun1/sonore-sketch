# The Painted tab, and the Paint primitive

The second tab of the app proposed in `../app.md`: paint level on a time ×
log-frequency plane with a brush, and hear a sound whose spectrotemporal
envelope is the painting. The brush, grid and canvas it is built on are the
**Paint** primitive (`../app.md`, "Drawing primitives"), which the Mask and
Edit tabs will reuse; this document designs both, and leaves what is
particular to Mask and Edit to their own documents.

On 2026-10-06 Cho renamed the tab "Paint spectrogram" on the page, and on
2026-10-13 "Draw spectrogram", so that every tab that adds is "Draw"; this document
keeps its earlier names.

Status: decided (2026-10-05). Cho accepted every recommendation except
P3's frequency range, which goes down to 100 Hz; the numbers below are
measured at that range. Built: step 1 of the order of work below, then steps 2
and 3 together, so the tab arrived audible.

This project is AI-assisted: the document and `tools/measure_paint_grid.py`
were drafted by Claude (Claude Code), for Cho to review.

## Why

Tracks lets you draw the parameters of a voice. Painted is one step up in
abstraction (`../app.md`, D7): you draw the spectrogram itself, the picture
people already read, and hear it. It is the most direct way to ask "what
does this shape sound like?": a glide, a gap in a band, a chord of noise
bands, a formant transition without a voice behind it.

## How the claims are verified

As in `tracks.md`, every number is tagged **[measure]** (printed by
`tools/measure_paint_grid.py`, which runs sonore 0.5.0 natively at 16 kHz on
a 4-core Linux cloud container, so it is not an independent check),
**[read]** (read from sonore's source, file named) or **[estimate]** (basis
given).

## What sonore provides

`so.ripple_sound(pattern, duration, fs, f_lo=250, f_hi=8000,
carrier="tones", ...)` already does the synthesis [read:
`sonore/sources/ripples.py`]:

- `pattern` may be any function `f(t, x)` of time [s] and octaves above
  `f_lo`, returning a non-negative envelope; a painted grid read between its
  cells is such a function. Nothing upstream is needed.
- The envelope multiplies each carrier component linearly (an amplitude, not
  dB), and the result is normalized to RMS 1, so only the painting's
  relative levels matter.
- Carriers: `"tones"` (log-spaced tones, 20 per octave by default),
  `"harmonic"` (harmonics of `f0`, so it sounds pitched), `"noise"`,
  `"low-noise"`, or a recording.
- `f_hi` must be below Nyquist, and a painting that is silent everywhere
  raises `ValueError("cannot normalize silence")` [measure: called with an
  all-zero pattern]. The tab must say "nothing painted yet" rather than
  show that as an error.

## Measurements

**P-M1. Speed is fine behind Play, and fast enough to play after each stroke
up to a few seconds.** [measure] A 72 × 256 grid with a dozen soft strokes,
16 kHz, 100–6400 Hz, first call (cold) and median of the next three (warm):

| Carrier | 1 s cold | 1 s warm | 3 s cold | 3 s warm | 10 s cold | 10 s warm |
|---|---|---|---|---|---|---|
| tones | 0.114 s | 0.069 s | 0.415 s | 0.210 s | 2.184 s | 1.003 s |
| harmonic | 0.038 s | 0.030 s | 0.152 s | 0.111 s | 0.966 s | 0.624 s |
| noise | 0.103 s | 0.094 s | 0.796 s | 0.423 s | 3.974 s | 2.481 s |

By the factor of 1.3–1.7 between native and Pyodide (`../app.md`, M2)
[estimate], 10 s on noise would take about 5–7 s in the browser, cold. D10's rule
already covers this: below about 3 s of sound, play when a stroke ends;
above it, play on Play with a progress note. Cho's local Pyodide run can
replace the estimate.

**P-M2. What you paint is what you get, in level.** [measure] A flat field at
0 dB with a hole one octave wide (400–800 Hz) and 0.4 s long; the hole's
level in the result, against the same band outside it:

| Carrier | painted −20 dB | painted −40 dB | painted silence |
|---|---|---|---|
| tones | −20.0 dB | −40.0 dB | −101.2 dB |
| harmonic | −20.0 dB | −40.0 dB | −126.7 dB |
| noise | −20.4 dB | −40.4 dB | −101.2 dB |

So a painted level can be shown and believed in dB, and "silence" really is
silent, with every carrier. The noise carrier comes out 0.4 dB deeper than
painted [measure; cause not investigated].

**P-M3. A painting fits in a link, but not a short one.** [measure] The grid
quantized to whole dB (one byte per cell, 60 levels), deflated and
base64url-encoded: 56 characters blank, 4758 for a dozen soft strokes, and
18 434 for the worst case (random cells). Browsers take links far longer
than that [estimate: Chrome's limit is 2 MB], but some chat apps cut long
links, so a big painting is better saved as a file (`../app.md`, D8).

## Proposed design

### Interface (sketch)

```
┌ Tracks │ Painted │ Mask │ Blobs │ Edit ─────────────────── ▶ ■  ⤓ ⟲ ┐
│ 6400 ┤░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│ Brush          │
│      │░░░░▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│  size  ●  ─○── │
│ 1600 ┤░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░│  soft  ─○──    │
│      │░░░░░░░░░░░░░░░░▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░│  level −12 dB  │
│  400 ┤░░░░░░░░░░░░░░░░░░░░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░│  ◉ paint ○ erase│
│  100 ┤                                            │ Sound          │
│      0 s                                    1.0 s │  carrier tones ▾│
├───────────────────────────────────────────────────┤  f0 (harmonic) │
│ result: waveform and spectrogram (the shell's)    │  100–6400 Hz   │
└───────────────────────────────────────────────────┴────────────────┘
```

- The canvas shows the painting in a gray or color scale of dB, on the
  same axes as the result spectrogram below it, so the two can be compared
  by eye. Frequency is logarithmic, labeled in Hz.
- Dragging paints; the brush's outline follows the pointer. Right-drag or
  the erase mode paints silence. Undo and redo take whole strokes, as
  Tracks does now.
- A stroke ends on pointer up, which commits it to history and (below the
  D10 threshold) plays it.

### The Paint primitive

- **Grid.** Rows are equal steps in octaves from `f_lo` to `f_hi`; columns
  are equal fractions of the duration, so changing the duration stretches
  the painting, as `../app.md` ("Duration") requires. Cells hold a level in
  dB from 0 down to a floor; at the floor a cell is silent.
- **Reading between cells.** Bilinear interpolation of the amplitude
  (`10^(dB/20)`, 0 at the floor), so the envelope is continuous and a
  column step does not click [inferred, not measured]. This happens in
  Python, in `pattern(t, x)`, the same function a notebook would use.
- **Brush.** A disc of a given radius (in cells) with a soft edge (a
  Gaussian falloff), that moves each cell toward the brush's level by the
  falloff's weight, once per pointer sample along the stroke, spaced by a
  fraction of the radius so a fast stroke is not dotted. Erase is the same
  brush at the floor. As built, the edge is a raised cosine, and a stroke
  keeps each cell's largest weight and moves the cell once when it ends,
  so going over a spot twice in one stroke does not darken it twice.
- **Canvas.** A `<canvas>` (not SVG: 18 432 cells), drawn as an image of
  the grid scaled to the plot, with SVG axes over it as in Tracks.
- The Mask and Edit tabs reuse all of this with a different meaning for a
  cell (a gain in dB on a recording's spectrogram or modulation spectrum)
  and a background picture under the painting.

### Data model

The page document gains a section per tab. Today a document is the Tracks
state with its duration and sampling rate; after this change:

```json
{
  "app": "sonore-sketch", "version": 2,
  "duration": 1.0, "fs": 16000, "tab": "painted",
  "tracks":  { "params": { ... } },
  "painted": {
    "f_lo": 100, "f_hi": 6400, "rows_per_octave": 12, "columns": 256,
    "floor_db": -60, "carrier": "tones", "f0": 100, "seed": 1,
    "levels": "<base64 of deflated bytes, one per cell: 0 = 0 dB ... 60 = floor>"
  }
}
```

A version-1 document (a Tracks link made before this change) opens as a
version-2 document with a default Painted section, so old links keep
working. Duration and sampling rate move up to the page, where
`../app.md` puts them.

### Python side

`src/sonore_sketch/painted.py` with `synthesize(state) -> so.Sound`, the
same contract as `tracks.py`, registered in `page.TABS`; it decodes the
grid, builds the bilinear `pattern(t, x)`, and calls `so.ripple_sound`.
Tests: the decoded grid round-trips, a hole comes out at its painted depth
(P-M2, as a test), a blank grid is reported as "nothing painted", and a
saved state gives the same samples in Python and from the page (as for
Tracks).

## Decisions

**P1. What is stored: the grid or the strokes.**
(a) the grid of levels (one byte per cell);
(b) the list of strokes (brush, level, points), replayed to make the grid.
*Recommended:* (a). The sound depends only on the grid, so the grid is the
honest record; it is what Python reads, it does not change if the brush
code changes, and undo is a list of grids. (b) would make links shorter
(a dozen strokes is roughly 1–2 kB [estimate: about 40 points of 3 numbers
per stroke]) but ties every saved painting to the brush's exact
arithmetic.

*Decided (2026-10-05):* (a).

**P2. Grid size.**
(a) a fixed 12 rows per octave (72 over 100–6400 Hz) by 256 columns,
stretched with the duration;
(b) columns per second (say 100), so a longer sound has more columns;
(c) a size the user picks.
*Recommended:* (a). It keeps a painting's look and size the same at any
duration, which is what stretching means. At 1 s a column is 3.9 ms; at
10 s it is 39 ms, coarse for a sharp onset but fine for painting by hand
[estimate]. Twelve rows per octave is a semitone, and resolves spectral
detail up to 6 cycles/octave, within the tone carrier's limit of 10
[read: `ripple_sound`, "Spectral modulation up to half this
(cycles/octave)"].

*Decided (2026-10-05):* (a).

**P3. Frequency range and floor.**
*Recommended:* 200–6400 Hz (exactly 5 octaves, below Nyquist at 16 kHz)
and a 60 dB range with the floor meaning silence, both as tab settings
with these defaults. P-M2 shows painted levels come out as painted across
that range. Changing the range resamples the grid rather than clearing it.
200 Hz was chosen because the harmonic carrier is coarse below it (with F0
at 100 Hz, harmonics 2 and 3 are 0.58 octave apart) [read].
*Decided (2026-10-05):* 100–6400 Hz (exactly 6 octaves, 72 rows), so
painting reaches lower; the 60 dB range as recommended. On the harmonic
carrier, fine detail painted at the bottom cannot come out: with F0 at
100 Hz the harmonics there are 1 and 0.58 octave apart [read].

**P4. Carriers offered.**
*Recommended:* tones (default), harmonic (with an F0 field) and noise.
Low-noise and a recording as carrier wait for the Mask tab, which brings
recordings in. Each carrier makes the same painting sound different in an
instructive way (`../app.md`, "Why").

*Decided (2026-10-05):* as recommended.

**P5. The brush.**
*Recommended:* size, softness, a level, and paint/erase, as in the sketch,
painting *toward* the level (so going over a stroke twice does not keep
getting louder). Not proposed for v1: shapes (rectangles, lines), a
smudge tool, copying a region, painting with the level under the pointer
rising with pressure. Each is easy to add once the grid exists.

*Decided (2026-10-05):* as recommended.

**P6. Links.**
*Recommended:* deflate only the grid, as in the data model above (the
browser's `CompressionStream("deflate")` writes the zlib format Python's
`zlib.decompress` reads), and leave the rest of the link as it is now.
P-M3: about 4.8 kB for a typical painting; the same grid as JSON numbers
would be about 70 kB of link [estimate: 18 432 numbers of 2–3 digits and a
comma, then base64]. A painting too big for a comfortable link is saved
as a file.

*Decided (2026-10-05):* as recommended.

**P7. Starting painting.**
(a) blank, with "paint something to hear it";
(b) a simple example (a glide and a noise band) so Play works at once.
*Recommended:* (b), as Tracks starts from a vowel, with Reset returning to
it and a "Clear" button for a blank canvas.

*Decided (2026-10-05):* (b).
*Changed (2026-10-11, Cho):* the glide and high band were too high-pitched;
the example is now a slow arpeggio of harmonic tones (A3, E4, A4, C#5, each
with six fading partials) on the harmonic carrier at 110 Hz, so every painted
partial is one of the carrier's. Later the same day Cho asked for something more
arbitrary in time and frequency: the example now spells "sonore" in block
letters (5 x 5 cells, 360 Hz to 3.6 kHz) on the harmonic carrier at 100 Hz. The blocks were loud
and sounded all at once (Cho), so it is now written by hand an octave lower
(about 180 Hz to 1.4 kHz): thin, soft, slanted strokes that sound as glides,
on the harmonic carrier at 50 Hz so that a harmonic is near every stroke. Draw speech's example became sonore saying
its name, with the tracks from sonore's formant-synthesis gallery page.

## Order of work

After the decisions, each a PR for Cho:

1. Page document version 2 (duration and fs at the page level, a section
   per tab), old links still opening. No visible change.
2. The Paint primitive: grid, brush, canvas, undo, with JavaScript tests,
   on a Painted tab that is drawn but silent.
3. `painted.py` and its tests, the tab's settings, playback, and the page
   check (`tools/check_page.py`) painting a stroke and hearing it.

## References

- sonore: `src/sonore/sources/ripples.py` (`ripple_sound`, `render`).
- `../app.md` (D7, D8, D10; "Duration"; "Drawing primitives"; M2).
- `tracks.md` (the Tracks tab, whose page structure this follows).
