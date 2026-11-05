import { audioArrival, audioDecoded, audioEnvironment, audioUnderrun, resetAudioArrival } from "./audio-diagnostics";
import type { Settings } from "./types";
type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };
export class AudioEngine {
  context?: SinkContext;
  player?: HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  mediaOutput?: MediaStreamAudioDestinationNode;
  onBlocked: (blocked: boolean) => void = () => {};
  recovering?: Promise<void>;
  startPromise?: Promise<void>;
  retryInput?: ReturnType<typeof setTimeout>;
  private deviceChange = () => {
    void this.recover();
  };
  node?: AudioWorkletNode;
  output?: GainNode;
  private notifyGain?: GainNode;
  private notifyBuffers?: Promise<
    Record<"zprava" | "poke", AudioBuffer> | undefined
  >;
  private lastNotify = -Infinity;
  source?: MediaStreamAudioSourceNode;
  stream?: MediaStream;
  settings: Settings;
  ptt = false;
  testing = false;
  ready = false;
  lastVoice = -Infinity;
  codec: "opus" | "pcm" = "pcm";
  worker?: Worker;
  private codecReady?: Promise<void>;
  private pcmOnly = false;
  private linkedNode?: AudioWorkletNode;
  private linkedWorker?: Worker;
  private history: Int16Array[] = [];
  private pending?: Int16Array;
  private upBytes = 0;
  private downBytes = 0;
  private rateAt = performance.now();
  private captureTokens = 8;
  private captureBudgetAt = performance.now();
  onCodecFailure: () => void = () => {};
  transmitting = false;
  inputRequest = 0;
  private inputQueue: Promise<void> = Promise.resolve();
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
      droppedCaptureFrames: 0,
      uid: "",
      sampleRate: 0,
      bufferMs: 0,
      targetBufferMs: 60,
      driftCorrection: 0,
      maxJump: 0,
      outputRms: 0,
      upKbps: 0,
      downKbps: 0,
      plcFrames: 0,
      lostFrames: 0,
      codec: "pcm",
      notifySounds: 0,
      notifyPokes: 0,

    };
  }
  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    const pending = this.open().finally(() => {
      if (this.startPromise === pending) this.startPromise = undefined;
    });
    this.startPromise = pending;
    return pending;
  }
  private async open() {
    if (!this.context) {
      const mobile = matchMedia("(pointer: coarse)").matches;
      const latencyHint = mobile ? "playback" : "interactive";
      try {
        this.context = new AudioContext({
          ...(mobile ? {} : { sampleRate: 48000 }),
          latencyHint,
        });
      } catch {
        this.context = new AudioContext({ latencyHint });
      }
      window.__mluvkaStats.sampleRate = this.context.sampleRate;
      audioEnvironment(this.context, () => this.player?.srcObject ? "<audio> / MediaStreamDestination" : "přímo / AudioDestinationNode");
      const startingContext = this.context;
      await startingContext.audioWorklet.addModule("/audio-worklet.js");
      if (this.context !== startingContext) return;
      this.node = new AudioWorkletNode(this.context, "mluvka-audio", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
      });
      this.node.port.postMessage({ settings: { mobile } });
      this.output = this.context.createGain();
      this.node.connect(this.output);
      this.notifyGain = this.context.createGain();
      this.notifyGain.gain.value = this.settings.deafen
        ? 0
        : this.settings.notifyVolume;
      this.notifyGain.connect(this.output);
      this.notifyBuffers = this.loadNotifications(this.context).catch(
        () => undefined,
      );
      // Mobilní přehrávač dává Androidu aktivní mediální relaci i při zhasnutí.
      // Desktop zůstává na přímé cestě s nejmenší latencí.
      if (matchMedia("(pointer: coarse)").matches) {
        this.mediaOutput = this.context.createMediaStreamDestination();
        this.output.connect(this.mediaOutput);
        this.player = document.createElement("audio");
        this.player.setAttribute("playsinline", "");
        this.player.autoplay = true;
        this.player.srcObject = this.mediaOutput.stream;
        document.body.append(this.player);
        void this.playOutput();
      } else this.output.connect(this.context.destination);
      this.context.addEventListener("statechange", this.stateChanged);
      navigator.mediaDevices?.addEventListener(
        "devicechange",
        this.deviceChange,
      );
      this.linkCodec();
      this.node.port.onmessage = ({ data }) => {
        if (data.underrun) {
          window.__mluvkaStats.underruns++;
          audioUnderrun();
        }
        if (data.dropped) window.__mluvkaStats.droppedFrames++;
        if (data.stats) Object.assign(window.__mluvkaStats, data.stats);
        if (data.plc && this.ready && this.codec === "opus")
          this.worker?.postMessage({ plc: true });
        this.measureRates();
        if (!data.pcm) return;
        if (
          typeof data.at === "number" &&
          this.context &&
          this.context.currentTime - data.at > 0.1
        ) {
          window.__mluvkaStats.droppedCaptureFrames++;
          this.history = [];
          this.pending = undefined;
          this.transmitting = false;
          return;
        }
        const { settings: s } = this;
        const now = performance.now();
        const permitted =
          this.ready && !s.microphone && !s.deafen && !this.testing;
        if (permitted && data.rms >= s.threshold) this.lastVoice = now;
        const active =
          permitted &&
          (s.mode === "always" ||
            (s.mode === "ptt" && this.ptt) ||
            (s.mode === "vad" && now - this.lastVoice < 400));
        window.__mluvkaStats.micRms = data.rms;
        this.onLevel(data.rms, active);
        const pcm = new Int16Array(data.pcm);
        if (!permitted) {
          this.history = [];
          this.pending = undefined;
          this.lastVoice = -Infinity;
        } else if (active) {
          if (!this.transmitting) {
            const first = s.mode === "vad" ? [...this.history, pcm] : [pcm];
            this.history = [];
            this.fadeFrame(first[0], true);
            for (const frame of first) {
              if (this.pending) this.sendPcm(this.pending);
              this.pending = frame;
            }
          } else {
            if (this.pending) this.sendPcm(this.pending);
            this.pending = pcm;
          }
        } else {
          if (this.pending) {
            this.fadeFrame(this.pending, false);
            this.sendPcm(this.pending);
            this.pending = undefined;
          }
          if (s.mode === "vad") {
            this.history.push(pcm);
            if (this.history.length > 5) this.history.shift();
          }
        }
        this.transmitting = active;
      };
    }
    void this.resume();
    if (!this.context) return;
    if (this.settings.output) await this.setOutput(this.settings.output);
    if (!this.stream) await this.changeInput();
    await this.update(this.settings);
    this.checkState();
  }
  private fadeFrame(frame: Int16Array, start: boolean) {
    for (let i = 0; i < 480; i++) {
      const index = start ? i : frame.length - 1 - i;
      frame[index] = Math.round((frame[index] * i) / 480);
    }
  }
  private emitFrame(packet: ArrayBuffer) {
    const now = performance.now();
    this.captureTokens = Math.min(
      8,
      this.captureTokens + (now - this.captureBudgetAt) / 20,
    );
    this.captureBudgetAt = now;
    if (this.captureTokens < 1) {
      window.__mluvkaStats.droppedCaptureFrames++;
      return;
    }
    this.captureTokens--;
    this.onFrame(packet);
  }
  private sendPcm(pcm: Int16Array) {
    if (this.codec === "opus" && this.worker)
      this.worker.postMessage({ encode: pcm.buffer }, [pcm.buffer]);
    else {
      const packet = new Uint8Array(1921);
      packet[0] = 1;
      packet.set(new Uint8Array(pcm.buffer), 1);
      this.emitFrame(packet.buffer);
    }
  }
  recordSent(bytes: number) {
    this.upBytes += bytes;
  }
  private measureRates() {
    const now = performance.now(),
      elapsed = now - this.rateAt;
    if (elapsed < 1000) return;
    window.__mluvkaStats.upKbps = (this.upBytes * 8) / elapsed;
    window.__mluvkaStats.downKbps = (this.downBytes * 8) / elapsed;
    this.upBytes = this.downBytes = 0;
    this.rateAt = now;
  }
  private linkCodec() {
    if (
      !this.worker ||
      !this.node ||
      (this.linkedNode === this.node && this.linkedWorker === this.worker)
    )
      return;
    const channel = new MessageChannel();
    this.node.port.postMessage({ codecPort: channel.port1 }, [channel.port1]);
    this.worker.postMessage({ playPort: channel.port2 }, [channel.port2]);
    this.linkedNode = this.node;
    this.linkedWorker = this.worker;
  }
  async prepareTransport() {
    if (this.pcmOnly) return;
    if (!this.codecReady)
      this.codecReady = new Promise<void>((resolve) => {
        const worker = new Worker(
          new URL("./codec-worker.ts", import.meta.url),
          { type: "module" },
        );
        this.worker = worker;
        let initialized = false;
        const fail = () => {
          if (this.worker !== worker) return;
          worker.terminate();
          this.worker = undefined;
          this.pcmOnly = true;
          this.codec = "pcm";
          clearTimeout(timer);
          resolve();
          if (initialized) this.onCodecFailure();
        };
        const timer = setTimeout(fail, 5000);
        worker.onerror = (event) => {
          event.preventDefault();
          fail();
        };
        worker.onmessage = ({ data }) => {
          if (this.worker !== worker) return;
          if (data.ready) {
            this.linkCodec();
            initialized = true;
            clearTimeout(timer);
            resolve();
          }
          if (data.failed) fail();
          if (data.decodeMs !== undefined) audioDecoded(data.decodeMs);
          if (data.encoded && this.ready && this.codec === "opus")
            this.emitFrame(data.encoded);
          if (data.lost) window.__mluvkaStats.lostFrames += data.lost;
          if (data.decoded && this.ready && this.codec === "opus") {
            window.__mluvkaStats.receivedFrames++;
            window.__mluvkaStats.rms = data.rms;
            if (data.plc) {
              window.__mluvkaStats.plcFrames++;
            }
          }
          if (data.pcm && this.ready && this.codec === "opus") {
            if (data.plc) {
              window.__mluvkaStats.plcFrames++;
            }
            this.playPcm(data.pcm);
          }
        };
        worker.postMessage({ init: true, quality: this.settings.quality });
      });
    try {
      await this.codecReady;
    } catch {
      this.worker?.terminate();
      this.worker = undefined;
      this.pcmOnly = true;
      this.codec = "pcm";
    }
  }
  transportOffer() {
    return {
      codec: this.worker ? "opus" : "pcm",
      version: 1,
      quality: this.settings.quality,
    };
  }
  negotiate(codec: string) {
    resetAudioArrival();
    this.codec = codec === "opus" && this.worker ? "opus" : "pcm";
    window.__mluvkaStats.codec = this.codec;
    this.worker?.postMessage({ reset: true });
    this.node?.port.postMessage({
      settings: { opus: this.codec === "opus" },
      flush: true,
    });
    this.history = [];
    this.pending = undefined;
    this.lastVoice = -Infinity;
    this.transmitting = false;
  }
  changeInput(): Promise<void> {
    const request = ++this.inputRequest;
    const context = this.context,
      node = this.node,
      settings = this.settings;
    const pending = this.inputQueue
      .catch(() => {})
      .then(() => this.openInput(request, context, node, settings));
    this.inputQueue = pending;
    return pending;
  }
  private async openInput(
    request: number,
    context: SinkContext | undefined,
    node: AudioWorkletNode | undefined,
    s: Settings,
  ) {
    if (
      !context ||
      !node ||
      this.context !== context ||
      request !== this.inputRequest
    )
      return;
    const actual = this.stream?.getAudioTracks()[0]?.getSettings();
    if (
      actual &&
      (actual.echoCancellation !== s.echo ||
        actual.noiseSuppression !== s.noise ||
        actual.autoGainControl !== s.autoGain)
    ) {
      // Chrome jinak recykluje aktivní capturer se starým DSP. Souběžná getUserMedia
      // navíc mohou vrátit stejný zdroj; změny proto řadíme a starý zdroj nejdřív zavřeme.
      const previous = this.stream;
      this.stream = undefined;
      this.source?.disconnect();
      previous?.getTracks().forEach((track) => track.stop());
    }
    const constraints: MediaStreamConstraints = {
      audio: {
        deviceId: s.input ? { exact: s.input } : undefined,
        echoCancellation: s.echo,
        noiseSuppression: s.noise,
        autoGainControl: s.autoGain,
        channelCount: 1,
        sampleRate: 48000,
      },
      video: false,
    };
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      if (
        !s.input ||
        !(error instanceof DOMException) ||
        !["NotFoundError", "OverconstrainedError"].includes(error.name)
      ) {
        this.checkState();
        throw error;
      }
      // Odpojené BT: zachováme uživatelovu volbu, dočasně otevřeme výchozí vstup.
      (constraints.audio as MediaTrackConstraints).deviceId = undefined;
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    }
    if (request !== this.inputRequest || this.context !== context) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    clearTimeout(this.retryInput);
    this.stream = stream;
    for (const track of stream.getAudioTracks()) {
      const reopen = () => {
        if (this.stream !== stream) return;
        this.ptt = false;
        this.retryInput = setTimeout(() => {
          void this.recover(true);
        }, 250);
      };
      track.addEventListener("ended", reopen);
      track.addEventListener("mute", reopen);
    }
    this.source = context.createMediaStreamSource(stream);
    this.source.connect(node);
    this.checkState();
  }
  private async setOutput(id: string) {
    if (this.player?.setSinkId) await this.player.setSinkId(id);
    else if (this.context?.setSinkId) await this.context.setSinkId(id);
  }
  private stateChanged = () => {
    this.checkState();
    if (
      document.visibilityState === "visible" &&
      this.context?.state !== "running"
    )
      void this.resume();
  };
  checkState = () => {
    const context = this.context;
    this.onBlocked(
      !!context &&
        (context.state !== "running" ||
          !!this.player?.paused ||
          !this.stream ||
          this.stream
            .getAudioTracks()
            .some((t) => t.readyState === "ended" || t.muted)),
    );
  };
  async resume() {
    const context = this.context;
    if (!context) return;
    this.checkState();
    // Safari může promise bez gesta nechat čekat; nesmí blokovat TS ani mikrofon.
    void context.resume().then(this.checkState).catch(this.checkState);
    await this.playOutput();
  }
  async playOutput() {
    if (!this.player) return;
    try {
      await this.player.play();
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        this.checkState();
        return;
      }
      // Nepodporovaná MediaStream cesta: přímý výstup, žádný dvojitý poslech.
      if (this.context && this.output && this.mediaOutput) {
        this.output.disconnect(this.mediaOutput);
        this.output.connect(this.context.destination);
      }
      this.player.srcObject = null;
      this.player.remove();
      this.player = undefined;
      this.mediaOutput = undefined;
    }
    this.checkState();
  }
  recover(forceInput = false) {
    if (this.recovering) return this.recovering;
    this.recovering = (async () => {
      if (!this.context) return;
      void this.resume();
      const devices = await navigator.mediaDevices.enumerateDevices();
      const track = this.stream?.getAudioTracks()[0];
      const selectedGone =
        !!track?.getSettings().deviceId &&
        !devices.some(
          (d) =>
            d.kind === "audioinput" &&
            d.deviceId === track.getSettings().deviceId,
        );
      if (
        forceInput ||
        !track ||
        track.readyState === "ended" ||
        track.muted ||
        selectedGone
      )
        await this.changeInput();
    })()
      .catch(() => {
        if (!this.context) return;
        this.onBlocked(true);
        clearTimeout(this.retryInput);
        // Návrat zařízení po hovoru může trvat několik sekund.
        this.retryInput = setTimeout(() => {
          void this.recover(true);
        }, 2000);
      })
      .finally(() => {
        this.recovering = undefined;
        this.checkState();
      });
    return this.recovering;
  }
  async update(settings: Settings) {
    const old = this.settings;
    this.worker?.postMessage({ quality: settings.quality });
    this.settings = settings;
    this.node?.port.postMessage({
      settings: {
        gain: settings.gain,
        monitor: this.testing,
        silent: settings.deafen,
        opus: this.codec === "opus",
      },
      flush: settings.deafen,
    });
    if (this.output) this.output.gain.value = settings.volume;
    if (this.notifyGain)
      this.notifyGain.gain.value = settings.deafen ? 0 : settings.notifyVolume;
    if (old.output !== settings.output)
      await this.setOutput(settings.output || "");
    if (
      this.context &&
      this.node &&
      (old.input !== settings.input ||
        old.echo !== settings.echo ||
        old.noise !== settings.noise ||
        old.autoGain !== settings.autoGain)
    )
      await this.changeInput();
  }
  receive(frame: ArrayBuffer) {
    this.downBytes += frame.byteLength;
    const type = new Uint8Array(frame)[0];
    if (type === 4 || type === 2) audioArrival();
    if (type === 4 && frame.byteLength > 5 && this.codec === "opus") {
      this.worker?.postMessage({ decode: frame }, [frame]);
      return;
    }
    if (type === 2 && frame.byteLength === 1921) this.playPcm(frame.slice(1));
  }
  private playPcm(pcm: ArrayBuffer) {
    const samples = new Int16Array(pcm);
    window.__mluvkaStats.receivedFrames++;
    window.__mluvkaStats.rms = Math.sqrt(
      samples.reduce((sum, x) => sum + (x / 32768) ** 2, 0) / samples.length,
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
  private async loadNotifications(context: AudioContext) {
    const buffers = await Promise.all(
      (["zprava", "poke"] as const).map(async (kind) => {
        const response = await fetch(`/sounds/${kind}.mp3`);
        if (!response.ok) throw Error("Zvuk upozornění není dostupný");
        return [
          kind,
          await context.decodeAudioData(await response.arrayBuffer()),
        ] as const;
      }),
    );
    return Object.fromEntries(buffers) as Record<
      "zprava" | "poke",
      AudioBuffer
    >;
  }
  async notify(kind: "zprava" | "poke") {
    const context = this.context;
    if (
      !context ||
      this.settings.deafen ||
      this.settings.notifyVolume <= 0 ||
      // Šťouchnutí má vždy svůj zvuk; omezení 1,5 s platí jen pro dávky zpráv.
      (kind === "zprava" && performance.now() - this.lastNotify < 1500)
    )
      return;
    if (kind === "zprava") this.lastNotify = performance.now();
    try {
      const buffers = await this.notifyBuffers;
      if (
        !buffers ||
        this.context !== context ||
        context.state !== "running" ||
        this.settings.deafen ||
        !this.notifyGain
      )
        return;
      const source = context.createBufferSource();
      source.buffer = buffers[kind];
      source.connect(this.notifyGain);
      source.onended = () => source.disconnect();
      source.start();
      window.__mluvkaStats.notifySounds++;
      if (kind === "poke") window.__mluvkaStats.notifyPokes++;
    } catch {
      // Chyba načtení upozornění nesmí přerušit hovor.
    }
  }
  async close() {
    this.worker?.terminate();
    this.worker = undefined;
    this.codecReady = undefined;
    this.history = [];
    this.pending = undefined;
    this.startPromise = undefined;
    this.ready = false;
    ++this.inputRequest;
    clearTimeout(this.retryInput);
    navigator.mediaDevices?.removeEventListener(
      "devicechange",
      this.deviceChange,
    );
    this.context?.removeEventListener("statechange", this.stateChanged);
    if (this.player) {
      this.player.pause();
      this.player.srcObject = null;
      this.player.remove();
    }
    this.player = undefined;
    this.mediaOutput = undefined;
    this.notifyGain?.disconnect();
    this.notifyGain = undefined;
    this.notifyBuffers = undefined;
    this.lastNotify = -Infinity;
    this.onBlocked(false);
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
