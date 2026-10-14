// The Erase modulation tab: paint out parts of a sound's modulation spectrum
// and hear what is left (docs/design/tabs/edit.md).
//
// The plane is the Draw modulation tab's (signed log rate, 1 to 64 Hz each side;
// density 0 to 6 cyc/oct) with a narrow center strip for |rate| < 1 Hz, the
// sound's static spectral shape (E2). It shows the source's modulation
// spectrum, analyzed by Python with each sound made; the mask painted on it
// darkens what it cuts and is outlined where the cut is deep, so the source
// stays readable (E7). A stroke collects each cell's largest brush weight
// and moves every cell toward the brush's cut by its weight when it ends, as
// the Draw spectrogram tab's brush does.
//
// Below, in the Result box: the result's spectrogram on a log-frequency
// axis, and its waveform.

import { magma } from "../colormap.js";
import {
  drawAxisName,
  drawBrush,
  drawFrame,
  drawMaskOutline,
  drawRateAxisWords,
  drawRateTicks,
  drawTitle,
  drawValueTicks,
  drawWaveform,
  fitCanvasInCssPixels,
  logSpectrogramPlot,
  pointerPosition,
  soundSeconds,
  drawPlayhead,
} from "../plot.js";
import { LevelCache, applyCut, brushWeight, typedNumber } from "../painted/model.js";
import { attachSourceControls, sourceFieldset } from "../sources.js";
import {
  CARRIERS,
  COARSE_BELOW_S,
  COLUMNS,
  DENSITY_MAX,
  FLOOR_DB,
  MAX_ITERATIONS,
  RATE_MAX,
  RATE_MIN,
  ROWS,
  SIDE,
  blank,
  keepBelow,
  removeSweeps,
} from "./model.js";

const MARGIN = { left: 52, right: 10, top: 8, bottom: 36 };
const STRIP = 8; // half the center strip's width, px
const CACHE = 200; // decoded masks kept, so undo and redo are instant
const OUTLINE_DB = 30; // the mask's outline runs where the cut crosses this
const CARRIER_LABELS = { source: "the source's own", tones: "tones", noise: "noise" };
const STFT_MARGIN = { left: 52, right: 10, top: 6, bottom: 20 };

