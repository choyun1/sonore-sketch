# A drawing front end for sonore

A design for a web page where you draw on a picture of sound and hear the
result: formant tracks over a time-frequency grid (TrackDraw), a painted
spectrogram, blobs on a modulation spectrum, and other views as they come.
Each tab is one of sonore's ways back to sound, given a point-and-click
surface. sonore does the synthesis; this project is only the interface.

Status: accepted. Proposed 2026-10-04, replacing the TrackDraw-only
proposal of 2026-10-03, which is now the Tracks tab (`tabs/tracks.md`).
Cho merged it on 2026-10-05 (TrackDraw PR #3), which accepts the
recommendations below, and the name is settled (D1). As of 2026-10-06
every step of the order of work is built: the shell and all five tabs,
each with its own design document in `tabs/`.

This project is AI-assisted: the documents and the scripts in `tools/` were
drafted by Claude (Claude Code) for Cho to review.

## Why

Cho, 2026-10-04: "just an easy, visual, point and click way to play around
with different 'views' (in sonore sense) and hearing the results." sonore's
views are what you see of a sound (a spectrogram, a modulation spectrum,
formant tracks, an F0 contour). Several of them now have a stated route back
to sound (`philosophy.md`, "`synthesize` is exact; `to_sound` is a stated
route back"), but each route is a function call with arrays. Drawing is the
natural way to set those arrays. The two ideas that started this, TrackDraw
and drawing modulation-spectrum blobs, share most of what makes an app
hard: a canvas with axes, picking and dragging things on it, undo, play and
stop, a picture of the result, saving and sharing. So they belong in one
app, as tabs. sonore's own modulation-targets design already says so:
"a GUI for drawing is left to TrackDraw, which would hand over the same
blob list or grid" (`docs/design/views/modulation-targets.md`, D1, accepted
2026-10-03).

It is a separate distribution from sonore because it needs a user interface
and has a different audience: people who want to hear an idea, not write
code (`philosophy.md`, "Heavy dependencies are optional").

## How the claims are verified

As in `tabs/tracks.md`: **[measure]** numbers come from a script in
`tools/` that runs sonore (it says so in its docstring); **[estimate]**
numbers give their basis. The native numbers here were measured on a
4-core Linux cloud container, Python 3.11.15, NumPy 2.4.6, with sonore's
main branch at commit 451f99a (it reports version 0.4.0, but holds
unreleased work, see M2).

## One tab, one route back to sound

Every tab has the same parts:

1. **A drawing surface** on the axes of one view, with its own tools.
2. **A state**: plain data, small enough to save as JSON and to put in a
   link.
3. **One sonore call** that turns the state into a `Sound`, run in a
   background worker.
4. **A picture of the result**, made by sonore from the sound that came
   out: its spectrogram always, and the tab's own view of it where that
   means something. Seeing the drawn target beside what the sound actually
   has is part of the lesson (for a modulation spectrum, a noise carrier
   adds modulation of its own; `to_sound`'s docstring measures it).

The shell around the tabs is shared: play and stop, a level meter, the
waveform and spectrogram of the last result, A/B against a loaded
recording, undo, save and open, export WAV, and a progress note while sonore
loads.

### Candidate tabs

In order of rising abstraction: parameters of a voice, then the spectrogram,
then the modulation spectrum (a transform of the spectrogram's envelope).

| Tab | You draw | sonore call | In sonore 0.4.0? |
|---|---|---|---|
| **Tracks** (TrackDraw) | F1–F5, F0, AV, bandwidths as tracks over time, optionally over a recording's spectrogram | `so.klatt_synthesize`; sine-wave speech by a new function (`tabs/tracks.md`, D6) | Yes |
| **Painted spectrogram** | Level painted on time × log-frequency | `so.ripple_sound(pattern, ...)` with the painting as `pattern(t, x)` | Yes |
| **Spectrogram mask** | A mask painted over a recording's spectrogram (erase a band, a moment, a harmonic) | `(stft * mask).to_sound()`, least squares (`GaborFrame`) | Yes |
| **Modulation blobs** | Gaussian blobs on rate (Hz, signed) × density (cycles/octave): centre, two widths, level; carrier, depth, seed | `ModulationSpectrum.from_blobs(...).to_sound(carrier=...)` | No: on sonore's main branch, unreleased |
| **Edit a modulation spectrum** | A gain mask painted on a recording's modulation spectrum | `spectrum.with_gain(g).to_sound(carrier=recording, iterations=n)` | No: same |

Further ideas, not proposed for now: an F0 contour drawn over a recording and
resynthesized with WORLD (`world_synthesize`); a long-term spectrum drawn as
a curve (`Spectrum.to_sound`); parametric moving ripples with sliders
(`Ripple`, `DynamicRipple`); texture statistics (too slow to be interactive,
about 0.4 s per iteration per second of sound by `texture.synthesize`'s
docstring).

## Measurements

**M1. Synthesis in the browser is fast enough; loading is the cost.**
[measure] Cho's run of `tools/measure_pyodide_latency.py` (2026-10-03,
Pyodide 314.0.7, details in `tabs/tracks.md`, M6): 1 s of Klatt speech in
0.13–0.22 s and 3 s in 0.36–0.48 s, but 16 s to load on a first visit and
9 s on a reload, of which about 4 s is `import sonore` each time.
[measure] 2026-10-13, `tools/measure_load.py` on a GitHub Actions runner
(fast network, same profile reopened between visits): about 5.7 s on every
visit before this change and 5.2 s after it (loading only NumPy, SciPy and
sonore's wheel, not micropip and sonore's matplotlib and soundfile); first
and later visits differ by under a second there, so the wait is starting
Python, not downloading. Split: Pyodide 1.1 s, packages 1.1 s (unpacking and
compiling their WebAssembly, which the HTTP cache does not keep), `import
sonore` 3.0 s, nearly all of it SciPy's `scipy.signal` (0.74 of 0.86 s
natively), which sonore needs.

**M2. The other tabs' calls are as fast or faster, natively, up to 10 s.**
[measure] `tools/measure_tab_synthesis.py` and
`tools/measure_pyodide_latency.py --native`, 16 kHz, cold (first call)
and warm (median of the next three), sonore's main branch at 451f99a:

| Case | 1 s cold | 1 s warm | 3 s cold | 3 s warm | 10 s cold | 10 s warm |
|---|---|---|---|---|---|---|
| Klatt, drawn tracks | 0.086 s | 0.075 s | 0.277 s | 0.278 s | 0.936 s | 0.920 s |
| Painted envelope (`ripple_sound`) | 0.020 s | 0.018 s | 0.058 s | 0.057 s | 0.531 s | 0.375 s |
| Spectrogram mask (`GaborFrame`) | 0.011 s | 0.010 s | 0.028 s | 0.030 s | 0.100 s | 0.101 s |
| Blobs on tones | 0.144 s | 0.064 s | 0.456 s | 0.171 s | 1.526 s | 0.684 s |
| Blobs on noise | 0.269 s | 0.184 s | 0.415 s | 0.393 s | 1.777 s | 1.163 s |

Every call grows roughly in proportion to the duration. Under Pyodide, 3 s
of Klatt speech took 0.36–0.48 s (M1) against 0.28 s here, a factor of
about 1.3–1.7 [estimate: one call, two different machines]. By that
factor, 10 s would take about 1.2–1.6 s for Klatt and up to about 3 s for
blobs on noise, cold. That is fine behind a Play button, but too slow to
play automatically after every stroke (D10). The Pyodide script now also
times 10 s, so Cho can replace this estimate by re-running it.

## Proposed design

### Layout (sketch)

```
┌ Tracks │ Painted │ Mask │ Blobs │ Edit ───────────────────── ▶ ■  ⤓ ⟲ ┐
│                                                              │ tools    │
│      drawing surface (the tab's view, with its axes)         │ for this │
│                                                              │ tab      │
├──────────────────────────────────────────────────────────────┤          │
│ result: waveform and spectrogram, and the tab's view of it   │ carrier, │
│ measured from the sound (drawn target vs what came out)      │ seed ... │
└──────────────────────────────────────────────────────────────┴──────────┘
```

Each tab keeps its own state when you switch away, so you can move between
them and come back. A loaded recording is shared: it can be the background
for Tracks, the carrier for Blobs, the source for Edit and Mask.

### Duration

The duration is a setting of the whole page, from a fraction of a second
up to a limit (D10), shown on the time axis of every tab. Lengthening or
shortening it stretches what is drawn: track breakpoints and painted
columns scale with it, as the paper's `dur` did (exactly for breakpoints,
`tabs/tracks.md`, C3), and a modulation spectrum is redrawn on the new grid
(`from_blobs` takes the duration). A tab over a recording takes the
recording's length, up to the same limit.

