# The Edit modulation tab

The fifth and last tab of the app proposed in `../app.md` ("Edit a
modulation spectrum" in its table; the page labels it **Edit
modulation**): take a sound, show its modulation spectrum, paint a gain on
it, and hear the sound with that modulation removed. It reuses the
**Paint** primitive (`painted.md`) on the Modulation tab's plane
(`blobs.md`). Its internal tab id is `edit`.

On 2026-10-06 Cho renamed the tab "Erase modulation" on the page; this document
keeps its first name, "Edit modulation".

Status: decided (2026-10-06): Cho accepted E1–E9 as recommended, and the
tab is built (PR #33). E1 decides how a recording gets into the page for
both this tab and Filter recording (`mask.md`, built after it in PR #36).

This project is AI-assisted: the document and `tools/measure_edit.py` were
drafted by Claude (Claude Code), for Cho to review.

## Why

The Modulation tab builds a sound from modulation alone. This tab goes the
other way: it starts from a sound people know and takes modulation out.
Remove every rate above 4 Hz from speech and it blurs into a murmur that
keeps its syllable rhythm. Remove the downward sweeps and the formant
transitions change. It is the most direct way to hear which parts of a
modulation spectrum a sound depends on.

## How the claims are verified

As in the other tab documents, every number is tagged **[measure]**
(printed by `tools/measure_edit.py`, which runs sonore 0.5.0 natively at
16 kHz, 100–6400 Hz, on a 4-core Linux cloud container, so it is not an
independent check), **[read]** (read from sonore's source, file named) or
**[estimate]** (basis given).

There is no recording in the repository, so the measurements use a Klatt
"syllable train" made with the Speech tab's own Python. It has 4.5
syllables per second, formants moving from syllable to syllable, and F0
falling from 130 to 90 Hz. A real sentence will differ in the numbers,
but probably not in which way they point [estimate].

## What sonore provides

All in `sonore/views/modulation.py` [read]:

- `ModulationSpectrum.octave(sound, bands_per_octave=12, f_lo, f_hi)`: the
  analysis, on the same grid as the Modulation tab's blobs.
- `.with_gain(g)`: every cell's amplitude times `g(rate, density)`. The
  gain is averaged over each `(rate, density)`, `(-rate, -density)` pair,
  since a real envelope's spectrum is the same at both.
- `.to_sound(carrier=sound, iterations=n)`: on the sound's own fine
  structure and modulation phase. Without an edit this rebuilds the sound,
  so an edit keeps the sound's timing wherever the gain is 1. `iterations`
  searches for a sound whose own envelopes come closer to the edited
  spectrum (Griffin–Lim style), each costing one analysis and one
  synthesis. `carrier="tones"` or `"noise"` replaces the fine structure.
- When an edit would need envelopes below zero, sonore clips them and
  warns, naming the fraction clipped.

## Measurements

**E-M1. Speed: the sound's own fine structure is slower than tones, and
iterations multiply it.** [measure] Warm median of three:

| Case | 1 s | 3 s | 10 s |
|---|---|---|---|
| analysis (`octave`) | 0.27 s | 0.49 s | 1.19 s |
| gain, on the source, 0 iterations | 0.90 s | 1.74 s | 4.75 s |
| gain, on the source, 5 iterations | 4.16 s | 7.22 s | 19.1 s |
| gain, on tones, 0 iterations | 0.34 s | 0.75 s | 2.49 s |
| gain, on noise, 0 iterations | 0.65 s | 1.32 s | 3.31 s |

By the Pyodide factor of 1.3–1.7 (`../app.md`, M1) [estimate], 5
iterations take about 5–7 s at 1 s and 25–32 s at 10 s in the browser.

**E-M2. Doing nothing gives the sound back, closely.** [measure] At 3 s,
the unedited spectrum on the source's own fine structure correlates 0.982
with the source (the error is 14.4 dB below it).

**E-M3. On the source, an edit needs iterations to be heard fully.**
[measure] Removing every rate above 4 Hz (3 s), how much less power the
result has at 6–40 Hz and 0–4 cyc/oct than the source:

| Carrier | 0 iterations | 5 iterations | 20 iterations |
|---|---|---|---|
| the source | 2.5 dB | 11.6 dB | 14.7 dB |
| tones | 11.3 dB | 12.1 dB | |
| noise | 2.2 dB | | |

sonore's docstring reports the same pattern on a real sentence: about
15 dB on tones, 3–5 dB on the sentence's own fine structure, 16.5 dB
after 20 iterations [read].

**E-M4. A sweep direction can be removed.** [measure] Downward minus
upward sweep power at 2–16 Hz and 0.5–4 cyc/oct is +1.4 dB in the source.
After removing downward sweeps it is −4.2 dB on the source with 0
iterations, −14.5 dB with 5, and −10.7 dB on tones.

**E-M5. Boosting barely works; cutting does.** [measure] A gain of ×2
(+6 dB) at 2–8 Hz gives +1.4 dB there, and ×4 (+12 dB) gives +2.0 dB, with
36% and 46% of envelope values clipped. Cutting the static ripple
(|rate| < 1 Hz, density above 0.5) lowers it by 5.5 dB. Every hard-edged
edit above was clipped by sonore by 15–31%. Its warning is worth showing.

## Proposed design

### Interface (sketch)

```
 Speech │ Spectrogram │ Filter recording │ Modulation │ Edit modulation   ▶ ■ ⤓ ⟲
 Paint out parts of a sound's modulation spectrum and hear what is left.
┌───────────────────────────────────────────────────────┬────────────────┐
│ 6 ┤ source's modulation spectrum, magma              │ Source         │
│   │  ░░ painted cut: darkened, with an outline        │  syllables ▾   │
│ 0 ┤          ░░░░░░░░░       ┊┊       ░░░░░░░░░       │  Open file…    │
│   └──┬─────┬─────┬─────┬───┊0┊──┬─────┬─────┬─────┬── │ Brush          │
│    −64   −16    −4    −1   ┊ ┊  1     4    16    64 Hz│  size, softness│
├───────────────────────────────────────────────────────┤  cut −60 dB    │
│ what came out: the result's modulation spectrum       │  paint / erase │
├───────────────────────────────────────────────────────┤ Presets        │
│ the result's spectrogram (log frequency)              │  keep < [4] Hz │
├───────────────────────────────────────────────────────┤  no ↓ sweeps   │
│ result: waveform                                      │  no ↑ sweeps   │
└───────────────────────────────────────────────────────┴ Sound ─────────┘
                                                          carrier source ▾
                                                          iterations 5
```

- The plane is the Modulation tab's: signed log rate from 1 to 64 Hz on
  each side and density from 0 to 6 cyc/oct. It also has a narrow center
  strip for |rate| < 1 Hz, the static spectral shape, which can be edited
  too (E-M5).
- The painted gain is a Paint grid over that plane. It is shown by
  darkening the source's spectrum where it cuts, with an outline, so the
  source stays readable.
- Below the plane: what came out, the result's measured modulation
  spectrum, and the result's spectrogram on a log-frequency axis, as on
  the Modulation tab.

### Data model

A section in the version-2 page document:

```json
"edit": {
  "edit": 1, "source": "syllables", "carrier": "source", "iterations": 5,
  "seed": 1, "f_lo": 100, "f_hi": 6400, "bands_per_octave": 12,
  "columns": 193, "rows": 48, "floor_db": -60, "levels": "<base64 of deflated bytes>"
}
```

- **Columns:** 16 per octave on each side of the rate axis (96 per side)
  plus the center strip.
- **Rows:** 0 to 6 cyc/oct in steps of 0.125.
- **Cells:** one byte each, in dB of cut, as on the Spectrogram tab.
- **Reading the grid:** Python reads it bilinearly in dB at each analysis
  cell's (rate, density) and passes it to `with_gain`.
- **Link size:** a "keep below 4 Hz" mask is 88 characters of link, and
  six soft strokes are about 760 [measure: one-off, deflated as the
  Spectrogram tab does].
- **Recordings:** a recording itself never goes in a link (E1).

### Python side

`src/sonore_sketch/edit.py` with `synthesize(state)` (the recording comes
in the state, as `state["recording"]`),
registered in `page.TABS` and the worker's file list. It:

- makes or takes the source;
- analyzes it with `octave`;
- applies the gain with `with_gain`;
- synthesizes with `to_sound`;
- passes sonore's clipping warning back with the result, so the page can
  show it.

For the tab's own source (E1), it builds the syllable train with
`tracks.py`.

## Decisions

**E1. The source.**
(a) a Klatt syllable train made by the app, at the page's duration;
(b) the Speech tab's current sound;
(c) a recording opened from a file (and from the microphone later).
*Recommended:* all three, with (a) as the default. The Speech tab's
default is a single 0.6 s vowel, which has little modulation to edit, so
(a) makes the first Play worth hearing. It also needs no license and
follows the page's duration, so no other tab is stretched.

For recordings, this takes the parked Filter recording design's
recommendations, so the two tabs share them:
- open a file now, with the microphone in a later PR (F1);
- a recording is kept in memory and in saved files, never in links (F3);
- a recording sets the page's duration to its length, up to 30 s (F6; 10 s until 2026-10-14, app.md D10).

**E2. The plane.**
*Recommended:* the Modulation tab's axes (signed log rate 1–64 Hz, density
0–6 cyc/oct), plus a center strip for |rate| < 1 Hz. Edits made on
Modulation and here then read the same way.

**E3. Cut only, or cut and boost.**
(a) cut only, 0 to −60 dB, the floor meaning "removed";
(b) also boost, up to +12 dB.
*Recommended:* (a). E-M5: +12 dB painted gives +2 dB heard, with nearly
half the envelope values clipped, so a boost brush would not do what it
shows.

**E4. The mask grid.**
*Recommended:* 193 × 48 cells, as in the data model, stored as the
Spectrogram tab's grid is (P1, P6). A painted mask does not depend on the
source or the duration, so it can be kept while the source changes.

**E5. Carrier and iterations.**
*Recommended:* the source's own fine structure (default), tones or noise,
and iterations from 0 to 20, default 5. E-M3 shows 5 iterations are what
make an edit audible on the source (11.6 dB vs 2.5 dB without). They cost
time (E-M1), so long sounds play on Play, with a "working" note and a
Stop that gives up by restarting the worker (as in `blobs.md`, B4).

**E6. Tools.**
*Recommended:*
- the Spectrogram tab's brush (size, softness, cut level, paint and
  erase);
- three presets: "keep rates below N Hz" (N in a field, default 4),
  "remove downward sweeps" and "remove upward sweeps";
- Clear.

The presets are the classic demonstrations and the measured ones
(E-M3, E-M4); the brush handles anything else. A preset replaces the
mask, and Undo brings the old one back.

**E7. Pictures.**
*Recommended:*
- the source's modulation spectrum on the plane;
- below it, the result's measured modulation spectrum and its
  log-frequency spectrogram.

Measuring the result costs one analysis (0.3–1.2 s natively, E-M1) after
each sound is made. Seeing that an edit came out weaker than painted is
the lesson of E-M3.

**E8. Starting state.**
(a) no edit, so Play gives the source back;
(b) the "keep rates below 4 Hz" preset.
*Recommended:* (b), with Clear one click away. The first Play then
demonstrates the tab, as every other tab's starting drawing does.

**E9. Clipping.**
*Recommended:* when sonore clips envelopes, say so in a note under the
plane ("12% of the envelopes were clipped: the result differs from what is
painted") and in the log, not as an error. A soft brush edge clips less
[estimate: clipping comes from sharp gain edges].

## Order of work

After the decisions, each a PR for Cho:

1. Sources in the shell: the syllable train, the Speech tab's sound, and
   opening an audio file (decoded by the browser, kept in memory and in
   saved files). The Filter recording tab will use these too.
2. The Edit modulation tab: the plane with the source's spectrum, the Paint
   mask, presets, `edit.py` and its tests, playback, and the page check.
3. The measured result spectrum below the plane, and the clipping note.

All three steps were built in one PR (2026-10-06), since a source has
nothing to show it until the tab does and the measured result is small. As built: the recording is kept on the page
document as 16-bit samples in base64 (`recording`), and opened from the
tab's Source box rather than the shell's Open button, which stays for
saved drawings.

## References

- sonore: `src/sonore/views/modulation.py` (`octave`, `with_gain`,
  `to_sound`), and its design note
  `docs/design/views/modulation-targets.md` (C6, C7).
- `../app.md` ("Candidate tabs", "Drawing primitives", M1).
- `painted.md` (the Paint primitive), `blobs.md` (the plane),
  `mask.md` on PR #14 (recordings: F1, F3, F6).
