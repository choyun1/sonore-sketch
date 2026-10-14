// Pictures of a result: a spectrogram image and a waveform, on canvases.

import { magma } from "./colormap.js";

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

// Draw `picture` (8-bit levels, rows from 0 Hz up) over time [0, duration]
// and frequency [0, fTop], in magma, as sonore plots it.
export function drawSpectrogram(canvas, picture, duration, fTop) {
  const context = fitCanvas(canvas);
  const { width, height } = canvas;
  context.clearRect(0, 0, width, height);
  if (!picture) return;
  const { data, nFreqs, nWindows, fMax, tStart, tStep } = picture;
  const image = context.createImageData(width, height);
  const [r0, g0, b0] = magma(0);
  for (let i = 0; i < image.data.length; i += 4) image.data.set([r0, g0, b0, 255], i);
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

// The waveform as a min-max envelope per pixel column.
export function drawWaveform(canvas, samples, fs, duration) {
  const context = fitCanvas(canvas);
  const { width, height } = canvas;
  context.clearRect(0, 0, width, height);
  if (!samples) return;
  let peak = 0;
  for (const x of samples) peak = Math.max(peak, Math.abs(x));
  if (!peak) return;
  context.fillStyle = getComputedStyle(canvas).getPropertyValue("--wave").trim() || "#2e86ab";
  const middle = height / 2;
  for (let x = 0; x < width; x++) {
    const a = Math.floor(((x / width) * duration) * fs);
    const b = Math.min(samples.length, Math.floor((((x + 1) / width) * duration) * fs));
    let lo = 0;
    let hi = 0;
    for (let i = a; i < b; i++) {
      lo = Math.min(lo, samples[i]);
      hi = Math.max(hi, samples[i]);
    }
    const top = middle - (hi / peak) * middle * 0.95;
    const bottom = middle - (lo / peak) * middle * 0.95;
    context.fillRect(x, top, 1, Math.max(1, bottom - top));
  }
}

// A time step whose labels are at least 44 px apart.
export function niceStep(duration, width) {
  for (const step of [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2]) if ((width * step) / duration >= 44) return step;
  return 5;
}