### Drawing primitives

Tabs are built from three primitives. They are the only drawing code, so
each one is worth getting right once:

- **Tracks**: a value over time, as breakpoints (point, line and freehand
  tools; `tabs/tracks.md`, D4 and D10).
- **Blobs**: shapes on a plane, placed, dragged, resized by handles, deleted.
  Each blob is a `ModulationBlob` (rate, density, two widths, level).
- **Paint**: a grid painted with a brush (size, softness, add or erase),
  for the painted spectrogram, the spectrogram mask and the modulation gain
  mask.

### Architecture

- A static page (HTML, CSS and JavaScript) for drawing and playback, on SVG
  or canvas; Web Audio plays the samples. Hosted on GitHub Pages; works on
  a tablet with a pen.
- Pyodide and sonore in a Web Worker, so drawing never waits on synthesis.
  The page sends a tab's state; the worker returns samples and pictures.
- A small Python package with one function per tab, `state -> Sound`, that
  runs both in the worker and in a notebook, so a saved drawing gives the
  same sound in Python. Tested with `python -m pytest` against sonore
  directly.
- Drawing can start before sonore has loaded; the first Play waits for it
  and says so.

## Decisions

**D1. Name and repository.**
The name should say what the app is. It is no longer only about tracks.
Options:
(a) keep **TrackDraw** for the whole app, for its history and the link to
Assmann et al. (1994), with "Tracks" as one tab;
(b) a name that ties it to sonore, such as **sonore-sketch** (import
`sonore_sketch`, page "sonore-sketch"): it says it is the drawing front end
of sonore;
(c) a name of its own, such as **Soundsketch** or **Drawn Sound**.
For the repository: rename `choyun1/TrackDraw`, which keeps the 2016 history
and the MIT licence with Daniel R Guest as co-author (GitHub redirects the
old URL), or start a new repository and keep TrackDraw as it is.
*Recommended:* (b), with the repository renamed. The app is sonore's views
made drawable, so the name should point there, and renaming keeps the
history. The Tracks tab keeps the TrackDraw name and credits Assmann et
al. *Decided (2026-10-05):* (b), as a new repository,
`choyun1/sonore-sketch`, which carries TrackDraw's history and licence;
`choyun1/TrackDraw` stays as it was. None of the four names (`sonore-sketch`, `soundsketch`,
`trackdraw`, `drawn-sound`) was taken on PyPI on 2026-10-04; GitHub was not
searched.

