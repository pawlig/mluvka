// Kontrakt řízení sdílení bez TS: pozdní snapshot/ack a konečný počet pokusů.
import assert from "node:assert/strict";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
const root = new URL("..", import.meta.url).pathname;
mkdirSync(resolve(root, "tmp-ts3"), { recursive: true });
const temp = mkdtempSync(resolve(root, "tmp-ts3/controller-test-"));
let source;
try {
  writeFileSync(
    resolve(temp, "tsconfig.json"),
    JSON.stringify({
      extends: resolve(root, "tsconfig.json"),
      compilerOptions: {
        noEmit: false,
        allowImportingTsExtensions: false,
        outDir: resolve(temp, "out"),
        rootDir: resolve(root, "frontend/src/sdileni"),
      },
      include: [resolve(root, "frontend/src/sdileni/controller.ts")],
    }),
  );
  execFileSync(resolve(root, "node_modules/.bin/tsc"), [
    "--project",
    resolve(temp, "tsconfig.json"),
  ]);
  source = readFileSync(resolve(temp, "out/controller.js"), "utf8")
    .replace(/^import .* from "react";\n/, "")
    .replaceAll("import.meta.env", "({})");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
const { Sharing } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);
const timers = new Map();
let serial = 0,
  iceServers = [],
  track;
