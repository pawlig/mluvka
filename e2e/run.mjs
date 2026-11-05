// Skutečný TS3 + dvě izolované relace Chrome. Testovací hesla vznikají jen v paměti.
import { installSharingCapture, sharingChecks } from "./sdileni.mjs";
import { chromium, expect } from "@playwright/test";
import { mobileChecks, pwaChecks } from "./mobil.mjs";
import {
  jitterChecks,
  installAudioProbe,
  toneCheck,
  mobileAudioCheck,
  vadCheck,
  networkCheck,
  slowReceiverCheck,
  shapeSocket,
  closeShapers,
  fallbackCheck,
  codecRecoveryCheck,
} from "./audio.mjs";
import { resamplingChecks } from "./resampling.mjs";
import { shaperChecks } from "./shaper.mjs";
import { jitterShaperCheck } from "./jitter-shaper.mjs";
import { chatChecks } from "./chat.mjs";
import { fileChecks } from "./soubory.mjs";
import { securityChecks } from "./bezpecnost.mjs";
import { notificationChecks } from "./upozorneni.mjs";
import { invitationChecks } from "./pozvanky.mjs";
import { spawn } from "node:child_process";
import { connect as tcpConnect } from "node:net";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, ".."),
  temp = resolve(root, "tmp-ts3"),
  appPort = process.env.E2E_PORT || "3000",
  base = process.env.E2E_URL || `http://localhost:${appPort}`;
const tsVoicePort = process.env.TS3_VOICE_PORT || "9987",
  tsQueryPort = Number(process.env.TS3_QUERY_PORT || 10011),
  tsFilePort = process.env.TS3_FT_PORT || "30033",
  tsAddress = `127.0.0.1:${tsVoicePort}`;
const admin = process.env.E2E_TS_ADMIN || randomBytes(18).toString("hex"),
  password = randomBytes(12).toString("hex"),
  channelPassword = randomBytes(12).toString("hex");
