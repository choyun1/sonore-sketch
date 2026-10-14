// Where synthesis runs. "pyodide" (the default): sonore in a Web Worker in
// this browser. "local": tools/serve.py runs the same Python natively, for
// working offline or testing without the Pyodide CDN (?engine=local).
//
// Both resolve a request {tab, state} to
// {fs, samples: Float32Array, synthesisSeconds, spectrogram: {...}}, on the
// Draw modulation tab modulation: {...}, and on the Erase modulation tab
// modulation, sourceModulation: {...} (modulationPicture) and clipped (a
// fraction), and on the Erase spectrogram tab sourceStft, resultStft: {...}
// (spectrogramPicture; both in pictures.js).

import { modulationPicture, spectrogramPicture } from "./pictures.js";

function bytesFromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

class PyodideEngine {
  supersedes = true; // the worker drops an older request itself

  constructor({ onProgress, onReady, onFailed }) {
    const url = new URL("./worker.js", import.meta.url);
    // ?pyodide=<URL> loads Pyodide from elsewhere, for testing; only on this
    // machine, so that a shared link cannot make the page run someone's script
    const pyodide = new URLSearchParams(location.search).get("pyodide");
    if (pyodide && LOCAL_HOSTS.includes(location.hostname)) url.searchParams.set("pyodide", pyodide);
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
      if (!waiting) return; // a request already settled, as when a failure cleared them all
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
    return readResult(body);
  }
}

// page.handle's result as JSON (tools/serve.py, encode): from the local
// server, or made ahead of time (tools/make_examples.py).
export function readResult(body) {
  return {
    fs: body.fs,
    samples: new Float32Array(bytesFromBase64(body.samples).buffer),
    synthesisSeconds: body.synthesis_s,
    spectrogram: readPicture(body.spectrogram, spectrogramPicture),
    sourceStft: body.source_stft && readPicture(body.source_stft, spectrogramPicture),
    resultStft: body.result_stft && readPicture(body.result_stft, spectrogramPicture),
    modulation: body.modulation && readPicture(body.modulation, modulationPicture),
    sourceModulation: body.source_modulation && readPicture(body.source_modulation, modulationPicture),
    clipped: body.clipped ?? null,
  };
}

// A picture from the local server, as `make` (pictures.js) reads it.
function readPicture(picture, make) {
  return make((field) => picture[field], bytesFromBase64(picture.data));
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
