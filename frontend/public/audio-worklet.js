// Jeden kontext 48 kHz, PCM po 960 vzorcích; přehrávání začíná po 80 ms.
class MluvkaAudio extends AudioWorkletProcessor {
  constructor() {
    super();
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
        this.queue.push(new Int16Array(data.pcm));
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
      }
    };
  }
  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0][0];
    if (!this.playing && this.queue.length >= 4) this.playing = true;
    for (let i = 0; i < output.length; i++) {
      const mic = Math.max(-1, Math.min(1, (input?.[i] || 0) * this.gain));
      if (input) {
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
      }
      let sample = 0;
      if (this.playing) {
        if (!this.queue.length) {
          this.playing = false;
          this.port.postMessage({ underrun: true });
        } else {
          sample = this.queue[0][this.offset++] / 32768;
          if (this.offset === this.queue[0].length) {
            this.queue.shift();
            this.offset = 0;
          }
        }
      }
      output[i] = this.silent ? 0 : sample + (this.monitor ? mic : 0);
    }
    return true;
  }
}
registerProcessor("mluvka-audio", MluvkaAudio);
