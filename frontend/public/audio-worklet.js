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
    this.workletVersion = /*__WORKLET_VERSION__*/ "dev";
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
    // Mobilní strop 320 ms = 300 ms jitter + jeden rámec pro dekódování/render.
    // 60 ms použitelné rezervy + půl 20ms rámce pro střed pilovité fronty.
    this.target = sampleRate * 0.07;
    this.arrival = undefined;
    this.mobile = false;
    this.gaps = [];
    this.adaptAt = 0;
    this.filtered = sampleRate * 0.07;
    this.integral = 0;
    this.correction = 0;
    this.clock = 0;
    this.plcAt = -sampleRate;
    this.opus = false;
    this.outputEnergy = 0;
    this.outputSamples = 0;
    this.maxJump = 0;
    this.previousOutput = 0;
    this.tracePlayback = false;
    this.traceFrames = [];
    const receive = (data) => {
      if (data.codecPort) {
        this.codecPort?.close();
        this.codecPort = data.codecPort;
        this.codecPort.onmessage = ({ data }) => receive(data);
      }
      if (typeof data.tracePlayback === "boolean") {
        if (!data.tracePlayback && this.traceFrames.length)
          this.port.postMessage({ playbackTrace: this.traceFrames });
        this.traceFrames = [];
        this.tracePlayback = data.tracePlayback;
      }
      if (data.pcm) {
        if (this.arrival !== undefined) {
          const gap = this.clock - this.arrival;
          this.gaps.push({ at: this.clock, gap });
          // Rychlá reakce i na řídkou špičku, kterou p95 ještě nevidí.
          if (gap > sampleRate * 0.04) {
            this.target = Math.max(this.target, Math.min(this.bufferLimit(), gap + sampleRate * 0.04));
          }
        }
        this.arrival = this.clock;
        this.playResampler.push(new Int16Array(data.pcm), (v) => {
          this.ring[this.write++ % this.ring.length] = v / 32768;
        });
        if (this.tracePlayback) this.traceFrames.push([
          this.clock / sampleRate * 1000, (this.write - this.read) / sampleRate * 1000,
          this.target / sampleRate * 1000, this.correction * 100,
        ]);
        if (this.write - this.read > Math.max(sampleRate * 0.8, this.target + sampleRate * 0.4)) {
          const skipped = this.write - this.target - this.read;
          this.read = this.write - this.target;
          this.tail = this.last;
          this.fade = 0;
          this.port.postMessage({ dropped: Math.ceil(skipped * 50 / sampleRate) });
        }
      }
      if (data.settings) {
        Object.assign(this, data.settings);
        if (data.settings.mobile && !this.started) this.target = sampleRate * 0.32;
      }
      if (data.resetMetrics) {
        this.port.postMessage({
          metricsResetAtMs: this.clock / sampleRate * 1000,
          // Jen testovací časová stopa; žádné vzorky ani obsah ring bufferu.
          playbackState: this.tracePlayback ? {
            sampleRate, clock: this.clock, read: this.read, write: this.write,
            target: this.target, filtered: this.filtered, integral: this.integral,
            correction: this.correction, playing: this.playing, started: this.started,
            arrival: this.arrival, adaptAt: this.adaptAt, gaps: this.gaps,
          } : undefined,
        });
        this.maxJump = 0;
        this.outputEnergy = 0;
        this.outputSamples = 0;
      }
      if (data.flush) {
        this.read = this.write = 0;
        this.playing = this.started = false;
        this.target = Math.min(this.bufferLimit(), Math.max(this.target, sampleRate * (this.mobile ? 0.32 : 0.07)));
        this.arrival = undefined;
        this.gaps = [];
        this.filtered = this.target - sampleRate * 0.01;
        this.integral = this.correction = 0;
        this.playResampler = new Resampler(48000, sampleRate);
        this.tail = this.last;
        this.fade = 0;
      }
    };
    this.port.onmessage = ({ data }) => receive(data);
  }
  bufferLimit() {
    // Desktop: 120ms špička + rezerva, nejvýše 150 ms; mobil má 320 ms.
    return sampleRate * (this.mobile ? 0.32 : 0.15);
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
      // Odhad středu skutečně naplněné fronty, včetně celých 20ms rámců.
      // Podhodnocený start by zbytečně nabil integrátor a rozkmital rezervu.
      this.filtered = (this.mobile ? this.target : this.write - this.read) - sampleRate * 0.01;
      this.integral = this.correction = 0;
      this.fade = 0;
      this.tail = this.last;
    }
    const seconds = output.length / sampleRate;
    if (this.clock - this.adaptAt >= sampleRate) {
      this.adaptAt = this.clock;
      this.gaps = this.gaps.filter((v) => this.clock - v.at < sampleRate * 10);
      const sorted = this.gaps.map((v) => v.gap).sort((a, b) => a - b);
      const p95 = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] || 0;
      const desired = Math.min(this.bufferLimit(), Math.max(sampleRate * (this.mobile ? 0.06 : 0.07), p95 + sampleRate * 0.04));
      this.target = Math.max(this.target, desired);
      // P95 posledních 10 s dovolí pokles i při jednotlivých odlehlých mezerách.
      // Pokles o 2 ms/s nezkracuje ani nezahazuje celé rámce.
      // Mobilní p95 nad 40 ms znamená trvající dávkování. Naučenou rezervu
      // v něm nesnižujeme mezi jednotlivými 400ms mezerami.
      if (!this.mobile || p95 <= sampleRate * 0.04)
        this.target = Math.max(desired, this.target - sampleRate * 0.002);
    }
    this.filtered +=
      (this.write - this.read - this.filtered) * (1 - Math.exp(-seconds));
    if (this.playing) {
      const error = (this.filtered - this.target) / sampleRate;
      const unsaturated = error * 0.4 + this.integral;
      // Anti-windup: velká změna rezervy nesmí nabít integrátor na desítky sekund.
      if (Math.abs(unsaturated) < 0.0105 || error * unsaturated < 0)
        this.integral = Math.max(-0.0105, Math.min(0.0105, this.integral + error * seconds * 0.02));
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
            const gap = this.arrival === undefined ? 0 : this.clock - this.arrival;
          this.target = this.mobile ? this.bufferLimit()
            : Math.min(this.bufferLimit(), Math.max(this.target, gap + sampleRate * 0.04));
          this.port.postMessage({ underrun: true, playbackAtMs: this.clock / sampleRate * 1000 });
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
    // TCP zpoždění není ztracený Opus paket. PLC vyrábí dekodér pouze pro
    // prokázanou díru v pořadí; jinak by pozdější hlas nahradilo umělé ticho.
    if (this.clock % sampleRate < output.length)
      this.port.postMessage({
        playbackTrace: this.tracePlayback ? this.traceFrames.splice(0) : undefined,
        stats: {
          workletVersion: this.workletVersion,
          renderQuantum: output.length,
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
