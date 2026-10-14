// The Draw speech tab: draw F1-F5, FNZ, F0, AV, AF, AH and B1-B5 over time and hear the
// Klatt speech they describe (docs/design/tabs/tracks.md).
//
// One panel per kind of track, all on the same time axis. The selected track
// is the one that is edited (D10); clicking another track's line or its
// button selects it. Tools: Point (add or drag a breakpoint; double-click
// removes one), Line (press at one end, release at the other) and Freehand
// (a stroke, simplified to the fewest breakpoints within a tolerance).

import { drawSpectrogram, niceStep } from "../plot.js";
import {
  TRACKS,
  clampValue,
  drawnPoints,
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
  { id: "formants", label: "Formants", tracks: ["F1", "F2", "F3", "F4", "F5", "FNZ"], ticks: [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000], format: (v) => `${v / 1000}k` },
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
  ...Object.fromEntries([1, 2, 3, 4, 5].flatMap((k) => [[`Digit${k}`, `F${k}`], [`Numpad${k}`, `F${k}`]])),
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

export function createTracksTab(root, { commit }) {
  let doc = null;
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
  const valueFor = (name, v) => clampValue(name, panelOf(name) === "formants" ? Math.min(v, formantTop) : v);
  // Whether F1-F5 are drawn over the spectrogram. Also only a view: hidden
  // formants still shape the sound, since Klatt's voice is made of them.
  let showFormants = true;

  root.innerHTML = `
    <div class="tracks-body">
      <div class="panels"></div>
      <aside class="side">
        <fieldset class="tool-group"><legend>Tool</legend></fieldset>
        <fieldset class="track-group"><legend>Track</legend></fieldset>
        <label class="check" title="Show F1–F5 over the spectrogram; hidden, they still shape the sound"><input type="checkbox" class="show-formants" checked> Show formant tracks</label>
        <label class="check"><input type="checkbox" class="show-bandwidths"> Bandwidths</label>
        <fieldset class="formant-top-group" title="How high the formants and the spectrogram under them reach; /s/ hisses mostly above 4 kHz"><legend>Formants up to</legend>
          <label class="choice"><input type="radio" name="tracks-formant-top" value="4000"> 4 kHz</label>
          <label class="choice"><input type="radio" name="tracks-formant-top" value="5000"> 5 kHz</label>
          <label class="choice"><input type="radio" name="tracks-formant-top" value="8000"> 8 kHz</label>
        </fieldset>
        <fieldset class="f0-scale-group" title="How the F0 strip spaces its frequencies"><legend>F0 axis</legend>
          <label class="choice"><input type="radio" name="tracks-f0-scale" value="log"> Log (octaves)</label>
          <label class="choice"><input type="radio" name="tracks-f0-scale" value="linear"> Linear</label>
        </fieldset>
        <p class="hint">Space plays. 1–5 select F1–F5, 0 or \` selects F0. V, S, H and Z select AV, AF, AH and FNZ. Ctrl+Z undoes. AF and AH are the noises for consonants; FNZ, raised, makes /n/ or /m/.</p>
      </aside>
    </div>`;
  const panelsNode = root.querySelector(".panels");
  const toolGroup = root.querySelector(".tool-group");
  const trackGroup = root.querySelector(".track-group");
  const showBandwidths = root.querySelector(".show-bandwidths");
  const showFormantsBox = root.querySelector(".show-formants");
  for (const input of root.querySelectorAll('input[name="tracks-f0-scale"]')) {
    input.checked = input.value === f0Scale;
    input.addEventListener("change", () => {
      f0Scale = input.value;
      try {
        localStorage.setItem("sonore-sketch.f0-scale", f0Scale);
      } catch {}
      render();
    });
  }

  for (const input of root.querySelectorAll('input[name="tracks-formant-top"]')) {
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
    node.innerHTML = `<input type="radio" name="tracks-tool" value="${id}"> ${label} <kbd>${key.toUpperCase()}</kbd>`;
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
      const kbd = document.createElement("kbd");
      kbd.textContent = TRACK_KEY_LABELS[name];
      button.append(" ", kbd);
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
    panels.find((p) => p.id === "bandwidths").node.hidden = !showBandwidths.checked;
    render();
  });
  panels.find((p) => p.id === "bandwidths").node.hidden = true;

  function select(name) {
    selected = name;
    if (/^F[1-5]$/.test(name)) bandwidth = `B${name[1]}`;
    if (/^B[1-5]$/.test(name)) bandwidth = name;
    // Choosing a formant to edit brings the formants back into view.
    if (/^F([1-5]|NZ)$/.test(name) && !showFormants) setShowFormants(true);
    else render();
  }

  // Panel geometry, in the SVG's own pixels.
  function geometry(panel) {
    const width = panel.svg.clientWidth || 600;
    const height = panel.svg.clientHeight || 100;
    const name = trackList(panel)[0];
    const scale = scaleOf(name);
    const { min } = trackSpec(name, scale);
    const max = panel.id === "formants" ? formantTop : trackSpec(name, scale).max;
    // Positions go by the panel's scale: octaves on a log one.
    const [lo, hi] = [toScale(name, min, scale), toScale(name, max, scale)];
    const x0 = MARGIN.left;
    const x1 = width - MARGIN.right;
    const y0 = MARGIN.top;
    const y1 = height - MARGIN.bottom;
    return {
      width, height, x0, x1, y0, y1, min, max,
      x: (t) => x0 + (t / doc.duration) * (x1 - x0),
      y: (v) => y1 - ((toScale(name, v, scale) - lo) / (hi - lo)) * (y1 - y0),
      t: (x) => Math.min(doc.duration, Math.max(0, ((x - x0) / (x1 - x0)) * doc.duration)),
      v: (y) => fromScale(name, lo + ((y1 - y) / (y1 - y0)) * (hi - lo), scale),
    };
  }

  function renderPanel(panel) {
    if (panel.node.hidden || !doc) return;
    const g = geometry(panel);
    const svg = panel.svg;
    svg.setAttribute("viewBox", `0 0 ${g.width} ${g.height}`);
    svg.replaceChildren();
    const grid = element("g", { class: "grid" }, svg);
    const ticks = panel.linearTicks && trackSpec(trackList(panel)[0], scaleOf(trackList(panel)[0])).scale === "linear" ? panel.linearTicks : panel.ticks;
    for (const tick of ticks) {
      if (tick > g.max) continue;
      element("line", { x1: g.x0, x2: g.x1, y1: g.y(tick), y2: g.y(tick) }, grid);
      const label = element("text", { x: g.x0 - 6, y: g.y(tick), class: "tick" }, grid);
      label.textContent = panel.format ? panel.format(tick) : tick;
    }
    const step = niceStep(doc.duration, g.x1 - g.x0);
    for (let t = 0; t <= doc.duration + 1e-9; t += step) {
      element("line", { x1: g.x(t), x2: g.x(t), y1: g.y0, y2: g.y1, class: "time" }, grid);
    }
    const title = element("text", { x: g.x0 + 6, y: g.y0 + 3, class: "panel-title" }, svg);
    title.textContent = panel.id === "bandwidths" ? `${bandwidth} (Hz)` : panel.label;

    const names = shownTracks(panel);
    // The selected track last, so it is drawn on top.
    for (const name of [...names.filter((n) => n !== selected), ...names.filter((n) => n === selected)]) {
      const pts = points(doc, name);
      const isSelected = name === selected;
      const ends = [[0, pts[0][1]], ...pts, [doc.duration, pts[pts.length - 1][1]]];
      const group = element("g", { class: `track${isSelected ? " selected" : ""}`, style: `--track: ${TRACKS[name].color}; --track-bright: ${TRACKS[name].bright ?? TRACKS[name].color}` }, svg);
      element("polyline", { points: drawnPoints(name, ends, scaleOf(name)).map(([t, v]) => `${g.x(t)},${g.y(v)}`).join(" ") }, group);
      if (names.length > 1) {
        const label = element("text", { x: g.x1 - 4, y: g.y(pts[pts.length - 1][1]) - 5, class: "track-label" }, group);
        label.textContent = name;
      }
      if (isSelected) {
        for (const [t, v] of pts) element("circle", { cx: g.x(t), cy: g.y(v), r: 4 }, group);
      }
    }
    if (gesture?.panel === panel && gesture.preview) {
      element("polyline", { class: "preview", points: gesture.preview.map(([t, v]) => `${g.x(t)},${g.y(v)}`).join(" ") }, svg);
    }
    if (playhead !== null) {
      element("line", { class: "playhead", x1: g.x(playhead), x2: g.x(playhead), y1: g.y0, y2: g.y1 }, svg);
    }
  }

  function renderBackground() {
    const panel = panels[0];
    if (!doc) return;
    const g = geometry(panel);
    const canvas = panel.canvas;
    // The canvas covers the plotting area only.
    Object.assign(canvas.style, { left: `${g.x0}px`, top: `${g.y0}px`, width: `${g.x1 - g.x0}px`, height: `${g.y1 - g.y0}px` });
    drawSpectrogram(canvas, picture, doc.duration, g.max);
    panel.node.classList.toggle("on-spectrogram", Boolean(picture));
  }

  function renderAxis() {
    if (!doc) return;
    const width = axis.clientWidth || 600;
    const x0 = MARGIN.left;
    const x1 = width - MARGIN.right;
    axis.setAttribute("viewBox", `0 0 ${width} 18`);
    axis.replaceChildren();
    // labels at least 44 px apart, so a phone's narrow axis does not run them together
    const step = niceStep(doc.duration, x1 - x0);
    for (let t = 0; t <= doc.duration + 1e-9; t += step) {
      const label = element("text", { x: x0 + (t / doc.duration) * (x1 - x0), y: 12 }, axis);
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
    const local = (event) => {
      const box = svg.getBoundingClientRect();
      return [event.clientX - box.left, event.clientY - box.top];
    };
    // The selected track's breakpoint whose circle is under (px, py), or -1.
    const circleAt = (px, py) => {
      if (!shownTracks(panel).includes(selected)) return -1;
      const g = geometry(panel);
      let best = -1;
      let nearest = HIT_PX;
      points(doc, selected).forEach(([t, v], i) => {
        const d = Math.hypot(g.x(t) - px, g.y(v) - py);
        if (d <= nearest) {
          best = i;
          nearest = d;
        }
      });
      return best;
    };

    svg.addEventListener("pointerdown", (event) => {
      const names = shownTracks(panel);
      if (!doc || event.button > 0 || !names.length) return;
      const g = geometry(panel);
      const [px, py] = local(event);
      const t = g.t(px);
      const distance = (name) => Math.abs(g.y(valueAt(points(doc, name), t)) - py);
      if (!names.includes(selected)) {
        // Pressing in another panel selects its track; in a strip of one
        // track, drawing starts at once.
        const nearest = names.reduce((a, b) => (distance(a) <= distance(b) ? a : b));
        select(nearest);
        if (names.length > 1) return;
      } else if (names.length > 1 && distance(selected) > SELECT_PX) {
        const other = names.find((n) => n !== selected && distance(n) <= SELECT_PX);
        if (other) return select(other);
      }
      event.preventDefault();
      svg.setPointerCapture(event.pointerId);
      const name = selected;
      const v = valueFor(name, g.v(py));
      const pts = points(doc, name);
      const start = doc;
      // Point grabs the breakpoint under the press, or nearest in time, or
      // adds one. With Line or Freehand a press on a circle waits to see the
      // first movement: mostly up or down drags the breakpoint, mostly along
      // time draws from it as usual.
      const onCircle = circleAt(px, py);
      if (tool !== "point" && onCircle >= 0) {
        gesture = { panel, name, start, kind: "undecided", index: onCircle, at: [px, py], from: [t, v] };
      } else if (tool === "point") {
        let index = onCircle >= 0 ? onCircle : nearestPoint(pts, t, (GRAB_PX / (g.x1 - g.x0)) * doc.duration);
        let current = pts;
        if (index < 0) ({ pts: current, index } = insertPoint(pts, t, v));
        gesture = { panel, name, start, kind: "point", index, base: current };
        doc = withPoints(doc, name, current);
      } else if (tool === "line") {
        gesture = { panel, name, start, kind: "line", from: [t, v], preview: [[t, v], [t, v]] };
      } else {
        gesture = { panel, name, start, kind: "freehand", stroke: [[t, v]], preview: [[t, v]] };
      }
      renderPanel(panel);
    });

    svg.addEventListener("pointermove", (event) => {
      if (!gesture) svg.classList.toggle("over-point", circleAt(...local(event)) >= 0);
      if (!gesture || gesture.panel !== panel) return;
      const g = geometry(panel);
      const moves = event.getCoalescedEvents?.() ?? [event];
      for (const move of moves.length ? moves : [event]) {
        const [px, py] = local(move);
        const t = g.t(px);
        const v = valueFor(gesture.name, g.v(py));
        if (gesture.kind === "undecided") {
          const dx = Math.abs(px - gesture.at[0]);
          const dy = Math.abs(py - gesture.at[1]);
          if (Math.max(dx, dy) < DECIDE_PX) continue;
          const { from } = gesture;
          if (dy >= dx) gesture = { ...gesture, kind: "point", base: points(doc, gesture.name) };
          else if (tool === "line") gesture = { ...gesture, kind: "line", preview: [from, from] };
          else gesture = { ...gesture, kind: "freehand", stroke: [from], preview: [from] };
        }
        if (gesture.kind === "point") {
          doc = withPoints(doc, gesture.name, movePoint(gesture.base, gesture.index, t, v));
        } else if (gesture.kind === "line") {
          gesture.preview = [gesture.from, [t, v]];
        } else {
          gesture.stroke.push([t, v]);
          gesture.preview = gesture.stroke;
        }
      }
      renderPanel(panel);
    });

    const finish = (event) => {
      if (!gesture || gesture.panel !== panel) return;
      const { name, start, kind } = gesture;
      const pts = points(doc, name);
      if (kind === "line") {
        const [a, b] = gesture.preview;
        const span = Math.abs(geometry(panel).x(b[0]) - geometry(panel).x(a[0])) < 3 && Math.abs(a[1] - b[1]) < 1e-9 ? [a] : lineSpan(name, a, b, scaleOf(name));
        doc = withPoints(doc, name, span.length === 1 ? insertPoint(pts, ...span[0]).pts : replaceSpan(pts, span));
      } else if (kind === "freehand") {
        const simplified = simplifyStroke(name, gesture.stroke, scaleOf(name));
        doc = withPoints(doc, name, simplified.length === 1 ? insertPoint(pts, ...simplified[0]).pts : replaceSpan(pts, simplified));
      }
      gesture = null;
      if (event.type === "pointercancel") doc = start;
      renderPanel(panel);
      if (JSON.stringify(doc.params[name]) !== JSON.stringify(start.params[name])) commit((doc = name === "AF" ? withFrication(doc) : doc));
      else doc = start;
    };
    svg.addEventListener("pointerup", finish);
    svg.addEventListener("pointercancel", finish);

    svg.addEventListener("dblclick", (event) => {
      if (!doc || tool !== "point" || !shownTracks(panel).includes(selected)) return;
      const g = geometry(panel);
      const [px] = local(event);
      const pts = points(doc, selected);
      const index = nearestPoint(pts, g.t(px), (GRAB_PX / (g.x1 - g.x0)) * doc.duration);
      if (index >= 0 && pts.length > 1) commit((doc = withPoints(doc, selected, removePoint(pts, index))));
      render();
    });
  }

  new ResizeObserver(() => {
    render();
    renderBackground();
  }).observe(panelsNode);

  return {
    id: "tracks",
    figure: panels[0].node, // the formants panel: where the shell shows synthesis progress
    setDocument(next) {
      gesture = null;
      doc = next;
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
      const toolKey = TOOLS.find((t) => t.key === event.key.toLowerCase());
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

