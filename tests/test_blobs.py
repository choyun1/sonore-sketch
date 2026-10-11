import json
import re
from pathlib import Path

import numpy as np
import pytest
import sonore as so

from sonore_sketch import blobs, page

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "blob_power.json"


def state(**changes):
    return {
        "blobs": 1, "sonore": "0.6.0", "duration": 1.0, "fs": 16000,
        "f_lo": 100, "f_hi": 6400, "bands_per_octave": 12,
        "carrier": "tones", "iterations": 0, "rms_depth": 0.2, "seed": 1,
        "items": [dict(item) for item in blobs.B9_ITEMS],  # the drawing the measurements use
    } | changes


def picture_fixture():
    """What the page's picture must agree with (tests/js/blobs.test.mjs):
    from_blobs's grid, and its level at some cells, in dB below its peak."""
    drawing = state(items=[*blobs.B9_ITEMS, {"rate": -6, "density": 2, "rate_width": 0.3, "density_width": 0.5, "level": -6}])
    spectrum = blobs.target(drawing)
    level = spectrum.level - spectrum.level.max()
    points = []
    for j in range(0, 18, 1):
        for i in np.flatnonzero((np.abs(spectrum.w_t) >= 1) & (np.abs(spectrum.w_t) <= 20)):
            if level[j, i] > -40:
                points.append([round(float(spectrum.w_t[i]), 6), round(float(spectrum.w_f[j]), 6), round(float(level[j, i]), 4)])
    return {
        "state": {k: drawing[k] for k in ("duration", "f_lo", "f_hi", "bands_per_octave", "items")},
        "rate_step": float(spectrum.w_t[1] - spectrum.w_t[0]),
        "n_rates": len(spectrum.w_t),
        "density_step": float(spectrum.w_f[1]),
        "n_densities": len(spectrum.w_f),
        "points": points,
    }


def test_the_pages_picture_fixture_is_what_sonore_draws():
    # Regenerate with: python tests/test_blobs.py
    saved, now = json.loads(FIXTURE.read_text()), json.loads(json.dumps(picture_fixture()))
    assert saved["state"] == now["state"] and saved["n_rates"] == now["n_rates"] and saved["n_densities"] == now["n_densities"]
    assert saved["rate_step"] == pytest.approx(now["rate_step"]) and saved["density_step"] == pytest.approx(now["density_step"])
    assert np.array(saved["points"]) == pytest.approx(np.array(now["points"]), abs=1e-3)


def test_the_page_starts_from_the_same_example():
    model = (ROOT / "app" / "blobs" / "model.js").read_text()
    block = re.search(r"EXAMPLE_ITEMS = \[(.*?)\];", model, re.S).group(1)
    items = [{k: float(v) for k, v in re.findall(r"(\w+): (-?[0-9.]+)", entry)} for entry in re.findall(r"\{([^}]*)\}", block)]
    assert items == blobs.EXAMPLE_ITEMS


@pytest.mark.parametrize("carrier", ["tones", "harmonic"])
def test_a_blob_is_heard_where_it_is_drawn(carrier):
    # blobs.md, B-M2, as a test: at 3 s, the result's measured modulation
    # peaks within the blob's width of where it was drawn.
    sound = blobs.synthesize(state(duration=3.0, carrier=carrier, items=[{"rate": 8, "density": 1, "rate_width": 0.3, "density_width": 0.25, "level": 0}]))
    measured = so.ModulationSpectrum.octave(sound, f_lo=100, f_hi=6400)
    # Rate 0 is left out: no blob can be there, and a harmonic complex's own
    # static spectral ripple (its harmonics) is.
    rates = (np.abs(measured.w_t) <= 40) & (np.abs(measured.w_t) >= 1)
    near = rates[None, :] & (measured.w_f <= 4)[:, None]
    j, i = np.unravel_index(np.argmax(np.where(near, measured.level, -np.inf)), measured.level.shape)
    assert 8 * 2**-0.6 <= measured.w_t[i] <= 8 * 2**0.6 and abs(measured.w_f[j] - 1) <= 0.5


