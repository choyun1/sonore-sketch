# The Draw a voice tab

A tenth tab: draw a voice's source and its filter separately, and hear them
put together. The source is what the larynx does: a pitch line over time
(where there is no line, there is no voicing) and how breathy the voice is.
The filter is what the vocal tract does: the spectral envelope, drawn as a
curve of level over frequency at a few moments and blended between them.
The sound comes from `so.source_filter_synthesize`, the harmonics-plus-noise
resynthesis sonore uses after its WORLD-style analysis (F0 track,
CheapTrick envelope, D4C aperiodicity).

Status: proposed. Cho asked for this tab on 2026-10-28, from the list of
ideas for new tabs offered with Match a texture. Nothing is built yet; the
decisions (S1-S11) are for Cho.

This project is AI-assisted: the document and `tools/measure_draw_voice.py`
were drafted by Claude (Claude Code), for Cho to review.

## Why

The source-filter theory of speech (Fant, 1960) says a voice is two things
that can be changed independently: a source that sets the pitch and the
buzz or hiss, and a filter that sets the vowel. Every textbook says so; this
tab lets the reader hear it. Raise the pitch line and the vowel stays the
same. Redraw the curve and the vowel changes while the pitch stays. Draw a
curve with no formant peaks at all and hear a voice that is not any vowel.

It differs from Draw speech, which draws the parameters of Klatt's (1980)
synthesizer: formant frequencies and bandwidths, each a resonance. Here the
filter is any curve at all, not a set of resonances, and the source has two
controls, not twenty. Draw speech is the phonetician's synthesizer; this is
the idea behind it.

`../app.md` listed "an F0 contour drawn over a recording and resynthesized
with WORLD" among its further ideas. S6 below covers that as a second step.

## How the claims are verified

Every number is tagged **[measure]** (printed by `tools/measure_draw_voice.py`,
which runs sonore 0.8.0 natively on one core, as Pyodide has none to spare,
on a 4-core Linux cloud container with Python 3.13, NumPy 2.5 and SciPy
1.18, one run each; it is not an independent check) or **[estimate]**. The
drawn voice it measures is the starting drawing proposed in S5: F0 from 130
down to 95 Hz with a rise in the middle, and the envelopes of /a/, /i/ and
/u/ (Peterson & Barney's male formants with Klatt's bandwidths, a -6 dB per
octave slope, held at 60 dB below the peak) at 10%, 50% and 90% of the
sound, with 0.1% of the power noise, at 16 kHz.

## What sonore provides

Everything the drawn tab needs is public in sonore 0.8, so it needs no new
sonore release.

- `so.source_filter_synthesize(f0, envelope, aperiodicity, duration=, rng=)`
  makes harmonics on the F0 track carrying `S (1 - a)` and shaped noise
  carrying `S a`, where `S` is the envelope's power and `a` the noise
  share, on the aperiodicity's grid (5 ms hop).
- `so.SpectralEnvelope(power, t, f, fs=)` is an envelope made by hand: it
  reads power linearly in time and in dB over frequency, held beyond its
  ends. So a drawn curve's points, at the moments drawn, *are* the
  envelope; nothing app-side interpolates them.
- `sonore.views.aperiodicity.Aperiodicity(ratio, t, fs, method)` is an
  aperiodicity made by hand, on the FFT grid. It also sets the synthesis
  grid, which a hand-made envelope with three moments could not.
- For S6: `so.f0_track`, `so.pitch_adaptive_envelope` (CheapTrick) and
  `so.band_aperiodicity` (D4C) measure all three from a sound, and
  `Aperiodicity.bands(..., envelope=)` averages the noise share into one
  number per time window.

Two things to know:

- With an aperiodicity given, the noise share is whatever it says, also
  where the F0 is 0. Where the drawn F0 has a gap, the tab must set the
  share to 1, as sonore does itself when there is no aperiodicity;
  otherwise the gap is nearly silent [measure: RMS 0.009 in a gap against
  0.19 voiced].
- The harmonics start in cosine phase, so each period is a sharp pulse,
  "peakier than a voice's" in sonore's words (S7).

## Measurements

**V1. Synthesis is about as fast as Klatt.** [measure] On one core, warm:
0.06 s for 0.6 s, 0.22 to 0.29 s for 2 s, 1.3 to 1.6 s for 10 s and 5.1 to
6.4 s for 30 s, much the same with a 512- or 1024-point grid for the noise
(cold calls within 15%). In the browser that is about 0.3 to 0.5 s for 2 s
and 7 to 11 s for 30 s [estimate: by the factor of 1.3 to 1.7 in
`../app.md`, M2]. Klatt does 3 s in 0.28 s natively (M2), so this is
the same order.

**V2. The sound has the drawn envelope.** [measure] Steady vowels at
130 Hz, 2 s, the spectrum of the result against the drawn curve after
removing the overall level, 100 Hz to 6 kHz:

