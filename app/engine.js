// Where synthesis runs. By default: the synthesis server (SYNTH_SERVER,
// server/synth_server.py), which answers at once, and sonore in a Web Worker
// in this browser (Pyodide), started only if the server cannot be reached,
// since it takes several seconds to load on every visit (docs/design/app.md,
// M1). "pyodide": only the browser (?engine=pyodide). "local": tools/serve.py
// runs the same Python natively, for working offline or testing without the
// Pyodide CDN (?engine=local).
//
// All resolve a request {tab, state} to
// {fs, samples: Float32Array, right: Float32Array or null (the right ear, on
// the Draw path tab, when samples is the left), synthesisSeconds, spectrogram: {...}}, on the
// Draw modulation tab modulation: {...}, and on the Erase modulation tab
// modulation, sourceModulation: {...} (modulationPicture) and clipped (a
// fraction), on the Scatter events tab modulationFrames, modulationPooled: {...}
// (modulationSpectrogramPicture),
// on the Erase spectrogram tab sourceStft, resultStft: {...}
// (spectrogramPicture; both in pictures.js), and on the Quilt a sound tab
// sourceStft, segments (how many the quilt has) and segmentSeconds (each one's length),
// and on the Match a texture tab sourceStft, match (dB per class of statistics,
// match_texture/model.js BARS) and imposed (whether each was).

import { modulationPicture, modulationSpectrogramPicture, spectrogramPicture } from "./pictures.js";

function bytesFromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

// The synthesis server's address (server/README.md), or "" for none: then
// the page loads Pyodide at once, as before there was a server.
export const SYNTH_SERVER = "";

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
      if (data.type === "step") return waiting.onStep?.(data.fraction, data.text);
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
  // and onStep(fraction, text) follows its progress: the fraction done and
  // what it does next.
  synthesize(request, onStep) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject, onStep });
      this.worker.postMessage({ id, request });
    });
  }
}

// A server answering page.handle's requests over HTTP: tools/serve.py for
// ?engine=local, or the synthesis server. A failure to reach it, or a server
// too busy to answer (429, 502-504), is marked `unavailable`.
class ServerEngine {
  constructor(base) {
    this.base = base;
  }

  async fetch(path, options = {}) {
    let response;
    try {
      response = await fetch(new URL(path, this.base), { ...options, signal: AbortSignal.timeout(options.timeout ?? 30_000) });
    } catch (error) {
      throw Object.assign(new Error(`could not reach ${this.base}: ${error.message}`), { unavailable: true });
    }
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    if (!response.ok) {
      const unavailable = [429, 502, 503, 504].includes(response.status);
      throw Object.assign(new Error(body.error ?? `HTTP ${response.status}`), { detail: body.detail, unavailable });
    }
    return body;
  }

  async version(timeout) {
    return (await this.fetch("api/version", { timeout })).versions;
  }

  async synthesize(request) {
    const body = await this.fetch("api/synthesize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    return readResult(body);
  }
}

class LocalEngine extends ServerEngine {
  constructor({ onProgress, onReady, onFailed }) {
    super(new URL("./", location.href));
    onProgress("Connecting to the local server…");
    this.version()
      .then((versions) => onReady(`${versions} (local server)`))
      .catch((error) => onFailed(`no local server (run python tools/serve.py): ${error.message}`));
  }
}

// The synthesis server while it answers; Pyodide, loaded only once it does not.
class FallbackEngine {
  constructor(base, callbacks) {
    this.callbacks = callbacks;
    this.server = new ServerEngine(base);
    this.pyodide = null;
    callbacks.onProgress("Connecting to the synthesis server…");
    this.server
      .version(5_000)
      .then((versions) => callbacks.onReady(`${versions} (synthesis server)`, `server: ${base}`))
      .catch((error) => this.fallBack(error));
  }

  get supersedes() {
    return this.pyodide !== null;
  }

  fallBack(error) {
    if (this.pyodide) return;
    this.callbacks.onProgress(`The synthesis server is unavailable (${error.message}); loading Python in the browser instead…`);
    this.pyodide = new PyodideEngine(this.callbacks);
  }

  async synthesize(request, onStep) {
    if (!this.pyodide) {
      try {
        return await this.server.synthesize(request);
      } catch (error) {
        if (!error.unavailable) throw error;
        this.fallBack(error);
      }
    }
    return this.pyodide.synthesize(request, onStep); // the worker waits until Pyodide has loaded
  }
}

// page.handle's result as JSON (tools/serve.py, encode): from the local
// server, or made ahead of time (tools/make_examples.py).
export function readResult(body) {
  return {
    fs: body.fs,
    samples: new Float32Array(bytesFromBase64(body.samples).buffer),
    right: body.samples_right ? new Float32Array(bytesFromBase64(body.samples_right).buffer) : null,
    synthesisSeconds: body.synthesis_s,
    spectrogram: readPicture(body.spectrogram, spectrogramPicture),
    sourceStft: body.source_stft && readPicture(body.source_stft, spectrogramPicture),
    resultStft: body.result_stft && readPicture(body.result_stft, spectrogramPicture),
    modulation: body.modulation && readPicture(body.modulation, modulationPicture),
    sourceModulation: body.source_modulation && readPicture(body.source_modulation, modulationPicture),
    clipped: body.clipped ?? null,
    segments: body.segments ?? null,
    segmentSeconds: body.segment_s ?? null,
    match: body.match ?? null,
    imposed: body.imposed ?? null,
    modulationFrames: body.modulation_frames && readPicture(body.modulation_frames, modulationSpectrogramPicture),
    modulationPooled: body.modulation_pooled && readPicture(body.modulation_pooled, modulationSpectrogramPicture),
  };
}

// A picture from the local server, as `make` (pictures.js) reads it.
function readPicture(picture, make) {
  return make((field) => picture[field], bytesFromBase64(picture.data));
}

export function createEngine(kind, callbacks) {
  if (kind === "local") return new LocalEngine(callbacks);
  // ?server=<URL> tries another synthesis server, for testing; only on this machine, as ?pyodide=
  const asked = new URLSearchParams(location.search).get("server");
  const server = asked && LOCAL_HOSTS.includes(location.hostname) ? asked : SYNTH_SERVER;
  return kind === "pyodide" || !server ? new PyodideEngine(callbacks) : new FallbackEngine(server, callbacks);
}

// Only the newest request matters while one is running: older waiting ones
// resolve to null instead of being synthesized. The Pyodide engine goes
// further and stops the running one between steps; a server (one HTTP
// request each) finishes it, and gives no steps.
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
