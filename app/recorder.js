// Recording from the microphone (docs/design/streaming.md, L6): Web Audio
// takes the microphone's samples at its own rate; they are gathered into
// blocks of about 50 ms for the live picture (onBlock), and at the end
// resampled to the page's rate.

const BLOCK_S = 0.05;

// Starts recording at once (the browser asks for the microphone first).
// onBlock(samples, fs) gets each block as it is recorded; recording stops
// by itself after maxSeconds (onEnd). Resolves to {stop(), fs, seconds()}:
// stop() resolves to the whole recording's mono samples at the microphone's
// rate `fs`.
export async function recordMicrophone({ maxSeconds, onBlock, onEnd }) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("this browser cannot record");
  // the raw sound: no echo cancellation, noise suppression or level control
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const context = new AudioContext();
  try {
    await context.audioWorklet.addModule(new URL("./recorder-worklet.js", import.meta.url));
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    context.close();
    throw error;
  }
  const fs = context.sampleRate;
  const maxLength = Math.round(maxSeconds * fs);
  const blockLength = Math.round(BLOCK_S * fs);
  const parts = [];
  let length = 0;
  let pending = [];
  let pendingLength = 0;
  let stopped = null;

  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, "recorder");
  node.port.onmessage = ({ data }) => {
    if (stopped) return;
    const take = data.subarray(0, Math.max(0, maxLength - length));
    if (!take.length) return;
    parts.push(take);
    length += take.length;
    pending.push(take);
    pendingLength += take.length;
    if (pendingLength >= blockLength) flush();
    if (length >= maxLength) onEnd?.();
  };
  source.connect(node);
  // silent, but on the way to the speakers, so every browser keeps it running
  const mute = context.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(context.destination);

  function flush() {
    if (!pendingLength) return;
    onBlock?.(join(pending, pendingLength), fs);
    pending = [];
    pendingLength = 0;
  }

  return {
    fs,
    seconds: () => length / fs,
    stop() {
      stopped ??= (async () => {
        flush();
        source.disconnect();
        node.port.onmessage = null;
        stream.getTracks().forEach((track) => track.stop());
        await context.close();
        return join(parts, length);
      })();
      return stopped;
    },
  };
}

function join(parts, length) {
  const out = new Float32Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// Mono samples at `from` Hz, at `to` Hz (the browser resamples).
export async function resample(samples, from, to) {
  if (from === to || !samples.length) return samples;
  const length = Math.max(1, Math.round((samples.length * to) / from));
  const offline = new OfflineAudioContext(1, length, to);
  const buffer = offline.createBuffer(1, samples.length, from);
  buffer.copyToChannel(samples, 0);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  return (await offline.startRendering()).getChannelData(0);
}
