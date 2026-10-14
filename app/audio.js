// Playback with Web Audio, and WAV export.
//
// sonore normalizes every sound to RMS 1, so the page scales each result to a
// peak of -1 dBFS before playing or saving it. A sound with a right channel
// (the Draw path tab's, one channel per ear) plays and saves in stereo, both
// channels scaled by the same gain so the difference between the ears stays.

const PLAYBACK_PEAK = 10 ** (-1 / 20);

// The largest magnitude among `samples`.
export function absolutePeak(samples) {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  return peak;
}

// The channels (the samples, and the right ear's if any) at one gain, to a peak of -1 dBFS.
export function toPlayback(samples, right = null) {
  const peak = Math.max(absolutePeak(samples), right ? absolutePeak(right) : 0);
  const gain = peak > 0 ? PLAYBACK_PEAK / peak : 0;
  const scaled = samples.map((sample) => sample * gain);
  return right ? [scaled, right.map((sample) => sample * gain)] : scaled;
}

export class Player {
  constructor() {
    this.context = null;
    this.source = null;
    this.onended = null;
  }

  play(samples, fs, right = null) {
    this.stop();
    // A context made inside a user gesture can play; later ones resume it.
    this.context ??= new AudioContext();
    if (this.context.state === "suspended") this.context.resume();
    const buffer = this.context.createBuffer(right ? 2 : 1, samples.length, fs);
    const channels = right ? toPlayback(samples, right) : [toPlayback(samples)];
    channels.forEach((channel, i) => buffer.copyToChannel(channel, i));
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

// 16-bit PCM WAV of the playback-scaled samples: mono, or stereo with `right`.
export function wavBlob(samples, fs, right = null) {
  const channels = right ? toPlayback(samples, right) : [toPlayback(samples)];
  const n = channels.length;
  const scaled = new Float32Array(n * samples.length); // interleaved
  channels.forEach((channel, c) => channel.forEach((sample, i) => (scaled[i * n + c] = sample)));
  const view = new DataView(new ArrayBuffer(44 + 2 * scaled.length));
  const text = (offset, letters) => [...letters].forEach((letter, i) => view.setUint8(offset + i, letter.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + 2 * scaled.length, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, n, true);
  view.setUint32(24, fs, true);
  view.setUint32(28, 2 * n * fs, true);
  view.setUint16(32, 2 * n, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, 2 * scaled.length, true);
  scaled.forEach((sample, i) => view.setInt16(44 + 2 * i, Math.round(Math.max(-1, Math.min(1, sample)) * 32767), true));
  return new Blob([view], { type: "audio/wav" });
}
