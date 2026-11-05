// Hudební bot: falešný „Spotify Bot" je běžný TS klient (přes WS backend
// Mluvky) a odpovídá na soukromé příkazy stejnými texty jako skutečný bot.
import { expect } from "@playwright/test";
import { resolve } from "node:path";

const HELP = "Commands: /play, /playnow, /pause, /stop, /next, /prev, /now, /upnext, /queue, /volume 0-100";

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
    commands: [],
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
  const handle = (from, name, message) => {
    const now = Date.now();
    if (now - (state.last.get(from) || 0) < 1000)
      return "Please wait a second between commands.";
    state.last.set(from, now);
    const [command, ...args] = message.trim().split(/\s+/);
    const rest = message.trim().split(/\s+(.*)/s)[1];
    state.commands.push(message);
    switch (command.toLowerCase()) {
      case "/now": {
        const tail = state.lastQueued ? " | Last queued: " + state.lastQueued : "";
        if (!state.current) return "Spotify has no current track." + tail;
        const by = state.current.by ? " | Requested by: " + state.current.by : "";
        return "Now: " + state.current.title + " — " + state.current.artist + by + tail;
      }
      case "/play":
      case "/playnow":
        if (!args.length)
          return command === "/play" ? "Resume requested." : "Usage: /playnow artist song OR /playnow Spotify-track-link";
        {
          const track = { title: rest, artist: "Hledaný interpret", by: name };
          state.lastQueued = label(track);
          if (command === "/playnow" || !state.current) {
            state.current = track;
            setTimeout(announce, 300);
          } else state.queue.push(track);
        }
        return `Searching Spotify for: ${rest}. Use /now to check the result.`;
      case "/pause":
      case "/stop":
        return "Pause requested.";
      case "/skip":
        if (args.length) {
          const s = Number(args[0]);
          return s > 0 ? `Forward seek requested: ${s} seconds.` : `Rewind requested: ${Math.abs(s)} seconds.`;
        }
      // falls through
      case "/next":
        state.current = state.queue.shift() || null;
        if (state.current) setTimeout(announce, 300);
        return "Skip requested.";
      case "/prev":
        return "Previous track requested.";
      case "/upnext":
        return state.queue[0] ? "Next: " + label(state.queue[0]) : "Next: nothing queued.";
      case "/queue": {
        if (!state.queue.length) return "Queue: no user requests.";
        const parts = state.queue.slice(0, 5).map((t, i) => `${i + 1}. ${label(t)}`);
        const more = state.queue.length - parts.length;
        return `Queue (${state.queue.length} waiting):\n` + parts.join("\n") + (more ? `\n+${more} more` : "");
      }
      case "/volume":
        if (args.length !== 1 || !/^\d+$/.test(args[0]) || Number(args[0]) > 100) return "Usage: /volume 0-100";
        return `Bot output volume: ${Number(args[0])}%`;
      case "/help":
        return HELP;
      default:
        return "Unknown command. " + HELP;
    }
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
      if (m.type === "chat" && m.target === "private" && m.from !== self)
        say(handle(m.from, m.name, m.text), m.from);
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

    await bar.getByRole("button", { name: "Pozastavit" }).click();
    await expect(bar.getByRole("button", { name: "Pustit" })).toBeVisible({ timeout: 10000 });
    await bar.getByRole("button", { name: "Pustit" }).click();
    await expect(bar.getByRole("button", { name: "Pozastavit" })).toBeVisible({ timeout: 10000 });
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
    ok("Hudba: přidání skladby a fronta v panelu");

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
    await b.screenshot({ path: resolve(root, "docs/screenshots/hudba-mobil.png") });
    await b.setViewportSize({ width: 1440, height: 900 });
    ok("Hudba: kompaktní lišta na mobilu nepřekrývá ovládání hovoru");
  } finally {
    bot.close();
  }
  await expect(a.locator(".hudba")).toHaveCount(0, { timeout: 20000 });
  ok("Hudba: bot odešel → lišta zmizí");
}
