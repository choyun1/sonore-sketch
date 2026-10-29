// The microphone's samples, handed on as they arrive (recorder.js): an
// AudioWorklet processor runs on the audio thread, 128 samples at a time.
class RecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channels = inputs[0];
    if (channels?.length) {
      // mono: the channels' mean
      const block = new Float32Array(channels[0].length);
      for (const channel of channels) for (let i = 0; i < block.length; i++) block[i] += channel[i] / channels.length;
      this.port.postMessage(block, [block.buffer]);
    }
    return true;
  }
}

registerProcessor("recorder", RecorderProcessor);
