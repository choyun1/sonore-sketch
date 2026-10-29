// The synthesis worker: Pyodide, sonore and sonore_sketch, off the page's
// thread so drawing never waits (docs/design/app.md, Architecture). A module
// worker, which loads Pyodide's ES module (pyodide.mjs) from its CDN, or from
// the folder named by ?pyodide=<URL> on the page (served locally only; engine.js).
//
// Messages in:  {id, request: {tab, state}},
//               or for a recording's live picture (streaming.md, L6) {live: "start", fs},
//               {live: "block", samples: Float32Array} and {live: "stop"}
// Messages out: {type: "progress", text} while loading,
//               {type: "ready", versions},
//               {id, type: "step", fraction, text} as synthesis goes (page.handle_steps:
//               the fraction done and what it does next),
//               {id, type: "sound", result} on the tabs whose pictures take a while
//               (page.MEASURED_AFTER): the sound alone, before the result (streaming.md, L4),
//               {id, type: "result", result} or {id, type: "error", message, detail},
//               or {id, type: "dropped"} when a newer request arrived first;
//               {type: "live", columns} as a recording's picture grows (live.py),
//               or {type: "live-error", message}.

import { modulationPicture, modulationSpectrogramPicture, spectrogramPicture } from "./pictures.js";

const PYODIDE_VERSION = "314.0.7"; // what Cho measured on 2026-10-03 (draw_speech.md, M6)
const SONORE_VERSION = "0.10.0"; // keep in step with pyproject.toml (app.md, D5)
// The wheel's file on PyPI (from https://pypi.org/project/sonore/<version>/#files),
// which is fetched directly: PyPI's by-name address redirects without the
// header that lets a page fetch it. Change it with SONORE_VERSION (tests/test_page.py checks).
const SONORE_WHEEL =
  "https://files.pythonhosted.org/packages/0d/10/9d50bd3aad1e80c2df8d58ae9c2bc3bf6c3faf9671bfe6a6eaa9cca87171/sonore-0.10.0-py3-none-any.whl";
// The package's modules are listed in src/sonore_sketch/files.json (tests/test_page.py
// checks it), fetched with the modules rather than written here: just after a
// deploy the browser can still run its kept copy of this file, and an old list
// here would leave a new module out of the new package.
const PYTHON_FILES = "files.json";

let steps = null;
let python = null; // the Pyodide instance, once loaded
const FOLDER = "/home/pyodide/sonore_sketch";
// The Draw path tab's HRIRs (src/sonore_sketch/data/mit_kemar.npz, 1.25 MB),
// fetched the first time that tab asks for a sound, not on every visit.
const HRIR_FILE = "data/mit_kemar.npz";
let hrirs = null;
let latest = -1; // the newest request's id: an older one stops at its next step
let LiveSpectrogram = null; // live.py's class, once Python has loaded
let live = null; // the recording's LiveSpectrogram while one is being made

function progress(text) {
  postMessage({ type: "progress", text });
}

// bytes from Python as a Uint8Array the worker owns, so it can be transferred.
function toBytes(proxy) {
  try {
    const view = proxy.toJs();
    if (ArrayBuffer.isView(view)) return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
    const buffer = proxy.getBuffer("u8");
    try {
      return new Uint8Array(buffer.data);
    } finally {
      buffer.release();
    }
  } finally {
    proxy.destroy();
  }
}

// Why a URL could not be loaded, as far as fetch can tell.
async function reachable(url) {
  try {
    const response = await fetch(url, { method: "HEAD" });
    return response.ok ? "it is reachable, so the failure is in the script" : `HTTP ${response.status}`;
  } catch (error) {
    return `network error: ${error.message}`;
  }
}

