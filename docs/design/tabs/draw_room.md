# The Draw a room tab

A proposed tab: draw how long a room rings at each frequency (its RT60
curve, from low to high) and hear a sound played in that room. The room's
impulse response comes from sonore's `synth_ir`, which follows Traer &
McDermott (2016): noise in cochlear bands, each band decaying at its own
rate, which listeners cannot tell from a real room's. The tab lets the
reader bend the curve away from a real room's and hear when the room
stops sounding real.

Status: built (see "As built" at the end). Cho asked for this tab on
2026-10-28 ("draw a voice and draw a room sound nice") and accepted every
recommendation (R1-R11) the same day. The sonore change in R2 was
released in sonore 0.9.0 the same day.

This project is AI-assisted: the document and `tools/measure_draw_room.py`
were drafted by Claude (Claude Code), for Cho to review.

## Why

Every other tab draws a sound, or where a sound is. This one draws the
space the sound is in. Traer & McDermott found that listeners hear
reverberation through a few statistics: the decay is exponential, and
mid frequencies ring longest while lows and highs die sooner. Change
those and the same sound is heard in a room that cannot exist. sonore's
`synth_ir` already has the paper's atypical rooms as named options
(`rt60_profile="inverted"` and others), but a drawn curve lets the reader
find the edge for themselves: flatten the curve, make the highs ring
longest, carve a notch at 1 kHz, and listen.

It also pairs with Draw path, whose room is a fixed living room (RT60
0.6 s). That tab is about where the sound is; this one is about where the
listener is.

## How the claims are verified

