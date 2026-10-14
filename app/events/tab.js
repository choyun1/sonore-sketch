// The Scatter events tab: one short event copied at random times, with the
// rate drawn as a track and sliders for the timing's regularity and the
// spread of the copies' levels and pitches, heard through sonore's
// event_train (docs/design/tabs/events.md).
//
// The rate track is drawn freehand over the page's time, on a log axis, and
// replaces what it passes over, like the elevation track on the Draw path
// tab. A slider's change is committed when it is let go (E6). Under the
// sound's spectrogram, two plots of one statistic, the envelope sparsity
// (E7): by band, and against rate.

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
  SLIDER_STEPS,
  flatRate,
  fromSlider,
  knobLabel,
  knobShown,
  ratePoints,
  toSlider,
  withRate,
} from "./model.js";

const TRACK_MARGIN = { left: 52, right: 10, top: 8, bottom: 22 };
const STFT_MARGIN = { left: 52, right: 10, top: 6, bottom: 22 };
const PLOT_MARGIN = { left: 52, right: 18, top: 22, bottom: 34 }; // room on the right for the label 1000
const RATE_TICKS = [1, 10, 100, 1000];
const RATE_TOLERANCE = 0.02; // log10 units, how far a simplified rate stroke may stray (about 5%)
const F_LOW = 100; // Hz, the spectrogram's and the band plot's lowest frequency
const SPARSITY_RANGE = [0.01, 10]; // var / mean², the plots' axis
const SPARSITY_TICKS = [0.01, 0.1, 1, 10];
const FREQUENCY_TICKS = [100, 200, 500, 1000, 2000, 5000];

const EVENT_KNOBS = KNOBS.filter((entry) => entry.events !== null);
const COPY_KNOBS = KNOBS.filter((entry) => entry.events === null);

const knobField = ({ name, label, title }) =>
  `<label class="field knob" data-knob="${name}" title="${title}"><span class="knob-name">${label}</span><output></output>
    <input type="range" min="0" max="${SLIDER_STEPS}" step="1"></label>`;