async function load() {
  const start = performance.now();
  let mark = start;
  const seconds = (from = start) => ((performance.now() - from) / 1000).toFixed(1);
  const phases = []; // how long each part took, for the Log
  const phase = (name) => {
    phases.push(`${name} ${seconds(mark)} s`);
    mark = performance.now();
  };
  progress("Loading Python (Pyodide)…");
  // sonore_sketch's own files, fetched while Pyodide loads. "no-cache" asks the
  // server whether each file changed (a 304 when not) rather than using a copy
  // the browser kept: GitHub Pages lets browsers keep files for 10 minutes, so
  // just after a deploy the page's new JavaScript could run old Python.
  const fetchSource = async (name) => {
    const response = await fetch(new URL(`../src/sonore_sketch/${name}`, self.location), { cache: "no-cache" });
    if (!response.ok) throw new Error(`could not fetch sonore_sketch/${name}: HTTP ${response.status}`);
    return response.text();
  };
  const sources = fetchSource(PYTHON_FILES).then((text) =>
    Promise.all(JSON.parse(text).map(async (name) => [name, await fetchSource(name)])),
  );
  sources.catch(() => {}); // awaited below; this only stops an early failure being reported as unhandled
  const indexURL =
    new URL(self.location).searchParams.get("pyodide") ?? `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
  let loadPyodide;
  try {
    ({ loadPyodide } = await import(`${indexURL}pyodide.mjs`));
  } catch (error) {
    throw new Error(`could not load ${indexURL}pyodide.mjs (${await reachable(`${indexURL}pyodide.mjs`)}): ${error.message}`);
  }
  const pyodide = await loadPyodide({ indexURL });
  phase("Pyodide");
  progress(`Loading NumPy, SciPy and sonore ${SONORE_VERSION}… (${seconds()} s)`);
  // Only what the page imports, in one call so the downloads run side by side.
  // micropip would also install sonore's matplotlib and soundfile (and their
  // pillow, fonttools, cffi, ...), which sonore imports only for plotting and
  // files: unpacking those and compiling their WebAssembly happens on every
  // visit, cached or not.
  const problems = [];
  await pyodide.loadPackage(["numpy", "scipy", SONORE_WHEEL], { errorCallback: (text) => problems.push(text) });
  if (problems.length) throw new Error(`could not load the packages: ${problems.join("; ")}`);
  phase("packages");
  pyodide.FS.mkdirTree(FOLDER);
  for (const [name, text] of await sources) pyodide.FS.writeFile(`${FOLDER}/${name}`, text);
  python = pyodide;
  progress(`Importing sonore… (${seconds()} s)`);
  steps = pyodide.runPython(`
import json, sys
sys.path.insert(0, "/home/pyodide")
from sonore_sketch.page import handle_steps
lambda text: handle_steps(json.loads(text))
`);
  LiveSpectrogram = pyodide.runPython("from sonore_sketch.live import LiveSpectrogram\nLiveSpectrogram");
  const versions = pyodide.runPython("import sonore, sys; f'sonore {sonore.__version__}, Python {sys.version.split()[0]}'");
  phase("import");
  postMessage({
    type: "ready",
    versions: `${versions}, Pyodide ${pyodide.version}`,
    seconds: Number(seconds()),
    phases: phases.join(", "),
  });
}

function loadHrirs() {
  hrirs ??= (async () => {
    const url = new URL(`../src/sonore_sketch/${HRIR_FILE}`, self.location);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`could not fetch the HRIRs (sonore_sketch/${HRIR_FILE}): HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    python.FS.mkdirTree(`${FOLDER}/data`);
    python.FS.writeFile(`${FOLDER}/${HRIR_FILE}`, bytes);
  })().catch((error) => {
    hrirs = null; // the next request tries again
    throw error;
  });
  return hrirs;
}

// A picture in `result` under `key`, as `make` (pictures.js) reads it, or null.
function readPicture(result, key, make) {
  if (!result.has(key)) return null;
  const proxy = result.get(key);
  try {
    return make((field) => proxy.get(field), toBytes(proxy.get("data")));
  } finally {
    proxy.destroy();
  }
}

// A list (or a dict, as an object) in `result` under `key`, copied out, or null.
function readList(result, key) {
  if (!result.has(key)) return null;
  const proxy = result.get(key);
  try {
    return proxy.toJs({ dict_converter: Object.fromEntries });
  } finally {
    proxy.destroy();
  }
}

