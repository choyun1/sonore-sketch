// The sounds the Erase tabs erase from, and the recording the page holds
// (docs/design/tabs/erase_modulation.md, E1, after the Erase spectrogram design's F1,
// F3, F6). Both Erase tabs take the same sources and share the page's
// recording, so their Source controls are made here too.
//
// Nothing here touches the DOM or Web Audio until it is called, so this file
// runs under `node --test`.

import { absolutePeak } from "./audio.js";
import { magma } from "./colormap.js";
import { recordMicrophone, resample } from "./recorder.js";

export const SOURCES = ["syllables", "draw_speech", "file"];
// The order every Source list keeps (Cho, 2026-10-17): sounds made here
// first, then the tabs' sounds in the order of the tabs, then a file last.
export const SOURCE_LABELS = { syllables: "Syllable train", draw_speech: "Draw speech tab's sound", file: "From a file…" };
export const MAX_RECORDING_S = 30; // F6: a recording sets the duration, up to the page's limit

// --- recordings --------------------------------------------------------------------

// Mono samples (any range) as 16-bit PCM in base64, scaled so the peak is
// just under full scale; what a page document keeps of a recording.
export function encodePcm16(samples) {
  const peak = absolutePeak(samples);
  const scale = peak > 0 ? 32767 / peak : 0;
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, i) => view.setInt16(2 * i, Math.round(sample * scale), true));
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}

export function pcm16Length(pcm16) {
  const padding = pcm16.endsWith("==") ? 2 : pcm16.endsWith("=") ? 1 : 0;
  return Math.floor(((pcm16.length * 3) / 4 - padding) / 2);
}

export function checkRecording(recording) {
  const { name, fs, pcm16 } = recording ?? {};
  if (typeof name !== "string" || !(fs > 0) || typeof pcm16 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(pcm16)) {
    throw new Error("a recording must have a name, a sampling rate and 16-bit samples in base64");
  }
  return recording;
}

// A sound file as mono samples at `fs` (the browser decodes and resamples
// it), at most MAX_RECORDING_S long, and its own length in seconds.
export async function decodeAudio(file, fs) {
  const audioContext = new OfflineAudioContext(1, 1, fs);
  let audio;
  try {
    audio = await audioContext.decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error("the browser cannot decode it as audio");
  }
  const length = Math.min(audio.length, Math.round(MAX_RECORDING_S * fs));
  const samples = new Float32Array(length);
  for (let channel = 0; channel < audio.numberOfChannels; channel++) {
    const channelSamples = audio.getChannelData(channel);
    for (let i = 0; i < length; i++) samples[i] += channelSamples[i] / audio.numberOfChannels;
  }
  return { samples, seconds: audio.length / audio.sampleRate };
}

// --- the Source controls -----------------------------------------------------------

// The engine's live pictures of a recording (engine.js, `live`), or null;
// main.js sets it, since the engine is the page's (streaming.md, L6).
let liveAnalysis = () => null;
export function useLiveAnalysis(get) {
  liveAnalysis = get;
}

let recordings = 0; // recordings made on this page, to name them
let recordingNow = null; // the Source controls recording now, if any: one at a time

// The Source fieldset's HTML; `title` is the source list's tooltip and
// `labels` the sources offered, by id.
export function sourceFieldset(title, labels = SOURCE_LABELS) {
  return `<fieldset><legend>Source</legend>
          <select class="source" title="${title}">
            ${Object.entries(labels).map(([id, label]) => `<option value="${id}">${label}</option>`).join("")}
          </select>
          <button type="button" class="open-audio" title="Open a sound file (WAV, MP3, …) to erase from; it sets the duration, up to ${MAX_RECORDING_S} s">Open audio file…</button>
          <button type="button" class="record" title="Record from the microphone, up to ${MAX_RECORDING_S} s; it sets the duration">● Record</button>
          <input type="file" class="audio-file" accept="audio/*" hidden>
          <canvas class="live-picture" hidden title="The recording's spectrogram as it is made (0 to 8 kHz)"></canvas>
          <p class="hint recording-note"></p>
        </fieldset>`;
}

