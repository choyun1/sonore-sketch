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

import { magma } from "../colormap.js";
import { drawWaveform, fitCanvas, niceStep } from "../plot.js";
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
const RATE_TICKS = [1, 2, 4, 8, 16, 32, 64];
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
  let fits = null; // the depth sonore said fits, after it refused this one
  let band = null; // {index, point} of the selected band (point: index or null)
  let bandDrag = null; // {kind, index, point, bands, changed, ...} while a gesture on the spectrogram lasts
  let focus = "blob"; // what Delete removes: the selected "blob" or "band"

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
            <select class="carrier">${CARRIERS.map((c) => `<option value="${c}">${c}</option>`).join("")}</select></label>
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
  const $ = (selector) => root.querySelector(selector);
  const canvas = $("canvas.plane");
  const ui = {
    count: $(".blob-count"), edit: $(".blob-edit"), rate: $(".rate"), density: $(".density"),
    rateWidth: $(".rate-width"), densityWidth: $(".density-width"), level: $(".level"), remove: $(".delete"),
    carrier: $(".carrier"), f0: $(".f0"), f0Field: $(".f0-field"), stft: $("canvas.stft"), depth: $(".depth"), useDepth: $(".use-depth"), seed: $(".seed"), iterations: $(".iterations"), iterationsField: $(".iterations-field"),
    newDraw: $(".new-draw"), coarse: $(".coarse"),
    bandCount: $(".band-count"), bandEdit: $(".band-edit"), bandWidth: $(".band-width"), bandLevel: $(".band-level"),
    removeBand: $(".delete-band"), addBand: $(".add-band"), bandMotion: $(".band-motion"), wave: $("canvas.wave"),
  };

  // The bands' drawing tools, as on the Draw speech tab: Point moves breakpoints
  // (and a click on a band's line adds one, a drag inside it moves it all);
  // Line and Freehand draw a stroke that replaces the band's track over its
  // span, on the band pressed in, or make a new band when pressed outside.
  let bandTool = "point";
  const toolBox = $(".band-tools");
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
    const list = items();
    if (selected !== null && selected >= list.length) selected = list.length ? list.length - 1 : null;
    const blob = selected === null ? null : list[selected];
    ui.edit.hidden = !blob;
    ui.count.textContent =
      list.length >= MAX_BLOBS
        ? `${list.length} of ${MAX_BLOBS} blobs: delete one to add another.`
        : `${list.length} of ${MAX_BLOBS} blobs.${blob ? "" : " Click a blob to edit it, or empty space to add one."}`;
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
    ui.useDepth.hidden = fits === null;
    if (fits !== null) ui.useDepth.textContent = `Use depth ${fits}`;
    const bandList = bands();
    if (band !== null && !bandList[band.index]) band = null;
    const chosen = band === null ? null : bandList[band.index];
    ui.bandEdit.hidden = !chosen;
    ui.addBand.disabled = bandList.length >= MAX_BANDS;
    ui.bandCount.textContent = !bandList.length
      ? `No bands: the sound fills ${state.f_lo}–${state.f_hi} Hz. Add one to confine it.`
      : `${bandList.length} of ${MAX_BANDS} bands.${chosen ? "" : " Click a band on the spectrogram to edit it."}`;
    if (chosen) {
      ui.bandWidth.value = +chosen.width.toFixed(2);
      ui.bandLevel.value = chosen.level ?? 0;
    }
    ui.bandMotion.hidden = !bandList.some((b) => b.points.some(([, f]) => f !== b.points[0][1]));
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
      commitItems(state.items.map((b, i) => (i === selected ? { ...b, [key]: next } : b)));
    };
  }
  const fieldOf = { rate: "rate", density: "density", rate_width: "rateWidth", density_width: "densityWidth", level: "level" };
  ui.rate.addEventListener("change", editSelected("rate", clampRate));
  ui.density.addEventListener("change", editSelected("density", clampDensity));
  ui.rateWidth.addEventListener("change", editSelected("rate_width", clampWidth));
  ui.densityWidth.addEventListener("change", editSelected("density_width", clampWidth));
  ui.level.addEventListener("change", editSelected("level", (x) => Math.min(0, Math.max(-40, x))));
  ui.remove.addEventListener("click", removeSelected);

  function editBand(key, clamp) {
    return () => {
      const chosen = band && state.bands?.[band.index];
      const value = Number(ui[key === "width" ? "bandWidth" : "bandLevel"].value);
      if (!chosen || !Number.isFinite(value)) return showSettings();
      const next = Math.round(clamp(value) * 100) / 100;
      if (next === (chosen[key] ?? 0)) return showSettings();
      commitBands(state.bands.map((b, i) => (i === band.index ? { ...b, [key]: next } : b)));
    };
  }
  ui.bandWidth.addEventListener("change", editBand("width", clampBandWidth));
  ui.bandLevel.addEventListener("change", editBand("level", clampBandLevel));
  ui.removeBand.addEventListener("click", () => {
    focus = "band";
    if (band) band.point = null;
    removeBandOrPoint();
  });
  ui.addBand.addEventListener("click", () => {
    const list = state.bands ?? [];
    if (list.length >= MAX_BANDS) return;
    band = { index: list.length, point: null };
    focus = "band";
    commitBands([...list, newBand(list, state.duration)]);
  });

  // Delete removes the selected breakpoint (a band keeps at least one), or,
  // with none selected, the band.
  function removeBandOrPoint() {
    const list = state.bands ?? [];
    const chosen = band && list[band.index];
    if (!chosen) return false;
    if (band.point !== null && chosen.points.length > 1) {
      const points = chosen.points.filter((_, k) => k !== band.point);
      band = { index: band.index, point: null };
      commitBands(list.map((b, i) => (i === band.index ? { ...b, points } : b)));
      return true;
    }
    const next = list.filter((_, i) => i !== band.index);
    band = null;
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
  ui.useDepth.addEventListener("click", () => fits !== null && commit({ ...state, rms_depth: fits }));
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
  ui.newDraw.addEventListener("click", () => commit({ ...state, seed: state.seed + 1 }));

  function removeSelected() {
    if (selected === null || !state.items[selected]) return false;
    const next = state.items.filter((_, i) => i !== selected);
    selected = next.length ? Math.min(selected, next.length - 1) : null;
    commitItems(next);
    return true;
  }

  // --- the plane -------------------------------------------------------------------

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
      rate: (px) => (px >= xc ? unitToRate(Math.max(0, (px - xc - SEAM) / half)) : -unitToRate(Math.max(0, (xc - SEAM - px) / half))),
      density: (py) => ((y1 - py) / (y1 - y0)) * DENSITY_MAX,
    };
  }

  // A blob's outline in pixels: center, the ellipse's extent, and its two handles.
  function shape(g, blob) {
    const xl = g.x(blob.rate * 2 ** -blob.rate_width);
    const xr = g.x(blob.rate * 2 ** blob.rate_width);
    return {
      cx: g.x(blob.rate),
      cy: g.y(blob.density),
      ex: (xl + xr) / 2,
      rx: Math.max(2, Math.abs(xr - xl) / 2),
      ry: Math.max(2, (blob.density_width / DENSITY_MAX) * (g.y1 - g.y0)),
      widthHandle: [xr, g.y(blob.density)],
      heightHandle: [g.x(blob.rate), g.y(blob.density + blob.density_width)],
    };
  }

  const image = document.createElement("canvas");

  // The drawn spectrum, one pixel per CSS pixel of the plot, each pixel
  // showing the grid cell (rate, density) it falls in.
  function picture(g) {
    const width = Math.max(1, Math.round(g.x1 - g.x0));
    const height = Math.max(1, Math.round(g.y1 - g.y0));
    image.width = width;
    image.height = height;
    const context = image.getContext("2d");
    const pixels = context.createImageData(width, height);
    const { rateStep, densityStep, densities } = grid(state);
    const list = items();
    // each pixel row's density cell, or -1 above the grid's last
    const rowCell = Int32Array.from({ length: height }, (_, py) => {
      const j = Math.round(g.density(g.y0 + py + 0.5) / densityStep);
      return j < densities.length ? j : -1;
    });
    const columns = [];
    let peak = 0;
    for (let px = 0; px < width; px++) {
      const x = g.x0 + px + 0.5;
      const k = Math.abs(x - g.xc) < SEAM ? 0 : Math.round(g.rate(x) / rateStep);
      if (k === 0) {
        columns.push(null);
        continue;
      }
      const column = densities.map((d) => power(list, k * rateStep, d));
      for (const p of column) peak = Math.max(peak, p);
      columns.push(column);
    }
    const floor = magma(0);
    for (let px = 0; px < width; px++) {
      const column = columns[px];
      for (let py = 0; py < height; py++) {
        const i = 4 * (py * width + px);
        const j = rowCell[py];
        let color = floor;
        if (column && j >= 0 && peak > 0) {
          const level = 10 * Math.log10(column[j] / peak);
          color = magma(Math.max(0, 1 - level / FLOOR_DB));
        }
        pixels.data.set(color, i);
        pixels.data[i + 3] = column || Math.abs(g.x0 + px + 0.5 - g.xc) >= SEAM ? 255 : 0;
      }
    }
    context.putImageData(pixels, 0, 0);
    return image;
  }

  function render() {
    if (!state) return;
    const context = fitCanvas(canvas);
    const ratio = canvas.width / (canvas.clientWidth || 1);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const g = geometry();
    const style = getComputedStyle(canvas);
    const muted = style.getPropertyValue("--muted").trim() || "#6b7280";
    const line = style.getPropertyValue("--line").trim() || "#d5d9e0";
    context.clearRect(0, 0, g.width, g.height);
    context.imageSmoothingEnabled = false;
    context.drawImage(picture(g), g.x0, g.y0, g.x1 - g.x0, g.y1 - g.y0);

    // axes and gridlines
    context.lineWidth = 1;
    context.font = "11px system-ui, sans-serif";
    context.fillStyle = muted;
    context.strokeStyle = line;
    context.strokeRect(g.x0 + 0.5, g.y0 + 0.5, g.x1 - g.x0 - 1, g.y1 - g.y0 - 1);
    context.textAlign = "right";
    context.textBaseline = "middle";
    for (let d = 0; d <= DENSITY_MAX; d++) {
      const y = Math.round(g.y(d)) + 0.5;
      context.strokeStyle = "rgba(255, 255, 255, 0.15)";
      context.beginPath();
      context.moveTo(g.x0, y);
      context.lineTo(g.x1, y);
      context.stroke();
      context.fillText(`${d}`, g.x0 - 6, Math.min(Math.max(y, g.y0 + 5), g.y1 - 5));
    }
    context.save();
    context.translate(12, (g.y0 + g.y1) / 2);
    context.rotate(-Math.PI / 2);
    context.textAlign = "center";
    context.fillText("cyc/oct", 0, 0);
    context.restore();
    context.textAlign = "center";
    context.textBaseline = "top";
    for (const sign of [-1, 1]) {
      for (const r of RATE_TICKS) {
        const x = Math.round(g.x(sign * r)) + 0.5;
        context.strokeStyle = "rgba(255, 255, 255, 0.15)";
        context.beginPath();
        context.moveTo(x, g.y0);
        context.lineTo(x, g.y1);
        context.stroke();
        context.fillText(`${sign * r}`.replace("-", "−"), x, g.y1 + 4);
      }
    }
    context.textAlign = "left";
    context.fillText("← sweeps up", g.x0, g.y1 + 19);
    context.textAlign = "center";
    context.fillText("rate, Hz", g.xc, g.y1 + 19);
    context.textAlign = "right";
    context.fillText("sweeps down →", g.x1, g.y1 + 19);

    // the blobs
    items().forEach((blob, i) => {
      const s = shape(g, blob);
      const chosen = i === selected;
      context.strokeStyle = chosen ? "rgba(255, 255, 255, 0.95)" : "rgba(255, 255, 255, 0.6)";
      context.lineWidth = chosen ? 2 : 1.25;
      context.setLineDash(chosen ? [] : [4, 3]);
      context.beginPath();
      context.ellipse(s.ex, s.cy, s.rx, s.ry, 0, 0, 2 * Math.PI);
      context.stroke();
      context.setLineDash([]);
      context.fillStyle = chosen ? "#ffffff" : "rgba(255, 255, 255, 0.8)";
      context.beginPath();
      context.arc(s.cx, s.cy, chosen ? 4.5 : 3.5, 0, 2 * Math.PI);
      context.fill();
      if (chosen) {
        context.fillStyle = "#ffffff";
        context.strokeStyle = "#000000";
        context.lineWidth = 1;
        for (const [hx, hy] of [s.widthHandle, s.heightHandle]) {
          context.fillRect(hx - 4, hy - 4, 8, 8);
          context.strokeRect(hx - 4 + 0.5, hy - 4 + 0.5, 7, 7);
        }
      }
    });
  }

  // --- gestures --------------------------------------------------------------------

  function local(event) {
    const box = canvas.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  }

  // What is under the pointer: the selected blob's handles first, then the
  // nearest center, then the inside of the smallest outline.
  function pick(g, [px, py]) {
    const list = items();
    const near = (x, y) => Math.hypot(px - x, py - y) <= PICK_PX;
    if (selected !== null && list[selected]) {
      const s = shape(g, list[selected]);
      // a handle held on the center by the plane's edge leaves the center to Move
      const onCenter = (handle) => Math.hypot(handle[0] - s.cx, handle[1] - s.cy) <= PICK_PX;
      if (near(...s.widthHandle) && !onCenter(s.widthHandle)) return { kind: "rate_width", index: selected };
      if (near(...s.heightHandle) && !onCenter(s.heightHandle)) return { kind: "density_width", index: selected };
    }
    let best = null;
    list.forEach((blob, index) => {
      const s = shape(g, blob);
      const distance = Math.hypot(px - s.cx, py - s.cy);
      if (distance <= PICK_PX && (!best || distance < best.distance)) best = { kind: "move", index, distance };
    });
    if (best) return best;
    let inside = null;
    list.forEach((blob, index) => {
      const s = shape(g, blob);
      const area = s.rx * s.ry;
      if (((px - s.ex) / s.rx) ** 2 + ((py - s.cy) / s.ry) ** 2 <= 1 && (!inside || area < inside.area)) {
        inside = { kind: "move", index, area };
      }
    });
    return inside;
  }

  const inPlot = (g, [px, py]) => px >= g.x0 && px <= g.x1 && py >= g.y0 && py <= g.y1;

  canvas.addEventListener("pointerdown", (event) => {
    if (!state || event.button !== 0) return;
    const g = geometry();
    const at = local(event);
    if (!inPlot(g, at)) return;
    event.preventDefault();
    let hit = pick(g, at);
    let list = state.items.map((blob) => ({ ...blob }));
    let added = false;
    if (!hit) {
      if (list.length >= MAX_BLOBS) {
        selected = null;
        showSettings();
        return render();
      }
      list = [...list, { rate: tidy(clampRate(g.rate(at[0]))), density: tidy(clampDensity(g.density(at[1]))), ...NEW_BLOB }];
      hit = { kind: "move", index: list.length - 1 };
      added = true;
    }
    canvas.setPointerCapture(event.pointerId);
    selected = hit.index;
    focus = "blob";
    const blob = list[hit.index];
    // a move keeps the blob's center where it was relative to the pointer
    drag = { ...hit, items: list, added, changed: false, offset: [at[0] - g.x(blob.rate), at[1] - g.y(blob.density)] };
    showSettings();
    render();
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!state) return;
    const g = geometry();
    const at = local(event);
    if (!drag) {
      const hit = inPlot(g, at) ? pick(g, at) : null;
      canvas.style.cursor = !hit ? "crosshair" : hit.kind === "move" ? "grab" : hit.kind === "rate_width" ? "ew-resize" : "ns-resize";
      return;
    }
    const blob = drag.items[drag.index];
    let next = blob;
    if (drag.kind === "move") {
      const x = at[0] - drag.offset[0];
      const y = at[1] - drag.offset[1];
      next = { ...blob, rate: tidy(clampRate(g.rate(x))), density: tidy(clampDensity(g.density(y))) };
    } else if (drag.kind === "rate_width") {
      const octaves = Math.abs(Math.log2(Math.abs(g.rate(at[0])) / Math.abs(blob.rate)));
      next = { ...blob, rate_width: tidy(clampWidth(octaves)) };
    } else {
      next = { ...blob, density_width: tidy(clampWidth(Math.abs(g.density(at[1]) - blob.density))) };
    }
    if (next.rate !== blob.rate || next.density !== blob.density || next.rate_width !== blob.rate_width || next.density_width !== blob.density_width) {
      drag.items = drag.items.map((b, i) => (i === drag.index ? next : b));
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

  const measuredCanvas = $("canvas.measured");
  const MEASURED_MARGIN = { left: MARGIN.left, right: MARGIN.right, top: 6, bottom: 22 };
  const measuredImage = document.createElement("canvas");
  let measuredDrawn = { picture: null, key: "" };

  function renderMeasured() {
    const context = fitCanvas(measuredCanvas);
    const ratio = measuredCanvas.width / (measuredCanvas.clientWidth || 1);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const width = measuredCanvas.clientWidth || 600;
    const height = measuredCanvas.clientHeight || 160;
    context.clearRect(0, 0, width, height);
    if (!state) return;
    // the plane's rate axis, at this canvas's height
    const g = { ...geometry() };
    const y0 = MEASURED_MARGIN.top;
    const y1 = height - MEASURED_MARGIN.bottom;
    const yOf = (d) => y1 - (d / DENSITY_MAX) * (y1 - y0);
    const style = getComputedStyle(measuredCanvas);
    const muted = style.getPropertyValue("--muted").trim() || "#6b7280";
    const line = style.getPropertyValue("--line").trim() || "#d5d9e0";
    const picture = sound?.modulation ?? null;
    const w = Math.max(1, Math.round(g.x1 - g.x0));
    const h = Math.max(1, Math.round(y1 - y0));
    const key = [w, h].join(" ");
    if (measuredDrawn.picture !== picture || measuredDrawn.key !== key) {
      measuredImage.width = w;
      measuredImage.height = h;
      const pixels = measuredImage.getContext("2d").createImageData(w, h);
      const floor = magma(0);
      for (let px = 0; px < w; px++) {
        const x = g.x0 + px + 0.5;
        const seam = Math.abs(x - g.xc) < SEAM;
        const k = picture && !seam ? Math.round((g.rate(x) - picture.rateFirst) / picture.rateStep) : -1;
        for (let py = 0; py < h; py++) {
          const i = 4 * (py * w + px);
          const j = picture ? Math.round(((1 - (py + 0.5) / h) * DENSITY_MAX) / picture.densityStep) : -1;
          const inside = k >= 0 && k < (picture?.nRates ?? 0) && j >= 0 && j < picture.nDensities;
          pixels.data.set(inside ? magma(picture.data[j * picture.nRates + k] / 255) : floor, i);
          pixels.data[i + 3] = seam ? 0 : 255;
        }
      }
      measuredImage.getContext("2d").putImageData(pixels, 0, 0);
      measuredDrawn = { picture, key };
    }
    context.imageSmoothingEnabled = false;
    context.drawImage(measuredImage, g.x0, y0, g.x1 - g.x0, y1 - y0);

    context.lineWidth = 1;
    context.font = "11px system-ui, sans-serif";
    context.strokeStyle = line;
    context.strokeRect(g.x0 + 0.5, y0 + 0.5, g.x1 - g.x0 - 1, y1 - y0 - 1);
    context.fillStyle = muted;
    context.textAlign = "right";
    context.textBaseline = "middle";
    for (const d of [0, 2, 4, 6]) {
      const y = Math.round(yOf(d)) + 0.5;
      context.strokeStyle = "rgba(255, 255, 255, 0.15)";
      context.beginPath();
      context.moveTo(g.x0, y);
      context.lineTo(g.x1, y);
      context.stroke();
      context.fillText(`${d}`, g.x0 - 6, Math.min(Math.max(y, y0 + 5), y1 - 5));
    }
    context.textAlign = "center";
    context.textBaseline = "top";
    for (const sign of [-1, 1]) {
      for (const r of RATE_TICKS) {
        const x = Math.round(g.x(sign * r)) + 0.5;
        context.strokeStyle = "rgba(255, 255, 255, 0.15)";
        context.beginPath();
        context.moveTo(x, y0);
        context.lineTo(x, y1);
        context.stroke();
        context.fillText(`${sign * r}`.replace("-", "−"), x, y1 + 4);
      }
    }
    context.textAlign = "left";
    context.fillStyle = "rgba(255, 255, 255, 0.85)";
    context.fillText(
      !picture ? "Modulation spectrum: play to measure the result" : (state.bands ?? []).length ? "Modulation spectrum, measured within the bands" : "Modulation spectrum, measured",
      g.x0 + 6, y0 + 4,
    );
  }

  // --- the result's spectrogram ------------------------------------------------------

  const STFT_MARGIN = { left: 52, right: 10, top: 6, bottom: 20 };
  const FREQUENCY_TICKS = [100, 200, 500, 1000, 2000, 5000];
  let sound = null;
  let playhead = null;
  const stftImage = document.createElement("canvas");
  let stftDrawn = { sound: null, key: "" };

  // The spectrogram as an image, one pixel per CSS pixel; kept until the
  // sound or the size changes, so the playhead can move over it cheaply.
  function paintStft(w, h, span, duration) {
    const { f_lo } = state;
    stftImage.width = w;
    stftImage.height = h;
    const pixels = stftImage.getContext("2d").createImageData(w, h);
    const floor = magma(0);
    for (let i = 0; i < pixels.data.length; i += 4) {
      pixels.data.set(floor, i);
      pixels.data[i + 3] = 255;
    }
    const picture = sound?.spectrogram;
    if (picture) {
      const { data, nFreqs, nWindows, fMax, tStart, tStep } = picture;
      const bins = Int32Array.from({ length: h }, (_, py) => Math.round(((f_lo * 2 ** ((1 - (py + 0.5) / h) * span)) / fMax) * (nFreqs - 1)));
      for (let px = 0; px < w; px++) {
        const timeWindow = Math.round((((px + 0.5) / w) * duration - tStart) / tStep);
        if (timeWindow < 0 || timeWindow >= nWindows) continue;
        for (let py = 0; py < h; py++) {
          const bin = bins[py];
          if (bin < 0 || bin >= nFreqs) continue;
          pixels.data.set(magma(data[bin * nWindows + timeWindow] / 255), 4 * (py * w + px));
        }
      }
    }
    stftImage.getContext("2d").putImageData(pixels, 0, 0);
  }

  // The spectrogram panel's plot: pixels to and from time and frequency.
  // Its time axis is the sound's own duration while a new one is made, so
  // the picture does not jump; the bands are drawn on the same axis.
  function stftGeometry() {
    const width = ui.stft.clientWidth || 600;
    const height = ui.stft.clientHeight || 200;
    const x0 = STFT_MARGIN.left;
    const x1 = width - STFT_MARGIN.right;
    const y0 = STFT_MARGIN.top;
    const y1 = height - STFT_MARGIN.bottom;
    const { f_lo, f_hi } = state;
    // the drawing's own time axis: a result of an older duration (not remade above 3 s) shows at its own times
    const duration = state.duration;
    const span = Math.log2(f_hi / f_lo);
    return {
      width, height, x0, x1, y0, y1, duration, span,
      x: (t) => x0 + (t / duration) * (x1 - x0),
      y: (f) => y1 - (Math.log2(f / f_lo) / span) * (y1 - y0),
      t: (px) => Math.min(state.duration, Math.max(0, ((px - x0) / (x1 - x0)) * duration)),
      f: (py) => Math.min(f_hi, Math.max(f_lo, f_lo * 2 ** (((y1 - py) / (y1 - y0)) * span))),
    };
  }

  function renderStft() {
    const context = fitCanvas(ui.stft);
    const ratio = ui.stft.width / (ui.stft.clientWidth || 1);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, ui.stft.clientWidth || 600, ui.stft.clientHeight || 200);
    if (!state) return;
    const sg = stftGeometry();
    const { x0, x1, y0, y1, duration, span, y } = sg;
    const { f_lo, f_hi } = state;
    const style = getComputedStyle(ui.stft);
    const muted = style.getPropertyValue("--muted").trim() || "#6b7280";
    const line = style.getPropertyValue("--line").trim() || "#d5d9e0";
    const w = Math.max(1, Math.round(x1 - x0));
    const h = Math.max(1, Math.round(y1 - y0));
    const key = [w, h, f_lo, f_hi, duration].join(" ");
    if (stftDrawn.sound !== sound || stftDrawn.key !== key) {
      paintStft(w, h, span, duration);
      stftDrawn = { sound, key };
    }
    context.imageSmoothingEnabled = true;
    context.drawImage(stftImage, x0, y0, x1 - x0, y1 - y0);

    context.lineWidth = 1;
    context.font = "11px system-ui, sans-serif";
    context.strokeStyle = line;
    context.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
    context.fillStyle = muted;
    context.textAlign = "right";
    context.textBaseline = "middle";
    for (const f of FREQUENCY_TICKS.filter((f) => f >= f_lo && f <= f_hi)) {
      const yy = Math.round(y(f)) + 0.5;
      context.strokeStyle = "rgba(255, 255, 255, 0.15)";
      context.beginPath();
      context.moveTo(x0, yy);
      context.lineTo(x1, yy);
      context.stroke();
      context.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x0 - 6, Math.min(Math.max(yy, y0 + 5), y1 - 5));
    }
    context.save();
    context.translate(12, (y0 + y1) / 2);
    context.rotate(-Math.PI / 2);
    context.textAlign = "center";
    context.fillText("Hz", 0, 0);
    context.restore();
    context.textAlign = "center";
    context.textBaseline = "top";
    const step = niceStep(duration, x1 - x0);
    for (let k = 0; k * step <= duration + 1e-9; k++) {
      const x = x0 + ((k * step) / duration) * (x1 - x0);
      if (x < x1 - 24) context.fillText(`${+(k * step).toFixed(2)}`, x, y1 + 4);
    }
    context.textAlign = "right";
    context.fillText("s", x1, y1 + 4);
    drawBands(context, sg);
    if (playhead !== null) {
      const x = Math.round(x0 + (playhead / duration) * (x1 - x0)) + 0.5;
      context.strokeStyle = style.getPropertyValue("--accent").trim() || "#2e86ab";
      context.beginPath();
      context.moveTo(x, y0);
      context.lineTo(x, y1);
      context.stroke();
    }
  }

  // --- the bands, on the spectrogram ---------------------------------------------------

  // A band's center in pixels along the plot, every few pixels.
  function bandPath(sg, b) {
    const path = [];
    for (let px = sg.x0; px <= sg.x1 + 0.5; px += 3) {
      const t = Math.min(state.duration, ((px - sg.x0) / (sg.x1 - sg.x0)) * sg.duration);
      path.push([Math.min(px, sg.x1), bandCenter(b.points, t)]);
    }
    return path;
  }

  function drawBands(context, sg) {
    const clampY = (v) => Math.min(sg.y1, Math.max(sg.y0, v));
    context.save();
    context.beginPath();
    context.rect(sg.x0, sg.y0, sg.x1 - sg.x0, sg.y1 - sg.y0);
    context.clip();
    bands().forEach((b, i) => {
      const chosen = band?.index === i;
      const path = bandPath(sg, b);
      const half = b.width / 2;
      context.beginPath();
      path.forEach(([px, f], k) => context[k ? "lineTo" : "moveTo"](px, clampY(sg.y(f * 2 ** half))));
      for (let k = path.length - 1; k >= 0; k--) context.lineTo(path[k][0], clampY(sg.y(path[k][1] * 2 ** -half)));
      context.closePath();
      context.fillStyle = chosen ? "rgba(255, 255, 255, 0.16)" : "rgba(255, 255, 255, 0.08)";
      context.fill();
      context.strokeStyle = chosen ? "rgba(255, 255, 255, 0.7)" : "rgba(255, 255, 255, 0.35)";
      context.lineWidth = 1;
      context.setLineDash([3, 3]);
      context.stroke();
      context.setLineDash([]);
      context.beginPath();
      path.forEach(([px, f], k) => context[k ? "lineTo" : "moveTo"](px, sg.y(f)));
      context.strokeStyle = chosen ? "#ffffff" : "rgba(255, 255, 255, 0.75)";
      context.lineWidth = chosen ? 2 : 1.5;
      context.stroke();
      b.points.forEach(([t, f], k) => {
        const on = chosen && band.point === k;
        context.beginPath();
        context.arc(sg.x(t), sg.y(f), on ? 5 : 4, 0, 2 * Math.PI);
        context.fillStyle = on ? "#ffffff" : "rgba(0, 0, 0, 0.6)";
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
  function pickBand(sg, [px, py]) {
    const list = bands();
    const order = list.map((_, i) => i).sort((a, b) => (b === band?.index) - (a === band?.index));
    for (const index of order) {
      const k = list[index].points.findIndex(([t, f]) => Math.hypot(px - sg.x(t), py - sg.y(f)) <= PICK_PX);
      if (k >= 0) return { kind: "point", index, point: k };
    }
    const t = sg.t(px);
    for (const index of order) {
      if (Math.abs(py - sg.y(bandCenter(list[index].points, t))) <= 5) return { kind: "line", index };
    }
    let inside = null;
    list.forEach((b, index) => {
      const octaves = Math.abs(Math.log2(sg.f(py) / bandCenter(b.points, t)));
      if (octaves <= b.width / 2 && (!inside || b.width < list[inside.index].width)) inside = { kind: "shift", index };
    });
    return inside;
  }

  function stftLocal(event) {
    const box = ui.stft.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  }

  // The plot, and a breakpoint's reach around it: the first and last
  // breakpoints sit on its edges.
  const nearPlot = (sg, [px, py]) => px >= sg.x0 - PICK_PX && px <= sg.x1 + PICK_PX && py >= sg.y0 - PICK_PX && py <= sg.y1 + PICK_PX;

  ui.stft.addEventListener("pointerdown", (event) => {
    if (!state || event.button !== 0) return;
    const sg = stftGeometry();
    const at = stftLocal(event);
    if (!nearPlot(sg, at)) return;
    event.preventDefault();
    const hit = pickBand(sg, at);
    if (bandTool !== "point") {
      // a stroke on the band pressed in, or a new band
      const list = bands().map((b) => ({ ...b, points: b.points.map((p) => [...p]) }));
      if (!hit && list.length >= MAX_BANDS) return;
      const index = hit ? hit.index : list.length;
      const from = [sg.t(at[0]), sg.f(at[1])];
      ui.stft.setPointerCapture(event.pointerId);
      focus = "band";
      band = { index, point: null };
      const origin = hit ? list[index].points : null;
      const next = [...list];
      next[index] = { ...(origin ? list[index] : { width: 1, level: 0 }), points: strokeOnto(origin, [from]) };
      bandDrag = { kind: bandTool, index, origin, stroke: [from], bands: next, added: !hit, changed: false, start: at };
      showSettings();
      return renderStft();
    }
    if (!hit) {
      band = null;
      showSettings();
      return renderStft();
    }
    focus = "band";
    let list = bands().map((b) => ({ ...b, points: b.points.map((p) => [...p]) }));
    let point = hit.kind === "point" ? hit.point : null;
    let added = false;
    if (hit.kind === "line") {
      // a new breakpoint on the line, where it was clicked
      const t = tidyTime(sg.t(at[0]));
      const points = list[hit.index].points;
      if (!points.some(([pt]) => pt === t)) {
        const f = tidyHz(bandCenter(points, t));
        point = points.findIndex(([pt]) => pt > t);
        if (point < 0) point = points.length;
        points.splice(point, 0, [t, f]);
        added = true;
      }
    }
    ui.stft.setPointerCapture(event.pointerId);
    band = { index: hit.index, point };
    bandDrag = { kind: point === null ? "shift" : "point", index: hit.index, point, bands: list, added, changed: false, start: at, origin: list[hit.index].points.map((p) => [...p]) };
    showSettings();
    renderStft();
  });

  ui.stft.addEventListener("pointermove", (event) => {
    if (!state) return;
    const sg = stftGeometry();
    const at = stftLocal(event);
    if (!bandDrag) {
      const hit = nearPlot(sg, at) ? pickBand(sg, at) : null;
      ui.stft.style.cursor = bandTool !== "point" ? "crosshair" : !hit ? "default" : hit.kind === "point" ? "grab" : hit.kind === "line" ? "copy" : "ns-resize";
      return;
    }
    if (bandDrag.kind === "line" || bandDrag.kind === "freehand") {
      const here = [sg.t(at[0]), sg.f(at[1])];
      bandDrag.stroke = bandDrag.kind === "line" ? [bandDrag.stroke[0], here] : [...bandDrag.stroke, here];
      const points = strokeOnto(bandDrag.origin, bandDrag.stroke);
      bandDrag.bands = bandDrag.bands.map((x, i) => (i === bandDrag.index ? { ...x, points } : x));
      bandDrag.changed = true;
      showSettings();
      return renderStft();
    }
    const { f_lo, f_hi } = state;
    const b = bandDrag.bands[bandDrag.index];
    let points;
    if (bandDrag.kind === "point") {
      const k = bandDrag.point;
      const before = k > 0 ? b.points[k - 1][0] + 0.001 : 0;
      const after = k < b.points.length - 1 ? b.points[k + 1][0] - 0.001 : state.duration;
      const t = tidyTime(Math.min(after, Math.max(before, sg.t(at[0]))));
      points = b.points.map((p, i) => (i === k ? [t, tidyHz(sg.f(at[1]))] : p));
    } else {
      // the whole band, up or down in octaves, kept within the range
      const octaves = Math.log2(sg.f(at[1]) / sg.f(bandDrag.start[1]));
      const lo = Math.log2(f_lo / Math.min(...bandDrag.origin.map(([, f]) => f)));
      const hi = Math.log2(f_hi / Math.max(...bandDrag.origin.map(([, f]) => f)));
      const shift = Math.min(hi, Math.max(lo, octaves));
      points = bandDrag.origin.map(([t, f]) => [t, Math.min(f_hi, Math.max(f_lo, tidyHz(f * 2 ** shift)))]);
    }
    if (points.some(([t, f], i) => t !== b.points[i][0] || f !== b.points[i][1])) {
      bandDrag.bands = bandDrag.bands.map((x, i) => (i === bandDrag.index ? { ...x, points } : x));
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
    const duration = state?.duration ?? (sound ? sound.samples.length / sound.fs : 1);
    drawWaveform(ui.wave, sound?.samples, sound?.fs, duration);
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
      fits = null; // a refusal is shown again if this drawing is refused again
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
        fits = null;
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
      fits = depth === null ? null : Math.max(0.01, Math.floor((depth - 0.005) * 100) / 100);
      showSettings();
    },
    blocked() {
      return state.items.length ? null : "No blobs yet: click the plane to add one.";
    },
    key(event) {
      if (event.key === "Delete" || event.key === "Backspace") return focus === "band" ? removeBandOrPoint() : removeSelected();
      const toolKey = !event.ctrlKey && !event.metaKey && BAND_TOOLS.find((t) => t.key === event.key.toLowerCase());
      if (toolKey) {
        bandTool = toolKey.id;
        toolBox.querySelector(`input[value="${bandTool}"]`).checked = true;
        return true;
      }
      return false;
    },
  };
}
