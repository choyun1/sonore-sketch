"""The Draw path tab's Python half (docs/design/tabs/draw_path.md)."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest
import sonore as so

from sonore_sketch import draw_path
from sonore_sketch.page import handle


def state(stroke, **changes):
    return {"draw_path": 1, "sonore": "0.10.0", "duration": 1.0, "fs": 16000, "source": "noise", "room": "dry",
            "stroke": stroke, "elevation": 0, **changes}


def straight(x0, y0, x1, y1, seconds=1.0, n=61):
    return [[seconds * i / (n - 1), x0 + (x1 - x0) * i / (n - 1), y0 + (y1 - y0) * i / (n - 1)] for i in range(n)]


def test_the_hrirs_have_their_travel_time_put_back():
    # MIT KEMAR's files start about 0.6 ms before the sound reaches the ears;
    # 1.4 m at 343 m/s is 4.08 ms more (draw_path.md, W-M1)
    onsets = draw_path.hrirs()._onset_times(draw_path.hrirs().positions)
    assert 4.5e-3 < onsets.min() < onsets.max() < 5.5e-3


def test_the_path_renders_in_two_channels_at_the_tabs_rate():
    sound = draw_path.synthesize(state(straight(-2, 1, 2, 1)))
    assert sound.n_channels == 2 and sound.fs == draw_path.FS
    assert 1.0 <= sound.duration < 1.05  # and the last sound's travel time and the HRIRs' length


def test_a_source_on_the_right_is_louder_in_the_right_ear():
    sound = draw_path.synthesize(state([[0, 1.5, 0.0]]))  # one point: a still source
    left, right = np.sqrt(np.mean(sound.data**2, axis=0))
    assert 20 * np.log10(right / left) > 6


def test_a_path_close_to_the_head_renders():
    # without the travel time put back, move_sound refuses anything nearer than about 1.2 m
    sound = draw_path.synthesize(state(straight(-1, 0.3, 1, 0.3)))
    assert np.all(np.isfinite(sound.data)) and sound.rms > 0


def test_the_stroke_is_stretched_to_the_duration_and_keeps_its_pace():
    # drawn slowly for the first half of the stroke's time and fast after: the
    # first 1 m takes 0.8 s of drawing, the next 3 m 0.2 s
    stroke = [[0.0, -2.0, 1.0], [0.8, -1.0, 1.0], [1.0, 2.0, 1.0]]
    times, points = draw_path.trajectory(state(stroke, duration=2.0))
    assert times[-1] == pytest.approx(2.0)
    assert points[np.searchsorted(times, 0.8)][0] == pytest.approx(-1.5, abs=0.02)  # still in the slow part
    assert points[np.searchsorted(times, 1.8)][0] == pytest.approx(0.5, abs=0.05)  # halfway through the fast part


def test_smoothing_takes_out_the_pointers_steps_but_keeps_the_path():
    rng = np.random.default_rng(0)
    true = straight(-2, 1.5, 2, 1.5, seconds=2.0, n=121)
    jittered = [[t, x + rng.normal(0, 0.01), y] for t, x, y in true]
    times, points = draw_path.smoothed(jittered)
    speed = np.hypot(*np.diff(points, axis=0).T) / np.diff(times)
    drawn = np.asarray(jittered)
    raw_speed = np.hypot(*np.diff(drawn[:, 1:], axis=0).T) / np.diff(drawn[:, 0])
    # the true speed is 2 m/s throughout
    assert np.std(speed[10:-10] - 2.0) < np.std(raw_speed[5:-5] - 2.0) / 4
    assert np.max(np.abs(points[:, 1] - 1.5)) < 1e-9


def test_an_even_speed_track_moves_at_one_speed_whatever_the_drawing():
    # drawn slowly for the first meter and fast for the next three
    stroke = [[0.0, -2.0, 1.0], [0.8, -1.0, 1.0], [1.0, 2.0, 1.0]]
    times, points = draw_path.trajectory(state(stroke, duration=2.0, speed=[[0, 1], [1, 1]]))
    speed = np.hypot(*np.diff(points, axis=0).T) / np.diff(times)
    length = np.hypot(*np.diff(points, axis=0).T).sum()
    assert times[0] == 0 and times[-1] == pytest.approx(2.0)
    assert np.allclose(speed, length / 2.0)


def test_a_slower_part_of_the_speed_track_takes_longer():
    # the first half of the path at a quarter of the second half's speed
    times, points = draw_path.trajectory(state(straight(-2, 1, 2, 1), speed=[[0, 0.5, 0.5, 1], [1, 1, 4, 4]]))
    halfway = times[np.searchsorted(points[:, 0], 0.0)]
    assert halfway == pytest.approx(0.8, abs=0.01)  # 4 parts of time for the first half, 1 for the second


def test_the_speed_track_has_a_floor():
    # a speed of almost nothing takes at most 20 times as long as the fastest
    slow = draw_path.trajectory(state(straight(-2, 1, 2, 1), speed=[[0, 0.5, 0.5, 1], [1e-6, 1e-6, 1, 1]]))
    floor = draw_path.trajectory(state(straight(-2, 1, 2, 1), speed=[[0, 0.5, 0.5, 1], [0.05, 0.05, 1, 1]]))
    assert np.allclose(slow[0], floor[0])


def test_no_speed_track_keeps_the_drawings_timing():
    stroke = [[0.0, -2.0, 1.0], [0.8, -1.0, 1.0], [1.0, 2.0, 1.0]]
    assert all(np.array_equal(a, b) for a, b in zip(draw_path.trajectory(state(stroke)), draw_path.trajectory(state(stroke, speed=None))))


def test_the_shape_smoothing_takes_out_the_hands_wobble_and_keeps_straight_ends():
    rng = np.random.default_rng(0)
    wobbly = [[t, x, 1.5 + 0.05 * rng.standard_normal()] for t, x, _ in straight(-2, 1.5, 2, 1.5, seconds=2.0, n=121)]
    _, timed = draw_path.smoothed(wobbly, 0)  # the 30 ms Gaussian alone
    _, shaped = draw_path.smoothed(wobbly, 0.3)
    assert np.std(shaped[:, 1] - 1.5) < np.std(timed[:, 1] - 1.5) / 2
    _, line = draw_path.smoothed(straight(-2, 1.5, 2, 1.5), 0.3)
    _, unshaped = draw_path.smoothed(straight(-2, 1.5, 2, 1.5), 0)
    assert np.allclose(line, unshaped, atol=1e-9)  # mirrored at the ends, so a straight line stays put


def test_the_elevation_track_lifts_the_path_on_its_sphere():
    times, points = draw_path.trajectory(state([[0, 0.0, 2.0]], elevation=[[0, 1], [0, 90]]))
    distance = np.linalg.norm(points, axis=1)
    assert np.allclose(distance, 2.0)
    assert points[0, 2] == pytest.approx(0, abs=1e-9)
    assert points[-1, 2] == pytest.approx(2.0, abs=1e-6)  # straight up at the end


def test_the_path_keeps_out_of_the_head_and_within_the_measured_elevations():
    times, points = draw_path.trajectory(state([[0, 0.0, 0.01]], elevation=-80))
    _, elevation, _ = so.rect_to_hcc(*points.T)
    assert np.all(np.linalg.norm(points, axis=1) >= draw_path.MIN_DISTANCE - 1e-9)
    assert np.all(elevation >= -40 - 1e-9)


def test_handle_returns_both_ears():
    result = handle({"tab": "draw_path", "state": state(straight(-2, 1, 2, 1))})
    left = np.frombuffer(result["samples"], dtype="<f4")
    right = np.frombuffer(result["samples_right"], dtype="<f4")
    assert result["fs"] == draw_path.FS and left.shape == right.shape and not np.allclose(left, right)


@pytest.mark.parametrize("changes, message", [
    ({"stroke": []}, "no path drawn yet"),
    ({"stroke": [[0, 1, 1], [-1, 1, 1]]}, "must not go back"),
    ({"stroke": [[0, 1]]}, r"\[t, x, y\]"),
    ({"source": "drums"}, "'source'"),
    ({"room": "hall"}, "'room'"),
    ({"elevation": [[0], [1, 2]]}, "'elevation'"),
    ({"speed": [[0, 1], [1, 0]]}, "'speed'"),
    ({"speed": [[0, 2], [1, 1]]}, "'speed'"),
    ({"speed": 1}, "'speed'"),
    ({"smoothing": 1}, "'smoothing'"),
    ({"smoothing": -0.1}, "'smoothing'"),
    ({"duration": 31}, "'duration'"),
])
def test_bad_states_are_refused(changes, message):
    with pytest.raises(ValueError, match=message):
        draw_path.synthesize({**state(straight(-1, 1, 1, 1)), **changes})


@pytest.mark.skipif(shutil.which("node") is None, reason="needs node to run the page's model")
def test_the_page_puts_the_path_in_time_as_python_does():
    # the dot and the marker follow app/draw_path/model.js's timeline, which must
    # match the path the sound takes
    section = {"source": "noise", "room": "dry", "elevation": 0, "smoothing": 0.3,
               "stroke": [[0.0, -2.0, 1.0], [0.8, -1.0, 1.5], [1.0, 2.0, 1.0]]}
    script = (
        'import { timeline, withSpeed } from "./app/draw_path/model.js";'
        f"const section = withSpeed({json.dumps(section)}, {json.dumps([[0, 1], [0.3, 4], [1, 0.5]])});"
        "console.log(JSON.stringify({ section, path: timeline(section, 2) }));"
    )
    root = Path(__file__).resolve().parent.parent
    out = json.loads(subprocess.run(["node", "--input-type=module", "-e", script], cwd=root, check=True, capture_output=True, text=True).stdout)
    times, points = draw_path.trajectory(state(out["section"]["stroke"], duration=2.0, speed=out["section"]["speed"], smoothing=0.3))
    page_times, page_points = np.asarray(out["path"]["times"]), np.asarray(out["path"]["points"])
    keep = np.append(True, np.diff(page_times) > 0)
    assert np.allclose(times, page_times[keep], atol=1e-9)
    assert np.allclose(points[:, :2], page_points[keep], atol=1e-9)
