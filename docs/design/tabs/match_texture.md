# The Match a texture tab

A ninth tab: pick a sound, choose which of its statistics to keep, and hear
noise pushed until it has those statistics and nothing else. This is the
experiment of McDermott & Simoncelli (2011). If a sound is a texture (rain,
applause, a stream), its statistics are enough to make something that
sounds like it. If it is not (speech, a melody), they are not. Each group of
statistics you switch on adds something you can hear. The sound comes from
`sonore.texture.synthesize`, and the tab follows sonore's
[Sound textures](https://choyun1.github.io/sonore/gallery/textures.html)
gallery page, with the reader choosing the statistics.

Status: proposed. Cho asked for this tab on 2026-10-28, from a list of ideas
for new tabs ("let's do 3 first"). No code until Cho answers the decisions
(T1-T9).

This project is AI-assisted: the document and `tools/measure_texture_stats.py`
were drafted by Claude (Claude Code), for Cho to review.

## Why

Every other tab starts from a picture of one sound: a spectrogram, tracks,
a modulation spectrum, a path. This one starts from a summary that throws
away all of the sound's timing except its averages. The question it lets
the reader answer by ear is: *what does the auditory system keep?* The
ladder in the paper's Figure 3 is the lesson. With the spectrum alone, rain
is a hiss. Add the envelope marginals and it crackles. Add modulation power
and the crackle gets its rhythm. Add the correlations between bands and the
drops become drops, because each one now hits many bands at once.

It also follows on from two tabs. Scatter events builds a texture from one
event. Quilt a sound rearranges a sound
and keeps its local structure. This tab keeps only statistics.

## How the claims are verified

Every number is tagged **[measure]** (printed by
`tools/measure_texture_stats.py`, which runs sonore 0.8.0 natively on one
core, as Pyodide has none to spare, on a 4-core Linux cloud container, one
run each; it is not an independent check) or **[estimate]**. Two sources
were measured, at 2 s and 16 kHz: "rain", a Scatter events impact train
(300 impacts a second, 4 ms decay, 6 kHz cutoff, 8 dB level spread), and
the Klatt syllable train the Erase tabs use.

## What sonore provides

Everything this tab needs is public in sonore 0.8, so it needs no new
sonore release.

- `so.texture.TextureStats.measure(sound)` measures the paper's 1515
  statistics with the paper's model: 30 cochlear bands from 20 Hz to
  10 kHz, compressed envelopes at 400 Hz, 20 modulation bands. They come in
  eight classes: envelope mean, variance, skew and kurtosis (the
  *marginals*); envelope correlations between bands (`env_corr`);
  modulation power (`mod_power`); and two modulation correlations (`c1`,
  `c2`). A ninth, the subband variance, is the spectrum and is always
  imposed.
- `so.texture.synthesize(target, duration=, classes=, max_iter=, rng=,
  init=)` starts from Gaussian noise (or `init`) and imposes the chosen
  classes, channel by channel, once per iteration. It returns the best
  iterate and a per-class SNR report. All of its filtering is circular, so
  the result loops seamlessly.
- `TextureStats.snr(other)` scores how well each class matches.

## Measurements

**V1. One iteration costs about 0.4 s per second of sound.** [measure]
Natively, on one core: 0.77 to 0.88 s per iteration for 2 s (median); 0.40,
0.78 and 1.46 s for 1, 2 and 4 s with sonore's 20 kHz model; 0.46, 0.69 and
1.24 s with the model at the page's 16 kHz. Measuring the source takes 0.1
to 0.3 s. In the browser this is about 1.0 to 1.5 s per iteration for 2 s
[estimate: by the factor of 1.3 to 1.7 in `../app.md`, M2]. Ten iterations
of 2 s take about 10 to 15 s in the browser. Ten iterations of 30 s, the
page's longest, take about 2 to 3 minutes, as long as Erase modulation at
30 s.

**V2. Ten iterations get most of the way.** [measure] The average SNR over
the eight classes, after 1, 2, 5, 10, 15, 20 and 30 iterations:

| source | 1 | 2 | 5 | 10 | 15 | 20 | 30 |
|---|---|---|---|---|---|---|---|
| rain | 14.2 | 18.0 | 23.3 | 26.9 | 27.8 | 29.2 | 31.6 dB |
| syllables | 10.0 | 12.7 | 16.5 | 19.2 | 20.1 | 20.8 | 22.1 dB |

The paper counts a synthesis as converged at 20 dB. Rain gets there in
about 3 iterations, and the syllables reach about 19 dB in 10 and never get
much further. That is the paper's point: speech is not a texture.

**V3. Each step of the ladder fixes the classes it adds, and only those.**
[measure] SNR in dB of every class after 20 iterations, rain:

| imposed | mean | var | skew | kurt | env corr | mod power | C1 | C2 | spectrum |
|---|---|---|---|---|---|---|---|---|---|
| spectrum only | 17.7 | 3.2 | -3.2 | 16.5 | 0.2 | 4.4 | 0.5 | -1.5 | 30.3 |
| + marginals | 34.3 | 50.3 | 39.7 | 54.1 | 0.8 | 6.9 | 2.4 | -1.2 | 30.3 |
| + modulation power | 34.5 | 41.0 | 29.2 | 44.8 | 0.8 | 32.6 | 2.6 | -0.7 | 30.2 |
| + correlations (all) | 35.3 | 36.0 | 24.3 | 41.2 | 29.3 | 16.8 | 27.6 | 23.0 | 30.2 |

Classes not imposed stay near 0 dB, so the bars in T7 show the reader
exactly what each switch did. One surprise: with every class on,
modulation power falls from 32.6 to 16.8 dB, because the correlations pull
against it within the same number of iterations. The syllables show the
same pattern (19.3 to 9.0 dB).

**V4. The tab can stop between iterations at little cost.** [measure] The
page reports progress between steps (`shared.Step`), but `synthesize` runs
all its iterations in one call. Ten calls of one iteration, each starting
from the last (`init=`), against one call of ten: 8.8 s against 7.3 s (rain)
and 8.4 s against 7.1 s (syllables), with the same SNR (27.1 against 26.9 dB,
19.1 against 19.2 dB). So the tab steps one iteration at a time, as Erase
modulation does, without any change to sonore.

## Proposed design

### Layout (sketch)

    [ Source: (Scatter events tab's sound v)        [ Open a file... ]  ]
    [ Keep:  [x] Spectrum (always)  [x] Envelope marginals               ]
    [        [x] Modulation power   [x] Correlations                     ]
    [ Iterations ---o--- 10    [ New draw ]                              ]
    [ Source spectrogram               ][ Result spectrogram             ]
    [ How well each statistic matches: bars, imposed ones solid          ]

### The sound

The source is measured with `TextureStats.measure` at the page's duration.
`synthesize` then starts from seeded Gaussian noise of the page's duration
and runs one iteration per step (V4) with the chosen classes. The result is
brought to the page's rate and one RMS, as the other tabs do.

## Decisions

**T1. The tab's name.** The others are verb-first. Candidates: (a) Match a
texture; (b) Match statistics; (c) Imitate a texture; (d) Synthesize a
texture.
*Recommended:* (a). It says what happens (noise is made to match) and that
the tab is about textures, which is also where it works.

**T2. The source.** (a) The same Source list as Quilt a sound: sounds
made here first (the syllable train), then the other tabs' sounds in tab
order, then "From a file…"; (b) a list of
textures made here (rain, wind, fire) as well.
*Recommended:* (a), starting on the Scatter events tab's sound, since the
syllable train is not a texture and would make a poor first impression.
Recorded textures from a file work too. (b) would add sound design that
sonore does not have.

**T3. Choosing statistics.** (a) Three checkboxes, all on by default:
envelope marginals (mean, variance, skew, kurtosis), modulation power, and
correlations (envelope correlation, C1, C2), with the spectrum always on;
(b) one checkbox per class (eight); (c) a four-step ladder as radio buttons.
*Recommended:* (a). The three groups are the paper's, they can be combined
in any order (unlike (c)), and eight boxes with names like C1 and C2 would
need a glossary.

**T4. Iterations.** A slider from 1 to 30, default 10 (V2), the same field
as Erase modulation's.
*Recommended:* as stated.

**T5. Duration.** (a) The page's duration, up to 30 s, with a note when it
will be slow, as Erase modulation has (V1); (b) a fixed length (say 2 s)
looped to the page's duration, which is seamless (circular filtering) but
repeats audibly; (c) a lower limit for this tab.
*Recommended:* (a), one rule for every tab.

**T6. The model's rate.** (a) sonore's default model at 20 kHz (20 Hz to
10 kHz, as in the paper), resampled to and from the page's 16 kHz; (b) the
model at the page's rate, 20 Hz to 8 kHz, 30 bands.
*Recommended:* (a). It is the paper's model and the gallery's, the cost is
about the same (V1). Its bands above 8 kHz are matched to the 16 kHz
source's silence there, so they cost a little time and change nothing.

**T7. The plots.** The source's and the result's spectrograms side by
side, and a bar for each of the eight classes plus the spectrum: the SNR of
the result against the source, imposed classes solid and the rest outlined.
*Recommended:* as stated. The bars make V3 visible: switching a group off
drops its bars to about 0 dB.

**T8. New draw.** The starting noise is seeded. "New draw" picks a random
seed (`app/seed.js`), as Scatter events and Quilt a sound do.
*Recommended:* as stated.

**T9. What is saved.** `{"match_texture": 1, "sonore": "0.8.0", "duration",
"fs", "source", "keep": ["marginals", "modulation", "correlations"],
"iterations": 10, "seed"}` plus the source's own section (`draw_speech`,
`recording` or `drawing`), as Quilt a sound saves it.
*Recommended:* as stated.

## Order of work

1. Cho answers T1-T9.
2. The tab: `src/sonore_sketch/match_texture.py` (steps, one iteration at a
   time), its page section, tests, an output fingerprint, the worker's
   file list, and the README's tabs table.
3. A screenshot and an example drawing, as for the other tabs.
4. Time it in the browser (Cho, locally), to replace the [estimate] in V1.

## References

- McDermott, J. H., & Simoncelli, E. P. (2011). Sound texture perception
  via statistics of the auditory periphery: evidence from sound synthesis.
  *Neuron*, 71(5), 926–940.
  [doi:10.1016/j.neuron.2011.06.032](https://doi.org/10.1016/j.neuron.2011.06.032)
- sonore's gallery page
  [Sound textures](https://choyun1.github.io/sonore/gallery/textures.html).
