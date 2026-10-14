// The Erase spectrogram tab: paint over parts of a sound's spectrogram to
// turn them down or remove them, and hear what is left
// (docs/design/tabs/mask.md).
//
// The plane is time x frequency, linear from 0 Hz to Nyquist (F4), and shows
// the source's spectrogram in the mask's own 32 ms STFT (F5), made by Python
// with each sound. What is painted darkens the picture and is outlined where
// the cut is deep, so the source stays readable. A stroke collects each
// cell's largest brush weight and moves every cell toward the brush's cut by
// its weight when it ends, as on the other painting tabs.
//
// Below, in the Result box: the result's spectrogram in the same STFT, on
// the same axes and scale, with the mask's outline over it, and its waveform.

import { magma } from "../colormap.js";
import {
  drawAxisName,
  drawBrush,
  drawFrame,
  drawMaskOutline,
  drawPlayhead,
  drawTimeTicks,
  drawTitle,
  drawValueTicks,
  drawWaveform,
  fitCanvasInCssPixels,
  frequencyLabel,
  pointerPosition,
  soundSeconds,
} from "../plot.js";
import { LevelCache, applyCut, dab, dabsAlong, typedNumber } from "../painted/model.js";
import { attachSourceControls, sourceFieldset } from "../sources.js";
import { COLUMNS, FLOOR_DB, ROWS, blank, retime } from "./model.js";

const MARGIN = { left: 52, right: 10, top: 8, bottom: 22 };
const CACHE = 200; // decoded masks kept, so undo and redo are instant
const OUTLINE_DB = 30; // the mask's outline runs where the cut crosses this
const FREQUENCY_STEPS = [250, 500, 1000, 2000, 5000];

