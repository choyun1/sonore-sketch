# The Draw path tab

A proposed tab: draw where a sound goes around the listener with the mouse
or a pen, on a picture of the room seen from above, and hear it move, in
headphones, through sonore's `move_sound`.

Status: decided (2026-10-14). Cho chose W1 (b), the top view with an
elevation track, and accepted W2–W6 as recommended. Built
(2026-10-14): steps 1 to 4 of the order of work, on the same pull
request as this document. A speed track was proposed afterwards
(2026-10-14, "A speed track" below); Cho chose W7 (a), along the path,
and W8 stands at its recommendation. Built the same day.

This project is AI-assisted: the document and `tools/measure_paths.py`
were drafted by Claude (Claude Code), for Cho to review.

## Why

Every tab so far draws a picture of the sound itself. This one draws where
the sound is. sonore can already render a source moving along any path
through measured HRIRs, with Doppler, distance and a room
(`so.move_sound`, sonore's gallery page Moving sounds), but writing a path
as a `(times, points)` array is the opposite of playing with it. Drawing a
pass-by, a circle round the head or a source that comes close and leaves,
and hearing it at once, is the quickest way to hear what each cue does.

## How the claims are verified

As in the other tab documents, every number is tagged **[measure]**
(printed by `tools/measure_paths.py`, which runs sonore 0.6.0 natively on
a 4-core Linux cloud container, so it is not an independent check),
**[read]** (read from a source, named) or **[estimate]** (basis given).

## What sonore provides

- `so.move_sound(sound, trajectory, hrirs, *, room=None, drr_db=0, hop=5e-3)`
  renders a mono sound moving along a path [read:
  `sonore/spatial/spatialization.py`]. A `(times, points)` pair, `(N,)`
  times and `(N, 3)` Cartesian points in meters, interpolated linearly and
  held before and after, is exactly what a stroke becomes. Each ear reads
  the sound through its own smoothly changing delay, so distance changes
  give Doppler rather than comb filtering; a room tail (`so.synth_ir`) can
  be added at a chosen direct-to-reverberant ratio.
- It refuses a path that comes toward an ear faster than sound, and a path
  that comes closer than the HRIRs' own travel time allows (W-M1).
- `so.HRIRSet.from_sofa(path)` reads any SOFA `SimpleFreeFieldHRIR` file
  (needs `h5py`); `so.HRIRSet(irs, positions, fs)` builds a set from plain
  arrays, which needs nothing beyond NumPy. `HRIRSet.at` interpolates over
  directions, elevation included.
- Since sonore PR #194 (released in 0.7.0), `HRIRSet.at`
  and so `move_sound` refuse directions in a gap in the measurements, such
  as below the lowest measured elevation, instead of blending across it
  (sonore's `docs/design/spatial/elevation.md`). MIT KEMAR has the same
  hole as PKU-IOA: in sonore 0.7.0 every elevation from −40° to 90°
  in 1° steps, at every azimuth in 1° steps, renders, and −41° and below
  is refused [measure: a sweep at 1.4 m]. So the tab keeps elevation
  within −40° to 90°.
- `so.load_hrirs()` downloads PKU-IOA from sofacoustics.org, which a page
  cannot use (next section).

## Where the HRIRs come from

This is the tab's real cost. The page needs a measured set it may serve
itself or fetch from somewhere that allows it.

| Set | Directions | Distances | Elevation | Size | May sonore-sketch serve it? |
|---|---|---|---|---|---|
| MIT KEMAR, normal pinna (Gardner & Martin, 1995) | 710 | 1.4 m only | −40° to 90° | 1.17 MB SOFA [measure] | Yes: "provided without any usage restrictions", with a request to cite [read: sound.media.mit.edu/resources/KEMAR/hrtfdoc.txt] |
| SADIE II, KEMAR or KU100 (Armstrong et al., 2018) | 8802 | one | yes | larger [estimate: 12× MIT's directions] | Yes, Apache 2.0, with the license file [read: york.ac.uk/sadie-project/database.html] |
| PKU-IOA (Qu et al., 2009), sonore's default | 793 per distance | 0.2–1.6 m, 8 shells | −40° to 90° | about 13 MB per distance [read: earlier investigation] | No: its terms of use are not published, so sonore only downloads the copy sofacoustics serves |
| A spherical head (ITD and ILD only) | any | any | none | none | Yes, but sonore has no such model; it would be new code, and it has no elevation |

Fetching from sofacoustics.org would need that server to send CORS headers.
This could not be checked: the cloud container's network policy refuses
the connection (HTTP 403 at the proxy, for both the PKU-IOA and the MIT
files). Even if it allows it, PKU-IOA costs 13 MB per distance per visit
and the page would depend on a server it does not control. GitHub's own
hosting does send `Access-Control-Allow-Origin: *` [measure: a request to
raw.githubusercontent.com], and the page's own files on GitHub Pages need
no CORS at all.

The synthesis server (`server/`) could use PKU-IOA, since it runs natively
and rendering there does not hand out the HRIRs. But then the same drawing
would sound different on the server and in the browser, which the app's
rule that a saved drawing makes the same sound in Python does not allow.

**So the recommendation is MIT KEMAR, served with the page,** converted
once to a compressed `.npz` of float32 arrays (1.24 MB at its own 44.1 kHz
and 512 taps [measure]), so the browser needs no `h5py`. It is the same
KEMAR mannequin as PKU-IOA, measured at one distance, with the same elevation
range (−40° to 90°) that sonore's elevation design note works with. What it lacks is distance:
nearer and farther than 1.4 m act through level (1/r) and travel time only,
with none of the near-field changes PKU-IOA measures below about 50 cm.

## Measurements

**W-M1. MIT KEMAR as distributed only renders paths farther than about
1.2 m; with the travel time put back, any path renders.** [measure] Its IRs
start 0.63–1.32 ms in, so the 4.1 ms the sound took to travel 1.4 m was cut
off. `move_sound` treats a source nearer than 1.4 m as arriving earlier than
that, and below about 1.2 m the ear delay would be negative, so it refuses
("the path comes closer than sound can travel from it"). A line passing
100 cm in front is refused; 120 cm renders. Padding every IR with 1.4 m of
travel time (180 samples at 44.1 kHz) makes every distance down to 5 cm
render. This padding belongs in the tab's loader, not in sonore (W4).

**W-M2. Strokes need smoothing, and 30 ms is enough.** [measure] A stroke
modelled as a hand drawing four minimum-jerk segments in front of the
listener (4 s, 1.5–3 m away, true peak speed 4.7 m/s), seen as the page
would see it: one pointer event per screen frame at 60 Hz, whole pixels of
a 600-pixel canvas 8 m across, frame time stamps against the hand's true
times scattered by 2 ms [estimate of event delivery jitter]. A 1 kHz tone
moved along it; the left ear's pitch with the slow Doppler (below 10 Hz)
removed, from 0.5 s to the last 0.5 s:

| Path | Peak speed | Pitch wobble, RMS | Pitch wobble, peak |
|---|---|---|---|
| a still source | 0 | 0.00 cents | 0.02 cents |
| the hand's true path | 4.69 m/s | 0.27 cents | 0.98 cents |
| raw events | 6.25 m/s | 2.10 cents | 10.4 cents |
| resampled every 10 ms, Gaussian SD 15 ms | 4.96 m/s | 0.52 cents | 2.4 cents |
| SD 30 ms | 4.78 m/s | 0.31 cents | 1.1 cents |
| SD 60 ms | 4.61 m/s | 0.30 cents | 1.0 cents |

Raw events give a path that changes speed at every event, 60 times a
second, which `move_sound` faithfully turns into a 60 Hz pitch flutter of
up to 10 cents; whether that is audible was not tested, but it is not in
the drawing. A 30 ms Gaussian brings it to the true path's level; 60 ms
adds nothing and would round corners more [estimate]. The wobble grows with speed, so
faster strokes gain more from it [estimate: the timing error is a fixed
fraction of each step].

**W-M3. Faster than sound does not come up on an 8 m canvas.** [measure] Of
200 flicks across the whole canvas in 0.15–0.4 s (true peak speeds
38–100 m/s), `move_sound` refused none, raw or smoothed. The limit would
only matter on a canvas several times larger; the tab should still show
the refusal as a note ("this path moves faster than sound") rather than an
error.

**W-M4. The other tabs' 16 kHz loses the strongest elevation cues.**
[measure] The median-plane HRTFs of MIT KEMAR (left ear, elevations −40° to
90° in 10° steps) spread across elevation by 1.6 dB (standard deviation,
averaged over the band) at 0.5–2 kHz, 1.7 dB at 2–4 kHz, 3.6 dB at
4–8 kHz, 5.6 dB at 8–12 kHz and 4.7 dB at 12–16 kHz. At 16 kHz the sound
stops at 8 kHz, so the bands that change most with elevation are gone.
Elevation from a non-individual head is weak and confusable anyway
(Wenzel et al., 1993); cutting it at 8 kHz makes it weaker. So this tab
should run at 32 kHz (W5).

**W-M5. Speed is fine at 32 kHz.** [measure] A straight pass, natively:
3 s takes 0.24 s at 16 kHz and 0.32 s at 32 kHz; 10 s takes 0.83 s and
1.08 s (median of three warm runs; the first run up to 0.3 s more). By the
1.3–1.7 factor between native and Pyodide (`../app.md`, M2) [estimate],
3 s at 32 kHz is about half a second in the browser, fine after each
stroke. The HRIR file is 1.2 MB, fetched once when the tab opens.

## Proposed design

### Interface (sketch)

```
┌ … │ Draw path ────────────────────────────────────────── ▶ ■ ⤓ ⟲ ┐
│            front                                  │ Sound:       │
│        ·  ·  ·  ·  ·  ·                           │  syllables ▾ │
│     ·    ╭───╮ 2 m      ~~~~stroke~~~~>           │ Room:        │
│    ·     │ 1 │  ○ head (nose up, ears)            │  dry ▾       │
│     ·    ╰───╯ 1.4 m ring: measured here          │ Duration 3 s │
│        ·  ·  ·  ·  ·  ·                           │ Clear        │
│            back                                   │              │
├───────────────────────────────────────────────────┤              │
│ Elevation  90° ┊              ╱‾‾‾╲               │              │
│ (a track)   0° ┊────────────╱       ╲─────        │              │
│           −40° ┊                                  │              │
├───────────────────────────────────────────────────┤              │
│ result: the two ears' waveforms and spectrograms  │              │
└───────────────────────────────────────────────────┴──────────────┘
```

- **Top view.** The listener at the center, nose up, 8 m across, rings at
  0.5, 1, 2 and 4 m and a marked ring at 1.4 m, where the HRIRs were
  measured. One stroke is one path; drawing again replaces it (a stroke
  is a performance, so editing points is not offered at first). A dot
  runs along the path while the sound plays.
- **Time.** The stroke keeps its own timing, how fast you drew each part,
  stretched to the page's duration, as every tab's drawing stretches with
  the duration (`../app.md`, Duration). Drawing slowly near the head and
  fast past it is how you make a source linger and then fly by.
- **Elevation** (W1, the fork for Cho) as a track below, on the same time
  axis, drawn with the Tracks primitive the Draw speech tab already has,
  from −40° to 90°, the measured range, flat at 0° until drawn.
- **Sound**: the sources the Erase tabs offer (syllable train, the Draw
  speech tab's sound, a recording), plus noise, which shows the spectral
  cues best.
- **Room**: dry, or a room tail (`so.synth_ir`) at a chosen RT60 and
  direct-to-reverberant ratio.
- **Headphones note**: the tab is meant for headphones, and says so.

### Data model

`{"paths": 1, "sonore": "0.7.0", "duration": 3.0, "fs": 16000, "source":
"noise", "room": "dry", "stroke": [[t, x, y], ...], "elevation": 0 or
[times, degrees]}`. As built, the page's `fs` stays the page's, and the
tab renders at 32 kHz whatever it says (W5). The raw stroke is stored (times in the stroke's own seconds, meters), not
the smoothed one, so the smoothing can change without breaking saved
drawings.

### Python side

`sonore_sketch.paths.synthesize(state) -> so.Sound`, testable natively:
smooth the stroke (resample every 10 ms, Gaussian SD 30 ms), stretch it to
the duration, combine with the elevation track into `(times, points)`,
keep it at least 25 cm from the head center [estimate: a little more than
KEMAR's head radius, so the path never passes through the head], and call
`so.move_sound` with the padded MIT KEMAR set. The source is at RMS 1 and
the result is not normalized, so a near pass is louder than a far one;
the page scales both ears by one gain to a peak of −1 dBFS when it plays
or saves the sound, as it does every tab's.

### Changes sonore needs

None for the tab: `move_sound` takes the path as it is, and padding MIT
KEMAR with its travel time is a few lines in the loader. Two optional
sonore changes would make the same path work in a notebook without
copying that loader: an `"mit-kemar"` entry in `so.load_hrirs` (from
sofacoustics, with the travel time put back), and a clearer error when a
set's IRs lack their travel time. Neither is needed first.

## Decisions

**W1. How elevation is drawn.** This is the fork.
(a) **Top view only**, at ear height. The simplest tab; elevation is left
to sonore's gallery (the Up and down section on Binaural cues).
(b) **Top view plus an elevation track** over time, as sketched. Reuses the
Tracks primitive; one stroke and one track describe any path on the
measured sphere.
(c) **Two views**, top and side, each drawn on. Closer to drawing in 3D, but
one stroke sets only two coordinates, so the second view would edit the
first stroke's points, which is hard to make feel right.
*Recommended:* (b), built after (a): the top view first, the track as the
next step. Elevation is the least reliable cue here (W-M4), so it should not
hold the rest of the tab back, but a track is cheap once the tab exists.
*Decided (2026-10-14):* (b).

**W2. Which HRIRs.** MIT KEMAR served with the page, SADIE II, PKU-IOA
from the server only, or a spherical head. *Recommended:* MIT KEMAR, for
the reasons above. SADIE II if more directions turn out to matter.
*Decided (2026-10-14):* as recommended.

**W3. Smoothing.** *Recommended:* resample every 10 ms and smooth with a
30 ms Gaussian (W-M2), applied in Python so a saved stroke is smoothed the
same way everywhere.
*Decided (2026-10-14):* as recommended. Amended the same day at Cho's
request ("smooth out the trajectory"): the 30 ms Gaussian takes out the
pointer's steps but not the hand's wobble, so the shape is then smoothed
along the path with a 15 cm Gaussian [estimate: 10 to 20 cm looked smooth
on a wobbly test stroke without rounding its corners much], mirrored
through each end so a straight end stays where it was drawn, and each
point keeps its time. A Smoothing slider sets that width from 0 to 50 cm
(`"smoothing"` in the section, 0.15 when absent). The top view shows this
smoothed path, the one heard.

**W4. Travel time.** *Recommended:* put the 1.4 m travel time back in the
loader (W-M1), not in sonore.
*Decided (2026-10-14):* as recommended.

**W5. Sampling rate.** *Recommended:* 32 kHz for this tab (W-M4, W-M5),
unlike the others' 16 kHz.
*Decided (2026-10-14):* as recommended.

**W6. Timing.** The stroke's own timing stretched to the page's duration,
or a constant speed along the drawn shape. *Recommended:* the stroke's own
timing; speed is half of what a moving sound is.
*Decided (2026-10-14):* as recommended.

## A speed track (2026-10-14)

Using the drawing's own timing (W6) worked, but Cho found it hard to
control: the hand's own speeding up and slowing down, at corners above
all, becomes the motion, and nothing on the page shows the speed. A
speed track under the top view, like the elevation track, makes the
speed something you see and edit.

- **What it holds.** Relative speed: faster here, slower there. Its
  scale is set by the duration: the page scales it so the trip from the
  start of the path to its end takes exactly the duration. With speed
  r(s) at arc length s along the path, the sound moves at c·r(s), where
  c = (∫ ds / r(s)) / duration, and the track's axis is labeled in m/s
  for the current duration, so changing the duration relabels the axis
  and leaves the shape alone.
- **Where it starts.** The speed you drew, smoothed as now (W3), so
  nothing changes until you edit the track. Drawing a new path resets the
  track to the new drawing's speed. An "Even speed" button sets it flat.
- **Seeing the place.** Hovering or drawing on the track puts a marker on
  the matching point of the path, and the playhead runs along both while
  the sound plays.
- **Elevation** stays on its time axis (W7 says why the speed track may
  not be on one).

**W7. The speed track's horizontal axis.** (a) **Distance along the
path**, from its start to its end: each spot on the track is a fixed
point on the path, so the marker under the cursor stays put while you
draw speed. It cannot show a pause, since standing still covers no
distance (W8). (b) **Time**, like the elevation track: the two line up,
but slowing one part pushes every later point to a later time, so the
point under the cursor slides while you draw. *Recommended:* (a).
*Decided (2026-10-14):* (a).

**W8. The slowest speed.** With (a), a speed of zero would take forever,
so the track has a floor, 1/20 of its top [estimate: slow enough to
hear as lingering, and it keeps one segment from taking nearly all the
duration]. A pause, if wanted, would be a separate "hold here" mark
rather than a speed. *Recommended:* the floor, and no hold mark until
asked for.

Data model: the paths section gains `"speed": null` (the drawing's own
timing, as saved drawings have) or `[fractions, speeds]`, breakpoints at
fractions of the path's length from 0 to 1 and relative speeds. The
Python side turns them into times along the smoothed path; the stroke's
own times then set only its shape. As built, the page keeps the stored
speeds scaled so that 1 is the average speed, interpolates them on a log
scale as the track shows them (from 1/8 to 8 times the average), and its
own timeline of the path matches the Python side's (`tests/test_paths.py`).

## Order of work

1. `tools/make_hrirs.py`: MIT KEMAR SOFA to
   `src/sonore_sketch/data/mit_kemar.npz`, with its citation and the MIT
   terms next to it. It sits in the package so that Python, the local
   engine and the synthesis server find it; the worker fetches it the
   first time the tab makes a sound.
2. `sonore_sketch.paths` and its tests: stroke to `(times, points)`,
   smoothing, the head limit, `move_sound`.
3. The top view, playback with the moving dot.
4. The elevation track (W1 b).

## References

Armstrong, C., Thresh, L., Murphy, D., & Kearney, G. (2018). A perceptual
evaluation of individual and non-individual HRTFs: A case study of the
SADIE II database. *Applied Sciences*, 8(11), 2029.

Gardner, W. G., & Martin, K. D. (1995). HRTF measurements of a KEMAR.
*The Journal of the Acoustical Society of America*, 97(6), 3907–3908.

Qu, T., Xiao, Z., Gong, M., Huang, Y., Li, X., & Wu, X. (2009).
Distance-dependent head-related transfer functions measured with high
spatial resolution using a spark gap. *IEEE Transactions on Audio, Speech,
and Language Processing*, 17(6), 1124–1132.

Wenzel, E. M., Arruda, M., Kistler, D. J., & Wightman, F. L. (1993).
Localization using nonindividualized head-related transfer functions.
*The Journal of the Acoustical Society of America*, 94(1), 111–123.
