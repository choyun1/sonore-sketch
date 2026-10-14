// The Draw spectrogram tab: paint level on time x log-frequency and hear a sound
// whose spectrotemporal envelope is the painting (docs/design/tabs/painted.md).
//
// The grid is drawn on a canvas as an image, one pixel per cell, scaled to
// the plot with smoothing (close to the bilinear reading Python does). A
// stroke collects each cell's largest brush weight, and every cell moves
// toward the brush's level by its weight when the stroke ends.

import { magma } from "../colormap.js";
import {
  drawAxisName,
  drawBrush,
  drawFrame,
  drawPlayhead,
  drawTimeTicks,
  drawValueTicks,
  fitCanvasInCssPixels,
  frequencyLabel,
  pointerPosition,
} from "../plot.js";
import {
  CARRIERS,
  LevelCache,
  applyStroke,
  blank,
  dab,
  dabsAlong,
  isSilent,
  octaves,
  resampleRows,
  rows,
} from "./model.js";

const MARGIN = { left: 52, right: 10, top: 8, bottom: 22 };
const CACHE = 400; // decoded paintings kept, so undo and redo are instant
const FREQUENCY_TICKS = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

export function createPaintedTab(root, { commit, log }) {
  let state = null;
  let bytes = null; // the painting shown: state's levels, decoded
  let stroke = null; // {weights, last, target, preview} while painting
  let pointer = null; // [x, y] of the brush outline, or null
  let playhead = null;
  let mode = "paint";
  const cache = new LevelCache(CACHE);

  root.innerHTML = `
    <div class="painted-body">
      <div class="paint-area"><canvas class="paint"></canvas></div>
      <aside class="side">
        <fieldset><legend>Brush</legend>
          <label class="choice" title="Paint at the level below (B)"><input type="radio" name="paint-mode" value="paint" checked> Paint <kbd>B</kbd></label>
          <label class="choice" title="Paint silence; right-drag erases too (E)"><input type="radio" name="paint-mode" value="erase"> Erase <kbd>E</kbd></label>
          <label class="field" title="The brush's diameter on screen">Size <input type="range" class="size" min="4" max="80" value="18"></label>
          <label class="field" title="How much of the brush's radius fades out at its edge">Softness <input type="range" class="softness" min="0" max="1" step="0.05" value="0.6"></label>
          <label class="field" title="The level the brush paints, in dB below the loudest (0 dB)">Level <input type="number" class="level" min="-59" max="0" step="1" value="0"> dB</label>
        </fieldset>
        <fieldset><legend>Sound</legend>
          <label class="field" title="What the painting shapes: log-spaced tones, harmonics of F0, or noise">Carrier
            <select class="carrier">${CARRIERS.map((c) => `<option value="${c}">${c}</option>`).join("")}</select></label>
          <label class="field f0-field" title="The harmonic carrier's fundamental">F0 <input type="number" class="f0" min="20" max="1000" step="1"> Hz</label>
          <label class="field" title="The painted frequency range; changing it keeps what is painted inside the new range">Range
            <input type="number" class="f-lo" min="20" step="1" aria-label="Range from, Hz"> – <input type="number" class="f-hi" step="1" aria-label="Range to, Hz"> Hz</label>
        </fieldset>
        <p class="hint">Drag to paint; right-drag erases. Space plays. Ctrl+Z undoes.</p>
      </aside>
    </div>`;
  const $ = (selector) => root.querySelector(selector);
  const canvas = $("canvas.paint");
  const ui = {
    size: $(".size"), softness: $(".softness"), level: $(".level"),
    carrier: $(".carrier"), f0: $(".f0"), f0Field: $(".f0-field"), fLo: $(".f-lo"), fHi: $(".f-hi"),
  };
  for (const input of root.querySelectorAll('input[name="paint-mode"]')) {
    input.addEventListener("change", () => (mode = input.value));
  }
  function setMode(next) {
    mode = next;
    root.querySelector(`input[name="paint-mode"][value="${next}"]`).checked = true;
  }

  // --- the painting and its state ------------------------------------------------

  // Commit `next` bytes (and any other changes) as a new state.
  async function commitBytes(next, changes = {}) {
    const before = state;
    const levels = await cache.encode(next);
    // an undo, redo or opened file while encoding wins: the stroke was made on what it replaced
    if (state === before) commit({ ...state, ...changes, levels });
  }

  let loaded = Promise.resolve(); // the painting shown being read
  async function load(next) {
    const decoded = await cache.decode(next.levels, rows(next) * next.columns, () => blank(next), (error) =>
      log?.error(`could not read the painting: ${error.message}`),
    );
    if (state === next) {
      bytes = decoded;
      render();
    }
  }

  function showSettings() {
    ui.carrier.value = state.carrier;
    ui.f0.value = state.f0;
    ui.f0Field.hidden = state.carrier !== "harmonic";
    ui.fLo.value = state.f_lo;
    ui.fHi.value = state.f_hi;
    ui.fHi.max = Math.floor(state.fs / 2) - 1;
  }

  ui.carrier.addEventListener("change", () => commit({ ...state, carrier: ui.carrier.value }));
  // The harmonic carrier needs a harmonic of F0 inside the range, or sonore has nothing to shape.
  const hasHarmonic = (f0, f_lo, f_hi) => f0 > 0 && Math.ceil(f_lo / f0) * f0 <= f_hi;
  ui.f0.addEventListener("change", () => {
    const f0 = Number(ui.f0.value);
    if (f0 >= 20 && hasHarmonic(f0, state.f_lo, state.f_hi)) commit({ ...state, f0 });
    else ui.f0.value = state.f0;
  });
  function changeRange() {
    const f_lo = Number(ui.fLo.value);
    const f_hi = Number(ui.fHi.value);
    const ok = f_lo >= 20 && f_hi < state.fs / 2 && Math.log2(f_hi / f_lo) * state.rows_per_octave >= 2;
    if (!ok || !bytes || (f_lo === state.f_lo && f_hi === state.f_hi)) return showSettings();
    // an F0 with no harmonic left in the new range moves to its bottom, so the harmonic carrier still sounds
    const f0 = hasHarmonic(state.f0, f_lo, f_hi) ? state.f0 : Math.ceil(f_lo);
    const next = { ...state, f_lo, f_hi, f0 };
    commitBytes(resampleRows(bytes, state, next), { f_lo, f_hi, f0 });
  }
  ui.fLo.addEventListener("change", changeRange);
  ui.fHi.addEventListener("change", changeRange);

  // --- drawing ---------------------------------------------------------------------

  function geometry() {
    const width = canvas.clientWidth || 600;
    const height = canvas.clientHeight || 300;
    const x0 = MARGIN.left;
    const x1 = width - MARGIN.right;
    const y0 = MARGIN.top;
    const y1 = height - MARGIN.bottom;
    const span = octaves(state);
    return {
      width, height, x0, x1, y0, y1,
      x: (t) => x0 + (t / state.duration) * (x1 - x0),
      y: (f) => y1 - (Math.log2(f / state.f_lo) / span) * (y1 - y0),
      // a pointer position in cells: [row from the bottom, column]
      cell: (px, py) => [((y1 - py) / (y1 - y0)) * rows(state), ((px - x0) / (x1 - x0)) * state.columns],
    };
  }

  const image = document.createElement("canvas");

  function render() {
    if (!state) return;
    const context = fitCanvasInCssPixels(canvas);
    const g = geometry();
    context.clearRect(0, 0, g.width, g.height);

    const shown = stroke?.preview ?? bytes;
    if (shown) {
      const nRows = rows(state);
      const { columns } = state;
      image.width = columns;
      image.height = nRows;
      const pixels = image.getContext("2d").createImageData(columns, nRows);
      const floor = -state.floor_db;
      for (let row = 0; row < nRows; row++) {
        for (let c = 0; c < columns; c++) {
          const level = 1 - Math.min(shown[row * columns + c], floor) / floor;
          const i = 4 * ((nRows - 1 - row) * columns + c);
          pixels.data.set(magma(level), i); // in magma, as sonore plots levels
          pixels.data[i + 3] = 255;
        }
      }
      image.getContext("2d").putImageData(pixels, 0, 0);
      context.imageSmoothingEnabled = true;
      context.drawImage(image, g.x0, g.y0, g.x1 - g.x0, g.y1 - g.y0);
    }

    // the harmonic carrier sounds only at multiples of F0, so paint between them is silent:
    // mark each harmonic, until they come closer than a few pixels and paint anywhere sounds
    if (state.carrier === "harmonic") {
      context.strokeStyle = "rgba(120, 200, 255, 0.45)";
      context.lineWidth = 1;
      context.setLineDash([2, 3]);
      context.beginPath();
      for (let k = Math.ceil(state.f_lo / state.f0); k * state.f0 <= state.f_hi; k++) {
        const y = g.y(k * state.f0);
        if (y - g.y((k + 1) * state.f0) < 4) break;
        context.moveTo(g.x0, Math.round(y) + 0.5);
        context.lineTo(g.x1, Math.round(y) + 0.5);
      }
      context.stroke();
      context.setLineDash([]);
    }

    // axes
    drawFrame(context, canvas, g);
    const ticks = FREQUENCY_TICKS.filter((f) => f >= state.f_lo && f <= state.f_hi);
    drawValueTicks(context, g, ticks, g.y, frequencyLabel, { gridColor: "rgba(255, 255, 255, 0.18)", clamp: false }); // over the dark picture
    drawAxisName(context, g, "Hz");
    drawTimeTicks(context, g, state.duration, 5);

    if (playhead !== null) drawPlayhead(context, g, g.x(playhead), getComputedStyle(canvas).getPropertyValue("--accent").trim() || "#d1495b");
    if (pointer) drawBrush(context, pointer, Number(ui.size.value));
  }

  // --- painting --------------------------------------------------------------------

  const local = (event) => pointerPosition(canvas, event);

  function brush(g) {
    const radius = Number(ui.size.value) / 2;
    return {
      rRow: Math.max(0.5, (radius / (g.y1 - g.y0)) * rows(state)),
      rColumn: Math.max(0.5, (radius / (g.x1 - g.x0)) * state.columns),
      softness: Number(ui.softness.value),
    };
  }

  function dabAt(at) {
    const { rRow, rColumn, softness } = brush(geometry());
    dab(stroke.weights, rows(state), state.columns, at[0], at[1], rRow, rColumn, softness);
  }

  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener("pointerdown", (event) => {
    if (!state || !bytes || event.button > 2 || event.button === 1) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    const erase = mode === "erase" || event.button === 2;
    const level = Math.min(0, Math.max(state.floor_db + 1, Number(ui.level.value) || 0));
    const at = geometry().cell(...local(event));
    stroke = {
      weights: new Float32Array(bytes.length),
      last: at,
      target: erase ? -state.floor_db : -level,
      preview: null,
    };
    dabAt(at);
    stroke.preview = applyStroke(bytes, stroke.weights, stroke.target);
    render();
  });

  canvas.addEventListener("pointermove", (event) => {
    pointer = local(event);
    if (stroke) {
      const { rRow, rColumn } = brush(geometry());
      const moves = event.getCoalescedEvents?.() ?? [event];
      for (const move of moves.length ? moves : [event]) {
        const at = geometry().cell(...local(move));
        for (const center of dabsAlong(stroke.last, at, rRow, rColumn)) dabAt(center);
        stroke.last = at;
      }
      stroke.preview = applyStroke(bytes, stroke.weights, stroke.target);
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
    commitBytes(next);
  }
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", finish);

  new ResizeObserver(render).observe(canvas);

  return {
    id: "painted",
    figure: canvas.parentElement, // where the shell shows synthesis progress
    setDocument(next) {
      stroke = null;
      state = next;
      showSettings();
      const decoded = cache.get(next.levels);
      if (decoded) {
        bytes = decoded;
        loaded = Promise.resolve();
        render();
      } else {
        bytes = null; // until it is read, so no stroke or range change lands on the painting before
        loaded = load(next);
      }
    },
    setResult() {},
    setPlayhead(t) {
      playhead = t;
      render();
    },
    // Why there is nothing to synthesize yet, if so, once the painting shown
    // is read (a Clear or an Undo can bring one not read yet).
    async blocked() {
      await loaded;
      if (bytes && isSilent(bytes, state)) return "Nothing painted yet: paint something to hear it.";
      return null;
    },
    key(event) {
      const key = event.key.toLowerCase();
      if (key === "b") setMode("paint");
      else if (key === "e") setMode("erase");
      else return false;
      return true;
    },
  };
}
