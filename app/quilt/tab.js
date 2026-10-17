// The Quilt a sound tab: cut a sound into short segments and hear them put
// back in a new order, each next to one that continues it as the sound
// itself went on (sonore's quilt; Overath et al., 2015).
//
// Nothing is drawn here. The Source box shows the source's spectrogram cut
// into its segments; the Result box shows the quilt's, with its joins, and
// its waveform. Both are on a log-frequency axis, over the page's duration.

import { numberBox } from "../numberbox.js";
import { drawPlayhead, drawTitle, drawWaveform, logSpectrogramPlot, soundSeconds } from "../plot.js";
import { typedNumber } from "../painted/model.js";
import { attachSourceControls, sourceFieldset } from "../sources.js";
import { MIN_SEGMENTS, SLIDER_STEPS, clampSegment, segmentFromSlider, sliderFromSegment, wholeSegments } from "./model.js";

const F_LO = 100; // Hz, the spectrograms' range
const F_HI = 8000;
const MARGIN = { left: 52, right: 10, top: 6, bottom: 20 };

export function createQuiltTab(root, { commit, openRecording, hasRecording, log }) {
  let state = null;
  let sound = null;
  let playhead = null;

  root.innerHTML = `
    <div class="quilt-body">
      <div class="paint-area">
        <section class="panel-box design-box">
          <h3 class="panel-group" title="The sound the quilt is made from">Source</h3>
          <div class="panel-stack">
            <canvas class="source-stft" title="The source's spectrogram (5 ms window) on a log-frequency axis, cut into its segments"></canvas>
          </div>
        </section>
        <section class="panel-box result-box">
          <h3 class="panel-group" title="What came out">Result</h3>
          <div class="panel-stack">
            <canvas class="quilt-stft" title="The quilt's spectrogram (5 ms window) on a log-frequency axis, with its joins"></canvas>
            <canvas class="wave" title="The quilt's waveform"></canvas>
            <p class="hint quilt-note"></p>
          </div>
        </section>
      </div>
      <aside class="side">
        ${sourceFieldset("The sound the quilt is made from")}
        <fieldset><legend>Quilt</legend>
          <label class="field knob" title="How long each segment is: short segments keep the sound's texture and lose its order; long ones keep words and rhythms whole"><span class="knob-name">Segment</span> <span class="unit">ms</span>
            <input type="range" class="segment" min="0" max="${SLIDER_STEPS}" step="1"></label>
          <label class="field" title="Which segment the quilt starts with; sonore chooses each next one from it">Seed <input type="number" class="seed" step="1"></label>
          <button type="button" class="reorder" title="Start from another segment, and hear the new order">New order</button>
        </fieldset>
        <p class="hint">Each segment is used at most once and never next to the one that followed it in the source. The segments are joined with 30 ms cross-fades. Space plays.</p>
      </aside>
    </div>`;
  const query = (selector) => root.querySelector(selector);
  const ui = {
    segment: query(".segment"), seed: query(".seed"), reorder: query(".reorder"), note: query(".quilt-note"),
    source: query("canvas.source-stft"), quilt: query("canvas.quilt-stft"), wave: query("canvas.wave"),
  };
  // typed in milliseconds
  const segmentBox = numberBox(ui.segment, {
    toBox: (position) => Math.round(1000 * segmentFromSlider(position)),
    fromBox: (ms) => sliderFromSegment(clampSegment(ms / 1000)),
    digits: 0,
  });
  segmentBox.box.min = 1000 * segmentFromSlider(0);
  segmentBox.box.max = 1000 * segmentFromSlider(SLIDER_STEPS);
  segmentBox.box.step = 1;
  ui.segment.previousElementSibling.before(segmentBox.box);

  const showSource = attachSourceControls(root, { state: () => state, commit, openRecording, hasRecording, log });

  function showSettings() {
    showSource();
    ui.segment.value = sliderFromSegment(state.segment);
    segmentBox.show();
    ui.seed.value = state.seed;
    showNote();
  }

  ui.segment.addEventListener("change", () => {
    const segment = segmentFromSlider(Number(ui.segment.value));
    if (segment !== state.segment) commit({ ...state, segment });
  });
  ui.seed.addEventListener("change", () => {
    const seed = Math.round(typedNumber(ui.seed.value, NaN));
    if (Number.isInteger(seed) && seed !== state.seed) commit({ ...state, seed });
    else ui.seed.value = state.seed;
  });
  ui.reorder.addEventListener("click", () => commit({ ...state, seed: state.seed + 1 }, { play: true }));

  // How many segments the source holds, and how many the quilt has, or why there is no quilt.
  function showNote() {
    const whole = wholeSegments(state);
    const ms = Math.round(1000 * state.segment);
    const cut = resultSegments();
    if (whole < MIN_SEGMENTS) {
      ui.note.textContent = `At ${state.duration} s the source holds ${whole} whole segment${whole === 1 ? "" : "s"} of ${ms} ms, and a quilt needs at least ${MIN_SEGMENTS}: shorten the segments or lengthen the duration.`;
    } else if (!cut) {
      ui.note.textContent = `The source holds ${whole} whole segments of ${ms} ms.`;
    } else {
      const silent = soundSeconds(sound) - cut.used * cut.length;
      ui.note.textContent = `The quilt is ${cut.used} of the source's ${cut.whole} segments${silent >= 0.0005 ? `; its last ${+silent.toFixed(3)} s are silent` : ""}.`;
    }
  }

  // --- the pictures ----------------------------------------------------------------

  const sourcePanel = logSpectrogramPlot(ui.source, MARGIN);
  const quiltPanel = logSpectrogramPlot(ui.quilt, MARGIN);

  // Lines up the plot every `segment` seconds, `count` segments from 0,
  // and the time past them shaded: what the quilt leaves out or leaves silent.
  function drawSegments(context, plot, segment, count) {
    context.save();
    context.strokeStyle = "rgba(255, 255, 255, 0.55)";
    context.lineWidth = 1;
    context.beginPath();
    for (let k = 1; k <= count; k++) {
      const x = Math.round(plot.x(k * segment)) + 0.5;
      if (x >= plot.x1) break;
      context.moveTo(x, plot.y0);
      context.lineTo(x, plot.y1);
    }
    context.stroke();
    const end = plot.x(count * segment);
    if (end < plot.x1) {
      context.fillStyle = "rgba(0, 0, 0, 0.55)";
      context.fillRect(end, plot.y0, plot.x1 - end, plot.y1 - plot.y0);
    }
    context.restore();
  }

  // The segments of the result shown: how long each is, how many the source
  // held and how many the quilt has (the result may be of an older segment
  // length while a newer one is being made).
  function resultSegments() {
    if (!sound?.segmentSeconds) return null;
    const whole = Math.floor(sound.samples.length / Math.round(sound.segmentSeconds * sound.fs));
    return { length: sound.segmentSeconds, whole, used: sound.segments };
  }

  function renderSource() {
    const context = sourcePanel.clear();
    if (!state) return;
    const plot = sourcePanel.geometry(F_LO, F_HI, sound ? soundSeconds(sound) : state.duration);
    const picture = sound?.sourceStft ?? null;
    const cut = resultSegments();
    sourcePanel.draw(context, plot, picture, { named: true });
    if (picture && cut) drawSegments(context, plot, cut.length, cut.whole);
    drawTitle(context, plot, picture && cut ? `The source: ${cut.whole} segments of ${+(1000 * cut.length).toFixed(1)} ms` : "The source: Play to hear it quilted");
  }

  function renderQuilt() {
    const context = quiltPanel.clear();
    if (!state) return;
    const plot = quiltPanel.geometry(F_LO, F_HI, sound ? soundSeconds(sound) : state.duration);
    quiltPanel.draw(context, plot, sound?.spectrogram, { named: true });
    const cut = resultSegments();
    if (cut) drawSegments(context, plot, cut.length, cut.used);
    if (playhead !== null) drawPlayhead(context, plot, plot.x(playhead), "#ffffff");
    drawTitle(context, plot, sound ? "The quilt: its segments, joined at the lines" : "The quilt: Play to make it");
  }

  function renderWave() {
    drawWaveform(ui.wave, sound, sound ? soundSeconds(sound) : state?.duration ?? 1);
  }

  new ResizeObserver(renderSource).observe(ui.source);
  new ResizeObserver(renderQuilt).observe(ui.quilt);
  new ResizeObserver(renderWave).observe(ui.wave);

  return {
    id: "quilt",
    figure: root.querySelector(".result-box .panel-stack"), // where the shell shows synthesis progress
    ownWaveform: true, // drawn in the Result box
    clearable: false, // nothing is drawn here
    setDocument(next) {
      state = next;
      showSettings();
      renderSource();
      renderQuilt();
    },
    setResult(next) {
      sound = next ?? null;
      showNote();
      renderSource();
      renderQuilt();
      renderWave();
    },
    setPlayhead(t) {
      playhead = t;
      renderQuilt();
    },
    blocked() {
      if (state.source === "file" && !state.recording) return "No recording: open an audio file (Source) to quilt.";
      if (wholeSegments(state) < MIN_SEGMENTS) return `Too few segments for a quilt: shorten the segments or lengthen the duration.`;
      return null;
    },
    key() {
      return false;
    },
  };
}
