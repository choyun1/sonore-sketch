// The Draw modulation tab: place Gaussian blobs on rate x density and hear a sound
// whose envelopes have that modulation spectrum (docs/design/tabs/blobs.md).
//
// The plane shows the drawn spectrum itself, on the grid sonore puts it on
// (rate steps of 1/duration), computed here with sonore's formula so it
// follows a drag at once; each blob's outline (one standard deviation), its
// center and, for the selected blob, its two width handles go on top. An
// edit is one gesture: adding, moving or resizing a blob is committed when
// the pointer comes up.
//
// The design panels come first: the plane, then the result's spectrogram
// (the shell's 5 ms STFT) on a log-frequency axis over the carrier's bands,
// so a blob's density shows as the slope of its stripes in octaves. The bands that confine the sound
// (docs/design/tabs/bands.md) are drawn on it: each a center track with
// breakpoints and a strip its width wide. Drag a breakpoint to move it, click
// a band's line to add one, drag inside a strip to move the whole band.
// Then the result: its own modulation spectrum, measured from the sound
// (blobs.md, B7) on the plane's axes, so drawn and heard compare by eye
// (with bands, measured within them: bands.md, K7), above the page's waveform.

import { extendStroke } from "../tracks/model.js";
import { magma } from "../colormap.js";
import {
  drawAxisName,
  drawBorder,
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
import {
  BAND_WIDTH_MAX,
  BAND_WIDTH_MIN,
  CARRIERS,
  MAX_BANDS,
  bandCenter,
  clampBandLevel,
  clampBandWidth,
  newBand,
  strokeOnto,
  tidyHz,
  tidyTime,
  COARSE_BELOW_S,
  DENSITY_MAX,
  MAX_BLOBS,
  NEW_BLOB,
  clampDensity,
  clampRate,
  clampWidth,
  depthThatFits,
  grid,
  power,
  rateToUnit,
  tidy,
  unitToRate,
} from "./model.js";

const MARGIN = { left: 52, right: 10, top: 8, bottom: 36 };
const SEAM = 7; // half the gap between the two sides of the rate axis, px
const FLOOR_DB = -40; // the picture's range below the drawing's peak
const PICK_PX = 8;
const BAND_TOOLS = [
  { id: "point", label: "Point", key: "p", title: "Drag a breakpoint; click a band's line to add one; drag inside a band to move it (P)" },
  { id: "line", label: "Line", key: "l", title: "Press at one end and release at the other: a straight stretch of the band (L)" },
  { id: "freehand", label: "Freehand", key: "f", title: "Draw the band's center; outside every band, a new band (F)" },
];

export function createBlobsTab(root, { commit: commitDocument }) {
  // The harmonic carrier takes iterations only with bands (bands.md, K-M5b).
  function commit(next) {
    commitDocument(next.carrier === "harmonic" && !next.bands?.length ? { ...next, iterations: 0 } : next);
  }

  let state = null;
  let selected = null; // index of the selected blob
  let drag = null; // {kind, index, items, changed, added} while a gesture lasts
  let fittingDepth = null; // the depth sonore said fits, after it refused this one
  let selectedBand = null; // {index, point} of the selected band (point: index or null)
  let bandDrag = null; // {kind, index, point, bands, changed, ...} while a gesture on the spectrogram lasts
  let deleteTarget = "blob"; // what Delete removes: the selected "blob" or "band"

  root.innerHTML = `
    <div class="blobs-body">
      <div class="paint-area">
        <section class="panel-box design-box">
          <h3 class="panel-group" title="What you draw: blobs on the modulation plane, and bands over the result's spectrogram">Design</h3>
          <div class="panel-stack">
            <canvas class="plane"></canvas>
            <canvas class="stft" title="The bands, drawn over the result's spectrogram (5 ms window) on a log-frequency axis"></canvas>
          </div>
        </section>
        <section class="panel-box result-box">
          <h3 class="panel-group" title="What came out: measured from the sound after Play">Result</h3>
          <div class="panel-stack">
            <canvas class="measured" title="The result's own modulation spectrum, measured from the sound after Play, on the plane's axes"></canvas>
            <canvas class="wave" title="The result's waveform"></canvas>
          </div>
        </section>
      </div>
      <aside class="side">
        <fieldset class="blob-fields"><legend>Blob</legend>
          <p class="hint blob-count"></p>
          <div class="blob-edit">
            <label class="field" title="Temporal modulation rate; negative sweeps up, positive sweeps down">Rate <input type="number" class="rate" step="0.1"> Hz</label>
            <label class="field" title="Spectral modulation density">Density <input type="number" class="density" min="0" max="${DENSITY_MAX}" step="0.05"> cyc/oct</label>
            <label class="field" title="Standard deviation along rate, in octaves of rate">Width <input type="number" class="rate-width" min="0.05" max="3" step="0.05"> oct</label>
            <label class="field" title="Standard deviation along density">Height <input type="number" class="density-width" min="0.05" max="3" step="0.05"> cyc/oct</label>
            <label class="field" title="Peak power relative to the other blobs">Level <input type="number" class="level" min="-40" max="0" step="1"> dB</label>
            <button type="button" class="delete" title="Remove this blob (Delete)">Delete</button>
          </div>
        </fieldset>
        <fieldset class="band-fields"><legend>Bands</legend>
          <p class="hint band-count"></p>
          <div class="band-tools"></div>
          <div class="band-edit">
            <label class="field" title="How wide the band is, in octaves">Width <input type="number" class="band-width" min="${+BAND_WIDTH_MIN.toFixed(2)}" max="${BAND_WIDTH_MAX}" step="0.25"> oct</label>
            <label class="field" title="The band's level relative to the others">Level <input type="number" class="band-level" min="-40" max="0" step="1"> dB</label>
            <button type="button" class="delete-band" title="Remove this band (Delete, with no breakpoint selected)">Delete band</button>
          </div>
          <button type="button" class="add-band" title="Confine the sound to a band, one octave wide, that you can then reshape on the spectrogram">Add band</button>
          <p class="hint band-motion" hidden>A band that moves is a sweep of its own, so it adds modulation to what the blobs draw. Iterations go back and forth between the blobs and the bands, pulling the sound toward the blobs inside them.</p>
        </fieldset>
        <fieldset><legend>Sound</legend>
          <label class="field" title="What carries the modulation: log-spaced tones (clearest), a harmonic complex on F0 (pitched), or noise (adds modulation of its own)">Carrier
            <select class="carrier">${CARRIERS.map((carrier) => `<option value="${carrier}">${carrier}</option>`).join("")}</select></label>
          <label class="field f0-field" title="The harmonic complex's fundamental">F0 <input type="number" class="f0" min="20" max="1000" step="1"> Hz</label>
          <label class="field" title="How deep the modulation is: the envelopes' rms about their mean, relative to it">Depth <input type="number" class="depth" min="0.01" max="1" step="0.01"></label>
          <button type="button" class="use-depth" hidden></button>
          <label class="field" title="Which random draw of the modulation's timing to hear">Seed <input type="number" class="seed" step="1"></label>
          <label class="field iterations-field" title="How many times to search for a sound whose own modulation comes closer to the blobs (slower). With bands, each time goes back and forth between the blobs and the bands. On the harmonic carrier, only with bands">Iterations <input type="number" class="iterations" min="0" max="10" step="1"></label>
          <button type="button" class="new-draw" title="Hear another draw with the same spectrum">New draw</button>
        </fieldset>
        <p class="hint coarse" hidden></p>
        <p class="hint">Click to add a blob, drag to move it, drag its squares to change its width and height. Space plays.</p>
      </aside>
    </div>`;
  const query = (selector) => root.querySelector(selector);
  const canvas = query("canvas.plane");
  const ui = {
    count: query(".blob-count"), edit: query(".blob-edit"), rate: query(".rate"), density: query(".density"),
    rateWidth: query(".rate-width"), densityWidth: query(".density-width"), level: query(".level"), remove: query(".delete"),
    carrier: query(".carrier"), f0: query(".f0"), f0Field: query(".f0-field"), stft: query("canvas.stft"), depth: query(".depth"), useDepth: query(".use-depth"), seed: query(".seed"), iterations: query(".iterations"), iterationsField: query(".iterations-field"),
    newDraw: query(".new-draw"), coarse: query(".coarse"),
    bandCount: query(".band-count"), bandEdit: query(".band-edit"), bandWidth: query(".band-width"), bandLevel: query(".band-level"),
    removeBand: query(".delete-band"), addBand: query(".add-band"), bandMotion: query(".band-motion"), wave: query("canvas.wave"),
  };

  // The bands' drawing tools, as on the Draw speech tab: Point moves breakpoints
  // (and a click on a band's line adds one, a drag inside it moves it all);
  // Line and Freehand draw a stroke that replaces the band's track over its
  // span, on the band pressed in, or make a new band when pressed outside.
  let bandTool = "point";
  const toolBox = query(".band-tools");
  for (const { id, label, key, title } of BAND_TOOLS) {
    const node = document.createElement("label");
    node.className = "band-tool";
    node.title = title;
    node.innerHTML = `<input type="radio" name="band-tool" value="${id}"> ${label} <kbd>${key.toUpperCase()}</kbd>`;
    node.querySelector("input").checked = id === bandTool;
    node.querySelector("input").addEventListener("change", () => (bandTool = id));
    toolBox.appendChild(node);
  }

  const items = () => drag?.items ?? state.items;
  const bands = () => bandDrag?.bands ?? state.bands ?? [];

  function commitBands(next) {
    commit({ ...state, bands: next });
  }

  function commitItems(next, changes = {}) {
    commit({ ...state, ...changes, items: next });
  }

  // --- the side panel ------------------------------------------------------------

  function showSettings() {
    const blobList = items();
    if (selected !== null && selected >= blobList.length) selected = blobList.length ? blobList.length - 1 : null;
    const blob = selected === null ? null : blobList[selected];
    ui.edit.hidden = !blob;
    ui.count.textContent =
      blobList.length >= MAX_BLOBS
        ? `${blobList.length} of ${MAX_BLOBS} blobs: delete one to add another.`
        : `${blobList.length} of ${MAX_BLOBS} blobs.${blob ? "" : " Click a blob to edit it, or empty space to add one."}`;
    if (blob) {
      ui.rate.value = blob.rate;
      ui.density.value = blob.density;
      ui.rateWidth.value = blob.rate_width;
      ui.densityWidth.value = blob.density_width;
      ui.level.value = blob.level;
    }
    ui.carrier.value = state.carrier;
    ui.f0.value = state.f0 ?? 100;
    ui.f0Field.hidden = state.carrier !== "harmonic";
    ui.depth.value = state.rms_depth;
    ui.seed.value = state.seed;
    ui.iterations.value = state.iterations ?? 0;
    ui.iterationsField.hidden = state.carrier === "harmonic" && !state.bands?.length;
    ui.useDepth.hidden = fittingDepth === null;
    if (fittingDepth !== null) ui.useDepth.textContent = `Use depth ${fittingDepth}`;
    const bandList = bands();
    if (selectedBand !== null && !bandList[selectedBand.index]) selectedBand = null;
    const chosen = selectedBand === null ? null : bandList[selectedBand.index];
    ui.bandEdit.hidden = !chosen;
    ui.addBand.disabled = bandList.length >= MAX_BANDS;
    ui.bandCount.textContent = !bandList.length
      ? `No bands: the sound fills ${state.f_lo}–${state.f_hi} Hz. Add one to confine it.`
      : `${bandList.length} of ${MAX_BANDS} bands.${chosen ? "" : " Click a band on the spectrogram to edit it."}`;
    if (chosen) {
      ui.bandWidth.value = +chosen.width.toFixed(2);
      ui.bandLevel.value = chosen.level ?? 0;
    }
    ui.bandMotion.hidden = !bandList.some((band) => band.points.some(([, f]) => f !== band.points[0][1]));
    const { rateStep } = grid(state);
    ui.coarse.hidden = state.duration >= COARSE_BELOW_S;
    ui.coarse.textContent = `At ${state.duration} s, rates come in steps of ${+rateStep.toFixed(2)} Hz, coarse below about 8 Hz; ${COARSE_BELOW_S} s or more shows low rates finer.`;
  }

  function editSelected(key, clamp) {
    return () => {
      const blob = state.items[selected];
      const value = Number(ui[fieldOf[key]].value);
      if (!blob || !Number.isFinite(value) || (key === "rate" && value === 0)) return showSettings();
      const next = tidy(clamp(value));
      if (next === blob[key]) return showSettings();
      commitItems(state.items.map((item, i) => (i === selected ? { ...item, [key]: next } : item)));
    };
  }
  const fieldOf = { rate: "rate", density: "density", rate_width: "rateWidth", density_width: "densityWidth", level: "level" };
  ui.rate.addEventListener("change", editSelected("rate", clampRate));
  ui.density.addEventListener("change", editSelected("density", clampDensity));
  ui.rateWidth.addEventListener("change", editSelected("rate_width", clampWidth));
  ui.densityWidth.addEventListener("change", editSelected("density_width", clampWidth));
  ui.level.addEventListener("change", editSelected("level", (level) => Math.min(0, Math.max(-40, level))));
  ui.remove.addEventListener("click", removeSelected);

  function editBand(key, clamp) {
    return () => {
      const chosen = selectedBand && state.bands?.[selectedBand.index];
      const value = Number(ui[key === "width" ? "bandWidth" : "bandLevel"].value);
      if (!chosen || !Number.isFinite(value)) return showSettings();
      const next = Math.round(clamp(value) * 100) / 100;
      if (next === (chosen[key] ?? 0)) return showSettings();
      commitBands(state.bands.map((band, i) => (i === selectedBand.index ? { ...band, [key]: next } : band)));
    };
  }
  ui.bandWidth.addEventListener("change", editBand("width", clampBandWidth));
  ui.bandLevel.addEventListener("change", editBand("level", clampBandLevel));
  ui.removeBand.addEventListener("click", () => {
    deleteTarget = "band";
    if (selectedBand) selectedBand.point = null;
    removeBandOrPoint();
  });
  ui.addBand.addEventListener("click", () => {
    const bandList = state.bands ?? [];
    if (bandList.length >= MAX_BANDS) return;
    selectedBand = { index: bandList.length, point: null };
    deleteTarget = "band";
    commitBands([...bandList, newBand(bandList, state.duration)]);
  });

  // Delete removes the selected breakpoint (a band keeps at least one), or,
  // with none selected, the band.
  function removeBandOrPoint() {
    const bandList = state.bands ?? [];
    const chosen = selectedBand && bandList[selectedBand.index];
    if (!chosen) return false;
    if (selectedBand.point !== null && chosen.points.length > 1) {
      const points = chosen.points.filter((_, pointIndex) => pointIndex !== selectedBand.point);
      selectedBand = { index: selectedBand.index, point: null };
      commitBands(bandList.map((band, i) => (i === selectedBand.index ? { ...band, points } : band)));
      return true;
    }
    const next = bandList.filter((_, i) => i !== selectedBand.index);
    selectedBand = null;
    commitBands(next);
    return true;
  }

  ui.carrier.addEventListener("change", () => {
    commit({ ...state, carrier: ui.carrier.value });
  });
  ui.f0.addEventListener("change", () => {
    const f0 = Math.round(Number(ui.f0.value));
    if (f0 >= 20 && f0 <= Math.min(1000, state.f_hi) && f0 !== state.f0) commit({ ...state, f0 });
    else showSettings();
  });
  ui.depth.addEventListener("change", () => {
    const depth = tidy(Number(ui.depth.value));
    if (depth > 0 && depth <= 1 && depth !== state.rms_depth) commit({ ...state, rms_depth: depth });
    else showSettings();
  });
  ui.useDepth.addEventListener("click", () => fittingDepth !== null && commit({ ...state, rms_depth: fittingDepth }));
  ui.seed.addEventListener("change", () => {
    const seed = Math.round(Number(ui.seed.value));
    if (Number.isFinite(seed) && seed !== state.seed) commit({ ...state, seed });
    else showSettings();
  });
  ui.iterations.addEventListener("change", () => {
    const iterations = Math.round(String(ui.iterations.value).trim() === "" ? NaN : Number(ui.iterations.value));
    if (iterations >= 0 && iterations <= 10 && iterations !== state.iterations) commit({ ...state, iterations });
    else showSettings();
  });
  ui.newDraw.addEventListener("click", () => commit({ ...state, seed: state.seed + 1 }, { play: true }));

  function removeSelected() {
    if (selected === null || !state.items[selected]) return false;
    const next = state.items.filter((_, i) => i !== selected);
    selected = next.length ? Math.min(selected, next.length - 1) : null;
    commitItems(next);
    return true;
  }

  // --- the plane -------------------------------------------------------------------

  // The plane's plot (x0 to x1, y0 to y1, xc the seam's middle): pixels to
  // and from rate and density.
  function geometry() {
    const width = canvas.clientWidth || 600;
    const height = canvas.clientHeight || 300;
    const x0 = MARGIN.left;
    const x1 = width - MARGIN.right;
    const y0 = MARGIN.top;
    const y1 = height - MARGIN.bottom;
    const xc = (x0 + x1) / 2;
    const half = xc - SEAM - x0;
    return {
      width, height, x0, x1, y0, y1, xc,
      x: (rate) => (rate > 0 ? xc + SEAM + rateToUnit(rate) * half : xc - SEAM + rateToUnit(rate) * half),
      y: (density) => y1 - (density / DENSITY_MAX) * (y1 - y0),
      // the rate at a pixel; the seam's pixels go to the nearer side's 1 Hz
      rate: (x) => (x >= xc ? unitToRate(Math.max(0, (x - xc - SEAM) / half)) : -unitToRate(Math.max(0, (xc - SEAM - x) / half))),
      density: (y) => ((y1 - y) / (y1 - y0)) * DENSITY_MAX,
    };
  }

  // A blob's outline in pixels: center, the ellipse's extent, and its two handles.
  function shape(plot, blob) {
    const leftX = plot.x(blob.rate * 2 ** -blob.rate_width);
    const rightX = plot.x(blob.rate * 2 ** blob.rate_width);
    return {
      centerX: plot.x(blob.rate),
      centerY: plot.y(blob.density),
      ellipseX: (leftX + rightX) / 2,
      radiusX: Math.max(2, Math.abs(rightX - leftX) / 2),
      radiusY: Math.max(2, (blob.density_width / DENSITY_MAX) * (plot.y1 - plot.y0)),
      widthHandle: [rightX, plot.y(blob.density)],
      heightHandle: [plot.x(blob.rate), plot.y(blob.density + blob.density_width)],
    };
  }

  const image = document.createElement("canvas");

  // The drawn spectrum, one pixel per CSS pixel of the plot, each pixel
  // showing the grid cell (rate, density) it falls in.
  function picture(plot) {
    const width = Math.max(1, Math.round(plot.x1 - plot.x0));
    const height = Math.max(1, Math.round(plot.y1 - plot.y0));
    image.width = width;
    image.height = height;
    const context = image.getContext("2d");
    const pixels = context.createImageData(width, height);
    const { rateStep, densityStep, densities } = grid(state);
    const blobList = items();
    // each pixel row's density cell, or -1 above the grid's last
    const densityCellOfRow = Int32Array.from({ length: height }, (_, pixelY) => {
      const densityIndex = Math.round(plot.density(plot.y0 + pixelY + 0.5) / densityStep);
      return densityIndex < densities.length ? densityIndex : -1;
    });
    const columnPowers = [];
    let peak = 0;
    for (let pixelX = 0; pixelX < width; pixelX++) {
      const x = plot.x0 + pixelX + 0.5;
      const rateIndex = Math.abs(x - plot.xc) < SEAM ? 0 : Math.round(plot.rate(x) / rateStep);
      if (rateIndex === 0) {
        columnPowers.push(null);
        continue;
      }
      const powers = densities.map((density) => power(blobList, rateIndex * rateStep, density));
      for (const cellPower of powers) peak = Math.max(peak, cellPower);
      columnPowers.push(powers);
    }
    const floor = magma(0);
    for (let pixelX = 0; pixelX < width; pixelX++) {
      const powers = columnPowers[pixelX];
      for (let pixelY = 0; pixelY < height; pixelY++) {
        const i = 4 * (pixelY * width + pixelX);
        const densityIndex = densityCellOfRow[pixelY];
        let color = floor;
        if (powers && densityIndex >= 0 && peak > 0) {
          const level = 10 * Math.log10(powers[densityIndex] / peak);
          color = magma(Math.max(0, 1 - level / FLOOR_DB));
        }
        pixels.data.set(color, i);
        pixels.data[i + 3] = powers || Math.abs(plot.x0 + pixelX + 0.5 - plot.xc) >= SEAM ? 255 : 0;
      }
    }
    context.putImageData(pixels, 0, 0);
    return image;
  }

  function render() {
    if (!state) return;
    const context = fitCanvasInCssPixels(canvas);
    const plot = geometry();
    context.clearRect(0, 0, plot.width, plot.height);
    context.imageSmoothingEnabled = false;
    context.drawImage(picture(plot), plot.x0, plot.y0, plot.x1 - plot.x0, plot.y1 - plot.y0);

    // axes and gridlines
    drawBorder(context, canvas, plot);
    drawValueTicks(context, plot, Array.from({ length: DENSITY_MAX + 1 }, (_, density) => density), plot.y, (density) => `${density}`);
    drawAxisName(context, plot, "cyc/oct");
    drawRateTicks(context, plot, plot.x);
    drawRateAxisWords(context, plot, plot.xc);

    // the blobs
    items().forEach((blob, i) => {
      const blobShape = shape(plot, blob);
      const chosen = i === selected;
      context.strokeStyle = chosen ? "rgba(255, 255, 255, 0.95)" : "rgba(255, 255, 255, 0.6)";
      context.lineWidth = chosen ? 2 : 1.25;
      context.setLineDash(chosen ? [] : [4, 3]);
      context.beginPath();
      context.ellipse(blobShape.ellipseX, blobShape.centerY, blobShape.radiusX, blobShape.radiusY, 0, 0, 2 * Math.PI);
      context.stroke();
      context.setLineDash([]);
      context.fillStyle = chosen ? "#ffffff" : "rgba(255, 255, 255, 0.8)";
      context.beginPath();
      context.arc(blobShape.centerX, blobShape.centerY, chosen ? 4.5 : 3.5, 0, 2 * Math.PI);
      context.fill();
      if (chosen) {
        context.fillStyle = "#ffffff";
        context.strokeStyle = "#000000";
        context.lineWidth = 1;
        for (const [handleX, handleY] of [blobShape.widthHandle, blobShape.heightHandle]) {
          context.fillRect(handleX - 4, handleY - 4, 8, 8);
          context.strokeRect(handleX - 4 + 0.5, handleY - 4 + 0.5, 7, 7);
        }
      }
    });
  }

  // --- gestures --------------------------------------------------------------------

  const local = (event) => pointerPosition(canvas, event);

  // What is under the pointer: the selected blob's handles first, then the
  // nearest center, then the inside of the smallest outline.
  function pick(plot, [pointerX, pointerY]) {
    const blobList = items();
    const near = (x, y) => Math.hypot(pointerX - x, pointerY - y) <= PICK_PX;
    if (selected !== null && blobList[selected]) {
      const blobShape = shape(plot, blobList[selected]);
      // a handle held on the center by the plane's edge leaves the center to Move
      const onCenter = (handle) => Math.hypot(handle[0] - blobShape.centerX, handle[1] - blobShape.centerY) <= PICK_PX;
      if (near(...blobShape.widthHandle) && !onCenter(blobShape.widthHandle)) return { kind: "rate_width", index: selected };
      if (near(...blobShape.heightHandle) && !onCenter(blobShape.heightHandle)) return { kind: "density_width", index: selected };
    }
    let best = null;
    blobList.forEach((blob, index) => {
      const blobShape = shape(plot, blob);
      const distance = Math.hypot(pointerX - blobShape.centerX, pointerY - blobShape.centerY);
      if (distance <= PICK_PX && (!best || distance < best.distance)) best = { kind: "move", index, distance };
    });
    if (best) return best;
    let inside = null;
    blobList.forEach((blob, index) => {
      const blobShape = shape(plot, blob);
      const area = blobShape.radiusX * blobShape.radiusY;
      if (((pointerX - blobShape.ellipseX) / blobShape.radiusX) ** 2 + ((pointerY - blobShape.centerY) / blobShape.radiusY) ** 2 <= 1 && (!inside || area < inside.area)) {
        inside = { kind: "move", index, area };
      }
    });
    return inside;
  }

  const inPlot = (plot, [x, y]) => x >= plot.x0 && x <= plot.x1 && y >= plot.y0 && y <= plot.y1;

  canvas.addEventListener("pointerdown", (event) => {
    if (!state || event.button !== 0) return;
    const plot = geometry();
    const at = local(event);
    if (!inPlot(plot, at)) return;
    event.preventDefault();
    let hit = pick(plot, at);
    let blobList = state.items.map((blob) => ({ ...blob }));
    let added = false;
    if (!hit) {
      if (blobList.length >= MAX_BLOBS) {
        selected = null;
        showSettings();
        return render();
      }
      blobList = [...blobList, { rate: tidy(clampRate(plot.rate(at[0]))), density: tidy(clampDensity(plot.density(at[1]))), ...NEW_BLOB }];
      hit = { kind: "move", index: blobList.length - 1 };
      added = true;
    }
    canvas.setPointerCapture(event.pointerId);
    selected = hit.index;
    deleteTarget = "blob";
    const blob = blobList[hit.index];
    // a move keeps the blob's center where it was relative to the pointer
    drag = { ...hit, items: blobList, added, changed: false, offset: [at[0] - plot.x(blob.rate), at[1] - plot.y(blob.density)] };
    showSettings();
    render();
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!state) return;
    const plot = geometry();
    const at = local(event);
    if (!drag) {
      const hit = inPlot(plot, at) ? pick(plot, at) : null;
      canvas.style.cursor = !hit ? "crosshair" : hit.kind === "move" ? "grab" : hit.kind === "rate_width" ? "ew-resize" : "ns-resize";
      return;
    }
    const blob = drag.items[drag.index];
    let next = blob;
    if (drag.kind === "move") {
      const x = at[0] - drag.offset[0];
      const y = at[1] - drag.offset[1];
      next = { ...blob, rate: tidy(clampRate(plot.rate(x))), density: tidy(clampDensity(plot.density(y))) };
    } else if (drag.kind === "rate_width") {
      const octaves = Math.abs(Math.log2(Math.abs(plot.rate(at[0])) / Math.abs(blob.rate)));
      next = { ...blob, rate_width: tidy(clampWidth(octaves)) };
    } else {
      next = { ...blob, density_width: tidy(clampWidth(Math.abs(plot.density(at[1]) - blob.density))) };
    }
    if (next.rate !== blob.rate || next.density !== blob.density || next.rate_width !== blob.rate_width || next.density_width !== blob.density_width) {
      drag.items = drag.items.map((item, i) => (i === drag.index ? next : item));
      drag.changed = true;
      showSettings();
      render();
    }
  });

  function finish(event) {
    if (!drag) return;
    const { items: next, added, changed } = drag;
    drag = null;
    if (event.type === "pointercancel" || !(added || changed)) {
      showSettings();
      return render();
    }
    commitItems(next);
  }
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", finish);

  // --- the result's measured modulation spectrum ---------------------------------------

  const measuredCanvas = query("canvas.measured");
  const MEASURED_MARGIN = { left: MARGIN.left, right: MARGIN.right, top: 6, bottom: 22 };
  const measuredImage = document.createElement("canvas");
  let measuredDrawn = { picture: null, key: "" };

  function renderMeasured() {
    const context = fitCanvasInCssPixels(measuredCanvas);
    const width = measuredCanvas.clientWidth || 600;
    const height = measuredCanvas.clientHeight || 160;
    context.clearRect(0, 0, width, height);
    if (!state) return;
    // the plane's rate axis, at this canvas's height
    const plane = { ...geometry() };
    const y0 = MEASURED_MARGIN.top;
    const y1 = height - MEASURED_MARGIN.bottom;
    const densityY = (density) => y1 - (density / DENSITY_MAX) * (y1 - y0);
    const measured = sound?.modulation ?? null;
    const imageWidth = Math.max(1, Math.round(plane.x1 - plane.x0));
    const imageHeight = Math.max(1, Math.round(y1 - y0));
    const key = [imageWidth, imageHeight].join(" ");
    if (measuredDrawn.picture !== measured || measuredDrawn.key !== key) {
      measuredImage.width = imageWidth;
      measuredImage.height = imageHeight;
      const pixels = measuredImage.getContext("2d").createImageData(imageWidth, imageHeight);
      const floor = magma(0);
      for (let pixelX = 0; pixelX < imageWidth; pixelX++) {
        const x = plane.x0 + pixelX + 0.5;
        const seam = Math.abs(x - plane.xc) < SEAM;
        const rateIndex = measured && !seam ? Math.round((plane.rate(x) - measured.rateFirst) / measured.rateStep) : -1;
        for (let pixelY = 0; pixelY < imageHeight; pixelY++) {
          const i = 4 * (pixelY * imageWidth + pixelX);
          const densityIndex = measured ? Math.round(((1 - (pixelY + 0.5) / imageHeight) * DENSITY_MAX) / measured.densityStep) : -1;
          const inside = rateIndex >= 0 && rateIndex < (measured?.nRates ?? 0) && densityIndex >= 0 && densityIndex < measured.nDensities;
          pixels.data.set(inside ? magma(measured.data[densityIndex * measured.nRates + rateIndex] / 255) : floor, i);
          pixels.data[i + 3] = seam ? 0 : 255;
        }
      }
      measuredImage.getContext("2d").putImageData(pixels, 0, 0);
      measuredDrawn = { picture: measured, key };
    }
    context.imageSmoothingEnabled = false;
    context.drawImage(measuredImage, plane.x0, y0, plane.x1 - plane.x0, y1 - y0);

    const plot = { x0: plane.x0, x1: plane.x1, y0, y1 };
    drawBorder(context, measuredCanvas, plot);
    drawValueTicks(context, plot, [0, 2, 4, 6], densityY, (density) => `${density}`);
    drawRateTicks(context, plot, plane.x);
    drawTitle(
      context, plot,
      !measured ? "Modulation spectrum: play to measure the result" : (state.bands ?? []).length ? "Modulation spectrum, measured within the bands" : "Modulation spectrum, measured",
    );
  }

  // --- the result's spectrogram ------------------------------------------------------

  const STFT_MARGIN = { left: 52, right: 10, top: 6, bottom: 20 };
  let sound = null;
  let playhead = null;
  const stftPanel = logSpectrogramPlot(ui.stft, STFT_MARGIN);

  // The spectrogram panel's plot: pixels to and from time and frequency, on
  // the drawing's own time axis (a result of an older duration, not remade
  // above 3 s, shows at the drawing's times), the axis the bands are drawn on.
  const stftGeometry = () => stftPanel.geometry(state.f_lo, state.f_hi, state.duration);

  function renderStft() {
    const context = stftPanel.clear();
    if (!state) return;
    const stftPlot = stftGeometry();
    stftPanel.draw(context, stftPlot, sound?.spectrogram, { named: true });
    drawBands(context, stftPlot);
    if (playhead !== null) drawPlayhead(context, stftPlot, stftPlot.x(playhead), getComputedStyle(ui.stft).getPropertyValue("--accent").trim() || "#2e86ab");
  }

  // --- the bands, on the spectrogram ---------------------------------------------------

  // A band's center in pixels along the plot, every few pixels.
  function bandPath(stftPlot, band) {
    const path = [];
    for (let x = stftPlot.x0; x <= stftPlot.x1 + 0.5; x += 3) {
      const t = Math.min(state.duration, ((x - stftPlot.x0) / (stftPlot.x1 - stftPlot.x0)) * stftPlot.duration);
      path.push([Math.min(x, stftPlot.x1), bandCenter(band.points, t)]);
    }
    return path;
  }

  function drawBands(context, stftPlot) {
    const clampY = (y) => Math.min(stftPlot.y1, Math.max(stftPlot.y0, y));
    context.save();
    context.beginPath();
    context.rect(stftPlot.x0, stftPlot.y0, stftPlot.x1 - stftPlot.x0, stftPlot.y1 - stftPlot.y0);
    context.clip();
    bands().forEach((band, index) => {
      const chosen = selectedBand?.index === index;
      const path = bandPath(stftPlot, band);
      const halfWidth = band.width / 2;
      context.beginPath();
      path.forEach(([x, f], step) => context[step ? "lineTo" : "moveTo"](x, clampY(stftPlot.y(f * 2 ** halfWidth))));
      for (let step = path.length - 1; step >= 0; step--) context.lineTo(path[step][0], clampY(stftPlot.y(path[step][1] * 2 ** -halfWidth)));
      context.closePath();
      context.fillStyle = chosen ? "rgba(255, 255, 255, 0.16)" : "rgba(255, 255, 255, 0.08)";
      context.fill();
      context.strokeStyle = chosen ? "rgba(255, 255, 255, 0.7)" : "rgba(255, 255, 255, 0.35)";
      context.lineWidth = 1;
      context.setLineDash([3, 3]);
      context.stroke();
      context.setLineDash([]);
      context.beginPath();
      path.forEach(([x, f], step) => context[step ? "lineTo" : "moveTo"](x, stftPlot.y(f)));
      context.strokeStyle = chosen ? "#ffffff" : "rgba(255, 255, 255, 0.75)";
      context.lineWidth = chosen ? 2 : 1.5;
      context.stroke();
      band.points.forEach(([t, f], pointIndex) => {
        const pointChosen = chosen && selectedBand.point === pointIndex;
        context.beginPath();
        context.arc(stftPlot.x(t), stftPlot.y(f), pointChosen ? 5 : 4, 0, 2 * Math.PI);
        context.fillStyle = pointChosen ? "#ffffff" : "rgba(0, 0, 0, 0.6)";
        context.fill();
        context.strokeStyle = "#ffffff";
        context.lineWidth = 1.5;
        context.stroke();
      });
    });
    context.restore();
  }

  // What is under the pointer on the spectrogram: a breakpoint (the
  // selected band's first), a band's center line, or the inside of a
  // band's strip (the narrowest).
  function pickBand(stftPlot, [pointerX, pointerY]) {
    const bandList = bands();
    const order = bandList.map((_, i) => i).sort((a, b) => (b === selectedBand?.index) - (a === selectedBand?.index));
    for (const index of order) {
      const pointIndex = bandList[index].points.findIndex(([t, f]) => Math.hypot(pointerX - stftPlot.x(t), pointerY - stftPlot.y(f)) <= PICK_PX);
      if (pointIndex >= 0) return { kind: "point", index, point: pointIndex };
    }
    const t = stftPlot.t(pointerX);
    for (const index of order) {
      if (Math.abs(pointerY - stftPlot.y(bandCenter(bandList[index].points, t))) <= 5) return { kind: "line", index };
    }
    let inside = null;
    bandList.forEach((band, index) => {
      const octaves = Math.abs(Math.log2(stftPlot.f(pointerY) / bandCenter(band.points, t)));
      if (octaves <= band.width / 2 && (!inside || band.width < bandList[inside.index].width)) inside = { kind: "shift", index };
    });
    return inside;
  }

  const stftLocal = (event) => pointerPosition(ui.stft, event);

  // The plot, and a breakpoint's reach around it: the first and last
  // breakpoints sit on its edges.
  const nearPlot = (stftPlot, [x, y]) => x >= stftPlot.x0 - PICK_PX && x <= stftPlot.x1 + PICK_PX && y >= stftPlot.y0 - PICK_PX && y <= stftPlot.y1 + PICK_PX;

  ui.stft.addEventListener("pointerdown", (event) => {
    if (!state || event.button !== 0) return;
    const stftPlot = stftGeometry();
    const at = stftLocal(event);
    if (!nearPlot(stftPlot, at)) return;
    event.preventDefault();
    const hit = pickBand(stftPlot, at);
    if (bandTool !== "point") {
      // a stroke on the band pressed in, or a new band
      const bandList = bands().map((band) => ({ ...band, points: band.points.map((breakpoint) => [...breakpoint]) }));
      if (!hit && bandList.length >= MAX_BANDS) return;
      const index = hit ? hit.index : bandList.length;
      const from = [stftPlot.t(at[0]), stftPlot.f(at[1])];
      ui.stft.setPointerCapture(event.pointerId);
      deleteTarget = "band";
      selectedBand = { index, point: null };
      const origin = hit ? bandList[index].points : null;
      const next = [...bandList];
      next[index] = { ...(origin ? bandList[index] : { width: 1, level: 0 }), points: strokeOnto(origin, [from]) };
      bandDrag = { kind: bandTool, index, origin, stroke: [from], bands: next, added: !hit, changed: false, start: at };
      showSettings();
      return renderStft();
    }
    if (!hit) {
      selectedBand = null;
      showSettings();
      return renderStft();
    }
    deleteTarget = "band";
    let bandList = bands().map((band) => ({ ...band, points: band.points.map((breakpoint) => [...breakpoint]) }));
    let point = hit.kind === "point" ? hit.point : null;
    let added = false;
    if (hit.kind === "line") {
      // a new breakpoint on the line, where it was clicked
      const t = tidyTime(stftPlot.t(at[0]));
      const points = bandList[hit.index].points;
      if (!points.some(([pointTime]) => pointTime === t)) {
        const f = tidyHz(bandCenter(points, t));
        point = points.findIndex(([pointTime]) => pointTime > t);
        if (point < 0) point = points.length;
        points.splice(point, 0, [t, f]);
        added = true;
      }
    }
    ui.stft.setPointerCapture(event.pointerId);
    selectedBand = { index: hit.index, point };
    bandDrag = { kind: point === null ? "shift" : "point", index: hit.index, point, bands: bandList, added, changed: false, start: at, origin: bandList[hit.index].points.map((breakpoint) => [...breakpoint]) };
    showSettings();
    renderStft();
  });

  ui.stft.addEventListener("pointermove", (event) => {
    if (!state) return;
    const stftPlot = stftGeometry();
    const at = stftLocal(event);
    if (!bandDrag) {
      const hit = nearPlot(stftPlot, at) ? pickBand(stftPlot, at) : null;
      ui.stft.style.cursor = bandTool !== "point" ? "crosshair" : !hit ? "default" : hit.kind === "point" ? "grab" : hit.kind === "line" ? "copy" : "ns-resize";
      return;
    }
    if (bandDrag.kind === "line" || bandDrag.kind === "freehand") {
      const here = [stftPlot.t(at[0]), stftPlot.f(at[1])];
      bandDrag.stroke = bandDrag.kind === "line" ? [bandDrag.stroke[0], here] : extendStroke([...bandDrag.stroke], here);
      const points = strokeOnto(bandDrag.origin, bandDrag.stroke);
      bandDrag.bands = bandDrag.bands.map((band, i) => (i === bandDrag.index ? { ...band, points } : band));
      bandDrag.changed = true;
      showSettings();
      return renderStft();
    }
    const { f_lo, f_hi } = state;
    const dragged = bandDrag.bands[bandDrag.index];
    let points;
    if (bandDrag.kind === "point") {
      const pointIndex = bandDrag.point;
      const before = pointIndex > 0 ? dragged.points[pointIndex - 1][0] + 0.001 : 0;
      const after = pointIndex < dragged.points.length - 1 ? dragged.points[pointIndex + 1][0] - 0.001 : state.duration;
      const t = tidyTime(Math.min(after, Math.max(before, stftPlot.t(at[0]))));
      points = dragged.points.map((point, i) => (i === pointIndex ? [t, tidyHz(stftPlot.f(at[1]))] : point));
    } else {
      // the whole band, up or down in octaves, kept within the range
      const octaves = Math.log2(stftPlot.f(at[1]) / stftPlot.f(bandDrag.start[1]));
      const lowestShift = Math.log2(f_lo / Math.min(...bandDrag.origin.map(([, f]) => f)));
      const highestShift = Math.log2(f_hi / Math.max(...bandDrag.origin.map(([, f]) => f)));
      const shift = Math.min(highestShift, Math.max(lowestShift, octaves));
      points = bandDrag.origin.map(([t, f]) => [t, Math.min(f_hi, Math.max(f_lo, tidyHz(f * 2 ** shift)))]);
    }
    if (points.some(([t, f], i) => t !== dragged.points[i][0] || f !== dragged.points[i][1])) {
      bandDrag.bands = bandDrag.bands.map((band, i) => (i === bandDrag.index ? { ...band, points } : band));
      bandDrag.changed = true;
      showSettings();
      renderStft();
    }
  });

  function finishBand(event) {
    if (!bandDrag) return;
    const { bands: next, added, changed } = bandDrag;
    bandDrag = null;
    if (event.type === "pointercancel" || !(added || changed)) {
      showSettings();
      return renderStft();
    }
    commitBands(next);
  }
  ui.stft.addEventListener("pointerup", finishBand);
  ui.stft.addEventListener("pointercancel", finishBand);

  // The result's waveform, under the measured spectrum, on the bands
  // panel's time axis (the page's own waveform strip is hidden on this tab).
  function renderWave() {
    // the drawing's duration, as the bands panel above it: an older, longer result shows at its own times
    drawWaveform(ui.wave, sound, state?.duration ?? (sound ? soundSeconds(sound) : 1));
  }

  new ResizeObserver(render).observe(canvas);
  new ResizeObserver(renderWave).observe(ui.wave);
  new ResizeObserver(renderMeasured).observe(measuredCanvas);
  new ResizeObserver(renderStft).observe(ui.stft);

  return {
    id: "blobs",
    figure: root.querySelector(".design-box .panel-stack"), // where the shell shows synthesis progress, over the plane
    ownWaveform: true, // drawn in the Result box above
    setDocument(next) {
      fittingDepth = null; // a refusal is shown again if this drawing is refused again
      drag = null;
      bandDrag = null;
      state = next;
      showSettings();
      render();
      renderMeasured();
      renderStft();
    },
    setResult(next) {
      sound = next ?? null;
      if (sound) {
        fittingDepth = null;
        showSettings();
      }
      renderMeasured();
      renderStft();
      renderWave();
    },
    setPlayhead(t) {
      playhead = t;
      renderStft();
    },
    // sonore refused the drawing; if it named a depth that fits, offer a
    // little less: it prints the depth rounded, and the depth that fits can
    // move by a few thousandths with the depth asked for (seen in
    // tools/check_page.py: 0.27 named, then 0.261 at 0.27). If the offer is
    // refused too, the next refusal offers again.
    failed(message) {
      const depth = depthThatFits(message);
      fittingDepth = depth === null ? null : Math.max(0.01, Math.floor((depth - 0.005) * 100) / 100);
      showSettings();
    },
    blocked() {
      return state.items.length ? null : "No blobs yet: click the plane to add one.";
    },
    key(event) {
      if (event.key === "Delete" || event.key === "Backspace") return deleteTarget === "band" ? removeBandOrPoint() : removeSelected();
      const toolKey = !event.ctrlKey && !event.metaKey && BAND_TOOLS.find((tool) => tool.key === event.key.toLowerCase());
      if (toolKey) {
        bandTool = toolKey.id;
        toolBox.querySelector(`input[value="${bandTool}"]`).checked = true;
        return true;
      }
      return false;
    },
  };
}
