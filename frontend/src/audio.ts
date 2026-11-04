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
  lastVoice = 0;
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
      uid: "",
      sampleRate: 0,
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
      try {
        this.context = new AudioContext({
          sampleRate: 48000,
          latencyHint: "interactive",
        });
      } catch {
        this.context = new AudioContext({ latencyHint: "interactive" });
      }
      window.__mluvkaStats.sampleRate = this.context.sampleRate;
      const startingContext = this.context;
      await startingContext.audioWorklet.addModule("/audio-worklet.js");
      if (this.context !== startingContext) return;
      this.node = new AudioWorkletNode(this.context, "mluvka-audio", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
      });
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
    void this.resume();
    if (!this.context) return;
    if (this.settings.output) await this.setOutput(this.settings.output);
    if (!this.stream) await this.changeInput();
    await this.update(this.settings);
    this.checkState();
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
    if (this.notifyGain)
      this.notifyGain.gain.value = settings.deafen ? 0 : settings.notifyVolume;
    if (old.output !== settings.output)
      await this.setOutput(settings.output || "");
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
