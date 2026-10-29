import numpy as np
import sonore as so

from sonore_sketch import live
from sonore_sketch.sources import syllables


def columns(fs, samples, sizes):
    """live.LiveSpectrogram's columns for `samples` cut into blocks of `sizes` (cycled), joined."""
    picture, parts, at, i = live.LiveSpectrogram(fs), [], 0, 0
    while at < len(samples):
        block = samples[at : at + sizes[i % len(sizes)]]
        at, i = at + len(block), i + 1
        parts.append(picture.step(np.asarray(block, dtype="<f4").tobytes()))
    parts.append(picture.finish())
    parts = [part for part in parts if part is not None]
    assert [part["first"] for part in parts] == list(np.cumsum([0] + [part["n_windows"] for part in parts[:-1]]))
    n_freqs = parts[0]["n_freqs"]
    return np.concatenate([np.frombuffer(part["data"], np.uint8).reshape(n_freqs, part["n_windows"]) for part in parts], axis=1)


def test_the_live_picture_is_the_recordings_stft_whatever_the_blocks():
    fs = 48000
    samples = 0.5 * syllables(1.0, fs).normalize().data[:, 0] / 4
    whole = columns(fs, samples, [len(samples)])
    np.testing.assert_array_equal(columns(fs, samples, [2400]), whole)  # 50 ms blocks, as the page sends
    np.testing.assert_array_equal(columns(fs, samples, [128, 1000, 7]), whole)
    frame = so.GaborFrame(live.WINDOW_S, live.HOP_S)
    assert whole.shape[1] == frame.analyze(so.Sound(samples, fs)).data.shape[-1]


def test_levels_are_below_a_full_scale_sine_up_to_8_khz():
    fs = 44100
    t = np.arange(fs // 2) / fs
    picture = columns(fs, np.sin(2 * np.pi * 1000 * t), [2205])
    assert picture.max() == 255 and picture.shape[0] == int(live.F_MAX // (fs / round(live.WINDOW_S * fs))) + 1
    quiet = columns(fs, 0.01 * np.sin(2 * np.pi * 1000 * t), [2205])
    assert abs(int(quiet.max()) - round(255 * (1 - 40 / 70))) <= 1  # 40 dB down
    assert columns(fs, np.zeros(1000), [1000]).max() == 0


def test_the_live_pitch_is_f0_track_decided_50_ms_late_whatever_the_blocks():
    fs = 16000
    sound = syllables(1.0, fs)
    samples = sound.data[:, 0]

    def tracked(sizes):
        pitch, parts, at, i = live.LivePitch(fs), [], 0, 0
        while at < len(samples):
            block = samples[at : at + sizes[i % len(sizes)]]
            at, i = at + len(block), i + 1
            parts.append(pitch.step(np.asarray(block, dtype="<f4").tobytes()))
        parts = [part for part in [*parts, pitch.finish()] if part is not None]
        return np.concatenate([part["t"] for part in parts]), np.concatenate([part["f0"] for part in parts])

    batch = so.f0_track(so.Sound(np.asarray(samples, dtype="<f4").astype(float), fs), delay=0.05)
    for sizes in ([800], [160, 1000, 37]):
        t, f0 = tracked(sizes)
        np.testing.assert_array_equal(t, batch.t)
        np.testing.assert_array_equal(f0, np.asarray(batch.f0).reshape(-1))
    assert (f0 > 0).any()


def test_a_recordings_live_pitch_is_used_instead_of_tracking_it_again():
    import base64

    from sonore_sketch import draw_voice

    fs = 16000
    sound = syllables(1.0, fs)
    pcm = np.round(sound.data[:, 0] / np.abs(sound.data).max() * 32000).astype("<i2")
    from test_draw_voice import STATE

    state = {**STATE, "source": "file", "recording": {"name": "Recording 1", "fs": fs, "pcm16": base64.b64encode(pcm.tobytes()).decode()}}
    pitch = {"t": [0.0, 0.005], "f0": [140.0, 0.0]}  # cut short on purpose: the rest is unvoiced
    work, texts = draw_voice.measure_steps(state, pitch), []
    while True:
        try:
            texts.append(next(work)[1])
        except StopIteration as done:
            _sound, voice = done.value
            break
    assert "Tracking the pitch" not in texts
    assert voice["f0"][:2] == [140.0, 0.0] and not any(voice["f0"][2:]) and len(voice["t"]) == 200
