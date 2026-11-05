import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { strict as assert } from "node:assert";
import { expect } from "@playwright/test";

function processor(rate = 48000) {
  let Type;
  const events = [];
  runInNewContext(
    readFileSync(
      new URL("../frontend/public/audio-worklet.js", import.meta.url),
      "utf8",
    ),
    {
      sampleRate: rate,
      AudioWorkletProcessor: class {
        port = { postMessage: (data) => events.push(data) };
      },
      registerProcessor: (_, type) => {
        Type = type;
      },
    },
  );
  return { node: new Type(), events };
}
export function jitterChecks(ok) {
  for (const speed of [1, 1.01, 0.99]) {
    const { node, events } = processor();
    node.opus = true;
    let next = 0,
      phase = 0,
      min = Infinity,
      max = 0,
      jump = 0,
      last = 0;
    const duration = speed === 1 ? 30 : 60;
    // Render quantum i příchod rámců se řídí dvěma nezávislými hodinami.
    for (let t = 0; t < 48000 * duration; t += 128) {
      while (next <= t) {
        const pcm = Int16Array.from({ length: 960 }, () =>
          Math.round(
            0.5 * 32767 * Math.sin((phase++ * 2 * Math.PI * 440) / 48000),
          ),
        );
        node.port.onmessage({ data: { pcm: pcm.buffer } });
        next += 960 / speed;
      }
      const output = new Float32Array(128);
      node.process([], [[output]]);
      if (t > 48000) {
        const ms = (node.write - node.read) / 48;
        min = Math.min(min, ms);
        max = Math.max(max, ms);
        for (const x of output) {
          jump = Math.max(jump, Math.abs(x - last));
          last = x;
        }
      } else last = output.at(-1);
    }
    const underruns = events.filter((e) => e.underrun).length,
      dropped = events.filter((e) => e.dropped).length;
    assert.equal(events.filter((event) => event.plc).length, 0);
    assert.equal(underruns, 0);
    assert.equal(dropped, 0);
    assert.ok(jump < 0.3);
    if (speed === 1) assert.ok(min >= 40 && max <= 120, `buffer ${min}–${max}`);
    if (speed !== 1) assert.ok(Math.abs(node.correction) > 0.001);
    ok(`Jitter buffer ${duration} s, takt ${speed}: bez podtečení a zahození`, {
      underruns,
      droppedFrames: dropped,
      maxJump: jump,
      minBufferMs: min,
      maxBufferMs: max,
      driftPercent: node.correction * 100,
    });
  }
  const { node, events } = processor();
  const tone = Int16Array.from({ length: 960 }, (_, i) =>
    Math.round(16384 * Math.cos((i * 2 * Math.PI * 440) / 48000)),
  );
  let last = 0,
    jump = 0;
  for (let i = 0; i < 500; i++) {
    if ((i < 30 && i % 7 === 0) || (i > 250 && i % 7 === 0))
      node.port.onmessage({ data: { pcm: tone.buffer } });
    const output = new Float32Array(128);
    node.process([], [[output]]);
    for (const x of output) {
      jump = Math.max(jump, Math.abs(x - last));
      last = x;
    }
  }
  assert.ok(events.some((e) => e.underrun));
  // Samostatný test fade-out s konstantním vstupem: skok při podtečení < 0,01.
  const fade = processor().node;
  for (let i = 0; i < 3; i++)
    fade.port.onmessage({
      data: { pcm: new Int16Array(960).fill(16384).buffer },
    });
  last = 0;
  jump = 0;
  for (let i = 0; i < 60; i++) {
    const out = new Float32Array(128);
    fade.process([], [[out]]);
    for (const x of out) {
      jump = Math.max(jump, Math.abs(x - last));
      last = x;
    }
  }
  assert.ok(jump < 0.01);
  ok("Podtečení a obnovení používají plynulé prolnutí", { fadeMaxJump: jump });
}

