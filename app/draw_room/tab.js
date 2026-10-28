// The Draw a room tab: draw how long a room rings at each frequency, its RT60
// curve, and hear a sound in that room, through sonore's synth_ir (Traer &
// McDermott, 2016; docs/design/tabs/draw_room.md).
//
// The Room box holds the curve, drawn freehand on log axes (R3), with the
// RT60 measured back from the room made as dots over it (R9), and under it
// the room's impulse response as a spectrogram, where each frequency's decay
// is a slope. The Result box holds the result's spectrogram and waveform,
// with the room's tail after the source (R8).

import {
  drawAxisName,
  drawBorder,
  drawPlayhead,
  drawTitle,
  drawValueTicks,
  drawWaveform,
  fitCanvasInCssPixels,
  frequencyLabel,
  logSpectrogramPlot,
  pointerPosition,
  soundSeconds,
} from "../plot.js";
import { typedNumber } from "../draw_spectrogram/model.js";
import { numberBox } from "../numberbox.js";
import { attachSourceControls, sourceFieldset } from "../sources.js";
import { randomSeed } from "../seed.js";
import {
  DRR_RANGE,
  F_RANGE,
  LABELS,
  RT60_RANGE,
  STARTS,
  drawOnCurve,
  median,
  nearestPointIndex,
  points,
  scaledTo,
  startCurve,
  withCurve,
} from "./model.js";

const MARGIN = { left: 52, right: 10, top: 6, bottom: 20 };
const CURVE_MARGIN = { left: 52, right: 10, top: 22, bottom: 34 };
const RT60_TICKS = [0.1, 0.2, 0.5, 1, 2, 5, 10];
const FREQUENCY_TICKS = [100, 200, 500, 1000, 2000, 5000];
const F_LO = 50; // Hz, the spectrograms' range
const F_HI = 8000;

