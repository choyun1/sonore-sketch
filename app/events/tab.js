// The Scatter events tab: one short event copied at random times, with the
// rate drawn as a track and sliders for the timing's regularity and the
// spread of the copies' levels and pitches, heard through sonore's
// event_train (docs/design/tabs/events.md).
//
// The rate track is drawn freehand over the page's time, on a log axis, and
// replaces what it passes over, like the elevation track on the Draw path
// tab. A slider's change is committed when it is let go (E6). Under the
// sound's spectrogram, its modulation spectrogram (E7): the depth pooled
// over bands, rate by time, and beside it the band x rate depth at one
// moment, which follows the playhead, as on sonore's gallery page.

import { magma } from "../colormap.js";
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
import { extendStroke, replaceSpan, simplify } from "../tracks/model.js";
import {
  DEFAULT_RATE,
  EVENTS,
  KNOBS,
  RATE_RANGE,
  TONES,
  SLIDER_STEPS,
  fromSlider,
  knobLabel,
  knobName,
  knobShown,
  ratePoints,
  toSlider,
  withRate,
} from "./model.js";

const TRACK_MARGIN = { left: 52, right: 10, top: 8, bottom: 22 };
const STFT_MARGIN = { left: 52, right: 10, top: 6, bottom: 22 };
const FRAME_MARGIN = { left: 44, right: 10, top: 22, bottom: 34 };
const RATE_TICKS = [1, 10, 100, 1000]; // events per second, the rate track's axis
const RATE_TOLERANCE = 0.02; // log10 units, how far a simplified rate stroke may stray (about 5%)
const MOD_TICKS = [2, 4, 8, 16, 32, 64]; // Hz, the modulation rates' axis
const F_LOW = 100; // Hz, the spectrogram's lowest frequency
const FREQUENCY_TICKS = [100, 200, 500, 1000, 2000, 5000];
const INVALID = "rgba(128, 128, 128, 0.35)"; // a cell the modulation spectrogram cannot trust

const EVENT_KNOBS = KNOBS.filter((entry) => entry.events !== null);
const COPY_KNOBS = KNOBS.filter((entry) => entry.events === null);

const knobField = ({ name, label, title, ends }) =>
  `<label class="field knob" data-knob="${name}" title="${title}"><span class="knob-name">${label}</span><output></output>
    <input type="range" min="0" max="${SLIDER_STEPS}" step="1">${ends ? `<span class="ends"><span>${ends[0]}</span><span>${ends[1]}</span></span>` : ""}</label>`;

