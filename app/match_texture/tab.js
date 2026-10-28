// The Match a texture tab: measure a sound's texture statistics and hear
// noise pushed until it has the ones chosen, and nothing else of the sound
// (sonore's texture synthesis; McDermott & Simoncelli, 2011;
// docs/design/tabs/match_texture.md).
//
// Nothing is drawn here. The Source box shows the source's spectrogram; the
// Result box shows the result's, its waveform, and a bar for each class of
// statistics: how well the result matches the source, solid where it was
// imposed (T7).

import { drawBorder, drawPlayhead, drawTitle, drawValueTicks, drawWaveform, fitCanvasInCssPixels, logSpectrogramPlot, soundSeconds } from "../plot.js";
import { typedNumber } from "../draw_spectrogram/model.js";
import { attachSourceControls, sourceFieldset } from "../sources.js";
import { randomSeed } from "../seed.js";
import { BARS, GROUPS, ITERATION_RANGE, LABELS, SNR_RANGE, toggled } from "./model.js";

const F_LO = 100; // Hz, the spectrograms' range
const F_HI = 8000;
const MARGIN = { left: 52, right: 10, top: 6, bottom: 20 };
const BAR_MARGIN = { left: 52, right: 10, top: 8, bottom: 34 };
const CONVERGED_DB = 20; // the paper's mark of a good match (sonore's converged_db)

