import { useEffect, useRef, useSyncExternalStore } from "react";

export interface Share {
  session: string;
  client: number;
  uid: string;
  name: string;
  kind: "screen";
}
interface Presence {
  client: number;
  uid: string;
  session: string;
  sharing: boolean;
}
export type Quality = "720" | "1080" | "motion";
export const qualities = {
  "720": {
    label: "720p · 30 fps",
    width: 1280,
    height: 720,
    fps: 30,
    bitrate: 2_500_000,
  },
  "1080": {
    label: "1080p · 30 fps",
    width: 1920,
    height: 1080,
    fps: 30,
    bitrate: 4_000_000,
  },
  motion: {
    label: "1080p · 60 fps",
    width: 1920,
    height: 1080,
    fps: 60,
    bitrate: 6_000_000,
  },
};
export interface ShareStats {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  candidate: string;
  framesDecoded: number;
}
interface State {
  self: string;
  shares: Share[];
  clients: Presence[];
  sharing: boolean;
  starting: boolean;
  switching: boolean;
  viewers: number;
  watching?: Share;
  stream?: MediaStream;
  status: string;
  error: string;
  stats?: ShareStats;
}
interface Peer {
  to: string;
  pc: RTCPeerConnection;
  call: string;
  sending: boolean;
  candidates: RTCIceCandidateInit[];
  timer?: ReturnType<typeof setTimeout>;
  offering?: boolean;
  videoSender?: RTCRtpSender;
  audioSender?: RTCRtpSender;
}
function displayOptions(quality: Quality, audio: boolean) {
  const preset = qualities[quality];
  return {
    video: {
      width: { ideal: preset.width, max: preset.width },
      height: { ideal: preset.height, max: preset.height },
      frameRate: { ideal: preset.fps, max: preset.fps },
    },
    audio,
  };
}
declare global {
  interface Window {
    __mluvkaShareTest?: { relay?: boolean };
    __mluvkaShareStats?: ShareStats;
  }
}
export class Sharing {
  state: State = {
    self: "",
    shares: [],
    clients: [],
    sharing: false,
    starting: false,
    switching: false,
    viewers: 0,
    status: "",
    error: "",
  };
  private listeners = new Set<() => void>();
  private token = "";
  private config?: RTCConfiguration;
  private configExpires = 0;
  private capture?: MediaStream;
  private quality: Quality = "720";
  private audio = false;
  private peers = new Map<string, Peer>();
  private queue = Promise.resolve();
  private desired?: string;
  private restoreUntil = 0;
  private generation = 0;
  private captureGeneration = 0;
  private pendingStart?: string;
  private startTimer?: ReturnType<typeof setTimeout>;
  private watchTimer?: ReturnType<typeof setTimeout>;
  private watchAttempts = 0;
  private hasTurn?: boolean;
  private lastBytes = { bytes: 0, at: 0 };
  constructor(private sendRaw: (data: unknown) => void) {}
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  snapshot = () => this.state;
  private update(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  private send(type: string, rest: Record<string, unknown> = {}) {
    this.sendRaw({ type, v: 1, kind: "screen", ...rest });
  }
  private fail(error: unknown) {
    this.update({
      error:
        error instanceof Error
          ? error.message
          : "Sdílení se nepodařilo připojit.",
    });
  }
  private async ice() {
    if (this.config && Date.now() < this.configExpires - 60000)
      return this.config;
    const token = this.token;
    const result = await fetch("/api/ice", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!result.ok)
      throw Error("Nastavení spojení není dostupné. Zkuste se připojit znovu.");
    const data = await result.json();
    if (token !== this.token) throw Error("Relace byla mezitím odpojena.");
    this.hasTurn = data.iceServers.some((server: RTCIceServer) =>
      (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) =>
        /^turns?:/i.test(url),
      ),
    );
    this.configExpires = data.expiresAt * 1000;
    this.config = {
      bundlePolicy: "max-bundle",
      iceServers: data.iceServers,
      ...(import.meta.env.VITE_E2E_SHARING === "1" &&
      window.__mluvkaShareTest?.relay
        ? { iceTransportPolicy: "relay" as const }
        : {}),
    };
    return this.config;
  }
  receive(msg: any) {
    if (
      ![
        "share_session",
        "share_started",
        "share_list",
        "share_stop",
        "watch",
        "unwatch",
        "rtc_offer",
        "rtc_answer",
        "rtc_ice",
        "share_error",
      ].includes(msg.type)
    )
      return;
    if (msg.type === "share_session") {
      this.token = msg.token;
      this.config = undefined;
      this.hasTurn = undefined;
      this.update({ self: msg.session });
      return;
    }
    // WS pořadí se zachová i přes asynchronní setRemoteDescription/addIceCandidate.
    const generation = this.generation;
    this.queue = this.queue
      .then(async () => {
        if (generation === this.generation) await this.handle(msg);
      })
      .catch((error) => {
        if (generation === this.generation) this.fail(error);
      });
  }
  private async handle(msg: any) {
    if (msg.type === "share_started") {
      if (msg.request === this.pendingStart && this.capture) {
        clearTimeout(this.startTimer);
        this.pendingStart = undefined;
        this.update({ sharing: true, starting: false });
      } else if (!this.capture && !this.state.starting) {
        // Uživatel mohl zrušit výběr/start dřív, než backend odpověděl.
        this.send("share_stop");
      }
      return;
    }
    if (msg.type === "share_error") {
      this.update({ error: msg.message });
      if (msg.request === "watch") {
        this.unwatch(false);
      }
      if (msg.request === "share_start") this.stop(false);
      return;
    }
    if (msg.type === "share_list") {
      const shares = msg.shares as Share[];
      this.update({ shares, clients: msg.clients, viewers: msg.viewers });
      // Starší snapshot nesmí zahodit zachycený stream před potvrzením startu.
      if (!msg.sharing && this.state.sharing && !this.pendingStart)
        this.stop(false);
      if (msg.sharing && !this.capture && !this.state.starting)
        this.send("share_stop");
      if (
        this.state.watching &&
        !shares.some((p) => p.session === this.state.watching?.session)
      )
        this.unwatch(false);
      if (
        this.desired &&
        !this.state.watching &&
        Date.now() < this.restoreUntil
      ) {
        const share = shares.find(
          (p) => p.uid === this.desired && p.session !== this.state.self,
        );
        if (share) this.watch(share);
      }
      return;
    }
    const from = msg.from as string;
    if (msg.type === "share_stop") {
      if (from === this.state.watching?.session) this.unwatch(false);
      return;
    }
    if (msg.type === "unwatch") {
      this.close(from, true);
      return;
    }
    if (msg.type === "watch") {
      if (!this.capture) {
        this.send("share_stop");
        return;
      }
      let peer = this.peers.get(`send:${from}`);
      if (!peer) {
        peer = await this.makePeer(from, true, crypto.randomUUID());
        if (!this.capture) {
          this.close(from, true);
          return;
        }
        for (const track of this.capture.getTracks()) {
          const sender = peer.pc.addTrack(track, this.capture!);
          if (track.kind === "audio") peer.audioSender = sender;
          if (track.kind === "video") {
            peer.videoSender = sender;
            const tx = peer.pc
              .getTransceivers()
              .find((t) => t.sender === sender);
            const codecs = RTCRtpReceiver.getCapabilities?.("video")?.codecs;
            if (tx?.setCodecPreferences && codecs) {
              const rank = (mime: string) =>
                ["video/vp9", "video/h264", "video/vp8"].indexOf(
                  mime.toLowerCase(),
                );
              try {
                tx.setCodecPreferences(
                  [...codecs].sort(
                    (a, b) =>
                      (rank(a.mimeType) < 0 ? 9 : rank(a.mimeType)) -
                      (rank(b.mimeType) < 0 ? 9 : rank(b.mimeType)),
                  ),
                );
              } catch {
                /* Starší Safari ponechá výchozí kodeky. */
              }
            }
          }
        }
        // Prázdný audio transceiver: zvuk jde přidat i do sdílení bez zvuku.
        if (!peer.audioSender) {
          try {
            peer.audioSender = peer.pc.addTransceiver("audio", {
              direction: "sendonly",
            }).sender;
          } catch {
            /* Bez transceiveru zůstane přepnutí jen u obrazu. */
          }
        }
        // Rezervované rozšíření: bez handleru příkazů, žádné vzdálené ovládání.
        peer.pc.createDataChannel("mluvka.v1", { protocol: "mluvka.v1" });
      }
      await this.offer(from, peer, true);
      return;
    }
    if (msg.type === "rtc_offer") {
      if (from !== this.state.watching?.session) return;
      let peer = this.peers.get(`recv:${from}`);
      if (!peer || peer.call !== msg.call) {
        this.close(from, false);
        peer = await this.makePeer(from, false, msg.call);
      }
      peer.pc.setConfiguration(await this.ice());
      await peer.pc.setRemoteDescription(msg.sdp);
      for (const c of peer.candidates.splice(0))
        await peer.pc.addIceCandidate(c);
      await peer.pc.setLocalDescription(await peer.pc.createAnswer());
      this.send("rtc_answer", {
        to: from,
        call: peer.call,
        sdp: peer.pc.localDescription,
      });
      return;
    }
    const peer = [...this.peers.values()].find(
      (p) => p.to === from && p.call === msg.call,
    );
    if (!peer || peer.call !== msg.call) return;
    if (msg.type === "rtc_answer" && peer.sending) {
      await peer.pc.setRemoteDescription(msg.sdp);
      for (const c of peer.candidates.splice(0))
        await peer.pc.addIceCandidate(c);
      await this.limit(peer);
    }
    if (msg.type === "rtc_ice" && msg.candidate) {
      if (peer.pc.remoteDescription)
        await peer.pc.addIceCandidate(msg.candidate);
      else peer.candidates.push(msg.candidate);
    }
  }
  private async makePeer(to: string, sending: boolean, call: string) {
    const generation = this.generation;
    const config = await this.ice();
    if (generation !== this.generation)
      throw Error("Relace byla mezitím odpojena.");
    const pc = new RTCPeerConnection(config);
    const peer: Peer = { to, pc, sending, call, candidates: [] };
    const key = `${sending ? "send" : "recv"}:${to}`;
    this.peers.set(key, peer);
    pc.onicecandidate = ({ candidate }) => {
      if (candidate)
        this.send("rtc_ice", { to, call, candidate: candidate.toJSON() });
    };
    pc.ontrack = ({ track, streams }) => {
      if (sending || this.state.watching?.session !== to) return;
      const stream = streams[0] || this.state.stream || new MediaStream();
      if (!stream.getTrackById(track.id)) stream.addTrack(track);
      this.update({ stream });
    };
    const stateChanged = () => {
      if (this.peers.get(`${peer.sending ? "send" : "recv"}:${to}`) !== peer)
        return;
      const failed =
        pc.connectionState === "failed" || pc.iceConnectionState === "failed";
      const disconnected =
        pc.connectionState === "disconnected" ||
        pc.iceConnectionState === "disconnected";
      if (
        !sending &&
        pc.connectionState === "connected" &&
        !failed &&
        !disconnected
      ) {
        clearTimeout(this.watchTimer);
        this.watchAttempts = 0;
      }
      if (!sending)
        this.update({
          status:
            pc.connectionState === "connected"
              ? "Připojeno"
              : failed || disconnected
                ? "Spojení ztraceno — zkouším znovu"
                : "Připojuji…",
        });
      clearTimeout(peer.timer);
      if (failed || disconnected)
        peer.timer = setTimeout(
          () => this.recover(to, peer),
          failed ? 500 : 2500,
        );
    };
    pc.onconnectionstatechange = stateChanged;
    pc.oniceconnectionstatechange = stateChanged;
    return peer;
  }
  private async offer(to: string, peer: Peer, restart: boolean) {
    if (peer.offering || peer.pc.signalingState !== "stable") return;
    peer.offering = true;
    try {
      if (restart) {
        peer.pc.setConfiguration(await this.ice());
        peer.pc.restartIce?.();
      }
      await peer.pc.setLocalDescription(
        await peer.pc.createOffer({ iceRestart: restart }),
      );
      this.send("rtc_offer", {
        to,
        call: peer.call,
        sdp: peer.pc.localDescription,
      });
      await this.limit(peer);
    } finally {
      peer.offering = false;
    }
  }
  private async limit(peer: Peer) {
    for (const sender of peer.pc.getSenders()) {
      if (sender.track?.kind !== "video") continue;
      const p = sender.getParameters();
      if (!p.encodings?.length) continue;
      p.encodings.forEach((e) => {
        e.maxBitrate = qualities[this.quality].bitrate;
        e.maxFramerate = qualities[this.quality].fps;
      });
      p.degradationPreference =
        this.quality === "motion"
          ? "maintain-framerate"
          : "maintain-resolution";
      try {
        await sender.setParameters(p);
      } catch {
        // Některé verze Safari odmítají degradationPreference; samotný bitrate zachováme.
        delete p.degradationPreference;
        try {
          await sender.setParameters(p);
        } catch {
          /* Omezení enkodéru není v tomto prohlížeči dostupné. */
        }
      }
    }
  }
  private recover(to: string, peer: Peer) {
    if (
      this.peers.get(`${peer.sending ? "send" : "recv"}:${to}`) !== peer ||
      !this.token
    )
      return;
    if (peer.sending)
      void this.offer(to, peer, true).catch((e) => this.fail(e));
    else {
      this.retryWatch();
      return;
    }
    peer.timer = setTimeout(() => this.recover(to, peer), 8000);
  }
  networkChanged = () => {
    for (const p of this.peers.values()) {
      clearTimeout(p.timer);
      if (p.sending) this.recover(p.to, p);
      else this.retryWatch(false);
    }
  };
  async start(quality: Quality, audio: boolean) {
    if (this.capture || this.state.starting || !this.token) return;
    const generation = ++this.captureGeneration;
    this.quality = quality;
    this.audio = audio;
    this.update({ starting: true, error: "" });
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia(
        displayOptions(quality, audio),
      );
      if (generation !== this.captureGeneration || !this.token) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.capture = stream;
      const track = stream.getVideoTracks()[0];
      track.contentHint = quality === "motion" ? "motion" : "detail";
      track.onended = () => this.stop();
      await this.ice();
      if (generation !== this.captureGeneration || !this.capture) return;
      this.pendingStart = crypto.randomUUID();
      this.send("share_start", { request: this.pendingStart });
      this.startTimer = setTimeout(() => {
        if (!this.pendingStart) return;
        this.stop();
        this.fail(
          Error("Server nepotvrdil zahájení sdílení. Zkuste to znovu."),
        );
      }, 10000);
    } catch (e) {
      stream?.getTracks().forEach((t) => t.stop());
      this.capture = undefined;
      if (!(e instanceof DOMException && e.name === "NotAllowedError"))
        this.fail(e);
    } finally {
      if (generation === this.captureGeneration && !this.pendingStart)
        this.update({ starting: false });
    }
  }
  async switchSource() {
    if (!this.capture || this.state.starting || this.state.switching) return;
    const generation = ++this.captureGeneration;
    this.update({ switching: true, error: "" });
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia(
        displayOptions(this.quality, this.audio),
      );
      if (generation !== this.captureGeneration || !this.capture) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const video = stream.getVideoTracks()[0];
      const audio = stream.getAudioTracks()[0] ?? null;
      for (const peer of this.peers.values()) {
        if (!peer.sending) continue;
        await peer.videoSender?.replaceTrack(video);
        await peer.audioSender?.replaceTrack(audio);
      }
      if (generation !== this.captureGeneration || !this.capture) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      video.contentHint = this.quality === "motion" ? "motion" : "detail";
      video.onended = () => this.stop();
      this.capture.getTracks().forEach((t) => {
        t.onended = null;
        t.stop();
      });
      this.capture = stream;
      stream = undefined;
    } catch (e) {
      stream?.getTracks().forEach((t) => t.stop());
      if (!(e instanceof DOMException && e.name === "NotAllowedError"))
        this.fail(e);
    } finally {
      if (generation === this.captureGeneration)
        this.update({ switching: false });
    }
  }
  stop(notify = true) {
    ++this.captureGeneration;
    clearTimeout(this.startTimer);
    this.pendingStart = undefined;
    this.capture?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    this.capture = undefined;
    for (const peer of this.peers.values())
      if (peer.sending) this.close(peer.to, true);
    if (notify && this.token) this.send("share_stop");
    this.update({
      sharing: false,
      starting: false,
      switching: false,
      viewers: 0,
    });
  }
  watch(share: Share) {
    this.unwatch();
    this.desired = share.uid;
    this.restoreUntil = 0;
    this.lastBytes = { bytes: 0, at: 0 };
    this.update({
      watching: share,
      status: "Připojuji…",
      error: "",
      stats: undefined,
    });
    this.watchAttempts = 1;
    this.send("watch", { to: share.session });
    this.watchDeadline();
    void this.ice().catch((error) => {
      if (this.state.watching !== share) return;
      this.unwatch();
      this.fail(error);
    });
  }
  private watchDeadline() {
    clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => this.retryWatch(), 10000);
  }
  private retryWatch(terminalWithoutTurn = true) {
    const share = this.state.watching;
    if (!share || !this.token) return;
    const noTurn = this.hasTurn === false;
    if ((terminalWithoutTurn && noTurn) || this.watchAttempts >= 3) {
      const message = noTurn
        ? "Přímé spojení se nepodařilo a server nemá TURN — sdílení přes tuhle síť nejde"
        : "Sdílení se nepodařilo připojit ani po třech pokusech. Zkuste sledování spustit znovu.";
      this.unwatch();
      this.update({ error: message });
      return;
    }
    this.watchAttempts++;
    this.update({ status: "Spojení ztraceno — zkouším znovu" });
    this.send("watch", { to: share.session });
    this.watchDeadline();
  }
  // Pozvánka s polem watch: sleduj sdílení daného UID, jakmile se objeví ve stavu.
  watchUid(uid: string, within = 15000) {
    this.desired = uid;
    this.restoreUntil = Date.now() + within;
    const share = this.state.shares.find(
      (p) => p.uid === uid && p.session !== this.state.self,
    );
    if (share && !this.state.watching) this.watch(share);
  }
  unwatch(notify = true) {
    clearTimeout(this.watchTimer);
    this.watchAttempts = 0;
    const share = this.state.watching;
    if (share) {
      if (notify && this.token) this.send("unwatch", { to: share.session });
      this.close(share.session, false);
    }
    this.desired = undefined;
    this.restoreUntil = 0;
    this.update({
      watching: undefined,
      stream: undefined,
      stats: undefined,
      status: "",
    });
    window.__mluvkaShareStats = undefined;
  }
  private close(id: string, sending: boolean) {
    const key = `${sending ? "send" : "recv"}:${id}`;
    const p = this.peers.get(key);
    if (!p) return;
    clearTimeout(p.timer);
    this.peers.delete(key);
    p.pc.ontrack =
      p.pc.onicecandidate =
      p.pc.onconnectionstatechange =
      p.pc.oniceconnectionstatechange =
        null;
    p.pc.close();
  }
  disconnected(manual = false) {
    const desired = manual
      ? undefined
      : this.state.watching?.uid || this.desired;
    this.generation++;
    this.token = "";
    this.config = undefined;
    this.hasTurn = undefined;
    this.stop(false);
    this.unwatch(false);
    for (const p of this.peers.values()) this.close(p.to, p.sending);
    this.desired = desired;
    this.restoreUntil = Date.now() + 90000;
    this.update({ self: "", shares: [], clients: [] });
  }
  async stats() {
    const share = this.state.watching;
    const peer = share && this.peers.get(`recv:${share.session}`);
    if (!peer) return;
    const report = await peer.pc.getStats();
    if (this.peers.get(`recv:${share!.session}`) !== peer) return;
    let candidate = "",
      stats: ShareStats | undefined;
    report.forEach((r) => {
      if (r.type === "transport" && r.selectedCandidatePairId) {
        const pair = report.get(r.selectedCandidatePairId);
        const local = pair && report.get(pair.localCandidateId),
          remote = pair && report.get(pair.remoteCandidateId);
        candidate =
          local?.candidateType === "relay" || remote?.candidateType === "relay"
            ? "relay"
            : local?.candidateType || "";
      }
      if (r.type === "inbound-rtp" && r.kind === "video") {
        const elapsed = r.timestamp - this.lastBytes.at;
        stats = {
          width: r.frameWidth || 0,
          height: r.frameHeight || 0,
          fps: r.framesPerSecond || 0,
          bitrate:
            this.lastBytes.at && elapsed > 0
              ? Math.round(
                  ((r.bytesReceived - this.lastBytes.bytes) * 8) / elapsed,
                )
              : 0,
          candidate: "",
          framesDecoded: r.framesDecoded || 0,
        };
        this.lastBytes = { bytes: r.bytesReceived, at: r.timestamp };
      }
    });
    if (stats) {
      stats.candidate = candidate;
      window.__mluvkaShareStats = stats;
      this.update({
        stats,
        ...(peer.pc.connectionState === "connected"
          ? { status: candidate === "relay" ? "Přes TURN" : "Připojeno" }
          : {}),
      });
    }
  }
}
export function useSharing(send: (data: unknown) => void) {
  const ref = useRef<Sharing | null>(null);
  if (!ref.current) ref.current = new Sharing(send);
  const controller = ref.current;
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  useEffect(() => {
    const timer = setInterval(() => {
      void controller.stats().catch(() => {});
    }, 1000);
    window.addEventListener("online", controller.networkChanged);
    const connection = (navigator as Navigator & { connection?: EventTarget })
      .connection;
    connection?.addEventListener("change", controller.networkChanged);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", controller.networkChanged);
      connection?.removeEventListener("change", controller.networkChanged);
      controller.disconnected(true);
    };
  }, [controller]);
  return { controller, state };
}