export function createEventsTab(root, { commit }) {
  let state = null;
  let sound = null; // the last result, with its modulation spectrogram
  let chosen = null; // the moment the band x rate picture shows while nothing plays (null: the middle)
  let drawing = null; // the rate stroke being drawn, [[t, rate], ...]
  let playhead = null;

  root.innerHTML = `
    <div class="events-body">
      <div class="events-area">
        <canvas class="rate" aria-label="Events per second over time, from 1 to 1000 on a log axis; draw to change it"></canvas>
        <canvas class="stft" aria-label="The result's spectrogram"></canvas>
        <canvas class="mod-pooled" aria-label="The modulation spectrogram: modulation depth by rate over time, pooled over frequency bands; click to choose a moment"></canvas>
        <canvas class="mod-frame" aria-label="Modulation depth by frequency band and rate at one moment"></canvas>
        <p class="hint">The modulation spectrogram (sonore's ModulationSpectrogram): how deeply the sound's envelope rises and falls at each rate, up to 64 times a second, over time. Every rate is measured over the same window, a third of the sound long and at most 1 s; the slowest rate shown holds two cycles in it (2 Hz from a 3 s sound on). Under the spectrogram, on the same time axis: pooled over frequency bands. Beside them: each band at one moment, which follows the sound as it plays; click the spectrogram or the pooled picture to choose the moment. Brighter is deeper, over the top 30 dB; gray cells cannot be measured (a rate faster than the band is wide, a rate too slow for the window, or half a window at each end, where the window runs off the sound). Events that stand apart modulate deeply at many rates; regular ones put a peak at their rate; many overlapping ones leave the shallow, even modulation of noise. It leaves out the fine structure, and rates above 64 Hz.</p>
      </div>
      <aside class="side">
        <fieldset><legend>Event</legend>
          <label class="field" title="The event that is copied">
            <select class="event">${EVENTS.map(([id, label]) => `<option value="${id}">${label}</option>`).join("")}</select></label>
          <label class="field tone-field" title="A pure tone at one frequency, or a harmonic complex: F0 and its harmonics">
            <select class="tone">${TONES.map(([id, label]) => `<option value="${id}">${label}</option>`).join("")}</select></label>
          ${EVENT_KNOBS.map(knobField).join("")}
        </fieldset>
        <fieldset><legend>Copies</legend>
          ${COPY_KNOBS.map(knobField).join("")}
          <button type="button" class="draw" title="Draw new times, levels and pitches with the same settings">New draw</button>
          <button type="button" class="flat" title="Set the rate back to ${DEFAULT_RATE} events per second throughout">Rate back to ${DEFAULT_RATE}/s</button>
        </fieldset>
        <p class="hint">Drag on the rate track to draw how many events come each second. The sliders apply when you let go. Space plays.</p>
      </aside>
    </div>`;
  const query = (selector) => root.querySelector(selector);
  const track = query("canvas.rate");
  const stft = query("canvas.stft");
  const pooled = query("canvas.mod-pooled");
  const frame = query("canvas.mod-frame");
  const ui = { event: query(".event"), tone: query(".tone"), toneField: query(".tone-field"), draw: query(".draw"), flat: query(".flat") };
  const fields = [...root.querySelectorAll(".knob")];

  const style = (name, fallback) => getComputedStyle(root).getPropertyValue(name).trim() || fallback;

  // --- the side panel ------------------------------------------------------------------

  function showSettings() {
    ui.event.value = state.event;
    ui.tone.value = state.tone;
    ui.toneField.hidden = state.event !== "pip";
    for (const field of fields) {
      const name = field.dataset.knob;
      field.hidden = !knobShown(name, state);
      field.querySelector(".knob-name").textContent = knobName(name, state);
      field.querySelector("input").value = toSlider(name, state[name]);
      field.querySelector("output").textContent = knobLabel(name, state[name]);
    }
    ui.flat.disabled = state.rate === DEFAULT_RATE;
  }
  ui.event.addEventListener("change", () => commit({ ...state, event: ui.event.value }));
  ui.tone.addEventListener("change", () => commit({ ...state, tone: ui.tone.value }));
  for (const field of fields) {
    const name = field.dataset.knob;
    const input = field.querySelector("input");
    input.addEventListener("input", () => (field.querySelector("output").textContent = knobLabel(name, fromSlider(name, Number(input.value)))));
    input.addEventListener("change", () => {
      const value = fromSlider(name, Number(input.value));
      if (value === state[name]) return;
      const changed = { ...state, [name]: value };
      // the noise band's ends cannot cross: the other end moves out of the way
      if (name === "noise_low" && value >= state.noise_high) changed.noise_high = Math.min(7500, Math.round(value * 1.25));
      if (name === "noise_high" && value <= state.noise_low) changed.noise_low = Math.max(50, Math.round(value / 1.25));
      commit(changed);
    });
  }
  ui.draw.addEventListener("click", () => commit({ ...state, seed: state.seed + 1 }));
  ui.flat.addEventListener("click", () => commit({ ...state, rate: DEFAULT_RATE }));

  // --- the rate track ------------------------------------------------------------------

  function trackPlot() {
    const width = track.clientWidth || 600;
    const height = track.clientHeight || 140;
    const [x0, x1, y0, y1] = [TRACK_MARGIN.left, width - TRACK_MARGIN.right, TRACK_MARGIN.top, height - TRACK_MARGIN.bottom];
    const [low, high] = RATE_RANGE.map(Math.log10);
    return {
      width, height, x0, x1, y0, y1,
      x: (t) => x0 + (t / state.duration) * (x1 - x0),
      y: (rate) => y1 - ((Math.log10(rate) - low) / (high - low)) * (y1 - y0),
      at: ([px, py]) => [
        Math.min(state.duration, Math.max(0, ((px - x0) / (x1 - x0)) * state.duration)),
        10 ** Math.min(high, Math.max(low, low + ((y1 - py) / (y1 - y0)) * (high - low))),
      ],
    };
  }

  function renderTrack() {
    const context = fitCanvasInCssPixels(track);
    const plot = trackPlot();
    context.clearRect(0, 0, plot.width, plot.height);
    drawBorder(context, track, plot);
    drawValueTicks(context, plot, RATE_TICKS, plot.y, (rate) => `${rate}`, { gridColor: style("--grid", "#eeece6") });
    drawAxisName(context, plot, "events / s");
    drawTimeTicks(context, plot, state.duration, 5);
    const points = ratePoints(state, state.duration);
    const shown = drawing ? replaceSpan(points, [...drawing].sort((a, b) => a[0] - b[0])) : points;
    context.strokeStyle = style("--accent", "#2e86ab");
    context.lineWidth = 2;
    context.beginPath();
    const ends = [[0, shown[0][1]], ...shown, [state.duration, shown[shown.length - 1][1]]];
    ends.forEach(([t, rate], i) => (i ? context.lineTo(plot.x(t), plot.y(rate)) : context.moveTo(plot.x(t), plot.y(rate))));
    context.stroke();
    if (playhead !== null) drawPlayhead(context, plot, plot.x(playhead), style("--error", "#d1495b"));
  }

  const fromTrack = (event) => trackPlot().at(pointerPosition(track, event));

  track.addEventListener("pointerdown", (event) => {
    if (!state || event.button !== 0) return;
    event.preventDefault();
    track.setPointerCapture(event.pointerId);
    drawing = [fromTrack(event)];
    renderTrack();
  });
  track.addEventListener("pointermove", (event) => {
    if (!drawing) return;
    const moves = event.getCoalescedEvents?.() ?? [];
    for (const move of moves.length ? moves : [event]) extendStroke(drawing, fromTrack(move));
    renderTrack();
  });
  function finishStroke(event) {
    if (!drawing) return;
    // simplified on the log axis it is drawn on, so a slope is kept as well at 2/s as at 500/s
    const logged = simplify(drawing.map(([t, rate]) => [t, Math.log10(rate)]), RATE_TOLERANCE);
    drawing = null;
    if (event.type === "pointercancel") return renderTrack();
    const span = logged.map(([t, level]) => [t, 10 ** level]);
    commit(withRate(state, replaceSpan(ratePoints(state, state.duration), span)));
  }
  track.addEventListener("pointerup", finishStroke);
  track.addEventListener("pointercancel", finishStroke);

  // --- the result: its spectrogram and its sparsity ------------------------------------

  const stftPanel = logSpectrogramPlot(stft, STFT_MARGIN);

  function renderStft() {
    const context = stftPanel.clear();
    // the sound's own duration: a result of an older duration shows at its own times
    const fTop = (sound?.fs ?? state.fs) / 2;
    const plot = stftPanel.geometry(F_LOW, fTop, sound ? soundSeconds(sound) : state.duration);
    stftPanel.draw(context, plot, sound?.spectrogram ?? null, { named: true });
    const at = shownTime();
    if (at <= plot.duration) drawPlayhead(context, plot, plot.x(at), playhead !== null ? style("--error", "#d1495b") : style("--accent", "#2e86ab"));
  }

  // The moment the band x rate picture shows: the playhead while playing,
  // else the moment chosen, else the middle of the sound.
  const shownTime = () => playhead ?? chosen ?? (sound ? soundSeconds(sound) : state.duration) / 2;

  // Paint 8-bit levels into `context` as cells over the box [x0, x1] x [y0, y1]:
  // `level(column, row)` for `columns` x `rows` cells, row 0 at the bottom.
  function paintCells(context, box, columns, rows, level, edges) {
    const { x0, x1, y0, y1 } = box;
    const [columnEdge, rowEdge] = edges;
    // gray underneath: cells that cannot be measured, and rates slower than the window holds
    context.fillStyle = INVALID;
    context.fillRect(x0, y0, x1 - x0, y1 - y0);
    for (let column = 0; column < columns; column++) {
      const left = x0 + columnEdge(column) * (x1 - x0);
      const right = x0 + columnEdge(column + 1) * (x1 - x0);
      for (let row = 0; row < rows; row++) {
        const value = level(column, row);
        const top = y1 - rowEdge(row + 1) * (y1 - y0);
        const bottom = y1 - rowEdge(row) * (y1 - y0);
        if (!value) continue;
        const [red, green, blue] = magma((value - 1) / 254);
        context.fillStyle = `rgb(${red}, ${green}, ${blue})`;
        context.fillRect(Math.floor(left), Math.floor(top), Math.ceil(right - left) + 1, Math.ceil(bottom - top) + 1);
      }
    }
  }

  // Edges of cells centered on log-spaced values, as fractions of the axis from `low` to `high`.
  function logEdges(values, low, high) {
    const at = (value) => Math.log(value / low) / Math.log(high / low);
    const middle = (i) => Math.sqrt(values[i - 1] * values[i]);
    return (i) => at(i === 0 ? values[0] ** 1.5 / values[1] ** 0.5 : i === values.length ? values[i - 1] ** 1.5 / values[i - 2] ** 0.5 : middle(i));
  }

  const pooledImage = { canvas: document.createElement("canvas"), picture: null, key: "" };

  function pooledPlot() {
    const width = pooled.clientWidth || 600;
    const height = pooled.clientHeight || 190;
    const duration = sound ? soundSeconds(sound) : state.duration;
    const [x0, x1, y0, y1] = [STFT_MARGIN.left, width - STFT_MARGIN.right, FRAME_MARGIN.top, height - FRAME_MARGIN.bottom];
    const [low, high] = [MOD_TICKS[0] / 2 ** 0.5, MOD_TICKS[MOD_TICKS.length - 1] * 2 ** 0.25];
    return {
      width, height, x0, x1, y0, y1, duration, low, high,
      x: (t) => x0 + (t / duration) * (x1 - x0),
      y: (rate) => y1 - (Math.log(rate / low) / Math.log(high / low)) * (y1 - y0),
      t: (px) => Math.min(duration, Math.max(0, ((px - x0) / (x1 - x0)) * duration)),
    };
  }

  function title(context, plot, text) {
    context.textAlign = "left";
    context.textBaseline = "bottom";
    context.fillStyle = style("--ink", "#1d232b");
    context.fillText(text, plot.x0, plot.y0 - 6);
  }

  function renderPooled() {
    const context = fitCanvasInCssPixels(pooled);
    const plot = pooledPlot();
    context.clearRect(0, 0, plot.width, plot.height);
    const picture = sound?.modulationPooled;
    if (picture) {
      // painted once per picture and size, then copied, so the playhead moves over it cheaply
      const key = [plot.x1 - plot.x0, plot.y1 - plot.y0, plot.duration].join(" ");
      if (pooledImage.picture !== picture || pooledImage.key !== key) {
        const { data, nRates, nWindows, rates: centers, tStart, tStep } = picture;
        const box = { x0: 0, x1: Math.max(1, Math.round(plot.x1 - plot.x0)), y0: 0, y1: Math.max(1, Math.round(plot.y1 - plot.y0)) };
        pooledImage.canvas.width = box.x1;
        pooledImage.canvas.height = box.y1;
        const columnEdge = (k) => Math.min(1, Math.max(0, (tStart + (k - 0.5) * tStep) / plot.duration));
        paintCells(pooledImage.canvas.getContext("2d"), box, nWindows, nRates, (column, row) => data[row * nWindows + column], [columnEdge, logEdges(centers, plot.low, plot.high)]);
        Object.assign(pooledImage, { picture, key });
      }
      context.drawImage(pooledImage.canvas, plot.x0, plot.y0, plot.x1 - plot.x0, plot.y1 - plot.y0);
    }
    drawBorder(context, pooled, plot);
    drawValueTicks(context, plot, MOD_TICKS, plot.y, (rate) => `${rate}`, { gridColor: "rgba(255, 255, 255, 0.12)" });
    drawAxisName(context, plot, "rate, Hz");
    drawTimeTicks(context, plot, plot.duration, 4);
    title(context, plot, "Modulation depth, pooled over bands");
    const at = shownTime();
    drawPlayhead(context, plot, plot.x(at), playhead !== null ? style("--error", "#d1495b") : style("--accent", "#2e86ab"));
  }

  function framePlot(fTop) {
    const width = frame.clientWidth || 300;
    const height = frame.clientHeight || 190;
    const [x0, x1, y0, y1] = [FRAME_MARGIN.left, width - FRAME_MARGIN.right, FRAME_MARGIN.top, height - FRAME_MARGIN.bottom];
    const [low, high] = [MOD_TICKS[0] / 2 ** 0.5, MOD_TICKS[MOD_TICKS.length - 1] * 2 ** 0.25];
    return {
      width, height, x0, x1, y0, y1, low, high, fTop,
      x: (rate) => x0 + (Math.log(rate / low) / Math.log(high / low)) * (x1 - x0),
      y: (f) => y1 - (Math.log(f / F_LOW) / Math.log(fTop / F_LOW)) * (y1 - y0),
    };
  }

  function renderFrame() {
    const context = fitCanvasInCssPixels(frame);
    const picture = sound?.modulationFrames;
    const plot = framePlot(picture ? picture.bands[picture.bands.length - 1] * 1.1 : 7000);
    context.clearRect(0, 0, plot.width, plot.height);
    const at = shownTime();
    if (picture) {
      const { data, nBands, nRates, nWindows, bands: centers, rates: rateCenters, tStart, tStep } = picture;
      const window = Math.min(nWindows - 1, Math.max(0, Math.round((at - tStart) / tStep)));
      const offset = window * nBands * nRates;
      const rowEdge = logEdges(centers, F_LOW, plot.fTop);
      paintCells(context, plot, nRates, nBands, (column, row) => data[offset + row * nRates + column], [logEdges(rateCenters, plot.low, plot.high), rowEdge]);
    }
    drawBorder(context, frame, plot);
    drawValueTicks(context, plot, FREQUENCY_TICKS.filter((f) => f < plot.fTop), plot.y, frequencyLabel, { gridColor: "rgba(255, 255, 255, 0.12)" });
    drawAxisName(context, plot, "Hz");
    context.textAlign = "center";
    context.textBaseline = "top";
    for (const rate of MOD_TICKS) context.fillText(`${rate}`, plot.x(rate), plot.y1 + 4);
    context.fillText("rate, Hz", (plot.x0 + plot.x1) / 2, plot.y1 + 18);
    title(context, plot, `By band at ${at.toFixed(2)} s`);
  }

  // A click or drag on the spectrogram or the pooled picture chooses the moment shown.
  for (const canvas of [stft, pooled]) {
    const choose = (event) => {
      if (!state) return;
      chosen = pooledPlot().t(pointerPosition(canvas, event)[0]);
      renderStft();
      renderPooled();
      renderFrame();
    };
    canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      canvas.setPointerCapture(event.pointerId);
      choose(event);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (canvas.hasPointerCapture(event.pointerId)) choose(event);
    });
  }

  function render() {
    if (!state) return;
    renderTrack();
    renderStft();
    renderPooled();
    renderFrame();
  }
  for (const canvas of [track, stft, pooled, frame]) new ResizeObserver(render).observe(canvas);

  return {
    id: "events",
    figure: track.parentElement, // where the shell shows synthesis progress
    setDocument(next) {
      drawing = null;
      state = next;
      showSettings();
      render();
    },
    setResult(result) {
      sound = result ?? null;
      if (sound && chosen !== null && chosen > soundSeconds(sound)) chosen = null;
      render();
    },
    setPlayhead(t) {
      playhead = t;
      if (!state) return;
      renderTrack();
      renderStft();
      renderPooled();
      renderFrame();
    },
    blocked() {
      return null;
    },
    key() {
      return false;
    },
  };
}
