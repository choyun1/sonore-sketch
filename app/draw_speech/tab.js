// The Draw speech tab: draw F1-F5, FNZ, F0, AV, AF, AH and B1-B5 over time and hear the
// Klatt speech they describe (docs/design/tabs/draw_speech.md).
//
// One panel per kind of track, all on the same time axis. The selected track
// is the one that is edited (D10); clicking another track's line or its
// button selects it. Tools: Point (add or drag a breakpoint; double-click
// removes one), Line (press at one end, release at the other) and Freehand
// (a stroke, simplified to the fewest breakpoints within a tolerance).

import { drawSpectrogram, niceStep, pointerPosition } from "../plot.js";
import {
  TRACKS,
  clampValue,
  drawnPoints,
  extendStroke,
  fromScale,
  insertPoint,
  lineSpan,
  movePoint,
  nearestPoint,
  points,
  removePoint,
  replaceSpan,
  simplifyStroke,
  toScale,
  trackSpec,
  valueAt,
  withFrication,
  withPoints,
} from "./model.js";

const SVG = "http://www.w3.org/2000/svg";
const MARGIN = { left: 52, right: 10, top: 8, bottom: 8 };
const GRAB_PX = 9; // a press this close in time to a breakpoint grabs it (Point tool)
const HIT_PX = 10; // a press this close to a breakpoint's circle grabs it, whatever the tool
const DECIDE_PX = 4; // with Line or Freehand, how far a press on a circle moves before it counts
const SELECT_PX = 7; // a press this close to another track's line selects it

const PANELS = [
  { id: "formants", label: "Formants", tracks: ["F1", "F2", "F3", "F4", "F5", "FNZ"], ticks: [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000], format: (hertz) => `${hertz / 1000}k` },
  { id: "F0", label: "F0 (Hz)", tracks: ["F0"], ticks: [25, 50, 100, 200, 400, 800], linearTicks: [0, 200, 400, 600, 800] },
  { id: "AV", label: "AV (dB)", tracks: ["AV"], ticks: [0, 20, 40, 60, 80] },
  { id: "noise", label: "Noise (dB)", tracks: ["AF", "AH"], ticks: [0, 20, 40, 60, 80] },
  { id: "bandwidths", label: "Bandwidth (Hz)", tracks: [], ticks: [0, 200, 400, 600] },
];

const TOOLS = [
  { id: "point", label: "Point", key: "p", title: "Add or drag a breakpoint; double-click one to remove it (P)" },
  { id: "line", label: "Line", key: "l", title: "Press at one end, release at the other (L)" },
  { id: "freehand", label: "Freehand", key: "f", title: "Draw a stroke; it becomes the fewest breakpoints that follow it (F)" },
];

// Keys that select a track, matched by physical key (event.code) so they
// sit in the same place whatever the layout: on AZERTY the digits need no
// Shift this way. F0 has 0 and also the key left of 1 (` on US layouts).
const TRACK_KEYS = {
  ...Object.fromEntries([1, 2, 3, 4, 5].flatMap((number) => [[`Digit${number}`, `F${number}`], [`Numpad${number}`, `F${number}`]])),
  Digit0: "F0", Numpad0: "F0", Backquote: "F0",
};
// The other tracks have letters under the left hand, matched by the letter
// typed, like the tools': V for voicing, S for the hiss of /s/ (frication),
// H for the breath of /h/ (aspiration) and Z for the nasal zero.
const TRACK_LETTERS = { v: "AV", s: "AF", h: "AH", z: "FNZ" };
// The key shown on each track's button, and the fuller list in its tooltip.
const TRACK_KEY_LABELS = {
  F1: "1", F2: "2", F3: "3", F4: "4", F5: "5", F0: "0",
  ...Object.fromEntries(Object.entries(TRACK_LETTERS).map(([key, name]) => [name, key.toUpperCase()])),
};
const TRACK_KEY_TITLES = { ...TRACK_KEY_LABELS, F0: "0 or `" };

function element(name, attributes = {}, parent = null) {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  parent?.appendChild(node);
  return node;
}

