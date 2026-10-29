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