def test_the_harmonic_carrier_is_a_harmonic_complex_on_f0():
    data = blobs.synthesize(state(carrier="harmonic", f0=125)).mono().data[:, 0]
    spectrum = np.abs(np.fft.rfft(data * np.hanning(len(data)))) ** 2
    f = np.fft.rfftfreq(len(data), 1 / 16000)
    on = np.isin(np.round(f), 125 * np.arange(1, 52))  # 1 Hz bins: the harmonics' own
    assert spectrum[on].sum() / spectrum.sum() > 0.5  # mostly at harmonics, though the envelopes widen each


@pytest.mark.parametrize("bands", [[], [{"points": [[0, 500], [1, 2000]], "width": 1.0, "level": 0.0}]])
def test_steps_report_progress_and_give_the_same_sound(bands):
    drawing = state(iterations=3, bands=bands)
    work, fractions = blobs.steps(drawing), []
    while True:
        try:
            fractions.append(next(work))
        except StopIteration as done:
            sound = done.value
            break
    assert fractions == pytest.approx([0.25, 0.5, 0.75, 1.0])
    assert np.array_equal(sound.data, blobs.synthesize(drawing).data)


def test_iterations_without_bands_are_to_sounds_own():
    drawing = state(carrier="noise", iterations=3)
    expected = blobs.target(drawing).to_sound(carrier="noise", fs=16000.0, rng=1, iterations=3)
    assert np.allclose(blobs.synthesize(drawing).data, expected.data, atol=1e-9)


def test_without_bands_iterations_are_refused_on_the_harmonic_carrier():
    with pytest.raises(ValueError, match="iterations"):
        blobs.synthesize(state(carrier="harmonic", iterations=2))


@pytest.mark.parametrize("carrier", blobs.CARRIERS)
def test_every_carrier_gives_the_same_samples_twice(carrier):
    a = blobs.synthesize(state(carrier=carrier))
    b = blobs.synthesize(state(carrier=carrier))
    assert a.duration == pytest.approx(1.0) and np.array_equal(a.data, b.data)
    assert np.sqrt(np.mean(a.data**2)) == pytest.approx(1)
    assert not np.array_equal(a.data, blobs.synthesize(state(carrier=carrier, seed=2)).data)


def test_too_deep_a_drawing_is_refused_with_the_depth_that_fits():
    with pytest.raises(ValueError, match=r"at most 0\.[0-9]+ fits"):
        blobs.synthesize(state(rms_depth=0.95))


def test_a_near_miss_is_heard_at_the_depth_that_fits():
    # Cho's report: "rms_depth 0.2 would push 0.0% ... at most 0.2 fits it".
    with pytest.raises(ValueError) as refusal:
        blobs.synthesize(state(rms_depth=0.95))
    fits = blobs.depth_that_fits(str(refusal.value))
    sound = blobs.synthesize(state(rms_depth=round(fits * 1.05, 3)))
    assert sound.rms == pytest.approx(1)
    with pytest.raises(ValueError, match="at most"):
        blobs.synthesize(state(rms_depth=round(fits * 1.2, 3)))


def test_no_blobs_says_so():
    with pytest.raises(ValueError, match="no blobs yet"):
        blobs.synthesize(state(items=[]))


@pytest.mark.parametrize(
    "changes, message",
    [
        ({"blobs": 2}, "format 1"),
        ({"f_hi": 8000}, "fs/2"),
        ({"carrier": "pink"}, "carrier"),
        ({"carrier": "harmonic", "f0": 5}, "f0"),
        ({"carrier": "harmonic", "iterations": 2, "items": []}, None),
        ({"iterations": 11}, "iterations"),
        ({"rms_depth": 0}, "rms_depth"),
        ({"items": [{"rate": 0, "density": 0, "rate_width": 0.5, "density_width": 0.25, "level": 0}]}, "nonzero rate"),
        ({"items": [{"rate": 4}]}, "a number for each"),
        ({"items": [dict(blobs.EXAMPLE_ITEMS[0])] * 9}, "at most 8"),
    ],
)
def test_bad_states_are_refused(changes, message):
    if message is None:  # allowed by check
        return blobs.check(state(**changes))
    with pytest.raises(ValueError, match=message):
        blobs.check(state(**changes))


