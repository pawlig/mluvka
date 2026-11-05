import { chromium, devices, expect } from "@playwright/test";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ready = (page, timeout = 90000) =>
  expect(page.locator(".connection-status")).toHaveText("Připojeno", {
    timeout,
  });
function observe(context, micFailure) {
  return context.addInitScript((micFailure) => {
    window.regSockets = [];
    window.regNotices = [];
    const Original = WebSocket;
    window.WebSocket = class extends Original {
      constructor(...args) {
        super(...args);
        window.regSockets.push(this);
        this.addEventListener("message", ({ data }) => {
          if (typeof data !== "string") return;
          const msg = JSON.parse(data);
          if (msg.type === "notice") window.regNotices.push(msg);
        });
      }
    };
    window.regStreams = [];
    const OriginalContext = window.AudioContext;
    window.AudioContext = class extends OriginalContext {
      constructor(options) {
        super(options);
        window.regAudioContext = this;
      }
    };
    window.regMicCalls = 0;
    const gum = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (...args) => {
      window.regMicCalls++;
      if (micFailure)
        throw new DOMException("Test chybějícího zařízení", micFailure);
      const stream = await gum(...args);
      window.regStreams.push(stream);
      return stream;
    };
    Object.defineProperty(navigator, "audioSession", {
      value: { type: "auto" },
      configurable: true,
    });
    localStorage.setItem(
      "mluvka.settings",
      JSON.stringify({
        echo: false,
        noise: false,
        autoGain: false,
        input: micFailure ? "odpojeny-vstup" : "",
      }),
    );
  }, micFailure);
}
async function hidden(page, value) {
  await page.evaluate((value) => {
    Object.defineProperty(document, "hidden", { configurable: true, value });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: value ? "hidden" : "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, value);
}
async function control(page, body) {
  await page.evaluate(
    (body) => window.regSockets.at(-1).send(JSON.stringify(body)),
    body,
  );
}
const selfId = (page) =>
  page
    .locator(".client-row")
    .filter({ hasText: / vy/ })
    .getAttribute("data-client");
const avatarColor = (locator) =>
  locator.evaluate((element) => getComputedStyle(element).backgroundColor);

export async function banUiChecks({ browser, base, login, ok }) {
  for (const seconds of [3, undefined]) {
    const context = await browser.newContext({
      permissions: ["microphone"],
      ...devices["Pixel 7"],
    });
    try {
      await observe(context);
      const page = await context.newPage();
      let attempts = 0;
      await page.routeWebSocket("**/ws", (socket) => {
        attempts++;
        socket.onMessage((text) => {
          if (JSON.parse(text).type !== "connect") return;
          socket.send(
            JSON.stringify({
              type: "error",
              code: "banned",
              fatal: true,
              retryable: false,
              ban_seconds: seconds,
              message:
                seconds === undefined
                  ? "Server vás odmítl: zákaz přístupu (ban). Dobu vypršení server neuvedl."
                  : "Server vás odmítl: zákaz přístupu (ban).",
            }),
          );
          socket.close();
        });
      });
      await page.goto(base);
      await login(page, "Odpočet");
      await expect(page.getByRole("alert")).toContainText("zákaz přístupu");
      if (seconds !== undefined) {
        await expect(page.getByText(/Ban vyprší za 00:0[123]/)).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Připojit znovu", exact: true }),
        ).toBeHidden();
        await page.screenshot({
          path: new URL("../docs/screenshots/mobil-ban.png", import.meta.url)
            .pathname,
          fullPage: true,
        });

        await expect(
          page.getByText("Ban vypršel — můžete se připojit znovu."),
        ).toBeVisible({ timeout: 5000 });
      } else {
        await expect(page.getByRole("alert")).toContainText(
          "Dobu vypršení server neuvedl",
        );
        await expect(page.getByText(/Ban vyprší za/)).toBeHidden();
      }
      await expect(
        page.getByRole("button", { name: "Připojit znovu", exact: true }),
      ).toBeVisible();
      await wait(11000); // Přes celý první jitter 0–10 s nesmí vzniknout další pokus.
      expect(attempts).toBe(1);
      await page.reload();
      await wait(3000);
      expect(attempts).toBe(1);
    } finally {
      await context.close();
    }
  }
  ok(
    "UI banu: doložená doba se odpočítává, neznámá se nevymýšlí; po vypršení pouze ruční návrat",
  );
}

export async function mobileRegressionChecks({
  browser,
  base,
  query,
  password,
  login,
  ok,
  backendLog,
  root,
}) {
  const contexts = [],
    pages = [],
    faults = [];
  try {
    // Výchozí TS3 limity, nikoli benevolentních 10000 bodů z původního harnessu.
    await query.cmd(
      "serveredit virtualserver_antiflood_points_needed_command_block=150 virtualserver_antiflood_points_needed_ip_block=250 virtualserver_antiflood_points_tick_reduce=5",
    );
    const beforeCommands = backendLog();
    for (let i = 0; i < 6; i++) {
      const context = await browser.newContext({
        permissions: ["microphone"],
        ...(i === 1 ? devices["Pixel 7"] : {}),
      });
      contexts.push(context);
      await observe(context);
      const page = await context.newPage();
      page.on("pageerror", (error) => faults.push(error.message));
      page.on("websocket", (socket) =>
        socket.on("framereceived", ({ payload }) => {
          if (typeof payload === "string") {
            const msg = JSON.parse(payload);
            if (msg.code === "flood" || msg.code === "banned")
              faults.push(msg.code);
          }
        }),
      );
      pages.push(page);
      await page.goto(base);
    }
    const start = Date.now();
    await Promise.all(pages.map((page, i) => login(page, `Regrese${i}`)));
    await Promise.all(pages.map((page) => ready(page)));
    const channels = await query.cmd("channellist");
    const rest = channels
      .split("|")
      .find((part) => part.includes("channel_name=Odpočívárna"));
    const channel = Number(/\bcid=(\d+)/.exec(rest)[1]);
    await Promise.all(
      pages.map((page) => control(page, { type: "move", channel })),
    );
    await Promise.all(
      pages.map((page) =>
        expect(page.locator(".room-title h1")).toHaveText("Odpočívárna"),
      ),
    );
    await pages[1].getByRole("button", { name: "Chat", exact: true }).click();
    await Promise.all(
      pages.map(async (page, i) => {
        await page.getByLabel("Zpráva", { exact: true }).fill(`šestice-${i}`);
        await page
          .getByRole("button", { name: "Odeslat zprávu", exact: true })
          .click();
      }),
    );
    await Promise.all(
      pages.map((page) => expect(page.locator(".message")).toHaveCount(6)),
    );
    expect(faults).toEqual([]);
    const counts = {};
    for (const [, command] of backendLog()
      .slice(beforeCommands.length)
      .matchAll(/ts_command="([^"]+)"/g))
      counts[command] = (counts[command] || 0) + 1;
    expect(counts.channelsubscribeall).toBe(6);
    expect(counts.clientmove).toBe(6);
    expect(counts.sendtextmessage).toBe(6);
    // Opakovaný stejný mute nesmí znovu vyslat clientupdate.
    const updates = (backendLog().match(/ts_command="clientupdate"/g) || [])
      .length;
    await Promise.all(
      pages.map((page) =>
        control(page, { type: "mute", microphone: false, deafen: false }),
      ),
    );
    await wait(1000);
    expect(
      (backendLog().match(/ts_command="clientupdate"/g) || []).length,
    ).toBe(updates);
    ok(
      "Výchozí antiflood: 6 současných relací, každá přesun + chat, bez banu; stejný mute bez příkazu",
      { commands: counts, elapsedMs: Date.now() - start },
    );
    const [a, b] = pages;
    await b.getByRole("button", { name: "Kanály", exact: true }).click();
    const aId = await selfId(a);
    const row = b.locator(`.client-row[data-client="${aId}"]`);
    const message = b
      .locator(".message")
      .filter({ hasText: "šestice-0" })
      .locator(".message-avatar");
    const originalColor = await avatarColor(row.locator(".avatar"));
    expect(await avatarColor(message)).toBe(originalColor);
    // Dlouhé podržení otevře kontext, paleta se vejde na mobil.
    await row.dispatchEvent("pointerdown", {
      pointerId: 9,
      pointerType: "touch",
      clientX: 80,
      clientY: 250,
    });
    await expect(
      b.getByRole("dialog", { name: "Uživatel Regrese0" }),
    ).toBeVisible();
    await row.dispatchEvent("pointerup", {
      pointerId: 9,
      pointerType: "touch",
    });
    await b.getByRole("button", { name: "Barva…", exact: true }).click();
    const eighth = b.getByRole("button", { name: "Barva 8", exact: true });
    await b
      .getByRole("button", {
        name:
          (await avatarColor(eighth)) === originalColor ? "Barva 9" : "Barva 8",
        exact: true,
      })
      .click();
    const selected = await avatarColor(message);
    expect(selected).not.toBe(originalColor);
    expect(await avatarColor(row.locator(".avatar"))).toBe(selected);
    const geometry = await b.locator(".color-palette").boundingBox();
    const viewport = b.viewportSize();
    expect(geometry.x).toBeGreaterThanOrEqual(0);
    expect(geometry.x + geometry.width).toBeLessThanOrEqual(viewport.width);
    expect(geometry.y + geometry.height).toBeLessThanOrEqual(viewport.height);
    const contrast = await b
      .locator(".color-palette button")
      .evaluateAll((buttons) => {
        const luminance = (rgb) => {
          const values = rgb
            .match(/[\d.]+/g)
            .slice(0, 3)
            .map(Number)
            .map((v) => v / 255)
            .map((v) =>
              v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
            );
          return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
        };
        return buttons.map((button) => {
          const s = getComputedStyle(button);
          const a = luminance(s.backgroundColor),
            b = luminance(s.color);
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        });
      });
    expect(Math.min(...contrast)).toBeGreaterThanOrEqual(4.5);
    await b.screenshot({ path: `${root}/docs/screenshots/mobil-barvy.png` });
    await b.getByRole("button", { name: "Zavřít uživatele" }).click();
    await control(a, {
      type: "chat",
      target: "channel",
      text: "barva-po-volbe",
    });
    await expect(
      b.locator(".message").filter({ hasText: "barva-po-volbe" }),
    ).toHaveCount(1);
    expect(
      await avatarColor(
        b
          .locator(".message")
          .filter({ hasText: "barva-po-volbe" })
          .locator(".message-avatar"),
      ),
    ).toBe(selected);
    // Změna přezdívky na TS přes ServerQuery clientedit není podporována; stejné UID
    // znovu připojíme s novou přezdívkou přes skutečný klientský handshake.
    await a.getByRole("button", { name: "Odpojit", exact: true }).click();
    await login(a, "Přejmenovaný");
    await ready(a);
    await control(a, { type: "move", channel });
    await expect(a.locator(".room-title h1")).toHaveText("Odpočívárna");
    const renamedId = await selfId(a);
    await expect(
      b.locator(`.client-row[data-client="${renamedId}"] .avatar`),
    ).toHaveCount(1);
    expect(
      await avatarColor(
        b.locator(`.client-row[data-client="${renamedId}"] .avatar`),
      ),
    ).toBe(selected);
    expect(await avatarColor(message)).toBe(selected);
    await b.reload();
    await ready(b);
    expect(
      await avatarColor(
        b.locator(`.client-row[data-client="${renamedId}"] .avatar`),
      ),
    ).toBe(selected);
    await b.getByRole("button", { name: "Chat", exact: true }).click();
    await control(a, {
      type: "chat",
      target: "channel",
      text: "barva-po-reloadu",
    });
    const restored = b
      .locator(".message")
      .filter({ hasText: "barva-po-reloadu" })
      .locator(".message-avatar");
    await expect(restored).toBeVisible();
    expect(await avatarColor(restored)).toBe(selected);
    await restored.click();
    await b.getByRole("button", { name: "Barva…", exact: true }).click();
    await b.getByRole("button", { name: "Automaticky", exact: true }).click();
    expect(await avatarColor(restored)).toBe(originalColor);
    await b.getByRole("button", { name: "Zavřít uživatele" }).click();
    ok(
      "Barvy UID: strom = zprávy, změna všude, přejmenování i reload zachová, Automaticky vrátí; mobilní dlouhé podržení a kontrast",
      { minContrast: Math.min(...contrast) },
    );
    const microphoneCalls = await b.evaluate(() => window.regMicCalls);
    const originalStream = await b.evaluate(() => {
      window.savedStream = window.regStreams[0];
      return window.regStreams.length;
    });
    expect(microphoneCalls).toBe(1);
    await b.getByRole("button", { name: "Odpojit", exact: true }).click();
    expect(
      await b.evaluate(() => window.savedStream.getAudioTracks()[0].readyState),
    ).toBe("live");
    expect(
      await b.evaluate(() => window.savedStream.getAudioTracks()[0].enabled),
    ).toBe(false);
    await login(b, "Regrese1");
    await ready(b);
    expect(await b.evaluate(() => window.regMicCalls)).toBe(microphoneCalls);
    expect(await b.evaluate(() => window.regStreams.length)).toBe(
      originalStream,
    );
    await expect
      .poll(() =>
        b.evaluate(() => window.savedStream.getAudioTracks()[0].enabled),
      )
      .toBe(true);
    expect(faults).toEqual([]);
    const listing = await query.cmd("clientlist -uid");
    expect(
      listing
        .split("|")
        .filter((client) => client.includes("client_nickname=Regrese1")),
    ).toHaveLength(1);
    await control(b, { type: "move", channel });
    await expect(b.locator(".room-title h1")).toHaveText("Odpočívárna");
    ok(
      "Mobil: okamžité odpojení a připojení bez banu a dvojí identity; stejný živý MediaStream, getUserMedia pouze jednou",
    );
    const sockets = await b.evaluate(() => window.regSockets.length);
    const currentBId = await selfId(b);
    await b.evaluate(() => window.dispatchEvent(new Event("online")));
    await wait(1500);
    expect(await b.evaluate(() => window.regSockets.length)).toBe(sockets);
    expect(await selfId(b)).toBe(currentBId);
    ok("online na zdravém spojení zachová WS i TS clid");
    // Další čtyři relace nepotřebujeme pro zvukovou část.
    for (let i = 2; i < 6; i++) await contexts[i].close();
    await a
      .getByLabel("Režim vysílání", { exact: true })
      .selectOption("always");
    await expect
      .poll(() => b.evaluate(() => window.__mluvkaStats.outputRms))
      .toBeGreaterThan(0.001);
    await expect
      .poll(() => b.evaluate(() => navigator.audioSession.type))
      .toBe("play-and-record");
    // Nastavení z UI, aby Media Session prošla skutečným frontendovým stavem.
    await b
      .getByRole("button", { name: "Ztlumit mikrofon", exact: true })
      .click();
    expect(await b.evaluate(() => navigator.mediaSession.playbackState)).toBe(
      "playing",
    );
    const cdp = await contexts[1].newCDPSession(b);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await hidden(b, true);
    await b.evaluate(() => window.regAudioContext.suspend());
    await expect
      .poll(() => b.evaluate(() => window.regAudioContext.state))
      .toBe("running");
    const baseline = await b.evaluate(
      () => window.__mluvkaStats.receivedFrames,
    );
    const micCalls = await b.evaluate(() => window.regMicCalls);
    await b.evaluate(() =>
      window.regStreams
        .at(-1)
        .getAudioTracks()[0]
        .dispatchEvent(new Event("mute")),
    );
    for (let i = 0; i < 6; i++) {
      await wait(10000);
      expect(
        await b.evaluate(() => window.__mluvkaStats.receivedFrames),
      ).toBeGreaterThan(baseline + i * 100);
      expect(
        await b.evaluate(() => window.__mluvkaStats.outputRms),
      ).toBeGreaterThan(0.001);
    }
    const output = await b.evaluate(() => {
      const audio = document.querySelector("audio");
      return {
        paused: audio.paused,
        muted: audio.muted,
        stream: !!audio.srcObject,
      };
    });
    expect(output).toEqual({ paused: false, muted: false, stream: true });
    expect(await b.evaluate(() => window.regMicCalls)).toBe(micCalls);
    expect(await b.evaluate(() => window.regSockets.length)).toBe(sockets);
    expect(await selfId(b)).toBe(currentBId);
    ok(
      "Pozadí 60 s: dekódované rámce a výstupní RMS rostou, audio hraje, stejné WS/clid, mute stopy bez getUserMedia",
      {
        frames:
          (await b.evaluate(() => window.__mluvkaStats.receivedFrames)) -
          baseline,
      },
    );
    await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
    await wait(30000);
    await cdp.send("Page.setWebLifecycleState", { state: "active" });
    const resumed = Date.now();
    await hidden(b, false);
    await expect(b.locator(".reconnect-banner")).toBeHidden();
    await expect
      .poll(() => b.evaluate(() => window.__mluvkaStats.outputRms), {
        timeout: 10000,
      })
      .toBeGreaterThan(0.001);
    await ready(b, 10000);
    await wait(5000); // Celá milost, nikoli jen první render po probuzení.
    await expect(b.locator(".reconnect-banner")).toBeHidden();
    expect(await b.evaluate(() => window.regSockets.length)).toBe(sockets);
    expect(await selfId(b)).toBe(currentBId);
    await expect(b.locator(".self-card strong")).toHaveText("Regrese1");
    ok(
      "Zmrazení 30 s → active: zvuk do 10 s, přezdívka zachována, žádný falešný banner v milosti",
      { elapsedMs: Date.now() - resumed },
    );
    await hidden(b, true);
    await b.evaluate(() => window.regSockets.at(-1).close());
    await expect
      .poll(() => b.evaluate(() => window.regSockets.length), {
        timeout: 20000,
      })
      .toBeGreaterThan(sockets);
    await ready(b);
    expect(await b.evaluate(() => document.hidden)).toBe(true);
    await hidden(b, false);
    ok("Spadlé WS na pozadí se znovu připojí ještě v hidden");
    await query.cmd(
      `clientkick clid=${await selfId(b)} reasonid=5 reasonmsg=Test`,
    );
    await expect(
      b.getByRole("button", { name: "Připojit znovu", exact: true }),
    ).toBeVisible();
    const afterKick = await b.evaluate(() => window.regSockets.length);
    await wait(10000);
    expect(await b.evaluate(() => window.regSockets.length)).toBe(afterKick);
    expect(await b.evaluate(() => navigator.audioSession.type)).toBe("auto");
    ok(
      "Kick přes ServerQuery: bez automatického návratu 10 s, ruční Připojit znovu, audioSession auto",
    );
    expect(faults).toEqual([]);
    await control(a, { type: "move", channel: 1 });
    await expect(a.locator(".room-title h1")).toHaveText("Lobby");
    await microphoneDeniedChecks({ base, password, ok });
  } catch (error) {
    console.error(
      "Regrese mobil:",
      await Promise.all(
        pages.map((page) =>
          page
            .evaluate(() => ({
              status: document.querySelector(".connection-status")?.textContent,
              error: document.querySelector(".toast")?.textContent,
              sockets: window.regSockets?.length,
              frames: window.__mluvkaStats?.receivedFrames,
              hidden: document.hidden,
            }))
            .catch(() => ({})),
        ),
      ),
    );
    console.error("TS diagnostika:", backendLog());
    throw error;
  } finally {
    for (const context of contexts) await context.close();
  }
}

async function microphoneDeniedChecks({ base, password, ok }) {
  // Vlastní čistý browser BEZ fake-ui: reálně zamítnuté oprávnění.
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      (process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : undefined),
    args: [
      "--use-fake-device-for-media-stream",
      "--disable-audio-output",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-features=HttpsFirstBalancedModeAutoEnable",
    ],
  });
  try {
    for (const failure of ["NotAllowedError", "NotFoundError"]) {
      const context = await browser.newContext({
        ...devices["Pixel 7"],
        permissions: [],
      });
      await context.grantPermissions([], { origin: base });
      await observe(
        context,
        failure === "NotFoundError" ? "NotFoundError" : undefined,
      );
      const page = await context.newPage();
      await page.goto(base);
      await page
        .getByLabel("Přezdívka", { exact: true })
        .fill(`BezMikrofonu-${failure}`);
      await page
        .getByLabel("Adresa serveru", { exact: true })
        .fill(`127.0.0.1:${process.env.TS3_VOICE_PORT || "9987"}`);
      await page.getByLabel("Heslo serveru", { exact: false }).fill(password);
      await page.getByRole("button", { name: /Připojit se/ }).click();
      await ready(page);
      await expect(page.locator(".microphone-banner")).toContainText(
        "Mikrofon není povolený — posloucháte jen",
      );
      await expect(page.locator(".audio-unlock")).toBeHidden();
      await expect(
        page.getByRole("button", { name: "Rozumím", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Rozumím", exact: true }).click();
      expect(
        await page.evaluate(() =>
          localStorage.getItem("mluvka.microphone-help"),
        ),
      ).toBe("1");

      await expect
        .poll(() => page.evaluate(() => window.__mluvkaStats.outputRms))
        .toBeGreaterThan(0.001);
      const attempts = await page.evaluate(() => window.regMicCalls);
      expect(attempts).toBe(1);
      await wait(10000);
      expect(await page.evaluate(() => window.regMicCalls)).toBe(attempts);
      await page
        .getByRole("button", { name: "Zkusit znovu", exact: true })
        .click();
      await expect
        .poll(() => page.evaluate(() => window.regMicCalls))
        .toBe(attempts + 1);
      await expect(
        page.getByRole("button", { name: "Rozumím", exact: true }),
      ).toBeHidden();
      if (failure === "NotAllowedError")
        await page.screenshot({
          path: new URL(
            "../docs/screenshots/mobil-bez-mikrofonu.png",
            import.meta.url,
          ).pathname,
          fullPage: true,
        });
      await page.getByRole("button", { name: "Odpojit", exact: true }).click();
      await context.close();
      ok(
        `${failure}: připojeno bez překryvu, žádný další getUserMedia 10 s, ruční opakování a Odpojit`,
      );
    }
  } finally {
    await browser.close();
  }
}

export async function floodRecoveryChecks({
  browser,
  base,
  query,
  login,
  ok,
  backendLog,
}) {
  const contexts = [],
    pages = [];
  const began = backendLog().length;
  try {
    await query.cmd(
      "serveredit virtualserver_antiflood_points_needed_command_block=150 virtualserver_antiflood_points_needed_ip_block=250",
    );
    for (let i = 0; i < 4; i++) {
      const context = await browser.newContext({ permissions: ["microphone"] });
      contexts.push(context);
      await observe(context);
      const page = await context.newPage();
      pages.push(page);
      await page.goto(base);
    }
    await Promise.all(
      pages.slice(0, 2).map((page, i) => login(page, `Flood-${i}`)),
    );
    await Promise.all(pages.slice(0, 2).map((page) => ready(page)));
    await wait(500); // Dokončit úvodní subscribe, testujeme flood dalšího handshake.
    const original = await pages[0].evaluate(() => window.regSockets.length);
    const originalClient = await selfId(pages[0]);
    const commandStart = backendLog().length;
    await control(pages[0], { type: "mute", microphone: true, deafen: false });
    await expect
      .poll(() => query.cmd(`clientinfo clid=${originalClient}`))
      .toContain("client_input_muted=1");
    await query.cmd(
      "serveredit virtualserver_antiflood_points_needed_command_block=1 virtualserver_antiflood_points_needed_ip_block=10000",
    );
    await control(pages[0], { type: "mute", microphone: false, deafen: false });
    await expect
      .poll(() => backendLog().slice(commandStart), { timeout: 15000 })
      .toMatch(/code="?0x020c"?/);
    // Totéž nastavení znovu během odmítnutí nesmí zahodit čekající unmute.
    await control(pages[0], { type: "mute", microphone: false, deafen: false });
    await query.cmd(
      "serveredit virtualserver_antiflood_points_needed_command_block=150 virtualserver_antiflood_points_needed_ip_block=250",
    );
    await expect
      .poll(() => query.cmd(`clientinfo clid=${originalClient}`), {
        timeout: 15000,
      })
      .toContain("client_input_muted=0");
    ok(
      "Příkazový flood: odmítnuté unmute přežije opakovaný stejný stav a skutečně odtlumí klienta na TS",
    );
    const chatStart = backendLog().length;

    await query.cmd(
      "serveredit virtualserver_antiflood_points_needed_command_block=1 virtualserver_antiflood_points_needed_ip_block=10000",
    );
    await control(pages[0], {
      type: "chat",
      target: "channel",
      text: "fronta-po-command-floodu",
    });
    await expect
      .poll(() => backendLog().slice(chatStart), { timeout: 15000 })
      .toMatch(/code="?0x020c"?/);
    await expect(
      pages[0].getByText("Odesílám pomaleji, server omezuje počet zpráv", {
        exact: true,
      }),
    ).toBeVisible();
    await ready(pages[0]);
    await query.cmd(
      "serveredit virtualserver_antiflood_points_needed_command_block=150 virtualserver_antiflood_points_needed_ip_block=250",
    );
    await expect(
      pages[1]
        .locator(".message")
        .filter({ hasText: "fronta-po-command-floodu" }),
    ).toHaveCount(1, { timeout: 20000 });
    expect(await selfId(pages[0])).toBe(originalClient);
    expect(await pages[0].evaluate(() => window.regSockets.length)).toBe(
      original,
    );
    expect(backendLog().slice(commandStart)).not.toContain(
      "Antiflood pauza nových připojení",
    );
    ok(
      "Příkazový flood 0x020c: odmítnutá zpráva doručena právě jednou po zpomalení; stejný WS a TS klient",
    );
    const living = await Promise.all(
      pages.slice(0, 2).map(async (page) => ({
        client: await selfId(page),
        sockets: await page.evaluate(() => window.regSockets.length),
      })),
    );
    // TS3 vrací na handshake 0x0d01 + explicitní marker flood prevention.
    // Omezuje se jen nový handshake, živé relace zůstávají beze změny.
    await query.cmd(
      "serveredit virtualserver_antiflood_points_needed_command_block=1 virtualserver_antiflood_points_needed_ip_block=2",
    );
    await login(pages[2], "Flood-2");
    await expect
      .poll(() => backendLog().slice(began), { timeout: 60000 })
      .toContain("Antiflood pauza nových připojení");
    expect(backendLog().slice(began)).toContain("0x0d03");
    expect(backendLog().slice(began)).toContain('wire_code="0x0d01"');
    const pausedAt = Date.now();
    await query.cmd(
      "serveredit virtualserver_antiflood_points_needed_command_block=150 virtualserver_antiflood_points_needed_ip_block=250",
    );
    const bans = await query.cmd("banlist").catch(() => "");
    for (const [, id] of bans.matchAll(/\bbanid=(\d+)/g))
      await query.cmd(`bandel banid=${id}`);
    // Čtvrtý klient přijde už za sdílené pauzy: čeká na stejném WS ve frontě.
    await login(pages[3], "Flood-3");
    await expect(
      pages[3].getByText(
        /Čekám na volné místo.*Pauza nových připojení \d\d:\d\d/,
      ),
    ).toBeVisible();
    const queuedSockets = await pages[3].evaluate(
      () => window.regSockets.length,
    );
    const subscriptions = () =>
      backendLog()
        .slice(began)
        .match(/ts_command="channelsubscribeall"/g)?.length || 0;
    const beforeSubscriptions = subscriptions();
    for (let i = 0; i < 11; i++) {
      await Promise.all(
        pages.slice(0, 2).map(async (page, index) => {
          await ready(page, 1000);
          expect(await selfId(page)).toBe(living[index].client);
          expect(await page.evaluate(() => window.regSockets.length)).toBe(
            living[index].sockets,
          );
          await control(page, {
            type: "chat",
            target: "channel",
            text: `během-handshake-pauzy-${i}-${index}`,
          });
        }),
      );
      await Promise.all(
        pages
          .slice(0, 2)
          .map((page, index) =>
            expect(
              page
                .locator(".message")
                .filter({ hasText: `během-handshake-pauzy-${i}-${1 - index}` }),
            ).toHaveCount(1, { timeout: 10000 }),
          ),
      );
      await wait(10000);
      if (Date.now() - pausedAt < 119000) {
        expect(subscriptions()).toBe(beforeSubscriptions);
        for (const page of pages.slice(2))
          await expect(page.locator(".connection-status")).not.toHaveText(
            "Připojeno",
          );
      }
    }
    await Promise.all(pages.map((page) => ready(page, 60000)));
    expect(Date.now() - pausedAt).toBeGreaterThanOrEqual(119000);
    for (let i = 0; i < 2; i++) {
      expect(await selfId(pages[i])).toBe(living[i].client);
      expect(await pages[i].evaluate(() => window.regSockets.length)).toBe(
        living[i].sockets,
      );
    }
    expect(await pages[3].evaluate(() => window.regSockets.length)).toBe(
      queuedSockets,
    );
    ok(
      "Handshake flood 0x0d01 → 0x0d03: nová připojení čekají ≥120 s s odpočtem, Flood-0/1 mají stejný WS i clid a dál doručují chat",
      {
        elapsedMs: Date.now() - pausedAt,
        wireCode: "0x0d01",
        floodCode: "0x0d03",
        survivingClients: living.map((client) => client.client),
      },
    );
  } finally {
    await query.cmd(
      "serveredit virtualserver_antiflood_points_needed_command_block=150 virtualserver_antiflood_points_needed_ip_block=250",
    );
    for (const context of contexts) await context.close();
  }
}