**D2. The tab model.**
(a) one app with tabs sharing a shell, state and recording, as above;
(b) separate small pages, one per idea, sharing a library.
*Recommended:* (a). It is what Cho described. The shared parts (canvas,
primitives, worker, playback, save) are most of the work, and one loaded
recording can be heard through every view.

**D3. Platform.**
A static browser page (recommended), a desktop app, or notebook widgets.
*Recommended:* the browser page, now with evidence: M1 shows synthesis is
fast enough under Pyodide. The weak point is load time (D6).

**D4. Where synthesis runs.**
sonore under Pyodide (recommended: one copy of every formula, as Cho
prefers), or JavaScript ports of each route. With several tabs, a port
would mean several second copies, so the case for Pyodide is stronger than
for Tracks alone.

**D5. Which sonore, and when.**
The Blobs and Edit tabs need `ModulationSpectrum.from_blobs`, `with_gain`
and `to_sound`, which are on sonore's main branch but not in a release
(sonore's CHANGELOG, "Unreleased"). The page installs sonore from PyPI with
micropip, so those tabs need a release (0.5.0, by sonore's versioning rule
for new behaviour).
*Recommended:* pin `sonore>=0.5,<0.6` once 0.5.0 exists, and build Tracks,
Painted and Mask on 0.4.0 until then. Each upgrade is a PR that bumps the
pin and re-runs the tests comparing the app's samples with Python's.
Whether sonore's README links to the app is a sonore PR and Cho's call.

**D6. Load time.**
M1: 16 s on a first visit, 9 s on a reload, about 4 s of it `import sonore`.
(a) accept it, show progress, and let drawing start at once;
(b) also make `import sonore` lighter (defer scipy and matplotlib until a
function needs them; a sonore PR, after profiling);
(c) load only what each tab needs.
*Recommended:* (a) now and (b) after a profile shows where the 4 s goes
(inferred, not profiled: probably scipy and matplotlib). (c) only if (b) is
not enough.
*Since then (2026-10-13):* the profile (M1) shows matplotlib is not imported
at all and the import is `scipy.signal`, so (b) has little to gain. The
worker now loads only NumPy, SciPy and sonore's wheel (about 0.5 s less on
every visit). What is left, about 5 s on a fast machine, is paid on every
visit; only a Pyodide memory snapshot saved in the browser could skip it.
*Tried (2026-10-13, `tools/try_snapshot.py` on a GitHub Actions runner,
Pyodide 314.0.7):* a snapshot taken after loading NumPy, SciPy and sonore is
refused by Pyodide itself ("Unexpected hiwire entry at index 6"), with or
without a serializer, so the 1.3 s of packages and 3.7 s of imports cannot
be skipped this way. A snapshot taken right after Pyodide starts works: 31.5
MB in Cache Storage, read in 0.1 s, Pyodide ready in 0.33 s instead of
1.5 s, then packages and imports as before; about 1.2 s saved of 7 s to the
first sound (timed on the page's thread, so slower than the worker). Not
adopted: about a sixth of the wait, for a private Pyodide option
(`_makeSnapshot`, `_loadSnapshot`) that can change with any upgrade and 31
MB stored per visitor. Re-run the script after a Pyodide upgrade.

**D7. Which tabs, in which order.**
*Recommended:* in order of rising abstraction, as Cho asked (2026-10-04):
Tracks, then the two spectrogram tabs (Painted, Mask), then the two
modulation tabs (Blobs, Edit). This also suits sonore's releases: Tracks,
Painted and Mask need only 0.4.0, and by the time the modulation tabs are
reached, 0.5.0 can be out (D5). Painted and Mask share the Paint
primitive. Edit is last because it combines a recording, a view and a
painted mask.

**D8. Sharing.**
A drawing small enough to fit in a link (`#state=...`) can be sent to a
student or a colleague and opens as drawn. Recordings cannot go in a link.
*Recommended:* links for drawings without recordings in v1, since a
Tracks or Blobs state is a few hundred bytes [estimate: about 13 tracks of
about 5 breakpoints, or a few blobs]. Recordings stay local files.

**D9. Generality.**
Build the three primitives and the tab contract, and nothing more general
("add generality when an experiment needs it"). A new tab is a new state, a
new sonore call and a choice of primitives.

**D10. Longest duration.**
Cho, 2026-10-04: let the user lengthen the sound, "up to some reasonable
computational limit, maybe up to like 10 sec?".
(a) 10 s for every tab;
(b) a limit per tab, set by its own speed;
(c) no fixed limit, with a warning above a measured time.
*Recommended:* (a), 10 s everywhere. It is one rule to explain, and M2
puts every tab's 10 s synthesis at roughly 1–3 s in the browser
[estimate]. Below about 3 s, sound plays automatically when a stroke ends.
Above that, it plays on Play, and a progress note shows while it is made.
The limit is one constant, so it can change after measuring in the browser.

The Tracks tab's own decisions (scope, track model, file format, sine-wave
speech upstream, drawing interaction) are in `tabs/tracks.md`.
The Painted tab's and the Paint primitive's decisions are in
`tabs/painted.md`.
The Draw modulation tab's and the Blobs primitive's decisions are in
`tabs/blobs.md`, the Erase modulation tab's in `tabs/edit.md`, and the
Erase spectrogram (Mask) tab's in `tabs/mask.md`.

## Order of work

After the decisions, each step a PR for Cho:

1. Repository and name (D1): README with credits, licence, a package
   pinning sonore (D5), `python -m pytest` running.
2. The shell: tabs, the duration setting, the worker with Pyodide and
   sonore, playback, the result picture, save and open, load progress
   (D2–D4, D6, D10).
3. The Tracks tab (`tabs/tracks.md`, its order of work).
4. The Paint primitive, then the Painted and Mask tabs.
5. The Blobs primitive and tab, once sonore 0.5.0 is released (D5).
6. Edit a modulation spectrum.

## References

- Assmann, P., Ballard, W., Bornstein, L., & Paschall, D. (1994).
  Track-Draw: A graphical interface for controlling the parameters of a
  speech synthesizer. *Behavior Research Methods, Instruments, & Computers*,
  26(4), 431–436. doi:10.3758/BF03204661.
- sonore: `docs/design/philosophy.md`,
  `docs/design/views/modulation-targets.md`, `CHANGELOG.md` (Unreleased),
  `src/sonore/views/modulation.py`, `src/sonore/sources/ripples.py`,
  `src/sonore/frames/gabor.py`.
- Further references for each tab are in its own document.
