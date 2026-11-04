// Streaming lineární interpolace. Fáze i poslední vzorek přežijí hranici render kvantu.
class Resampler {
  constructor(from, to) {
    this.step = from / to;
    this.position = 0;
    this.previous = 0;
    this.started = false;
  }
  push(input, emit) {
    for (const current of input) {
      if (!this.started) {
        this.previous = current;
        this.started = true;
      }
      while (this.position < 1) {
        emit(this.previous + (current - this.previous) * this.position);
        this.position += this.step;
      }
      this.position -= 1;
      this.previous = current;
    }
  }
}
class MluvkaAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.captureResampler = new Resampler(sampleRate, 48000);
    this.playResampler = new Resampler(48000, sampleRate);
    this.capture = new Int16Array(960);
    this.position = 0;
    this.energy = 0;
    this.queue = [];
    this.offset = 0;
    this.playing = false;
    this.gain = 1;
    this.monitor = false;
    this.silent = false;
    this.port.onmessage = ({ data }) => {
      if (data.pcm) {
        const samples = [];
        this.playResampler.push(new Int16Array(data.pcm), (value) =>
          samples.push(value / 32768),
        );
        this.queue.push(Float32Array.from(samples));
        if (this.queue.length > 8) {
          this.queue.splice(0, this.queue.length - 4);
          this.offset = 0;
          this.port.postMessage({ dropped: true });
        }
      }
      if (data.settings) Object.assign(this, data.settings);
      if (data.flush) {
        this.queue = [];
        this.offset = 0;
        this.playing = false;
        this.playResampler = new Resampler(48000, sampleRate);
      }
    };
  }
  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0][0];
    if (input)
      this.captureResampler.push(input, (value) => {
        const mic = Math.max(-1, Math.min(1, value * this.gain));
        this.capture[this.position++] = Math.round(mic * 32767);
        this.energy += mic * mic;
        if (this.position === 960) {
          this.port.postMessage(
            { pcm: this.capture.buffer, rms: Math.sqrt(this.energy / 960) },
            [this.capture.buffer],
          );
          this.capture = new Int16Array(960);
          this.position = 0;
          this.energy = 0;
        }
      });
    if (!this.playing && this.queue.length >= 4) this.playing = true;
    for (let i = 0; i < output.length; i++) {
      let sample = 0;
      if (this.playing) {
        if (!this.queue.length) {
          this.playing = false;
          this.port.postMessage({ underrun: true });
        } else {
          sample = this.queue[0][this.offset++];
          if (this.offset === this.queue[0].length) {
            this.queue.shift();
            this.offset = 0;
          }
        }
      }
      output[i] = this.silent
        ? 0
        : sample + (this.monitor ? (input?.[i] || 0) * this.gain : 0);
    }
    return true;
  }
}
registerProcessor("mluvka-audio", MluvkaAudio);