export function createEventsTab(root, { commit }) {
  let state = null;
  let sound = null; // the last result, with its sparsity
  let drawing = null; // the rate stroke being drawn, [[t, rate], ...]
  let playhead = null;

  root.innerHTML = `
    <div class="events-body">
      <div class="events-area">
        <canvas class="rate" aria-label="Events per second over time, from 1 to 1000 on a log axis; draw to change it"></canvas>
        <canvas class="stft" aria-label="The result's spectrogram"></canvas>
        <div class="events-plots">
          <canvas class="sparsity-bands" aria-label="Envelope sparsity in each frequency band"></canvas>
          <canvas class="sparsity-rate" aria-label="Envelope sparsity against rate"></canvas>
        </div>
        <p class="hint">Sparsity is each band's envelope variance over its squared mean, a statistic of sonore's texture model: high when the band's envelope is peaky, as with separate events, and close to Gaussian noise's (dashed) when many overlap. It says nothing about rhythm or onsets. Against rate: the mean over the event's own bands (shaded on the left) for this event at each rate, with random timing and nothing spread; the red dot is this sound, while its rate is flat.</p>
      </div>
      <aside class="side">
        <fieldset><legend>Event</legend>
          <label class="field" title="The event that is copied">
            <select class="event">${EVENTS.map(([id, label]) => `<option value="${id}">${label}</option>`).join("")}</select></label>
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
  const bands = query("canvas.sparsity-bands");
  const rates = query("canvas.sparsity-rate");
  const ui = { event: query(".event"), draw: query(".draw"), flat: query(".flat") };
  const fields = [...root.querySelectorAll(".knob")];

  const style = (name, fallback) => getComputedStyle(root).getPropertyValue(name).trim() || fallback;

  // --- the side panel ------------------------------------------------------------------

  function showSettings() {
    ui.event.value = state.event;
    for (const field of fields) {
      const name = field.dataset.knob;
      field.hidden = !knobShown(name, state.event);
      field.querySelector("input").value = toSlider(name, state[name]);
      field.querySelector("output").textContent = knobLabel(name, state[name]);
    }
    ui.flat.disabled = state.rate === DEFAULT_RATE;
  }
  ui.event.addEventListener("change", () => commit({ ...state, event: ui.event.value }));
  for (const field of fields) {
    const name = field.dataset.knob;
    const input = field.querySelector("input");
    input.addEventListener("input", () => (field.querySelector("output").textContent = knobLabel(name, fromSlider(name, Number(input.value)))));
    input.addEventListener("change", () => {
      const value = fromSlider(name, Number(input.value));
      if (value !== state[name]) commit({ ...state, [name]: value });
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
    if (playhead !== null && playhead <= plot.duration) drawPlayhead(context, plot, plot.x(playhead), style("--error", "#d1495b"));
  }

  // A plot with log axes on both sides, in `canvas`.
  function logPlot(canvas, [xLow, xHigh]) {
    const width = canvas.clientWidth || 300;
    const height = canvas.clientHeight || 180;
    const [x0, x1, y0, y1] = [PLOT_MARGIN.left, width - PLOT_MARGIN.right, PLOT_MARGIN.top, height - PLOT_MARGIN.bottom];
    const [yLow, yHigh] = SPARSITY_RANGE.map(Math.log10);
    const clampY = (value) => Math.min(yHigh, Math.max(yLow, Math.log10(Math.max(value, 1e-6))));
    return {
      width, height, x0, x1, y0, y1,
      x: (value) => x0 + ((Math.log10(value) - Math.log10(xLow)) / (Math.log10(xHigh) - Math.log10(xLow))) * (x1 - x0),
      y: (value) => y1 - ((clampY(value) - yLow) / (yHigh - yLow)) * (y1 - y0),
    };
  }

  function plotFrame(canvas, plot, title, xTicks, xLabel, xName) {
    const context = fitCanvasInCssPixels(canvas);
    context.clearRect(0, 0, plot.width, plot.height);
    drawBorder(context, canvas, plot);
    drawValueTicks(context, plot, SPARSITY_TICKS, plot.y, (value) => `${value}`, { gridColor: style("--grid", "#eeece6") });
    drawAxisName(context, plot, "var / mean²");
    context.textAlign = "center";
    context.textBaseline = "top";
    for (const tick of xTicks) context.fillText(xLabel(tick), plot.x(tick), plot.y1 + 4);
    context.fillText(xName, (plot.x0 + plot.x1) / 2, plot.y1 + 18);
    context.textAlign = "left";
    context.textBaseline = "bottom";
    context.fillStyle = style("--ink", "#1d232b");
    context.fillText(title, plot.x0, plot.y0 - 6);
    return context;
  }

  function line(context, plot, xs, ys, color, { dashed = false, width = 1.5 } = {}) {
    context.strokeStyle = color;
    context.lineWidth = width;
    context.setLineDash(dashed ? [5, 4] : []);
    context.beginPath();
    xs.forEach((x, i) => (i ? context.lineTo(plot.x(x), plot.y(ys[i])) : context.moveTo(plot.x(x), plot.y(ys[i]))));
    context.stroke();
    context.setLineDash([]);
  }

  function renderBands() {
    const sparsity = sound?.sparsity;
    const fTop = (sound?.fs ?? state.fs) / 2;
    const plot = logPlot(bands, [F_LOW, fTop]);
    const context = plotFrame(bands, plot, "Sparsity by band", FREQUENCY_TICKS.filter((f) => f < fTop), frequencyLabel, "band, Hz");
    if (!sparsity) return;
    const { cfs, values, noise, own } = sparsity;
    // the event's own bands, shaded
    context.fillStyle = "rgba(128, 128, 128, 0.12)";
    cfs.forEach((f, i) => {
      if (!own[i]) return;
      const left = i ? Math.sqrt(f * cfs[i - 1]) : f;
      const right = i < cfs.length - 1 ? Math.sqrt(f * cfs[i + 1]) : f;
      context.fillRect(plot.x(Math.max(F_LOW, left)), plot.y0, plot.x(Math.min(fTop, right)) - plot.x(Math.max(F_LOW, left)), plot.y1 - plot.y0);
    });
    const shown = cfs.map((f, i) => i).filter((i) => cfs[i] >= F_LOW);
    line(context, plot, shown.map((i) => cfs[i]), shown.map((i) => noise[i]), style("--muted", "#6b7280"), { dashed: true, width: 1 });
    line(context, plot, shown.map((i) => cfs[i]), shown.map((i) => values[i]), style("--accent", "#2e86ab"));
  }

  function renderRates() {
    const sparsity = sound?.sparsity;
    const plot = logPlot(rates, RATE_RANGE);
    const context = plotFrame(rates, plot, "Sparsity against rate", RATE_TICKS, (rate) => `${rate}`, "events / s");
    if (!sparsity) return;
    const { curve_rates: curveRates, curve, noise_mean: noiseMean, mean, rate } = sparsity;
    line(context, plot, RATE_RANGE, [noiseMean, noiseMean], style("--muted", "#6b7280"), { dashed: true, width: 1 });
    line(context, plot, curveRates, curve, style("--ink", "#1d232b"), { width: 1.2 });
    context.fillStyle = style("--ink", "#1d232b");
    curveRates.forEach((r, i) => {
      context.beginPath();
      context.arc(plot.x(r), plot.y(curve[i]), 2.5, 0, 2 * Math.PI);
      context.fill();
    });
    if (rate !== null && rate === flatRate(state)) {
      context.fillStyle = style("--error", "#d1495b");
      context.beginPath();
      context.arc(plot.x(rate), plot.y(mean), 5, 0, 2 * Math.PI);
      context.fill();
    }
  }

  function render() {
    if (!state) return;
    renderTrack();
    renderStft();
    renderBands();
    renderRates();
  }
  for (const canvas of [track, stft, bands, rates]) new ResizeObserver(render).observe(canvas);

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
      render();
    },
    setPlayhead(t) {
      playhead = t;
      if (!state) return;
      renderTrack();
      renderStft();
    },
    blocked() {
      return null;
    },
    key() {
      return false;
    },
  };
}
