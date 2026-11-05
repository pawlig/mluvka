// Hudební bot: falešný „Spotify Bot" je běžný TS klient (přes WS backend
// Mluvky) a odpovídá na soukromé příkazy stejnými texty jako skutečný bot.
import { expect } from "@playwright/test";
import { resolve } from "node:path";

const HELP = "Commands: /play, /playnow, /pause, /stop, /next, /prev, /now, /upnext, /queue, /volume 0-100";
// Plugin bota předá ovladači jen zprávy, jejichž první slovo je známý příkaz;
// na ostatní (i „ahoj" nebo „/neco") bot vůbec neodpoví.
const COMMANDS = [
  "/play", "/playnow", "/resume", "/pause", "/stop", "/skip", "/next",
  "/previous", "/prev", "/now", "/upnext", "/queue", "/volume", "/help",
];
const isCommand = (text) => COMMANDS.includes(text.split(/[ \t\r\n]/)[0].toLowerCase());
const ACTIONS = {
  "/play": "Resume requested.",
  "/resume": "Resume requested.",
  "/pause": "Pause requested.",
  "/stop": "Pause requested.",
  "/skip": "Skip requested.",
  "/next": "Skip requested.",
  "/previous": "Previous track requested.",
  "/prev": "Previous track requested.",
};

export async function startFakeMusicBot({ base, tsAddress, password, channel, channelPassword }) {
  const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws");
  const label = (t) => t.title + (t.artist ? " — " + t.artist : "");
  const state = {
    current: { title: "Ranní káva", artist: "Testovací kapela", by: "" },
    queue: [
      { title: "Druhá píseň", artist: "Kapela B", by: "Bára" },
      { title: "Třetí píseň", artist: "Kapela C", by: "Bára" },
    ],
    lastQueued: "",
    /** Příkazy, které došly až k ovladači bota. */
    commands: [],
    /** Všechny soukromé zprávy botovi (i ty, které plugin zahodí). */
    received: [],
    last: new Map(),
  };
  let self = 0;
  const say = (text, client) =>
    ws.send(
      JSON.stringify(
        client === undefined
          ? { type: "chat", target: "channel", text }
          : { type: "chat", target: "private", client, text },
      ),
    );
  const announce = () => {
    let text = "Now playing: " + label(state.current);
    if (state.current.by) text += "\nRequested by: " + state.current.by;
    if (state.queue[0]) text += "\nNext: " + label(state.queue[0]);
    say(text);
  };
  // Texty a pořadí kontrol odpovídají ovladači skutečného bota.
  const handle = (from, name, message) => {
    const now = Date.now();
    if (now - (state.last.get(from) || 0) < 1000)
      return "Please wait a second between commands.";
    state.last.set(from, now);
    const [first, ...args] = message.trim().split(/\s+/);
    const command = first.toLowerCase();
    const rest = message.trim().split(/\s+(.*)/s)[1];
    state.commands.push(message);
    if (command === "/help") return HELP;
    if ((command === "/play" || command === "/playnow") && args.length) {
      const link = /^(https?:\/\/|spotify:|\[url)/i.test(rest);
      const track = {
        title: link ? "Skladba z odkazu" : rest,
        artist: "Hledaný interpret",
        by: name,
      };
      state.lastQueued = label(track);
      if (command === "/playnow" || !state.current) {
        state.current = track;
        setTimeout(announce, 300);
      } else state.queue.push(track);
      return link
        ? "Opening Spotify link. Use /now to check the result."
        : `Searching Spotify for: ${rest}. Use /now to check the result.`;
    }
    if (command === "/playnow")
      return "Usage: /playnow artist song OR /playnow Spotify-track-link";
    let seek = null;
    if (command === "/skip" && args.length) {
      if (args.length !== 1 || !/^[+-]?[0-9]{1,5}$/.test(args[0]) || Math.abs(Number(args[0])) < 1 || Math.abs(Number(args[0])) > 86400)
        return "Usage: /skip [seconds] (1-86400 forward, -1 to -86400 rewind; omit for next song).";
      seek = Number(args[0]);
    }
    if (command !== "/volume" && args.length && seek === null)
      return `Usage: ${command} (without arguments). Use /play artist song to search.`;
    if (command === "/volume") {
      if (args.length !== 1 || !/^\d+$/.test(args[0]) || Number(args[0]) > 100) return "Usage: /volume 0-100";
      return `Bot output volume: ${Number(args[0])}%`;
    }
    if (command === "/upnext")
      return state.queue[0] ? "Next: " + label(state.queue[0]) : "Next: nothing queued.";
    if (command === "/queue") {
      if (!state.queue.length) return "Queue: no user requests.";
      const parts = state.queue.slice(0, 5).map((t, i) => `${i + 1}. ${label(t)}`);
      const more = state.queue.length - parts.length;
      return `Queue (${state.queue.length} waiting):\n` + parts.join("\n") + (more ? `\n+${more} more` : "");
    }
    if (seek !== null) {
      const unit = Math.abs(seek) === 1 ? "second" : "seconds";
      return `${seek > 0 ? "Forward seek" : "Rewind"} requested: ${Math.abs(seek)} ${unit}.`;
    }
    if (command === "/now") {
      const tail = state.lastQueued ? " | Last queued: " + state.lastQueued : "";
      if (!state.current) return "Spotify has no current track." + tail;
      const by = state.current.by ? " | Requested by: " + state.current.by : "";
      return "Now: " + label(state.current) + by + tail;
    }
    if (command === "/skip" || command === "/next") {
      state.current = state.queue.shift() || null;
      if (state.current) setTimeout(announce, 300);
    }
    return ACTIONS[command];
  };
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(Error("Falešný bot se nepřipojil")), 30000);
    ws.onerror = () => fail(Error("WS falešného bota selhal"));
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          type: "connect",
          nickname: "Spotify Bot",
          server: tsAddress,
          password,
          channel,
          channel_password: channelPassword,
        }),
      );
    ws.onmessage = ({ data }) => {
      if (typeof data !== "string") return;
      const m = JSON.parse(data);
      if (m.type === "error" && m.fatal) fail(Error("Falešný bot: " + m.message));
      if (m.type === "state") {
        self = m.self;
        clearTimeout(timer);
        done();
      }
      if (m.type === "chat" && m.target === "private" && m.from !== self) {
        state.received.push({ from: m.from, name: m.name, text: m.text, at: Date.now() });
        if (isCommand(m.text)) say(handle(m.from, m.name, m.text), m.from);
      }
    };
  });
  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
  }, 5000);
  return {
    state,
    close() {
      clearInterval(ping);
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "disconnect" }));
      ws.close();
    },
  };
}

