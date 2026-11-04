// Fáze a poslední vzorek přežijí hranici render kvantu.
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
    this.ring = new Float32Array(sampleRate);
    this.read = 0;
    this.write = 0;
    this.playing = false;
    this.started = false;
    this.gain = 1;
    this.monitor = false;
    this.silent = false;
    this.last = 0;
    this.envelope = 0;
    this.lookahead = new Float32Array(240);
    this.lookaheadAt = 0;
    this.fade = 0;
    this.tail = 0;
    this.target = sampleRate * 0.06;
    this.arrival = undefined;
    this.filtered = sampleRate * 0.05;
    this.integral = 0;
    this.correction = 0;
    this.clock = 0;
    this.plcAt = -sampleRate;
    this.opus = false;
    this.outputEnergy = 0;
    this.outputSamples = 0;
    this.maxJump = 0;
    this.previousOutput = 0;
    const receive = (data) => {
      if (data.codecPort) {
        this.codecPort?.close();
        this.codecPort = data.codecPort;
        this.codecPort.onmessage = ({ data }) => receive(data);
      }
      if (data.pcm) {
        if (this.arrival !== undefined) {
          const gap = this.clock - this.arrival;
          this.target = Math.max(
            this.target,
            Math.min(sampleRate * 0.1, gap + sampleRate * 0.02),
          );
        }
        this.arrival = this.clock;
        this.playResampler.push(new Int16Array(data.pcm), (v) => {
          this.ring[this.write++ % this.ring.length] = v / 32768;
        });
        if (this.write - this.read > sampleRate * 0.3) {
          this.read = this.write - sampleRate * 0.06;
          this.tail = this.last;
          this.fade = 0;
          this.port.postMessage({ dropped: true });
        }
      }
      if (data.settings) Object.assign(this, data.settings);
      if (data.resetMetrics) {
        this.maxJump = 0;
        this.outputEnergy = 0;
        this.outputSamples = 0;
      }
      if (data.flush) {
        this.read = this.write = 0;
        this.playing = this.started = false;
        this.target = sampleRate * 0.06;
        this.arrival = undefined;
        this.filtered = sampleRate * 0.05;
        this.integral = this.correction = 0;
        this.playResampler = new Resampler(48000, sampleRate);
        this.tail = this.last;
        this.fade = 0;
      }
    };
    this.port.onmessage = ({ data }) => receive(data);
  }
  process(inputs, outputs) {
    const input = inputs[0]?.[0],
      output = outputs[0][0];
    if (input)
      this.captureResampler.push(input, (value) => {
        const mic = value * this.gain;
        // Detektor VAD měří před kompresorem. Obálka s attack 5 ms / release 150 ms.
        this.energy += mic * mic;
        const power = mic * mic;
        const alpha = Math.exp(
          -1 / (48000 * (power > this.envelope ? 0.005 : 0.15)),
        );
        this.envelope = alpha * this.envelope + (1 - alpha) * power;
        const level = Math.sqrt(this.envelope);
        const compression =
          level > 0.1258925 ? Math.pow(0.1258925 / level, 0.75) : 1;
        const delayed = this.lookahead[this.lookaheadAt];
        this.lookahead[this.lookaheadAt] = mic;
        this.lookaheadAt = (this.lookaheadAt + 1) % this.lookahead.length;
        const compressed = delayed * compression;
        // Měkká pojistka krátkých špiček nad 0,8.
        const limited =
          Math.abs(compressed) > 0.8
            ? Math.sign(compressed) *
              (0.8 + 0.2 * Math.tanh((Math.abs(compressed) - 0.8) / 0.2))
            : compressed;
        this.capture[this.position++] = Math.round(limited * 32767);
        if (this.position === 960) {
          this.port.postMessage(
            {
              pcm: this.capture.buffer,
              rms: Math.sqrt(this.energy / 960),
              at: typeof currentTime === "number" ? currentTime : undefined,
            },
            [this.capture.buffer],
          );
          this.capture = new Int16Array(960);
          this.position = this.energy = 0;
        }
      });
    if (!this.playing && this.write - this.read >= this.target) {
      this.playing = this.started = true;
      this.fade = 0;
      this.tail = this.last;
    }
    const seconds = output.length / sampleRate;
    this.filtered +=
      (this.write - this.read - this.filtered) * (1 - Math.exp(-seconds));
    if (this.playing) {
      const error = (this.filtered - this.target) / sampleRate;
      this.integral = Math.max(
        -0.0105,
        Math.min(0.0105, this.integral + error * seconds * 0.02),
      );
      const desired = Math.max(
        -0.0105,
        Math.min(0.0105, error * 0.4 + this.integral),
      );
      this.correction +=
        (desired - this.correction) * (1 - Math.exp(-seconds / 0.2));
    }
    const ramp = Math.max(1, Math.round(sampleRate * 0.005));
    for (let i = 0; i < output.length; i++) {
      let sample;
      if (this.playing && this.write - this.read >= 2) {
        const index = Math.floor(this.read),
          f = this.read - index;
        sample =
          this.ring[index % this.ring.length] * (1 - f) +
          this.ring[(index + 1) % this.ring.length] * f;
        this.read += 1 + this.correction;
        if (this.fade < ramp) {
          const t = ++this.fade / ramp;
          sample = this.tail * (1 - t) + sample * t;
        }
      } else {
        if (this.playing) {
          this.playing = false;
          this.tail = this.last;
          this.fade = 0;
          this.port.postMessage({ underrun: true });
        }
        sample = this.tail * Math.max(0, 1 - ++this.fade / ramp);
      }
      this.last = sample;
      output[i] = this.silent
        ? 0
        : sample + (this.monitor ? (input?.[i] || 0) * this.gain : 0);
      this.maxJump = Math.max(
        this.maxJump,
        Math.abs(output[i] - this.previousOutput),
      );
      this.previousOutput = output[i];
      this.outputEnergy += output[i] * output[i];
      this.outputSamples++;
    }
    this.clock += output.length;
    if (
      this.opus &&
      this.started &&
      this.write - this.read < sampleRate * (this.playing ? 0.06 : 0.1) &&
      this.clock - this.plcAt >= sampleRate * 0.02
    ) {
      const next = this.plcAt + sampleRate * 0.02;
      this.plcAt = this.clock - next < sampleRate * 0.02 ? next : this.clock;
      this.target = Math.min(sampleRate * 0.1, this.target + sampleRate * 0.02);
      (this.codecPort || this.port).postMessage({ plc: true });
    }
    if (this.clock % sampleRate < output.length)
      this.port.postMessage({
        stats: {
          bufferMs: ((this.write - this.read) / sampleRate) * 1000,
          targetBufferMs: (this.target / sampleRate) * 1000,
          driftCorrection: this.correction * 100,
          maxJump: this.maxJump,
          outputRms: Math.sqrt(
            this.outputEnergy / Math.max(1, this.outputSamples),
          ),
        },
      });
    return true;
  }
}
registerProcessor("mluvka-audio", MluvkaAudio);
