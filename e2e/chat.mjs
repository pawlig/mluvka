import { expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const escapeQuery = (text) =>
  text
    .replaceAll("\\", "\\\\")
    .replaceAll("/", "\\/")
    .replaceAll(" ", "\\s")
    .replaceAll("|", "\\p")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
export async function probe(base, tsAddress, password) {
  const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws");
  const token = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("Chybí upload token přihlášené relace")),
      90000,
    );
    ws.onerror = () => {
      clearTimeout(timer);
      reject(Error("Upload WS selhal"));
    };
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          type: "connect",
          nickname: "Upload test",
          server: tsAddress,
          password,
        }),
      );
    ws.onmessage = ({ data }) => {
      if (typeof data !== "string") return;
      const message = JSON.parse(data);
      if (message.type === "error") {
        clearTimeout(timer);
        reject(Error("Upload test se nepřihlásil k TS"));
      }
      if (message.type === "upload_token") {
        clearTimeout(timer);
        resolve(message.token);
      }
    };
  });
  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: "ping" }));
  }, 5000);
  return {
    token,
    close: () => {
      clearInterval(ping);
      ws.close();
    },
  };
}
export async function chatChecks({
  a,
  b,
  query,
  base,
  root,
  tsAddress,
  password,
  ok,
}) {
  for (const page of [a, b])
    await page.getByRole("button", { name: "Server", exact: true }).click();
  // Doručení sledujeme na WS příjemce, ne v optimistické bublině odesílatele.
  // Antiflood fronta může legitimně rozložit rychlou sérii do několika sekund.
  const wire = await b.context().newCDPSession(b);
  await wire.send("Network.enable");
  const deliveryCounts = new Map();
  wire.on("Network.webSocketFrameReceived", ({ response }) => {
    if (response.opcode !== 1) return;
    try {
      const message = JSON.parse(response.payloadData);
      if (message.type === "chat")
        deliveryCounts.set(message.text, (deliveryCounts.get(message.text) || 0) + 1);
    } catch {
      /* Jiné protokolové rámce nejsou chat. */
    }
  });
  const send = async (text) => {
    const before = deliveryCounts.get(text) || 0;
    await a.getByLabel("Zpráva", { exact: true }).fill(text);
    await a
      .getByRole("button", { name: "Odeslat zprávu", exact: true })
      .click();
    await expect
      .poll(() => deliveryCounts.get(text) || 0, { timeout: 15000 })
      .toBeGreaterThan(before);
  };
  const text =
    "Koukni na https://example.org/a?b=1 a [URL=https://example.org]tohle[/URL] javascript:alert(1) [B]tučně[/B] <script>window.chatXss=1</script>";
  await send(text);
  const message = b.locator(".message").filter({ hasText: "Koukni na" }).last();
  await expect(message.locator("a")).toHaveCount(2);
  for (const anchor of await message.locator("a").all()) {
    await expect(anchor).toHaveAttribute("target", "_blank");
    await expect(anchor).toHaveAttribute("rel", "noopener noreferrer nofollow");
  }
  await expect(
    message.locator("strong").filter({ hasText: "tučně" }),
  ).toHaveCount(1);
  await expect(message).toContainText("javascript:alert(1)");
  await expect(message).toContainText("<script>window.chatXss=1</script>");
  expect(await b.evaluate(() => window.chatXss)).toBeUndefined();
  await send(
    "[I]kurzíva[/I] [U]podtržené[/U] [S]škrtnuté[/S] [COLOR=black]čitelná barva[/COLOR] [COLOR=red;position:fixed]bez CSS[/COLOR] [NEZNÁMÉ]text[/NEZNÁMÉ] [URL=javascript:alert(1)]nebezpečné[/URL] www.example.org [URL]https://example.org/b[/URL] ts3server://voice.example.org",
  );
  const styles = b.locator(".message").filter({ hasText: "kurzíva" }).last();
  await expect(styles.locator("em")).toHaveText("kurzíva");
  await expect(styles.locator("u")).toHaveText("podtržené");
  await expect(styles.locator("s")).toHaveText("škrtnuté");
  await expect(styles.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(styles.locator('a[href^="ts3server:"]')).not.toHaveAttribute(
    "target",
  );
  await expect(styles).toContainText("[NEZNÁMÉ]text[/NEZNÁMÉ]");
  expect(
    await styles
      .getByText("čitelná barva", { exact: true })
      .evaluate((el) => getComputedStyle(el).color),
  ).not.toBe("rgb(0, 0, 0)");
  ok("Chat: bezpečné URL, BBCode, barvy, neznámé značky a HTML bez spuštění");

  const attachment =
    '{"msg_type":"ts.file.myts","file_id":"…","chat_user_id":"@…:chat-8.tmspk.net","file_name":"9854755_78f48.gif","file_size":1301257,"body":"9854755_78f48.gif","v2":true}';
  await query.cmd(
    `sendtextmessage targetmode=3 target=1 msg=${escapeQuery(attachment)}`,
  );
  const card = b.locator(".ts-attachment").last();
  await expect(card).toContainText("9854755_78f48.gif · 1,2 MB");
  await expect(card).toContainText("TeamSpeak 5/6");
  await expect(card).toContainText(
    "leží na serveru myTeamSpeak a bez účtu je stáhnout nejde",
  );
  await expect(b.getByRole("log")).not.toContainText('"msg_type"');
  await query.cmd(
    `sendtextmessage targetmode=3 target=1 msg=${escapeQuery('{"msg_type":"ts.other","body":"Text novějšího klienta"}')}`,
  );
  await expect(b.getByRole("log")).toContainText("Text novějšího klienta");
  await query.cmd(
    `sendtextmessage targetmode=3 target=1 msg=${escapeQuery('{"msg_type":"ts.other"}')}`,
  );
  await expect(b.getByRole("log")).toContainText(
    "Zpráva z novějšího TeamSpeaku, kterou Mluvka neumí zobrazit",
  );
  await send('{"neplatný JSON');
  await expect(b.getByRole("log")).toContainText('{"neplatný JSON');
  ok(
    "TS5/TS6 JSON přes ServerQuery: karta, velikost, fallback; bez surového JSON",
  );

  const pngPath = resolve(root, "e2e/fixtures/gps.png"),
    gifPath = resolve(root, "e2e/fixtures/animated.gif");
  const png = readFileSync(pngPath),
    gif = readFileSync(gifPath);
  expect(png.includes(Buffer.from("eXIf"))).toBe(true);
  const chooser = a.waitForEvent("filechooser");
  await a.getByRole("button", { name: "Přidat soubor" }).click();
  await (await chooser).setFiles(pngPath);
  await expect(a.getByAltText("Náhled před odesláním")).toBeVisible();
  await a.getByLabel("Zpráva", { exact: true }).fill("Fotka bez polohy");
  await a.getByRole("button", { name: "Odeslat obrázek" }).click();
  const received = b
    .locator(".message")
    .filter({ hasText: "Fotka bez polohy" })
    .last();
  const preview = received.locator(".image-preview img");
  await expect
    .poll(() => preview.evaluate((img) => img.naturalWidth))
    .toBeGreaterThan(0);
  expect(
    await preview.evaluate((img) =>
      Math.max(img.naturalWidth, img.naturalHeight),
    ),
  ).toBeLessThanOrEqual(2048);
  const url = await preview.getAttribute("src");
  const response = await fetch(url),
    output = Buffer.from(await response.arrayBuffer());
  expect(response.headers.get("content-type")).toMatch(/^image\/(jpeg|png)$/);
  expect(url).toMatch(/\/img\/[\w-]+\.(jpg|png)$/);
  await expect
    .poll(() => query.messages.find((m) => m.startsWith("Fotka bez polohy\n")), { timeout: 30000 })
    .toBe(`Fotka bez polohy\n${url}`);
  expect(
    query.messages.find((m) => m.startsWith("Fotka bez polohy\n")),
  ).not.toMatch(/\[IMG\]/i);
  expect(response.headers.get("cache-control")).toBe(
    "public, max-age=604800, immutable",
  );
  expect(response.headers.get("content-security-policy")).toBe(
    "default-src 'none'",
  );
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  for (const marker of ["EXIF", "Exif", "eXIf", "GPS"])
    expect(output.includes(Buffer.from(marker))).toBe(false);
  await received.getByRole("button", { name: "Otevřít obrázek" }).click();
  const viewer = b.getByRole("dialog", { name: "Prohlížeč obrázku" });
  await expect(viewer).toBeVisible();
  expect(
    await viewer.evaluate((el) => ({ w: el.clientWidth, h: el.clientHeight })),
  ).toEqual({ w: 1440, h: 900 });
  await b.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await send(`Samostatný odkaz ${url}?preview=1`);
  const bare = b
    .locator(".message")
    .filter({ hasText: "Samostatný odkaz" })
    .last();
  await expect
    .poll(() => bare.locator("img").evaluate((img) => img.naturalWidth))
    .toBeGreaterThan(0);
  ok(
    "A → B PNG s GPS: canvas odstraní EXIF, resize ≤2048, náhled i holá URL, viewer a Esc",
  );

  // Skutečně odeslaný JPEG a PNG: žádná závislost na metadatech/názvu vstupu.
  for (const kind of ["photo", "transparent", "screenshot"]) {
    const encoded = await a.evaluate((kind) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 128;
      const ctx = canvas.getContext("2d");
      if (kind === "photo") {
        const pixels = ctx.createImageData(128, 128);
        for (let i = 0; i < pixels.data.length; i += 4) {
          pixels.data[i] = (i * 73) % 251;
          pixels.data[i + 1] = Math.floor(i / 128) % 256;
          pixels.data[i + 2] = (i * 13 + Math.floor(i / 256) * 17) % 253;
          pixels.data[i + 3] = 255;
        }
        ctx.putImageData(pixels, 0, 0);
      } else {
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, 128, 128);
        ctx.fillStyle = "#234";
        ctx.fillRect(20, 20, 50, 50);
        if (kind === "transparent") ctx.clearRect(0, 0, 1, 1);
      }
      return canvas
        .toDataURL(kind === "photo" ? "image/jpeg" : "image/png")
        .split(",")[1];
    }, kind);
    await a
      .getByLabel("Vybrat soubory")
      .setInputFiles({
        name: `${kind}.png`,
        mimeType: "image/png",
        buffer: Buffer.from(encoded, "base64"),
      });
    await expect(a.getByAltText("Náhled před odesláním")).toBeVisible();
    await a.getByLabel("Zpráva", { exact: true }).fill(`Formát ${kind}`);
    await a
      .getByRole("button", { name: "Odeslat obrázek", exact: true })
      .click();
    const img = b
      .locator(".message")
      .filter({ hasText: `Formát ${kind}` })
      .last()
      .locator(".image-preview img");
    await expect
      .poll(() => img.evaluate((image) => image.naturalWidth), { timeout: 30000 })
      .toBe(128);
    const outputUrl = await img.getAttribute("src");
    expect(outputUrl).toMatch(kind === "photo" ? /\.jpg$/ : /\.png$/);
    await expect
      .poll(() => query.messages.find((m) => m.startsWith(`Formát ${kind}\n`)), { timeout: 30000 })
      .toBe(`Formát ${kind}\n${outputUrl}`);
    if (kind === "transparent")
      expect(
        await img.evaluate((img) => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 128;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0);
          return ctx.getImageData(0, 0, 1, 1).data[3];
        }),
      ).toBe(0);
  }
  ok(
    "Odchozí zprávy zachycené ServerQuery: holé URL bez IMG; fotografie JPEG, průhlednost a malá paleta PNG",
  );

  await a.getByLabel("Vybrat soubory").setInputFiles(gifPath);
  await expect(a.getByAltText("Náhled před odesláním")).toBeVisible();
  await a.getByLabel("Zpráva", { exact: true }).fill("Animovaný GIF");
  await a.getByRole("button", { name: "Odeslat obrázek" }).click();
  const gifImage = b
    .locator(".message")
    .filter({ hasText: "Animovaný GIF" })
    .last()
    .locator(".image-preview img");
  await expect
    .poll(() => gifImage.evaluate((img) => img.naturalWidth), { timeout: 30000 })
    .toBeGreaterThan(0);
  expect(
    Buffer.from(
      await (await fetch(await gifImage.getAttribute("src"))).arrayBuffer(),
    ),
  ).toEqual(gif);
  ok("A → B GIF: zachované bajty animovaného souboru");
  await send(`Nedostupný obrázek [IMG]${base}/healthz[/IMG]`);
  const broken = b
    .locator(".message")
    .filter({ hasText: "Nedostupný obrázek" })
    .last();
  await expect(broken.locator("a")).toHaveCount(1);
  await expect(broken.locator(".image-preview")).toHaveCount(0);
  ok("Nenačtený obrázek ponechá pouze bezpečný odkaz");

  for (const kind of ["paste", "drop"]) {
    await a.locator(".chat-panel").evaluate(
      (el, { data, kind }) => {
        const file = new File(
          [Uint8Array.from(atob(data), (c) => c.charCodeAt(0))],
          "clipboard.gif",
          { type: "image/gif" },
        );
        const transfer = new DataTransfer();
        transfer.items.add(file);
        el.dispatchEvent(
          kind === "paste"
            ? new ClipboardEvent("paste", {
                clipboardData: transfer,
                bubbles: true,
                cancelable: true,
              })
            : new DragEvent("drop", {
                dataTransfer: transfer,
                bubbles: true,
                cancelable: true,
              }),
        );
      },
      { data: gif.toString("base64"), kind },
    );
    await expect(a.getByAltText("Náhled před odesláním")).toBeVisible();
    await a.getByRole("button", { name: "Zrušit", exact: true }).click();
    await expect(a.getByAltText("Náhled před odesláním")).toHaveCount(0);
  }
  ok("Schránka a přetažení obrázku otevřou náhled, Zrušit jej odstraní");

  await send(
    `Fotka z výletu: https://example.org a [URL=https://example.org]další odkaz[/URL]`,
  );
  await query.cmd(
    `sendtextmessage targetmode=3 target=1 msg=${escapeQuery(attachment)}`,
  );
  await send(`[IMG]${url}[/IMG]`);
  await expect(b.locator(".ts-attachment")).toHaveCount(2);
  await a
    .locator(".messages")
    .evaluate((el) =>
      el.scrollTo({ top: el.scrollHeight, behavior: "instant" }),
    );
  await expect(a.locator(".ts-attachment").last()).toBeVisible();
  await expect
    .poll(() =>
      a
        .locator(".image-preview img")
        .last()
        .evaluate((img) => img.naturalWidth),
    )
    .toBeGreaterThan(0);
  await a.screenshot({
    path: resolve(root, "docs/screenshots/chat-desktop.png"),
  });
  await b.setViewportSize({ width: 390, height: 960 });
  await b.getByRole("button", { name: "Chat", exact: true }).click();
  const mobileChooser = b.waitForEvent("filechooser");
  await b.getByRole("button", { name: "Přidat soubor" }).click();
  await (await mobileChooser).setFiles(gifPath);
  await expect(b.getByAltText("Náhled před odesláním")).toBeVisible();
  await b.getByRole("button", { name: "Zrušit", exact: true }).click();
  // Screenshot obsahuje odkazy, přílohu i obrázek v jednom výřezu.
  await b.locator(".ts-attachment").last().scrollIntoViewIfNeeded();
  await b.locator(".messages").evaluate((el) => {
    const card = el.querySelector(".ts-attachment:last-of-type");
    el.style.scrollBehavior = "auto";
    el.scrollTop = el.scrollHeight;
  });
  await b.screenshot({
    path: resolve(root, "docs/screenshots/chat-mobil.png"),
  });
  await b.setViewportSize({ width: 390, height: 844 });
  await send(
    `Dlouhá URL https://example.org/${"velmi-dlouha-cesta".repeat(30)}`,
  );
  await expect(b.getByRole("log")).toContainText("Dlouhá URL");
  expect(
    await b.evaluate(
      () =>
        document.documentElement.scrollWidth <= innerWidth &&
        document.querySelector(".messages").scrollWidth <=
          document.querySelector(".messages").clientWidth,
    ),
  ).toBe(true);
  const mobileImage = b.locator(".image-preview").first();
  await mobileImage.scrollIntoViewIfNeeded();
  await mobileImage.click();
  await expect(viewer).toBeVisible();
  const cdp = await b.context().newCDPSession(b);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { x: 140, y: 350, id: 1 },
      { x: 240, y: 350, id: 2 },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { x: 80, y: 350, id: 1 },
      { x: 300, y: 350, id: 2 },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect
    .poll(() =>
      viewer
        .locator("img")
        .evaluate(
          (img) => new DOMMatrixReadOnly(getComputedStyle(img).transform).a,
        ),
    )
    .toBeGreaterThan(1);
  expect(await b.evaluate(() => visualViewport.scale)).toBe(1);
  await b.keyboard.press("Escape");
  await mobileImage.click();
  await b.mouse.move(190, 250);
  await b.mouse.down();
  await b.mouse.move(190, 450, { steps: 5 });
  await b.mouse.up();
  await expect(viewer).toHaveCount(0);
  expect(await b.evaluate(() => visualViewport.scale)).toBe(1);
  await mobileImage.click();
  await viewer.click({ position: { x: 20, y: 400 } });
  await expect(viewer).toHaveCount(0);
  await b.setViewportSize({ width: 1440, height: 900 });
  ok(
    "Mobil: dlouhá URL bez přesahu, výběr souboru, viewer zavře tažení; stránka 100 %",
  );

  const post = (body, token, headers = {}) =>
    fetch(`${base}/api/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "image/png",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body,
    });
  expect((await post(png)).status).toBe(401);
  expect((await post(png, "neplatny")).status).toBe(401);
  let session = await probe(base, tsAddress, password);
  try {
    for (const fake of [
      "<svg xmlns='http://www.w3.org/2000/svg'/>",
      "<!doctype html><script>alert(1)</script>",
    ])
      expect(
        (
          await post(fake, session.token, {
            "Content-Disposition": 'attachment; filename="image.png"',
          })
        ).status,
      ).toBe(415);
    const large = Buffer.alloc(10 * 1024 * 1024 + 1);
    png.copy(large);
    expect((await post(large, session.token)).status).toBe(413);
    const largeGif = Buffer.alloc(8 * 1024 * 1024 + 1);
    gif.copy(largeGif);
    expect((await post(largeGif, session.token)).status).toBe(413);
  } finally {
    session.close();
  }
  await expect
    .poll(async () => (await post(gif, session.token)).status)
    .toBe(401);
  session = await probe(base, tsAddress, password);
  try {
    for (let i = 0; i < 10; i++)
      expect((await post(gif, session.token)).status).toBe(201);
    expect((await post(gif, session.token)).status).toBe(429);
  } finally {
    session.close();
  }
  ok(
    "Upload API: 401 bez/po relaci, SVG/HTML 415, 10 MiB a GIF 8 MiB 413, jedenáctý upload 429",
  );
  // Úprava odeslaných zpráv: ↑ v prázdném poli a tužka; na drátě nová zpráva s opravou.
  const field = (page) => page.getByLabel("Zpráva", { exact: true });
  const delivered = (text) => () => deliveryCounts.get(text) || 0;
  const editBar = a.locator(".edit-bar");
  const edited = (page, text) =>
    page
      .locator(".message")
      .filter({ has: page.locator(".message-text", { hasText: text }) });
  const correction = "✎ oprava „Ahoj všichni“: Ahoj všem";
  await send("Ahoj všichni");
  await field(a).focus();
  await field(a).press("ArrowUp");
  await expect(field(a)).toHaveValue("Ahoj všichni");
  await expect(editBar).toContainText("Upravujete zprávu · Esc zrušit");
  await expect(
    a.getByRole("button", { name: "Uložit úpravu", exact: true }),
  ).toBeVisible();
  // Pruh úpravy nesmí upravovanou zprávu odsunout pod okraj logu.
  await expect(
    a.locator(".message[data-editing] .message-text"),
  ).toBeInViewport({ ratio: 1 });
  await a.screenshot({
    path: resolve(root, "docs/screenshots/uprava-desktop.png"),
  });
  await field(a).fill("Ahoj všem");
  await field(a).press("Enter");
  await expect.poll(delivered(correction), { timeout: 15000 }).toBe(1);
  await a.waitForTimeout(700);
  for (const page of [a, b]) {
    await expect(page.getByText("Ahoj všem", { exact: true })).toHaveCount(1);
    await expect(edited(page, "Ahoj všem").locator(".message-edited")).toHaveText(
      "upraveno",
    );
    await expect(page.getByRole("log")).not.toContainText("Ahoj všichni");
    await expect(page.getByRole("log")).not.toContainText("✎ oprava");
  }
  await expect(editBar).toHaveCount(0);
  await expect(field(a)).toHaveValue("");
  await expect
    .poll(() => query.messages.includes(correction), { timeout: 15000 })
    .toBe(true);
  await b.setViewportSize({ width: 390, height: 844 });
  await b.locator(".messages").evaluate((el) => {
    el.style.scrollBehavior = "auto";
    el.scrollTop = el.scrollHeight;
  });
  await b.screenshot({
    path: resolve(root, "docs/screenshots/uprava-mobil.png"),
  });
  await b.setViewportSize({ width: 1440, height: 900 });
  // Zprávy s obrázkem tužku nemají, textové vlastní ano.
  await expect(
    edited(a, "Fotka bez polohy").getByRole("button", { name: "Upravit zprávu" }),
  ).toHaveCount(0);
  await expect(
    edited(a, "Ahoj všem").getByRole("button", { name: "Upravit zprávu" }),
  ).toHaveCount(1);
  // Oprava bez původní zprávy (jiný odesílatel, příjemce originál neviděl) je běžná zpráva.
  const orphan = "✎ oprava „Tohle nikdo neposlal“: Samotná oprava";
  await query.cmd(
    `sendtextmessage targetmode=3 target=1 msg=${escapeQuery(orphan)}`,
  );
  await expect(b.getByRole("log")).toContainText(orphan);
  // Kanál: totéž přes ↑.
  for (const page of [a, b])
    await page
      .locator(".chat-tabs")
      .getByRole("button", { name: "Kanál", exact: true })
      .click();
  await send("Kanál první");
  await field(a).focus();
  await field(a).press("ArrowUp");
  await expect(field(a)).toHaveValue("Kanál první");
  await field(a).fill("Kanál druhý");
  await field(a).press("Enter");
  await expect
    .poll(delivered("✎ oprava „Kanál první“: Kanál druhý"), { timeout: 15000 })
    .toBe(1);
  await a.waitForTimeout(700);
  for (const page of [a, b]) {
    await expect(page.getByText("Kanál druhý", { exact: true })).toHaveCount(1);
    await expect(page.getByRole("log")).not.toContainText("Kanál první");
  }
  // Soukromá konverzace: tužkou starší zprávu, pořadí zůstane.
  await a.locator(".client-row").filter({ hasText: "Bára" }).click();
  await a.getByRole("button", { name: "Napsat zprávu" }).click();
  await send("Soukromá první");
  await send("Soukromá druhá");
  await edited(a, "Soukromá první")
    .getByRole("button", { name: "Upravit zprávu" })
    .click();
  await expect(field(a)).toHaveValue("Soukromá první");
  await expect(editBar).toBeVisible();
  await field(a).fill("Soukromá první upravená");
  await field(a).press("Enter");
  await expect
    .poll(
      delivered("✎ oprava „Soukromá první“: Soukromá první upravená"),
      { timeout: 15000 },
    )
    .toBe(1);
  await b
    .locator(".chat-tabs")
    .getByRole("button", { name: /^Adam(?: |$)/ })
    .click();
  await a.waitForTimeout(700);
  // Starší soukromé zprávy z dřívějších kroků (upozornění) zůstávají; kontrolujeme poslední dvě a pořadí.
  for (const page of [a, b]) {
    await expect
      .poll(async () => (await page.locator(".message-text").allTextContents()).slice(-2))
      .toEqual(["Soukromá první upravená", "Soukromá druhá"]);
    const texts = await page.locator(".message-text").allTextContents();
    expect(texts.filter((t) => t.includes("Soukromá první"))).toEqual(["Soukromá první upravená"]);
    expect(texts.some((t) => t.includes("✎ oprava"))).toBe(false);
  }
  // Esc úpravu zruší a nic se neodešle.
  const total = () =>
    [...deliveryCounts.values()].reduce((sum, value) => sum + value, 0);
  const before = total();
  await edited(a, "Soukromá druhá")
    .getByRole("button", { name: "Upravit zprávu" })
    .click();
  await expect(field(a)).toHaveValue("Soukromá druhá");
  await field(a).press("Escape");
  await expect(editBar).toHaveCount(0);
  await expect(field(a)).toHaveValue("");
  await a.waitForTimeout(1500);
  expect(total()).toBe(before);
  ok(
    "Úprava zpráv: ↑ a tužka, oprava na drátě, náhrada na místě i v soukromé konverzaci, štítek upraveno, Esc, osamocená oprava",
  );
  for (const page of [a, b])
    await page
      .locator(".chat-tabs")
      .getByRole("button", { name: "Kanál", exact: true })
      .click();
  await wire.detach();
}