/** Zprávy, které bot dostal od klienta s přezdívkou `name` od indexu `from`. */
const sentBy = (bot, name, from = 0) =>
  bot.state.received.slice(from).filter((m) => m.name === name).map((m) => m.text);

async function setHidden(page, hidden) {
  await page.evaluate((hide) => {
    if (hide) {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    } else {
      delete document.visibilityState;
      delete document.hidden;
    }
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

export async function musicChecks({ a, b, base, tsAddress, password, channelPassword, root, ok }) {
  await expect(a.locator(".hudba")).toHaveCount(0);
  for (const p of [a, b]) await p.getByRole("button", { name: "Kanál", exact: true }).click();
  const bot = await startFakeMusicBot({
    base,
    tsAddress,
    password,
    channel: "Večerní parta",
    channelPassword,
  });
  try {
    const bar = a.locator(".hudba");
    await expect(bar).toBeVisible({ timeout: 20000 });
    await expect(bar.locator(".hudba-title")).toHaveText("Ranní káva", { timeout: 15000 });
    await expect(bar.locator(".hudba-by")).toHaveCount(0);
    ok("Hudba: bot v kanálu → lišta s aktuální skladbou");

    // `/now` s titulem neříká, jestli hraje — ⏯ zůstává neutrální.
    const play = bar.locator(".hudba-play");
    await expect(play).toHaveAttribute("data-state", "unknown");
    await expect(play).toHaveAttribute("aria-label", "Přehrávání (stav neznámý)");
    ok("Hudba: po /now je stav přehrávání neznámý (neutrální ⏯)");

    // Nové spojení rovnou do kanálu s botem: `state` i „bot přítomen" přijdou
    // dřív, než se lišta stihne přihlásit na sběrnici.
    const cContext = await a.context().browser().newContext({ permissions: ["microphone"] });
    try {
      const c = await cContext.newPage();
      await c.goto(base);
      await c.locator("details").evaluate((el) => (el.open = true));
      await c.getByLabel("Název nebo cesta kanálu", { exact: true }).fill("Večerní parta");
      await c.getByLabel("Heslo kanálu", { exact: true }).fill(channelPassword);
      await c.getByLabel("Přezdívka", { exact: true }).fill("Cyril");
      await c.getByLabel("Adresa serveru", { exact: true }).fill(tsAddress);
      await c.getByLabel("Heslo serveru", { exact: false }).fill(password);
      await c.getByRole("button", { name: /Připojit se/ }).click();
      await expect(c.locator(".connection-status")).toHaveText("Připojeno", { timeout: 45000 });
      await expect(c.locator(".hudba")).toBeVisible({ timeout: 5000 });
      await expect(c.locator(".hudba-title")).toHaveText("Ranní káva", { timeout: 15000 });
    } finally {
      await cContext.close();
    }
    ok("Hudba: připojení do kanálu s už přítomným botem ukáže lištu");

    await play.click();
    await expect(bar.getByRole("button", { name: "Pustit", exact: true })).toBeVisible({ timeout: 10000 });
    await bar.getByRole("button", { name: "Pustit", exact: true }).click();
    await expect(bar.getByRole("button", { name: "Pozastavit", exact: true })).toBeVisible({ timeout: 10000 });
    ok("Hudba: pauza a pokračování podle potvrzení bota");

    await bar.getByRole("button", { name: "Další skladba" }).click();
    await expect(bar.locator(".hudba-title")).toHaveText("Druhá píseň", { timeout: 15000 });
    await expect(bar.locator(".hudba-by")).toHaveText("přidal: Bára");
    await expect(b.getByRole("log")).toContainText("Now playing: Druhá píseň", { timeout: 10000 });
    ok("Hudba: další skladba, oznámení v kanálu zůstává v chatu");

    await bar.getByRole("slider", { name: "Hlasitost hudby", exact: true }).fill("35");
    await expect(bar.locator(".hudba-volume span")).toHaveText("35 %", { timeout: 10000 });
    ok("Hudba: hlasitost až po potvrzení bota");

    await bar.getByRole("button", { name: "Fronta a přidání skladby" }).click();
    const panel = a.getByRole("dialog", { name: "Fronta hudby" });
    await expect(panel.locator(".hudba-list li")).toHaveCount(1, { timeout: 15000 });
    await expect(panel.locator(".hudba-next")).toContainText("Třetí píseň");
    await panel.getByLabel("Přidat skladbu nebo odkaz Spotify").fill("Nová skladba");
    await panel.getByRole("button", { name: "Přidat" }).click();
    await expect(bar.locator(".hudba-artist")).toContainText("Hledám", { timeout: 5000 });
    await expect(panel.locator(".hudba-list")).toContainText("Nová skladba", { timeout: 20000 });
    await expect(panel).toContainText("Naposledy přidáno: Nová skladba", { timeout: 15000 });
    expect(bot.state.commands).toContain("/play Nová skladba");
    await panel.getByLabel("Přidat skladbu nebo odkaz Spotify").fill("spotify:track:e2e123");
    await panel.getByRole("button", { name: "Přidat" }).click();
    await expect(bar.locator(".hudba-artist")).toContainText("Otevírám odkaz", { timeout: 10000 });
    await expect(panel.locator(".hudba-list")).toContainText("Skladba z odkazu", { timeout: 20000 });
    ok("Hudba: přidání skladby i odkazu a fronta v panelu");

    // Příkazy Mluvky ani odpovědi bota se v chatu neukážou.
    await expect(a.locator(".private-tab")).toHaveCount(0);
    const log = await a.getByRole("log").textContent();
    expect(log).not.toContain("/now");
    expect(log).not.toContain("Bot output volume");
    expect(log).not.toContain("Queue (");
    ok("Hudba: příkazy a odpovědi bota se v chatu nezobrazují");

    await a.screenshot({ path: resolve(root, "docs/screenshots/hudba-desktop.png") });
    await bar.getByRole("button", { name: "Fronta a přidání skladby" }).click();
    await b.setViewportSize({ width: 390, height: 844 });
    const mobileBar = b.locator(".hudba");
    await expect(mobileBar).toBeVisible();
    await expect(mobileBar.getByRole("button", { name: "Zpět o 15 sekund" })).toBeHidden();
    const barBox = await mobileBar.boundingBox();
    const voiceBox = await b.locator(".voice-bar").boundingBox();
    expect(barBox.y + barBox.height).toBeLessThanOrEqual(voiceBox.y + 1);
    ok("Hudba: kompaktní lišta na mobilu nepřekrývá ovládání hovoru");

    await mobileBar.getByRole("button", { name: "Fronta a přidání skladby" }).click();
    const mobilePanel = b.getByRole("dialog", { name: "Fronta hudby" });
    await expect(mobilePanel).toBeVisible();
    const composer = b.locator(".composer");
    await expect(composer).toBeVisible();
    const panelBox = await mobilePanel.boundingBox();
    const composerBox = await composer.boundingBox();
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(composerBox.y + 1);
    // Vstup chatu jde dál použít (nic ho nepřekrývá).
    await b.getByLabel("Zpráva", { exact: true }).click({ trial: true });
    await b.screenshot({ path: resolve(root, "docs/screenshots/hudba-mobil.png") });
    await mobileBar.getByRole("button", { name: "Fronta a přidání skladby" }).click();
    await b.setViewportSize({ width: 1440, height: 900 });
    ok("Hudba: otevřený panel na mobilu končí nad vstupem chatu");

    // Skrytá stránka: odložený `/now` po akci ani pravidelné dotazy se nepošlou.
    // Počkáme na čerstvý `/now` (další je nejdřív za ~10 s), pak akce a skrytí.
    const pollMark = bot.state.received.length;
    await expect
      .poll(() => sentBy(bot, "Adam", pollMark).includes("/now"), { timeout: 25000 })
      .toBe(true);
    const seekMark = bot.state.received.length;
    await bar.getByRole("button", { name: "Vpřed o 30 sekund" }).click();
    await expect
      .poll(() => sentBy(bot, "Adam", seekMark).includes("/skip +30"), { timeout: 5000 })
      .toBe(true);
    await setHidden(a, true);
    const hiddenMark = bot.state.received.length;
    await a.waitForTimeout(6000);
    expect(sentBy(bot, "Adam", hiddenMark)).toEqual([]);
    await setHidden(a, false);
    await expect
      .poll(() => sentBy(bot, "Adam", hiddenMark).includes("/now"), { timeout: 10000 })
      .toBe(true);
    ok("Hudba: skrytá stránka botovi nic neposílá, po návratu se obnoví");

    // Ruční „ahoj" botovi: bot mlčí, automatický `/now` zůstane skrytý.
    await a.locator(".client-row").filter({ hasText: "Spotify Bot" }).click();
    await a.getByRole("button", { name: "Napsat zprávu" }).click();
    await a.getByLabel("Zpráva", { exact: true }).fill("ahoj");
    const helloMark = bot.state.received.length;
    await a.getByRole("button", { name: "Odeslat zprávu" }).click();
    await expect
      .poll(
        () => {
          const sent = sentBy(bot, "Adam", helloMark);
          return sent.includes("ahoj") && sent.slice(sent.indexOf("ahoj") + 1).includes("/now");
        },
        { timeout: 25000 },
      )
      .toBe(true);
    await a.waitForTimeout(1500); // odpověď bota na `/now` stihne dorazit
    const privateLog = a.getByRole("log");
    await expect(privateLog).toContainText("ahoj");
    const privateText = await privateLog.textContent();
    expect(privateText).not.toContain("/now");
    expect(privateText).not.toContain("Now:");
    await expect(a.locator(".hudba-toast")).toHaveCount(0);
    await a.getByRole("button", { name: "Kanál", exact: true }).click();
    ok("Hudba: ruční zpráva botovi zůstane v chatu, odpověď na /now ne");
  } finally {
    bot.close();
  }
  await expect(a.locator(".hudba")).toHaveCount(0, { timeout: 20000 });
  ok("Hudba: bot odešel → lišta zmizí");
}
