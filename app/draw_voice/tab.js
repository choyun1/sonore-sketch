// The Draw a voice tab: a voice's source and filter drawn separately and put
// together by sonore's source_filter_synthesize (docs/design/tabs/draw_voice.md).
//
// The source is two tracks over the page's time, drawn freehand as on
// Scatter events: the pitch, on a log axis, which the Unvoice brush takes
// out, and the breathiness, the share of noise. The filter is a curve of
// level over frequency (an ERB axis) at each of a few moments, marked on the
// strip under the tracks: choose one to draw its curve, drag it to move it,
// double-click the strip to add one where you click. Under them, the
// result's spectrogram.

import {
  drawAxisName,
  drawBorder,
  drawPlayhead,
  drawTimeTicks,
  drawValueTicks,
  fitCanvasInCssPixels,
  frequencyLabel,
  logSpectrogramPlot,
  pointerPosition,
  soundSeconds,
} from "../plot.js";
import { extendStroke, replaceSpan, simplify } from "../draw_speech/model.js";
import {
  DB_RANGE,
  F0_RANGE,
  F_RANGE,
  MAX_MOMENTS,
  VOWELS,
  addMoment,
  curveAt,
  drawOnCurve,
  drawPitch,
  erbNumber,
  moveMoment,
  nearestPointIndex,
  pitchAt,
  removeMoment,
  trackPoints,
  unvoice,
  voicedRuns,
  withEnds,
  vowelCurve,
  withCurve,
  withTrack,
} from "./model.js";

const MARGIN = { left: 52, right: 10, top: 8, bottom: 22 };
const STRIP_MARGIN = { left: 52, right: 10, top: 4, bottom: 4 };
const FILTER_MARGIN = { left: 52, right: 10, top: 22, bottom: 34 };
const PITCH_TICKS = [50, 100, 200, 500];
const SHARE_TICKS = [0, 0.5, 1];
const DB_TICKS = [0, -20, -40, -60];
const FREQUENCY_TICKS = [100, 200, 500, 1000, 2000, 5000];
const PITCH_TOLERANCE = 0.01; // octaves a simplified pitch stroke may stray
const SHARE_TOLERANCE = 0.01; // of the share
const GRAB_PX = 8; // how near a moment's mark a press grabs it

