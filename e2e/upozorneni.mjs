import { expect } from "@playwright/test";
import { resolve } from "node:path";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sounds = (page) => page.evaluate(() => window.__mluvkaStats.notifySounds);
const tab = (page, name) =>
  page.locator(".chat-tabs").getByRole("button", { name, exact: true });
const badge = (page, name) =>
  page
    .locator(".chat-tabs")
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .locator(".unread-badge");
async function send(page, text) {
  await page.getByLabel("Zpráva", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Odeslat zprávu" }).click();
}
export async function notificationChecks({
  a,
  b,
  bContext,
  root,
  query,
  moveToProtected,
  ok,
}) {
  // Headless Chrome nemá spolehlivou správu OS oken; fokus a skrytí řídíme odděleně.
  await b.evaluate(() => {
    window.testHidden = false;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (window.testHidden ? "hidden" : "visible"),
    });
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => !window.testBlurred,
    });
    window.testVibrations = [];
    navigator.vibrate = (duration) => {
      window.testVibrations.push(duration);
      return true;
    };
    window.testBadges = [];
    navigator.setAppBadge = async (count) => {
      window.testBadges.push(count);
    };
    navigator.clearAppBadge = async () => {
      window.testBadges.push(0);
    };
  });
  await tab(b, "Server").click();
  const before = await sounds(b);
  for (let i = 1; i <= 3; i++) await send(a, `Dávka upozornění ${i}`);
  await expect(badge(b, "Kanál")).toHaveText("3");
  await expect(b).toHaveTitle(/^\(3\) Mluvka/);
  await expect.poll(() => sounds(b)).toBe(before + 1);
  expect(await b.evaluate(() => window.testBadges.at(-1))).toBe(3);
  await b.setViewportSize({ width: 390, height: 844 });
  await b.screenshot({
    path: resolve(root, "docs/screenshots/mobil-odznaky.png"),
  });
  await expect(b.locator(".mobile-tabs .unread-badge")).toHaveText("3");
  await b.getByRole("button", { name: /^Chat/ }).click();
  await b.screenshot({
    path: resolve(root, "docs/screenshots/mobil-chat-odznaky.png"),
  });
  await b
    .locator(".chat-tabs")
    .getByRole("button", { name: /^Kanál/ })
    .click();
  await expect(badge(b, "Kanál")).toHaveCount(0);
  await expect(b).toHaveTitle(/^Mluvka/);
  expect(await b.evaluate(() => window.testBadges.at(-1))).toBe(0);
  await b.setViewportSize({ width: 1440, height: 900 });
  ok(
    "3 zprávy → odznak Kanál, mobilní Chat, titulek a app badge = 3; jediný zvuk; přečtení vynuluje",
  );
  await pause(1550);
  const visibleBefore = await sounds(b);
  await send(a, "Otevřený viditelný kanál");
  await expect(b.getByRole("log")).toContainText("Otevřený viditelný kanál");
  expect(await sounds(b)).toBe(visibleBefore);
  await expect(badge(b, "Kanál")).toHaveCount(0);
  ok("Otevřená viditelná konverzace → žádný zvuk ani odznak");
  // Samotná ztráta fokusu stačí i při visibilityState=visible.
  await b.evaluate(() => {
    window.testBlurred = true;
    window.dispatchEvent(new Event("blur"));
  });
  await send(a, "Kanál bez fokusu");
  await expect(badge(b, "Kanál")).toHaveText("1");
  await expect.poll(() => sounds(b)).toBe(visibleBefore + 1);
  await b.evaluate(() => {
    window.testBlurred = false;
    window.dispatchEvent(new Event("focus"));
  });
  await expect(badge(b, "Kanál")).toHaveCount(0);
  ok("Viditelné okno bez fokusu upozorní; návrat fokusu přečte konverzaci");
  await pause(1550);
  await a.locator(".client-row").filter({ hasText: "Bára" }).click();
  await a.getByRole("button", { name: "Napsat zprávu" }).click();
  const privateBefore = await sounds(b);
  await send(a, "Soukromé upozornění");
  await expect(badge(b, "Adam")).toHaveText("1");
  await expect.poll(() => sounds(b)).toBe(privateBefore + 1);
  await b.locator(".chat-tabs").getByRole("button", { name: /^Adam/ }).click();
  await expect(badge(b, "Adam")).toHaveCount(0);
  await tab(b, "Kanál").click();
  ok("Soukromá zpráva vytvoří odznak a zvuk; otevření ji přečte");
  await pause(1550);
  const serverBefore = await sounds(b);
  await tab(a, "Server").click();
  await send(a, "Serverové upozornění");
  await expect(badge(b, "Server")).toHaveText("1");
  await expect.poll(() => sounds(b)).toBe(serverBefore + 1);
  await b
    .locator(".chat-tabs")
    .getByRole("button", { name: /^Server/ })
    .click();
  await expect(badge(b, "Server")).toHaveCount(0);
  await tab(b, "Kanál").click();
  await b.getByRole("button", { name: "Nastavení", exact: true }).click();
  await b.getByLabel("Zvuk u zpráv na serveru", { exact: true }).uncheck();
  await b.getByRole("button", { name: "Hotovo", exact: true }).click();
  await pause(1550);
  const disabledBefore = await sounds(b);
  await send(a, "Server bez zvuku");
  await expect(badge(b, "Server")).toHaveText("1");
  expect(await sounds(b)).toBe(disabledBefore);
  expect(
    await b.evaluate(
      () => JSON.parse(localStorage.getItem("mluvka.settings")).notifyServer,
    ),
  ).toBe(false);
  await b
    .locator(".chat-tabs")
    .getByRole("button", { name: /^Server/ })
    .click();
  await tab(a, "Kanál").click();
  await send(a, "Nepřečtený kanál před přesunem");
  await expect(badge(b, "Kanál")).toHaveText("1");
  await b
    .getByRole("button", { name: "Vstoupit do Lobby", exact: true })
    .click();
  await expect(b.locator(".room-title h1")).toHaveText("Lobby");
  await expect(badge(b, "Kanál")).toHaveCount(0);
  await moveToProtected(b);
  await tab(b, "Kanál").click();
  await a.locator(".chat-tabs .private-tab > button:first-child").click();
  await b.getByRole("button", { name: "Nastavení", exact: true }).click();
  await b.getByLabel("Zvuk u zpráv na serveru", { exact: true }).check();
  await b.getByRole("button", { name: "Hotovo", exact: true }).click();
  ok(
    "Serverový odznak a zvuk; vypnutý zvuk se uloží a ponechá počty; změna kanálu vynuluje Kanál",
  );
  const vibrationsBefore = await b.evaluate(() => window.testVibrations.length);
  expect(vibrationsBefore).toBeGreaterThan(0);
  await bContext.grantPermissions(["notifications"]);
  await b.getByRole("button", { name: "Nastavení", exact: true }).click();
  await b.getByLabel("Upozornění systému", { exact: true }).click();
  await expect(
    b.getByLabel("Upozornění systému", { exact: true }),
  ).toBeChecked();
  for (const label of [
    "Zvuk u zpráv v kanálu",
    "Zvuk u zpráv na serveru",
    "Zvuk u soukromých zpráv",
    "Zvuk u šťouchnutí",
  ])
    await expect(b.getByLabel(label, { exact: true })).toBeChecked();
  await expect(
    b.getByLabel("Hlasitost upozornění", { exact: true }),
  ).toHaveValue("0.7");
  await b.getByRole("button", { name: "Hotovo", exact: true }).click();
  await b.evaluate(async () => {
    await navigator.serviceWorker.ready;
    const show = ServiceWorkerRegistration.prototype.showNotification;
    window.testNotifications = [];
    ServiceWorkerRegistration.prototype.showNotification = function (
      title,
      options,
    ) {
      window.testNotifications.push({ title, ...options });
      return show.call(this, title, options);
    };
    window.testHidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await send(a, "Zpráva na pozadí");
  await expect
    .poll(() => b.evaluate(() => window.testNotifications.length))
    .toBe(1);
  const notification = await b.evaluate(() => window.testNotifications[0]);
  expect(notification).toMatchObject({
    title: "Adam",
    body: "Zpráva na pozadí",
    renotify: true,
  });
  expect(notification.tag).toContain("private:");
  // Otestovat skutečný handler v instalovaném SW i přepnutí do soukromé konverzace.
  const worker = bContext.serviceWorkers()[0];
  expect(worker).toBeTruthy();
  await b.evaluate(() => {
    window.testHidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await worker.evaluate(async (target) => {
    const event = new Event("notificationclick");
    let completed;
    event.notification = { data: target, close() {} };
    event.waitUntil = (promise) => {
      completed = promise;
    };
    self.dispatchEvent(event);
    await completed.catch(() => {}); // Syntetický event nemá OS oprávnění fokusovat okno.
  }, notification.data);
  await expect(b.locator(".private-tab[data-active=true]")).toContainText(
    "Adam",
  );
  await expect(b.getByRole("log")).toContainText("Zpráva na pozadí");
  ok(
    "Skrytá aplikace → SW showNotification (titulek, text, tag, renotify); notificationclick otevře konverzaci",
  );
  // Bez pauzy: poke hned po zprávě musí zaznít i přes omezení 1,5 s.
  const pokeBefore = await b.evaluate(() => window.__mluvkaStats.notifyPokes);
  const bId = await b
    .locator(".client-row")
    .filter({ hasText: "Bára" })
    .getAttribute("data-client");
  await query.cmd(`clientpoke clid=${bId} msg=Upozorneni`);
  await expect(
    b.getByRole("status").filter({ hasText: "Šťouchnutí od" }),
  ).toBeVisible();
  await expect
    .poll(() => b.evaluate(() => window.__mluvkaStats.notifyPokes))
    .toBe(pokeBefore + 1);
  await b.getByRole("button", { name: "Ztlumit zvuk", exact: true }).click();
  await pause(1550);
  const deafBefore = await sounds(b);
  await b.evaluate(() => {
    window.testHidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await send(a, "Soukromá při deafen");
  await query.cmd(`clientpoke clid=${bId} msg=Deafen`);
  await expect
    .poll(() => b.evaluate(() => window.testNotifications.length))
    .toBe(3);
  expect(await sounds(b)).toBe(deafBefore);
  expect(await b.evaluate(() => window.__mluvkaStats.notifyPokes)).toBe(
    pokeBefore + 1,
  );
  await b.evaluate(() => {
    window.testHidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await b.getByRole("button", { name: "Ztlumit zvuk", exact: true }).click();
  expect(await b.evaluate(() => window.testVibrations.length)).toBeGreaterThan(
    vibrationsBefore,
  );
  await tab(a, "Kanál").click();
  await tab(b, "Kanál").click();
  ok(
    "Poke používá vlastní dekódovaný zvuk; deafen umlčí zprávy i poke, systémová upozornění běží dál",
  );
}
