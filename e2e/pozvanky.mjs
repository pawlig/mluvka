import { expect } from "@playwright/test";
import { resolve } from "node:path";

export async function invitationChecks({
  a,
  browser,
  base,
  root,
  password,
  channelPassword,
  backendLogs,
  ok,
}) {
  await a.getByRole("button", { name: "Pozvat", exact: true }).click();
  const dialog = a.getByRole("dialog", {
    name: "Pozvat na server",
    exact: true,
  });
  await dialog.getByLabel("I heslo kanálu", { exact: true }).check();
  await expect(
    dialog.getByRole("img", { name: "QR kód pozvánky" }),
  ).toBeVisible();
  const url = await dialog
    .getByLabel("Odkaz pozvánky", { exact: true })
    .inputValue();
  const payload = JSON.parse(
    Buffer.from(new URL(url).hash.slice(10), "base64url").toString(),
  );
  expect(payload).toMatchObject({
    v: 1,
    password,
    channelPassword,
    channel: "Večerní parta",
    name: "Mluvka · zkušebna",
  });
  // Snímky s hesly jsou jen z dočasného testovacího TS serveru.
  await a.setViewportSize({ width: 390, height: 844 });
  for (const action of await dialog.locator("footer button").all()) {
    const box = await action.boundingBox();
    expect(box.y + box.height).toBeLessThanOrEqual(844);
  }
  await a.screenshot({ path: resolve(root, "docs/screenshots/pozvat-qr.png") });
  await a.setViewportSize({ width: 1440, height: 900 });
  await dialog.getByLabel("Včetně hesla serveru", { exact: true }).uncheck();
  await dialog.getByLabel("Rovnou do mého kanálu", { exact: true }).uncheck();
  const minimal = JSON.parse(
    Buffer.from(
      new URL(
        await dialog.getByLabel("Odkaz pozvánky").inputValue(),
      ).hash.slice(10),
      "base64url",
    ).toString(),
  );
  expect(minimal.password).toBeUndefined();
  expect(minimal.channel).toBeUndefined();
  expect(minimal.channelPassword).toBeUndefined();
  await a.getByRole("button", { name: "Zavřít pozvánku" }).click();
  const context = await browser.newContext({
    permissions: ["microphone"],
    viewport: { width: 390, height: 844 },
  });
  const c = await context.newPage();
  let leaked = false;
  const check = (request) => {
    const data =
      request.url() +
      (request.postData() || "") +
      JSON.stringify(request.headers());
    if (
      data.includes(password) ||
      data.includes(channelPassword) ||
      data.includes("#pozvanka=")
    )
      leaked = true;
  };
  c.on("request", check);
  try {
    await c.goto(url);
    await expect(
      c.getByRole("heading", {
        name: "Pozvánka na Mluvka · zkušebna",
        exact: true,
      }),
    ).toBeVisible();
    await expect(c.getByLabel("Přezdívka", { exact: true })).toBeVisible();
    await expect(c.getByLabel("Adresa serveru", { exact: true })).toBeHidden();
    await expect(c.getByLabel("Heslo serveru", { exact: false })).toBeHidden();
    await expect(
      c.getByRole("button", { name: "Připojit", exact: true }),
    ).toBeVisible();
    expect(await c.evaluate(() => location.hash)).toBe("");
    expect(await c.locator("form input:visible").count()).toBe(1);
    await c.screenshot({
      path: resolve(root, "docs/screenshots/pozvanka-mobil.png"),
    });
    await c.getByLabel("Přezdívka", { exact: true }).fill("Cyril");
    await c.getByRole("button", { name: "Připojit", exact: true }).click();
    await expect(c.locator(".connection-status")).toHaveText("Připojeno", {
      timeout: 30000,
    });
    await expect(c.locator(".room-title h1")).toHaveText("Večerní parta");
    const saved = await c.evaluate(() =>
      JSON.parse(localStorage.getItem("mluvka.login")),
    );
    expect(saved).toMatchObject({
      password,
      channel_password: channelPassword,
      auto: true,
      remember: true,
      passwords: true,
    });
    expect(leaked).toBe(false);
    expect(
      backendLogs().includes(password) ||
        backendLogs().includes(channelPassword),
    ).toBe(false);
    ok(
      "Pozvánka A → C: jediná přezdívka, připojení do kanálu s heslem, údaje uložené; fragment prázdný, HTTP i backend log bez hesel",
    );
    // Odkaz dorazí i do právě připojené aplikace: zrušení ponechá spojení.
    let asked = false;
    c.once("dialog", async (dialog) => {
      asked = true;
      expect(dialog.message()).toContain("Odpojit se a připojit na");
      await dialog.dismiss();
    });
    await c.evaluate((url) => {
      location.hash = new URL(url).hash;
    }, url);
    await expect.poll(() => asked).toBe(true);
    await expect(c.locator(".connection-status")).toHaveText("Připojeno");
    expect(await c.evaluate(() => location.hash)).toBe("");
    await c.locator(".disconnect").click();
    await c.goto(`${base}/#pozvanka=vadny-odkaz`);
    await expect(c.getByRole("alert")).toContainText("Pozvánka je neplatná");
    await expect(c.getByLabel("Adresa serveru", { exact: true })).toBeVisible();
    expect(await c.evaluate(() => location.hash)).toBe("");
    await c
      .getByRole("button", { name: "Vložit pozvánku", exact: true })
      .click();
    await c
      .getByRole("dialog", { name: "Vložit pozvánku", exact: true })
      .getByLabel("Odkaz pozvánky", { exact: true })
      .fill(url);
    await c
      .getByRole("button", { name: "Otevřít pozvánku", exact: true })
      .click();
    await expect(
      c.getByRole("heading", {
        name: "Pozvánka na Mluvka · zkušebna",
        exact: true,
      }),
    ).toBeVisible();
    await expect(c.getByLabel("Přezdívka", { exact: true })).toHaveValue(
      "Cyril",
    );
    await c.getByRole("button", { name: "Připojit", exact: true }).click();
    await expect(c.locator(".connection-status")).toHaveText("Připojeno", {
      timeout: 30000,
    });
    await expect(c.locator(".room-title h1")).toHaveText("Večerní parta");
    expect(leaked).toBe(false);
    ok(
      "Pozvánka za připojení vyžádá odpojení; neplatná → česká chyba a formulář; Vložit pozvánku opět připojí",
    );
  } finally {
    await context.close();
  }
}
