// Virtuální čas ověřuje minimální prodlevu i po návratu skrytého tabu.
import { chromium, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";
const base = process.argv[2] || "http://localhost:3001";
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROME_PATH ||
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined),
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--disable-audio-output",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const results = [];
try {
  for (const [code, delay] of [
    ["flood", 120000],
    ["server_restart", 3000],
  ]) {
    const context = await browser.newContext({ permissions: ["microphone"] });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await context.addInitScript(() => {
      window.Worker = class {
        constructor() {
          throw Error("Test PCM");
        }
      };
    });
    await page.clock.install();
    let connections = 0;
    await page.routeWebSocket("**/ws", (route) => {
      route.onMessage(async (text) => {
        if (typeof text !== "string" || JSON.parse(text).type !== "connect")
          return;
        connections++;
        if (connections === 1) {
          await page.evaluate(() =>
            Object.defineProperty(document, "visibilityState", {
              configurable: true,
              value: "hidden",
            }),
          );
          route.send(
            JSON.stringify({
              type: code === "flood" ? "error" : "notice",
              code,
              fatal: true,
              message: "Test čekání",
            }),
          );
          await page.waitForTimeout(50);
          route.close();
        } else {
          route.send(
            JSON.stringify({
              type: "hello",
              audio: { codec: "pcm", version: 1 },
            }),
          );
          route.send(
            JSON.stringify({
              type: "state",
              self: 1,
              name: "Test",
              clients: [],
              channels: [],
            }),
          );
        }
      });
    });
    await page.goto(base);
    await page.getByLabel("Přezdívka", { exact: true }).fill("Čekání");
    await page
      .getByLabel("Adresa serveru", { exact: true })
      .fill("example.invalid");
    await page.getByRole("button", { name: /Připojit se/ }).click();
    await expect(page.locator(".reconnect-banner")).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.clock.fastForward(delay - 500);
    expect(connections).toBe(1);
    await page.clock.fastForward(1000);
    await expect.poll(() => connections).toBe(2);
    await expect(page.locator(".connection-status")).toHaveText("Připojeno");
    expect(errors).toEqual([]);
    results.push({
      code,
      minimumDelayMs: delay,
      before: 1,
      after: connections,
      result: "OK",
    });
    await context.close();
  }
  writeFileSync(
    new URL("../docs/flood-vysledky.json", import.meta.url),
    JSON.stringify({ results }, null, 2) + "\n",
  );
  console.log(
    "OK · skrytý tab: flood ≥120 s, restart ≥3 s, po návratu automaticky pokračuje",
  );
} finally {
  await browser.close();
}