def test_a_saved_page_on_the_modulation_tab_sounds_as_the_tab_does():
    section = {k: v for k, v in state().items() if k not in ("blobs", "sonore", "duration", "fs")}
    document = {
        "app": "sonore-sketch", "version": 2, "sonore": "0.6.0", "duration": 1.0, "fs": 16000,
        "tab": "blobs", "tracks": {"mode": "klatt", "params": {}}, "blobs": section,
    }
    assert np.array_equal(page.synthesize(document).data, blobs.synthesize(state()).data)


# --- bands (docs/design/tabs/bands.md) ---------------------------------------------


def band(points, width=1.0, level=0.0):
    return {"points": [list(p) for p in points], "width": width, "level": level}


def band_levels(sound, t0=0.0, t1=None):
    """Long-term level [dB] per 1/12-octave band between ``t0`` and ``t1``."""
    bank = so.cosine_filterbank(f_lo=100, f_hi=6400, spacing=1 / 12, scale="octave")
    env = bank.analyze(sound).envelopes(fs=1000).data.mean(axis=2)
    env = env[int(t0 * 1000) : None if t1 is None else int(t1 * 1000)]
    return bank.cfs, 10 * np.log10(np.mean(env**2, axis=0) + 1e-20)


def test_no_bands_is_the_sound_as_before():
    plain = blobs.synthesize(state())
    assert np.array_equal(blobs.synthesize(state(bands=[])).data, plain.data)


@pytest.mark.parametrize("carrier", blobs.CARRIERS)
def test_a_band_keeps_the_sound_inside_it(carrier):
    # bands.md, K-M1, as a test: 45-58 dB measured; 40 dB asked.
    sound = blobs.synthesize(state(carrier=carrier, bands=[band([(0, 1000)])]))
    cfs, level = band_levels(sound)
    distance = np.abs(np.log2(cfs / 1000))
    power = 10 ** (level / 10)
    assert 10 * np.log10(power[distance <= 0.5].mean() / power[distance >= 1].mean()) > 40
    assert sound.rms == pytest.approx(1)


def test_a_band_follows_its_track():
    sound = blobs.synthesize(state(duration=2.0, bands=[band([(0, 300), (2, 3000)], width=0.5)]))
    for t0, t1, hz in ((0.0, 0.3, 300 * 10 ** (0.15)), (1.7, 2.0, 3000 / 10 ** 0.15)):
        cfs, level = band_levels(sound, t0, t1)
        assert abs(np.log2(cfs[np.argmax(level)] / hz)) < 0.5


def test_a_bands_level_is_heard_and_bands_combine_by_the_largest_gain():
    sound = blobs.synthesize(state(bands=[band([(0, 400)], width=0.5), band([(0, 3200)], width=0.5, level=-20)]))
    cfs, level = band_levels(sound)
    assert level[np.argmin(np.abs(cfs - 400))] - level[np.argmin(np.abs(cfs - 3200))] == pytest.approx(20, abs=3)
    gain = blobs.band_gain([band([(0, 1000)]), band([(0, 1000)], level=-6)], np.array([1000.0]), np.array([0.0]))
    assert gain[0, 0] == pytest.approx(1)


def drawn_contrast(sound, drawing):
    """B-M4 of blobs.md on the measured plane within the bands."""
    drawn = blobs.target(drawing)
    near = ((np.abs(drawn.w_t) <= 32) & (np.abs(drawn.w_t) >= 1))[None, :] & (drawn.w_f <= 4)[:, None]
    inside = near & (drawn.level >= drawn.level[near].max() - 6)
    outside = near & (drawn.level <= drawn.level[near].max() - 30)
    power = 10 ** (blobs.measured(sound, drawing).level / 10)
    return 10 * np.log10(power[inside].mean() / power[outside].mean())