export async function installAudioProbe(context) {
  await context.addInitScript(() => {
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", ({ data }) => {
          if (typeof data === "string") return;
          const now = performance.now();
          window.testBinaryGapMs = Math.max(
            window.testBinaryGapMs || 0,
            now - (window.testBinaryAt || now),
          );
          window.testBinaryAt = now;
        });
      }
    };
    const NativeNode = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends NativeNode {
      constructor(...args) {
        super(...args);
        window.testAudioNode = this;
        window.testCapturedRms = [];
        this.port.addEventListener("message", ({ data }) => {
          if (!data.pcm) return;
          const pcm = new Int16Array(data.pcm);
          window.testCapturedRms.push(
            Math.sqrt(
              pcm.reduce((s, x) => s + (x / 32768) ** 2, 0) / pcm.length,
            ),
          );
          if (window.testCapturedRms.length > 500)
            window.testCapturedRms.shift();
        });
      }
    };
    const send = Worker.prototype.postMessage;
    window.testEncodedRms = [];
    Worker.prototype.postMessage = function (data, ...args) {
      if (data.encode) {
        const pcm = new Int16Array(data.encode);
        window.testEncodedRms.push(
          Math.sqrt(pcm.reduce((s, x) => s + (x / 32768) ** 2, 0) / pcm.length),
        );
        if (window.testEncodedRms.length > 500) window.testEncodedRms.shift();
      }
      return send.call(this, data, ...args);
    };
  });
}
export async function toneCheck(a, b, ok, codec, profile) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Změna captureru a otevření kodeku nesmějí vstoupit do měření ustáleného hovoru.
  await b.waitForTimeout(5000);
  await expect
    .poll(() => b.evaluate(() => window.__mluvkaStats.bufferMs), {
      timeout: 15000,
    })
    .toBeLessThanOrEqual(120);
  await b.evaluate(() => {
    const node = window.testAudioNode;
    const analyser = node.context.createAnalyser();
    analyser.fftSize = 16384;
    node.connect(analyser);
    window.testAnalyser = analyser;
    window.__mluvkaStats.underruns = 0;
    window.__mluvkaStats.droppedFrames = 0;
    window.__mluvkaStats.plcFrames = 0;
    window.__mluvkaStats.lostFrames = 0;
    window.testBinaryGapMs = 0;
    window.testBinaryAt = performance.now();
    node.port.postMessage({ resetMetrics: true });
  });
  profile.inputGapMs = profile.outputGapMs = 0;
  profile.inputAt = profile.outputAt = Date.now();
  let min = Infinity,
    max = 0,
    maxDown = 0;
  const start = Date.now();
  let powers = [],
    frequencyStep = 0;
  while (Date.now() - start < 30000) {
    await wait(1000);
    const { stats, bins, step } = await b.evaluate(() => {
      const analyser = window.testAnalyser;
      const db = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(db);
      const step = window.testAudioNode.context.sampleRate / analyser.fftSize;
      return {
        stats: { ...window.__mluvkaStats, uid: undefined },
        bins: [...db.slice(Math.ceil(100 / step), Math.ceil(1000 / step))],
        step,
      };
    });
    frequencyStep = step;
    bins.forEach((db, i) => {
      powers[i] = (powers[i] || 0) + 10 ** (db / 10);
    });
    if (process.env.E2E_FOCUS)
      console.log("tone second", Math.round((Date.now() - start) / 1000), {
        rms: stats.rms,
        buffer: stats.bufferMs,
        underruns: stats.underruns,
        plc: stats.plcFrames,
      });
    min = Math.min(min, stats.bufferMs);
    max = Math.max(max, stats.bufferMs);
    maxDown = Math.max(maxDown, stats.downKbps);
  }
  const measurement = await b.evaluate(() => {
    const samples = new Float32Array(window.testAnalyser.fftSize);
    window.testAnalyser.getFloatTimeDomainData(samples);
    return {
      samples: [...samples],
      rate: window.testAudioNode.context.sampleRate,
      binaryGapMs: window.testBinaryGapMs,
      stats: { ...window.__mluvkaStats, uid: undefined },
    };
  });
  const dominantHz =
    (powers.indexOf(Math.max(...powers)) + Math.ceil(100 / frequencyStep)) *
    frequencyStep;
  const outputRms = measurement.stats.outputRms;
  const inputRms = await a.evaluate(
    () => window.testCapturedRms.slice(-50).reduce((s, x) => s + x, 0) / 50,
  );
  const rmsDifferenceDb = inputRms
    ? 20 * Math.log10(outputRms / inputRms)
    : null;
  if (process.env.E2E_FOCUS)
    console.log("tone metrics", {
      outputRms,
      inputRms,
      dominantHz,
      rmsDifferenceDb,
      min,
      max,
      maxDown,
    });
  const timing = {
    binaryGapMs: measurement.binaryGapMs,
    inputGapMs: profile.inputGapMs,
    outputGapMs: profile.outputGapMs,
  };
  expect(measurement.stats.codec).toBe(codec);
  {
    expect(
      measurement.stats.plcFrames,
      JSON.stringify({ ...measurement.stats, ...timing }),
    ).toBe(0);
    expect(
      measurement.stats.underruns,
      JSON.stringify({ ...measurement.stats, ...timing }),
    ).toBe(0);
    expect(measurement.stats.droppedFrames).toBe(0);
    expect(min).toBeGreaterThanOrEqual(40);
    expect(max).toBeLessThanOrEqual(120);
  }
  expect(measurement.stats.maxJump).toBeLessThan(0.3);
  expect(Math.abs(dominantHz - 440)).toBeLessThanOrEqual(5);
  expect(Math.abs(rmsDifferenceDb)).toBeLessThanOrEqual(1.5);
  if (codec === "opus") {
    expect(maxDown).toBeLessThanOrEqual(130);
  }
  ok(`TS3 tón 440 Hz / ${codec}, 30 s bez podtečení`, {
    underruns: measurement.stats.underruns,
    plcFrames: measurement.stats.plcFrames,
    lostFrames: measurement.stats.lostFrames,
    ...timing,
    maxJump: measurement.stats.maxJump,
    minBufferMs: min,
    maxBufferMs: max,
    dominantHz,
    rmsDifferenceDb,
    maxDownKbps: maxDown,
  });
}