Every number is tagged **[measure]** (printed by
`tools/measure_draw_room.py`, which runs sonore 0.8.0 natively on one core,
as Pyodide has none to spare, on a 4-core Linux cloud container, one run
of best-of-3 timings; it is not an independent check), **[read]** (read
from sonore's source, named) or **[estimate]** (basis given). Nothing here
was timed in a browser.

## What sonore provides

- `so.synth_ir(rt60, fs, *, drr_db=None, n_channels=1, decay_shape=,
  rt60_profile=, drr_profile=, rng=)` [read: `sonore/spatial/reverb.py`].
  It splits Gaussian noise into 32 cosine bands (20 Hz to 16 kHz, capped at
  half the rate), multiplies each band by an exponential decay, and sums
  them. Each band's RT60 comes from `band_rt60s(rt60, freqs,
  profile=)`: the paper's regression on 271 rooms, scaled to the broadband
  `rt60` (the median over bands), or one of four named variants. Each
  band's starting level comes from the paper's fit for that `rt60` too.
  `drr_db` adds a direct impulse at that direct-to-reverberant ratio;
  `n_channels=2` gives two independent tails with one direct sound.
- `so.measure_rt60(ir)` measures an IR's RT60 in 30 bands from 50 Hz to
  8 kHz, by a line through each band's Schroeder decay from -5 to -25 dB.
- `Sound.convolve(ir)` applies the IR; a mono sound and a two-channel IR
  give two channels.

**What is missing.** `synth_ir` takes one number for the RT60 and one of
four named shapes for how it varies with frequency. There is no way to
hand it an RT60 for each band, which is what a drawn curve is. The pieces
it uses inside (`_decay_envelopes`, and `_model()`, which loads the
paper's fits from sonore's data folder) are private. So the tab cannot be
built on sonore 0.8 without either copying `synth_ir`'s synthesis into
sonore-sketch and reading sonore's private data, which is what the
2026-10-13 audit removed from the other tabs, or not drawing at all. R2 is
about that.

## Measurements

**V1. Making the IR is fast.** [measure] `synth_ir` at 16 kHz, one core:

| RT60 | IR length | mono | two channels |
|---|---|---|---|
| 0.3 s | 0.45 s | 0.02 s | 0.04 s |
| 0.6 s | 0.70 s | 0.02 s | 0.06 s |
| 1 s | 1.23 s | 0.06 s | 0.12 s |
| 2 s | 2.68 s | 0.11 s | 0.22 s |
| 4 s | 5.82 s | 0.23 s | 0.57 s |
| 8 s | 12.67 s | 0.80 s | 1.28 s |

The IR is as long as its slowest band takes to fall 60 dB, which is
longer than the broadband RT60 because the middle bands ring longest.

**V2. Applying it is faster still.** [measure] Convolving a two-channel IR
with a 2 s source takes 0.002 to 0.012 s; with a 30 s source, 0.025 to
0.04 s, whatever the RT60. With `measure_rt60` for the check plot (R9,
0.02 s at 0.6 s, 0.4 s at 8 s), the whole tab at RT60 1 s costs about
0.2 s natively, and at 8 s about 1.7 s. In the browser that is about
0.3 s and 2 to 3 s [estimate: by the factor of 1.3 to 1.7 in `../app.md`,
M2], plus making the source itself, as on every tab. No progress steps are
needed.

**V3. A drawn curve comes out as drawn, within about 5 % in most bands.**
[measure] The drawn curves below go through a prototype of R2's change in
the measuring script (`drawn_ir`: the drawing read off at each band by
interpolating in log frequency and log RT60). Each IR's decay was measured
back with `measure_rt60` (up to 7 kHz) and compared with the drawing, band
by band, over three seeds:

| curve | median error | worst band |
|---|---|---|
| flat 1 s | 4 % | 25 % |
| a real room, 1 s | 4 % | 25 % |
| inverted, 1 s | 4 % | 43 % |
| boomy (3 s low, 0.3 s high) | 6 % | 25 % |
| bright (0.4 s low, 2 s high) | 5 % | 62 % |
| a notch (1 s, 0.2 s at 1 kHz) | 7 % | 27 % |
| cathedral, 6 s | 2 % | 10 % |
| dead, 0.15 s | 11 % | 72 % |

The worst bands are below about 300 Hz, where the bands are wide enough
that a slow band rings into a fast neighbour (the bright room's 195 Hz band
measures 33 % long), and in very short rooms, where a 20 dB fall lasts only
a few hundredths of a second and the fit has little to go on. On the real-room
curve the prototype is sonore's own `synth_ir` (V4), and it misses by as
much, so this is the method, not the prototype. It is why R9 plots what was measured on
top of what was drawn.

**V4. The change leaves sonore's own rooms alone.** [measure] Given the
paper's real-room curve as a drawing, the prototype gives `synth_ir`'s
samples to within 4e-15 (identical at 1 s; the rest is rounding from
going through logarithms). R2's change keeps the scalar path as it is, so
every existing call stays bit-identical.

## Proposed design

### Layout (sketch)

    [ Source: (Syllable train v)           [ Open a file... ]           ]
    [ Start from: (A real room v)  RT60 [1.0] s     [ New draw ]         ]
    [ Direct to reverberant ---o--- 0 dB                                 ]
    [ RT60 (log, 0.1-10 s)                                               ]
    [   drawn curve, measured RT60 as dots                               ]
    [   ------------------------------------------ 50 Hz ... 8 kHz (log) ]
    [ The room's impulse response (spectrogram)  ][ Result spectrogram   ]

### The sound

The curve is stored as RT60s at 64 frequencies spaced evenly in log
frequency from 50 Hz to 8 kHz. `synth_ir` reads it off at its own 32 bands
(R2), with two channels (R7) and the chosen direct-to-reverberant ratio
(R6), from a seeded draw (R10). The source, at the page's duration, is
convolved with it and brought to one RMS, as on the other tabs. The
result keeps the room's tail (R8).

## Decisions

**R1. The tab's name.** The others are verb-first. Candidates: (a) Draw a
room; (b) Draw reverberation; (c) Draw an echo.
*Recommended:* (a). It is the name Cho used, it is plain, and it says
what is drawn without the word "reverberation". (c) is wrong: there are no
echoes, only a smooth decay.

*Decided (2026-10-28):* as recommended.

**R2. How a drawn curve reaches sonore.** (a) A change in sonore: the
`rt60` of `synth_ir` and `band_rt60s` also takes a pair `(freqs, rt60s)`,
read off at each band by linear interpolation in log frequency and log
RT60 and held flat past its ends. The broadband RT60 for the paper's
starting levels is the curve's median over the bands. With a pair,
`rt60_profile` must be left at "ecological" (anything else is refused, as
it would have nothing to reshape). A single number works exactly as now,
bit for bit (V4). This needs a sonore release (0.9) before the tab is
built. (b) sonore-sketch builds the IR itself from public pieces
(`cosine_filterbank`, `TemporalEnvelope`), copying `synth_ir`'s loop and
reading the paper's fits from sonore's data folder. (c) No drawing: an
RT60 number and sonore's four named profiles (real, inverted,
exaggerated, reduced), which works on sonore 0.8 today.
*Recommended:* (a). It is about 15 lines in `sonore/spatial/reverb.py`
plus tests (a pair giving the same samples as the number for the
ecological curve, a flat pair measuring flat, a refused profile), and it
is the kind of thing sonore's philosophy says belongs in sonore. (b) puts
synthesis code and private data back in sonore-sketch, which the
2026-10-13 audit took out. (c) is a different, smaller tab. The sonore
repository is not reachable from this session, so the sonore pull
request is a separate piece of work.

*Decided (2026-10-28):* as recommended.

**R3. How the curve is drawn.** (a) Freehand, as a track is drawn on Draw
speech: drag across, and each column takes the value under the pointer,
on a log-frequency axis from 50 Hz to 8 kHz and a log RT60 axis from
0.1 to 10 s; (b) eight points at the octave centres (63 Hz to 8 kHz)
dragged up and down, like an equalizer.
*Recommended:* (a). It is the page's way of drawing and makes notches and
bumps easy. Eight octave points would hide the fact that the curve can be
anything. 50 Hz to 8 kHz is what `measure_rt60` can check at 16 kHz; the
IR's bands below 50 Hz take the value at 50 Hz.

*Decided (2026-10-28):* as recommended.

**R4. Where the curve starts.** A "Start from" list redraws the curve: (a)
a real room (sonore's ecological profile), (b) flat, (c) inverted (a real
room upside down), with an RT60 box (the median, 0.1 to 10 s) that sets
the curve's overall length. The tab opens on a real room of 1 s.
*Recommended:* as stated. Starting on a real room and hearing it change
as you draw is the experiment; the inverted room is the paper's own
example of a room listeners hear as wrong. 1 s is a classroom or a small
hall, long enough to hear the shape at a glance. Changing the RT60 box
after drawing scales the drawn curve rather than replacing it.

*Decided (2026-10-28):* as recommended.

**R5. The source.** (a) Quilt a sound's list (the syllable train, rain,
the Draw speech tab's sound and the other drawn tabs' sounds, a file),
with "A clap" added at the top: one short click, so the room is heard
alone; (b) the same list without a clap.
*Recommended:* (a), starting on the syllable train. Speech is where
listeners know reverberation best, and its gaps let the tail be heard.
The clap answers "what does this room sound like" in one second.

*Decided (2026-10-28):* as recommended.

**R6. Direct sound.** A slider for the direct-to-reverberant ratio, from
-20 dB (far away) to +20 dB (close), default 0 dB, passed to `synth_ir`
as `drr_db`.
*Recommended:* as stated. 0 dB is `move_sound`'s default and leaves the
source clear while the room is plainly audible. The ratio is one number
for the whole IR, as in sonore; a drawn ratio by frequency would be a
second curve and a second sonore change, not worth it now.

*Decided (2026-10-28):* as recommended.

**R7. Channels.** (a) Two independent tails, one in each ear, with the
same direct sound (`n_channels=2`), played in stereo as Draw path's
result is; (b) mono.
*Recommended:* (a). In headphones the decorrelated tails sound like a
space around the listener; in mono the same room sounds narrower, as if
heard through a doorway. It costs 2x on the IR (V1), well under a second.

*Decided (2026-10-28):* as recommended.

**R8. The tail.** (a) The result runs on until the room has died away
(the page's duration plus the IR's length), as Draw path's result with a
room already does; (b) the result is cut to the page's duration, with a
short fade.
*Recommended:* (a). The tail is the point of the tab, and cutting it off
at the end of the source would hide the last word's decay, the part most
worth hearing. At RT60 10 s and a 30 s source the result is about 46 s.

*Decided (2026-10-28):* as recommended.

**R9. The plots.** The drawing, with the RT60 measured from the IR made
(`measure_rt60`) as dots over it; the IR's spectrogram, which shows each
frequency's decay as a slope; and the result's spectrogram beside it.
*Recommended:* as stated. The dots keep the tab honest where the method
cannot follow the drawing (V3, at low frequencies and in very short
rooms) instead of implying every wiggle is heard.

*Decided (2026-10-28):* as recommended.

**R10. New draw.** The IR's noise is seeded; "New draw" picks a random
seed (`app/seed.js`), as Scatter events, Quilt a sound and Match a
texture do. Different seeds give different rooms with the same curve,
which sound the same.
*Recommended:* as stated.

*Decided (2026-10-28):* as recommended.

**R11. What is saved.** `{"draw_room": 1, "sonore": "0.9.0", "duration",
"fs", "source", "rt60": [64 numbers, s], "drr_db": 0, "seed"}` plus the
source's own section (`draw_speech`, `recording` or `drawing`), as Quilt a
sound saves it. The 64 frequencies are fixed (R3), so only the RT60s are
saved.
*Recommended:* as stated.

*Decided (2026-10-28):* as recommended.

## As built

- `src/sonore_sketch/draw_room.py` and `app/draw_room/`, on sonore 0.9.0,
  whose `synth_ir` and `band_rt60s` take `rt60=(freqs, rt60s)` (R2). The
  tab sits after Draw path; its link is `#tab=draw-a-room`.
