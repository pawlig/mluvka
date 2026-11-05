import { expect } from "@playwright/test";
import { createHmac } from "node:crypto";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";

export async function installSharingCapture(context, relay = false) {
  await context.addInitScript(
    ({ relay }) => {
      window.__mluvkaShareTest = {
        relay: relay || window.__mluvkaShareTest?.relay || false,
      };
      if (window.__e2eSharingInstalled) return;
      window.__e2eSharingInstalled = true;
      window.__e2eShareMessages = [];
      const Original = window.WebSocket;
      window.WebSocket = class extends Original {
        constructor(...args) {
          super(...args);
          window.__e2eShareSocket = this;
          this.addEventListener("message", (event) => {
            if (typeof event.data !== "string") return;
            const msg = JSON.parse(event.data);
            if (msg.type === "share_started" && window.__e2eDelayStartAck) {
              event.stopImmediatePropagation();
              window.__e2eDelayedAck = event.data;
              return;
            }
            if (msg.type === "rtc_offer" && window.__e2eBlockOffers) {
              event.stopImmediatePropagation();
              return;
            }
            if (msg.type === "share_list") window.__e2eLastList = msg;
            if (msg.type === "share_session") {
              window.__e2eShareToken = msg.token;
              window.__e2eShareSession = msg.session;
            }
            if (
              msg.type.startsWith("share_") ||
              msg.type === "watch" ||
              msg.type.startsWith("rtc_")
            )
              window.__e2eShareMessages.push(msg);
            if (window.__e2eShareMessages.length > 200)
              window.__e2eShareMessages.shift();
          });
        }
      };
      // Náhrada API je jen v harnessu, do aplikace se testovací obraz nedostane.
      navigator.mediaDevices.getDisplayMedia = async ({ audio }) => {
        const canvas = document.createElement("canvas");
        canvas.width = 1280;
        canvas.height = 720;
        const ctx = canvas.getContext("2d");
        let frame = 0;
        function draw() {
          ctx.fillStyle = "#151816";
          ctx.fillRect(0, 0, 1280, 720);
          ctx.strokeStyle = "#36442c";
          ctx.lineWidth = 1;
          for (let x = 0; x < 1280; x += 64) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, 720);
            ctx.stroke();
          }
          for (let y = 0; y < 720; y += 64) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(1280, y);
            ctx.stroke();
          }
          ctx.fillStyle = "#d5f879";
          ctx.font = "bold 80px sans-serif";
          ctx.fillText("Společná obrazovka", 80, 200);
          ctx.fillStyle = "#e9ede5";
          ctx.font = "30px sans-serif";
          ctx.fillText("Mluvka · živé sdílení", 85, 260);
          ctx.fillStyle = "#d5f879";
          ctx.fillRect(85 + (frame % 950), 380, 80, 80);
          ctx.font = "24px monospace";
          ctx.fillText(`Snímek ${frame++}`, 85, 570);
        }
        draw();
        const timer = setInterval(draw, 33);
        const stream = canvas.captureStream(30);
        if (audio) {
          const ac = new AudioContext(),
            oscillator = ac.createOscillator(),
            gain = ac.createGain(),
            dest = ac.createMediaStreamDestination();
          gain.gain.value = 0.01;
          oscillator.connect(gain).connect(dest);
          oscillator.start();
          stream.addTrack(dest.stream.getAudioTracks()[0]);
          stream.getVideoTracks()[0].addEventListener("ended", () => {
            void ac.close();
          });
        }
        const track = stream.getVideoTracks()[0],
          stop = track.stop.bind(track);
        track.stop = () => {
          clearInterval(timer);
          stop();
        };
        window.__e2eDisplayStream = stream;
        return stream;
      };
    },
    { relay },
  );
}
async function send(page, data) {
  await page.evaluate(
    (data) =>
      window.__e2eShareSocket.send(
        JSON.stringify({ v: 1, kind: "screen", ...data }),
      ),
    data,
  );
}
async function flowing(page, relay = false) {
  await expect
    .poll(() =>
      page.locator(".share-player video").evaluate((v) => v.videoWidth),
    )
    .toBeGreaterThan(0);
  await expect
    .poll(() =>
      page.evaluate(() => window.__mluvkaShareStats?.framesDecoded || 0),
    )
    .toBeGreaterThan(0);
  const before = await page.evaluate(
    () => window.__mluvkaShareStats.framesDecoded,
  );
  await page.waitForTimeout(5200);
  const after = await page.evaluate(
    () => window.__mluvkaShareStats.framesDecoded,
  );
  expect(after).toBeGreaterThan(before + 20);
  if (relay)
    await expect
      .poll(() => page.evaluate(() => window.__mluvkaShareStats?.candidate))
      .toBe("relay");
  return {
    framesBefore: before,
    framesAfter: after,
    ...(await page.evaluate(() => window.__mluvkaShareStats)),
  };
}
export async function sharingChecks({
  a,
  b,
  browser,
  base,
  root,
  query,
  login,
  connected,
  moveToProtected,
  password,
  channelPassword,
  tsAddress,
  ok,
}) {
  expect((await a.request.get(base + "/api/ice")).status()).toBe(401);
  const token = await a.evaluate(() => window.__e2eShareToken);
  const ice = await a.request.get(base + "/api/ice", {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(ice.status()).toBe(200);
  expect(ice.headers()["cache-control"]).toBe("no-store");
  const config = await ice.json(),
    turn = config.iceServers.find((s) => s.username);
  expect(turn).toBeTruthy();
  expect(
    Number(turn.username.split(":")[0]) - Math.floor(Date.now() / 1000),
  ).toBeGreaterThan(43100);
  expect(turn.credential).toBe(
    createHmac("sha1", process.env.TURN_SECRET)
      .update(turn.username)
      .digest("base64"),
  );
  ok("ICE: bez relace 401, s relací dočasný HMAC-SHA1 a platnost 12 hodin");

  // Překročení signalizačního limitu nesmí ukončit TS ani přenos hlasových rámců.
  const beforeFlood = await b.evaluate(
    () => window.__mluvkaStats?.receivedFrames || 0,
  );
  await b.evaluate(async () => {
    const socket = window.__e2eShareSocket;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("WS po zahlcení neodpověděl")),
        5000,
      );
      const listener = ({ data }) => {
        if (typeof data === "string" && JSON.parse(data).type === "pong") {
          clearTimeout(timer);
          socket.removeEventListener("message", listener);
          resolve();
        }
      };
      socket.addEventListener("message", listener);
      for (let i = 0; i < 500; i++)
        socket.send(
          JSON.stringify({
            type: "rtc_ice",
            v: 1,
            kind: "screen",
            to: "missing",
          }),
        );
      socket.send(JSON.stringify({ type: "ping" }));
    });
  });
  await connected(b);
  await expect
    .poll(() => b.evaluate(() => window.__mluvkaStats?.receivedFrames || 0))
    .toBeGreaterThan(beforeFlood);
  expect(
    await b.evaluate(() =>
      window.__e2eShareMessages.some(
        (m) => m.type === "share_error" && m.message.includes("příliš rychle"),
      ),
    ),
  ).toBe(true);
  ok(
    "500 signalizačních zpráv: share_error, WS odpoví pong a hlasové rámce dál přibývají",
  );

  await a.evaluate(() => {
    window.__e2eDelayStartAck = true;
  });
  await a
    .getByRole("button", { name: "Sdílet obrazovku", exact: true })
    .click();
  await expect
    .poll(() => a.evaluate(() => !!window.__e2eDelayedAck))
    .toBe(true);
  await a.evaluate(() => {
    // Opožděný snapshot z doby před share_start dorazí před jeho potvrzením.
    window.__e2eShareSocket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ ...window.__e2eLastList, sharing: false }),
      }),
    );
  });
  await expect(
    a.getByRole("button", { name: "Spouštím…", exact: true }),
  ).toBeVisible();
  expect(
    await a.evaluate(
      () => window.__e2eDisplayStream.getVideoTracks()[0].readyState,
    ),
  ).toBe("live");
  await a.evaluate(() => {
    window.__e2eDelayStartAck = false;
    window.__e2eShareSocket.dispatchEvent(
      new MessageEvent("message", { data: window.__e2eDelayedAck }),
    );
  });
  await expect(a.locator(".share-live")).toContainText("0 diváků");
  ok(
    "Opožděný share_list nezastaví capture; sdílení čeká na share_started a divák se připojí",
  );
  await expect(b.locator(".share-card")).toContainText("Adam");
  await expect(
    b.locator('.share-tree-icon[title="Sdílí obrazovku"]'),
  ).toBeVisible();
  await b.getByRole("button", { name: "Sledovat", exact: true }).click();
  ok("Sdílení A → B: dekódované snímky rostou alespoň 5 s", await flowing(b));
  await expect(a.locator(".share-live")).toContainText("1 diváků");
  for (const page of [a, b])
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - innerWidth,
      ),
    ).toBeLessThanOrEqual(1);
  await a.screenshot({
    path: resolve(root, "docs/screenshots/sdileni-desktop-sdilejici.png"),
  });
  await b.screenshot({
    path: resolve(root, "docs/screenshots/sdileni-desktop-divak.png"),
  });

  const previousOffers = await b.evaluate(
    () =>
      window.__e2eShareMessages.filter((m) => m.type === "rtc_offer").length,
  );
  const previousUfrag = await b.evaluate(
    () =>
      window.__e2eShareMessages
        .filter((m) => m.type === "rtc_offer")
        .at(-1)
        .sdp.sdp.match(/a=ice-ufrag:([^\r\n]+)/)[1],
  );
  await b.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect
    .poll(() =>
      b.evaluate(
        () =>
          window.__e2eShareMessages.filter((m) => m.type === "rtc_offer")
            .length,
      ),
    )
    .toBeGreaterThan(previousOffers);
  expect(
    await b.evaluate(
      () =>
        window.__e2eShareMessages
          .filter((m) => m.type === "rtc_offer")
          .at(-1)
          .sdp.sdp.match(/a=ice-ufrag:([^\r\n]+)/)[1],
    ),
  ).not.toBe(previousUfrag);
  await flowing(b);
  ok("Síťový online vyvolá ICE restart s novým ufrag a přenos pokračuje");

  // Souběžné sdílení oběma směry musí mít dvě nezávislá PeerConnection.
  await b
    .getByRole("button", { name: "Sdílet obrazovku", exact: true })
    .click();
  await a.getByRole("button", { name: "Sledovat", exact: true }).click();
  await flowing(a);
  await a.getByRole("button", { name: "Zavřít sledování" }).click();
  await b.getByRole("button", { name: "Ukončit sdílení" }).click();
  await expect(b.locator(".share-player video")).toBeVisible();
  ok(
    "Dva lidé současně sdílí i sledují; ukončení vlastního sdílení zachová sledování",
  );

  // Obnova po WS reconnectu: stejný UID sdílejícího, nová relace diváka.
  const oldSession = await b.evaluate(() => window.__e2eShareSession);
  await b.evaluate(() => window.__e2eShareSocket.close());
  await expect
    .poll(() => b.evaluate(() => window.__e2eShareSession), { timeout: 45000 })
    .not.toBe(oldSession);
  await connected(b);
  await flowing(b);
  ok("Sledování se obnoví po opětovném přihlášení WS");

  const aSession = await a.evaluate(() => window.__e2eShareSession);
  await b.getByRole("button", { name: "Zavřít sledování" }).click();
  const reserved = [];
  try {
    for (let i = 0; i < 6; i++) {
      const socket = new WebSocket(base.replace(/^http/, "ws") + "/ws");
      reserved.push(socket);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error("Simulovaný divák se nepřihlásil")),
          65000,
        );
        socket.onopen = () =>
          socket.send(
            JSON.stringify({
              type: "connect",
              server: tsAddress,
              password,
              nickname: `Divák ${i + 1}`,
              channel: "Večerní parta",
              channel_password: channelPassword,
            }),
          );
        socket.onmessage = ({ data }) => {
          if (typeof data !== "string") return;
          const msg = JSON.parse(data);
          if (msg.type === "share_session") {
            clearTimeout(timer);
            resolve();
          }
          if (msg.type === "error") {
            clearTimeout(timer);
            reject(Error("Simulovaný divák byl odmítnut"));
          }
        };
      });
      socket.send(
        JSON.stringify({ type: "watch", v: 1, kind: "screen", to: aSession }),
      );
    }
    await expect(a.locator(".share-live")).toContainText("6 diváků", {
      timeout: 15000,
    });
    await b.getByRole("button", { name: "Sledovat", exact: true }).click();
    await expect(b.locator(".share-error")).toContainText("nejvýše 6 diváků");
    ok(
      "Sedmý divák: šest simulovaných WS relací obsadí limit, UI zobrazí českou chybu",
    );
  } finally {
    for (const socket of reserved) socket.close();
  }
  await expect(a.locator(".share-live")).toContainText("0 diváků", {
    timeout: 15000,
  });
  const lobby = /cid=(\d+)/.exec(await query.cmd("channellist"))[1];
  const bClient = Number(
    await b
      .locator(".client-row")
      .filter({ hasText: "Bára" })
      .first()
      .getAttribute("data-client"),
  );
  await query.cmd(`clientmove clid=${bClient} cid=${lobby}`);
  await expect(b.locator(".share-card")).toHaveCount(0, { timeout: 2000 });
  await expect(b.locator(".share-tree-icon")).toHaveCount(0, { timeout: 2000 });
  await expect(b.locator(".share-player")).toHaveCount(0, { timeout: 2000 });
  await send(b, { type: "watch", to: aSession });
  await expect(b.locator(".share-error")).toContainText("stejném kanálu");
  ok(
    "Jiný kanál: karta i přenos zaniknou do 2 s a backend odmítne přímý watch",
  );
  await moveToProtected(b);
  await b.getByRole("button", { name: "Sledovat", exact: true }).click();
  await flowing(b);
  await a.getByRole("button", { name: "Ukončit sdílení" }).click();
  await expect(b.locator(".share-card")).toHaveCount(0, { timeout: 2000 });
  await expect(b.locator(".share-player")).toHaveCount(0, { timeout: 2000 });
  ok("Ukončení sdílení odstraní kartu i video do 2 s");

  const contexts = [];
  try {
    // Nové relace vynutí nový ICE config. Pouze testovací build čte relay příznak.
    const senderContext = await browser.newContext({
      permissions: ["microphone"],
    });
    contexts.push(senderContext);
    const viewerContext = await browser.newContext({
      permissions: ["microphone"],
    });
    contexts.push(viewerContext);
    await installSharingCapture(senderContext, true);
    await installSharingCapture(viewerContext, true);
    const s = await senderContext.newPage(),
      v = await viewerContext.newPage();
    await s.goto(base);
    await v.goto(base);
    await login(s, "TURN vysílá");
    await connected(s);
    await login(v, "TURN sleduje");
    await connected(v);
    await s.getByLabel("Zvuk karty / systému").check();
    await s
      .getByRole("button", { name: "Sdílet obrazovku", exact: true })
      .click();
    await v.getByRole("button", { name: "Sledovat", exact: true }).click();
    ok(
      "Coturn TURN REST: vynucené relay, video i zvuková stopa",
      await flowing(v, true),
    );
    expect(
      await v
        .locator(".share-player audio")
        .evaluate((a) => a.srcObject.getAudioTracks().length),
    ).toBe(1);
    // Přepnutí na mobilní diváckou relaci, vlastní zoom skutečnými dotykovými vstupy CDP.
    await viewerContext.close();
    contexts.pop();
    const mobileContext = await browser.newContext({
      viewport: { width: 852, height: 393 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 1,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
      permissions: ["microphone"],
    });
    contexts.push(mobileContext);
    await installSharingCapture(mobileContext, true);
    const m = await mobileContext.newPage();
    await m.goto(base);
    await login(m, "Mobil sleduje");
    await connected(m);
    await expect(
      m.getByRole("button", { name: "Sdílet obrazovku", exact: true }),
    ).toHaveCount(0);
    // Klepnutí na sdílejícího ve stromu rovnou otevře přehrávač.
    await m.locator(".client-row").filter({ hasText: "TURN vysílá" }).click();
    await flowing(m, true);
    const viewport = m.locator(".share-viewport"),
      rect = await viewport.boundingBox(),
      cdp = await mobileContext.newCDPSession(m);
    const cx = rect.x + rect.width / 2,
      cy = rect.y + rect.height / 2;
    const points = (d) => [
      { x: cx - d, y: cy, id: 1 },
      { x: cx + d, y: cy, id: 2 },
    ];
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: points(35),
    });
    for (const d of [45, 60, 80])
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: points(d),
      });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    expect(Number(await viewport.getAttribute("data-scale"))).toBeGreaterThan(
      1.8,
    );
    expect(await m.evaluate(() => window.visualViewport.scale)).toBe(1);
    expect(
      await m.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await m.screenshot({
      path: resolve(root, "docs/screenshots/sdileni-mobil-sirka.png"),
    });
    await m.getByRole("button", { name: "Obnovit přiblížení" }).click();
    await expect(viewport).toHaveAttribute("data-scale", "1.00");
    ok(
      "iPhone na šířku: relay video, pinch mění jen přehrávač, stránka má scale 1",
    );
    await s.evaluate(() => {
      const track = window.__e2eDisplayStream.getVideoTracks()[0];
      track.stop();
      track.dispatchEvent(new Event("ended"));
    });
    await expect(m.locator(".share-player")).toHaveCount(0, { timeout: 2000 });
    await expect(
      s.getByRole("button", { name: "Sdílet obrazovku", exact: true }),
    ).toBeVisible();
    ok("Systémové track.onended zastaví sdílení i všechny diváky");
  } finally {
    for (const context of contexts.reverse()) await context.close();
  }
  await withoutTurn({ browser, base, root, tsAddress, login, connected, ok });
}

