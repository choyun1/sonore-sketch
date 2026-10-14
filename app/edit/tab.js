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
  drawBorder,
  drawMaskOutline,
  drawPlayhead,
  drawRateAxisWords,
  drawRateTicks,
  drawTitle,
  drawValueTicks,
  drawWaveform,
  fitCanvasInCssPixels,
  logSpectrogramPlot,
  pointerPosition,
  soundSeconds,
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
            <select class="carrier">${CARRIERS.map((carrier) => `<option value="${carrier}">${CARRIER_LABELS[carrier]}</option>`).join("")}</select></label>
          <label class="field" title="How many times to search for a sound whose own modulation comes closer to what is left (each one an analysis and a synthesis; slower). On the source's own fine structure, an erasure needs a few to be heard">Iterations <input type="number" class="iterations" min="0" max="${MAX_ITERATIONS}" step="1"></label>
        </fieldset>
        <p class="hint coarse" hidden></p>
        <p class="hint">Paint on the plane to erase that modulation; right-drag restores it. Space plays.</p>
      </aside>
    </div>`;
  const query = (selector) => root.querySelector(selector);
  const canvas = query("canvas.mask-plane");
  const ui = {
    size: query(".size"), softness: query(".softness"), cut: query(".cut"),
    keepBelow: query(".keep-below"), keepRate: query(".keep-rate"), noDown: query(".no-down"), noUp: query(".no-up"),
    carrier: query(".carrier"), iterations: query(".iterations"), coarse: query(".coarse"), stft: query("canvas.result-stft"), wave: query("canvas.wave"),
    measured: query("canvas.measured-plane"), clipNote: query(".clip-note"),
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
  const sourceKey = (tabState) =>
    JSON.stringify([
      tabState.source, tabState.duration, tabState.fs, tabState.f_lo, tabState.f_hi, tabState.bands_per_octave,
      tabState.speech ?? null, tabState.recording?.pcm16.length ?? 0, tabState.recording?.name ?? "",
    ]);

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
    const iterations = Math.round(typedNumber(ui.iterations.value, NaN));
    if (iterations >= 0 && iterations <= MAX_ITERATIONS && iterations !== state.iterations) commit({ ...state, iterations });
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

  // The plane's plot on `target` (the design plane, or the measured one
  // below): x0 to x1, y0 to y1, the strip around xc, and `half` the width of
  // each side; pixels to and from rate, density and the mask's cells.
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
    const unitOf = (rate) => Math.min(1, Math.log2(Math.max(Math.abs(rate), RATE_MIN) / RATE_MIN) / span);
    return {
      width, height, x0, x1, y0, y1, xc, half,
      // rates under 1 Hz sit in the center strip
      x: (rate) => (Math.abs(rate) < RATE_MIN ? xc : rate > 0 ? xc + STRIP + unitOf(rate) * half : xc - STRIP - unitOf(rate) * half),
      y: (density) => y1 - (density / DENSITY_MAX) * (y1 - y0),
      // the rate at a pixel; the strip is |rate| < 1 Hz, shown as 0
      rate: (x) => {
        if (Math.abs(x - xc) < STRIP) return 0;
        const unit = Math.min(1, Math.max(0, (Math.abs(x - xc) - STRIP) / half));
        return Math.sign(x - xc) * RATE_MIN * 2 ** (unit * span);
      },
      density: (y) => ((y1 - y) / (y1 - y0)) * DENSITY_MAX,
      // a pixel's place on the mask, in cells: [row from density 0, column]
      cell: (x, y) => {
        const row = ((y1 - y) / (y1 - y0)) * ROWS;
        let column;
        if (x <= xc - STRIP) column = ((x - x0) / half) * SIDE;
        else if (x < xc + STRIP) column = SIDE + (x - (xc - STRIP)) / (2 * STRIP);
        else column = SIDE + 1 + ((x - (xc + STRIP)) / half) * SIDE;
        return [row, column];
      },
      // a mask column's left edge, px
      columnX: (column) =>
        column <= SIDE ? x0 + (column / SIDE) * half
          : column <= SIDE + 1 ? xc - STRIP + (column - SIDE) * 2 * STRIP
            : xc + STRIP + ((column - SIDE - 1) / SIDE) * half,
    };
  }

  const planeImage = document.createElement("canvas");
  const measuredImage = document.createElement("canvas");

  // A spectrum on the plane (`shown`, a modulation picture), darkened where
  // `mask` cuts, into `image`, one pixel per CSS pixel of the plot: each
  // pixel shows the analysis cell it falls in (the strip, the loudest cell
  // under 1 Hz) and the mask cell it falls in.
  function picture(plot, shown, mask, image) {
    const width = Math.max(1, Math.round(plot.x1 - plot.x0));
    const height = Math.max(1, Math.round(plot.y1 - plot.y0));
    image.width = width;
    image.height = height;
    const context = image.getContext("2d");
    const pixels = context.createImageData(width, height);
    const floor = magma(0);
    const maskRowOf = Int32Array.from({ length: height }, (_, pixelY) => Math.min(ROWS - 1, Math.max(0, Math.floor(plot.cell(0, plot.y0 + pixelY + 0.5)[0]))));
    const densityCellOf = Int32Array.from({ length: height }, (_, pixelY) => (shown ? Math.round(plot.density(plot.y0 + pixelY + 0.5) / shown.densityStep) : -1));
    const levels = new Float32Array(height);
    for (let pixelX = 0; pixelX < width; pixelX++) {
      const x = plot.x0 + pixelX + 0.5;
      const column = Math.min(COLUMNS - 1, Math.max(0, Math.floor(plot.cell(x, 0)[1])));
      levels.fill(-1);
      if (shown) {
        const inStrip = Math.abs(x - plot.xc) < STRIP;
        const rateCells = [];
        if (inStrip) {
          for (let rateIndex = 0; rateIndex < shown.nRates; rateIndex++) if (Math.abs(shown.rateFirst + rateIndex * shown.rateStep) < RATE_MIN) rateCells.push(rateIndex);
        } else {
          const rateIndex = Math.round((plot.rate(x) - shown.rateFirst) / shown.rateStep);
          if (rateIndex >= 0 && rateIndex < shown.nRates) rateCells.push(rateIndex);
        }
        for (let pixelY = 0; pixelY < height; pixelY++) {
          const densityIndex = densityCellOf[pixelY];
          if (densityIndex < 0 || densityIndex >= shown.nDensities) continue;
          for (const rateIndex of rateCells) levels[pixelY] = Math.max(levels[pixelY], shown.data[densityIndex * shown.nRates + rateIndex] / 255);
        }
      }
      for (let pixelY = 0; pixelY < height; pixelY++) {
        const i = 4 * (pixelY * width + pixelX);
        const color = levels[pixelY] >= 0 ? magma(levels[pixelY]) : floor;
        const cut = mask ? Math.min(mask[maskRowOf[pixelY] * COLUMNS + column], -FLOOR_DB) / -FLOOR_DB : 0;
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
  function outline(context, plot, mask) {
    const rowY = (row) => plot.y1 - (row / ROWS) * (plot.y1 - plot.y0);
    drawMaskOutline(context, mask, ROWS, COLUMNS, OUTLINE_DB, plot.columnX, rowY);
  }

  // The plane's border, gridlines and labels, as on the Draw modulation tab
  // (`densities`: the ones labeled; `words`: the rate axis's name and directions).
  function axes(context, target, plot, densities, words) {
    drawBorder(context, target, plot);
    drawValueTicks(context, plot, densities, plot.y, (density) => `${density}`);
    if (words) drawAxisName(context, plot, "cyc/oct");
    drawRateTicks(context, plot, plot.x, 2);
    context.fillText("0", plot.xc, plot.y1 + 4); // the strip: |rate| under 1 Hz
    if (words) drawRateAxisWords(context, plot, plot.xc);
  }

  function render() {
    if (!state) return;
    const context = fitCanvasInCssPixels(canvas);
    const plot = geometry();
    context.clearRect(0, 0, plot.width, plot.height);
    const mask = stroke?.preview ?? bytes;
    context.imageSmoothingEnabled = false;
    context.drawImage(picture(plot, source?.picture ?? null, mask, planeImage), plot.x0, plot.y0, plot.x1 - plot.x0, plot.y1 - plot.y0);
    axes(context, canvas, plot, [0, 1, 2, 3, 4, 5, 6], true);

    if (mask) {
      context.strokeStyle = "rgba(255, 255, 255, 0.85)";
      context.lineWidth = 1;
      outline(context, plot, mask);
    }
    drawTitle(context, plot, source ? "The source's modulation spectrum; what is erased is darkened and outlined" : "The source's modulation spectrum: Play to analyze it");

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
    const plot = geometry(target, MEASURED_MARGIN);
    context.clearRect(0, 0, plot.width, plot.height);
    if (!state) return;
    const shown = sound?.modulation ?? null;
    context.imageSmoothingEnabled = false;
    context.drawImage(picture(plot, shown, null, measuredImage), plot.x0, plot.y0, plot.x1 - plot.x0, plot.y1 - plot.y0);
    axes(context, target, plot, [0, 2, 4, 6], false);
    const mask = resultMask;
    if (mask && shown) {
      context.strokeStyle = "rgba(255, 255, 255, 0.6)";
      context.setLineDash([3, 3]);
      outline(context, plot, mask);
      context.setLineDash([]);
    }
    drawTitle(context, plot, shown ? "The result's modulation spectrum, measured; what was erased is outlined" : "The result's modulation spectrum: Play to measure it");
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
    const plot = geometry();
    const radius = Math.max(1, Number(ui.size.value) / 2);
    const softness = Number(ui.softness.value);
    const sideColumnWidth = plot.half / SIDE; // px
    const rowHeight = (plot.y1 - plot.y0) / ROWS;
    const firstRow = Math.max(0, Math.floor((plot.y1 - at[1] - radius) / rowHeight));
    const lastRow = Math.min(ROWS - 1, Math.floor((plot.y1 - at[1] + radius) / rowHeight));
    for (let column = 0; column < COLUMNS; column++) {
      const left = plot.columnX(column);
      const right = column === COLUMNS - 1 ? plot.x1 : plot.columnX(column + 1);
      // distance to the column: from its center, less any width beyond a side column's
      const across = Math.max(0, Math.abs(at[0] - (left + right) / 2) - Math.max(0, (right - left - sideColumnWidth) / 2));
      if (across > radius) continue;
      for (let row = firstRow; row <= lastRow; row++) {
        const along = at[1] - (plot.y1 - (row + 0.5) * rowHeight);
        const weight = brushWeight(Math.hypot(across, along) / radius, softness);
        const i = row * COLUMNS + column;
        if (weight > stroke.weights[i]) stroke.weights[i] = weight;
      }
    }
  }

  // Dab centers from `from` to `to` (px), a quarter of the brush's radius
  // apart, not including `from`.
  function dabsAlongPx(from, to) {
    const spacing = Math.max(1, Number(ui.size.value) / 8);
    const count = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / spacing));
    return Array.from({ length: count }, (_, k) => [from[0] + ((k + 1) / count) * (to[0] - from[0]), from[1] + ((k + 1) / count) * (to[1] - from[1])]);
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
    if (event.type === "pointercancel" || next.every((cell, i) => cell === bytes[i])) return render();
    bytes = next;
    render();
    renderMeasured();
    commitBytes(next);
  }
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", finish);

  // --- the result ------------------------------------------------------------------

  const stftPanel = logSpectrogramPlot(ui.stft, STFT_MARGIN);

  function renderStft() {
    const context = stftPanel.clear();
    if (!state) return;
    // the sound's own duration: a result of an older duration shows at its own times
    const plot = stftPanel.geometry(state.f_lo, state.f_hi, sound ? soundSeconds(sound) : state.duration);
    stftPanel.draw(context, plot, sound?.spectrogram, { named: false });
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