| vowel | harmonics alone: median, max | noise alone: median, max |
|---|---|---|
| /a/ | 0.3, 1.1 dB | 0.3, 2.8 dB |
| /i/ | 0.3, 1.0 dB | 0.3, 2.9 dB |
| /u/ | 0.3, 1.0 dB | 0.3, 1.9 dB |

Above 6.5 kHz the harmonics fade out (sonore's `harmonic_complex` fades
from 0.9 of 7.2 kHz); the noise does not. A check the other way round does
not work: CheapTrick measuring the moving drawn voice gives back the curve
to a median of 1.3 dB but a 90th percentile of 29 dB, because a 60 dB
fall from /a/'s F2 leaks into CheapTrick's three-period window. So the tab
should not draw a measured envelope of its result as a check.

**V3. 48 points make a curve.** [measure] The syllable train's CheapTrick
envelope kept at N points, equally spaced on the ERB scale from 50 Hz to
8 kHz, and read back as sonore reads an envelope, against the full one
(1025 points), 100 Hz to 7 kHz, voiced time windows:

| points | median | 90th percentile | max |
|---|---|---|---|
| 16 | 1.84 | 6.31 | 18.9 dB |
| 24 | 1.22 | 4.20 | 13.3 dB |
| 32 | 0.57 | 2.56 | 13.8 dB |
| 48 | 0.26 | 1.45 | 7.0 dB |
| 64 | 0.16 | 0.95 | 7.3 dB |
| 96 | 0.07 | 0.41 | 3.9 dB |

48 points copy a measured envelope to within 1.5 dB nine times in ten,
and are few enough to see and drag on a phone.