export function createDrawVoiceTab(root, { commit }) {
  let state = null;
  let sound = null;
  let chosen = 0; // the moment whose curve is shown and drawn
  let brush = "draw"; // on the pitch track: "draw" or "unvoice"
  let stroke = null; // {canvas: "pitch" | "breath", points: [[t, value], ...]}
  let editedCurve = null; // the chosen curve while it is being drawn
  let lastOnCurve = null; // [ERB-number, dB] of the last pointer position on the filter
  let dragged = null; // {index, moved, section} while a moment's mark is dragged
  let playhead = null;

  root.innerHTML = `
    <div class="draw-voice-body">
      <div class="draw-voice-area">
        <canvas class="pitch" aria-label="The pitch over time, 50 to 500 Hz on a log axis; draw to change it, or unvoice a stretch"></canvas>
        <canvas class="breath" aria-label="The breathiness over time: the share of the voice's power that is noise; draw to change it"></canvas>
        <canvas class="moments" aria-label="The filter's moments: press one to choose it, drag to move it, double-click to add one"></canvas>
        <canvas class="filter" aria-label="The filter at the chosen moment: level in dB over frequency; draw to change it"></canvas>
        <canvas class="stft" aria-label="The result's spectrogram"></canvas>
      </div>
      <aside class="side">
        <fieldset><legend>Pitch brush</legend>
          <label class="check" title="Draw the pitch line; drawn over an unvoiced stretch, it voices it again"><input type="radio" name="voice-brush" value="draw" checked> Draw</label>
          <label class="check" title="Drag across the pitch track to make a stretch unvoiced: there the filter shapes noise only, as in a whisper or an s"><input type="radio" name="voice-brush" value="unvoice"> Unvoice</label>
        </fieldset>
        <fieldset><legend>Filter</legend>
          <p class="moment-name"></p>
          <label class="field" title="Set the chosen moment's curve to a vowel's (Peterson &amp; Barney's men's formants)">
            <select class="vowel"><option value="">Set to a vowel…</option>${VOWELS.map(([id, label]) => `<option value="${id}">${label}</option>`).join("")}</select></label>
          <button type="button" class="add" title="Add a moment halfway along the longest stretch without one, with the curve heard there">Add moment</button>
          <button type="button" class="remove" title="Remove the chosen moment (the last one stays)">Remove moment</button>
        </fieldset>
        <p class="hint">The source: drag on the pitch track to draw the pitch, or with Unvoice to take it out, and on the breathiness track to set how much of the voice is noise. The filter: each mark under the tracks is a moment with its own curve, and between moments the curve blends from one to the next. Choose a mark and draw its curve below; drag a mark to move it; double-click the strip to add one. Change the pitch and the vowel stays; change the curve and the pitch stays. Space plays.</p>
      </aside>
    </div>`;
  const query = (selector) => root.querySelector(selector);
  const canvases = { pitch: query("canvas.pitch"), breath: query("canvas.breath"), moments: query("canvas.moments"), filter: query("canvas.filter"), stft: query("canvas.stft") };
  const ui = { vowel: query(".vowel"), add: query(".add"), remove: query(".remove"), momentName: query(".moment-name"), brushes: [...root.querySelectorAll("input[name=voice-brush]")] };

  const style = (name, fallback) => getComputedStyle(root).getPropertyValue(name).trim() || fallback;
  const accent = () => style("--accent", "#2e86ab");
  const playColor = () => style("--error", "#d1495b");
  const section = () => dragged?.section ?? state;
  const pitchPoints = (voice) => withEnds(trackPoints(voice.f0), state.duration, pitchAt);

  // --- the side panel ------------------------------------------------------------------

  function showSettings() {
    const { moments } = section().filter;
    chosen = Math.min(chosen, moments.length - 1);
    ui.momentName.textContent = `Moment ${chosen + 1} of ${moments.length}, at ${moments[chosen].toFixed(2)} s`;
    ui.remove.disabled = moments.length <= 1;
    ui.add.disabled = moments.length >= MAX_MOMENTS;
    ui.vowel.value = "";
    for (const input of ui.brushes) input.checked = input.value === brush;
  }
  for (const input of ui.brushes) input.addEventListener("change", () => (brush = input.value));
  ui.vowel.addEventListener("change", () => {
    if (!ui.vowel.value) return;
    commit(withCurve(state, chosen, vowelCurve(ui.vowel.value, state.filter.f)));
  });
  ui.add.addEventListener("click", () => {
    // halfway along the longest stretch without a moment, the page's ends included
    const ends = [0, ...state.filter.moments, state.duration];
    let best = 0;
    for (let i = 1; i < ends.length - 1; i++) if (ends[i + 1] - ends[i] > ends[best + 1] - ends[best]) best = i;
    addAt((ends[best] + ends[best + 1]) / 2);
  });
  ui.remove.addEventListener("click", () => {
    const next = removeMoment(state, chosen);
    chosen = Math.max(0, chosen - 1);
    commit(next);
  });
  function addAt(t) {
    const added = addMoment(state, t);
    if (!added) return;
    chosen = added.index;
    commit(added.section);
  }

  // --- the time plots: pitch, breathiness, moments, spectrogram -------------------------

  function timePlot(canvas, margin, low, high, scale) {
    const width = canvas.clientWidth || 600;
    const height = canvas.clientHeight || 120;
    const [x0, x1, y0, y1] = [margin.left, width - margin.right, margin.top, height - margin.bottom];
    const map = scale === "log" ? Math.log2 : (v) => v;
    const [a, b] = [map(low), map(high)];
    return {
      width, height, x0, x1, y0, y1,
      x: (t) => x0 + (t / state.duration) * (x1 - x0),
      y: (value) => y1 - ((map(value) - a) / (b - a)) * (y1 - y0),
      t: (px) => Math.min(state.duration, Math.max(0, ((px - x0) / (x1 - x0)) * state.duration)),
      value: (py) => {
        const v = a + Math.min(1, Math.max(0, (y1 - py) / (y1 - y0))) * (b - a);
        return scale === "log" ? 2 ** v : v;
      },
    };
  }
  const pitchPlot = () => timePlot(canvases.pitch, MARGIN, F0_RANGE[0], F0_RANGE[1], "log");
  const breathPlot = () => timePlot(canvases.breath, MARGIN, 0, 1, "linear");
  const stripPlot = () => timePlot(canvases.moments, STRIP_MARGIN, 0, 1, "linear");

  function momentLines(context, plot, { marks = false } = {}) {
    const { moments } = section().filter;
    context.save();
    moments.forEach((t, i) => {
      const x = Math.round(plot.x(t)) + 0.5;
      context.strokeStyle = i === chosen ? accent() : style("--muted", "#6b7280");
      context.globalAlpha = i === chosen ? 0.9 : 0.45;
      context.setLineDash([3, 3]);
      context.beginPath();
      context.moveTo(x, plot.y0);
      context.lineTo(x, plot.y1);
      context.stroke();
      if (marks) {
        context.setLineDash([]);
        context.globalAlpha = 1;
        context.fillStyle = i === chosen ? accent() : style("--panel", "#fff");
        context.beginPath();
        context.moveTo(x, plot.y0 + 2);
        context.lineTo(x - 7, plot.y1 - 2);
        context.lineTo(x + 7, plot.y1 - 2);
        context.closePath();
        context.fill();
        context.stroke();
      }
    });
    context.restore();
  }

  function line(context, points, plot) {
    context.beginPath();
    points.forEach(([t, value], i) => (i ? context.lineTo(plot.x(t), plot.y(value)) : context.moveTo(plot.x(t), plot.y(value))));
    context.stroke();
  }

  // The pitch line as it is, or with the stroke being drawn laid in.
  function shownPitch() {
    const points = pitchPoints(section());
    if (stroke?.canvas !== "pitch") return points;
    const sorted = [...stroke.points].sort((a, b) => a[0] - b[0]);
    if (brush === "unvoice") return unvoice(points, sorted[0][0], sorted[sorted.length - 1][0]);
    return drawPitch(points, sorted);
  }

  function renderPitch() {
    const canvas = canvases.pitch;
    const context = fitCanvasInCssPixels(canvas);
    const plot = pitchPlot();
    context.clearRect(0, 0, plot.width, plot.height);
    drawBorder(context, canvas, plot);
    drawValueTicks(context, plot, PITCH_TICKS, plot.y, (f) => `${f}`, { gridColor: style("--grid", "#eeece6") });
    drawAxisName(context, plot, "pitch, Hz");
    drawTimeTicks(context, plot, state.duration, 5);
    momentLines(context, plot);
    const points = shownPitch();
    context.strokeStyle = accent();
    context.lineWidth = 2;
    for (const run of voicedRuns(points, state.duration)) line(context, run, plot);
    // unvoiced stretches: a band along the bottom
    context.fillStyle = style("--muted", "#6b7280");
    context.globalAlpha = 0.25;
    const step = state.duration / Math.max(1, plot.x1 - plot.x0);
    let start = null;
    for (let t = 0; t <= state.duration + step / 2; t += step) {
      const voiced = t <= state.duration && pitchAt(points, t) > 0;
      if (!voiced && start === null) start = t;
      if ((voiced || t > state.duration) && start !== null) {
        context.fillRect(plot.x(start), plot.y1 - 6, plot.x(Math.min(t, state.duration)) - plot.x(start), 6);
        start = null;
      }
    }
    context.globalAlpha = 1;
    if (stroke?.canvas === "pitch" && brush === "unvoice") {
      const ts = stroke.points.map(([t]) => t);
      context.fillStyle = "rgba(128, 128, 128, 0.2)";
      context.fillRect(plot.x(Math.min(...ts)), plot.y0, plot.x(Math.max(...ts)) - plot.x(Math.min(...ts)), plot.y1 - plot.y0);
    }
    if (playhead !== null) drawPlayhead(context, plot, plot.x(playhead), playColor());
  }

  function renderBreath() {
    const canvas = canvases.breath;
    const context = fitCanvasInCssPixels(canvas);
    const plot = breathPlot();
    context.clearRect(0, 0, plot.width, plot.height);
    drawBorder(context, canvas, plot);
    drawValueTicks(context, plot, SHARE_TICKS, plot.y, (share) => `${share * 100}%`, { gridColor: style("--grid", "#eeece6") });
    drawAxisName(context, plot, "noise");
    drawTimeTicks(context, plot, state.duration, 5);
    momentLines(context, plot);
    let points = withEnds(trackPoints(section().breathiness), state.duration);
    if (stroke?.canvas === "breath") points = replaceSpan(points, [...stroke.points].sort((a, b) => a[0] - b[0]));
    context.strokeStyle = accent();
    context.lineWidth = 2;
    line(context, [[0, points[0][1]], ...points, [state.duration, points[points.length - 1][1]]], plot);
    if (playhead !== null) drawPlayhead(context, plot, plot.x(playhead), playColor());
  }

  function renderStrip() {
    const canvas = canvases.moments;
    const context = fitCanvasInCssPixels(canvas);
    const plot = stripPlot();
    context.clearRect(0, 0, plot.width, plot.height);
    context.font = "11px system-ui, sans-serif";
    context.fillStyle = style("--muted", "#6b7280");
    context.textAlign = "right";
    context.textBaseline = "middle";
    context.fillText("filter", plot.x0 - 6, (plot.y0 + plot.y1) / 2);
    context.strokeStyle = style("--line", "#d5d9e0");
    context.beginPath();
    context.moveTo(plot.x0, (plot.y0 + plot.y1) / 2 + 0.5);
    context.lineTo(plot.x1, (plot.y0 + plot.y1) / 2 + 0.5);
    context.stroke();
    momentLines(context, plot, { marks: true });
    if (playhead !== null) drawPlayhead(context, plot, plot.x(playhead), playColor());
  }

  const stftPanel = logSpectrogramPlot(canvases.stft, MARGIN);
  function renderStft() {
    const context = stftPanel.clear();
    const fTop = (sound?.fs ?? state.fs) / 2;
    const plot = stftPanel.geometry(F_RANGE[0], fTop, sound ? soundSeconds(sound) : state.duration);
    stftPanel.draw(context, plot, sound?.spectrogram ?? null, { named: true });
    if (playhead !== null && playhead <= plot.duration) drawPlayhead(context, plot, plot.x(playhead), playColor());
  }

  // A stroke on the pitch or breathiness track.
  for (const name of ["pitch", "breath"]) {
    const canvas = canvases[name];
    const plotOf = name === "pitch" ? pitchPlot : breathPlot;
    const at = (event) => {
      const plot = plotOf();
      const [px, py] = pointerPosition(canvas, event);
      return [plot.t(px), plot.value(py)];
    };
    canvas.addEventListener("pointerdown", (event) => {
      if (!state || event.button !== 0) return;
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      stroke = { canvas: name, points: [at(event)] };
      render();
    });
    canvas.addEventListener("pointermove", (event) => {
      if (stroke?.canvas !== name) return;
      const moves = event.getCoalescedEvents?.() ?? [];
      for (const move of moves.length ? moves : [event]) extendStroke(stroke.points, at(move));
      name === "pitch" ? renderPitch() : renderBreath();
    });
    const finish = (event) => {
      if (stroke?.canvas !== name) return;
      const drawn = stroke.points;
      stroke = null;
      if (event.type === "pointercancel") return render();
      if (name === "breath") {
        const span = simplify(drawn, SHARE_TOLERANCE);
        return commit(withTrack(state, "breathiness", replaceSpan(withEnds(trackPoints(state.breathiness), state.duration), span)));
      }
      const sorted = [...drawn].sort((a, b) => a[0] - b[0]);
      if (brush === "unvoice") {
        if (sorted[sorted.length - 1][0] - sorted[0][0] < 0.005) return render(); // a click unvoices nothing
        return commit(withTrack(state, "f0", unvoice(pitchPoints(state), sorted[0][0], sorted[sorted.length - 1][0])));
      }
      // simplified in octaves, the axis it is drawn on
      const span = simplify(sorted.map(([t, f]) => [t, Math.log2(f)]), PITCH_TOLERANCE).map(([t, octave]) => [t, 2 ** octave]);
      commit(withTrack(state, "f0", drawPitch(pitchPoints(state), span)));
    };
    canvas.addEventListener("pointerup", finish);
    canvas.addEventListener("pointercancel", finish);
  }

  // The moments' strip: choose, drag, double-click to add.
  const strip = canvases.moments;
  function grabbed(px) {
    const plot = stripPlot();
    let best = -1;
    state.filter.moments.forEach((t, i) => {
      if (Math.abs(plot.x(t) - px) <= GRAB_PX && (best < 0 || Math.abs(plot.x(t) - px) < Math.abs(plot.x(state.filter.moments[best]) - px))) best = i;
    });
    return best;
  }
  strip.addEventListener("pointerdown", (event) => {
    if (!state || event.button !== 0) return;
    const [px] = pointerPosition(strip, event);
    const index = grabbed(px);
    if (index < 0) return;
    event.preventDefault();
    strip.setPointerCapture(event.pointerId);
    chosen = index;
    dragged = { index, moved: false, section: state };
    showSettings();
    render();
  });
  strip.addEventListener("pointermove", (event) => {
    if (!dragged) return;
    const [px] = pointerPosition(strip, event);
    dragged.section = moveMoment(state, dragged.index, stripPlot().t(px), state.duration);
    dragged.moved = dragged.section.filter.moments[dragged.index] !== state.filter.moments[dragged.index];
    showSettings();
    render();
  });
  const dropMoment = (event) => {
    if (!dragged) return;
    const { moved, section: next } = dragged;
    dragged = null;
    if (moved && event.type !== "pointercancel") return commit(next);
    showSettings();
    render();
  };
  strip.addEventListener("pointerup", dropMoment);
  strip.addEventListener("pointercancel", dropMoment);
  strip.addEventListener("dblclick", (event) => {
    if (!state) return;
    const [px] = pointerPosition(strip, event);
    if (grabbed(px) < 0) addAt(stripPlot().t(px));
  });

  // --- the filter ----------------------------------------------------------------------

  function filterPlot() {
    const canvas = canvases.filter;
    const width = canvas.clientWidth || 600;
    const height = canvas.clientHeight || 220;
    const [x0, x1, y0, y1] = [FILTER_MARGIN.left, width - FILTER_MARGIN.right, FILTER_MARGIN.top, height - FILTER_MARGIN.bottom];
    const [e0, e1] = F_RANGE.map(erbNumber);
    const [low, high] = DB_RANGE;
    return {
      width, height, x0, x1, y0, y1,
      x: (f) => x0 + ((erbNumber(f) - e0) / (e1 - e0)) * (x1 - x0),
      y: (db) => y1 - ((db - low) / (high - low)) * (y1 - y0),
      at: ([px, py]) => [e0 + Math.min(1, Math.max(0, (px - x0) / (x1 - x0))) * (e1 - e0), low + ((y1 - py) / (y1 - y0)) * (high - low)],
    };
  }

  function curveLine(context, plot, f, curve) {
    context.beginPath();
    curve.forEach((db, k) => (k ? context.lineTo(plot.x(f[k]), plot.y(db)) : context.moveTo(plot.x(f[k]), plot.y(db))));
    context.stroke();
  }

  function renderFilter() {
    const canvas = canvases.filter;
    const context = fitCanvasInCssPixels(canvas);
    const plot = filterPlot();
    const { f, moments, db } = section().filter;
    context.clearRect(0, 0, plot.width, plot.height);
    drawBorder(context, canvas, plot);
    drawValueTicks(context, plot, DB_TICKS, plot.y, (level) => `${level}`, { gridColor: style("--grid", "#eeece6") });
    drawAxisName(context, plot, "dB");
    context.textAlign = "center";
    context.textBaseline = "top";
    for (const tick of FREQUENCY_TICKS) context.fillText(frequencyLabel(tick), plot.x(tick), plot.y1 + 4);
    context.fillText("frequency, Hz (ERB scale)", (plot.x0 + plot.x1) / 2, plot.y1 + 18);
    context.textAlign = "left";
    context.textBaseline = "bottom";
    context.fillStyle = style("--ink", "#1d232b");
    context.fillText(`Filter at ${moments[chosen].toFixed(2)} s (moment ${chosen + 1} of ${moments.length})`, plot.x0, plot.y0 - 6);
    // the other moments faint, the curve heard now dashed while playing, the chosen one on top
    context.lineWidth = 1;
    context.strokeStyle = style("--muted", "#6b7280");
    context.globalAlpha = 0.35;
    db.forEach((curve, i) => i !== chosen && curveLine(context, plot, f, curve));
    context.globalAlpha = 1;
    if (playhead !== null) {
      context.save();
      context.strokeStyle = playColor();
      context.setLineDash([4, 3]);
      curveLine(context, plot, f, curveAt(section().filter, playhead));
      context.restore();
    }
    const curve = editedCurve ?? db[chosen];
    context.strokeStyle = accent();
    context.lineWidth = 2;
    curveLine(context, plot, f, curve);
    context.fillStyle = accent();
    curve.forEach((level, k) => context.fillRect(plot.x(f[k]) - 1.5, plot.y(level) - 1.5, 3, 3));
  }

  const filterCanvas = canvases.filter;
  const onCurve = (event) => filterPlot().at(pointerPosition(filterCanvas, event));
  filterCanvas.addEventListener("pointerdown", (event) => {
    if (!state || event.button !== 0) return;
    event.preventDefault();
    filterCanvas.setPointerCapture(event.pointerId);
    const [e, level] = onCurve(event);
    const { f, db } = state.filter;
    editedCurve = [...db[chosen]];
    editedCurve[nearestPointIndex(f, e)] = Math.min(DB_RANGE[1], Math.max(DB_RANGE[0], Math.round(level * 10) / 10));
    lastOnCurve = [e, level];
    renderFilter();
  });
  filterCanvas.addEventListener("pointermove", (event) => {
    if (!editedCurve) return;
    const moves = event.getCoalescedEvents?.() ?? [];
    for (const move of moves.length ? moves : [event]) {
      const next = onCurve(move);
      editedCurve = drawOnCurve(editedCurve, state.filter.f, lastOnCurve, next);
      lastOnCurve = next;
    }
    renderFilter();
  });
  const finishCurve = (event) => {
    if (!editedCurve) return;
    const curve = editedCurve;
    editedCurve = lastOnCurve = null;
    if (event.type === "pointercancel") return renderFilter();
    commit(withCurve(state, chosen, curve));
  };
  filterCanvas.addEventListener("pointerup", finishCurve);
  filterCanvas.addEventListener("pointercancel", finishCurve);

  function render() {
    if (!state) return;
    renderPitch();
    renderBreath();
    renderStrip();
    renderFilter();
    renderStft();
  }
  for (const canvas of Object.values(canvases)) new ResizeObserver(render).observe(canvas);

  return {
    id: "draw_voice",
    figure: canvases.pitch.parentElement, // where the shell shows synthesis progress
    setDocument(next) {
      stroke = editedCurve = lastOnCurve = dragged = null;
      state = next;
      showSettings();
      render();
    },
    setResult(result) {
      sound = result ?? null;
      renderStft();
    },
    setPlayhead(t) {
      playhead = t;
      render();
    },
    blocked() {
      return null;
    },
    key() {
      return false;
    },
  };
}