// The Source fieldset under `root` brought to life. `state()` is the tab's
// state, `commit` keeps a new one, `openRecording(recording, seconds)` gives
// the page a recording and `hasRecording()` says whether it holds one.
// `pitch`, if given, follows a recording's pitch as it is made (streaming.md,
// L7): start(), part({t, f0}) for each stretch tracked, recorded(recording)
// once it is the page's, done() when the last stretch has come, or
// unavailable(why) when the pitch is not tracked live.
// Returns show(), which shows the state's source and its recording.
export function attachSourceControls(root, { state, commit, openRecording, hasRecording, log, pitch }) {
  const sourceList = root.querySelector(".source");
  const openAudio = root.querySelector(".open-audio");
  const audioFile = root.querySelector(".audio-file");
  const recordingNote = root.querySelector(".recording-note");
  const recordButton = root.querySelector(".record");
  const livePicture = root.querySelector(".live-picture");
  let recorder = null; // recordMicrophone's, while recording
  let clock = null;

  function show() {
    if (recorder) return; // the note says how the recording goes
    const { source, recording, duration } = state();
    sourceList.value = source;
    recordingNote.textContent =
      source !== "file" ? "" : recording
        ? `${recording.name}: ${(pcm16Length(recording.pcm16) / recording.fs).toFixed(2)} s, heard at ${duration} s.`
        : "No recording yet: open an audio file. Links do not carry recordings, so open it again after following one.";
  }

  sourceList.addEventListener("change", () => {
    // the page may hold a recording while another source is chosen
    if (sourceList.value === "file" && !hasRecording()) {
      show(); // the source changes when a recording opens
      return audioFile.click();
    }
    commit({ ...state(), source: sourceList.value });
  });

  openAudio.addEventListener("click", () => audioFile.click());
  audioFile.addEventListener("change", async () => {
    const file = audioFile.files[0];
    audioFile.value = "";
    if (!file) return;
    try {
      const { samples, seconds } = await decodeAudio(file, state().fs);
      if (!samples.some((sample) => sample !== 0)) throw new Error("it is silent");
      openRecording({ name: file.name, fs: state().fs, pcm16: encodePcm16(samples) }, seconds);
      log?.info(`opened the recording ${file.name} (${seconds.toFixed(2)} s)`);
    } catch (error) {
      recordingNote.textContent = `Could not open ${file.name}: ${error.message}`;
      log?.error(`could not open the recording ${file.name}: ${error.message}`);
    }
  });

  // The recording's spectrogram, drawn column by column as sonore streams it
  // (live.py): one canvas pixel per column, 0 Hz at the bottom.
  function drawColumns({ data, nFreqs, nWindows, first, tStep }) {
    const width = Math.round(MAX_RECORDING_S / tStep);
    if (livePicture.width !== width || livePicture.height !== nFreqs) {
      livePicture.width = width;
      livePicture.height = nFreqs;
    }
    const image = new ImageData(nWindows, nFreqs);
    for (let window = 0; window < nWindows; window++) {
      for (let row = 0; row < nFreqs; row++) {
        const [r, g, b] = magma(data[row * nWindows + window] / 255);
        const at = 4 * ((nFreqs - 1 - row) * nWindows + window);
        image.data.set([r, g, b, 255], at);
      }
    }
    livePicture.getContext("2d").putImageData(image, first, 0);
  }

  function showClock() {
    const seconds = recorder?.seconds() ?? 0;
    recordButton.textContent = `■ Stop recording (${seconds.toFixed(1)} s)`;
  }

  async function startRecording() {
    if (recordingNow) return;
    recordingNow = root;
    recordButton.disabled = true;
    const live = liveAnalysis();
    let picturing = false;
    const pageFs = state().fs;
    try {
      recorder = await recordMicrophone({
        fs: pageFs,
        maxSeconds: MAX_RECORDING_S,
        onBlock: (samples, fs) => {
          if (!live) return;
          if (!picturing) {
            // the pitch only at the page's rate, up to 16 kHz: faster rates fall behind (L7)
            const tracking = Boolean(pitch) && fs === pageFs && fs <= 16000;
            if (pitch && !tracking) pitch.unavailable(`the microphone records at ${fs} Hz`);
            live.start(
              fs,
              {
                onColumns: drawColumns,
                onPitch: tracking ? (part) => pitch.part(part) : undefined,
                onDone: tracking ? () => pitch.done() : undefined,
                onError: (message) => log?.error(`the recording's picture failed: ${message}`),
              },
              { pitch: tracking },
            );
            if (tracking) pitch.start();
            picturing = true;
          }
          live.block(samples);
        },
        onEnd: () => stopRecording(),
      });
    } catch (error) {
      recordingNow = null;
      recordButton.disabled = false;
      recordingNote.textContent = `Could not record: ${error.message}`;
      log?.error(`could not record: ${error.message}`);
      return;
    }
    livePicture.width = livePicture.width; // clears the last recording's picture
    livePicture.hidden = !live;
    recordingNote.textContent = live ? `Recording, up to ${MAX_RECORDING_S} s; its spectrogram fills in as it goes.` : `Recording, up to ${MAX_RECORDING_S} s.`;
    recordButton.disabled = false;
    showClock();
    clock = setInterval(showClock, 100);
    recorder.stopPicture = () => picturing && live.stop();
  }

  async function stopRecording() {
    if (!recorder || recorder.stopping) return;
    recorder.stopping = true;
    clearInterval(clock);
    const { fs: micFs } = recorder;
    try {
      const samples = await recorder.stop();
      recorder.stopPicture();
      const seconds = samples.length / micFs;
      if (!samples.some((sample) => sample !== 0)) throw new Error("it is silent (is the microphone muted?)");
      const atPageRate = await resample(samples, micFs, state().fs);
      const name = `Recording ${++recordings}`;
      recorder = null;
      const made = { name, fs: state().fs, pcm16: encodePcm16(atPageRate) };
      pitch?.recorded(made);
      openRecording(made, seconds);
      show();
      log?.info(`recorded ${name} (${seconds.toFixed(2)} s at ${micFs} Hz)`);
    } catch (error) {
      recorder = null;
      recordingNote.textContent = `Could not keep the recording: ${error.message}`;
      log?.error(`could not keep the recording: ${error.message}`);
    } finally {
      recordingNow = null;
      recordButton.textContent = "● Record";
    }
  }

  recordButton.addEventListener("click", () => (recorder ? stopRecording() : startRecording()));

  return show;
}