**V4. Measuring a sound is slower than making one.** [measure] For S6.
On one core: the Draw speech tab's sound (0.6 s) takes 0.51 s for
`f0_track`, 0.04 s for CheapTrick and 0.06 s for D4C; the syllable train
(2 s) 1.17, 0.12 and 0.17 s. `f0_track` is most of it, about 0.6 s per
second of sound, so 30 s would take about 18 s natively and 25 to 30 s in
the browser [estimate: linear in duration, then M2's factor]. sonore's other
aperiodicity, `harmonic_aperiodicity`, took 6.4 s for 2 s and is not
proposed.

**V5. Copy synthesis keeps the pitch.** [measure] The syllable train
measured (F0, CheapTrick, D4C) and rebuilt by `source_filter_synthesize`:
the rebuilt sound's F0, tracked again, is voiced where the original was in
95% of time windows and within 0.2 cents (median; 6.2 cents nine times in
ten) of it.

## Proposed design

### Layout (sketch)

    [ Source                                                             ]
    [  Pitch     ~~~~~~~~~\___/~~~~~~~~\________      (log Hz, 50-500)    ]
    [  Breathy   ______________/‾‾‾‾\____________     (0-100% noise)      ]
    [  Filter    ▲ /a/          ▲ /i/          ▲ /u/  (moments: drag, add)]
    [ Filter at the chosen moment                                        ]
    [  dB  ^\_/\__/\___                     the other moments faint      ]
    [      +------------------------- frequency (ERB scale, 50 Hz-8 kHz)  ]
    [ Result spectrogram (shared)                                        ]

The two source lines share one time axis with the page's other tabs. The
moments of the filter are marks on that axis; choosing one shows its
curve below, which is drawn by dragging across it as Draw speech's tracks
are (the points under the pointer follow it).

### The sound

At the page's duration and rate, on a 5 ms grid with a 1024-point FFT:

- The F0 line, with 0 where it is erased, is the `f0` track.
- The breathiness line is the noise share `a`, the same at every frequency
  (S4), set to 1 wherever the F0 is 0; its square root is the
  aperiodicity's ratio.
- The curves are a `SpectralEnvelope` of their points' power at the
  moments' times, read by sonore linearly in time between moments and held
  before the first and after the last.
- The noise is seeded (S10). The result is brought to one RMS, as on the
  other tabs.

## Decisions

**S1. The tab's name.** (a) Draw a voice; (b) Draw source and filter;
(c) Draw a vowel.
*Recommended:* (a), Cho's own words, verb-first like the others. Its risk
is being confused with Draw speech; the README line and the tab's first
sentence say the difference (the filter is a curve, not resonances).

**S2. How the filter is drawn.** (a) Envelope curves (dB over frequency)
at moments placed on the time axis, blended between moments; the page
starts with three and the reader can add, move and remove them; (b) a
smooth envelope painted on time × frequency, as on Draw spectrogram;
(c) one curve for the whole sound.
*Recommended:* (a). A curve per moment is the filter as the theory draws
it, and blending between moments makes a diphthong or a word from a few
curves. (b) is Draw spectrogram again with the harmonics laid under it,
and (c) is (a) with one moment.

**S3. The curve's points and axes.** 48 points equally spaced on the ERB
scale from 50 Hz to 8 kHz (V3), on a dB axis 60 dB tall; a point dragged
below the axis sits at its floor.
*Recommended:* as stated. 32 points would do for drawn vowels, but 48
keeps a measured envelope (S6) to within 1.5 dB.

**S4. What the source has.** (a) A pitch line (50 to 500 Hz on a log axis,
erased stretches unvoiced) and a breathiness line (the share of noise,
0 to 100%, the same at every frequency); (b) as (a), with the noise share
rising with frequency as in a real voice, by a fixed rule; (c) as (a), plus
a voice quality (Fant's Rd, from pressed to lax), as a slope added to the
filter.
*Recommended:* (a). What is drawn is what is heard: "30% of the power is
noise" needs no rule to explain. (b) invents a rule sonore does not have.
(c) would mix the source into the filter, which is the thing the tab
separates; it can come later if wanted.

**S5. The starting drawing.** (a) /a/, /i/, /u/ at 10%, 50% and 90% of
the sound on a falling pitch with a rise in the middle, breathiness 0.1%
(the drawn voice measured above); (b) one /a/ on a flat 120 Hz;
(c) the Draw speech tab's word, measured (needs S6).
*Recommended:* (a). It moves, so the first sound already shows the filter
changing and the pitch changing separately.

**S6. Starting from a sound.** (a) Not offered; (b) a Source list (as on
Quilt a sound) and "Take the source": the sound's F0 and its power-weighted
noise share become the two lines, which can then be redrawn; (c) (b), and
"Copy the filter here": the sound's envelope at the chosen moment becomes
that moment's curve (48 points, V3); (d) the whole measured envelope every
5 ms, which a few curves cannot hold.
*Recommended:* (c), built after the drawn tab. It lets the reader put one
sound's source under another's filter, which is the theory's strongest
demonstration, and keeps one way of holding the filter. Measuring is slow
at long durations (V4: about 25 to 30 s in the browser for 30 s), so it
runs once per Take or Copy, with the page's progress label, not on every
stroke. (d) would need a second kind of filter on the page.

**S7. The buzz.** sonore starts every harmonic in cosine phase, so each
period is a single sharp pulse, buzzier than a voice. (a) Accept it, as
sonore's own resynthesis does; (b) a small sonore change: pass
`harmonic_complex`'s `phases=` through `source_filter_synthesize`
(presets include "random" and "schroeder-"), with a choice in the tab;
(c) the tab builds the harmonics itself.
*Recommended:* (a) for this tab, and (b) raised with sonore separately if
Cho wants it. (c) would copy sonore's level bookkeeping into sonore-sketch.

**S8. Duration.** The page's duration, up to 30 s (V1: about 7 to 11 s in
the browser at 30 s), without a slow note.
*Recommended:* as stated, one rule for every tab.

**S9. Where it goes.** (a) Right after Draw speech, its neighbour in
subject; (b) last, after Match a texture.
*Recommended:* (a). Tab id `draw_voice`, link `#tab=draw-a-voice`. Its
sound is not offered as a source to other tabs in this step.

**S10. The noise's seed.** (a) A fixed seed, saved, with no New draw
button; (b) a New draw button, as Scatter events has.
*Recommended:* (a). Only the breathy and unvoiced parts use the noise, and
a new draw of it is barely audible.

**S11. What is saved.** `{"draw_voice": 1, "sonore": "0.8.0", "duration",
"fs", "f0": [[times], [Hz, 0 unvoiced]], "breathiness": [[times],
[shares]], "filter": {"f": [48 Hz], "moments": [times], "db": [[48 per
moment]]}, "seed": 1}`, times in seconds, as Draw speech saves its tracks.
*Recommended:* as stated, with the frequencies saved, not implied, so a
later change to S3 still opens old files.

## Order of work

1. Cho answers S1-S11.
2. The drawn tab: `src/sonore_sketch/draw_voice.py`, `app/draw_voice/`,
   tests (unvoiced gaps are noise; the result's spectrum follows a steady
   drawn curve, as V2), an output fingerprint, the worker's file list,
   the README's tabs table, a screenshot and an example drawing.
3. If S6 is (b) or (c): the Source list, Take the source and Copy the
   filter here.
4. Time it in the browser (Cho, locally), to replace the [estimate]s in V1
   and V4.

## References

- Fant, G. (1960). *Acoustic Theory of Speech Production.* Mouton.
- Klatt, D. H. (1980). Software for a cascade/parallel formant
  synthesizer. *JASA*, 67(3), 971–995.
- Morise, M., Yokomori, F., & Ozawa, K. (2016). WORLD: a vocoder-based
  high-quality speech synthesis system for real-time applications.
  *IEICE Transactions on Information and Systems*, E99-D(7), 1877–1884.
- Peterson, G. E., & Barney, H. L. (1952). Control methods used in a study
  of the vowels. *JASA*, 24(2), 175–184.