export async function vadCheck({ browser, base, login, ok, codec }) {
  const sender = await browser.newContext({ permissions: ["microphone"] });
  const receiver = await browser.newContext({ permissions: ["microphone"] });
  await installAudioProbe(sender);
  await installAudioProbe(receiver);
  await sender.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext({ sampleRate: 48000 });
      const tone = context.createOscillator(),
        gain = context.createGain(),
        destination = context.createMediaStreamDestination();
      tone.frequency.value = 440;
      gain.gain.value = 0;
      tone.connect(gain).connect(destination);
      tone.start();
      await context.resume();
      window.testSignal = { context, gain };
      return destination.stream;
    };
  });
  await receiver.addInitScript(() => {
    const NativeWorker = Worker;
    window.testReceived = [];
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", ({ data }) => {
          if (data.decoded) window.testReceived.push(data.rms);
        });
      }
    };
    const post = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (data, ...args) {
      if (data?.pcm) {
        const pcm = new Int16Array(data.pcm);
        window.testReceived.push(
          Math.sqrt(pcm.reduce((s, x) => s + (x / 32768) ** 2, 0) / pcm.length),
        );
        if (window.testReceived.length > 1000) window.testReceived.shift();
      }
      return post.call(this, data, ...args);
    };
  });
  for (const [context, mode] of [
    [sender, "vad"],
    [receiver, "ptt"],
  ])
    await context.addInitScript(
      ({ mode }) => {
        localStorage.setItem("mluvka.settingsVersion", "2");
        localStorage.setItem(
          "mluvka.settings",
          JSON.stringify({
            mode,
            threshold: 0.035,
            autoGain: false,
            echo: false,
            noise: false,
            beep: false,
          }),
        );
      },
      { mode },
    );
  const a = await sender.newPage(),
    b = await receiver.newPage();
  try {
    await a.goto(base);
    await b.goto(base);
    for (const page of [a, b]) {
      await expect(page.getByLabel("Přezdívka", { exact: true })).toBeVisible();
    }
    await login(a, "VAD tón");
    await login(b, "VAD poslech");
    // Sdílené 45s okno může odložit nový TS handshake déle než původních 40 s.
    await expect(a.locator(".connection-status")).toHaveText("Připojeno", {
      timeout: 90000,
    });
    await expect(b.locator(".connection-status")).toHaveText("Připojeno", {
      timeout: 90000,
    });
    await a.waitForTimeout(3000);
    expect(await a.evaluate(() => window.__mluvkaStats.sentFrames)).toBe(0);
    await b.evaluate(() => {
      window.testReceived = [];
    });
    // Bránu řídí skutečný čas testu; samostatný zdrojový AudioContext má vlastní takt.
    await a.evaluate(() => {
      window.testSignal.gain.gain.value = 0.02;
    });
    await a.waitForTimeout(80);
    await a.evaluate(() => {
      window.testSignal.gain.gain.value = 0.5;
    });
    await a.waitForTimeout(3000);
    await a.evaluate(() => {
      window.testSignal.gain.gain.value = 0;
    });
    await b.waitForTimeout(1200);
    const levels = await b.evaluate(() => window.testReceived);
    const high = levels.findIndex((x) => x > 0.04);
    expect(high).toBeGreaterThanOrEqual(0);
    const first = Math.sqrt(
      levels.slice(high, high + 10).reduce((s, x) => s + x * x, 0) / 10,
    );
    const steady = Math.sqrt(
      levels.slice(high + 50, high + 150).reduce((s, x) => s + x * x, 0) / 100,
    );
    const onsetDb = 20 * Math.log10(first / steady);
    if (process.env.E2E_FOCUS)
      console.log("VAD metriky", {
        high,
        count: levels.length,
        steadyCount: levels.slice(high + 50, high + 150).filter((x) => x > 0.05)
          .length,
        onsetDb,
        first,
        steady,
        levels: levels.slice(Math.max(0, high - 5), high + 15),
      });
    const precursorFrames = levels
      .slice(Math.max(0, high - 5), high)
      .filter((x) => x > 0.003 && x < 0.04).length;
    expect(onsetDb).toBeLessThanOrEqual(3);
    expect(precursorFrames).toBeGreaterThanOrEqual(3); // nejméně 60 z 80 ms, nejvýše 20 ms ztraceno
    await expect
      .poll(() => a.evaluate(() => window.__mluvkaStats.sentFrames))
      .toBeGreaterThan(100);
    const frames = await a.evaluate(() => window.__mluvkaStats.sentFrames);
    await a.waitForTimeout(500);
    expect(await a.evaluate(() => window.__mluvkaStats.sentFrames)).toBe(
      frames,
    );
    ok(`VAD / ${codec}: ticho 3 s, předběh a vyrovnaný začátek`, {
      onsetDb,
      precursorMs: precursorFrames * 20,
      lostOnsetMs: Math.max(0, 80 - precursorFrames * 20),
      firstRms: first,
      steadyRms: steady,
    });
  } catch (error) {
    console.error(
      "VAD diagnostika",
      await Promise.all(
        [a, b].map((page) =>
          page.evaluate(() => ({
            status: document.querySelector(".connection-status")?.textContent,
            form: !!document.querySelector('input[name="nickname"]'),
            text: document.querySelector(".toast")?.textContent,
            body: document.body.innerText.slice(0, 1500),
          })),
        ),
      ),
    );
    throw error;
  } finally {
    await sender.close();
    await receiver.close();
  }
}
export async function networkCheck(browser, a, b, ok, codec, profile, query) {
  const cdp = profile.cdp;
  profile.latency = 80;
  profile.bitsPerSecond = 1500000;
  profile.next = 0;
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 80,
    downloadThroughput: 1500000 / 8,
    uploadThroughput: 1500000 / 8,
  });
  await b.waitForTimeout(5000);
  await b.evaluate(() => {
    window.__mluvkaStats.underruns = 0;
    window.__mluvkaStats.droppedFrames = 0;
    window.__mluvkaStats.plcFrames = 0;
    window.__mluvkaStats.lostFrames = 0;
  });
  profile.inputGapMs = profile.outputGapMs = 0;
  profile.inputAt = profile.outputAt = Date.now();
  await b.waitForTimeout(30000);
  const stats = await b.evaluate(() => ({
    ...window.__mluvkaStats,
    uid: undefined,
  }));
  expect(
    stats.underruns,
    JSON.stringify({
      stats,
      inputGapMs: profile.inputGapMs,
      outputGapMs: profile.outputGapMs,
    }),
  ).toBe(0);
  ok(`CDP síť 1,5 Mb/s / 80 ms, ${codec}, 30 s`, {
    underruns: stats.underruns,
    downKbps: stats.downKbps,
    plcFrames: stats.plcFrames,
    note: "CDP doplněné skutečným WS shaperem: 1,5 Mb/s a 80 ms pro binární rámce.",
  });
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  profile.latency = 0;
  profile.bitsPerSecond = Infinity;
  // Již naplánované rámce mají přednost i při snížení latence.
  await cdp.send("Debugger.enable");
  const sent = await a.evaluate(() => window.__mluvkaStats.sentFrames);
  const bid = Number(
    await b
      .locator(".client-row")
      .filter({ hasText: "Bára" })
      .getAttribute("data-client"),
  );
  const leftBefore = query.leaves.length;
  await cdp.send("Debugger.pause");
  try {
    await a.waitForTimeout(10000);
    const clients = await query.cmd("clientlist");
    expect(clients).toContain("client_nickname=Adam");
    if (!clients.includes("client_nickname=Bára")) {
      expect(
        query.leaves.slice(leftBefore).find((client) => client.client === bid)
          ?.reason,
      ).toBe(8);
    }
    await a.waitForTimeout(10000);
    await expect(a.locator(".connection-status")).toHaveText("Připojeno");
    expect(
      await a.evaluate(() => window.__mluvkaStats.sentFrames),
    ).toBeGreaterThan(sent + 500);
  } finally {
    await cdp.send("Debugger.resume").catch(() => {});
  }
  await expect(b.locator(".connection-status")).toHaveText("Připojeno", {
    timeout: 90000,
  });
  await expect
    .poll(() => b.evaluate(() => window.__mluvkaStats.rms), { timeout: 15000 })
    .toBeGreaterThan(0.02);
  const leaves = query.leaves
    .slice(leftBefore)
    .filter((client) => client.client === bid);
  expect(leaves.map((client) => client.reason)).toEqual(leaves.map(() => 8));
  ok(
    `Pomalý příjemce ${codec}: Debugger.pause 20 s, A drží spojení a B obnoví zvuk`,
    { cleanReconnect: leaves.length > 0, disconnectReason: leaves[0]?.reason },
  );
  await cdp.detach();
}

