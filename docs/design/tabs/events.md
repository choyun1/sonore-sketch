# The Scatter events tab

A sixth tab: one short event copied at random times, with a drawn rate and
sliders for how regular the timing is and how much each copy's level and
pitch vary. At a low rate the events stand apart; at a high one they pile up
into a texture. The tab plays the sound and plots the statistics that change
as they pile up. The sound comes from sonore's `so.event_train`, and the tab
follows the "From single events to a texture" section of sonore's
[Sound textures](https://choyun1.github.io/sonore/gallery/textures.html)
gallery page, with the reader moving the knobs. Its internal tab id is
`events`; its name on the page is **Scatter events** (E1).

Status: built (see "As built" and "Changes after the first build" at the end). Cho answered four questions
on 2026-10-14: add lowpass-filtered impacts such as claps to the events
(E2), build the rate sweep in as a drawn track (E3), the name (E1) and the
README tagline (E9); the rest was built as recommended, except E5 (see
"As built").

This project is AI-assisted: the document and `tools/measure_events.py` were
drafted by Claude (Claude Code), for Cho to review.

## Why

The other tabs draw a picture of a sound. This one has no picture to draw
beyond the rate: its point is what a few distributions do to a sound. A
texture is "many similar events", and the clearest way to hear that is to
start from one event and add more until single events disappear. The rate,
the regularity of the timing, and the spread of levels and pitches each
change the sound in a different way, and each changes a different statistic.
Sliders are the quickest way to hear which.

## How the claims are verified

Every number is tagged **[measure]** (printed by `tools/measure_events.py`,
which runs sonore natively at 16 kHz, 5 s renders, one run each, on a 4-core
Linux cloud container; it is not an independent check) or **[estimate]**.

## What sonore provides

`so.event_train(event, duration, intervals, *, rate_scale, level_db,
pitch_cents, lead, rng)` copies `event` at onsets whose intervals are drawn
from `intervals` (a number or a SciPy distribution), on a clock that
`rate_scale` (a number or a `(times, values)` track) speeds up or slows down.
Each copy's level (dB) and pitch shift (cents) are drawn from `level_db` and
`pitch_cents`. A higher copy is also shorter, as a tape played fast is.
The statistics come from sonore's texture model (`TextureStats.measure`, in
`sonore.texture`), the same ones the gallery plots.

**Speed depends on the sonore release.** In sonore 0.6, a pitch spread makes
renders slow, because each distinct pitch shift gets its own resampling
filter. sonore PR #195 (decided by Cho on 2026-10-14, option B1 of sonore's
`docs/design/sources/event-train-speed.md`) reads the event with a shared
windowed sinc instead. [measure] 5 s renders of the chirp:

| settings | sonore 0.6 | with PR #195 |
|---|---|---|
| 30/s, nothing spread | 0.01 s | 0.01 s |
| 300/s, level 6 dB, pitch 100 cents | 6.6 s | 0.16 s |
| 1000/s, level 12 dB, pitch 300 cents | 21.6 s | 0.46 s |
| 100/s, pitch 300 cents, rising track | 11.0 s | 0.24 s |

So the tab waits for the sonore release that carries PR #195, then raises
this project's pin to it (E10).

## Measurements

**V1. Every setting renders fast enough to follow the sliders.** [measure]
With PR #195, render plus statistics for 5 s, by event:

| settings | chirp | tone pip | noise burst | impact |
|---|---|---|---|---|
| 30/s, nothing spread | 0.01 + 0.48 s | 0.01 + 0.31 s | 0.01 + 0.26 s | 0.01 + 0.25 s |
| 1000/s, nearly regular | 0.01 + 0.27 s | 0.01 + 0.24 s | 0.01 + 0.26 s | 0.01 + 0.29 s |
| 300/s, 6 dB, 100 cents | 0.16 + 0.33 s | 0.18 + 0.31 s | 0.16 + 0.25 s | 0.27 + 0.27 s |
| 1000/s, 12 dB, 300 cents | 0.46 + 0.44 s | 0.50 + 0.31 s | 0.53 + 0.25 s | 0.75 + 0.60 s |
| 100/s, 300 cents, rising track | 0.24 + 0.29 s | 0.27 + 0.28 s | 0.26 + 0.28 s | 0.41 + 0.57 s |

The slowest is about 1.4 s natively, so about 2 to 2.4 s in the browser
[estimate: by the factor of 1.3 to 1.7 in `../app.md`, M2]. That is fine on
releasing a slider, not while dragging one (E6).