// Druhý backend využívá stejnou zamčenou TS3 instanci, ale skutečně nemá TURN env.
async function withoutTurn({
  browser,
  base,
  root,
  tsAddress,
  login,
  connected,
  ok,
}) {
  const url = new URL(base);
  url.port = String(Number(url.port) + 1);
  const directBase = url.origin;
  const directory = mkdtempSync(resolve(root, "tmp-ts3/sharing-direct-"));
  const backend = spawn(resolve(root, "target/release/mluvka"), [], {
    cwd: root,
    env: {
      ...process.env,
      PORT: url.port,
      PUBLIC_URL: directBase,
      ALLOWED_SERVERS: tsAddress,
      TURN_URLS: "",
      TURN_SECRET: "",
      STUN_URLS: "",
      UPLOAD_DIR: directory,
    },
    stdio: "ignore",
  });
  let startupError;
  backend.on("error", (error) => {
    startupError = error;
  });
  const contexts = [];
  try {
    await expect
      .poll(
        async () => {
          if (startupError || backend.exitCode !== null)
            throw Error("Backend bez TURN nenastartoval");
          return fetch(directBase + "/healthz")
            .then((r) => r.ok)
            .catch(() => false);
        },
        { timeout: 10000 },
      )
      .toBe(true);
    for (let i = 0; i < 2; i++)
      contexts.push(await browser.newContext({ permissions: ["microphone"] }));
    const s = await contexts[0].newPage(),
      v = await contexts[1].newPage();
    await s.goto(directBase);
    await v.goto(directBase);
    await login(s, "Přímé vysílání");
    await connected(s);
    await login(v, "Přímý divák");
    await connected(v);
    const token = await v.evaluate(() => window.__e2eShareToken);
    const config = await (
      await v.request.get(directBase + "/api/ice", {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json();
    expect(config.iceServers).toEqual([]);
    await s
      .getByRole("button", { name: "Sdílet obrazovku", exact: true })
      .click();
    await v.getByRole("button", { name: "Sledovat", exact: true }).click();
    const stats = await flowing(v);
    expect(stats.candidate).toBe("host");
    ok(
      "Bez TURN_URLS: skutečný backend bez ICE serverů přenáší video přímo přes host kandidáta",
      stats,
    );
    await v.getByRole("button", { name: "Zavřít sledování" }).click();
    await v.evaluate(() => {
      window.__e2eBlockOffers = true;
    });
    await v.getByRole("button", { name: "Sledovat", exact: true }).click();
    await expect(v.locator(".share-error")).toHaveText(
      "Přímé spojení se nepodařilo a server nemá TURN — sdílení přes tuhle síť nejde",
      { timeout: 13000 },
    );
    await expect(v.locator(".share-player")).toHaveCount(0);
    await expect(s.locator(".share-live")).toContainText("0 diváků");
    const attempts = await s.evaluate(
      () => window.__e2eShareMessages.filter((m) => m.type === "watch").length,
    );
    await v.waitForTimeout(1500);
    expect(
      await s.evaluate(
        () =>
          window.__e2eShareMessages.filter((m) => m.type === "watch").length,
      ),
    ).toBe(attempts);
    expect(attempts).toBeLessThanOrEqual(3);
    ok(
      "Bez TURN: chybějící offer skončí do 10 s českou chybou, uvolní místo a neopakuje watch",
    );
  } finally {
    for (const context of contexts.reverse()) await context.close();
    if (backend.exitCode === null && backend.signalCode === null && backend.pid)
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          backend.kill("SIGKILL");
          resolve();
        }, 3000);
        backend.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        backend.kill("SIGTERM");
      });
    rmSync(directory, { recursive: true, force: true });
  }
}