export function createMaskTab(root, { commit, openRecording, hasRecording, log }) {
  let state = null;
  let bytes = null; // the mask shown: state's levels, decoded
  let stroke = null; // {weights, last, target, preview} while painting
  let resultMask = null; // {bytes, duration}: the mask the result shown was made with, for its outline
  let pointer = null;
  let mode = "paint";
  let sound = null;
  let source = null; // {key, picture}: the source's spectrogram, kept while only the mask changes
  let playhead = null;
  const cache = new LevelCache(CACHE);

  root.innerHTML = `
    <div class="mask-body">
      <div class="paint-area">
        <section class="panel-box design-box">
          <h3 class="panel-group" title="What you paint: what to erase from the source's spectrogram">Design</h3>
          <div class="panel-stack">
            <canvas class="filter-plane" title="The source's spectrogram (32 ms window); what you paint is turned down or removed"></canvas>
          </div>
        </section>
        <section class="panel-box result-box">
          <h3 class="panel-group" title="What came out">Result</h3>
          <div class="panel-stack">
            <canvas class="filter-result" title="The result's spectrogram, in the same window and on the same scale as the source's above"></canvas>
            <canvas class="wave" title="The result's waveform"></canvas>
          </div>
        </section>
      </div>
      <aside class="side">
        ${sourceFieldset("The sound you erase from")}
        <fieldset><legend>Brush</legend>
          <label class="choice" title="Erase what you paint over (E)"><input type="radio" name="mask-mode" value="paint" checked> Erase <kbd>E</kbd></label>
          <label class="choice" title="Restore what was erased; right-drag restores too (R)"><input type="radio" name="mask-mode" value="erase"> Restore <kbd>R</kbd></label>
          <label class="field" title="The brush's diameter on screen">Size <input type="range" class="size" min="4" max="80" value="18"></label>
          <label class="field" title="How much of the brush's radius fades out at its edge">Softness <input type="range" class="softness" min="0" max="1" step="0.05" value="0.4"></label>
          <label class="field" title="How deep Erase goes: ${FLOOR_DB} dB removes what it covers">Depth <input type="number" class="cut" min="${FLOOR_DB}" max="-1" step="1" value="${FLOOR_DB}"> dB</label>
        </fieldset>
        <p class="hint">Paint on the spectrogram to erase that part of the sound; right-drag restores it. Harmonics are the evenly spaced lines, so one is a straight stroke. Space plays.</p>
      </aside>
    </div>`;
  const query = (selector) => root.querySelector(selector);
  const canvas = query("canvas.filter-plane");
  const ui = {
    size: query(".size"), softness: query(".softness"), cut: query(".cut"),
    result: query("canvas.filter-result"), wave: query("canvas.wave"),
  };
  for (const input of root.querySelectorAll('input[name="mask-mode"]')) input.addEventListener("change", () => (mode = input.value));
  function setMode(next) {
    mode = next;
    root.querySelector(`input[name="mask-mode"][value="${next}"]`).checked = true;
  }

  // --- the mask and its state --------------------------------------------------------

  async function commitBytes(next) {
    const before = state;
    const levels = await cache.encode(next);
    // an undo, redo or opened file while encoding wins: the stroke was made on what it replaced
    if (state !== before) return;
    // `bytes` are on the duration's columns (load retimes them), so the span goes
    const { span: _span, ...rest } = state;
    commit({ ...rest, levels });
  }

  async function load(next) {
    const decoded = await cache.decode(next.levels, ROWS * COLUMNS, blank, (error) =>
      log?.error(`could not read the Erase spectrogram mask: ${error.message}`),
    );
    if (state === next) {
      bytes = retime(decoded, next.span, next.duration); // erasures kept in seconds (model.js, stretchSection)
      renderAll();
    }
  }

  // The source's identity: its picture is kept while only the mask changes.
  const sourceKey = (tabState) =>
    JSON.stringify([tabState.source, tabState.duration, tabState.fs, tabState.speech ?? null, tabState.recording?.pcm16.length ?? 0, tabState.recording?.name ?? ""]);

  const showSettings = attachSourceControls(root, { state: () => state, commit, openRecording, hasRecording, log });

  // --- the plane -------------------------------------------------------------------

  function geometry(target = canvas) {
    const width = target.clientWidth || 600;
    const height = target.clientHeight || 300;
    const x0 = MARGIN.left;
    const x1 = width - MARGIN.right;
    const y0 = MARGIN.top;
    const y1 = height - MARGIN.bottom;
    const duration = state.duration;
    const nyquist = state.fs / 2;
    return {
      width, height, x0, x1, y0, y1, duration, nyquist,
      x: (t) => x0 + (t / duration) * (x1 - x0),
      y: (f) => y1 - (f / nyquist) * (y1 - y0),
      // a pixel's place on the mask, in cells: [row from 0 Hz, column]
      cell: (x, y) => [((y1 - y) / (y1 - y0)) * ROWS, ((x - x0) / (x1 - x0)) * COLUMNS],
    };
  }

  // A spectrogram (`shown`, in the mask's STFT) darkened where `mask` cuts,
  // into `image`, one pixel per CSS pixel of the plot.
  function picture(plot, shown, mask, image) {
    const width = Math.max(1, Math.round(plot.x1 - plot.x0));
    const height = Math.max(1, Math.round(plot.y1 - plot.y0));
    image.width = width;
    image.height = height;
    const context = image.getContext("2d");
    const pixels = context.createImageData(width, height);
    const floor = magma(0);
    const maskRowOf = Int32Array.from({ length: height }, (_, pixelY) => Math.min(ROWS - 1, Math.max(0, Math.floor(((height - pixelY - 0.5) / height) * ROWS))));
    const binOf = Int32Array.from({ length: height }, (_, pixelY) =>
      shown ? Math.round((((height - pixelY - 0.5) / height) * plot.nyquist / shown.fMax) * (shown.nFreqs - 1)) : -1,
    );
    for (let pixelX = 0; pixelX < width; pixelX++) {
      const t = ((pixelX + 0.5) / width) * plot.duration;
      const column = Math.min(COLUMNS - 1, Math.floor(((pixelX + 0.5) / width) * COLUMNS));
      const timeWindow = shown ? Math.round((t - shown.tStart) / shown.tStep) : -1;
      const inside = shown && timeWindow >= 0 && timeWindow < shown.nWindows;
      for (let pixelY = 0; pixelY < height; pixelY++) {
        const bin = binOf[pixelY];
        const color = inside && bin >= 0 && bin < shown.nFreqs ? magma(shown.data[bin * shown.nWindows + timeWindow] / 255) : floor;
        const cut = mask ? Math.min(mask[maskRowOf[pixelY] * COLUMNS + column], -FLOOR_DB) / -FLOOR_DB : 0;
        const keep = 1 - 0.6 * cut; // erased cells stay readable underneath
        const i = 4 * (pixelY * width + pixelX);
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
    const columnX = (column) => plot.x0 + (column / COLUMNS) * (plot.x1 - plot.x0);
    const rowY = (row) => plot.y1 - (row / ROWS) * (plot.y1 - plot.y0);
    drawMaskOutline(context, mask, ROWS, COLUMNS, OUTLINE_DB, columnX, rowY);
  }

  function axes(context, target, plot) {
    drawFrame(context, target, plot);
    const frequencyStep = FREQUENCY_STEPS.find((step) => ((plot.y1 - plot.y0) * step) / plot.nyquist >= 28) ?? 5000;
    const frequencies = [];
    for (let f = 0; f <= plot.nyquist + 1e-9; f += frequencyStep) frequencies.push(f);
    drawValueTicks(context, plot, frequencies, plot.y, frequencyLabel);
    drawAxisName(context, plot, "Hz");
    drawTimeTicks(context, plot, plot.duration, 5);
    if (playhead !== null) drawPlayhead(context, plot, plot.x(playhead), "#ffffff");
  }

  // The pictures are redrawn only when what they show changes, not for the playhead.
  const planeImage = document.createElement("canvas");
  const resultImage = document.createElement("canvas");
  const drawn = new Map(); // image -> [shown, mask, width, height, duration, fs]
  function cached(plot, shown, mask, target) {
    const key = [shown, mask, Math.round(plot.x1 - plot.x0), Math.round(plot.y1 - plot.y0), plot.duration, plot.nyquist];
    const last = drawn.get(target);
    if (!last || key.some((part, i) => part !== last[i])) {
      picture(plot, shown, mask, target);
      drawn.set(target, key);
    }
    return target;
  }

  function render() {
    if (!state) return;
    const context = fitCanvasInCssPixels(canvas);
    const plot = geometry();
    context.clearRect(0, 0, plot.width, plot.height);
    const mask = stroke?.preview ?? bytes;
    context.imageSmoothingEnabled = false;
    context.drawImage(cached(plot, source?.picture ?? null, mask, planeImage), plot.x0, plot.y0, plot.x1 - plot.x0, plot.y1 - plot.y0);
    axes(context, canvas, plot);
    if (mask) {
      context.strokeStyle = "rgba(255, 255, 255, 0.85)";
      outline(context, plot, mask);
    }
    drawTitle(context, plot, source ? "The source's spectrogram; what is erased is darkened and outlined" : "The source's spectrogram: Play to see it");
    if (pointer) drawBrush(context, pointer, Number(ui.size.value));
  }

  // What came out, in the same STFT and on the same scale as the source's,
  // with the mask's outline: a cut least squares could not keep shows here.
  function renderResult() {
    const target = ui.result;
    const context = fitCanvasInCssPixels(target);
    if (!state) return;
    const plot = geometry(target);
    context.clearRect(0, 0, plot.width, plot.height);
    const shown = sound?.resultStft ?? null;
    context.imageSmoothingEnabled = false;
    context.drawImage(cached(plot, shown, null, resultImage), plot.x0, plot.y0, plot.x1 - plot.x0, plot.y1 - plot.y0);
    axes(context, target, plot);
    // on the duration shown: the result keeps its own seconds, as its spectrogram does
    const mask = resultMask && retime(resultMask.bytes, resultMask.duration, state.duration);
    if (mask && shown) {
      context.strokeStyle = "rgba(255, 255, 255, 0.6)";
      context.setLineDash([3, 3]);
      outline(context, plot, mask);
      context.setLineDash([]);
    }
    drawTitle(context, plot, shown ? "The result's spectrogram; what was erased is outlined" : "The result's spectrogram: Play to hear it");
  }

  function renderWave() {
    drawWaveform(ui.wave, sound, sound ? soundSeconds(sound) : state?.duration ?? 1);
  }

  function renderAll() {
    render();
    renderResult();
  }

  // --- painting --------------------------------------------------------------------

  const local = (event) => pointerPosition(canvas, event);

  function brush(plot) {
    const radius = Number(ui.size.value) / 2;
    return {
      rowRadius: Math.max(0.5, (radius / (plot.y1 - plot.y0)) * ROWS),
      columnRadius: Math.max(0.5, (radius / (plot.x1 - plot.x0)) * COLUMNS),
      softness: Number(ui.softness.value),
    };
  }

  function dabAt(at) {
    const { rowRadius, columnRadius, softness } = brush(geometry());
    dab(stroke.weights, ROWS, COLUMNS, at[0], at[1], rowRadius, columnRadius, softness);
  }

  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener("pointerdown", (event) => {
    if (!state || !bytes || event.button > 2 || event.button === 1) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    // the brush's modes are the Draw spectrogram tab's: "paint" erases, "erase" restores
    const restore = mode === "erase" || event.button === 2;
    const cut = Math.min(-1, Math.max(FLOOR_DB, typedNumber(ui.cut.value, FLOOR_DB)));
    const at = geometry().cell(...local(event));
    stroke = { weights: new Float32Array(bytes.length), last: at, target: restore ? 0 : -cut, preview: null };
    dabAt(at);
    stroke.preview = applyCut(bytes, stroke.weights, stroke.target);
    render();
  });
  canvas.addEventListener("pointermove", (event) => {
    pointer = local(event);
    if (stroke) {
      const { rowRadius, columnRadius } = brush(geometry());
      const moves = event.getCoalescedEvents?.() ?? [event];
      for (const move of moves.length ? moves : [event]) {
        const at = geometry().cell(...local(move));
        for (const center of dabsAlong(stroke.last, at, rowRadius, columnRadius)) dabAt(center);
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
    renderAll();
    commitBytes(next);
  }
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", finish);

  new ResizeObserver(render).observe(canvas);
  new ResizeObserver(renderResult).observe(ui.result);
  new ResizeObserver(renderWave).observe(ui.wave);

  return {
    id: "mask",
    figure: root.querySelector(".design-box .panel-stack"), // where the shell shows synthesis progress, over the plane
    ownWaveform: true, // drawn in the Result box
    setDocument(next) {
      stroke = null;
      state = next;
      if (source && source.key !== sourceKey(next)) source = null; // another source: its picture is not this one's
      showSettings();
      const decoded = cache.get(next.levels);
      if (decoded) {
        bytes = retime(decoded, next.span, next.duration);
        renderAll();
      } else {
        load(next);
      }
    },
    setResult(next) {
      sound = next ?? null;
      // made from the drawing shown now, so from this mask; later strokes are not in it yet
      resultMask = sound ? { bytes, duration: state.duration } : null;
      if (sound?.sourceStft) source = { key: sourceKey(state), picture: sound.sourceStft };
      renderAll();
      renderWave();
    },
    setPlayhead(t) {
      playhead = t;
      renderAll();
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
