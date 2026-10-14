// Pictures of a result (a spectrogram image and a waveform) on canvases, and
// the pieces of a plot the tabs share: frames, ticks, labels, the playhead
// and the brush. A plot is a box on its canvas, in CSS pixels, from x0 to x1
// across and from y0 (top) to y1 (bottom).

import { absolutePeak } from "./audio.js";
import { magma } from "./colormap.js";

const GRID_COLOR = "rgba(255, 255, 255, 0.15)"; // gridlines over the dark pictures
const LOG_FREQUENCY_TICKS = [100, 200, 500, 1000, 2000, 5000];
const RATE_TICKS = [1, 2, 4, 8, 16, 32, 64];

// Size a canvas's backing store to its displayed size; returns its context.
export function fitCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return canvas.getContext("2d");
}

// fitCanvas, with the context drawing in CSS pixels.
export function fitCanvasInCssPixels(canvas) {
  const context = fitCanvas(canvas);
  const ratio = canvas.width / (canvas.clientWidth || 1);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return context;
}

// Where a pointer event is on `element`, in CSS pixels from its top left.
export function pointerPosition(element, event) {
  const box = element.getBoundingClientRect();
  return [event.clientX - box.left, event.clientY - box.top];
}

// A sound's own length in seconds.
export function soundSeconds(sound) {
  return sound.samples.length / sound.fs;
}

