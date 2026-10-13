// Where synthesis runs. "pyodide" (the default): sonore in a Web Worker in
// this browser. "local": tools/serve.py runs the same Python natively, for
// working offline or testing without the Pyodide CDN (?engine=local).
//
// Both resolve a request {tab, state} to
// {fs, samples: Float32Array, synthesisSeconds, spectrogram: {...}}, on the
// Draw modulation tab modulation: {...}, and on the Erase modulation tab
// modulation, sourceModulation: {...} (modulationPicture) and clipped (a
// fraction), and on the Erase spectrogram tab sourceStft, resultStft: {...}
// (spectrogramPicture).

function bytesFromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

class PyodideEngine {
  supersedes = true; // the worker drops an older request itself

  constructor({ onProgress, onReady, onFailed }) {
    const url = new URL("./worker.js", import.meta.url);
    const pyodide = new URLSearchParams(location.search).get("pyodide");
    if (pyodide) url.searchParams.set("pyodide", pyodide);
    this.worker = new Worker(url, { type: "module" });
    this.waiting = new Map();
    this.nextId = 0;
    this.worker.onmessage = ({ data }) => {
      if (data.type === "progress") return onProgress(data.text);
      if (data.type === "ready") return onReady(data.versions, `loaded in ${data.seconds} s: ${data.phases}`);
      if (data.type === "failed") {
        onFailed(data.message);
        for (const { reject } of this.waiting.values()) reject(new Error(data.message));
        this.waiting.clear();
        return;
      }
      const waiting = this.waiting.get(data.id);
      if (data.type === "step") return waiting.onStep?.(data.fraction);
      const { resolve, reject } = waiting;
      this.waiting.delete(data.id);
      if (data.type === "result") resolve(data.result);
      else if (data.type === "dropped") resolve(null);
      else reject(Object.assign(new Error(data.message), { detail: data.detail }));
    };
    this.worker.onerror = (event) => {
      const message = event.message ?? "the synthesis worker failed";
      onFailed(message);
      // nothing more will come back for the requests under way
      for (const { reject } of this.waiting.values()) reject(new Error(message));
      this.waiting.clear();
    };
  }

  // A newer request stops this one at its next step (it resolves to null),
  // and onStep(fraction) follows its progress.
  synthesize(request, onStep) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject, onStep });
      this.worker.postMessage({ id, request });
    });
  }
}

class LocalEngine {
  constructor({ onProgress, onReady, onFailed }) {
    onProgress("Connecting to the local server…");
    fetch("api/version")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then(({ versions }) => onReady(`${versions} (local server)`))
      .catch((error) => onFailed(`no local server (run python tools/serve.py): ${error.message}`));
  }

  async synthesize(request) {
    const response = await fetch("api/synthesize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error(body.error), { detail: body.detail });
    return {
      fs: body.fs,
      samples: new Float32Array(bytesFromBase64(body.samples).buffer),
      synthesisSeconds: body.synthesis_s,
      spectrogram: spectrogramPicture(body.spectrogram),
      sourceStft: body.source_stft && spectrogramPicture(body.source_stft),
      resultStft: body.result_stft && spectrogramPicture(body.result_stft),
      modulation: body.modulation && modulationPicture(body.modulation, bytesFromBase64(body.modulation.data)),
      sourceModulation: body.source_modulation && modulationPicture(body.source_modulation, bytesFromBase64(body.source_modulation.data)),
      clipped: body.clipped ?? null,
    };
  }
}

// A spectrogram picture (sonore_sketch.page.spectrogram, mask.pictures) from the local server.
function spectrogramPicture(picture) {
  return {
    data: bytesFromBase64(picture.data),
    nFreqs: picture.n_freqs,
    nFrames: picture.n_frames,
    fMax: picture.f_max,
    tStart: picture.t_start,
    tStep: picture.t_step,
  };
}

// A modulation spectrum on the plane: the Draw modulation tab's measured one
// (sonore_sketch.blobs.measured_picture), the Erase modulation tab's source
// (sonore_sketch.edit.plane_picture).
export function modulationPicture(picture, data) {
  return {
    data,
    nDensities: picture.n_densities,
    nRates: picture.n_rates,
    rateFirst: picture.rate_first,
    rateStep: picture.rate_step,
    densityStep: picture.density_step,
  };
}

export function createEngine(kind, callbacks) {
  return kind === "local" ? new LocalEngine(callbacks) : new PyodideEngine(callbacks);
}

// Only the newest request matters while one is running: older waiting ones
// resolve to null instead of being synthesized. The Pyodide engine goes
// further and stops the running one between steps; the local engine (one
// HTTP request each) finishes it, and gives no steps.
export class LatestOnly {
  constructor(engine) {
    this.engine = engine;
    this.running = false;
    this.pending = null;
  }

  synthesize(request, onStep) {
    if (this.engine.supersedes) return this.engine.synthesize(request, onStep);
    return new Promise((resolve, reject) => {
      this.pending?.resolve(null);
      this.pending = { request, resolve, reject };
      this.next();
    });
  }

  async next() {
    if (this.running || !this.pending) return;
    const { request, resolve, reject } = this.pending;
    this.pending = null;
    this.running = true;
    try {
      resolve(await this.engine.synthesize(request));
    } catch (error) {
      reject(error);
    } finally {
      this.running = false;
      this.next();
    }
  }
}
