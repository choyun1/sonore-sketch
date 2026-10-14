// The Draw path tab: draw where a sound goes around the listener on a top
// view, and how high it is on an elevation track below, and hear it move
// through sonore's move_sound (docs/design/tabs/paths.md).
//
// One stroke on the top view is one path: drawing again replaces it. The
// stroke keeps the pointer's own timing, so how fast you draw is how fast
// the sound moves (W6). The elevation track is drawn freehand over the
// page's time, like a track on the Draw speech tab, and replaces what it
// passes over.

import { drawAxisName, drawBorder, drawPlayhead, drawTimeTicks, drawValueTicks, fitCanvasInCssPixels, pointerPosition } from "../plot.js";
import { replaceSpan, simplify } from "../tracks/model.js";
import {
  ELEVATION_RANGE,
  HALF_WIDTH,
  MAX_POINTS,
  MEASURED_DISTANCE,
  MIN_DISTANCE,
  ROOMS,
  SOURCES,
  elevationAt,
  elevationPoints,
  positionAt,
  strokePoint,
  withElevation,
} from "./model.js";

const TOP_MARGIN = 22; // px around the top view, for the words front, back, left and right
const TRACK_MARGIN = { left: 52, right: 10, top: 8, bottom: 22 };
const RINGS = [0.5, 1, 2, 3, 4]; // m
const LABEL_ANGLE = Math.PI / 6; // where the rings are labeled, below the horizontal
const ELEVATION_TICKS = [-40, 0, 45, 90];
const ELEVATION_TOLERANCE = 1.5; // degrees, how far a simplified elevation stroke may stray
const HEAD_RADIUS = 0.0875; // m, a KEMAR-sized head, drawn to scale

