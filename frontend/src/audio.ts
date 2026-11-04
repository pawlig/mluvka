import type { Settings } from "./types";
type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };
export class AudioEngine {
  context?: SinkContext;
  node?: AudioWorkletNode;
  output?: GainNode;
  source?: MediaStreamAudioSourceNode;
  stream?: MediaStream;
  settings: Settings;
  ptt = false;
  testing = false;
  ready = false;
  lastVoice = 0;
  transmitting = false;
  inputRequest = 0;
  onLevel: (level: number, talking: boolean) => void;
  onFrame: (data: ArrayBuffer) => void;
  constructor(
    settings: Settings,
    onLevel: AudioEngine["onLevel"],
    onFrame: AudioEngine["onFrame"],
  ) {
    this.settings = settings;
    this.onLevel = onLevel;
    this.onFrame = onFrame;
    window.__mluvkaStats = {
      receivedFrames: 0,
      sentFrames: 0,
      rms: 0,
      micRms: 0,
      underruns: 0,
      droppedFrames: 0,
      uid: "",
      sampleRate: 0,
    };
  }
  async start() {
    if (!this.context) {
      this.context = new AudioContext({
        sampleRate: 48000,
        latencyHint: "interactive",
      });
      if (this.context.sampleRate !== 48000) {
        await this.close();
        throw new Error("Prohlížeč nepodporuje audio s frekvencí 48 kHz.");
      }
      window.__mluvkaStats.sampleRate = this.context.sampleRate;
      await this.context.audioWorklet.addModule("/audio-worklet.js");
      this.node = new AudioWorkletNode(this.context, "mluvka-audio", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
      });
      this.output = this.context.createGain();
      this.node.connect(this.output).connect(this.context.destination);
      this.node.port.onmessage = ({ data }) => {
        if (data.underrun) window.__mluvkaStats.underruns++;
        if (data.dropped) window.__mluvkaStats.droppedFrames++;
        if (!data.pcm) return;
        const { settings: s } = this;
        const now = performance.now();
        if (data.rms >= s.threshold) this.lastVoice = now;
        const active =
          this.ready &&
          !s.microphone &&
          !s.deafen &&
          !this.testing &&
          (s.mode === "always" ||
            (s.mode === "ptt" && this.ptt) ||
            (s.mode === "vad" && now - this.lastVoice < 300));
        this.transmitting = active;
        window.__mluvkaStats.micRms = data.rms;
        this.onLevel(data.rms, active);
        if (active) {
          const packet = new Uint8Array(1921);
          packet[0] = 1;
          packet.set(new Uint8Array(data.pcm), 1);
          this.onFrame(packet.buffer);
        }
      };
    }
    await this.context.resume();
    if (this.context.setSinkId && this.settings.output)
      await this.context.setSinkId(this.settings.output);
    await this.changeInput();
    await this.update(this.settings);
  }
  async changeInput() {
    if (!this.context || !this.node) return;
    const s = this.settings,
      context = this.context,
      node = this.node,
      request = ++this.inputRequest;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: s.input ? { exact: s.input } : undefined,
        echoCancellation: s.echo,
        noiseSuppression: s.noise,
        autoGainControl: s.autoGain,
        channelCount: 1,
        sampleRate: 48000,
      },
      video: false,
    });
    if (request !== this.inputRequest || this.context !== context) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = stream;
    this.source = context.createMediaStreamSource(stream);
    this.source.connect(node);
  }
  async update(settings: Settings) {
    const old = this.settings;
    this.settings = settings;
    this.node?.port.postMessage({
      settings: {
        gain: settings.gain,
        monitor: this.testing,
        silent: settings.deafen,
      },
      flush: settings.deafen,
    });
    if (this.output) this.output.gain.value = settings.volume;
    if (this.context?.setSinkId && old.output !== settings.output)
      await this.context.setSinkId(settings.output || "");
    if (
      this.stream &&
      (old.input !== settings.input ||
        old.echo !== settings.echo ||
        old.noise !== settings.noise ||
        old.autoGain !== settings.autoGain)
    )
      await this.changeInput();
  }
  receive(frame: ArrayBuffer) {
    if (frame.byteLength !== 1921 || new Uint8Array(frame)[0] !== 2) return;
    const pcm = frame.slice(1);
    const samples = new Int16Array(pcm);
    window.__mluvkaStats.receivedFrames++;
    window.__mluvkaStats.rms = Math.sqrt(
      samples.reduce((sum, x) => sum + (x / 32768) ** 2, 0) / 960,
    );
    this.node?.port.postMessage({ pcm }, [pcm]);
  }
  test(active: boolean) {
    this.testing = active;
    this.node?.port.postMessage({ settings: { monitor: active } });
  }
  beep(join: boolean) {
    if (
      !this.context ||
      this.settings.deafen ||
      !this.settings.beep ||
      !this.output
    )
      return;
    const osc = this.context.createOscillator(),
      gain = this.context.createGain();
    const t = this.context.currentTime;
    osc.frequency.setValueAtTime(join ? 660 : 440, t);
    osc.frequency.exponentialRampToValueAtTime(join ? 880 : 330, t + 0.09);
    gain.gain.setValueAtTime(0.06, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    osc.connect(gain).connect(this.output);
    osc.start(t);
    osc.stop(t + 0.15);
  }
  async close() {
    this.ready = false;
    ++this.inputRequest;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.source?.disconnect();
    this.node?.disconnect();
    const context = this.context;
    this.context = undefined;
    this.node = undefined;
    this.stream = undefined;
    this.source = undefined;
    this.ptt = false;
    await context?.close();
  }
}