- "A real room" on the page is sonore's `band_rt60s` (ecological) for the
  RT60 asked for, scaled so the curve's median is that RT60 exactly, since
  sonore's own median comes within about 6% of it. The page holds the
  paper's fit at its 30 frequencies up to 8.6 kHz and reads it as sonore
  does; `tests/js/draw_room.test.mjs` checks it against sonore at 0.1 to
  10 s. "Inverted" is sonore's `max + min - real`, scaled the same way.
- The RT60 box is the median of the 64 points drawn (R4). Clear makes the
  curve flat at that median.
- The clap (R5) is one click 50 ms in, so the result is the room's impulse
  response itself (`tests/test_draw_room.py` checks it).
- The dots (R9) are `so.measure_rt60` of the room made, with the direct
  sound taken out first (the unit impulse `synth_ir` puts at the start); a
  note under the plots counts the bands within 20% of the curve.
- `tests/test_draw_room.py` checks that the room is sonore's from the
  curve, that the result keeps the whole tail in two independent channels,
  that a boomy curve measures boomy, and that the direct sound's level
  moves the share of the tail; `tests/test_fingerprints.py` pins a 1 s
  case.
- Not yet timed in the browser: V2's browser figures are still an
  estimate.

## Order of work

1. Cho answers R1-R11 (done, 2026-10-28).
2. R2 (a): the sonore pull request (`synth_ir` and `band_rt60s` take a
   pair, with tests and a CHANGELOG line) and a sonore release.
3. The tab: `src/sonore_sketch/draw_room.py`, `app/draw_room/`, the
   freehand curve, tests, an output fingerprint, the worker's file list,
   the README's tabs table, and sonore-sketch's sonore pin raised.
4. A screenshot and an example drawing, as for the other tabs.
5. Time it in the browser (Cho, locally), to replace the [estimate] in V2.

## References

- Traer, J., & McDermott, J. H. (2016). Statistics of natural
  reverberation enable perceptual separation of sound and space.
  *Proceedings of the National Academy of Sciences*, 113(48),
  E7856–E7865.
  [doi:10.1073/pnas.1612524113](https://doi.org/10.1073/pnas.1612524113)