globalThis.window = {};
globalThis.setTimeout = (callback, delay) => {
  const id = ++serial;
  timers.set(id, { callback, delay });
  return id;
};
globalThis.clearTimeout = (id) => timers.delete(id);
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ iceServers, expiresAt: Date.now() / 1000 + 43200 }),
});
const mkTrack = (kind) => ({
  kind,
  id: `${kind}-${++serial}`,
  readyState: "live",
  onended: () => {},
  stop() {
    this.readyState = "ended";
  },
});
const mkStream = (...tracks) => ({
  getTracks: () => tracks,
  getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
  getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
});
// Falešný getDisplayMedia: `display.next` určí odpověď (stream, výjimka nebo čekání).
const display = { next: undefined };
Object.defineProperty(globalThis, "navigator", {
  value: {
    mediaDevices: {
      getDisplayMedia: async () => {
        if (display.next) {
          const next = display.next;
          display.next = undefined;
          return await next();
        }
        track = mkTrack("video");
        return mkStream(track);
      },
    },
  },
  configurable: true,
});
globalThis.RTCRtpReceiver = { getCapabilities: () => undefined };
// Falešný RTCPeerConnection: sendery zaznamenávají volání replaceTrack.
const pcs = [];
globalThis.RTCPeerConnection = class {
  constructor() {
    this.transceivers = [];
    this.signalingState = "stable";
    this.localDescription = { type: "offer", sdp: "x" };
    pcs.push(this);
  }
  mkSender(track) {
    return {
      track,
      calls: [],
      async replaceTrack(t) {
        this.calls.push(t);
        this.track = t;
      },
      getParameters: () => ({}),
    };
  }
  addTrack(track) {
    const sender = this.mkSender(track);
    this.transceivers.push({ sender, receiver: { track } });
    return sender;
  }
  addTransceiver(kind, init) {
    const tx = {
      sender: this.mkSender(null),
      receiver: { track: { kind } },
      direction: init.direction,
    };
    this.transceivers.push(tx);
    return tx;
  }
  getTransceivers() {
    return this.transceivers;
  }
  getSenders() {
    return this.transceivers.map((t) => t.sender);
  }
  createDataChannel() {}
  setConfiguration() {}
  restartIce() {}
  async createOffer() {
    return { type: "offer", sdp: "x" };
  }
  async setLocalDescription() {}
  close() {}
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const connected = () => {
  const messages = [],
    controller = new Sharing((data) => messages.push(data));
  controller.receive({
    type: "share_session",
    session: "self",
    token: "test-session",
  });
  return { controller, messages };
};
const tick = () => {
  const [id, timer] =
    [...timers].find(([, timer]) => timer.delay === 10000) || [];
  assert.ok(timer, "Má existovat konečný timeout spojení");
  timers.delete(id);
  timer.callback();
};
{
  const { controller, messages } = connected();
  await controller.start("720", false);
  const request = messages.find((m) => m.type === "share_start").request;
  assert.equal(controller.state.sharing, false);
  assert.equal(controller.state.starting, true);
  controller.receive({
    type: "share_list",
    sharing: false,
    shares: [],
    clients: [],
    viewers: 0,
  });
  await flush();
  assert.equal(track.readyState, "live");
  assert.equal(controller.state.starting, true);
  controller.receive({ type: "share_started", request });
  await flush();
  assert.equal(controller.state.sharing, true);
  assert.equal(controller.state.starting, false);
  controller.stop();
  assert.equal(track.readyState, "ended");
  const stops = messages.filter((m) => m.type === "share_stop").length;
  controller.receive({ type: "share_started", request });
  await flush();
  assert.equal(
    messages.filter((m) => m.type === "share_stop").length,
    stops + 1,
  );
  assert.equal(controller.state.sharing, false);
  controller.disconnected(true);
  console.log(
    "OK · opožděný share_list před ack zachová capture; pozdní ack po zrušení odešle share_stop",
  );
}
for (const turn of [false, true]) {
  iceServers = turn ? [{ urls: "turn:turn.example.org:3478" }] : [];
  const { controller, messages } = connected();
  controller.watch({
    session: "source",
    client: 2,
    uid: "source-uid",
    name: "Sdílející",
    kind: "screen",
  });
  await flush();
  for (let attempt = 0; attempt < (turn ? 3 : 1); attempt++) tick();
  assert.equal(controller.state.watching, undefined);
  assert.equal(messages.filter((m) => m.type === "watch").length, turn ? 3 : 1);
  assert.equal(messages.at(-1).type, "unwatch");
  assert.match(
    controller.state.error,
    turn ? /třech pokusech/ : /server nemá TURN/,
  );
  assert.equal(timers.size, 0);
  controller.disconnected(true);
  console.log(
    `OK · ${turn ? "s TURN nejvýše tři pokusy" : "bez TURN konečná chyba po 10 s"}, uvolněné sledování i časovače`,
  );
}
// Přepnutí zdroje: replaceTrack ve všech sending peerech, bez nového vyjednání.
const sharing = async (audio) => {
  const { controller, messages } = connected();
  await controller.start("720", audio);
  const request = messages.find((m) => m.type === "share_start").request;
  controller.receive({ type: "share_started", request });
  await flush();
  assert.equal(controller.state.sharing, true);
  return { controller, messages };
};
const viewer = async (controller, from) => {
  controller.receive({ type: "watch", from });
  for (let i = 0; i < 4; i++) await flush();
  return pcs.at(-1);
};
const sender = (pc, kind) =>
  pc.transceivers.find(
    (t) => (t.sender.track ?? t.receiver.track).kind === kind,
  ).sender;
{
  iceServers = [];
  const { controller, messages } = await sharing(false);
  const pc1 = await viewer(controller, "v1");
  const pc2 = await viewer(controller, "v2");
  assert.notEqual(pc1, pc2);
  const oldTrack = track;
  const starts = messages.filter((m) => m.type === "share_start").length;
  const offers = messages.filter((m) => m.type === "rtc_offer").length;
  assert.equal(offers, 2);
  const newVideo = mkTrack("video");
  display.next = async () => mkStream(newVideo);
  await controller.switchSource();
  for (const pc of [pc1, pc2]) {
    const v = sender(pc, "video");
    assert.deepEqual(v.calls, [newVideo]);
    assert.equal(v.track, newVideo);
    assert.deepEqual(sender(pc, "audio").calls, [null]);
  }
  assert.equal(oldTrack.readyState, "ended");
  assert.equal(newVideo.readyState, "live");
  assert.equal(typeof newVideo.onended, "function");
  assert.equal(controller.state.switching, false);
  assert.equal(controller.state.error, "");
  assert.equal(messages.filter((m) => m.type === "share_start").length, starts);
  assert.equal(messages.filter((m) => m.type === "rtc_offer").length, offers);
  // Nový divák po přepnutí dostane nový stream a prázdný audio transceiver.
  const pc3 = await viewer(controller, "v3");
  assert.equal(sender(pc3, "video").track, newVideo);
  assert.ok(pc3.transceivers.some((t) => t.direction === "sendonly"));
  controller.stop();
  controller.disconnected(true);
  console.log(
    "OK · přepnutí zdroje: replaceTrack u všech diváků, starý track zastaven, bez share_start/nové nabídky, nový divák dostane nový stream",
  );
}
{
  const { controller } = await sharing(false);
  const pc = await viewer(controller, "v1");
  const original = track;
  display.next = async () => {
    throw new DOMException("zrušeno", "NotAllowedError");
  };
  await controller.switchSource();
  assert.equal(original.readyState, "live");
  assert.equal(controller.state.error, "");
  assert.equal(controller.state.switching, false);
  assert.deepEqual(sender(pc, "video").calls, []);
  display.next = async () => {
    throw new Error("selhalo");
  };
  await controller.switchSource();
  assert.notEqual(controller.state.error, "");
  assert.equal(original.readyState, "live");
  assert.equal(controller.state.switching, false);
  controller.stop();
  controller.disconnected(true);
  console.log(
    "OK · zrušený výběr bez chyby, jiná chyba ponechá původní stream",
  );
}
{
  const { controller } = await sharing(false);
  const pc = await viewer(controller, "v1");
  const audio = mkTrack("audio");
  display.next = async () => mkStream(mkTrack("video"), audio);
  await controller.switchSource();
  assert.deepEqual(sender(pc, "audio").calls, [audio]);
  assert.equal(sender(pc, "audio").track, audio);
  display.next = async () => mkStream(mkTrack("video"));
  await controller.switchSource();
  assert.deepEqual(sender(pc, "audio").calls, [audio, null]);
  controller.stop();
  controller.disconnected(true);
  console.log(
    "OK · zvuk přidaný do sdílení bez zvuku a poté odebraný (replaceTrack(null))",
  );
}
{
  const { controller } = await sharing(false);
  const pc = await viewer(controller, "v1");
  const late = mkTrack("video");
  let release;
  display.next = () => new Promise((r) => (release = () => r(mkStream(late))));
  const pending = controller.switchSource();
  assert.equal(controller.state.switching, true);
  controller.stop();
  assert.equal(controller.state.switching, false);
  release();
  await pending;
  assert.equal(late.readyState, "ended");
  assert.deepEqual(sender(pc, "video").calls, []);
  assert.equal(controller.state.sharing, false);
  controller.disconnected(true);
  console.log("OK · stop() během výběru zastaví nový stream");
}
