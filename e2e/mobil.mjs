import { chromium, devices, expect } from "@playwright/test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const pageErrors = [];
function observe(page) {
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return page;
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function connected(page, timeout = 90000) {
  try {
    await expect(page.locator(".connection-status")).toHaveText("Připojeno", {
      timeout,
    });
  } catch (error) {
    console.error(
      "Mobil připojení:",
      await page.evaluate(() => ({
        error: document.querySelector(".toast")?.textContent,
        retry: document.querySelector(".reconnect-banner")?.textContent,
        visibility: document.visibilityState,
      })),
    );
    throw error;
  }
}
async function channel(page) {
  await expect(page.locator(".room-title h1")).toHaveText("Večerní parta", {
    timeout: 30000,
  });
}
async function login(page, password, nickname = "Mobil") {
  await page.getByLabel("Přezdívka", { exact: true }).fill(nickname);
  await page
    .getByLabel("Adresa serveru", { exact: true })
    .fill(`127.0.0.1:${process.env.TS3_VOICE_PORT || "9987"}`);
  await page.getByLabel("Heslo serveru", { exact: false }).fill(password);
  await page.getByRole("button", { name: /Připojit se/ }).click();
  await connected(page);
}
async function noOverflow(page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}
async function savedContext(browser, base, storage, device) {
  const context = await browser.newContext({
    ...device,
    permissions: ["microphone"],
    storageState: storage,
  });
  const page = observe(await context.newPage());
  if (process.env.E2E_DEBUG)
    page.on("websocket", (socket) => {
      console.log("Mobil WS otevřen");
      socket.on("framereceived", ({ payload }) => {
        if (typeof payload !== "string") return;
        const { type, code, fatal } = JSON.parse(payload);
        if (["error", "notice", "identity"].includes(type))
          console.log("Mobil WS", { type, code, fatal });
      });
      socket.on("close", () => console.log("Mobil WS zavřen"));
    });
  await page.goto(base);
  return { context, page };
}
export async function pwaChecks({ browser, base, root, ok }) {
  const response = await fetch(`${base}/manifest.webmanifest`);
  expect(response.headers.get("content-type")).toBe(
    "application/manifest+json",
  );
  const manifest = await response.json();
  expect(manifest).toMatchObject({
    name: "Mluvka",
    short_name: "Mluvka",
    lang: "cs",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#151816",
    theme_color: "#151816",
    orientation: "any",
  });
  expect(manifest.icons).toEqual([
    {
      src: "/icons/192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "/icons/512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "/icons/maskable-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    },
  ]);
  for (const [path, size] of [
    ["icons/192.png", 192],
    ["icons/512.png", 512],
    ["icons/maskable-512.png", 512],
    ["apple-touch-icon.png", 180],
  ]) {
    const response = await fetch(`${base}/${path}`);
    expect(response.status).toBe(200);
    const png = Buffer.from(await response.arrayBuffer());
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
  }
  for (const path of ["", "/index.html", "/sw.js"])
    expect((await fetch(base + path)).headers.get("cache-control")).toBe(
      "no-cache",
    );
  ok("PWA manifest, MIME, rozměry 192/512/maskable/180 a no-cache index/SW");
  // Instalovatelnost Chrome v anonymním kontextu vždy hlásí in-incognito.
  const profile = mkdtempSync(resolve(root, "tmp-ts3/pwa-"));
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      (process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : undefined),
    args: ["--disable-features=HttpsFirstBalancedModeAutoEnable"],
  });
  try {
    const page = observe(await context.newPage());
    await page.goto(base);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await expect
      .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
      .toBe(true);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Page.enable");
    await expect
      .poll(
        async () =>
          (await cdp.send("Page.getInstallabilityErrors")).installabilityErrors,
        { timeout: 15000 },
      )
      .toEqual([]);
    const urls = [];
    cdp.on("Network.responseReceived", ({ response }) => {
      if (response.url.endsWith("/ws") || response.url.endsWith("/healthz"))
        urls.push(response);
    });
    await cdp.send("Network.enable");
    await page.evaluate(async () => {
      await fetch("/healthz");
      await fetch("/ws");
    });
    await expect.poll(() => urls.length).toBe(2);
    expect(urls.every((r) => !r.fromServiceWorker)).toBe(true);
    const asset = await page
      .locator('script[src^="/assets/"]')
      .getAttribute("src");
    expect((await fetch(base + asset)).headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByLabel("Přezdívka", { exact: true })).toBeVisible();
    await context.setOffline(false);
    ok(
      "Chrome CDP: instalovatelnost bez chyb, SW registrován, /ws a /healthz mimo SW, offline skořápka",
    );
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
}
async function safeUpdate(page, context, base, root, ok) {
  const path = resolve(root, "dist/sw.js");
  const original = readFileSync(path, "utf8");
  const idle = observe(await context.newPage());
  await idle.addInitScript(() =>
    sessionStorage.setItem("mluvka.manual-disconnect", "1"),
  );
  await idle.goto(base);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    window.testUpdateMarker = 42;
  });
  try {
    writeFileSync(
      path,
      original.replace(/mluvka-([a-f0-9]+)/, "mluvka-test-$1"),
    );
    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      await reg.update();
    });
    await expect
      .poll(
        () =>
          page.evaluate(
            async () =>
              (await navigator.serviceWorker.getRegistration()).waiting?.state,
          ),
        { timeout: 15000 },
      )
      .toBe("installed");
    // I nepřipojený tab požádá o aktivaci; hovor v druhém ji musí zablokovat.
    await idle.evaluate(async () =>
      (await navigator.serviceWorker.getRegistration()).waiting.postMessage({
        type: "ACTIVATE_WHEN_IDLE",
      }),
    );
    await wait(2000);
    expect(
      await page.evaluate(
        async () => !!(await navigator.serviceWorker.getRegistration()).waiting,
      ),
    ).toBe(true);
    await connected(page);
    await page.getByRole("button", { name: "Odpojit", exact: true }).click();
    await expect
      .poll(
        () =>
          page.evaluate(
            async () =>
              !!(await navigator.serviceWorker.getRegistration()).waiting,
          ),
        { timeout: 15000 },
      )
      .toBe(false);
    expect(await page.evaluate(() => window.testUpdateMarker)).toBe(42);
    ok(
      "Aktualizace SW čeká i při žádosti z jiného tabu; po odpojení aktivuje bez reloadu hovoru",
    );
  } finally {
    writeFileSync(path, original);
    await idle.close();
  }
}
export async function mobileChecks({
  browser,
  base,
  root,
  password,
  channelPassword,
  query,
  ok,
  restartBackend,
}) {
  const context = await browser.newContext({ permissions: ["microphone"] });
  const page = observe(await context.newPage());
  await page.goto(base);
  await expect(
    page.getByLabel("Zapamatovat připojení", { exact: true }),
  ).toBeChecked();
  await expect(
    page.getByLabel("Zapamatovat i hesla na tomto zařízení"),
  ).toBeChecked();
  await expect(
    page.getByLabel("Připojit automaticky po spuštění"),
  ).toBeChecked();
  await login(page, password);
  await page
    .getByRole("button", { name: "Vstoupit do Večerní parta", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Heslo kanálu" })
    .getByLabel("Heslo kanálu", { exact: true })
    .fill(channelPassword);
  await page.getByRole("button", { name: "Vstoupit do kanálu" }).click();
  await channel(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("mluvka.login")).channel,
      ),
    )
    .toBe("Večerní parta");
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("mluvka.login")).channel_password,
    ),
  ).toBe(channelPassword);
  const uid = await page.evaluate(() => window.__mluvkaStats.uid);
  const storage = await context.storageState();
  await page.reload();
  await connected(page);
  await channel(page);
  expect(await page.locator(".self-card strong").textContent()).toBe("Mobil");
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("mluvka.login")).channel_password,
    ),
  ).toBe(channelPassword);
  expect(await page.evaluate(() => window.__mluvkaStats.uid)).toBe(uid);
  ok(
    "Auto-připojení bez formuláře: heslo serveru i posledního kanálu, stejné UID a přezdívka",
  );
  const badStorage = structuredClone(storage);
  // Chybu hesla zkouší samostatná identita; aktivní okno tak nepřebírá testovanou relaci.
  badStorage.origins[0].localStorage =
    badStorage.origins[0].localStorage.filter(
      (item) => item.name !== "mluvka.identity",
    );
  const entry = badStorage.origins[0].localStorage.find(
    (item) => item.name === "mluvka.login",
  );
  entry.value = JSON.stringify({
    ...JSON.parse(entry.value),
    password: "zamerne-chybne",
  });
  const bad = await savedContext(browser, base, badStorage);
  let wsCount = 0;
  // Počet od načtení měří druhý reload s posluchačem přidaným předem.
  bad.page.on("websocket", () => wsCount++);
  await bad.page.reload();
  await expect(bad.page.getByRole("alert")).toContainText("Nesprávné heslo", {
    timeout: 90000,
  });
  await expect(
    bad.page.getByLabel("Heslo serveru", { exact: false }),
  ).toBeFocused();
  await wait(10000);
  expect(wsCount).toBe(1);
  await bad.context.close();
  ok("Trvalá chyba bad_password: formulář, fokus hesla, právě 1 WS za 10 s");
  await safeUpdate(page, context, base, root, ok);
  let disconnectedSockets = 0;
  page.on("websocket", () => disconnectedSockets++);
  await page.reload();
  await wait(3000);
  expect(disconnectedSockets).toBe(0);
  await expect(page.getByLabel("Přezdívka", { exact: true })).toBeVisible();
  expect(await page.locator(".connection-status").textContent()).toBe(
    "Připraveno k hovoru",
  );
  await context.close();
  const fresh = await savedContext(browser, base, storage);
  await connected(fresh.page);
  await channel(fresh.page);
  ok(
    "Ruční Odpojit + reload zůstane na formuláři; nový kontext automaticky připojí",
  );
  await fresh.context.setOffline(true);
  await wait(22000); // mrtvé WS odhalí 20s watchdog i bez události close
  await expect(fresh.page.locator(".reconnect-banner")).toBeVisible();
  const restoredAt = Date.now();
  await fresh.context.setOffline(false);
  await connected(fresh.page, 20000);
  await channel(fresh.page);
  expect(await fresh.page.evaluate(() => window.__mluvkaStats.uid)).toBe(uid);
  await expect(fresh.page.locator(".self-card strong")).toHaveText("Mobil");
  expect(Date.now() - restoredAt).toBeLessThanOrEqual(20000);
  ok(
    "Offline/online: návrat do 20 s do posledního kanálu, stejné UID a původní přezdívka",
    { elapsed_ms: Date.now() - restoredAt },
  );
  let restartedSockets = 0;
  fresh.page.on("websocket", () => restartedSockets++);
  await restartBackend();
  await expect(
    fresh.page
      .getByText("Mluvka se aktualizuje — připojuji znovu…", { exact: true })
      .first(),
  ).toBeVisible();
  await expect
    .poll(() => restartedSockets, { timeout: 20000 })
    .toBeGreaterThan(0);
  await connected(fresh.page, 60000);
  await channel(fresh.page);
  await expect(fresh.page.locator(".self-card strong")).toHaveText("Mobil", {
    timeout: 20000,
  });
  expect(await fresh.page.evaluate(() => window.__mluvkaStats.uid)).toBe(uid);
  ok("Restart backendu za hovoru: automatický návrat, původní UID a přezdívka");
  await fresh.context.close();
  // Fyzický mobil nesimulujeme: Chromium s UA, touch, rozměry a skutečným audio tokem.
  for (const [name, device] of [
    ["iPhone", devices["iPhone 13"]],
    ["Pixel", devices["Pixel 7"]],
  ]) {
    const mobile = await savedContext(browser, base, storage, device);
    const p = mobile.page;
    await connected(p);
    await channel(p);
    await expect
      .poll(() => p.evaluate(() => window.__mluvkaStats.micRms))
      .toBeGreaterThan(0.01);
    await noOverflow(p);
    expect(
      await p.evaluate(() => !!document.querySelector("audio")?.srcObject),
    ).toBe(true);
    expect(await p.evaluate(() => navigator.mediaSession.metadata?.title)).toBe(
      "Mluvka — Večerní parta",
    );
    await p.screenshot({
      path: resolve(root, `docs/screenshots/${name.toLowerCase()}-portret.png`),
    });
    const sent = await p.evaluate(() => window.__mluvkaStats.sentFrames);
    const ptt = p.locator(".ptt-button");
    const touch = await mobile.context.newCDPSession(p);
    const box = await ptt.boundingBox();
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [point],
    });
    await expect
      .poll(() => p.evaluate(() => window.__mluvkaStats.sentFrames))
      .toBeGreaterThan(sent + 5);
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await wait(200);
    const stopped = await p.evaluate(() => window.__mluvkaStats.sentFrames);
    await wait(300);
    expect(await p.evaluate(() => window.__mluvkaStats.sentFrames)).toBe(
      stopped,
    );
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [point],
    });
    await wait(200);
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchCancel",
      touchPoints: [],
    });
    await wait(150);
    const cancelled = await p.evaluate(() => window.__mluvkaStats.sentFrames);
    await wait(250);
    expect(await p.evaluate(() => window.__mluvkaStats.sentFrames)).toBe(
      cancelled,
    );
    // Druhý člověk se samostatnou identitou v témže kanálu.
    const peerContext = await browser.newContext({
      permissions: ["microphone"],
    });
    const peer = observe(await peerContext.newPage());
    await peer.goto(base);
    await peer.evaluate(() =>
      localStorage.setItem(
        "mluvka.settings",
        JSON.stringify({ echo: false, noise: false, autoGain: false }),
      ),
    );
    await peer.reload();
    await login(peer, password, "Kamarád");
    await peer
      .getByRole("button", { name: "Vstoupit do Večerní parta", exact: true })
      .click();
    await peer
      .getByRole("dialog", { name: "Heslo kanálu" })
      .getByLabel("Heslo kanálu", { exact: true })
      .fill(channelPassword);
    await peer.getByRole("button", { name: "Vstoupit do kanálu" }).click();
    await channel(peer);
    await peer
      .getByLabel("Režim vysílání", { exact: true })
      .selectOption("always");
    await expect
      .poll(() => p.evaluate(() => window.__mluvkaStats.rms))
      .toBeGreaterThan(0.02);
    const person = p.locator(".client-row").filter({ hasText: "Kamarád" });
    await expect(person).toBeVisible();
    await person.dispatchEvent("pointerdown", {
      pointerId: 12,
      pointerType: "touch",
      clientX: 80,
      clientY: 250,
    });
    await expect(
      p.getByRole("dialog", { name: "Uživatel Kamarád" }),
    ).toBeVisible();
    await person.dispatchEvent("pointerup", {
      pointerId: 12,
      pointerType: "touch",
    });
    await p.getByLabel("Lokálně ztlumit", { exact: true }).check();
    await expect
      .poll(() => p.evaluate(() => window.__mluvkaStats.rms))
      .toBeLessThan(0.001);
    await p.screenshot({
      path: resolve(root, `docs/screenshots/${name.toLowerCase()}-menu.png`),
    });
    await p.getByRole("button", { name: "Zavřít uživatele" }).click();
    await p.getByRole("button", { name: "Chat", exact: true }).click();
    await p.getByLabel("Zpráva", { exact: true }).focus();
    const zoom = await p.evaluate(() => ({
      scale: visualViewport.scale,
      viewport: document.querySelector('meta[name="viewport"]').content,
      fonts: [...document.querySelectorAll("input, textarea, select")].map(
        (e) => parseFloat(getComputedStyle(e).fontSize),
      ),
      touch: getComputedStyle(document.documentElement).touchAction,
      gesturePrevented: !document.dispatchEvent(
        new Event("gesturestart", { cancelable: true }),
      ),
    }));
    expect(zoom.scale).toBe(1);
    expect(zoom.viewport).toContain("maximum-scale=1, user-scalable=no");
    expect(zoom.fonts.every((size) => size >= 16)).toBe(true);
    expect(zoom.touch).toBe("manipulation");
    expect(zoom.gesturePrevented).toBe(true);
    await p.getByLabel("Zpráva", { exact: true }).blur();
    ok(`${name}: fokus bez zoomu, vstupy ≥16 px, pinch gesto blokované`, {
      scale: zoom.scale,
      minFontPx: Math.min(...zoom.fonts),
    });
    await p.setViewportSize({
      width: device.viewport.height,
      height: device.viewport.width,
    });
    await noOverflow(p);
    await p.screenshot({
      path: resolve(root, `docs/screenshots/${name.toLowerCase()}-sirka.png`),
    });
    await peerContext.close();
    await mobile.context.close();
    ok(
      `${name} touch: PTT pustit/cancel zastaví audio, dlouhé podržení, lokální mute, portrét/šířka bez přesahu`,
    );
  }
  // Gesto, přerušení zvuku a 44,1kHz skutečná cesta do backendu.
  const audioStorage = structuredClone(storage);
  audioStorage.origins[0].localStorage.find(
    (item) => item.name === "mluvka.settings",
  ).value = JSON.stringify({ echo: false, noise: false, autoGain: false });
  const audioContext = await browser.newContext({
    ...devices["Pixel 7"],
    permissions: ["microphone"],
    storageState: audioStorage,
  });
  await audioContext.addInitScript(() => {
    const Original = window.AudioContext;
    window.AudioContext = class extends Original {
      constructor(options) {
        super({ ...options, sampleRate: 44100 });
        window.testAudioContext = this;
      }
      resume() {
        if (window.testBlockResume)
          return Promise.reject(
            new DOMException("Čekám na gesto", "NotAllowedError"),
          );
        return super.resume();
      }
    };
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    window.testStreams = [];
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await getUserMedia(constraints);
      window.testStreams.push(stream);
      return stream;
    };
  });
  const audioPage = observe(await audioContext.newPage());
  await audioPage.goto(base);
  await connected(audioPage);
  expect(await audioPage.evaluate(() => window.__mluvkaStats.sampleRate)).toBe(
    44100,
  );
  await audioPage.evaluate(() => {
    window.testBlockResume = true;
    document.addEventListener(
      "click",
      () => {
        window.testBlockResume = false;
      },
      { once: true, capture: true },
    );
    return window.testAudioContext.suspend();
  });
  await expect(
    audioPage.getByRole("button", { name: "Klepni pro zapnutí zvuku" }),
  ).toBeVisible();
  await audioPage.screenshot({
    path: resolve(root, "docs/screenshots/mobil-zapnout-zvuk.png"),
  });
  await audioPage
    .getByRole("button", { name: "Klepni pro zapnutí zvuku" })
    .click();
  await expect(audioPage.locator(".audio-unlock")).toBeHidden();
  const receiverContext = await browser.newContext({
    permissions: ["microphone"],
  });
  const receiver = observe(await receiverContext.newPage());
  await receiver.goto(base);
  await receiver.evaluate(() =>
    localStorage.setItem(
      "mluvka.settings",
      JSON.stringify({ echo: false, noise: false, autoGain: false }),
    ),
  );
  await receiver.reload();
  await login(receiver, password, "Poslech");
  await receiver
    .getByRole("button", { name: "Vstoupit do Večerní parta", exact: true })
    .click();
  await receiver
    .getByRole("dialog", { name: "Heslo kanálu" })
    .getByLabel("Heslo kanálu", { exact: true })
    .fill(channelPassword);
  await receiver.getByRole("button", { name: "Vstoupit do kanálu" }).click();
  await channel(receiver);
  await audioPage
    .getByRole("button", { name: "Nastavení", exact: true })
    .click();
  await audioPage
    .getByRole("dialog", { name: "Nastavení zvuku" })
    .getByRole("combobox")
    .first()
    .selectOption("always");
  await audioPage.getByRole("button", { name: "Hotovo", exact: true }).click();
  await expect
    .poll(() => receiver.evaluate(() => window.__mluvkaStats.rms))
    .toBeGreaterThan(0.02);
  await receiver
    .getByLabel("Režim vysílání", { exact: true })
    .selectOption("always");
  await expect
    .poll(() => audioPage.evaluate(() => window.__mluvkaStats.rms))
    .toBeGreaterThan(0.02);
  ok(
    "AudioContext 44100 Hz: hlas A → B i B → A; suspend → překryv → gesto resume bez odpojení TS",
  );
  for (const event of ["ended"]) {
    const count = await audioPage.evaluate(() => window.testStreams.length);
    await audioPage.evaluate((event) => {
      const track = window.testStreams.at(-1).getAudioTracks()[0];
      if (event === "ended") track.stop();
      track.dispatchEvent(new Event(event));
    }, event);
    await expect
      .poll(() => audioPage.evaluate(() => window.testStreams.length))
      .toBeGreaterThan(count);
    await connected(audioPage);
    await expect
      .poll(() => receiver.evaluate(() => window.__mluvkaStats.rms))
      .toBeGreaterThan(0.02);
  }
  ok(
    "Ukončená mikrofonní stopa: nové getUserMedia, hlas pokračuje bez odpojení TS",
  );
  const beforeDeviceChange = await audioPage.evaluate(
    () => window.testStreams.length,
  );
  await audioPage.evaluate(() => {
    const enumerate = navigator.mediaDevices.enumerateDevices.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.enumerateDevices = async () =>
      (await enumerate()).filter((device) => device.kind !== "audioinput");
    navigator.mediaDevices.dispatchEvent(new Event("devicechange"));
    setTimeout(() => {
      navigator.mediaDevices.enumerateDevices = enumerate;
    }, 300);
  });
  await expect
    .poll(() => audioPage.evaluate(() => window.testStreams.length))
    .toBeGreaterThan(beforeDeviceChange);
  await connected(audioPage);
  ok(
    "devicechange bez vybraného vstupu: mikrofon se znovu otevře, TS zůstává připojený",
  );
  await receiverContext.close();
  await audioContext.close();
  const installContext = await browser.newContext({ ...devices["iPhone 13"] });
  const installPage = observe(await installContext.newPage());
  await installPage.goto(base);
  await expect(
    installPage.getByRole("button", { name: "Přidat na plochu" }),
  ).toBeVisible();
  await installPage.screenshot({
    path: resolve(root, "docs/screenshots/mobil-instalace.png"),
    fullPage: true,
  });
  await installPage
    .getByRole("button", { name: "Zavřít nápovědu instalace" })
    .click();
  await installPage.reload();
  await expect(installPage.locator(".install-card")).toBeHidden();
  await installContext.close();
  ok("iOS: instalace Sdílet → Přidat na plochu, zavření nápovědy se pamatuje");
  expect(pageErrors).toEqual([]);
  ok("PWA a mobilní relace bez JS výjimek");
}