const tsDir = process.env.TS3_DIR || resolve(temp, "teamspeak3-server_mac");
mkdirSync(temp, { recursive: true });
const uploadDir = mkdtempSync(resolve(root, "tmp-ts3/mluvka-chat-upload-"));
let ts, backend, browser, query;
let backendOutput = "";
let pages = [];
const results = [],
  errors = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function writeReport() {
  writeFileSync(
    resolve(root, "docs/e2e-vysledky.json"),
    JSON.stringify(
      { date: new Date().toISOString(), results, errors },
      null,
      2,
    ) + "\n",
  );
}
function ok(name, details = {}) {
  results.push({ test: name, result: "OK", ...details });
  writeReport();
  console.log(`OK · ${name}`);
}
async function audioStep(step) {
  try {
    await step();
  } catch (error) {
    if (!error.audioMeasurement) throw error;
    results.push(error.audioMeasurement);
    writeReport();
    console.error("FAIL ·", JSON.stringify(error.audioMeasurement));
    process.exitCode = 1;
  }
}
async function eventually(fn, ms = 15000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await wait(150);
    }
  }
  throw last || Error("Vypršel čas čekání");
}
class Query {
  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    this.pending = undefined;
    this.leaves = [];
    this.messages = [];
    this.notifications = "";
    socket.on("data", (data) => {
      this.notifications += data.toString();
      const lines = this.notifications.split(/[\r\n]+/);
      this.notifications = lines.pop();
      for (const line of lines) {
        if (line.startsWith("notifytextmessage ")) {
          const raw = /\bmsg=([^ ]*)/.exec(line)?.[1] || "";
          this.messages.push(raw.replace(/\\([\\/spnr])/g, (_, c) => ({s:" ", p:"|", n:"\n", r:"\r"})[c] || c));
        }
        if (line.startsWith("notifyclientleftview"))
          this.leaves.push({
            client: Number(/\bclid=(\d+)/.exec(line)?.[1]),
            reason: Number(/\breasonid=(\d+)/.exec(line)?.[1]),
          });
      }
      this.buffer += data.toString();
      if (this.pending && /error id=\d+[^\n]*[\r\n]+/.test(this.buffer)) {
        const response = this.buffer;
        this.buffer = "";
        const pending = this.pending;
        this.pending = undefined;
        const code = /error id=(\d+)/.exec(response)?.[1];
        if (code === "0") pending.resolve(response);
        else
          pending.reject(
            Error(`ServerQuery odmítl příkaz ${pending.command} (kód ${code})`),
          );
      }
    });
  }
  async cmd(text) {
    this.buffer = "";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(Error("ServerQuery timeout"));
      }, 5000);
      this.pending = {
        command: text.split(" ")[0],
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.socket.write(`${text}\n`);
    });
  }
}
async function socketOpen(port) {
  return new Promise((res, rej) => {
    const s = tcpConnect({ host: "127.0.0.1", port }, () => res(s));
    s.on("error", rej);
  });
}
async function fillLogin(page, nickname, pass = password) {
  await page.getByLabel("Přezdívka", { exact: true }).fill(nickname);
  await page
    .getByLabel("Adresa serveru", { exact: true })
    .fill(tsAddress);
  await page.getByLabel("Heslo serveru", { exact: false }).fill(pass);
  await page.getByRole("button", { name: /Připojit se/ }).click();
}
async function connected(page) {
  await expect(page.locator(".connection-status")).toHaveText("Připojeno", {
    timeout: 45000,
  });
}
async function moveToProtected(page) {
  if ((await page.locator(".room-title h1").textContent()) === "Večerní parta")
    return;
  await page
    .getByRole("button", { name: "Vstoupit do Večerní parta", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Heslo kanálu" })
    .getByLabel("Heslo kanálu", { exact: true })
    .fill(channelPassword);
  await page
    .getByRole("button", { name: "Vstoupit do kanálu", exact: true })
    .click();
  await expect(page.locator(".room-title h1")).toHaveText("Večerní parta");
}
async function rms(page) {
  return page.evaluate(() => window.__mluvkaStats.rms);
}
async function voiceFlags(clientId) {
  const list = await query.cmd("clientlist -voice");
  const client = list
    .split("|")
    .find((part) => new RegExp(`\\bclid=${clientId}\\b`).test(part));
  return {
    microphone: client?.includes("client_input_muted=1") || false,
    deafen: client?.includes("client_output_muted=1") || false,
  };
}
async function earlyBackendMessages() {
  const probe = new WebSocket(base.replace(/^http/, "ws") + "/ws");
  try {
    const clientId = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("TS nepřijal předčasné WS zprávy")),
        30000,
      );
      const fail = () => {
        clearTimeout(timer);
        reject(Error("Předčasné audio nebo mute ukončilo WS"));
      };
      probe.onerror = fail;
      probe.onclose = fail;
      probe.onopen = () => {
        probe.send(
          JSON.stringify({
            type: "connect",
            nickname: "Časné zprávy",
            server: tsAddress,
            password,
          }),
        );
        const frame = new Uint8Array(1921);
        frame[0] = 1;
        probe.send(frame);
        probe.send(
          JSON.stringify({ type: "mute", microphone: false, deafen: false }),
        );
        probe.send(frame);
        probe.send(
          JSON.stringify({ type: "mute", microphone: true, deafen: true }),
        );
      };
      probe.onmessage = ({ data }) => {
        if (typeof data !== "string") return;
        const msg = JSON.parse(data);
        if (msg.type === "error") {
          fail();
          return;
        }
        if (msg.type !== "state") return;
        clearTimeout(timer);
        resolve(msg.self);
      };
    });
    await expect
      .poll(() => voiceFlags(clientId))
      .toEqual({ microphone: true, deafen: true });
    ok("Backend zahodí audio během navazování a použije poslední mute/deafen");
  } finally {
    probe.close();
  }
}
async function restoredTransmission(mode, muteWhileConnecting) {
  const context = await browser.newContext({ permissions: ["microphone"] });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  try {
    await page.goto(base);
    await page.evaluate(
      ({ mode }) =>
        localStorage.setItem(
          "mluvka.settings",
          JSON.stringify({
            mode,
            threshold: 0.005,
            echo: false,
            noise: false,
            autoGain: false,
          }),
        ),
      { mode },
    );
    await page.reload();
    let releaseConnect;
    let stateReceived = false;
    let closed = false;
    const premature = [],
      controls = [];
    let connectSent;
    const connectQueued = new Promise((resolve) => (connectSent = resolve));
    // Pozdržíme jen connect, aby i rychlý lokální TS zaručil otevřené WS bez state.
    await page.routeWebSocket("**/ws", (route) => {
      const upstream = route.connectToServer();
      route.onMessage((message) => {
        const control =
          typeof message === "string" ? JSON.parse(message) : null;
        if (control?.type === "connect") {
          releaseConnect = () => upstream.send(message);
          connectSent();
          return;
        }
        if (!stateReceived) premature.push(control?.type || "audio");
        if (control) controls.push(control);
        upstream.send(message);
      });
      upstream.onMessage((message) => {
        if (typeof message === "string" && JSON.parse(message).type === "state")
          stateReceived = true;
        route.send(message);
      });
    });
    page.on("websocket", (socket) => socket.on("close", () => (closed = true)));
    await fillLogin(page, "Obnovený hlas");
    await connectQueued;
    await expect(page.locator(".connection-status")).toHaveText("Připojuji…");
    await expect
      .poll(() => page.evaluate(() => window.__mluvkaStats.micRms))
      .toBeGreaterThan(0.02);
    if (muteWhileConnecting) {
      await page
        .getByRole("button", { name: "Ztlumit mikrofon", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Ztlumit mikrofon", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await page
        .getByRole("button", { name: "Ztlumit zvuk", exact: true })
        .click();
    }
    await wait(300);
    expect(premature).toEqual([]);
    expect(await page.evaluate(() => window.__mluvkaStats.sentFrames)).toBe(0);
    releaseConnect();
    await connected(page);
    await expect(
      page.locator(".channel-button").filter({ hasText: "Lobby" }),
    ).toBeVisible();
    await expect(page.locator(".self-card strong")).toHaveText("Obnovený hlas");
    await expect
      .poll(() => controls[0])
      .toEqual({
        type: "mute",
        microphone: muteWhileConnecting,
        deafen: muteWhileConnecting,
      });
    if (muteWhileConnecting) {
      const clientId = await page
        .locator(".client-row")
        .filter({ hasText: "Obnovený hlas" })
        .getAttribute("data-client");
      await expect
        .poll(() => voiceFlags(clientId))
        .toEqual({ microphone: true, deafen: true });
      expect(await page.evaluate(() => window.__mluvkaStats.sentFrames)).toBe(
        0,
      );
      await page
        .getByRole("button", { name: "Ztlumit mikrofon", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Ztlumit zvuk", exact: true })
        .click();
    }
    await expect
      .poll(() => page.evaluate(() => window.__mluvkaStats.sentFrames))
      .toBeGreaterThan(20);
    expect(closed).toBe(false);
    await connected(page);
    ok(
      muteWhileConnecting
        ? "Klik na mute/deafen během připojování přežije a stav se přenese do TS"
        : `Obnovený režim ${mode}: žádné zprávy před state, připojení a hlas pokračují`,
    );
  } finally {
    await context.close();
  }
}
async function uiCheck(page, name) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    ),
  ).toBeLessThanOrEqual(0);
  const controls = await page
    .locator("button:visible,input:visible,select:visible")
    .evaluateAll((elements) =>
      elements
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return (
            r.width > 0 &&
            (r.left < 0 ||
              r.right > innerWidth + 1 ||
              r.bottom > innerHeight + 1)
          );
        })
        .map((e) => e.getAttribute("aria-label") || e.textContent),
    );
  expect(controls).toEqual([]);
  ok(name);
}