def test_with_bands_iterations_pull_the_sound_toward_the_blobs_and_the_bands_still_hold():
    # tools/measure_loop.py, "within": a gliding band, tones, 3 s, gains 4.4 dB at 10
    # iterations; the band still rejects 74 dB (static). Asked here: 2 dB at 5, and 40 dB.
    drawing = state(duration=3.0, bands=[band([(0, 500), (3, 4000)])])
    before = drawn_contrast(blobs.synthesize(drawing), drawing)
    after = drawn_contrast(blobs.synthesize(drawing | {"iterations": 5}), drawing)
    assert after - before > 2
    sound = blobs.synthesize(state(iterations=5, bands=[band([(0, 1000)])]))
    cfs, level = band_levels(sound)
    distance, power = np.abs(np.log2(cfs / 1000)), 10 ** (level / 10)
    assert 10 * np.log10(power[distance <= 0.5].mean() / power[distance >= 1].mean()) > 40
    assert sound.rms == pytest.approx(1)


def test_with_bands_iterations_work_on_the_harmonic_carrier_too():
    # bands.md, K-M5b: a gliding band, 3 s, 18.8 dB at 0 iterations and 26.0 dB at 5; asked here: 2 dB.
    drawing = state(duration=3.0, carrier="harmonic", bands=[band([(0, 500), (3, 4000)])])
    before = drawn_contrast(blobs.synthesize(drawing), drawing)
    after = drawn_contrast(blobs.synthesize(drawing | {"iterations": 5}), drawing)
    assert after - before > 2


@pytest.mark.parametrize(
    "bands, message",
    [
        ([band([(0, 1000)])] * 6, "at most 5"),
        ([band([(0, 1000)], width=0.1)], "width"),
        ([band([(0, 1000)], level=-50)], "level"),
        ([band([])], "points"),
        ([band([(0.5, 1000), (0.5, 2000)])], "times must increase"),
        ([band([(0, 1000), (2, 2000)])], "times must increase"),
        ([band([(0, 50)])], "centre"),
    ],
)
def test_bad_bands_are_refused(bands, message):
    with pytest.raises(ValueError, match=message):
        blobs.check(state(bands=bands))


def contrast(spectrum, drawn):
    """blobs.md, B-M4: measured power where the drawing is within 6 dB of its
    peak over where it is 30 dB or more below, 1 <= |rate| <= 32 Hz."""
    near = ((np.abs(drawn.w_t) <= 32) & (np.abs(drawn.w_t) >= 1))[None, :] & (drawn.w_f <= 4)[:, None]
    inside = near & (drawn.level >= drawn.level[near].max() - 6)
    outside = near & (drawn.level <= drawn.level[near].max() - 30)
    power = 10 ** (spectrum.level / 10)
    return 10 * np.log10(power[inside].mean() / power[outside].mean())


def test_the_measured_plane_is_the_results_own_modulation_spectrum():
    drawing = state(duration=3.0)
    sound = blobs.synthesize(drawing)
    ours, sonores = blobs.measured(sound, drawing), so.ModulationSpectrum.octave(sound, f_lo=100, f_hi=6400)
    assert np.allclose(ours.level, sonores.level) and np.allclose(ours.w_t, sonores.w_t)


def test_within_the_bands_a_moving_band_does_not_hide_the_blobs():
    # bands.md, K-M4: 10.5 dB over the whole range, 22.5 dB within the band.
    drawing = state(duration=3.0, bands=[band([(0, 500), (3, 4000)])])
    sound, drawn = blobs.synthesize(drawing), blobs.target(drawing)
    whole, within = contrast(blobs.measured(sound, state(duration=3.0)), drawn), contrast(blobs.measured(sound, drawing), drawn)
    assert whole < 15 and within > 18, (whole, within)


def test_the_page_gets_the_measured_plane_on_the_modulation_tab():
    result = page.handle({"tab": "blobs", "state": state()})
    picture = result["modulation"]
    assert len(picture["data"]) == picture["n_densities"] * picture["n_rates"]
    assert picture["rate_first"] == pytest.approx(-64, abs=picture["rate_step"]) and picture["n_densities"] >= 30
    assert max(picture["data"]) == 255


if __name__ == "__main__":
    FIXTURE.write_text(json.dumps(picture_fixture(), indent=0) + "\n")
    print(f"wrote {FIXTURE.relative_to(ROOT)}")
