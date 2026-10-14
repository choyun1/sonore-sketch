// Playback with Web Audio, and WAV export.
//
// sonore normalizes every sound to RMS 1, so the page scales each result to a
// peak of -1 dBFS before playing or saving it.

const PLAYBACK_PEAK = 10 ** (-1 / 20);

// The largest magnitude among `samples`.
export function absolutePeak(samples) {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  return peak;
}

export function toPlayback(samples) {
  const peak = absolutePeak(samples);
  const gain = peak > 0 ? PLAYBACK_PEAK / peak : 0;
  return samples.map((sample) => sample * gain);
}

export class Player {
  constructor() {
    this.context = null;
    this.source = null;
    this.onended = null;
  }

  play(samples, fs) {
    this.stop();
    // A context made inside a user gesture can play; later ones resume it.
    this.context ??= new AudioContext();
    if (this.context.state === "suspended") this.context.resume();
    const buffer = this.context.createBuffer(1, samples.length, fs);
    buffer.copyToChannel(toPlayback(samples), 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    source.onended = () => {
      if (this.source !== source) return; // stopped: stop() has said so
      this.source = null;
      this.onended?.();
    };
    source.start();
    this.source = source;
    this.startedAt = this.context.currentTime;
  }

  stop() {
    if (this.source) {
      const source = this.source;
      this.source = null;
      source.stop();
      this.onended?.();
    }
  }

  get playing() {
    return this.source !== null;
  }

  // Seconds into the sound that is playing, or null.
  get position() {
    return this.source ? this.context.currentTime - this.startedAt : null;
  }
}

// 16-bit PCM mono WAV of the playback-scaled samples.
export function wavBlob(samples, fs) {
  const scaled = toPlayback(samples);
  const view = new DataView(new ArrayBuffer(44 + 2 * scaled.length));
  const text = (offset, letters) => [...letters].forEach((letter, i) => view.setUint8(offset + i, letter.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + 2 * scaled.length, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, fs, true);
  view.setUint32(28, 2 * fs, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, 2 * scaled.length, true);
  scaled.forEach((sample, i) => view.setInt16(44 + 2 * i, Math.round(Math.max(-1, Math.min(1, sample)) * 32767), true));
  return new Blob([view], { type: "audio/wav" });
}