export function createEditTab(root, { commit, openRecording, hasRecording, log }) {
  let state = null;
  let bytes = null; // the mask shown: state's levels, decoded
  let stroke = null; // {weights, last, target, preview} while painting
  let resultMask = null; // the mask the result shown was made with: what its outline shows
  let pointer = null;
  let mode = "paint";
  let sound = null;
  let source = null; // {key, picture}: the source's modulation spectrum, kept while only the mask changes
  let playhead = null;
  const cache = new LevelCache(CACHE);

  root.innerHTML = `
    <div class="edit-body">
      <div class="paint-area">
        <section class="panel-box design-box">
          <h3 class="panel-group" title="What you paint: what to erase from the source's modulation spectrum">Design</h3>
          <div class="panel-stack">
            <canvas class="mask-plane" title="The source's modulation spectrum; what you paint is erased from it"></canvas>
            <p class="hint clip-note" hidden></p>
          </div>
        </section>
        <section class="panel-box result-box">
          <h3 class="panel-group" title="What came out">Result</h3>
          <div class="panel-stack">
            <canvas class="measured-plane" title="The result's own modulation spectrum, measured from the sound, on the plane's axes"></canvas>
            <canvas class="result-stft" title="The result's spectrogram (5 ms window) on a log-frequency axis"></canvas>
            <canvas class="wave" title="The result's waveform"></canvas>
          </div>
        </section>
      </div>
      <aside class="side">
        ${sourceFieldset("The sound whose modulation you erase")}
        <fieldset><legend>Brush</legend>
          <label class="choice" title="Erase modulation where you paint (E)"><input type="radio" name="edit-mode" value="paint" checked> Erase <kbd>E</kbd></label>
          <label class="choice" title="Restore what was erased; right-drag restores too (R)"><input type="radio" name="edit-mode" value="erase"> Restore <kbd>R</kbd></label>
          <label class="field" title="The brush's diameter on screen">Size <input type="range" class="size" min="4" max="80" value="24"></label>
          <label class="field" title="How much of the brush's radius fades out at its edge (a soft edge clips the sound less)">Softness <input type="range" class="softness" min="0" max="1" step="0.05" value="0.6"></label>
          <label class="field" title="How deep Erase goes: ${FLOOR_DB} dB removes what it covers">Depth <input type="number" class="cut" min="${FLOOR_DB}" max="-1" step="1" value="${FLOOR_DB}"> dB</label>
        </fieldset>
        <fieldset><legend>Presets</legend>
          <div class="preset-row">
            <button type="button" class="keep-below" title="Erase every rate faster than this, on both sides">Keep below</button>
            <input type="number" class="keep-rate" min="1" max="64" step="1" value="4"> Hz
          </div>
          <button type="button" class="no-down" title="Erase the right side above density 0: the sweeps whose frequency falls">No ↓ sweeps</button>
          <button type="button" class="no-up" title="Erase the left side above density 0: the sweeps whose frequency rises">No ↑ sweeps</button>
        </fieldset>
        <fieldset><legend>Sound</legend>
          <label class="field" title="What carries the modulation that is left: the source's own fine structure (keeps its voice), log-spaced tones (shows what was erased most clearly), or noise">Carrier
            <select class="carrier">${CARRIERS.map((c) => `<option value="${c}">${CARRIER_LABELS[c]}</option>`).join("")}</select></label>
          <label class="field" title="How many times to search for a sound whose own modulation comes closer to what is left (each one an analysis and a synthesis; slower). On the source's own fine structure, an erasure needs a few to be heard">Iterations <input type="number" class="iterations" min="0" max="${MAX_ITERATIONS}" step="1"></label>
        </fieldset>
        <p class="hint coarse" hidden></p>
        <p class="hint">Paint on the plane to erase that modulation; right-drag restores it. Space plays.</p>
      </aside>
    </div>`;
  const $ = (selector) => root.querySelector(selector);
  const canvas = $("canvas.mask-plane");
  const ui = {
    size: $(".size"), softness: $(".softness"), cut: $(".cut"),
    keepBelow: $(".keep-below"), keepRate: $(".keep-rate"), noDown: $(".no-down"), noUp: $(".no-up"),
    carrier: $(".carrier"), iterations: $(".iterations"), coarse: $(".coarse"), stft: $("canvas.result-stft"), wave: $("canvas.wave"),
    measured: $("canvas.measured-plane"), clipNote: $(".clip-note"),
  };
  for (const input of root.querySelectorAll('input[name="edit-mode"]')) input.addEventListener("change", () => (mode = input.value));
  function setMode(next) {
    mode = next;
    root.querySelector(`input[name="edit-mode"][value="${next}"]`).checked = true;
  }

  // --- the mask and its state --------------------------------------------------------

  async function commitBytes(next) {
    const before = state;
    const levels = await cache.encode(next);
    // an undo, redo or opened file while encoding wins: the stroke was made on what it replaced
    if (state === before) commit({ ...state, levels });
  }

  async function load(next) {
    const decoded = await cache.decode(next.levels, ROWS * COLUMNS, blank, (error) => log?.error(`could not read the mask: ${error.message}`));
    if (state === next) {
      bytes = decoded;
      render();
      renderMeasured();
    }
  }

  // The source's identity: its spectrum is kept while only the mask, the carrier or the iterations change.
  const sourceKey = (s) => JSON.stringify([s.source, s.duration, s.fs, s.f_lo, s.f_hi, s.bands_per_octave, s.speech ?? null, s.recording?.pcm16.length ?? 0, s.recording?.name ?? ""]);

  // the Source controls, opening a recording among them (E1, c)
  const showSource = attachSourceControls(root, { state: () => state, commit, openRecording, hasRecording, log });

  function showSettings() {
    showSource();
    ui.carrier.value = state.carrier;
    ui.iterations.value = state.iterations;
    ui.coarse.hidden = state.duration >= COARSE_BELOW_S;
    ui.coarse.textContent = `At ${state.duration} s, rates come in steps of ${+(1 / state.duration).toFixed(2)} Hz, coarse below about 8 Hz; ${COARSE_BELOW_S} s or more shows slow modulation finer.`;
  }

  ui.carrier.addEventListener("change", () => commit({ ...state, carrier: ui.carrier.value }));
  ui.iterations.addEventListener("change", () => {
    const n = Math.round(typedNumber(ui.iterations.value, NaN));
    if (n >= 0 && n <= MAX_ITERATIONS && n !== state.iterations) commit({ ...state, iterations: n });
    else ui.iterations.value = state.iterations;
  });
  // A preset replaces the mask; Undo brings the old one back (E6).
  ui.keepBelow.addEventListener("click", () => {
    const rate = Math.min(RATE_MAX, Math.max(RATE_MIN, Number(ui.keepRate.value) || 4));
    ui.keepRate.value = rate;
    commitBytes(keepBelow(rate));
  });
  ui.noDown.addEventListener("click", () => commitBytes(removeSweeps("down")));
  ui.noUp.addEventListener("click", () => commitBytes(removeSweeps("up")));

  // --- the plane -------------------------------------------------------------------

  // The plane's axes on `target` (the design plane, or the measured one below).
  function geometry(target = canvas, margin = MARGIN) {
    const width = target.clientWidth || 600;
    const height = target.clientHeight || 300;
    const x0 = margin.left;
    const x1 = width - margin.right;
    const y0 = margin.top;
    const y1 = height - margin.bottom;
    const xc = (x0 + x1) / 2;
    const half = xc - STRIP - x0;
    const span = Math.log2(RATE_MAX / RATE_MIN);
    const unit = (rate) => Math.min(1, Math.log2(Math.max(Math.abs(rate), RATE_MIN) / RATE_MIN) / span);
    return {
      width, height, x0, x1, y0, y1, xc, half,
      // rates under 1 Hz sit in the center strip
      x: (rate) => (Math.abs(rate) < RATE_MIN ? xc : rate > 0 ? xc + STRIP + unit(rate) * half : xc - STRIP - unit(rate) * half),
      y: (density) => y1 - (density / DENSITY_MAX) * (y1 - y0),
      // the rate at a pixel; the strip is |rate| < 1 Hz, shown as 0
      rate: (px) => {
        if (Math.abs(px - xc) < STRIP) return 0;
        const u = Math.min(1, Math.max(0, (Math.abs(px - xc) - STRIP) / half));
        return Math.sign(px - xc) * RATE_MIN * 2 ** (u * span);
      },
      density: (py) => ((y1 - py) / (y1 - y0)) * DENSITY_MAX,
      // a pixel's place on the mask, in cells: [row from density 0, column]
      cell: (px, py) => {
        const row = ((y1 - py) / (y1 - y0)) * ROWS;
        let column;
        if (px <= xc - STRIP) column = ((px - x0) / half) * SIDE;
        else if (px < xc + STRIP) column = SIDE + (px - (xc - STRIP)) / (2 * STRIP);
        else column = SIDE + 1 + ((px - (xc + STRIP)) / half) * SIDE;
        return [row, column];
      },
      // a mask column's left edge, px
      columnX: (c) => (c <= SIDE ? x0 + (c / SIDE) * half : c <= SIDE + 1 ? xc - STRIP + (c - SIDE) * 2 * STRIP : xc + STRIP + ((c - SIDE - 1) / SIDE) * half),
    };
  }

  const image = document.createElement("canvas");
  const measuredImage = document.createElement("canvas");

  // A spectrum on the plane (`shown`, a modulation picture), darkened where
  // `mask` cuts, into `image`, one pixel per CSS pixel of the plot: each
  // pixel shows the analysis cell it falls in (the strip, the loudest cell
  // under 1 Hz) and the mask cell it falls in.
  function picture(g, shown, mask, image) {
    const width = Math.max(1, Math.round(g.x1 - g.x0));
    const height = Math.max(1, Math.round(g.y1 - g.y0));
    image.width = width;
    image.height = height;
    const context = image.getContext("2d");
    const pixels = context.createImageData(width, height);
    const floor = magma(0);
    const rowOf = Int32Array.from({ length: height }, (_, py) => Math.min(ROWS - 1, Math.max(0, Math.floor(g.cell(0, g.y0 + py + 0.5)[0]))));
    const densityCell = Int32Array.from({ length: height }, (_, py) => (shown ? Math.round(g.density(g.y0 + py + 0.5) / shown.densityStep) : -1));
    const level = new Float32Array(height);
    for (let px = 0; px < width; px++) {
      const x = g.x0 + px + 0.5;
      const column = Math.min(COLUMNS - 1, Math.max(0, Math.floor(g.cell(x, 0)[1])));
      level.fill(-1);
      if (shown) {
        const strip = Math.abs(x - g.xc) < STRIP;
        const ks = [];
        if (strip) {
          for (let k = 0; k < shown.nRates; k++) if (Math.abs(shown.rateFirst + k * shown.rateStep) < RATE_MIN) ks.push(k);
        } else {
          const k = Math.round((g.rate(x) - shown.rateFirst) / shown.rateStep);
          if (k >= 0 && k < shown.nRates) ks.push(k);
        }
        for (let py = 0; py < height; py++) {
          const j = densityCell[py];
          if (j < 0 || j >= shown.nDensities) continue;
          for (const k of ks) level[py] = Math.max(level[py], shown.data[j * shown.nRates + k] / 255);
        }
      }
      for (let py = 0; py < height; py++) {
        const i = 4 * (py * width + px);
        const color = level[py] >= 0 ? magma(level[py]) : floor;
        const cut = mask ? Math.min(mask[rowOf[py] * COLUMNS + column], -FLOOR_DB) / -FLOOR_DB : 0;
        const keep = 1 - 0.6 * cut; // cut cells stay readable underneath
        pixels.data[i] = color[0] * keep;
        pixels.data[i + 1] = color[1] * keep;
        pixels.data[i + 2] = color[2] * keep;
        pixels.data[i + 3] = 255;
      }
    }
    context.putImageData(pixels, 0, 0);
    return image;
  }

  // The mask's outline: cell edges where the cut crosses OUTLINE_DB.
  function outline(context, g, mask) {
    const rowY = (r) => g.y1 - (r / ROWS) * (g.y1 - g.y0);
    drawMaskOutline(context, mask, ROWS, COLUMNS, OUTLINE_DB, g.columnX, rowY);
  }

  // The plane's border, gridlines and labels, as on the Draw modulation tab
  // (`densities`: the ones labeled; `words`: the rate axis's name and directions).
  function axes(context, target, g, densities, words) {
    drawFrame(context, target, g);
    drawValueTicks(context, g, densities, g.y, (d) => `${d}`);
    if (words) drawAxisName(context, g, "cyc/oct");
    drawRateTicks(context, g, g.x, 2);
    context.fillText("0", g.xc, g.y1 + 4); // the strip: |rate| under 1 Hz
    if (words) drawRateAxisWords(context, g, g.xc);
  }

  function render() {
    if (!state) return;
    const context = fitCanvasInCssPixels(canvas);
    const g = geometry();
    context.clearRect(0, 0, g.width, g.height);
    const mask = stroke?.preview ?? bytes;
    context.imageSmoothingEnabled = false;
    context.drawImage(picture(g, source?.picture ?? null, mask, image), g.x0, g.y0, g.x1 - g.x0, g.y1 - g.y0);
    axes(context, canvas, g, [0, 1, 2, 3, 4, 5, 6], true);

    if (mask) {
      context.strokeStyle = "rgba(255, 255, 255, 0.85)";
      context.lineWidth = 1;
      outline(context, g, mask);
    }
    drawTitle(context, g, source ? "The source's modulation spectrum; what is erased is darkened and outlined" : "The source's modulation spectrum: Play to analyze it");

    if (pointer) drawBrush(context, pointer, Number(ui.size.value));
  }

  // What came out: the result's own modulation spectrum, measured from the
  // sound on the plane's axes, with the mask's outline over it, so what was
  // painted and what was heard compare by eye (E7; E-M3: an edit comes out
  // weaker than painted).
  const MEASURED_MARGIN = { left: MARGIN.left, right: MARGIN.right, top: 6, bottom: 22 };
  function renderMeasured() {
    const target = ui.measured;
    const context = fitCanvasInCssPixels(target);
    const g = geometry(target, MEASURED_MARGIN);
    context.clearRect(0, 0, g.width, g.height);
    if (!state) return;
    const shown = sound?.modulation ?? null;
    context.imageSmoothingEnabled = false;
    context.drawImage(picture(g, shown, null, measuredImage), g.x0, g.y0, g.x1 - g.x0, g.y1 - g.y0);
    axes(context, target, g, [0, 2, 4, 6], false);
    const mask = resultMask;
    if (mask && shown) {
      context.strokeStyle = "rgba(255, 255, 255, 0.6)";
      context.setLineDash([3, 3]);
      outline(context, g, mask);
      context.setLineDash([]);
    }
    drawTitle(context, g, shown ? "The result's modulation spectrum, measured; what was erased is outlined" : "The result's modulation spectrum: Play to measure it");
  }

  // E9: sonore clips envelopes an edit pushes below zero; say how much, not as an error.
  function showClipping() {
    const clipped = sound?.clipped ?? 0;
    ui.clipNote.hidden = !(clipped > 0);
    ui.clipNote.textContent = `${+(100 * clipped).toFixed(clipped < 0.01 ? 1 : 0)}% of the envelopes were clipped: the result differs from what is painted. A softer brush edge clips less.`;
  }

  // --- painting --------------------------------------------------------------------

  const local = (event) => pointerPosition(canvas, event);

  // A dab of the brush at pixel `at`, weighed by distance on screen, so the
  // wide center strip is cut only where the circle drawn on it reaches (a
  // radius in cells would be in side columns, about 6 times narrower).
  function dabAt(at) {
    const g = geometry();
    const radius = Math.max(1, Number(ui.size.value) / 2);
    const softness = Number(ui.softness.value);
    const side = g.half / SIDE; // a side column's width, px
    const rowHeight = (g.y1 - g.y0) / ROWS;
    const r0 = Math.max(0, Math.floor((g.y1 - at[1] - radius) / rowHeight));
    const r1 = Math.min(ROWS - 1, Math.floor((g.y1 - at[1] + radius) / rowHeight));
    for (let c = 0; c < COLUMNS; c++) {
      const left = g.columnX(c);
      const right = c === COLUMNS - 1 ? g.x1 : g.columnX(c + 1);
      // distance to the column: from its center, less any width beyond a side column's
      const dx = Math.max(0, Math.abs(at[0] - (left + right) / 2) - Math.max(0, (right - left - side) / 2));
      if (dx > radius) continue;
      for (let r = r0; r <= r1; r++) {
        const dy = at[1] - (g.y1 - (r + 0.5) * rowHeight);
        const w = brushWeight(Math.hypot(dx, dy) / radius, softness);
        const i = r * COLUMNS + c;
        if (w > stroke.weights[i]) stroke.weights[i] = w;
      }
    }
  }

  // Dab centers from a to b (px), a quarter of the brush's radius apart, not including a.
  function dabsAlongPx(a, b) {
    const step = Math.max(1, Number(ui.size.value) / 8);
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    return Array.from({ length: n }, (_, k) => [a[0] + ((k + 1) / n) * (b[0] - a[0]), a[1] + ((k + 1) / n) * (b[1] - a[1])]);
  }

  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener("pointerdown", (event) => {
    if (!state || !bytes || event.button > 2 || event.button === 1) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    // the brush's modes are the Draw spectrogram tab's: "paint" erases modulation, "erase" restores it
    const restore = mode === "erase" || event.button === 2;
    const cut = Math.min(-1, Math.max(FLOOR_DB, typedNumber(ui.cut.value, FLOOR_DB)));
    const at = local(event);
    stroke = { weights: new Float32Array(bytes.length), last: at, target: restore ? 0 : -cut, preview: null };
    dabAt(at);
    stroke.preview = applyCut(bytes, stroke.weights, stroke.target);
    render();
  });
  canvas.addEventListener("pointermove", (event) => {
    pointer = local(event);
    if (stroke) {
      const moves = event.getCoalescedEvents?.() ?? [event];
      for (const move of moves.length ? moves : [event]) {
        const at = local(move);
        for (const center of dabsAlongPx(stroke.last, at)) dabAt(center);
        stroke.last = at;
      }
      stroke.preview = applyCut(bytes, stroke.weights, stroke.target);
    }
    render();
  });
  canvas.addEventListener("pointerleave", () => {
    pointer = null;
    if (!stroke) render();
  });
  function finish(event) {
    if (!stroke) return;
    const next = stroke.preview;
    stroke = null;
    if (event.type === "pointercancel" || next.every((b, i) => b === bytes[i])) return render();
    bytes = next;
    render();
    renderMeasured();
    commitBytes(next);
  }
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", finish);

  // --- the result ------------------------------------------------------------------

  const stftPlot = logSpectrogramPlot(ui.stft, STFT_MARGIN);

  function renderStft() {
    const context = stftPlot.clear();
    if (!state) return;
    // the sound's own duration: a result of an older duration shows at its own times
    const plot = stftPlot.geometry(state.f_lo, state.f_hi, sound ? soundSeconds(sound) : state.duration);
    stftPlot.draw(context, plot, sound?.spectrogram, { named: false });
    if (playhead !== null) drawPlayhead(context, plot, plot.x(playhead), "#ffffff");
  }

  function renderWave() {
    drawWaveform(ui.wave, sound, sound ? soundSeconds(sound) : state?.duration ?? 1);
  }

  new ResizeObserver(render).observe(canvas);
  new ResizeObserver(renderStft).observe(ui.stft);
  new ResizeObserver(renderMeasured).observe(ui.measured);
  new ResizeObserver(renderWave).observe(ui.wave);

  return {
    id: "edit",
    figure: root.querySelector(".design-box .panel-stack"), // where the shell shows synthesis progress, over the plane
    ownWaveform: true, // drawn in the Result box
    setDocument(next) {
      stroke = null;
      state = next;
      if (source && source.key !== sourceKey(next)) source = null; // another source: its spectrum is not this one's
      showSettings();
      const decoded = cache.get(next.levels);
      if (decoded) {
        bytes = decoded;
        render();
        renderMeasured();
      } else {
        load(next);
      }
    },
    setResult(next) {
      sound = next ?? null;
      // made from the drawing shown now, so from this mask; later strokes are not in it yet
      resultMask = sound ? bytes : null;
      if (sound?.sourceModulation) source = { key: sourceKey(state), picture: sound.sourceModulation };
      if (sound?.clipped > 0) log?.info(`${Math.round(100 * sound.clipped)}% of the envelopes were clipped (sonore's warning)`);
      showClipping();
      render();
      renderMeasured();
      renderStft();
      renderWave();
    },
    setPlayhead(t) {
      playhead = t;
      renderStft();
    },
    blocked() {
      if (state.source === "file" && !state.recording) return "No recording: open an audio file (Source) to erase from.";
      return null;
    },
    key(event) {
      const key = event.key.toLowerCase();
      if (key === "e") setMode("paint");
      else if (key === "r") setMode("erase");
      else return false;
      return true;
    },
  };
}