// CDP samotné nemusí škrtit WS. Tento obal zpozdí skutečné binární WS rámce
// a rozpočítá jejich bajty na sériovou linku; pořadí i payload zůstávají zachované.
export async function shapeSocket(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  if (process.env.E2E_NATIVE) return { cdp };
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  const profile = { latency: 0, bitsPerSecond: Infinity, next: 0, cdp };
  await page.routeWebSocket("**/ws", (route) => {
    const server = route.connectToServer();
    route.onMessage((data) => server.send(data));
    server.onMessage((data) => {
      if (typeof data === "string") {
        route.send(data);
        return;
      }
      const now = Date.now();
      profile.inputGapMs = Math.max(
        profile.inputGapMs || 0,
        now - (profile.inputAt || now),
      );
      profile.inputAt = now;
      const delivery = Math.max(now + profile.latency, profile.next);
      profile.next = delivery + (data.length * 8000) / profile.bitsPerSecond;
      const deliver = () => {
        try {
          const at = Date.now();
          profile.outputGapMs = Math.max(
            profile.outputGapMs || 0,
            at - (profile.outputAt || at),
          );
          profile.outputAt = at;
          route.send(data);
        } catch {}
      };
      const delay = delivery - now;
      if (delay <= 0) deliver();
      else setTimeout(deliver, delay).unref();
    });
    server.onClose(() => route.close());
    route.onClose(() => server.close());
  });
  return profile;
}