function convert(result) {
  try {
    return {
      fs: result.get("fs"),
      samples: new Float32Array(toBytes(result.get("samples")).buffer),
      right: result.has("samples_right") ? new Float32Array(toBytes(result.get("samples_right")).buffer) : null,
      synthesisSeconds: result.get("synthesis_s"),
      spectrogram: readPicture(result, "spectrogram", spectrogramPicture),
      sourceStft: readPicture(result, "source_stft", spectrogramPicture),
      resultStft: readPicture(result, "result_stft", spectrogramPicture),
      modulation: readPicture(result, "modulation", modulationPicture),
      sourceModulation: readPicture(result, "source_modulation", modulationPicture),
      clipped: result.has("clipped") ? result.get("clipped") : null,
      segments: result.has("segments") ? result.get("segments") : null,
      segmentSeconds: result.has("segment_s") ? result.get("segment_s") : null,
      match: readList(result, "match"),
      imposed: readList(result, "imposed"),
      voice: readList(result, "voice"),
      roomStft: readPicture(result, "room_stft", spectrogramPicture),
      measured: readList(result, "measured"),
      modulationFrames: readPicture(result, "modulation_frames", modulationSpectrogramPicture),
      modulationPooled: readPicture(result, "modulation_pooled", modulationSpectrogramPicture),
    };
  } finally {
    result.destroy();
  }
}

// The buffers a converted result can hand over to the page without copying.
function transfers(result) {
  const transfer = [result.samples.buffer, result.spectrogram.data.buffer];
  if (result.right) transfer.push(result.right.buffer);
  for (const picture of [result.modulation, result.sourceModulation, result.sourceStft, result.resultStft, result.modulationFrames, result.modulationPooled, result.roomStft]) if (picture) transfer.push(picture.data.buffer);
  return transfer;
}

const loading = load().catch((error) => {
  postMessage({ type: "failed", message: String(error?.message ?? error) });
  throw error;
});

// Python runs one step at a time, and between steps the worker lets other
// messages in, so a newer drawing stops this one instead of waiting for it.
const between = () => new Promise((resolve) => setTimeout(resolve, 0));

// A recording's picture, block by block. Blocks that come while Python
// loads wait for it, in order; then the picture catches up.
async function onLive({ live: what, fs, samples }) {
  try {
    await loading;
    if (what === "start") {
      live?.destroy();
      live = LiveSpectrogram(fs);
      return;
    }
    if (!live) return;
    const columns = what === "block" ? live.step(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)) : live.finish();
    if (columns) {
      const picture = readColumns(columns);
      postMessage({ type: "live", columns: picture }, [picture.data.buffer]);
    }
    if (what === "stop") {
      live.destroy();
      live = null;
    }
  } catch (error) {
    live?.destroy();
    live = null;
    const lines = String(error?.message ?? error).trim().split("\n");
    postMessage({ type: "live-error", message: lines[lines.length - 1] });
  }
}

// live.py's columns, copied out of Python (and the dict destroyed).
function readColumns(columns) {
  try {
    const field = (name) => columns.get(name);
    return {
      data: toBytes(field("data")),
      nFreqs: field("n_freqs"),
      nWindows: field("n_windows"),
      first: field("first"),
      fMax: field("f_max"),
      tStep: field("t_step"),
    };
  } finally {
    columns.destroy();
  }
}

onmessage = async ({ data }) => {
  if (data.live) return onLive(data);
  const { id, request } = data;
  latest = id;
  let work = null;
  try {
    await loading;
    if (request.tab === "draw_path") await loadHrirs();
    if (id !== latest) return postMessage({ id, type: "dropped" });
    work = steps(JSON.stringify(request));
    let result;
    for (;;) {
      const step = work.next();
      if (step.done) {
        result = convert(step.value); // destroys the Python result
        break;
      }
      // a Python (fraction, text) tuple, or (fraction, text, the result so far) once the sound is made
      const [fraction, text] = [step.value.get(0), step.value.get(1)];
      const sound = step.value.length === 3 ? convert(step.value.get(2)) : null; // convert destroys the Python dict
      step.value.destroy();
      postMessage({ id, type: "step", fraction, text });
      if (sound) postMessage({ id, type: "sound", result: sound }, transfers(sound));
      await between();
      if (id !== latest) return postMessage({ id, type: "dropped" });
    }
    postMessage({ id, type: "result", result }, transfers(result));
  } catch (error) {
    // A PythonError's message is the traceback, ending with the exception's
    // own line: that line is the message, the whole traceback the detail.
    const full = String(error?.message ?? error).trim();
    const lines = full.split("\n");
    postMessage({ id, type: "error", message: lines[lines.length - 1], detail: full });
  } finally {
    work?.destroy();
  }
};