export function createPathsTab(root, { commit, hasRecording }) {
  let state = null;
  let drawing = null; // the stroke being drawn on the top view, [[t, x, y], ...]
  let started = 0; // its first event's time stamp, ms
  let lifting = null; // the elevation stroke being drawn, [[t, degrees], ...]
  let playhead = null;

  root.innerHTML = `
    <div class="paths-body">
      <div class="paths-area">
        <canvas class="top-view" aria-label="The listener seen from above, nose up; draw where the sound goes"></canvas>
        <canvas class="elevation" aria-label="Elevation over time, from 40 degrees below ear height to straight up"></canvas>
      </div>
      <aside class="side">
        <fieldset><legend>Sound</legend>
          <label class="field" title="What moves along the path">Source
            <select class="source">${SOURCES.map(([id, label]) => `<option value="${id}">${label}</option>`).join("")}</select></label>
          <label class="field" title="Dry, or with a room's reverberation, which stays put while the source moves">Room
            <select class="room">${ROOMS.map(([id, label]) => `<option value="${id}">${label}</option>`).join("")}</select></label>
          <button type="button" class="level" title="Put the whole path back at ear height">Elevation back to 0°</button>
        </fieldset>
        <p class="hint">Use headphones. Drag on the top view to draw where the sound goes: the speed you draw is the speed it moves, stretched to the duration. Drag on the elevation track below to raise or lower it. Space plays.</p>
        <p class="hint">The head is MIT's KEMAR mannequin, measured at 1.4 m (the dashed ring); nearer and farther, only level and delay change. Elevation from a borrowed head is the weakest of the cues.</p>
      </aside>
    </div>`;
  const query = (selector) => root.querySelector(selector);
  const top = query("canvas.top-view");
  const track = query("canvas.elevation");
  const ui = { source: query(".source"), room: query(".room"), level: query(".level") };

  const style = (name, fallback) => getComputedStyle(root).getPropertyValue(name).trim() || fallback;

  function showSettings() {
    ui.source.value = state.source;
    ui.room.value = state.room;
    ui.source.querySelector('option[value="file"]').disabled = !hasRecording() && state.source !== "file";
    ui.level.disabled = state.elevation === 0;
  }
  ui.source.addEventListener("change", () => commit({ ...state, source: ui.source.value }));
  ui.room.addEventListener("change", () => commit({ ...state, room: ui.room.value }));
  ui.level.addEventListener("click", () => commit({ ...state, elevation: 0 }));

  // --- the top view ----------------------------------------------------------------

  function view() {
    const width = top.clientWidth || 400;
    const height = top.clientHeight || 400;
    const center = [width / 2, height / 2];
    const scale = (Math.min(width, height) / 2 - TOP_MARGIN) / HALF_WIDTH; // px per m
    return {
      width, height, scale,
      toPixels: ([x, y]) => [center[0] + x * scale, center[1] - y * scale],
      toMeters: ([px, py]) => [
        Math.max(-HALF_WIDTH, Math.min(HALF_WIDTH, (px - center[0]) / scale)),
        Math.max(-HALF_WIDTH, Math.min(HALF_WIDTH, (center[1] - py) / scale)),
      ],
      center,
    };
  }

  function drawStroke(context, plot, stroke, color, width) {
    if (!stroke.length) return;
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = width;
    context.lineJoin = context.lineCap = "round";
    context.beginPath();
    stroke.forEach(([, x, y], i) => {
      const [px, py] = plot.toPixels([x, y]);
      if (i) context.lineTo(px, py);
      else context.moveTo(px, py);
    });
    context.stroke();
    const [sx, sy] = plot.toPixels(stroke[0].slice(1));
    context.beginPath();
    context.arc(sx, sy, 4, 0, 2 * Math.PI);
    context.fill();
    // an arrowhead at the end, along the last few centimeters drawn
    const end = stroke[stroke.length - 1];
    const back = [...stroke].reverse().find(([, x, y]) => Math.hypot(x - end[1], y - end[2]) > 0.1);
    if (!back) return;
    const [ex, ey] = plot.toPixels(end.slice(1));
    const [bx, by] = plot.toPixels(back.slice(1));
    const angle = Math.atan2(ey - by, ex - bx);
    context.beginPath();
    context.moveTo(ex, ey);
    context.lineTo(ex - 11 * Math.cos(angle - 0.45), ey - 11 * Math.sin(angle - 0.45));
    context.lineTo(ex - 11 * Math.cos(angle + 0.45), ey - 11 * Math.sin(angle + 0.45));
    context.closePath();
    context.fill();
  }

  function renderTop() {
    const context = fitCanvasInCssPixels(top);
    const plot = view();
    const [cx, cy] = plot.center;
    const ink = style("--ink", "#1d232b");
    const muted = style("--muted", "#6b7280");
    const line = style("--line", "#e3e1db");
    const accent = style("--accent", "#2e86ab");
    context.clearRect(0, 0, plot.width, plot.height);
    context.font = "11px system-ui, sans-serif";

    // distance rings, the measured one dashed, and the region too close to render
    context.lineWidth = 1;
    for (const radius of RINGS) {
      context.strokeStyle = line;
      context.beginPath();
      context.arc(cx, cy, radius * plot.scale, 0, 2 * Math.PI);
      context.stroke();
      // labeled below and to the right, out of the way of the words front, back, left and right
      context.fillStyle = muted;
      context.textAlign = "left";
      context.textBaseline = "top";
      context.fillText(`${radius} m`, cx + radius * plot.scale * Math.cos(LABEL_ANGLE) + 2, cy + radius * plot.scale * Math.sin(LABEL_ANGLE));
    }
    context.strokeStyle = muted;
    context.setLineDash([4, 4]);
    context.beginPath();
    context.arc(cx, cy, MEASURED_DISTANCE * plot.scale, 0, 2 * Math.PI);
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = muted;
    context.textAlign = "right";
    context.textBaseline = "top";
    context.fillText("measured", cx - MEASURED_DISTANCE * plot.scale * Math.cos(LABEL_ANGLE) - 2, cy + MEASURED_DISTANCE * plot.scale * Math.sin(LABEL_ANGLE));
    context.fillStyle = "rgba(128, 128, 128, 0.12)";
    context.beginPath();
    context.arc(cx, cy, MIN_DISTANCE * plot.scale, 0, 2 * Math.PI);
    context.fill();

    // the head, nose up, with its ears
    const head = Math.max(5, HEAD_RADIUS * plot.scale);
    context.strokeStyle = ink;
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(cx - head * 0.35, cy - head * 0.93);
    context.lineTo(cx, cy - head * 1.45);
    context.lineTo(cx + head * 0.35, cy - head * 0.93);
    context.stroke();
    context.beginPath();
    context.arc(cx, cy, head, 0, 2 * Math.PI);
    context.stroke();
    for (const side of [-1, 1]) {
      context.beginPath();
      context.ellipse(cx + side * head * 1.08, cy, head * 0.18, head * 0.4, 0, 0, 2 * Math.PI);
      context.stroke();
    }

    context.fillStyle = muted;
    context.textAlign = "center";
    context.textBaseline = "top";
    context.fillText("front", cx, 4);
    context.textBaseline = "bottom";
    context.fillText("back", cx, plot.height - 4);
    context.textBaseline = "middle";
    context.textAlign = "left";
    context.fillText("left", 4, cy);
    context.textAlign = "right";
    context.fillText("right", plot.width - 4, cy);

    const shown = drawing ?? state?.stroke ?? [];
    drawStroke(context, plot, shown, accent, 2.5);
    if (!shown.length) {
      context.fillStyle = muted;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText("Drag to draw where the sound goes", cx, cy + 2.2 * plot.scale);
    }

    if (playhead !== null && state?.stroke.length && !drawing) {
      const at = positionAt(state.stroke, state.duration, playhead);
      const [px, py] = plot.toPixels(at);
      context.fillStyle = style("--error", "#d1495b");
      context.beginPath();
      context.arc(px, py, 7, 0, 2 * Math.PI);
      context.fill();
      const elevation = elevationAt(state, state.duration, playhead);
      if (elevation) {
        context.textAlign = "left";
        context.textBaseline = "middle";
        context.fillText(`${Math.round(elevation)}°`, px + 10, py);
      }
    }
  }

  const fromTop = (event) => view().toMeters(pointerPosition(top, event));

  top.addEventListener("pointerdown", (event) => {
    if (!state || event.button !== 0) return;
    event.preventDefault();
    top.setPointerCapture(event.pointerId);
    started = event.timeStamp;
    drawing = [strokePoint(0, ...fromTop(event))];
    renderTop();
  });
  top.addEventListener("pointermove", (event) => {
    if (!drawing) return;
    const moves = event.getCoalescedEvents?.() ?? [];
    for (const move of moves.length ? moves : [event]) {
      if (drawing.length >= MAX_POINTS) break;
      const t = Math.max(drawing[drawing.length - 1][0], (move.timeStamp - started) / 1000);
      drawing.push(strokePoint(t, ...fromTop(move)));
    }
    renderTop();
  });
  function finishStroke(event) {
    if (!drawing) return;
    const stroke = drawing;
    drawing = null;
    if (event.type === "pointercancel") return renderTop();
    commit({ ...state, stroke });
  }
  top.addEventListener("pointerup", finishStroke);
  top.addEventListener("pointercancel", finishStroke);

  // --- the elevation track ------------------------------------------------------------

  function trackPlot() {
    const width = track.clientWidth || 400;
    const height = track.clientHeight || 120;
    const [x0, x1, y0, y1] = [TRACK_MARGIN.left, width - TRACK_MARGIN.right, TRACK_MARGIN.top, height - TRACK_MARGIN.bottom];
    const [low, high] = ELEVATION_RANGE;
    return {
      width, height, x0, x1, y0, y1,
      x: (t) => x0 + (t / state.duration) * (x1 - x0),
      y: (degrees) => y1 - ((degrees - low) / (high - low)) * (y1 - y0),
      at: ([px, py]) => [
        Math.min(state.duration, Math.max(0, ((px - x0) / (x1 - x0)) * state.duration)),
        Math.min(high, Math.max(low, low + ((y1 - py) / (y1 - y0)) * (high - low))),
      ],
    };
  }

  function renderTrack() {
    if (!state) return;
    const context = fitCanvasInCssPixels(track);
    const plot = trackPlot();
    context.clearRect(0, 0, plot.width, plot.height);
    drawBorder(context, track, plot);
    drawValueTicks(context, plot, ELEVATION_TICKS, plot.y, (degrees) => `${degrees}°`, { gridColor: style("--grid", "#eeece6") });
    drawAxisName(context, plot, "elevation");
    drawTimeTicks(context, plot, state.duration, 5);
    const points = elevationPoints(state, state.duration);
    const shown = lifting ? replaceSpan(points, [...lifting].sort((a, b) => a[0] - b[0])) : points;
    context.strokeStyle = style("--accent", "#2e86ab");
    context.lineWidth = 2;
    context.beginPath();
    const ends = [[0, shown[0][1]], ...shown, [state.duration, shown[shown.length - 1][1]]];
    ends.forEach(([t, degrees], i) => (i ? context.lineTo(plot.x(t), plot.y(degrees)) : context.moveTo(plot.x(t), plot.y(degrees))));
    context.stroke();
    if (playhead !== null) drawPlayhead(context, plot, plot.x(playhead), style("--error", "#d1495b"));
  }

  const fromTrack = (event) => trackPlot().at(pointerPosition(track, event));

  track.addEventListener("pointerdown", (event) => {
    if (!state || event.button !== 0) return;
    event.preventDefault();
    track.setPointerCapture(event.pointerId);
    lifting = [fromTrack(event)];
    renderTrack();
  });
  track.addEventListener("pointermove", (event) => {
    if (!lifting) return;
    const moves = event.getCoalescedEvents?.() ?? [];
    for (const move of moves.length ? moves : [event]) lifting.push(fromTrack(move));
    renderTrack();
  });
  function finishLift(event) {
    if (!lifting) return;
    const span = simplify(lifting, ELEVATION_TOLERANCE);
    lifting = null;
    if (event.type === "pointercancel") return renderTrack();
    commit(withElevation(state, replaceSpan(elevationPoints(state, state.duration), span)));
  }
  track.addEventListener("pointerup", finishLift);
  track.addEventListener("pointercancel", finishLift);

  function render() {
    if (!state) return;
    renderTop();
    renderTrack();
  }
  new ResizeObserver(render).observe(top);
  new ResizeObserver(render).observe(track);

  return {
    id: "paths",
    figure: top.parentElement, // where the shell shows synthesis progress
    setDocument(next) {
      drawing = lifting = null;
      state = next;
      showSettings();
      render();
    },
    setResult() {},
    setPlayhead(t) {
      playhead = t;
      render();
    },
    blocked() {
      if (!state.stroke.length) return "No path yet: drag on the top view to draw one.";
      if (state.source === "file" && !hasRecording()) return "No recording: open one on an Erase tab (links do not carry recordings).";
      return null;
    },
    key() {
      return false;
    },
  };
}
