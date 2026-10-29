# Streaming (sonore 0.10)

What sonore 0.10.0's streams change on the page, and what they could add.

Status: accepted. Cho asked on 2026-10-29 to upgrade to sonore 0.10.0
(PR #100) and "consider what its new live streaming feature enables, or
changes in sonore-sketch", and accepted every recommendation (L1-L8) the
same day. L1 is built (PR #100); the rest follow "Order of work".

This project is AI-assisted: the document and `tools/measure_streaming.py`
were drafted by Claude (Claude Code), for Cho to review.

## What sonore 0.10 adds

[read] From sonore's CHANGELOG (0.10.0, 2026-10-29) and `sonore/core/stream.py`:

- **Streams are analysis, not synthesis.** A view that streams has
  `start(fs)`, `step(state, block)` and `finish(state)`; `so.stream(view,
  blocks)` runs them over any blocks, and the parts joined (`concatenate`)
  equal the batch analysis of the whole sound bit for bit. What streams:
  the STFT (`GaborFrame`), cepstrum and MFCCs (with a fixed `reference=`),
  a time-domain gammatone bank and its pooled envelopes (a cochleagram),
  the causal modulation spectrogram, and the F0 track (`F0TrackStream`,
  each time window decided 50 ms after it).
- **A part of a stream cannot be resynthesized.** `STFT.is_whole` is false
  for a part, and `to_sound`, `griffin_lim`, `synthesize` and `adjoint`
  refuse it. Nothing in sonore makes a sound one block at a time.
- `live_blocks(fs, size)` reads a sound card through python-sounddevice
  (the new `live` extra). That is for a native Python; in a browser the
  page has to take the microphone itself (Web Audio) and hand blocks to
  Python. sonore's own docs/live/ page does exactly that under Pyodide.
- `f0_track` runs about twice as fast and its F0s move by rounding only.

## How the claims are verified

**[measure]**: printed by `tools/measure_streaming.py`, natively on one
core of a 4-core Linux cloud container, Python 3.13, 16 kHz, best of 3
(the per-tab table is one run). It runs sonore to measure it; it is not an
independent check. **[browser]**: Pyodide numbers already in
`docs/design/app.md` (D10, sonore 0.7.0). **[read]**: read from sonore's
source or changelog. **[estimate]**: not measured; Pyodide timings cannot
run in this container (the CDN is blocked) and are left to Cho.

## Measurements

**V1. The upgrade changes no sound.** [measure] The fingerprint test passes
unchanged and every starting sound in `app/examples/` is byte-identical
under 0.10.0 (PR #100).

**V2. Startup is unchanged.** [measure] `import sonore`, fresh interpreter:
0.9.0 1.05 s, 0.10.0 1.11 s. In the browser the import is about 3 s of the
~5 s wait (sonore-sketch-load-time notes, PR #54), nearly all of it
`scipy.signal`; 0.10 adds modules but not that cost.

**V3. The pictures hold back the sound on two tabs.** [measure] Each tab's
starting drawing: seconds until the sound exists (`synthesis_s`), and
until `page.handle` returns the sound with its pictures. The page plays
only when both are done.

| Tab | 2 s: sound | 2 s: all | 30 s: sound | 30 s: all |
|---|---|---|---|---|
| Draw speech | 0.04 | 0.08 | 3.1 | 3.3 |
| Draw a voice | 0.81 | 0.90 | 93.8 | 93.9 |
| Draw spectrogram | 0.24 | 0.31 | 10.8 | 10.9 |
| Draw modulation | 0.37 | 1.40 | 14.7 | 21.4 |
| Erase modulation | 9.8 | 10.5 | 116.3 | 123.1 |
| Erase spectrogram | 0.29 | 0.37 | 5.7 | 5.8 |
| Draw path | 0.52 | 0.59 | 5.5 | 5.6 |
| Draw a room | 0.53 | 0.80 | 5.1 | 5.3 |
| Scatter events | 0.26 | 0.33 | 4.4 | 4.5 |
| Quilt a sound | 0.50 | 0.65 | 9.6 | 9.8 |
| Match a texture | 14.9 | 15.1 | 261 | 261 |

[browser] The same gap at 30 s in Pyodide (app.md, D10): Draw modulation
6.5 s of synthesis, 20.5 s from Play to sound; Erase modulation 176 s and
188 s. Every other tab's gap is under half a second.

**V4. Live views are cheap, except the F0 track.** [measure] Per 10 ms of
sound (under 10 ms keeps up with a microphone), on 30 s of the Syllables
source:

| Stream | 10 ms blocks | 50 ms blocks |
|---|---|---|
| Spectrogram, 5 ms windows every 2.5 ms | 0.40 ms | 0.23 ms |
| F0 track, decided 50 ms late | 8.4 ms | 4.1 ms |
| Cochleagram, 32 gammatones, 10 ms | 1.7 ms | 0.67 ms |

The streamed spectrogram equals the batch one (12001 time windows, every
value identical). [estimate] Pyodide has run 2 to 4 times slower than
native here, so a live spectrogram keeps up easily, and a live F0 track
keeps up only in 50 ms blocks and only just. sonore's live page check notes
that it restarts when it falls behind.

**V5. Taking a voice from a long sound waits on the F0 track.** [measure]
`f0_track` on 30 s of syllables: 0.9.0 19.4 s, 0.10.0 10.1 s. Draw a
voice's "Take from a sound" at 30 s (one run): making the source 6.2 s,
the pitch 9.8 s, the filter 2.5 s, the breathiness 4.9 s.

## What streaming does not change

**Playback before synthesis finishes.** Not possible with 0.10: every tab's
synthesis is a whole-sound computation (least-squares resynthesis, the
modulation iterations, quilting, texture matching, WORLD and Klatt over the
whole track), and sonore refuses to resynthesize a part of a stream
[read]. A streaming synthesis would be a sonore change, and most of these
algorithms (iterations over the whole envelope, least squares over the
whole frame) have no causal form to stream.

**The ~5 s start.** Unchanged (V2). The time is Pyodide, the packages and
`scipy.signal`; streams do not touch any of it.

**The slow tabs.** Erase modulation and Match a texture spend their time
iterating on the whole sound (V3); streams do not help. (L4 is the one
change that helps a slow tab, and it does not need streams.)

**The synthesis server.** Still on hold, and streams give no new reason
for it: a server would speed synthesis, which streams do not touch, and a
live view needs the microphone near the analysis (in the browser), not a
round trip.

## Decisions

**L1. Upgrade to sonore 0.10.0.** Pin `>=0.10,<0.11`, the worker's wheel
and the version stamps. *Recommended:* yes, as PR #100 (V1: no sound
changes; Draw a voice's "Take from a sound" gets faster, V5).

**L2. Playback before synthesis finishes.** (a) Not now: nothing in sonore
0.10 makes a sound in blocks; (b) ask sonore for streaming synthesis.
*Recommended:* (a). A streaming synthesis would have to change what the
tabs' algorithms are (V3's slow tabs iterate on the whole sound), and L4
gets the sound out sooner without it.

**L3. The start-up wait.** *Recommended:* no change (V2). Re-try the
Pyodide memory snapshot when Pyodide is next upgraded, as before.

**L4. Send the sound before its pictures.** Today the worker sends one
result: the sound and every picture measured from it. (a) Keep it;
(b) send the sound as soon as it exists, play it, and draw the pictures
when they arrive (the measured modulation spectrum, the source's
spectrogram and so on, in a second message). *Recommended:* (b). At 30 s
it cuts Draw modulation's wait from about 20.5 s to 6.5 s in the browser
and Erase modulation's by 12 s (V3); elsewhere it saves under half a
second, and nothing gets slower. This is not sonore's streaming, but it is
the "hear it sooner" the streaming release suggests. `page.handle_steps`
already yields between steps, so the worker can post the samples at the
step where the sound is made; the picture panes show "Measuring…" until
theirs arrives.

**L5. Hear Erase modulation's iterations as they come.** Each iteration
makes a whole sound (`edited.iterate(sound)`). (a) Keep waiting for the
last; (b) with L4, play the first synthesis as soon as it is made (about
3/8 of the wait with 5 iterations), and replace it after each iteration,
the progress label saying which one is heard. *Recommended:* (a) for now.
Swapping the sound while it plays is confusing, and fewer iterations
already make the tab faster; revisit if Cho finds the wait the problem
after L4.

**L6. Record from the microphone, with a live spectrogram.** The page
opens audio files but cannot record. (a) Leave it; (b) a Record button
wherever a recording can be the source (Erase spectrogram, Erase
modulation, Quilt a sound, Match a texture, Draw a voice, Draw a room),
up to the page's 30 s, with the recording's spectrogram drawn as it comes
in by sonore's streamed STFT. *Recommended:* (b). This is what streams
make possible: the live picture costs well under 1 ms per 10 ms of sound
(V4), and because the streamed picture equals the batch one, the picture
drawn while recording is the one the tab shows afterwards (with a fixed
reference level instead of the whole sound's loudest cell, which is not
known until the end). The page takes the microphone with Web Audio
(`getUserMedia` and an AudioWorklet), not `live_blocks`. A recording
started before Python has loaded is kept and analyzed when it is ready
(streams take blocks of any size, so it catches up). A recording is kept
like an opened file, so links still do not carry it.

**L7. Sing a pitch on Draw a voice.** With L6, track the recording's F0 as
it comes in (`F0TrackStream`), drawn onto the pitch track as you sing, so
"Take from a sound" on a recording has its pitch the moment recording
stops instead of after the pitch pass (about 10 s natively at 30 s, V5).
(a) Not now; (b) yes, after L6, once Cho has timed the F0 stream in a
browser. *Recommended:* (b), on 50 ms blocks. V4 puts it near the limit
in Pyodide, so it needs the browser timing first; if it falls behind, the
page should keep recording and finish the track after, not drop samples.

**L8. A live-analysis tab.** sonore's views of a microphone (spectrogram,
cochleagram, modulation spectrogram, F0) as a tab of their own. (a) No:
sonore's docs/live/ page does this already, and every tab here is about
drawing a sound; (b) yes. *Recommended:* (a), with a link to sonore's
live page from the README.

## Also seen

Not about streaming, but measured on the way: Draw a voice's starting
drawing takes 0.8 s at 2 s and 94 s at 30 s natively (V3), far more than
in proportion (15 times the duration, about 115 times the time). Every
other tab grows about in proportion. Worth its own look before L7 adds
recordings to Draw a voice.

## Order of work

1. L1 (PR #100).
2. L4: the worker posts the sound, then the pictures; tests for the two
   messages; Draw modulation and Erase modulation panes wait for theirs.
3. L6: Record (Web Audio capture, blocks to the worker, the streamed
   spectrogram drawn as it grows), on every tab that takes a recording.
4. Cho times the F0 stream in a browser; then L7.

## References

- sonore 0.10.0 CHANGELOG, and docs/design/streaming.md and
  docs/design/live-page.md in sonore's repository.
- `docs/design/app.md` (D10, browser timings at 30 s).

## As built

**L4** (2026-10-29). `page.MEASURED_AFTER` names the tabs whose pictures
take a while after the sound (Draw modulation, Erase modulation, Draw a
room); on those, `page.handle_steps` yields one step with the sound alone
(`shared.SoundStep`: the result's `fs`, samples, spectrogram and
`synthesis_s`). The worker posts it as a `sound` message, the Pyodide
engine hands it to `onSound`, and the page shows and plays it ("Made 10 s
in 11.79 s; measuring it…") and draws the pictures when the whole result
comes ("Made 10 s in 11.79 s, measured in 18.82 s."). Play pressed while
the pictures are measured plays the sound at once. The server and local
engines still answer in one piece. Checked under Pyodide 314.0.7 in
headless Chromium (served locally): Draw modulation at 10 s played at
11.8 s instead of 18.8 s; Draw a room and Erase modulation at 4 s also
played before their pictures; Draw spectrogram is unchanged.

**L8** (2026-10-29). The README links sonore's live page
(https://choyun1.github.io/sonore/live/, the address Cho gave) beside the
gallery link.

**L6** (2026-10-29). Every Source list (Erase spectrogram, Erase
modulation, Draw a voice, Draw a room, Quilt a sound, Match a texture) has
**● Record** under **Open audio file…**. `app/recorder.js` takes the
microphone with Web Audio (an AudioWorklet, `app/recorder-worklet.js`; no
echo cancellation, noise suppression or level control) at its own rate,
in blocks of 50 ms, up to 30 s, and at the end resamples it to the page's
rate (`OfflineAudioContext`); it then opens like a file ("Recording 1").
While it records, each block goes to the worker, where
`src/sonore_sketch/live.py` (`LiveSpectrogram`) runs sonore's streamed
STFT (5 ms windows every 10 ms, 0 to 8 kHz, dB below a full-scale sine,
floor -70 dB) and returns the columns each block completed; the Source box
draws them on a strip spanning the 30 s limit. The picture is the
recording's own STFT at the microphone's rate, not the tab's (that comes
when the sound is made). A recording started before Python has loaded
keeps recording, and the picture catches up once it has
(`tests/test_live.py`: any cut into blocks gives the same columns). The
synthesis server and the local engine make no live picture; Record still
works there. Checked in headless Chromium with a stand-in microphone: under
Pyodide, a recording started while Python loaded ran 17.1 s and its
picture caught up to every one of its 1712 columns; `tools/check_page.py`
now records 1.5 s on Erase spectrogram (local engine).