**V2. The sparsity-against-rate curve costs about 2 s per event.**
[measure] Seven renders (1 to 1000 per second) and their statistics:
1.95 to 2.43 s, depending on the event. It is computed once per event and
kept (E7).

**V3. The impact's cutoff sets its color; its decay is set directly.**
[measure] Spectral centroid of the impact (white noise under an exponential
decay, then a 4th-order causal Butterworth lowpass so the onset stays
sharp): about 270 to 320 Hz at a 500 Hz cutoff, 900 to 1000 Hz at 2 kHz,
and 2400 to 2900 Hz at 6 kHz, for decay time constants of 2 to 30 ms.

## Proposed design

### Layout (sketch)

    [ Event: (chirp) (tone pip) (noise burst) (impact)   event knobs ... ]
    [ Rate track: events per second over 5 s, log axis 1 to 1000        ]
    [ Regularity ---o---   Level spread ---o---   Pitch spread ---o---   ]
    [ New draw ]  [ Play ]
    [ Spectrogram with playhead                                          ]
    [ Sparsity by band ]   [ Sparsity against rate, with this sound's dot ]

### The sound

Five seconds at 16 kHz, like the other tabs' defaults. The intervals are
`stats.gamma(k, scale=1 / k)` (mean 1 s, k from the regularity slider), and
the drawn rate track is passed as `rate_scale`, so the track *is* the rate
in events per second at each moment. `lead` is the event's length, so the
start is as dense as the rest. The result is brought to one RMS before
playback, as the gallery does, because the power grows with the rate.

## Decisions

**E1. The tab's name.** The other tabs are named verb-first ("Draw
speech", "Erase modulation"). Candidates: (a) Scatter events; (b) Repeat an
event; (c) Pile up events; (d) Sprinkle events; (e) Draw event rate, since
the rate is now drawn; (f) Draw a texture, which promises the most and is
only true at high rates.
*Recommended:* (a). It says what the tab does (copies scattered in time)
and fits the verb-first names.

*Decided (2026-10-14):* (a), Scatter events.

**E2. The events.** (a) chirp 2 to 6 kHz (the gallery's), tone pip,
noise burst, and an impact; (b) only the chirp and the impact.
Cho asked for lowpass-filtered impacts such as claps.
*Recommended:* (a), each with its own knobs: the chirp's lowest and highest
frequency, the tone pip's frequency, an event length of 10 to 100 ms for
these three, and for the impact a decay time constant (2 to 50 ms) and a
lowpass cutoff (300 Hz to 8 kHz; V3). The impact lasts eight time
constants, at least 50 ms. Every event is made with sonore's own functions
(`so.exponential_chirp`, `so.pure_tone`, `so.gaussian_noise`,
`so.butter_filter`), so the tab adds no formulas.

**E3. The rate.** Cho asked for the rate sweep as a track. (a) The drawn
track is the rate, events per second over time, on a log axis from 1 to
1000, drawn with the Tracks primitive (`tracks.md`); a fresh tab has a flat
track at 10 per second. (b) A rate slider plus a drawn track that scales
it.
*Recommended:* (a). One control instead of two, and a flat line is the
constant-rate case.

**E4. The sliders.** Regularity, the gamma shape k from 1 (Poisson) to 64
(nearly regular), log scale; level spread, a normal standard deviation from
0 to 12 dB; pitch spread, a normal standard deviation from 0 to 300 cents.
New draw changes the seed. *Recommended:* these ranges; a wider pitch
spread costs more (V1).

**E5. Duration and sampling rate.** 5 s at 16 kHz, fixed. *Recommended*: fixed.
Shorter renders save little (the cost follows the number of distinct pitch
shifts, not the duration) and make the statistics noisier.

**E6. When it renders.** (a) On releasing a slider or finishing a stroke,
plots updated, sound played only on Play (as `../app.md` D10 does for the
other tabs); (b) while dragging. *Recommended:* (a); V1 rules out (b).

**E7. The plots.** The spectrogram with a playhead; the envelope sparsity
of each band (var / mean² of its envelope), with Gaussian noise's value as a
dashed line; and the sparsity against rate (V2), the gallery's curve for the
chosen event with nothing spread, computed once per event and kept, with a
dot for the current sound when its track is flat. The last plot is a
one-way view: it says nothing about rhythm or onsets, and its caption says
so, as the gallery's does. *Recommended:* these three.

**E8. What is saved.** The event and its knobs, the track's breakpoints,
the three sliders and the seed, with the sonore version, as the other tabs
save their state. *Recommended:* this.

**E9. The README tagline.** Cho agreed to reword it. Now: "Draw on a
picture of sound and hear the result." Proposed: "Draw on a picture of
sound, or move a few sliders, and hear what sonore makes of it." The
paragraph under it gains one clause for this tab, and the tab count goes
from five to six. *Recommended:* change it in the PR that builds the tab,
so the README never describes a tab that is not there.

*Decided (2026-10-14):* the tagline becomes "A visual front end for
sonore's sound synthesis.", changed in the PR that builds the tab.

**E10. The sonore release.** The tab needs a sonore release with PR #195
(E3's track uses `rate_scale`, already in 0.6; the speed needs #195).
*Recommended:* build the tab against sonore's main branch locally, and
merge it after that release, raising the pin from `sonore>=0.6,<0.7` in the
same PR.
That release also carries sonore PR #191, which made public the
modulation hooks the Draw and Erase modulation tabs read privately today;
against sonore's main branch 19 of this project's tests fail on
`_modulation_phase` [measure: `python -m pytest`, 2026-10-14]. So the pin
change also needs those tabs moved to the public hooks.

## Order of work

1. sonore: merge PR #195 and release (Cho).
2. This project: the tab (`src/sonore_sketch/events.py`, its page section,
   tests), the pin, and the README (E9, E10).
3. A screenshot and an example drawing, as for the other tabs.

## As built

Built on sonore 0.7.0, which carries PR #195 and the public modulation
hooks; this project's pin moved to it before the tab was built (PRs #65
and #67), so E10 needed nothing more here.

- **E5 changed: the tab follows the page's duration.** Every other tab and
  the page around it (the duration box, the waveform, the status line)
  work on the page's duration, so a fixed 5 s render would have left the
  duration box doing nothing on this tab and the waveform at the wrong
  length. The cost of following it: at the page's starting 0.6 s (2 s since
  2026-10-14), a few events and a noisier statistic. Sounds up to 3 s play on each change, as
  on the other tabs. The sampling rate is the page's, 16 kHz.
- **The sparsity curve uses 3 s renders,** not the gallery's 10 s or the
  5 s measured in V2: on its own, so it does not change with the duration.
  [measure, native, one run each] the first sound for an event, its curve
  included, took 1.9 to 2.1 s; a later one at 1000/s with 12 dB and 300
  cents, 0.7 to 1.2 s, for a 3 s sound. The curve is kept for the last
  eight events (`events._reference`, an LRU cache), so moving a copies
  slider never remakes it; moving an event knob does.
- **What the plots average over.** The curve and the red dot are the mean
  of the band sparsity over the event's own bands, those where Gaussian
  noise filtered by the event comes within 10 dB of its strongest band
  [estimate: a threshold chosen to pick the chirp's 2 to 6 kHz; it gave
  6 of 28 bands for the chirp, 2 for the 1 kHz pip, 20 for the noise burst
  and 16 for the impact]. Only bands under 0.45 times the sampling rate are
  plotted: the texture model runs at 20 kHz, and above the page's 8 kHz
  there is nothing to measure.
- **The impact's noise is always seed 0,** so New draw (a new seed) moves
  the copies without changing their shape, and the curve stays valid.
- Clear puts the rate back to a flat 10 per second, the tab's only
  drawing; the event and the sliders stay, as other tabs keep their
  settings.
- Tested in `tests/test_events.py` and `tests/js/events.test.mjs`, and in
  the page check (`tools/check_page.py`: a rate stroke, a slider, New draw,
  Clear and the impact, each made and heard).

## Changes after the first build (Cho, 2026-10-14)

Cho tried the built tab and asked for changes; one choice was made on a
decision card (the plots), the rest were asked for directly.

- **The sparsity plots are replaced by the modulation spectrogram** (Cho
  chose "Replace both"). The wait Cho noticed was the sparsity-against-rate
  curve: [measure, native, one run] the sound itself took 0.01 s, the
  curve 1.7 to 2.2 s, made on the first sound of a visit and again on every
  event change; a later 3 s request took 0.22 s. Cho also found both plots
  hard to read. In their place: sonore's `ModulationSpectrogram`, with the
  gallery's settings, as the depth pooled over bands (rate by time, under
  the spectrogram) and the band by rate depth at one moment, which follows
  the playhead as on the gallery's page. [measure, native, one run each]
  render plus modulation spectrogram for a 3 s sound: 0.3 to 0.7 s across
  the four events at 100/s with a 600-cent spread. E7 above is superseded.
- **Pitch spread goes up to 600 cents** (was 300; E4).
- **Pitch spread goes up to 1200 cents and events up to 500 ms** (were 600
  cents and 100 ms; Cho, 2026-10-15; E2, E4). Length is now on a log slider
  (10 to 500 ms). Every slider on the page also has a box to type its value in.
- **Each copy is made at its own pitch** (Cho, 2026-10-15). sonore's
  `event_train` resamples the event once for each distinct pitch shift (a
  windowed sinc, widened going up), and with a wide spread nearly every
  copy has its own, so 1000/s with 500 ms chirps and 1200 cents took 29.7 s
  for 2 s of sound. The tab now hands `event_train` a function of the pitch
  ratio that makes the copy with sonore's own functions: the frequencies
  times the ratio, the length divided by it, as the resampled copy would
  be; what would rise above Nyquist is left out, as the resampling filters
  it. [measure, native] 1.3 s for those 2 s; at 30 s, 63 s became 14 s for
  the noise burst and 62 s became 4.7 s for the chirp. Tonal copies match
  the resampled ones within 0.15 dB (tests/test_events.py); noise copies
  are scaled to the same power. Without a pitch spread the sound is
  unchanged.
- **The tone pip is a pure tone or a harmonic complex** (F0 and 1 to 30
  harmonics, those above 0.45 times the sampling rate left out), since a
  single frequency alone said little (E2).
- **The noise burst is a band of noise,** its lowest and highest frequency
  set by two sliders (a 4th-order Butterworth bandpass, before the Hann
  window); by default 100 Hz to 7.5 kHz.
- **Regularity is explained on the page:** its slider is labeled
  "random" and "regular" at its ends, and its tooltip says the gaps vary
  by about 1/√k of their mean.

Saved drawings from before these changes open with the new knobs at their
defaults.

### One window for every modulation rate

Cho noticed that the pooled picture always took a U shape. With the
gallery's bank each rate's window is three cycles long, so the cells that
cannot be measured are the first and last 1.5/rate seconds. [measure, one
3 s chirp train] nothing below 1 Hz was valid, 4 Hz was valid from 0.38 to
2.62 s and 64 Hz from 0.04 to 2.96 s, which draws a U on the log rate axis.
Cho chose to try one window for every rate, as in an STFT. [measure, same
sound] a 1 s window gives rates 2 to 64 Hz
in 1 Hz steps, half a second gray at each end at every rate, and each event
blurred over about ±0.3 s; 0.5 s gives 4 to 64 Hz, 0.25 s gray and
±0.14 s. A 2 Hz floor is about the rate of a musical beat, and speech's
rhythm peaks near 5 Hz (Ding et al., 2017), so the tab uses 1 s; but the
page's sounds run from 0.05 to 30 s (2 s by default; 0.6 s until 2026-10-14), and a 1 s window
leaves a shorter sound all gray. So the window is a third of the sound, at
most 1 s, and at least two cycles of 64 Hz; the slowest rate holds two
cycles in it. [measure] 0.6 s: rates 10 to 64 Hz, valid from 0.1 to 0.5 s;
3 s: 2 to 64 Hz, valid from 0.5 to 2.5 s.

Cho also found the pooled picture hard to compare with the spectrogram, as
it was narrower and its time axis did not line up. It now runs under the
spectrogram at its full width, on the same time axis, and the band by rate
picture stands in its own column beside the two.

Cho then asked for no gray strips at the pictures' edges. The axes now run
from the outer cells' edges, so there is no empty strip above 64 Hz or
below the slowest rate. The tab uses 16 bands instead of 24: the lowest
kept band, at 166 Hz, is 72 Hz wide, so no rate is faster than a band is
wide [measure: every measured window is valid in every band and rate, 0.6
and 3 s]. Near the ends, where the window runs off the sound, the band by
rate picture shows the nearest window that was measured.

## References

- Ding, N., Patel, A. D., Chen, L., Butler, H., Luo, C., & Poeppel, D.
  (2017). Temporal modulations in speech and music. *Neuroscience &
  Biobehavioral Reviews*, 81, 181–187.
  [doi:10.1016/j.neubiorev.2017.02.011](https://doi.org/10.1016/j.neubiorev.2017.02.011)

- McDermott, J. H., & Simoncelli, E. P. (2011). Sound texture perception
  via statistics of the auditory periphery: evidence from sound synthesis.
  *Neuron*, 71(5), 926–940.
  [doi:10.1016/j.neuron.2011.06.032](https://doi.org/10.1016/j.neuron.2011.06.032)
- sonore: `docs/design/sources/event-texture.md` (the measured statistics)
  and `docs/design/sources/event-train-speed.md` (the speed).