// Draw `picture` (8-bit levels, rows from 0 Hz up) over time [0, duration]
// and frequency [0, fTop], in magma, as sonore plots it.
export function drawSpectrogram(canvas, picture, duration, fTop) {
  const context = fitCanvas(canvas);
  const { width, height } = canvas;
  context.clearRect(0, 0, width, height);
  if (!picture) return;
  const { data, nFreqs, nWindows, fMax, tStart, tStep } = picture;
  const image = context.createImageData(width, height);
  const [red, green, blue] = magma(0);
  for (let i = 0; i < image.data.length; i += 4) image.data.set([red, green, blue, 255], i);
  for (let x = 0; x < width; x++) {
    const t = ((x + 0.5) / width) * duration;
    const timeWindow = Math.round((t - tStart) / tStep);
    if (timeWindow < 0 || timeWindow >= nWindows) continue;
    for (let y = 0; y < height; y++) {
      const f = (1 - (y + 0.5) / height) * fTop;
      const row = Math.round((f / fMax) * (nFreqs - 1));
      if (row < 0 || row >= nFreqs) continue;
      const level = data[row * nWindows + timeWindow] / 255;
      const i = 4 * (y * width + x);
      image.data.set(magma(level), i);
      image.data[i + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
}

// The 5 ms spectrogram (the shell's) on a log-frequency axis from fLo up
// `span` octaves over `duration` s, into `target`, width x height pixels.
export function paintLogSpectrogram(target, picture, width, height, fLo, span, duration) {
  target.width = width;
  target.height = height;
  const pixels = target.getContext("2d").createImageData(width, height);
  const floor = magma(0);
  for (let i = 0; i < pixels.data.length; i += 4) {
    pixels.data.set(floor, i);
    pixels.data[i + 3] = 255;
  }
  if (picture) {
    const { data, nFreqs, nWindows, fMax, tStart, tStep } = picture;
    const binOfRow = Int32Array.from({ length: height }, (_, y) => Math.round(((fLo * 2 ** ((1 - (y + 0.5) / height) * span)) / fMax) * (nFreqs - 1)));
    for (let x = 0; x < width; x++) {
      const timeWindow = Math.round((((x + 0.5) / width) * duration - tStart) / tStep);
      if (timeWindow < 0 || timeWindow >= nWindows) continue;
      for (let y = 0; y < height; y++) {
        const bin = binOfRow[y];
        if (bin < 0 || bin >= nFreqs) continue;
        pixels.data.set(magma(data[bin * nWindows + timeWindow] / 255), 4 * (y * width + x));
      }
    }
  }
  target.getContext("2d").putImageData(pixels, 0, 0);
}

// The waveform of `sound` (or nothing) as a min-max envelope per pixel
// column, over `duration` s.
export function drawWaveform(canvas, sound, duration) {
  const context = fitCanvas(canvas);
  const { width, height } = canvas;
  context.clearRect(0, 0, width, height);
  if (!sound?.samples) return;
  const { samples, fs } = sound;
  const peak = absolutePeak(samples);
  if (!peak) return;
  context.fillStyle = getComputedStyle(canvas).getPropertyValue("--wave").trim() || "#2e86ab";
  const middle = height / 2;
  for (let x = 0; x < width; x++) {
    const first = Math.floor(((x / width) * duration) * fs);
    const end = Math.min(samples.length, Math.floor((((x + 1) / width) * duration) * fs));
    let lowest = 0;
    let highest = 0;
    for (let i = first; i < end; i++) {
      lowest = Math.min(lowest, samples[i]);
      highest = Math.max(highest, samples[i]);
    }
    const top = middle - (highest / peak) * middle * 0.95;
    const bottom = middle - (lowest / peak) * middle * 0.95;
    context.fillRect(x, top, 1, Math.max(1, bottom - top));
  }
}

// A time step whose labels are at least 44 px apart.
export function niceStep(duration, width) {
  for (const step of [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2]) if ((width * step) / duration >= 44) return step;
  return 5;
}

// --- a plot's frame, ticks and labels ------------------------------------------------

// A frequency as a tick label: 500, 2k.
export const frequencyLabel = (f) => (f >= 1000 ? `${f / 1000}k` : `${f}`);

// The plot's border in the page's line color; labels drawn after it take
// the muted color and the page's small font.
export function drawFrame(context, canvas, plot) {
  const style = getComputedStyle(canvas);
  context.lineWidth = 1;
  context.font = "11px system-ui, sans-serif";
  context.fillStyle = style.getPropertyValue("--muted").trim() || "#6b7280";
  context.strokeStyle = style.getPropertyValue("--line").trim() || "#d5d9e0";
  context.strokeRect(plot.x0 + 0.5, plot.y0 + 0.5, plot.x1 - plot.x0 - 1, plot.y1 - plot.y0 - 1);
}

// Gridlines across the plot at `values`, placed by `y(value)` and labeled
// on the left with `label(value)`. A label is kept inside the plot's height
// unless `clamp` is false.
export function drawValueTicks(context, plot, values, y, label, { gridColor = GRID_COLOR, clamp = true } = {}) {
  context.textAlign = "right";
  context.textBaseline = "middle";
  for (const value of values) {
    const lineY = Math.round(y(value)) + 0.5;
    context.strokeStyle = gridColor;
    context.beginPath();
    context.moveTo(plot.x0, lineY);
    context.lineTo(plot.x1, lineY);
    context.stroke();
    context.fillText(label(value), plot.x0 - 6, clamp ? Math.min(Math.max(lineY, plot.y0 + 5), plot.y1 - 5) : lineY);
  }
}

// The name of the vertical axis, written upward at the canvas's left edge.
export function drawAxisName(context, plot, name) {
  context.save();
  context.translate(12, (plot.y0 + plot.y1) / 2);
  context.rotate(-Math.PI / 2);
  context.textAlign = "center";
  context.fillText(name, 0, 0);
  context.restore();
}

// Time labels `gap` px under the plot, from 0 s at x0 to `duration` s at
// x1, at least 44 px apart, and the unit at the right.
export function drawTimeTicks(context, plot, duration, gap) {
  context.textAlign = "center";
  context.textBaseline = "top";
  const step = niceStep(duration, plot.x1 - plot.x0);
  for (let k = 0; k * step <= duration + 1e-9; k++) {
    const tickX = plot.x0 + ((k * step) / duration) * (plot.x1 - plot.x0);
    if (tickX < plot.x1 - 24) context.fillText(`${+(k * step).toFixed(2)}`, tickX, plot.y1 + gap); // room for "s"
  }
  context.textAlign = "right";
  context.fillText("s", plot.x1, plot.y1 + gap);
}

// Gridlines up the plot at ±1 to ±64 Hz, placed by `x(rate)`, labeled under
// it from `labelFrom` Hz up, with a minus sign on the negative side.
export function drawRateTicks(context, plot, x, labelFrom = 1) {
  context.textAlign = "center";
  context.textBaseline = "top";
  for (const sign of [-1, 1]) {
    for (const rate of RATE_TICKS) {
      const lineX = Math.round(x(sign * rate)) + 0.5;
      context.strokeStyle = GRID_COLOR;
      context.beginPath();
      context.moveTo(lineX, plot.y0);
      context.lineTo(lineX, plot.y1);
      context.stroke();
      if (rate >= labelFrom) context.fillText(`${sign * rate}`.replace("-", "−"), lineX, plot.y1 + 4);
    }
  }
}

// What the signed rate axis means, under its labels; `centerX` is rate 0.
export function drawRateAxisWords(context, plot, centerX) {
  context.textAlign = "left";
  context.fillText("← sweeps up", plot.x0, plot.y1 + 19);
  context.textAlign = "center";
  context.fillText("rate, Hz", centerX, plot.y1 + 19);
  context.textAlign = "right";
  context.fillText("sweeps down →", plot.x1, plot.y1 + 19);
}

// A title over the picture, at its top left.
export function drawTitle(context, plot, text) {
  context.textAlign = "left";
  context.textBaseline = "top";
  context.fillStyle = "rgba(255, 255, 255, 0.85)";
  context.fillText(text, plot.x0 + 6, plot.y0 + 4);
}

// The playhead, at `x` px, the plot's height.
export function drawPlayhead(context, plot, x, color) {
  const lineX = Math.round(x) + 0.5;
  context.strokeStyle = color;
  context.beginPath();
  context.moveTo(lineX, plot.y0);
  context.lineTo(lineX, plot.y1);
  context.stroke();
}

// The brush's outline at the pointer, `diameter` px across.
export function drawBrush(context, [x, y], diameter) {
  context.strokeStyle = "rgba(255, 255, 255, 0.8)";
  context.setLineDash([3, 3]);
  context.beginPath();
  context.arc(x, y, diameter / 2, 0, 2 * Math.PI);
  context.stroke();
  context.setLineDash([]);
}

// A mask's outline, in the current stroke style: the edges between cells
// whose cut reaches `threshold` and cells whose cut does not. The mask has
// `rows` x `columns` cells, rows from the bottom; `columnX(column)` and
// `rowY(row)` are a column's left edge and a row's bottom edge, px.
export function drawMaskOutline(context, mask, rows, columns, threshold, columnX, rowY) {
  const deep = (row, column) => mask[row * columns + column] >= threshold;
  context.beginPath();
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const here = deep(row, column);
      if (column + 1 < columns && here !== deep(row, column + 1)) {
        const edgeX = Math.round(columnX(column + 1)) + 0.5;
        context.moveTo(edgeX, rowY(row));
        context.lineTo(edgeX, rowY(row + 1));
      }
      if (row + 1 < rows && here !== deep(row + 1, column)) {
        const edgeY = Math.round(rowY(row + 1)) + 0.5;
        context.moveTo(columnX(column), edgeY);
        context.lineTo(columnX(column + 1), edgeY);
      }
    }
  }
  context.stroke();
}

// --- a spectrogram on a log-frequency axis -------------------------------------------

// The result's spectrogram on a log-frequency axis, with its axes, on
// `canvas` inside `margin`: the Erase modulation tab's Result box and the
// Draw modulation tab's bands panel. The picture is kept as an image, one
// pixel per CSS pixel, until the sound or the size changes, so the playhead
// moves over it cheaply.
export function logSpectrogramPlot(canvas, margin) {
  const image = document.createElement("canvas");
  let drawn = { picture: null, key: "" };

  // The plot from fLo to fHi over `duration` s: pixels to and from time and frequency.
  function geometry(fLo, fHi, duration) {
    const width = canvas.clientWidth || 600;
    const height = canvas.clientHeight || 200;
    const x0 = margin.left;
    const x1 = width - margin.right;
    const y0 = margin.top;
    const y1 = height - margin.bottom;
    const span = Math.log2(fHi / fLo);
    return {
      width, height, x0, x1, y0, y1, fLo, fHi, duration, span,
      x: (t) => x0 + (t / duration) * (x1 - x0),
      y: (f) => y1 - (Math.log2(f / fLo) / span) * (y1 - y0),
      t: (pointerX) => Math.min(duration, Math.max(0, ((pointerX - x0) / (x1 - x0)) * duration)),
      f: (pointerY) => Math.min(fHi, Math.max(fLo, fLo * 2 ** (((y1 - pointerY) / (y1 - y0)) * span))),
    };
  }

  // The canvas, cleared; returns its context.
  function clear() {
    const context = fitCanvasInCssPixels(canvas);
    context.clearRect(0, 0, canvas.clientWidth || 600, canvas.clientHeight || 200);
    return context;
  }

  // `picture` (the shell's spectrogram, or none) on `plot`, with its frame,
  // frequency ticks ("Hz" beside them if `named`) and time ticks.
  function draw(context, plot, picture, { named }) {
    const { x0, x1, y0, y1, fLo, fHi, duration, span } = plot;
    const imageWidth = Math.max(1, Math.round(x1 - x0));
    const imageHeight = Math.max(1, Math.round(y1 - y0));
    const key = [imageWidth, imageHeight, fLo, fHi, duration].join(" ");
    if (drawn.picture !== picture || drawn.key !== key) {
      paintLogSpectrogram(image, picture, imageWidth, imageHeight, fLo, span, duration);
      drawn = { picture, key };
    }
    context.imageSmoothingEnabled = true;
    context.drawImage(image, x0, y0, x1 - x0, y1 - y0);
    drawFrame(context, canvas, plot);
    drawValueTicks(context, plot, LOG_FREQUENCY_TICKS.filter((f) => f >= fLo && f <= fHi), plot.y, frequencyLabel);
    if (named) drawAxisName(context, plot, "Hz");
    drawTimeTicks(context, plot, duration, 4);
  }

  return { geometry, clear, draw };
}