export async function fallbackCheck(browser, base, login, ok) {
  const context = await browser.newContext({ permissions: ["microphone"] });
  await context.addInitScript(() => {
    window.Worker = class {
      constructor() {
        throw Error("Simulovaná chyba WASM Workeru");
      }
    };
  });
  const page = await context.newPage();
  try {
    await page.goto(base);
    await page.evaluate(() => {
      localStorage.setItem(
        "mluvka.settings",
        JSON.stringify({ autoGain: true, echo: false, noise: false }),
      );
      localStorage.removeItem("mluvka.settingsVersion");
    });
    await page.reload();
    expect(
      await page.evaluate(
        () => JSON.parse(localStorage.getItem("mluvka.settings")).autoGain,
      ),
    ).toBe(false);
    await page
      .getByRole("button", { name: "Nastavení zvuku", exact: true })
      .click();
    await page
      .getByLabel("Automatické zesílení prohlížeče (může zesilovat začátky)", {
        exact: true,
      })
      .check();
    await page.reload();
    expect(
      await page.evaluate(
        () => JSON.parse(localStorage.getItem("mluvka.settings")).autoGain,
      ),
    ).toBe(true);
    ok("Migrace AGC proběhne jednou a pozdější výslovná volba přežije reload");
    await login(page, "PCM záloha");
    await expect(page.locator(".connection-status")).toHaveText("Připojeno", {
      timeout: 90000,
    });
    expect(await page.evaluate(() => window.__mluvkaStats.codec)).toBe("pcm");
    await expect
      .poll(() => page.evaluate(() => window.__mluvkaStats.receivedFrames))
      .toBeGreaterThan(10);
    ok("Selhání konstruktoru WASM Workeru: vyjedná se funkční PCM");
  } finally {
    await context.close();
  }
}

