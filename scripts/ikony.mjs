// Deterministické PNG ze stejného SVG jako favicon; vyžaduje Playwright Chromium/Chrome.
import { chromium } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
const root = new URL("../frontend/public/", import.meta.url);
const svg = await readFile(new URL("favicon.svg", root), "utf8");
await mkdir(new URL("icons/", root), { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined),
});
try {
  for (const [path, size, safe] of [
    ["icons/192.png", 192, false],
    ["icons/512.png", 512, false],
    ["icons/maskable-512.png", 512, true],
    ["apple-touch-icon.png", 180, false],
  ]) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    // Celé logo včetně zeleného podkladu se vejde do středových 68 % (kruh masky 80 %).
    await page.setContent(
      `<style>body{margin:0;background:#151816;display:grid;place-items:center;height:100vh}svg{width:${safe ? 68 : 100}%;height:${safe ? 68 : 100}%}</style>${svg}`,
    );
    await page.screenshot({
      path: new URL(path, root).pathname,
      omitBackground: false,
    });
    await page.close();
  }
} finally {
  await browser.close();
}