export function createMatchTextureTab(root, { commit, openRecording, hasRecording, log }) {
  let state = null;
  let sound = null;
  let playhead = null;

  const [lowIterations, highIterations] = ITERATION_RANGE;
  root.innerHTML = `
    <div class="match-texture-body">
      <div class="paint-area">
        <p class="advisory"><strong>Be advised:</strong> this tab is slow. Each iteration analyzes and resynthesizes the whole
          sound, so 10 iterations of a 2 s sound take about 10 to 15 s in the browser and of a 30 s one 2 to 3 minutes.
          Fewer iterations or a shorter duration are faster.</p>
        <section class="panel-box design-box">
          <h3 class="panel-group" title="The sound whose statistics are matched">Source</h3>
          <div class="panel-stack">
            <canvas class="source-stft" title="The source's spectrogram (5 ms window) on a log-frequency axis"></canvas>
          </div>
        </section>
        <section class="panel-box result-box">
          <h3 class="panel-group" title="What came out">Result</h3>
          <div class="panel-stack">
            <canvas class="texture-stft" title="The result's spectrogram (5 ms window) on a log-frequency axis"></canvas>
            <canvas class="wave" title="The result's waveform"></canvas>
            <canvas class="match-bars" title="How well each class of the result's statistics matches the source's (sonore's SNR, dB): solid where it was imposed, outlined where it was not"></canvas>
            <p class="hint texture-note"></p>
          </div>
        </section>
      </div>
      <aside class="side">
        ${sourceFieldset("The sound whose statistics are matched", LABELS)}
        <fieldset><legend>Keep</legend>
          <label class="check" title="The power in each cochlear band: always imposed"><input type="checkbox" checked disabled> Spectrum</label>
          ${Object.entries(GROUPS).map(([id, { name, classes }]) => `
          <label class="check" title="Impose ${classes.join(", ")}"><input type="checkbox" class="keep" value="${id}"> ${name}</label>`).join("")}
        </fieldset>
        <fieldset><legend>Synthesis</legend>
          <label class="field" title="How many times every statistic kept is imposed on the sound, band by band (each one an analysis and a synthesis; slower)">Iterations
            <input type="number" class="iterations" min="${lowIterations}" max="${highIterations}" step="1"></label>
          <label class="field" title="The starting noise's seed">Seed <input type="number" class="seed" min="0" step="1"></label>
          <button type="button" class="reorder" title="Draw a random seed: start from other noise">New draw</button>
        </fieldset>
        <p class="hint">The result starts as noise and keeps only the statistics ticked, measured over the whole source. A texture (rain, applause, a crowd) comes back; speech or a melody does not. Space plays.</p>
      </aside>
    </div>`;
  const query = (selector) => root.querySelector(selector);
  const ui = {
    keep: [...root.querySelectorAll(".keep")], iterations: query(".iterations"), seed: query(".seed"), reorder: query(".reorder"),
    note: query(".texture-note"), source: query("canvas.source-stft"), texture: query("canvas.texture-stft"), wave: query("canvas.wave"),
    bars: query("canvas.match-bars"),
  };

  const showSource = attachSourceControls(root, { state: () => state, commit, openRecording, hasRecording, log });

  function showSettings() {
    showSource();
    for (const box of ui.keep) box.checked = state.keep.includes(box.value);
    ui.iterations.value = state.iterations;
    ui.seed.value = state.seed;
  }

  for (const box of ui.keep) box.addEventListener("change", () => commit({ ...state, keep: toggled(state.keep, box.value, box.checked) }));
  ui.iterations.addEventListener("change", () => {
    const iterations = Math.round(typedNumber(ui.iterations.value, NaN));
    if (iterations >= lowIterations && iterations <= highIterations && iterations !== state.iterations) commit({ ...state, iterations });
    else ui.iterations.value = state.iterations;
  });
  ui.seed.addEventListener("change", () => {
    const seed = Math.round(typedNumber(ui.seed.value, NaN));
    if (Number.isInteger(seed) && seed >= 0 && seed !== state.seed) commit({ ...state, seed });
    else ui.seed.value = state.seed;
  });
  ui.reorder.addEventListener("click", () => commit({ ...state, seed: randomSeed(state.seed) }, { play: true }));

  // What the bars say, in words: the classes imposed that reached the paper's mark.
  function showNote() {
    if (!sound?.match) {
      ui.note.textContent = "";
      return;
    }
    const imposed = BARS.filter((_, i) => sound.imposed[i]);
    const reached = imposed.filter(([name]) => sound.match[BARS.findIndex(([bar]) => bar === name)] >= CONVERGED_DB);
    ui.note.textContent = `${reached.length} of the ${imposed.length} classes imposed match the source to ${CONVERGED_DB} dB or better, the paper's mark of a good match.`;
  }

  // --- the pictures ----------------------------------------------------------------

  const sourcePanel = logSpectrogramPlot(ui.source, MARGIN);
  const texturePanel = logSpectrogramPlot(ui.texture, MARGIN);

  function renderSource() {
    const context = sourcePanel.clear();
    if (!state) return;
    const plot = sourcePanel.geometry(F_LO, F_HI, sound ? soundSeconds(sound) : state.duration);
    const picture = sound?.sourceStft ?? null;
    sourcePanel.draw(context, plot, picture, { named: true });
    drawTitle(context, plot, picture ? "The source" : "The source: Play to measure it");
  }

  function renderTexture() {
    const context = texturePanel.clear();
    if (!state) return;
    const plot = texturePanel.geometry(F_LO, F_HI, sound ? soundSeconds(sound) : state.duration);
    texturePanel.draw(context, plot, sound?.spectrogram, { named: true });
    if (playhead !== null) drawPlayhead(context, plot, plot.x(playhead), "#ffffff");
    drawTitle(context, plot, sound ? "Noise with the source's statistics" : "The result: Play to make it");
  }

  function renderWave() {
    drawWaveform(ui.wave, sound, sound ? soundSeconds(sound) : state?.duration ?? 1);
  }

  // A bar per class, from the axis's floor up to its SNR (T7).
  function renderBars() {
    const canvas = ui.bars;
    const context = fitCanvasInCssPixels(canvas);
    const width = canvas.clientWidth || 600;
    const height = canvas.clientHeight || 160;
    context.clearRect(0, 0, width, height);
    const [low, high] = SNR_RANGE;
    const plot = { x0: BAR_MARGIN.left, x1: width - BAR_MARGIN.right, y0: BAR_MARGIN.top, y1: height - BAR_MARGIN.bottom };
    const y = (db) => plot.y1 - ((Math.min(high, Math.max(low, db)) - low) / (high - low)) * (plot.y1 - plot.y0);
    drawBorder(context, canvas, plot);
    const style = getComputedStyle(canvas);
    const line = style.getPropertyValue("--line").trim() || "#d5d9e0";
    const accent = style.getPropertyValue("--accent").trim() || "#2563eb";
    drawValueTicks(context, plot, [-20, 0, 20, 40, 60], y, (db) => `${db}`, { gridColor: line });
    context.save();
    context.translate(12, (plot.y0 + plot.y1) / 2);
    context.rotate(-Math.PI / 2);
    context.textAlign = "center";
    context.fillText("match, dB", 0, 0);
    context.restore();
    // the paper's mark of a good match
    context.save();
    context.setLineDash([4, 3]);
    context.strokeStyle = accent;
    context.beginPath();
    context.moveTo(plot.x0, Math.round(y(CONVERGED_DB)) + 0.5);
    context.lineTo(plot.x1, Math.round(y(CONVERGED_DB)) + 0.5);
    context.stroke();
    context.restore();
    const slot = (plot.x1 - plot.x0) / BARS.length;
    context.textAlign = "center";
    context.textBaseline = "top";
    const short = BARS.some(([, label]) => context.measureText(label).width > slot - 4);
    BARS.forEach(([, label, shortLabel], i) => {
      const center = plot.x0 + (i + 0.5) * slot;
      context.fillText(short ? shortLabel : label, center, plot.y1 + 6);
      if (!sound?.match) return;
      const top = y(sound.match[i]);
      const bottom = y(low);
      const left = Math.round(center - slot * 0.3) + 0.5;
      const barWidth = Math.round(slot * 0.6);
      if (sound.imposed[i]) {
        context.fillStyle = accent;
        context.fillRect(left, top, barWidth, bottom - top);
      } else {
        context.strokeStyle = accent;
        context.strokeRect(left, top, barWidth, bottom - top);
      }
      context.fillStyle = style.getPropertyValue("--muted").trim() || "#6b7280";
    });
    if (!sound?.match) {
      context.textAlign = "left";
      context.fillText("Play to measure how well the result matches", plot.x0 + 6, plot.y0 + 4);
    }
  }

  new ResizeObserver(renderSource).observe(ui.source);
  new ResizeObserver(renderTexture).observe(ui.texture);
  new ResizeObserver(renderWave).observe(ui.wave);
  new ResizeObserver(renderBars).observe(ui.bars);

  return {
    id: "match_texture",
    figure: root.querySelector(".result-box .panel-stack"), // where the shell shows synthesis progress
    ownWaveform: true, // drawn in the Result box
    clearable: false, // nothing is drawn here
    setDocument(next) {
      state = next;
      showSettings();
      renderSource();
      renderTexture();
    },
    setResult(next) {
      sound = next ?? null;
      showNote();
      renderSource();
      renderTexture();
      renderWave();
      renderBars();
    },
    setPlayhead(t) {
      playhead = t;
      renderTexture();
    },
    failed(message) {
      // the pictures are still the last result's; the note says this one was not made
      ui.note.textContent = `Not made: ${message.replace(/^ValueError: /, "")}`;
    },
    blocked() {
      if (state.source === "file" && !state.recording) return "No recording: open an audio file (Source) to match.";
      return null;
    },
    key() {
      return false;
    },
  };
}
