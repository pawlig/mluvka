// Kontrakt řízení sdílení bez TS: pozdní snapshot/ack a konečný počet pokusů.
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
const root = new URL("..", import.meta.url).pathname;
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
Object.defineProperty(globalThis, "navigator", {
  value: {
    mediaDevices: {
      getDisplayMedia: async () => {
        track = {
          kind: "video",
          readyState: "live",
          stop() {
            this.readyState = "ended";
          },
        };
        const video = track;
        return { getTracks: () => [video], getVideoTracks: () => [video] };
      },
    },
  },
  configurable: true,
});
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