export function createDrawRoomTab(root, { commit, openRecording, hasRecording, log }) {
  let state = null;
  let sound = null;
  let playhead = null;
  let editedCurve = null; // the curve while a stroke is drawn
  let lastOnCurve = null; // [log frequency, log RT60] of the last pointer position on the curve
  const f = points();

  root.innerHTML = `
    <div class="draw-room-body">
      <div class="paint-area">
        <section class="panel-box design-box">
          <h3 class="panel-group" title="The room: how long it rings at each frequency">Room</h3>
          <div class="panel-stack">
            <canvas class="rt60-curve" title="Draw the room's RT60, the time it takes to fall 60 dB, at each frequency; the dots are what the room made measures"></canvas>
            <canvas class="room-stft" title="The room's impulse response: its spectrogram (5 ms window) on a log-frequency axis"></canvas>
            <p class="hint room-note"></p>
          </div>
        </section>
        <section class="panel-box result-box">
          <h3 class="panel-group" title="What came out">Result</h3>
          <div class="panel-stack">
            <canvas class="result-stft" title="The result's spectrogram (5 ms window) on a log-frequency axis"></canvas>
            <canvas class="wave" title="The result's waveform"></canvas>
          </div>
        </section>
      </div>
      <aside class="side">
        ${sourceFieldset("The sound heard in the room", LABELS)}
        <fieldset><legend>Room</legend>
          <label class="field" title="Redraw the curve as one of these rooms, with the RT60 below">Start from
            <select class="start">
              <option value="" selected>Choose a room…</option>
              ${Object.entries(STARTS).map(([id, name]) => `<option value="${id}">${name}</option>`).join("")}
            </select></label>
          <label class="field" title="The curve's median RT60, in seconds: a new value scales the whole curve">RT60, s
            <input type="number" class="rt60" min="${RT60_RANGE[0]}" max="${RT60_RANGE[1]}" step="0.1"></label>
          <label class="field knob" title="The direct sound's level against the room's (the direct-to-reverberant ratio): low is far from the source, high is close"><span class="knob-name">Direct sound</span> <span class="unit">dB</span>
            <input type="range" class="drr" min="${DRR_RANGE[0]}" max="${DRR_RANGE[1]}" step="1"></label>
          <label class="field" title="The seed of the room's noise">Seed <input type="number" class="seed" min="0" step="1"></label>
          <button type="button" class="reorder" title="Draw a random seed: another room with the same curve">New draw</button>
        </fieldset>
        <p class="hint">Real rooms ring longest in the middle frequencies and die sooner below and above. Draw the curve another way and listen for when the room stops sounding real. Each ear hears its own tail, so use headphones. Space plays.</p>
      </aside>
    </div>`;
  const query = (selector) => root.querySelector(selector);
  const ui = {
    start: query(".start"), rt60: query(".rt60"), drr: query(".drr"), seed: query(".seed"), reorder: query(".reorder"), note: query(".room-note"),
    curve: query("canvas.rt60-curve"), room: query("canvas.room-stft"), result: query("canvas.result-stft"), wave: query("canvas.wave"),
  };
  const drrBox = numberBox(ui.drr, { digits: 0 });
  ui.drr.previousElementSibling.before(drrBox.box);

  const showSource = attachSourceControls(root, { state: () => state, commit, openRecording, hasRecording, log });

  function showSettings() {
    showSource();
    ui.rt60.value = +median(state.rt60).toFixed(2);
    ui.drr.value = state.drr_db;
    drrBox.show();
    ui.seed.value = state.seed;
  }

  ui.start.addEventListener("change", () => {
    const kind = ui.start.value;
    ui.start.value = ""; // so the same room can be chosen again
    if (kind) commit({ ...state, rt60: startCurve(kind, median(state.rt60)) });
  });
  ui.rt60.addEventListener("change", () => {
    const rt60 = typedNumber(ui.rt60.value, NaN);
    if (rt60 >= RT60_RANGE[0] && rt60 <= RT60_RANGE[1]) commit({ ...state, rt60: scaledTo(state.rt60, rt60) });
    else ui.rt60.value = +median(state.rt60).toFixed(2);
  });
  ui.drr.addEventListener("change", () => {
    const drr = Number(ui.drr.value);
    if (drr !== state.drr_db) commit({ ...state, drr_db: drr });
  });
  ui.seed.addEventListener("change", () => {
    const seed = Math.round(typedNumber(ui.seed.value, NaN));
    if (Number.isInteger(seed) && seed >= 0 && seed !== state.seed) commit({ ...state, seed });
    else ui.seed.value = state.seed;
  });
  ui.reorder.addEventListener("click", () => commit({ ...state, seed: randomSeed(state.seed) }, { play: true }));

  // What the dots say: how closely the room made follows the curve.
  function showNote() {
    const measured = sound?.measured;
    if (!measured) {
      ui.note.textContent = "";
      return;
    }
    const errors = measured.f.map((frequency, k) => {
      const value = measured.rt60[k];
      if (!Number.isFinite(value)) return null;
      return Math.abs(value / drawnAt(state.rt60, frequency) - 1);
    }).filter((error) => error !== null);
    if (!errors.length) {
      ui.note.textContent = "The room is too short to measure.";
      return;
    }
    const near = errors.filter((error) => error <= 0.2).length;
    ui.note.textContent = `In ${near} of the ${errors.length} bands measured the room rings within 20% of the curve drawn. Below about 300 Hz, and in very short rooms, it follows the curve less closely.`;
  }

  // The drawn curve at `frequency`, as sonore reads it: linear in log frequency and log RT60, held flat beyond its ends.
  function drawnAt(curve, frequency) {
    const x = Math.log(Math.min(F_RANGE[1], Math.max(F_RANGE[0], frequency)));
    let k = 1;
    while (k < f.length - 1 && Math.log(f[k]) < x) k += 1;
    const [x0, x1] = [Math.log(f[k - 1]), Math.log(f[k])];
    const w = Math.min(1, Math.max(0, (x - x0) / (x1 - x0)));
    return Math.exp(Math.log(curve[k - 1]) + w * (Math.log(curve[k]) - Math.log(curve[k - 1])));
  }

  // --- the curve -----------------------------------------------------------------------

  const style = (name, fallback) => getComputedStyle(ui.curve).getPropertyValue(name).trim() || fallback;

  function curvePlot() {
    const canvas = ui.curve;
    const width = canvas.clientWidth || 600;
    const height = canvas.clientHeight || 220;
    const [x0, x1, y0, y1] = [CURVE_MARGIN.left, width - CURVE_MARGIN.right, CURVE_MARGIN.top, height - CURVE_MARGIN.bottom];
    const [l0, l1] = F_RANGE.map(Math.log);
    const [r0, r1] = RT60_RANGE.map(Math.log);
    return {
      width, height, x0, x1, y0, y1,
      x: (frequency) => x0 + ((Math.log(frequency) - l0) / (l1 - l0)) * (x1 - x0),
      y: (rt60) => y1 - ((Math.log(rt60) - r0) / (r1 - r0)) * (y1 - y0),
      at: ([px, py]) => [l0 + Math.min(1, Math.max(0, (px - x0) / (x1 - x0))) * (l1 - l0), r0 + ((y1 - py) / (y1 - y0)) * (r1 - r0)],
    };
  }

  function renderCurve() {
    const canvas = ui.curve;
    const context = fitCanvasInCssPixels(canvas);
    const plot = curvePlot();
    context.clearRect(0, 0, plot.width, plot.height);
    if (!state) return;
    drawBorder(context, canvas, plot);
    drawValueTicks(context, plot, RT60_TICKS, plot.y, (rt60) => `${rt60}`, { gridColor: style("--grid", "#eeece6") });
    drawAxisName(context, plot, "RT60, s");
    context.textAlign = "center";
    context.textBaseline = "top";
    for (const tick of FREQUENCY_TICKS) context.fillText(frequencyLabel(tick), plot.x(tick), plot.y1 + 4);
    context.fillText("frequency, Hz", (plot.x0 + plot.x1) / 2, plot.y1 + 18);
    const curve = editedCurve ?? state.rt60;
    context.textAlign = "left";
    context.textBaseline = "bottom";
    context.fillStyle = style("--ink", "#1d232b");
    context.fillText(`RT60 across frequency: median ${median(curve).toFixed(2)} s`, plot.x0, plot.y0 - 6);
    const accent = style("--accent", "#2563eb");
    context.strokeStyle = accent;
    context.lineWidth = 2;
    context.beginPath();
    curve.forEach((rt60, k) => (k ? context.lineTo(plot.x(f[k]), plot.y(rt60)) : context.moveTo(plot.x(f[k]), plot.y(rt60))));
    context.stroke();
    context.lineWidth = 1;
    // the RT60 measured from the room made, where a band has one (R9)
    const measured = editedCurve ? null : sound?.measured;
    if (measured) {
      context.fillStyle = style("--ink", "#1d232b");
      measured.f.forEach((frequency, k) => {
        const value = measured.rt60[k];
        if (!Number.isFinite(value) || frequency < F_RANGE[0] || frequency > F_RANGE[1]) return;
        const y = plot.y(Math.min(RT60_RANGE[1], Math.max(RT60_RANGE[0], value)));
        context.beginPath();
        context.arc(plot.x(frequency), y, 2.5, 0, 2 * Math.PI);
        context.fill();
      });
      context.textAlign = "right";
      context.fillText("• measured", plot.x1, plot.y0 - 6);
    }
  }

  const onCurve = (event) => curvePlot().at(pointerPosition(ui.curve, event));
  ui.curve.addEventListener("pointerdown", (event) => {
    if (!state || event.button !== 0) return;
    event.preventDefault();
    ui.curve.setPointerCapture(event.pointerId);
    const [x, y] = onCurve(event);
    editedCurve = [...state.rt60];
    editedCurve[nearestPointIndex(f, x)] = Math.min(RT60_RANGE[1], Math.max(RT60_RANGE[0], Number(Math.exp(y).toFixed(3))));
    lastOnCurve = [x, y];
    renderCurve();
  });
  ui.curve.addEventListener("pointermove", (event) => {
    if (!editedCurve) return;
    const moves = event.getCoalescedEvents?.() ?? [];
    for (const move of moves.length ? moves : [event]) {
      const next = onCurve(move);
      editedCurve = drawOnCurve(editedCurve, f, lastOnCurve, next);
      lastOnCurve = next;
    }
    renderCurve();
  });
  const finishCurve = (event) => {
    if (!editedCurve) return;
    const curve = editedCurve;
    editedCurve = lastOnCurve = null;
    if (event.type === "pointercancel") return renderCurve();
    commit(withCurve(state, curve));
  };
  ui.curve.addEventListener("pointerup", finishCurve);
  ui.curve.addEventListener("pointercancel", finishCurve);

  // --- the spectrograms --------------------------------------------------------------

  const roomPanel = logSpectrogramPlot(ui.room, MARGIN);
  const resultPanel = logSpectrogramPlot(ui.result, MARGIN);

  function renderRoom() {
    const context = roomPanel.clear();
    if (!state) return;
    const picture = sound?.roomStft ?? null;
    const seconds = picture ? roomSeconds(picture) : 1;
    const plot = roomPanel.geometry(F_LO, F_HI, seconds);
    roomPanel.draw(context, plot, picture, { named: true });
    drawTitle(context, plot, picture ? "The room's impulse response" : "The room: Play to make it");
  }

  // How long the room's impulse response is, from its spectrogram's windows.
  function roomSeconds(picture) {
    return Math.max(picture.tStart + picture.tStep * picture.nWindows, 0.01);
  }

  function renderResult() {
    const context = resultPanel.clear();
    if (!state) return;
    const plot = resultPanel.geometry(F_LO, F_HI, sound ? soundSeconds(sound) : state.duration);
    resultPanel.draw(context, plot, sound?.spectrogram, { named: true });
    if (playhead !== null) drawPlayhead(context, plot, plot.x(playhead), "#ffffff");
    drawTitle(context, plot, sound ? "The source in the room" : "The result: Play to make it");
  }

  function renderWave() {
    drawWaveform(ui.wave, sound, sound ? soundSeconds(sound) : state?.duration ?? 1);
  }

  new ResizeObserver(renderCurve).observe(ui.curve);
  new ResizeObserver(renderRoom).observe(ui.room);
  new ResizeObserver(renderResult).observe(ui.result);
  new ResizeObserver(renderWave).observe(ui.wave);

  return {
    id: "draw_room",
    figure: root.querySelector(".result-box .panel-stack"), // where the shell shows synthesis progress
    ownWaveform: true, // drawn in the Result box
    setDocument(next) {
      editedCurve = lastOnCurve = null;
      state = next;
      showSettings();
      showNote();
      renderCurve();
      renderRoom();
      renderResult();
    },
    setResult(next) {
      sound = next ?? null;
      showNote();
      renderCurve();
      renderRoom();
      renderResult();
      renderWave();
    },
    setPlayhead(t) {
      playhead = t;
      renderResult();
    },
    failed(message) {
      ui.note.textContent = `Not made: ${message.replace(/^ValueError: /, "")}`;
    },
    blocked() {
      if (state.source === "file" && !state.recording) return "No recording: open an audio file (Source) to hear in the room.";
      return null;
    },
    key() {
      return false;
    },
  };
}