function startBackend() {
  backend = spawn(resolve(root, "target/release/mluvka"), [], {
    cwd: root,
    env: {
      ...process.env,
      PORT: appPort,
      ALLOWED_SERVERS: tsAddress,
      UPLOAD_DIR: uploadDir,
      PUBLIC_URL: base,
      TS_FILE_MAX_MB: "1",
      MAX_SESSIONS: "12",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const output of [backend.stdout, backend.stderr])
    output.on("data", (data) => {
      backendOutput = (backendOutput + data.toString()).slice(-200000);
      if (process.env.E2E_DEBUG) process.stderr.write(data);
    });
  backend.on("error", () => {});
}
async function restartBackend() {
  if (process.env.E2E_URL)
    throw Error("Restart vyžaduje lokální backend, bez E2E_URL.");
  const stoppedAt = Date.now();
  const leftBefore = query.leaves.length;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("SIGTERM neukončil backend do 5 s")),
      5000,
    );
    backend.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    backend.kill("SIGTERM");
  });
  const remaining = await query.cmd("clientlist");
  expect(remaining).not.toContain("client_type=0");
  const leaving = query.leaves.slice(leftBefore);
  expect(leaving.length).toBeGreaterThan(0);
  expect(leaving.map((client) => client.reason)).toEqual(leaving.map(() => 8));
  ok(
    "SIGTERM: všechny TS relace zmizely přes clientdisconnect před novým startem",
    {
      elapsedMs: Date.now() - stoppedAt,
      disconnectedClients: leaving.length,
      disconnectReasons: [...new Set(leaving.map((client) => client.reason))],
    },
  );
  startBackend();
  await eventually(async () =>
    expect((await fetch(`${base}/healthz`)).status).toBe(200),
  );
}