export async function codecRecoveryCheck(ok) {
  // Spustí skutečný Worker handler s reálným libopus, jen port nahradí sběračem.
  const { stripTypeScriptTypes } = await import("node:module");
  const { Application, createEncoder, createDecoder } =
    await import("libopus-wasm");
  const source = stripTypeScriptTypes(
    readFileSync(
      new URL("../frontend/src/codec-worker.ts", import.meta.url),
      "utf8",
    ),
  ).replace(/import\s*\{[\s\S]*?\}\s*from\s*"libopus-wasm";/, "");
  const messages = [],
    scope = {};
  const handler = new Function(
    "Application",
    "createEncoder",
    "createDecoder",
    "postMessage",
    "self",
    `${source}\nreturn self.onmessage;`,
  )(
    Application,
    createEncoder,
    createDecoder,
    (data) => messages.push(data),
    scope,
  );
  await handler({ data: { init: true, quality: "high" } });
  const encoder = await createEncoder({
    channels: 1,
    application: Application.Voip,
    frameSize: 960,
    bitrate: 64000,
    fec: true,
  });
  let phase = 0;
  async function frame(sequence) {
    const pcm = Int16Array.from({ length: 960 }, () =>
      Math.round(Math.sin((phase++ * 2 * Math.PI * 440) / 48000) * 8000),
    );
    const opus = encoder.encode(pcm),
      packet = new Uint8Array(opus.length + 5);
    packet[0] = 4;
    new DataView(packet.buffer).setUint32(1, sequence, true);
    packet.set(opus, 5);
    await handler({ data: { decode: packet.buffer } });
  }
  await frame(0);
  for (let i = 0; i < 30; i++) await handler({ data: { plc: true } });
  const before = messages.filter((m) => m.pcm).length;
  for (let sequence = 1; sequence <= 40; sequence++) await frame(sequence);
  assert.equal(
    messages.filter((m) => m.resynced).length,
    30,
    "pozdní pakety musí aktualizovat dekodér",
  );
  assert.equal(
    messages.filter((m) => m.pcm).length,
    before + 10,
    "skutečné opožděné pakety se po PLC nesmějí zablokovat",
  );
  assert.equal(messages.filter((m) => m.failed).length, 0);
  const recovered = new Int16Array(messages.filter((m) => m.pcm).at(-1).pcm);
  assert.ok(
    Math.sqrt(
      recovered.reduce((s, x) => s + (x / 32768) ** 2, 0) / recovered.length,
    ) > 0.1,
  );
  await frame(42);
  assert.equal(messages.filter((m) => m.lost).at(-1).lost, 1);
  encoder.free();
  const audioSource = stripTypeScriptTypes(
    readFileSync(new URL("../frontend/src/audio.ts", import.meta.url), "utf8"),
  )
    .replace("export class AudioEngine", "class AudioEngine")
    .replaceAll("import.meta.url", '"http://test.invalid/audio.ts"');
  let clock = 0,
    sent = 0;
  const testWindow = new EventTarget();
  let micCalls = 0,
    stopped = 0;
  const testNavigator = {
    permissions: { query: async () => ({ state: "granted" }) },
    mediaDevices: {
      removeEventListener() {},
      enumerateDevices: async () => [],
      getUserMedia: async () => {
        micCalls++;
        const track = {
          readyState: "live",
          enabled: true,
          addEventListener() {},
          getSettings: () => ({}),
          stop() {
            this.readyState = "ended";
            stopped++;
          },
        };
        return { getTracks: () => [track], getAudioTracks: () => [track] };
      },
    },
  };
  const Engine = new Function(
    "window",
    "performance",
    "navigator",
    `${audioSource}\nreturn AudioEngine;`,
  )(testWindow, { now: () => clock }, testNavigator);
  const engine = new Engine(
    {},
    () => {},
    () => {
      sent++;
    },
  );
  for (let i = 0; i < 100; i++) engine.emitFrame(new ArrayBuffer(32));
  assert.equal(
    sent,
    8,
    "nahromaděné rámce nesmějí vytvořit neomezenou WS dávku",
  );
  for (let i = 0; i < 50; i++) {
    clock += 20;
    engine.emitFrame(new ArrayBuffer(32));
  }
  assert.equal(
    sent,
    58,
    "běžných 50 rámců/s musí pokračovat po zahození dávky",
  );
  const attachContext = (target = engine) => {
    target.context = {
      state: "running",
      removeEventListener() {},
      close: async () => {},
      resume: async () => {},
      createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    };
    target.node = { disconnect() {} };
  };
  attachContext();
  await engine.changeInput();
  assert.equal(micCalls, 1);
  const retained = engine.stream;
  await engine.close();
  assert.equal(stopped, 0, "odpojení drží mikrofon pro další připojení");
  assert.equal(retained.getAudioTracks()[0].enabled, false);
  attachContext();
  await engine.changeInput();
  assert.equal(micCalls, 1, "nové připojení použije původní MediaStream");
  assert.equal(engine.stream, retained);
  assert.equal(retained.getAudioTracks()[0].enabled, true);
  await engine.changeInput(true);
  assert.equal(
    micCalls,
    2,
    "ztracené zařízení nebo ruční retry smí otevřít nový vstup",
  );
  assert.equal(stopped, 1);
  // Uživatel může nechat výzvu otevřenou déle než dvousekundový recover.
  // Zamítnutí pak nesmí odemknout další automaticky zařazenou žádost.
  const blocked = new Engine(
    {},
    () => {},
    () => {},
  );
  attachContext(blocked);
  const originalGet = testNavigator.mediaDevices.getUserMedia;
  let deny,
    permissionRequests = 0;
  testNavigator.mediaDevices.getUserMedia = () => {
    permissionRequests++;
    return new Promise((_, reject) => {
      deny = reject;
    });
  };
  const waitingPermission = blocked.changeInput();
  await new Promise(setImmediate);
  const automaticRecovery = blocked.recover();
  deny(new DOMException("denied", "NotAllowedError"));
  await waitingPermission;
  await new Promise(setImmediate);
  assert.equal(
    permissionRequests,
    1,
    "recover nesmí zařadit další výzvu při čekání na oprávnění",
  );
  assert.equal(blocked.inputUnavailable, true);
  await automaticRecovery;
  testNavigator.mediaDevices.getUserMedia = originalGet;
  const stoppedBeforeHide = stopped;
  const cached = new Event("pagehide");
  Object.defineProperty(cached, "persisted", { value: true });
  testWindow.dispatchEvent(cached);
  assert.equal(
    stopped,
    stoppedBeforeHide,
    "návrat z BFCache má zachovat mikrofon",
  );
  testWindow.dispatchEvent(new Event("pagehide"));
  assert.equal(
    stopped,
    stoppedBeforeHide + 1,
    "skutečné zavření stránky uvolní mikrofon",
  );
  assert.equal(engine.stream, undefined);
  ok(
    "Mikrofon: stream se drží přes odpojení, skutečná ztráta zařízení jej obnoví a zavření stránky uvolní",
  );
  ok("Uplink: dávka nejvýše 8 rámců a dále 50 rámců/s i po zdržení prohlížeče");
  ok(
    "Opus Worker: 30 PLC rámců nezablokuje pozdější zvuk; skutečná mezera se počítá samostatně",
  );
}
