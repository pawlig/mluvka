import { expect } from "@playwright/test";
import { randomBytes, createHash } from "node:crypto";
import { connect } from "node:net";
import { request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { probe, escapeQuery } from "./chat.mjs";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const unescapeQuery = (s) =>
  s.replace(
    /\\([\\/spnr])/g,
    (_, c) => ({ s: " ", p: "|", n: "\n", r: "\r" })[c] || c,
  );
async function nativeUpload(query, channel, name, bytes, password = "") {
  const response = await query.cmd(
    `ftinitupload clientftfid=1 name=${escapeQuery(`/${name}`)} cid=${channel} cpw=${escapeQuery(password)} size=${bytes.length} overwrite=1 resume=0 proto=1`,
  );
  const rawKey = /\bftkey=([^\s]+)/.exec(response)?.[1];
  const key = rawKey && unescapeQuery(rawKey);
  const port = Number(/\bport=(\d+)/.exec(response)?.[1]);
  expect(key).toBeTruthy();
  expect(port).toBe(Number(process.env.TS3_FT_PORT || 30033));
  await new Promise((resolve, reject) => {
    let written = false;
    const socket = connect({ host: "127.0.0.1", port }, () =>
      socket.end(Buffer.concat([Buffer.from(key), bytes]), () => {
        written = true;
      }),
    );
    socket.setTimeout(10000, () => socket.destroy(Error("TS upload timeout")));
    socket.on("error", (error) => {
      if (error.code !== "ECONNRESET" || !written) reject(error);
    });
    socket.on("close", () =>
      written ? resolve() : reject(Error("TS upload selhal")),
    );
  });
  // TS může po posledním bajtu ukončit TCP resetem. Úspěch potvrzuje server i následný SHA-256.
  await expect
    .poll(async () => {
      const info = await query.cmd(
        `ftgetfileinfo cid=${channel} cpw=${escapeQuery(password)} name=${escapeQuery(`/${name}`)}`,
      );
      return Number(/\bsize=(\d+)/.exec(info)?.[1]);
    })
    .toBe(bytes.length);
}
async function browserDownload(page, card, expected) {
  const download = page.waitForEvent("download");
  await card.getByText("Stáhnout", { exact: true }).click();
  const file = await download;
  expect(await file.failure()).toBeNull();
  expect(sha(readFileSync(await file.path()))).toBe(sha(expected));
}
export async function fileChecks({
  a,
  b,
  query,
  base,
  root,
  tsAddress,
  password,
  channelPassword,
  ok,
}) {
  const send = async (text) => {
    await a.getByLabel("Zpráva", { exact: true }).fill(text);
    await a
      .getByRole("button", { name: "Odeslat zprávu", exact: true })
      .click();
  };
  await a
    .getByLabel("Vybrat soubory")
    .setInputFiles({
      name: "poskozeny.png",
      mimeType: "image/png",
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
  await expect(a.getByRole("alert")).toContainText("Obrázek nelze připravit.");
  const bytes = randomBytes(5 * 1024 * 1024);
  await a.getByLabel("Vybrat soubory").setInputFiles({
    name: "zkouska.zip",
    mimeType: "application/zip",
    buffer: bytes,
  });
  await expect(a.locator(".pending-image")).toContainText("zkouska.zip");
  await a.getByRole("button", { name: "Odeslat soubory", exact: true }).click();
  const zip = b.locator(".file-card").filter({ hasText: "zkouska.zip" }).last();
  await expect(zip).toBeVisible();
  await browserDownload(b, zip, bytes);
  const url = await zip.locator("a").getAttribute("href");
  const response = await fetch(url);
  expect(sha(Buffer.from(await response.arrayBuffer()))).toBe(sha(bytes));
  for (const [key, value] of Object.entries({
    "content-type": "application/octet-stream",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cache-control": "private, max-age=604800",
  }))
    expect(response.headers.get(key)).toBe(value);
  expect(response.headers.get("content-disposition")).toMatch(
    /^attachment; filename\*=UTF-8''zkouska.zip$/,
  );
  ok(
    "Soubor A → B: 5 MiB náhodných bajtů, karta, download a SHA-256; attachment/octet-stream/nosniff/CSP/cache",
  );
  const post = (body, token, name = "x.html") =>
    new Promise((resolve, reject) => {
      const request = httpRequest(
        `${base}/api/upload`,
        {
          method: "POST",
          headers: {
            "Transfer-Encoding": "chunked",
            "X-File-Name": encodeURIComponent(name),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () =>
            resolve({
              status: response.statusCode,
              json: async () => JSON.parse(Buffer.concat(chunks).toString()),
            }),
          );
        },
      );
      request.on("error", reject);
      request.end(body);
    });
  expect((await post(Buffer.alloc(16))).status).toBe(401);
  expect((await post(Buffer.alloc(16), "cizi-token")).status).toBe(401);
  const session = await probe(base, tsAddress, password);
  try {
    expect(
      (await post(Buffer.alloc(25 * 1024 * 1024 + 1), session.token)).status,
    ).toBe(413);
    const html = Buffer.from(
      "<!doctype html><script>window.fileXss=1</script>",
    );
    const uploaded = await post(html, session.token);
    expect(uploaded.status).toBe(201);
    const { url } = await uploaded.json();
    await send(`[URL=${url}]x.html[/URL]`);
    const card = b.locator(".file-card").filter({ hasText: "x.html" }).last();
    await expect(card).toBeVisible();
    await browserDownload(b, card, html);
    expect(await b.evaluate(() => window.fileXss)).toBeUndefined();
    const downloaded = await fetch(url);
    expect(downloaded.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(downloaded.headers.get("content-disposition")).toContain(
      "attachment;",
    );
    const foreign = `ts3file://example.org?port=9987&channel=1&path=/&filename=cizi.zip&isDir=0&size=1`;
    const api = (url, token = session.token) =>
      fetch(`${base}/api/ts-file?${new URLSearchParams({ url })}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    expect((await api(foreign, "cizi-token")).status).toBe(401);
    expect((await api(foreign)).status).toBe(403);
    const hostile = `ts3file://${tsAddress.split(":")[0]}?port=${tsAddress.split(":")[1]}&channel=1&path=/../x&filename=x.zip&isDir=0&size=1`;
    expect((await api(hostile)).status).toBe(400);
    await send(`[URL=${foreign}]cizi.zip[/URL]`);
    const foreignCard = b
      .locator(".file-card")
      .filter({ hasText: "cizi.zip" })
      .last();
    await expect(foreignCard).toContainText("Soubor z jiného serveru");
    await expect(foreignCard.locator("a,button")).toHaveCount(0);
  } finally {
    session.close();
  }
  ok(
    "Soubory API: >25 MiB 413, bez/cizí token 401, HTML jen příloha, cizí TS server 403, path=/../x 400",
  );

  for (const kind of ["paste", "drop"]) {
    await a.locator(".chat-panel").evaluate((el, kind) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File(["soubor ze schranky"], `vlozeny-${kind}.txt`, {
          type: "text/plain",
        }),
      );
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
    }, kind);
    await expect(a.locator(".pending-image")).toContainText(
      `vlozeny-${kind}.txt`,
    );
    await a.getByRole("button", { name: "Zrušit", exact: true }).click();
    await expect(a.locator(".pending-image")).toHaveCount(0);
  }
  await a.getByLabel("Vybrat soubory").setInputFiles([
    { name: "prvni.txt", mimeType: "text/plain", buffer: Buffer.from("prvni") },
    {
      name: "druhy.zip",
      mimeType: "application/zip",
      buffer: Buffer.from("druhy"),
    },
  ]);
  await expect(a.locator(".pending-image")).toContainText("2 souborů");
  await a.getByRole("button", { name: "Odeslat soubory", exact: true }).click();
  await expect(
    b.locator(".file-card").filter({ hasText: "druhy.zip" }),
  ).toBeVisible();
  const names = await b.locator(".file-card strong").allTextContents();
  expect(names.indexOf("prvni.txt")).toBeLessThan(names.indexOf("druhy.zip"));
  ok(
    "Libovolné přílohy: paste/drop a zrušení, více vybraných souborů dorazí postupně",
  );

  const info = await query.cmd("serverinfo");
  const uid = unescapeQuery(
    /\bvirtualserver_unique_identifier=([^\s]+)/.exec(info)[1],
  );
  const channels = await query.cmd("channellist");
  const protectedId = /cid=(\d+)[^|]*channel_name=Večerní\\sparta/.exec(
    channels,
  )[1];
  const native = randomBytes(128 * 1024);
  const host = tsAddress.split(":")[0],
    port = tsAddress.split(":")[1];
  for (const [channel, name] of [
    [1, "kanal.zip"],
    [protectedId, "chraneny.zip"],
  ]) {
    await nativeUpload(
      query,
      channel,
      name,
      native,
      channel === 1 ? "" : channelPassword,
    );
    const link = `ts3file://${host}?${new URLSearchParams({ port, serverUID: uid, channel: String(channel), path: "/", filename: name, isDir: "0", size: String(native.length), fileDateTime: "0" })}`;
    await send(`[URL=${link}]${name}[/URL]`);
    const card = b.locator(".file-card").filter({ hasText: name }).last();
    await expect(card).toContainText(
      channel === 1 ? "Soubor kanálu Lobby" : "Soubor kanálu Večerní parta",
    );
    await browserDownload(b, card, native);
    if (channel === 1) {
      // Stejný skutečný TS přenos i přes API; kontrola hlaviček a UID.
      const session = await probe(base, tsAddress, password);
      try {
        const res = await fetch(
          `${base}/api/ts-file?${new URLSearchParams({ url: link })}`,
          { headers: { Authorization: `Bearer ${session.token}` } },
        );
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe(
          "application/octet-stream",
        );
        expect(res.headers.get("content-disposition")).toContain("attachment;");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(sha(Buffer.from(await res.arrayBuffer()))).toBe(sha(native));
      } finally {
        session.close();
      }
    }
  }
  const access = await probe(base, tsAddress, password);
  try {
    const linkFor = (channel, name) =>
      `ts3file://${host}?${new URLSearchParams({ port, serverUID: uid, channel: String(channel), path: "/", filename: name, isDir: "0" })}`;
    const download = (url) =>
      fetch(`${base}/api/ts-file?${new URLSearchParams({ url })}`, {
        headers: { Authorization: `Bearer ${access.token}` },
      });
    const protectedResponse = await download(
      linkFor(protectedId, "chraneny.zip"),
    );
    expect(protectedResponse.status).toBe(403);
    expect(await protectedResponse.text()).toContain(
      "Soubor je v kanálu s heslem",
    );
    expect(
      (
        await download(
          linkFor(1, "kanal.zip").replace(encodeURIComponent(uid), "jinyUID"),
        )
      ).status,
    ).toBe(403);
    await query.cmd(
      "channeladdperm cid=1 permsid=i_ft_needed_file_download_power permvalue=10000",
    );
    try {
      const denied = await download(linkFor(1, "kanal.zip"));
      expect(denied.status).toBe(403);
      expect(await denied.text()).toContain("oprávnění");
    } finally {
      await query.cmd(
        "channeladdperm cid=1 permsid=i_ft_needed_file_download_power permvalue=0",
      );
    }
    await nativeUpload(query, 1, "nad-limit.zip", randomBytes(2 * 1024 * 1024));
    expect((await download(linkFor(1, "nad-limit.zip"))).status).toBe(413);
  } finally {
    access.close();
  }
  await send("Chat po odmítnutém přenosu funguje");
  await expect(b.getByRole("log")).toContainText(
    "Chat po odmítnutém přenosu funguje",
  );
  ok(
    "TS přenos: neznámé heslo a nesouhlasící UID 403, nedostatečný download power česká chyba, nakonfigurovaný strop 1 MiB → 413; chat pokračuje",
  );
  ok(
    "TS3 ftinitupload na vlastním FT portu → ts3file karta → download SHA-256, včetně známého hesla kanálu",
  );

  // Zpráva od A umožňuje ověřit soukromou žádost skutečně doručenou odesílateli.
  await send(
    JSON.stringify({
      msg_type: "ts.file.myts",
      file_id: "YWdk",
      chat_user_id: "@test:example.org",
      file_name: "teamspeak-spotify-bot-integration.zip",
      file_size: 111303,
      body: "teamspeak-spotify-bot-integration.zip",
      v2: true,
    }),
  );
  const myts = b.locator(".ts-attachment").last();
  await expect(myts).toContainText("108,7 kB");
  await expect(myts).toContainText("Soubor z TeamSpeak 5/6");
  await expect(b.getByRole("log")).not.toContainText('"msg_type"');
  await myts.getByRole("button", { name: "Požádat o odkaz" }).click();
  await a
    .locator(".private-tab")
    .getByRole("button", { name: /^Bára/ })
    .click();
  await expect(a.getByRole("log")).toContainText(
    "Můžeš mi teamspeak-spotify-bot-integration.zip poslat přes Mluvku nebo jako odkaz? Z TeamSpeaku 5/6 ho v prohlížeči nestáhnu.",
  );
  await a.getByRole("button", { name: "Server", exact: true }).click();
  ok(
    "TS5/6 zip: 108,7 kB, žádný surový JSON; žádost po kliknutí dorazila soukromě odesílateli",
  );
  // Všechny druhy karet v jednom výřezu, bez nevyžádaného načítání externí přílohy.
  let externalFetches = 0;
  await b.route("https://example.org/priloha.pdf", (route) => {
    externalFetches++;
    return route.abort();
  });
  await send("https://example.org/priloha.pdf");
  await expect(b.locator(".file-card").last()).toContainText(
    "Externí odkaz na soubor",
  );
  expect(externalFetches).toBe(0);
  for (const [width, height, name] of [
    [1440, 900, "desktop"],
    [390, 844, "mobil"],
  ]) {
    await b.setViewportSize({ width, height });
    if (width === 390)
      await b.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(b.locator('input[type="file"]')).not.toHaveAttribute("accept");
    const chooser = b.waitForEvent("filechooser");
    await b.getByRole("button", { name: "Přidat soubor" }).click();
    await (await chooser).setFiles([]);
    for (const [kind, card] of [
      ["mluvka", zip],
      [
        "ts3",
        b.locator(".file-card").filter({ hasText: "chraneny.zip" }).last(),
      ],
      ["ts56", myts],
    ]) {
      await card.scrollIntoViewIfNeeded();
      await expect(card).toBeVisible();
      expect(
        await b.evaluate(
          () =>
            document.documentElement.scrollWidth <= innerWidth &&
            document.querySelector(".messages").scrollWidth <=
              document.querySelector(".messages").clientWidth,
        ),
      ).toBe(true);
      await b.screenshot({
        path: resolve(root, `docs/screenshots/soubory-${kind}-${name}.png`),
      });
    }
  }
  await b.setViewportSize({ width: 1440, height: 900 });
  ok(
    "Karty Mluvka/TS3/TS5/6: desktop a mobil bez přesahu, picker bez accept, externí odkaz bez fetch; šest screenshotů",
  );
}
