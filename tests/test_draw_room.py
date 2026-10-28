import numpy as np
import pytest
import sonore as so

from sonore_sketch import draw_room, page

F = draw_room.points()
STATE = {
    "draw_room": 1, "sonore": "0.9.0", "duration": 1.0, "fs": 16000, "source": "clap",
    "rt60": np.round(so.band_rt60s(0.6, F), 3).tolist(), "drr_db": 0.0, "seed": 1,
}


def test_the_points_run_from_50_hz_to_8_khz_on_a_log_axis():
    assert len(F) == draw_room.N_POINTS and F[0] == 50 and F[-1] == 8000
    np.testing.assert_allclose(F, np.geomspace(50, 8000, draw_room.N_POINTS), atol=0.05)  # rounded to 0.1 Hz


def test_the_result_is_two_channels_and_keeps_the_rooms_tail():
    sound, ir = draw_room.shared.finish(draw_room.steps(STATE))
    assert sound.n_channels == ir.n_channels == 2 and sound.fs == 16000
    assert sound.n_samples == 16000 + ir.n_samples - 1  # the source and the whole tail (R8)
    assert sound.rms == pytest.approx(1) and np.isfinite(sound.data).all()
    assert abs(np.corrcoef(sound.data[2000:, 0], sound.data[2000:, 1])[0, 1]) < 0.2  # two independent tails (R7)


def test_the_clap_is_one_click_so_the_result_is_the_room_itself():
    sound, ir = draw_room.shared.finish(draw_room.steps(STATE))
    start = round(draw_room.CLAP_AT * 16000)
    room = sound.data[start:start + ir.n_samples]
    np.testing.assert_allclose(room / np.abs(room).max(), ir.data / np.abs(ir.data).max(), atol=1e-9)


def test_the_room_is_sonores_from_the_curve():
    ir = draw_room.room(STATE)
    expected = so.synth_ir((F, np.asarray(STATE["rt60"])), 16000, drr_db=0.0, n_channels=2, rng=1)
    np.testing.assert_array_equal(ir.data, expected.data)


def test_the_measured_rt60_follows_the_drawing():
    # a boomy room: long at low frequencies, short at high (draw_room.md, V3)
    state = {**STATE, "rt60": np.round(np.geomspace(3.0, 0.3, draw_room.N_POINTS), 3).tolist()}
    measured = draw_room.measured(draw_room.room(state))
    f, rt60 = np.asarray(measured["f"]), np.asarray([np.nan if v is None else v for v in measured["rt60"]])
    drawn = np.exp(np.interp(np.log(f), np.log(F), np.log(state["rt60"])))
    assert np.nanmedian(np.abs(rt60 / drawn - 1)) < 0.15
    assert rt60[np.argmin(np.abs(f - 150))] > 3 * rt60[np.argmin(np.abs(f - 5000))]


def test_a_louder_direct_sound_makes_less_room():
    def tail_share(drr):
        ir = draw_room.room({**STATE, "drr_db": drr})
        return np.sum(ir.data[1:] ** 2) / np.sum(ir.data**2)

    assert tail_share(20.0) < tail_share(0.0) < tail_share(-20.0)


def test_the_seed_changes_the_room_and_the_same_seed_gives_the_same_sound():
    one = draw_room.synthesize(STATE)
    np.testing.assert_array_equal(one.data, draw_room.synthesize(STATE).data)
    assert not np.array_equal(one.data, draw_room.synthesize({**STATE, "seed": 2}).data)


@pytest.mark.parametrize("change, message", [
    ({"rt60": [1.0] * 10}, "'rt60' must be 64"),
    ({"rt60": [20.0] * 64}, "'rt60' must be 64"),
    ({"drr_db": 30}, "'drr_db'"),
    ({"source": "noise"}, "'source'"),
    ({"seed": -1}, "'seed'"),
])
def test_check_refuses_what_it_cannot_use(change, message):
    with pytest.raises(ValueError, match=message):
        draw_room.check({**STATE, **change})


def test_the_page_returns_the_room_and_its_measured_rt60():
    result = page.handle({"tab": "draw_room", "state": STATE})
    assert "samples_right" in result and result["room_stft"]["n_windows"] > 0
    assert len(result["measured"]["f"]) == len(result["measured"]["rt60"]) == 30


def test_the_source_can_be_another_tabs_sound():
    sound = draw_room.synthesize({**STATE, "source": "syllables"})
    assert sound.rms == pytest.approx(1)
