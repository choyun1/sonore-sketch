// The sounds the Erase tabs erase from, and the recording the page holds
// (docs/design/tabs/edit.md, E1, after the Erase spectrogram design's F1,
// F3, F6). Both Erase tabs take the same sources and share the page's
// recording, so their Source controls are made here too.
//
// Nothing here touches the DOM or Web Audio until it is called, so this file
// runs under `node --test`.

import { absolutePeak } from "./audio.js";

export const SOURCES = ["syllables", "speech", "file"];
export const SOURCE_LABELS = { syllables: "Syllable train", speech: "The Draw speech tab's sound", file: "A recording" };
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

// The Source fieldset's HTML; `title` is the source list's tooltip and
// `labels` the sources offered, by id.
export function sourceFieldset(title, labels = SOURCE_LABELS) {
  return `<fieldset><legend>Source</legend>
          <select class="source" title="${title}">
            ${Object.entries(labels).map(([id, label]) => `<option value="${id}">${label}</option>`).join("")}
          </select>
          <button type="button" class="open-audio" title="Open a sound file (WAV, MP3, …) to erase from; it sets the duration, up to ${MAX_RECORDING_S} s">Open audio file…</button>
          <input type="file" class="audio-file" accept="audio/*" hidden>
          <p class="hint recording-note"></p>
        </fieldset>`;
}

// The Source fieldset under `root` brought to life. `state()` is the tab's
// state, `commit` keeps a new one, `openRecording(recording, seconds)` gives
// the page a recording and `hasRecording()` says whether it holds one.
// Returns show(), which shows the state's source and its recording.
export function attachSourceControls(root, { state, commit, openRecording, hasRecording, log }) {
  const sourceList = root.querySelector(".source");
  const openAudio = root.querySelector(".open-audio");
  const audioFile = root.querySelector(".audio-file");
  const recordingNote = root.querySelector(".recording-note");

  function show() {
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

  return show;
}
