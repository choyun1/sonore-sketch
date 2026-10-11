// The synthesis worker: Pyodide, sonore and sonore_sketch, off the page's
// thread so drawing never waits (docs/design/app.md, Architecture). A module
// worker, which loads Pyodide's ES module (pyodide.mjs) from its CDN, or from
// the folder named by ?pyodide=<URL> on the page.
//
// Messages in:  {id, request: {tab, state}}
// Messages out: {type: "progress", text} while loading,
//               {type: "ready", versions},
//               {id, type: "step", fraction} as synthesis goes (page.handle_steps),
//               {id, type: "result", result} or {id, type: "error", message, detail},
//               or {id, type: "dropped"} when a newer request arrived first.

const PYODIDE_VERSION = "314.0.7"; // what Cho measured on 2026-10-03 (tracks.md, M6)
const SONORE_VERSION = "0.6.0"; // keep in step with pyproject.toml (app.md, D5)
const PYTHON_FILES = ["__init__.py", "blobs.py", "edit.py", "mask.py", "page.py", "painted.py", "tracks.py"]; // every file in src/sonore_sketch (tests/test_page.py checks)

let steps = null;
let latest = -1; // the newest request's id: an older one stops at its next step

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
  let start = performance.now();
  const seconds = () => ((performance.now() - start) / 1000).toFixed(1);
  progress("Loading Python (Pyodide)…");
  const indexURL =
    new URL(self.location).searchParams.get("pyodide") ?? `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
  let loadPyodide;
  try {
    ({ loadPyodide } = await import(`${indexURL}pyodide.mjs`));
  } catch (error) {
    throw new Error(`could not load ${indexURL}pyodide.mjs (${await reachable(`${indexURL}pyodide.mjs`)}): ${error.message}`);
  }
  const pyodide = await loadPyodide({ indexURL });
  progress(`Installing sonore ${SONORE_VERSION} and NumPy/SciPy… (${seconds()} s)`);
  await pyodide.loadPackage("micropip");
  await pyodide.pyimport("micropip").install(`sonore==${SONORE_VERSION}`);
  const folder = "/home/pyodide/sonore_sketch";
  pyodide.FS.mkdirTree(folder);
  for (const name of PYTHON_FILES) {
    const response = await fetch(new URL(`../src/sonore_sketch/${name}`, self.location));
    if (!response.ok) throw new Error(`could not fetch sonore_sketch/${name}: HTTP ${response.status}`);
    pyodide.FS.writeFile(`${folder}/${name}`, await response.text());
  }
  progress(`Importing sonore… (${seconds()} s)`);
  steps = pyodide.runPython(`
import json, sys
sys.path.insert(0, "/home/pyodide")
from sonore_sketch.page import handle_steps
lambda text: handle_steps(json.loads(text))
`);
  const versions = pyodide.runPython("import sonore, sys; f'sonore {sonore.__version__}, Python {sys.version.split()[0]}'");
  postMessage({ type: "ready", versions: `${versions}, Pyodide ${pyodide.version}`, seconds: Number(seconds()) });
}

// A modulation spectrum picture (blobs.measured_picture, edit.plane_picture), or null.
function modulationPicture(result, key) {
  if (!result.has(key)) return null;
  const picture = result.get(key);
  try {
    return {
      data: toBytes(picture.get("data")),
      nDensities: picture.get("n_densities"),
      nRates: picture.get("n_rates"),
      rateFirst: picture.get("rate_first"),
      rateStep: picture.get("rate_step"),
      densityStep: picture.get("density_step"),
    };
  } finally {
    picture.destroy();
  }
}

// A spectrogram picture (page.spectrogram, mask.pictures), or null.
function spectrogramPicture(result, key) {
  if (!result.has(key)) return null;
  const picture = result.get(key);
  try {
    return {
      data: toBytes(picture.get("data")),
      nFreqs: picture.get("n_freqs"),
      nFrames: picture.get("n_frames"),
      fMax: picture.get("f_max"),
      tStart: picture.get("t_start"),
      tStep: picture.get("t_step"),
    };
  } finally {
    picture.destroy();
  }
}

function convert(result) {
  try {
    return {
      fs: result.get("fs"),
      samples: new Float32Array(toBytes(result.get("samples")).buffer),
      synthesisSeconds: result.get("synthesis_s"),
      spectrogram: spectrogramPicture(result, "spectrogram"),
      sourceStft: spectrogramPicture(result, "source_stft"),
      resultStft: spectrogramPicture(result, "result_stft"),
      modulation: modulationPicture(result, "modulation"),
      sourceModulation: modulationPicture(result, "source_modulation"),
      clipped: result.has("clipped") ? result.get("clipped") : null,
    };
  } finally {
    result.destroy();
  }
}

const loading = load().catch((error) => {
  postMessage({ type: "failed", message: String(error?.message ?? error) });
  throw error;
});

// Python runs one step at a time, and between steps the worker lets other
// messages in, so a newer drawing stops this one instead of waiting for it.
const between = () => new Promise((resolve) => setTimeout(resolve, 0));

onmessage = async ({ data: { id, request } }) => {
  latest = id;
  let work = null;
  try {
    await loading;
    if (id !== latest) return postMessage({ id, type: "dropped" });
    work = steps(JSON.stringify(request));
    let result;
    for (;;) {
      const step = work.next();
      if (step.done) {
        result = convert(step.value); // destroys the Python result
        break;
      }
      postMessage({ id, type: "step", fraction: step.value });
      await between();
      if (id !== latest) return postMessage({ id, type: "dropped" });
    }
    const transfer = [result.samples.buffer, result.spectrogram.data.buffer];
    for (const picture of [result.modulation, result.sourceModulation, result.sourceStft, result.resultStft]) if (picture) transfer.push(picture.data.buffer);
    postMessage({ id, type: "result", result }, transfer);
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