export function createDrawSpeechTab(root, { commit }) {
  let drawing = null;
  let selected = "F2";
  let tool = "point";
  let picture = null;
  let playhead = null;
  let gesture = null;
  // How the F0 strip is spaced: a viewing choice, remembered in this browser
  // but not part of the drawing.
  let f0Scale = "log";
  try {
    if (localStorage.getItem("sonore-sketch.f0-scale") === "linear") f0Scale = "linear";
  } catch {}
  const scaleOf = (name) => (name === "F0" ? f0Scale : undefined);
  // How high the formants panel (and the spectrogram under it) reaches: 4 kHz
  // gives F1-F3 the most room, 5 kHz takes in F4 and F5, and 8 kHz shows the
  // hiss of /s/. Also only a view, remembered in this browser.
  const FORMANT_TOPS = [4000, 5000, 8000];
  let formantTop = 5000;
  try {
    const stored = Number(localStorage.getItem("sonore-sketch.formant-top"));
    if (FORMANT_TOPS.includes(stored)) formantTop = stored;
  } catch {}
  const panelOf = (name) => TRACKS[name].panel;
  // A value drawn at a pointer, kept inside what its panel shows.
  const valueFor = (name, value) => clampValue(name, panelOf(name) === "formants" ? Math.min(value, formantTop) : value);
  // Whether F1-F5 are drawn over the spectrogram. Also only a view: hidden
  // formants still shape the sound, since Klatt's voice is made of them.
  let showFormants = true;

  root.innerHTML = `
    <div class="draw-speech-body">
      <div class="panels"></div>
      <aside class="side">
        <fieldset class="tool-group"><legend>Tool</legend></fieldset>
        <fieldset class="track-group"><legend>Track</legend></fieldset>
        <label class="check" title="Show F1–F5 over the spectrogram; hidden, they still shape the sound"><input type="checkbox" class="show-formants" checked> Show formant tracks</label>
        <label class="check"><input type="checkbox" class="show-bandwidths"> Bandwidths</label>
        <fieldset class="formant-top-group" title="How high the formants and the spectrogram under them reach; /s/ hisses mostly above 4 kHz"><legend>Formants up to</legend>
          <label class="choice"><input type="radio" name="draw-speech-formant-top" value="4000"> 4 kHz</label>
          <label class="choice"><input type="radio" name="draw-speech-formant-top" value="5000"> 5 kHz</label>
          <label class="choice"><input type="radio" name="draw-speech-formant-top" value="8000"> 8 kHz</label>
        </fieldset>
        <fieldset class="f0-scale-group" title="How the F0 strip spaces its frequencies"><legend>F0 axis</legend>
          <label class="choice"><input type="radio" name="draw-speech-f0-scale" value="log"> Log (octaves)</label>
          <label class="choice"><input type="radio" name="draw-speech-f0-scale" value="linear"> Linear</label>
        </fieldset>
        <p class="hint">Space plays. 1–5 select F1–F5, 0 or \` selects F0. V, S, H and Z select AV, AF, AH and FNZ. Ctrl+Z undoes. AF and AH are the noises for consonants; FNZ, raised, makes /n/ or /m/.</p>
      </aside>
    </div>`;
  const panelsNode = root.querySelector(".panels");
  const toolGroup = root.querySelector(".tool-group");
  const trackGroup = root.querySelector(".track-group");
  const showBandwidths = root.querySelector(".show-bandwidths");
  const showFormantsBox = root.querySelector(".show-formants");
  for (const input of root.querySelectorAll('input[name="draw-speech-f0-scale"]')) {
    input.checked = input.value === f0Scale;
    input.addEventListener("change", () => {
      f0Scale = input.value;
      try {
        localStorage.setItem("sonore-sketch.f0-scale", f0Scale);
      } catch {}
      render();
    });
  }

  for (const input of root.querySelectorAll('input[name="draw-speech-formant-top"]')) {
    input.checked = Number(input.value) === formantTop;
    input.addEventListener("change", () => {
      formantTop = Number(input.value);
      try {
        localStorage.setItem("sonore-sketch.formant-top", input.value);
      } catch {}
      render();
      renderBackground();
    });
  }

  for (const { id, label, key, title } of TOOLS) {
    const node = document.createElement("label");
    node.className = "choice";
    node.title = title;
    node.innerHTML = `<input type="radio" name="draw-speech-tool" value="${id}"> ${label} <kbd>${key.toUpperCase()}</kbd>`;
    node.querySelector("input").checked = id === tool;
    node.querySelector("input").addEventListener("change", () => (tool = id));
    toolGroup.appendChild(node);
  }
  const trackButtons = {};
  const TRACK_TITLES = {
    AV: "Voicing level",
    AF: "Frication: hiss through the high formants, as in /s/",
    AH: "Aspiration: breath through the formants, as in /h/",
    FNZ: "Nasal zero: raise it above 250 Hz for /n/ or /m/",
  };
  for (const name of ["F1", "F2", "F3", "F4", "F5", "F0", "AV", "AF", "AH", "FNZ"]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = name;
    if (TRACK_KEY_LABELS[name]) {
      const keyLabel = document.createElement("kbd");
      keyLabel.textContent = TRACK_KEY_LABELS[name];
      button.append(" ", keyLabel);
      button.title = `Select ${name} (${TRACK_KEY_TITLES[name]})`;
    }
    if (TRACK_TITLES[name]) button.title = `${TRACK_TITLES[name]} (${TRACK_KEY_TITLES[name]})`;
    button.style.setProperty("--track", TRACKS[name].color);
    button.style.setProperty("--track-bright", TRACKS[name].bright ?? TRACKS[name].color);
    // The selected button is dark, so its label needs a light color: F0 and AV have none of their own.
    button.style.setProperty("--track-active", TRACKS[name].bright ?? "#fff");
    button.addEventListener("click", () => select(name));
    trackGroup.appendChild(button);
    trackButtons[name] = button;
  }

  const panels = PANELS.map((spec) => {
    const node = document.createElement("div");
    node.className = `panel panel-${spec.id}`;
    node.innerHTML = `<canvas class="background"></canvas>`;
    const svg = element("svg", { class: "surface" }, node);
    panelsNode.appendChild(node);
    const panel = { ...spec, node, svg, canvas: node.querySelector("canvas") };
    attachPointer(panel);
    return panel;
  });
  const axis = element("svg", { class: "time-axis" });
  panelsNode.appendChild(axis);

  // Bandwidths show one at a time: that of the selected formant, else the last.
  let bandwidth = "B2";
  function trackList(panel) {
    return panel.id === "bandwidths" ? [bandwidth] : panel.tracks;
  }
  // The tracks drawn (and pressable) in a panel: none of F1-F5 while hidden.
  function shownTracks(panel) {
    return panel.id === "formants" && !showFormants ? [] : trackList(panel);
  }

  function setShowFormants(on) {
    showFormants = on;
    showFormantsBox.checked = on;
    panels[0].node.classList.toggle("formants-hidden", !on);
    render();
  }
  showFormantsBox.addEventListener("change", () => setShowFormants(showFormantsBox.checked));

  showBandwidths.addEventListener("change", () => {
    panels.find((panel) => panel.id === "bandwidths").node.hidden = !showBandwidths.checked;
    render();
  });
  panels.find((panel) => panel.id === "bandwidths").node.hidden = true;

  function select(name) {
    selected = name;
    if (/^F[1-5]$/.test(name)) bandwidth = `B${name[1]}`;
    if (/^B[1-5]$/.test(name)) bandwidth = name;
    // Choosing a formant to edit brings the formants back into view.
    if (/^F([1-5]|NZ)$/.test(name) && !showFormants) setShowFormants(true);
    else render();
  }

  // Panel geometry, in the SVG's own pixels: the plot from x0 to x1 and y0
  // to y1, and pixels to and from time and the panel's track values.
  function geometry(panel) {
    const width = panel.svg.clientWidth || 600;
    const height = panel.svg.clientHeight || 100;
    const name = trackList(panel)[0];
    const scale = scaleOf(name);
    const { min } = trackSpec(name, scale);
    const max = panel.id === "formants" ? formantTop : trackSpec(name, scale).max;
    // Positions go by the panel's scale: octaves on a log one.
    const [scaledMin, scaledMax] = [toScale(name, min, scale), toScale(name, max, scale)];
    const x0 = MARGIN.left;
    const x1 = width - MARGIN.right;
    const y0 = MARGIN.top;
    const y1 = height - MARGIN.bottom;
    return {
      width, height, x0, x1, y0, y1, min, max,
      x: (t) => x0 + (t / drawing.duration) * (x1 - x0),
      y: (value) => y1 - ((toScale(name, value, scale) - scaledMin) / (scaledMax - scaledMin)) * (y1 - y0),
      t: (x) => Math.min(drawing.duration, Math.max(0, ((x - x0) / (x1 - x0)) * drawing.duration)),
      value: (y) => fromScale(name, scaledMin + ((y1 - y) / (y1 - y0)) * (scaledMax - scaledMin), scale),
    };
  }

  function renderPanel(panel) {
    if (panel.node.hidden || !drawing) return;
    const plot = geometry(panel);
    const svg = panel.svg;
    svg.setAttribute("viewBox", `0 0 ${plot.width} ${plot.height}`);
    svg.replaceChildren();
    const grid = element("g", { class: "grid" }, svg);
    const ticks = panel.linearTicks && trackSpec(trackList(panel)[0], scaleOf(trackList(panel)[0])).scale === "linear" ? panel.linearTicks : panel.ticks;
    for (const tick of ticks) {
      if (tick > plot.max) continue;
      element("line", { x1: plot.x0, x2: plot.x1, y1: plot.y(tick), y2: plot.y(tick) }, grid);
      const label = element("text", { x: plot.x0 - 6, y: plot.y(tick), class: "tick" }, grid);
      label.textContent = panel.format ? panel.format(tick) : tick;
    }
    const step = niceStep(drawing.duration, plot.x1 - plot.x0);
    for (let t = 0; t <= drawing.duration + 1e-9; t += step) {
      element("line", { x1: plot.x(t), x2: plot.x(t), y1: plot.y0, y2: plot.y1, class: "time" }, grid);
    }
    const title = element("text", { x: plot.x0 + 6, y: plot.y0 + 3, class: "panel-title" }, svg);
    title.textContent = panel.id === "bandwidths" ? `${bandwidth} (Hz)` : panel.label;

    const names = shownTracks(panel);
    // The selected track last, so it is drawn on top.
    for (const name of [...names.filter((other) => other !== selected), ...names.filter((other) => other === selected)]) {
      const breakpoints = points(drawing, name);
      const isSelected = name === selected;
      const ends = [[0, breakpoints[0][1]], ...breakpoints, [drawing.duration, breakpoints[breakpoints.length - 1][1]]];
      const group = element("g", { class: `track${isSelected ? " selected" : ""}`, style: `--track: ${TRACKS[name].color}; --track-bright: ${TRACKS[name].bright ?? TRACKS[name].color}` }, svg);
      element("polyline", { points: drawnPoints(name, ends, scaleOf(name)).map(([t, value]) => `${plot.x(t)},${plot.y(value)}`).join(" ") }, group);
      if (names.length > 1) {
        const label = element("text", { x: plot.x1 - 4, y: plot.y(breakpoints[breakpoints.length - 1][1]) - 5, class: "track-label" }, group);
        label.textContent = name;
      }
      if (isSelected) {
        for (const [t, value] of breakpoints) element("circle", { cx: plot.x(t), cy: plot.y(value), r: 4 }, group);
      }
    }
    if (gesture?.panel === panel && gesture.preview) {
      element("polyline", { class: "preview", points: gesture.preview.map(([t, value]) => `${plot.x(t)},${plot.y(value)}`).join(" ") }, svg);
    }
    if (playhead !== null) {
      element("line", { class: "playhead", x1: plot.x(playhead), x2: plot.x(playhead), y1: plot.y0, y2: plot.y1 }, svg);
    }
  }

  function renderBackground() {
    const panel = panels[0];
    if (!drawing) return;
    const plot = geometry(panel);
    const canvas = panel.canvas;
    // The canvas covers the plotting area only.
    Object.assign(canvas.style, { left: `${plot.x0}px`, top: `${plot.y0}px`, width: `${plot.x1 - plot.x0}px`, height: `${plot.y1 - plot.y0}px` });
    drawSpectrogram(canvas, picture, drawing.duration, plot.max);
    panel.node.classList.toggle("on-spectrogram", Boolean(picture));
  }

  function renderAxis() {
    if (!drawing) return;
    const width = axis.clientWidth || 600;
    const x0 = MARGIN.left;
    const x1 = width - MARGIN.right;
    axis.setAttribute("viewBox", `0 0 ${width} 18`);
    axis.replaceChildren();
    // labels at least 44 px apart, so a phone's narrow axis does not run them together
    const step = niceStep(drawing.duration, x1 - x0);
    for (let t = 0; t <= drawing.duration + 1e-9; t += step) {
      const label = element("text", { x: x0 + (t / drawing.duration) * (x1 - x0), y: 12 }, axis);
      label.textContent = Number(t.toFixed(2));
    }
    const unit = element("text", { x: x0 - 16, y: 12, class: "unit" }, axis);
    unit.textContent = "s";
  }

  function render() {
    for (const [name, button] of Object.entries(trackButtons)) button.classList.toggle("active", name === selected);
    panels.forEach(renderPanel);
    renderAxis();
  }

  // --- drawing ---------------------------------------------------------------

  function attachPointer(panel) {
    const svg = panel.svg;
    const local = (event) => pointerPosition(svg, event);
    // The selected track's breakpoint whose circle is under (pointerX, pointerY), or -1.
    const circleAt = (pointerX, pointerY) => {
      if (!shownTracks(panel).includes(selected)) return -1;
      const plot = geometry(panel);
      let best = -1;
      let nearest = HIT_PX;
      points(drawing, selected).forEach(([t, value], i) => {
        const distance = Math.hypot(plot.x(t) - pointerX, plot.y(value) - pointerY);
        if (distance <= nearest) {
          best = i;
          nearest = distance;
        }
      });
      return best;
    };

    svg.addEventListener("pointerdown", (event) => {
      const names = shownTracks(panel);
      if (!drawing || event.button > 0 || !names.length) return;
      const plot = geometry(panel);
      const [pointerX, pointerY] = local(event);
      const t = plot.t(pointerX);
      const distance = (name) => Math.abs(plot.y(valueAt(points(drawing, name), t)) - pointerY);
      if (!names.includes(selected)) {
        // Pressing in another panel selects its track; in a strip of one
        // track, drawing starts at once.
        const nearest = names.reduce((nearer, other) => (distance(nearer) <= distance(other) ? nearer : other));
        select(nearest);
        if (names.length > 1) return;
      } else if (names.length > 1 && distance(selected) > SELECT_PX) {
        const other = names.find((candidate) => candidate !== selected && distance(candidate) <= SELECT_PX);
        if (other) return select(other);
      }
      event.preventDefault();
      svg.setPointerCapture(event.pointerId);
      const name = selected;
      const value = valueFor(name, plot.value(pointerY));
      const breakpoints = points(drawing, name);
      const start = drawing;
      // Point grabs the breakpoint under the press, or nearest in time, or
      // adds one. With Line or Freehand a press on a circle waits to see the
      // first movement: mostly up or down drags the breakpoint, mostly along
      // time draws from it as usual.
      const onCircle = circleAt(pointerX, pointerY);
      if (tool !== "point" && onCircle >= 0) {
        gesture = { panel, name, start, kind: "undecided", index: onCircle, at: [pointerX, pointerY], from: [t, value] };
      } else if (tool === "point") {
        let index = onCircle >= 0 ? onCircle : nearestPoint(breakpoints, t, (GRAB_PX / (plot.x1 - plot.x0)) * drawing.duration);
        let current = breakpoints;
        if (index < 0) ({ breakpoints: current, index } = insertPoint(breakpoints, t, value));
        gesture = { panel, name, start, kind: "point", index, base: current };
        drawing = withPoints(drawing, name, current);
      } else if (tool === "line") {
        gesture = { panel, name, start, kind: "line", from: [t, value], preview: [[t, value], [t, value]] };
      } else {
        gesture = { panel, name, start, kind: "freehand", stroke: [[t, value]], preview: [[t, value]] };
      }
      renderPanel(panel);
    });

    svg.addEventListener("pointermove", (event) => {
      if (!gesture) svg.classList.toggle("over-point", circleAt(...local(event)) >= 0);
      if (!gesture || gesture.panel !== panel) return;
      const plot = geometry(panel);
      const moves = event.getCoalescedEvents?.() ?? [event];
      for (const move of moves.length ? moves : [event]) {
        const [pointerX, pointerY] = local(move);
        const t = plot.t(pointerX);
        const value = valueFor(gesture.name, plot.value(pointerY));
        if (gesture.kind === "undecided") {
          const movedX = Math.abs(pointerX - gesture.at[0]);
          const movedY = Math.abs(pointerY - gesture.at[1]);
          if (Math.max(movedX, movedY) < DECIDE_PX) continue;
          const { from } = gesture;
          if (movedY >= movedX) gesture = { ...gesture, kind: "point", base: points(drawing, gesture.name) };
          else if (tool === "line") gesture = { ...gesture, kind: "line", preview: [from, from] };
          else gesture = { ...gesture, kind: "freehand", stroke: [from], preview: [from] };
        }
        if (gesture.kind === "point") {
          drawing = withPoints(drawing, gesture.name, movePoint(gesture.base, gesture.index, t, value));
        } else if (gesture.kind === "line") {
          gesture.preview = [gesture.from, [t, value]];
        } else {
          extendStroke(gesture.stroke, [t, value]);
          gesture.preview = gesture.stroke;
        }
      }
      renderPanel(panel);
    });

    const finish = (event) => {
      if (!gesture || gesture.panel !== panel) return;
      const { name, start, kind } = gesture;
      const breakpoints = points(drawing, name);
      if (kind === "line") {
        const [from, to] = gesture.preview;
        const span = Math.abs(geometry(panel).x(to[0]) - geometry(panel).x(from[0])) < 3 && Math.abs(from[1] - to[1]) < 1e-9 ? [from] : lineSpan(name, from, to, scaleOf(name));
        drawing = withPoints(drawing, name, span.length === 1 ? insertPoint(breakpoints, ...span[0]).breakpoints : replaceSpan(breakpoints, span));
      } else if (kind === "freehand") {
        const simplified = simplifyStroke(name, gesture.stroke, scaleOf(name));
        drawing = withPoints(drawing, name, simplified.length === 1 ? insertPoint(breakpoints, ...simplified[0]).breakpoints : replaceSpan(breakpoints, simplified));
      }
      gesture = null;
      if (event.type === "pointercancel") drawing = start;
      renderPanel(panel);
      if (JSON.stringify(drawing.params[name]) !== JSON.stringify(start.params[name])) commit((drawing = name === "AF" ? withFrication(drawing) : drawing));
      else drawing = start;
    };
    svg.addEventListener("pointerup", finish);
    svg.addEventListener("pointercancel", finish);

    svg.addEventListener("dblclick", (event) => {
      if (!drawing || tool !== "point" || !shownTracks(panel).includes(selected)) return;
      const plot = geometry(panel);
      const [pointerX] = local(event);
      const breakpoints = points(drawing, selected);
      const index = nearestPoint(breakpoints, plot.t(pointerX), (GRAB_PX / (plot.x1 - plot.x0)) * drawing.duration);
      if (index >= 0 && breakpoints.length > 1) commit((drawing = withPoints(drawing, selected, removePoint(breakpoints, index))));
      render();
    });
  }

  new ResizeObserver(() => {
    render();
    renderBackground();
  }).observe(panelsNode);

  return {
    id: "draw_speech",
    figure: panels[0].node, // the formants panel: where the shell shows synthesis progress
    setDocument(next) {
      gesture = null;
      drawing = next;
      render();
      renderBackground();
    },
    setResult(result) {
      picture = result?.spectrogram ?? null;
      renderBackground();
    },
    setPlayhead(t) {
      playhead = t;
      render();
    },
    key(event) {
      const toolKey = TOOLS.find((entry) => entry.key === event.key.toLowerCase());
      if (toolKey) {
        tool = toolKey.id;
        toolGroup.querySelector(`input[value="${tool}"]`).checked = true;
        return true;
      }
      if (TRACK_KEYS[event.code]) {
        select(TRACK_KEYS[event.code]);
        return true;
      }
      const letter = TRACK_LETTERS[event.key.toLowerCase()];
      if (letter) {
        select(letter);
        return true;
      }
      return false;
    },
  };
}