try {
  mkdirSync(temp, { recursive: true });
  mkdirSync(resolve(root, "docs/screenshots"), { recursive: true });
  const executable = resolve(
    tsDir,
    process.platform === "darwin" ? "ts3server" : "ts3server",
  );
  if (!existsSync(executable))
    throw Error(
      "Chybí lokální TS3 server. Stáhněte ho do tmp-ts3 podle README nebo nastavte TS3_DIR.",
    );
  if (!process.env.E2E_TS_ADMIN) {
    ts = spawn(
      executable,
      [
        "license_accepted=1",
        `serveradmin_password=${admin}`,
        "query_ip=127.0.0.1",
        "voice_ip=127.0.0.1",
        "query_protocols=raw",
        "filetransfer_ip=127.0.0.1",
        `default_voice_port=${tsVoicePort}`,
        `query_port=${tsQueryPort}`,
        `filetransfer_port=${tsFilePort}`,
      ],
      { cwd: tsDir, stdio: "ignore" },
    );
    ts.on("error", () => {});
  }
  const socket = await eventually(() => socketOpen(tsQueryPort));
  query = new Query(socket);
  await wait(250);
  await query.cmd(`login serveradmin ${admin}`);
  await query.cmd("use 1");
  await query.cmd("servernotifyregister event=server");
  await query.cmd("servernotifyregister event=textserver");
  await query.cmd(
    `serveredit virtualserver_name=Mluvka\\s·\\szkušebna virtualserver_password=${password} virtualserver_needed_identity_security_level=8 virtualserver_antiflood_points_needed_command_block=10000 virtualserver_antiflood_points_needed_ip_block=10000`,
  );
  await query.cmd(
    "servergroupaddperm sgid=8 permsid=b_client_server_textmessage_send permvalue=1 permnegated=0 permskip=0",
  );
  const channels = await query.cmd("channellist");
  const channelIds = [...channels.matchAll(/\bcid=(\d+)/g)].map((m) =>
    Number(m[1]),
  );
  for (const id of channelIds.filter((id) => id !== 1).reverse())
    await query.cmd(`channeldelete cid=${id} force=1`);
  await query.cmd("channeledit cid=1 channel_codec=4");
  if (!channels.includes("channel_name=Lobby"))
    await query.cmd("channeledit cid=1 channel_name=Lobby");
  const created = await query.cmd(
    `channelcreate channel_name=Večerní\\sparta channel_password=${channelPassword} channel_flag_permanent=1 channel_codec=4 channel_topic=Prostor\\spro\\snaši\\spartu`,
  );
  const protectedId = /cid=(\d+)/.exec(created)[1];
  await query.cmd(
    `channelcreate channel_name=Dvojice cpid=${protectedId} channel_flag_permanent=1 channel_codec=4`,
  );
  await query.cmd(
    "channelcreate channel_name=Odpočívárna channel_flag_permanent=1 channel_codec=4",
  );
  ok("Lokální TS3 3.13.7: heslo serveru, kanál s heslem a podkanál");
  if (!process.env.E2E_URL) {
    startBackend();
  }
  await eventually(async () => {
    const response = await fetch(`${base}/healthz`);
    expect(await response.text()).toBe("ok");
  });
  expect((await fetch(base)).status).toBe(200);
  ok("HTTP frontend a /healthz → 200 ok");
  if (!process.env.E2E_FOCUS) {
    await securityChecks(base, ok);
    await earlyBackendMessages();
  }
  const samples = 48000 * 2,
    wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24);
  wav.writeUInt32LE(96000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    wav.writeInt16LE(
      Math.round(Math.sin((i * 2 * Math.PI * 440) / 48000) * 8500),
      44 + i * 2,
    );
  const wavPath = resolve(temp, "test-tone.wav");
  writeFileSync(wavPath, wav);
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      (process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : undefined),
    args: [
      "--use-fake-device-for-media-stream",
      "--disable-audio-output",
      "--disable-background-media-suspend",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${wavPath}`,
      "--autoplay-policy=no-user-gesture-required",
      "--disable-features=HttpsFirstBalancedModeAutoEnable",
    ],
  });
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await newContext(...args);
    await installSharingCapture(context);
    if (process.env.E2E_CODEC === "pcm")
      await context.addInitScript(() => {
        const send = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
          if (typeof data === "string") {
            const msg = JSON.parse(data);
            if (msg.type === "connect") {
              msg.audio = { codec: "pcm", version: 1 };
              data = JSON.stringify(msg);
            }
          }
          return send.call(this, data);
        };
      });
    return context;
  };
  await shaperChecks(ok);
  await jitterShaperCheck(ok);
  await codecRecoveryCheck(ok);
  resamplingChecks(ok);
  jitterChecks(ok);
  if (!process.env.E2E_FOCUS) {
    await pwaChecks({ browser, base, root, ok });
    await restoredTransmission("always", false);
    await restoredTransmission("vad", false);
    await restoredTransmission("always", true);
  }
  if (!process.env.E2E_TAIL) {
    const aContext = await browser.newContext({
        permissions: ["microphone"],
        viewport: { width: 1440, height: 900 },
      }),
      bContext = await browser.newContext({
        permissions: ["microphone"],
        viewport: { width: 1440, height: 900 },
      });
    await installAudioProbe(aContext);
    await installAudioProbe(bContext);
    await aContext.addInitScript(() => {
      const get = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      window.testMicTracks = [];
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const stream = await get(constraints);
        window.testMicTracks.push(...stream.getAudioTracks());
        return stream;
      };
    });
    const a = await aContext.newPage(),
      b = await bContext.newPage();
    let networkProfile = {};
    pages = [a, b];
    for (const p of [a, b]) {
      if (process.env.E2E_DEBUG)
        p.on("websocket", (socket) => {
          console.log("WS opened", p === a ? "A" : "B");
          socket.on("framereceived", ({ payload }) => {
            if (typeof payload === "string") {
              const { type, code, fatal } = JSON.parse(payload);
              console.log("WS reply", { type, code, fatal });
            }
          });
          socket.on("close", () =>
            console.log("WS closed", p === a ? "A" : "B"),
          );
        });
      p.on("pageerror", (e) => errors.push(e.message));
      p.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
    }
    await a.goto(base);
    await b.goto(base);
    await fillLogin(a, "Adam", "zamerne-nespravne");
    await expect(a.getByRole("alert")).toContainText("Nesprávné heslo", {
      timeout: 30000,
    });
    await expect(a.getByRole("button", { name: /Připojit se/ })).toBeEnabled();
    ok("Špatné heslo → česká chyba");
    await fillLogin(a, "Adam");
    await connected(a);
    await b.getByLabel("Zapamatovat i hesla na tomto zařízení").uncheck();
    await fillLogin(b, "Bára");
    await connected(b);
    await expect(
      a.locator(".client-name").filter({ hasText: "Bára" }),
    ).toBeVisible();
    await expect(
      b.locator(".client-name").filter({ hasText: "Adam" }),
    ).toBeVisible();
    ok("Dvě relace se vidí ve stromu TS");
    const beforeUid = await b.evaluate(() => window.__mluvkaStats.uid);
    const list = await query.cmd("clientlist -uid");
    expect(list.replaceAll("\\/", "/")).toContain(beforeUid);
    ok("Identita z prohlížeče odpovídá UID na TS serveru");
    const cContext = await browser.newContext({ permissions: ["microphone"] });
    const c = await cContext.newPage();
    await c.goto(base);
    await fillLogin(c, "Adam");
    await connected(c);
    await expect(c.locator(".self-card strong")).toHaveText("Adam1");
    await cContext.close();
    ok("Obsazená přezdívka se automaticky doplní o 1");
    const live = await query.cmd(
      "channelcreate channel_name=Změny channel_flag_permanent=1 channel_codec=4",
    );
    const liveId = /cid=(\d+)/.exec(live)[1];
    await expect(
      a.locator(".channel-button").filter({ hasText: "Změny" }),
    ).toBeVisible();
    await query.cmd(`channeledit cid=${liveId} channel_name=Přejmenováno`);
    await expect(
      b.locator(".channel-button").filter({ hasText: "Přejmenováno" }),
    ).toBeVisible();
    await query.cmd(`channeldelete cid=${liveId} force=1`);
    await expect(
      a.locator(".channel-button").filter({ hasText: "Přejmenováno" }),
    ).toHaveCount(0);
    ok("Živý vznik, přejmenování a smazání kanálu v obou relacích");
    await moveToProtected(a);
    await moveToProtected(b);
    ok("Přesun obou relací do kanálu s heslem");
    await sharingChecks({ a, b, browser, base, root, query, login: fillLogin, connected, moveToProtected, password, channelPassword, tsAddress, ok });
    if (!process.env.E2E_FOCUS) {
      await notificationChecks({ a, b, bContext, root, query, moveToProtected, ok });
      await invitationChecks({
        a, browser, base, root, password, channelPassword,
        backendLogs: () => backendOutput, ok,
      });
    }
    await a.getByLabel("Zpráva", { exact: true }).fill("Čau Báro, slyšíme se.");
    await a.getByRole("button", { name: "Odeslat zprávu" }).click();
    await expect(b.getByRole("log")).toContainText("Čau Báro, slyšíme se.");
    ok("Chat kanálu A → B");
    if (!process.env.E2E_FOCUS)
      await chatChecks({ a, b, query, base, root, tsAddress, password, ok });
    await a.getByRole("button", { name: "Server", exact: true }).click();
    await b.getByRole("button", { name: "Server", exact: true }).click();
    await a
      .getByLabel("Zpráva", { exact: true })
      .fill("Zpráva celému serveru.");
    await a.getByRole("button", { name: "Odeslat zprávu" }).click();
    await expect(b.getByRole("log")).toContainText("Zpráva celému serveru.");
    ok("Chat serveru A → B");
    await a.locator(".client-row").filter({ hasText: "Bára" }).click();
    await a.getByRole("button", { name: "Napsat zprávu" }).click();
    await a
      .getByLabel("Zpráva", { exact: true })
      .fill("Soukromě jen pro Báru.");
    await a.getByRole("button", { name: "Odeslat zprávu" }).click();
    await b
      .locator(".chat-tabs")
      .getByRole("button", { name: /^Adam(?: |$)/ })
      .click();
    await expect(b.getByRole("log")).toContainText("Soukromě jen pro Báru.");
    ok("Soukromá zpráva A → B");
    await a.getByRole("button", { name: "Nastavení", exact: true }).click();
    for (const label of [
      "Potlačení ozvěny",
      "Potlačení šumu",
      "Automatické zesílení prohlížeče (může zesilovat začátky)",
    ])
      await a.getByLabel(label, { exact: true }).uncheck();
    await expect
      .poll(() =>
        a.evaluate(() => {
          const track = window.testMicTracks.findLast(
            (track) => track.readyState === "live",
          );
          if (!track) return null;
          const { echoCancellation, noiseSuppression, autoGainControl } =
            track.getSettings();
          return { echoCancellation, noiseSuppression, autoGainControl };
        }),
      )
      .toEqual({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      });
    ok(
      "Změny potlačení ozvěny/šumu a AGC se skutečně použijí na mikrofonní stopě",
    );
    await a.getByRole("button", { name: "Hotovo", exact: true }).click();
    await a
      .getByLabel("Režim vysílání", { exact: true })
      .selectOption("always");
    await expect(
      b.locator(".client-row.talking").filter({ hasText: "Adam" }),
    ).toBeVisible({ timeout: 15000 });
    await expect.poll(() => rms(b), { timeout: 15000 }).toBeGreaterThan(0.02);
    const audible = await b.evaluate(() => ({
      ...window.__mluvkaStats,
      uid: undefined,
    }));
    ok(
      "Skutečný mikrofon → Worklet → PCM → Opus → TS → mix → PCM u B",
      audible,
    );
    await audioStep(() => toneCheck(a, b, ok, process.env.E2E_CODEC || "opus", networkProfile));
    networkProfile = await shapeSocket(b);
    // Routing zachytí až nová WS. Čistý tón proto používá skutečnou přímou cestu.
    if (!process.env.E2E_NATIVE) {
      await b.evaluate(() => window.dispatchEvent(new Event("online")));
      await expect.poll(() => networkProfile.connections).toBeGreaterThan(0);
      await connected(b);
      expect(await b.evaluate(() => window.__mluvkaStats.codec)).toBe(process.env.E2E_CODEC || "opus");
      ok("Síťový shaper se připojil až po měření nativního WS");
    }
    await audioStep(() => networkCheck(
      browser,
      a,
      b,
      ok,
      process.env.E2E_CODEC || "opus",
      networkProfile,
      query,
    ));
    await slowReceiverCheck(browser, a, b, ok, process.env.E2E_CODEC || "opus", networkProfile, query);
    await audioStep(() => mobileAudioCheck({ browser, base, ok, codec: process.env.E2E_CODEC || "opus", privateValues: [tsAddress, "Adam", "Bára", password], login: async (page, nick) => {
      await fillLogin(page, nick); await connected(page); await moveToProtected(page);
    } }));
    await b.locator(".client-row").filter({ hasText: "Adam" }).click();
    await b.getByLabel("Lokálně ztlumit", { exact: true }).check();
    await b.getByRole("button", { name: "Zavřít uživatele" }).click();
    await expect.poll(() => rms(b)).toBeLessThan(0.001);
    const sent = await a.evaluate(() => window.__mluvkaStats.sentFrames);
    await expect
      .poll(() => a.evaluate(() => window.__mluvkaStats.sentFrames))
      .toBeGreaterThan(sent + 20);
    ok("Lokální mute A u B → RMS < 0,001, A dál vysílá");
    await b.locator(".client-row").filter({ hasText: "Adam" }).click();
    await b.getByLabel("Lokálně ztlumit", { exact: true }).uncheck();
    await b.getByRole("button", { name: "Zavřít uživatele" }).click();
    await expect.poll(() => rms(b)).toBeGreaterThan(0.02);
    await a
      .getByRole("button", { name: "Ztlumit mikrofon", exact: true })
      .click();
    await expect(
      b
        .locator(".client-row")
        .filter({ hasText: "Adam" })
        .locator(".client-icons > svg"),
    ).toHaveCount(1);
    await expect.poll(() => rms(b)).toBeLessThan(0.001);
    await a
      .getByRole("button", { name: "Ztlumit mikrofon", exact: true })
      .click();
    ok("Mute mikrofonu se propíše do TS a zastaví hlas");
    await b.getByRole("button", { name: "Ztlumit zvuk", exact: true }).click();
    await expect.poll(() => rms(b)).toBeLessThan(0.001);
    await b.getByRole("button", { name: "Ztlumit zvuk", exact: true }).click();
    await expect.poll(() => rms(b)).toBeGreaterThan(0.02);
    ok("Deafen zastaví poslech a po vypnutí obnoví audio");
    await a.getByRole("button", { name: "Nastavení", exact: true }).click();
    await a
      .getByRole("button", { name: "Test mikrofonu", exact: true })
      .click();
    await expect.poll(() => rms(b)).toBeLessThan(0.001);
    await a.getByRole("button", { name: "Ukončit test mikrofonu" }).click();
    await a.getByRole("button", { name: "Hotovo", exact: true }).click();
    ok("Test mikrofonu nic nevysílá na server");
    await a.getByLabel("Režim vysílání", { exact: true }).selectOption("ptt");
    await expect.poll(() => rms(b)).toBeLessThan(0.001);
    await a.getByLabel("Zpráva", { exact: true }).focus();
    await a.keyboard.down("Space");
    await wait(200);
    expect(await rms(b)).toBeLessThan(0.001);
    await a.keyboard.up("Space");
    await a.locator(".room-title h1").click();
    if (process.env.E2E_DEBUG)
      console.log(
        "Mikrofon PTT",
        await a.evaluate(() =>
          window.testMicTracks.map((track) => {
            const {
              echoCancellation,
              noiseSuppression,
              autoGainControl,
              sampleRate,
            } = track.getSettings();
            return {
              state: track.readyState,
              echoCancellation,
              noiseSuppression,
              autoGainControl,
              sampleRate,
            };
          }),
        ),
      );
    await a.keyboard.down("Space");
    await expect.poll(() => rms(b)).toBeGreaterThan(0.02);
    await a.keyboard.up("Space");
    await expect.poll(() => rms(b)).toBeLessThan(0.001);
    ok("PTT reaguje na mezerník mimo textová pole");
    await a.getByLabel("Zpráva", { exact: true }).fill("");
    await a.getByLabel("Režim vysílání", { exact: true }).selectOption("vad");
    await a.getByRole("button", { name: "Nastavení", exact: true }).click();
    await a.getByLabel("Práh hlasové aktivace", { exact: true }).fill("0.005");
    await a.getByRole("button", { name: "Hotovo", exact: true }).click();
    await expect.poll(() => rms(b)).toBeGreaterThan(0.02);
    ok("Hlasová aktivace vysílá nad prahem");
    await b.getByRole("button", { name: "Odpojit", exact: true }).click();
    await expect(b.getByLabel("Přezdívka", { exact: true })).toBeVisible();
    await b.reload();
    expect(await b.getByLabel("Přezdívka", { exact: true }).inputValue()).toBe(
      "Bára",
    );
    expect(
      await b.getByLabel("Heslo serveru", { exact: false }).inputValue(),
    ).toBe("");
    await b.locator("details").evaluate((el) => (el.open = true));
    await b.getByLabel("Heslo kanálu", { exact: true }).fill(channelPassword);
    await fillLogin(b, "Bára");
    await connected(b);
    expect(await b.evaluate(() => window.__mluvkaStats.uid)).toBe(beforeUid);
    expect(
      (await query.cmd("clientlist -uid")).replaceAll("\\/", "/"),
    ).toContain(beforeUid);
    ok("Obnovení: stejné UID na TS, údaje uloženy bez hesel");
    await moveToProtected(b);
    await a
      .getByLabel("Režim vysílání", { exact: true })
      .selectOption("always");
    await a
      .locator(".chat-tabs")
      .getByRole("button", { name: "Kanál", exact: true })
      .click();
    await b
      .locator(".chat-tabs")
      .getByRole("button", { name: "Kanál", exact: true })
      .click();
    await uiCheck(a, "Desktop 1440×900: žádný přesah ani ovládání mimo okno");
    await a.screenshot({ path: resolve(root, "docs/screenshots/desktop.png") });
    await b.setViewportSize({ width: 390, height: 844 });
    await uiCheck(b, "Mobil 390×844: strom bez přesahu");
    await b.screenshot({ path: resolve(root, "docs/screenshots/mobil.png") });
    await b.getByRole("button", { name: "Chat", exact: true }).click();
    await uiCheck(b, "Mobil 390×844: chat bez přesahu");
    await b.screenshot({
      path: resolve(root, "docs/screenshots/mobil-chat.png"),
    });
    await aContext.close();
    await expect
      .poll(async () => {
        const r = await query.cmd("clientlist");
        return r.includes("client_nickname=Adam");
      })
      .toBe(false);
    ok("Zavření prohlížeče odpojí jeho TS klienta");
    await bContext.close();
    await networkProfile.close?.();
  }
  await vadCheck({
    browser,
    base,
    login: fillLogin,
    ok,
    codec: process.env.E2E_CODEC || "opus",
  });
  await fallbackCheck(browser, base, fillLogin, ok);
  await mobileChecks({
    browser,
    base,
    root,
    password,
    channelPassword,
    query,
    ok,
    restartBackend,
  });
  if (!process.env.E2E_FOCUS || process.env.E2E_FOCUS === "files") {
    // Velké souborové payloady a jejich GC patří až za měření latence zvuku.
    const fileContexts = await Promise.all(
      [0, 1].map(() => browser.newContext({
        permissions: ["microphone"],
        viewport: { width: 1440, height: 900 },
      })),
    );
    try {
      const [a, b] = await Promise.all(fileContexts.map((context) => context.newPage()));
      pages = [a, b];
      for (const page of pages) {
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        await page.goto(base);
      }
      await fillLogin(a, "Adam");
      await connected(a);
      await fillLogin(b, "Bára");
      await connected(b);
      await moveToProtected(a);
      await moveToProtected(b);
      for (const page of pages)
        await page.getByRole("button", { name: "Server", exact: true }).click();
      await fileChecks({ a, b, query, base, root, tsAddress, password, channelPassword, ok });
    } finally {
      await Promise.all(fileContexts.map((context) => context.close()));
    }
  }
  const timing = backendOutput.split("\n").flatMap((line) => {
    const match = /audio_timing=(\{.*\})/.exec(line.replace(/\u001b\[[0-9;]*m/g, ""));
    if (!match) return [];
    try { return [JSON.parse(match[1])]; } catch { return []; }
  });
  if (timing.length) ok("Backend: histogram mezer mixu a WS writeru bez osobních údajů", { timing });
  expect(errors).toEqual([]);
  ok("Žádné JS výjimky ani chyby konzole v obou relacích");
  writeFileSync(
    resolve(root, "docs/e2e-vysledky.json"),
    JSON.stringify(
      { date: new Date().toISOString(), results, errors },
      null,
      2,
    ) + "\n",
  );
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  for (const page of pages) {
    try {
      console.error(
        await Promise.race([
          page.evaluate(() => ({
            stats: { ...window.__mluvkaStats, uid: undefined },
            error: document.querySelector(".toast")?.textContent,
            status: document.querySelector(".connection-status")?.textContent,
            visibility: document.visibilityState,
            mode: document.querySelector(".mode-select select")?.value,
          })),
          wait(1000).then(() => ({ diagnostic: "JS nereaguje" })),
        ]),
      );
    } catch {}
  }
  if (process.env.E2E_DEBUG) console.error("Backend diagnostika", backendOutput);
  process.exitCode = 1;
} finally {
  query?.socket.destroy();
  await Promise.all(
    [backend, ts].map(
      (child) =>
        new Promise((resolve) => {
          if (!child || child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 5000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
          child.kill("SIGTERM");
        }),
    ),
  );
  await Promise.race([browser?.close(), wait(5000)]);
  await closeShapers();
  rmSync(uploadDir, { recursive: true, force: true });
}
