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

Status: proposal, for Cho to decide. Cho has already answered three
questions (2026-10-14): add lowpass-filtered impacts such as claps to the
events (E2), build the rate sweep in as a drawn track (E3), and reword the
README tagline (E9). Nothing is built.

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

## References

- McDermott, J. H., & Simoncelli, E. P. (2011). Sound texture perception
  via statistics of the auditory periphery: evidence from sound synthesis.
  *Neuron*, 71(5), 926–940.
  [doi:10.1016/j.neuron.2011.06.032](https://doi.org/10.1016/j.neuron.2011.06.032)
- sonore: `docs/design/sources/event-texture.md` (the measured statistics)
  and `docs/design/sources/event-train-speed.md` (the speed).
