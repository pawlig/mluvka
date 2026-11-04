// Static login acceptance. Uses the clean Chrome started by the prohlizec wrapper.
// Run after npm run build, with vite preview on port 4180.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const url = process.env.HP_URL || "http://localhost:4180";
const output = "docs/screenshots";
mkdirSync(output, { recursive: true });
execFileSync("prohlizec", ["open", url], { stdio: "pipe" });
const endpoint = execFileSync("prohlizec", ["get", "cdp-url"], {
  encoding: "utf8",
}).trim();
const browser = await chromium.connectOverCDP(endpoint);
const report = { url, checks: [], errors: [] };
const contexts = [];
const check = (name, detail) => {
  report.checks.push({ name, ...detail });
  console.log(name, JSON.stringify(detail));
};
const stats = (page) => page.evaluate(() => ({ ...window.__vlnaStats }));
async function ready(page) {
  page.on("pageerror", (e) => report.errors.push(e.message));
  page.on("console", (e) => {
    if (e.type() === "error") report.errors.push(e.text());
  });
  await page.goto(url);
  await page.waitForFunction(() => window.__vlnaStats?.fps > 0);
  await page.waitForTimeout(1200);
}
async function context(options = {}) {
  const ctx = await browser.newContext(options);
  contexts.push(ctx);
  return ctx;
}
async function pixels(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => {
          const copy = document.createElement("canvas");
          copy.width = 160;
          copy.height = 100;
          const ctx = copy.getContext("2d");
          ctx.drawImage(document.querySelector(".vlna canvas"), 0, 0, 160, 100);
          resolve(Array.from(ctx.getImageData(0, 0, 160, 100).data));
        }),
      ),
  );
}
function difference(a, b) {
  let changed = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (
      Math.abs(a[i] - b[i]) +
        Math.abs(a[i + 1] - b[i + 1]) +
        Math.abs(a[i + 2] - b[i + 2]) +
        Math.abs(a[i + 3] - b[i + 3]) >
      40
    )
      changed++;
  }
  assert(changed > 180, `Only ${changed} pixels changed`);
  return changed;
}
// Compare rendered pixels with an independently drawn application-font word mask.
// A wrong-word control rejects a uniform bright rectangle or the underlying strings.
async function nameMatch(page, screenshot) {
  await page.waitForFunction(
    () => window.__vlnaStats.name > 0.98 && window.__vlnaStats.glitch === 0,
  );
  await page.waitForTimeout(650);
  const result = await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => {
          const source = document.querySelector(".vlna canvas"),
            box = window.__vlnaStats.nameBounds;
          const sample = document.createElement("canvas");
          sample.width = 360;
          sample.height = 100;
          const ctx = sample.getContext("2d");
          ctx.drawImage(
            source,
            box.x * source.width,
            box.y * source.height,
            box.width * source.width,
            box.height * source.height,
            0,
            0,
            360,
            100,
          );
          const ink = ctx.getImageData(0, 0, 360, 100).data,
            actual = new Uint8Array(36000);
          for (let y = 1; y < 99; y++)
            for (let x = 1; x < 359; x++) {
              const i = (y * 360 + x) * 4;
              if (ink[i + 3] > 60 && ink[i + 1] > 100)
                for (let dy = -1; dy <= 1; dy++)
                  for (let dx = -1; dx <= 1; dx++)
                    actual[(y + dy) * 360 + x + dx] = 1;
            }
          function score(word) {
            const expected = document.createElement("canvas");
            expected.width = 720;
            expected.height = 200;
            const ref = expected.getContext("2d");
            ref.font = '800 160px "Manrope", sans-serif';
            ref.textAlign = "center";
            ref.textBaseline = "middle";
            ref.fillStyle = "white";
            ref.fillText(word, 360, 100);
            ctx.clearRect(0, 0, 360, 100);
            ctx.drawImage(expected, 0, 0, 360, 100);
            const mask = ctx.getImageData(0, 0, 360, 100).data;
            let hit = 0,
              predicted = 0,
              target = 0;
            for (let i = 0; i < actual.length; i++) {
              const wanted = mask[i * 4 + 3] > 100;
              predicted += actual[i];
              target += wanted ? 1 : 0;
              if (wanted && actual[i]) hit++;
            }
            const precision = hit / Math.max(1, predicted),
              recall = hit / Math.max(1, target);
            return {
              precision,
              recall,
              f1:
                (2 * precision * recall) / Math.max(0.001, precision + recall),
            };
          }
          resolve({
            word: score("mluvka"),
            control: score("banana"),
            formation: window.__vlnaStats.name,
          });
        }),
      ),
  );
  assert(
    result.word.f1 > 0.5 &&
      result.word.precision > 0.62 &&
      result.word.recall > 0.5,
    JSON.stringify(result),
  );
  assert(result.word.f1 > result.control.f1 + 0.12, JSON.stringify(result));
  await page.screenshot({ scale: "css", path: `${output}/${screenshot}` });
  return result;
}
async function swipeGlitch(page) {
  await page.mouse.move(100, 350);
  await page.waitForTimeout(500);
  await page.mouse.move(105, 350);
  await page.waitForTimeout(20);
  await page.mouse.move(780, 310);
  await page.waitForFunction(() => window.__vlnaStats.glitch > 0.15);
  const active = await stats(page);
  const cdp = await page.context().newCDPSession(page);
  const capture = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${output}/hp-glitch.png`, Buffer.from(capture.data, "base64"));
  await page.waitForTimeout(300);
  assert.equal((await stats(page)).glitch, 0);
  assert((await stats(page)).name < 0.1);
  await page.mouse.dblclick(350, 430);
  await page.waitForFunction(() => window.__vlnaStats.detune > 0.5);
  const detuned = await stats(page);
  await page.screenshot({ path: `${output}/hp-rozladeni.png` });
  check("reactive-glitch-name-break-doubleclick", {
    active,
    glitchAfter300ms: 0,
    detune: detuned.detune,
  });
}
async function layout(page, portrait = false) {
  const result = await page.evaluate(() => {
    const main = document.querySelector(".login-layout"),
      card = document.querySelector(".login-card");
    const canvas = document.querySelector(".vlna").getBoundingClientRect(),
      form = card.getBoundingClientRect();
    return {
      horizontalOverflow:
        Math.max(document.documentElement.scrollWidth, main.scrollWidth) >
        innerWidth,
      cardRight: form.right,
      viewportWidth: innerWidth,
      canvasBottom: canvas.bottom,
      cardTop: form.top,
      cardLeft: form.left,
      nameRight:
        canvas.left +
        (window.__vlnaStats.nameBounds.x +
          window.__vlnaStats.nameBounds.width) *
          canvas.width,
      touchAction: getComputedStyle(document.querySelector("canvas"))
        .touchAction,
      formTouchAction: getComputedStyle(card).touchAction,
      backdropFilter: getComputedStyle(card).backdropFilter,
    };
  });
  assert.equal(result.horizontalOverflow, false);
  assert(result.cardRight <= result.viewportWidth);
  assert.equal(result.touchAction, "none");
  assert.equal(result.formTouchAction, "auto");
  assert.equal(result.backdropFilter, "blur(22px)");
  if (portrait) assert(result.canvasBottom <= result.cardTop + 1);
  else assert(result.nameRight <= result.cardLeft);
  return result;
}
try {
  const desktop = await (
    await context({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  await ready(desktop);
  check("desktop", {
    stats: await stats(desktop),
    layout: await layout(desktop),
  });
  await desktop.screenshot({ path: `${output}/hp-desktop.png` });
  await desktop.waitForFunction(() => window.__vlnaStats.name > 0.12);
  const nameStartedMs = await desktop.evaluate(() => performance.now());
  assert(nameStartedMs < 4200);
  check("name-formation-timing", { nameStartedMs });
  const before = await pixels(desktop);
  const particleBaseline = (await stats(desktop)).particles;
  assert((await stats(desktop)).fps >= 55);
  await desktop.mouse.move(130, 380);
  await desktop.mouse.move(520, 580, { steps: 12 });
  await desktop.mouse.down();
  await desktop.mouse.move(410, 310, { steps: 8 });
  await desktop.waitForTimeout(250);
  const held = await stats(desktop);
  assert(held.energy > 0.4 && held.pointers === 1);
  assert(held.particles > particleBaseline + 300);
  const changedPixels = difference(before, await pixels(desktop));
  await desktop.screenshot({ path: `${output}/hp-impuls.png` });
  await desktop.mouse.up();
  await desktop.mouse.move(20, 20);
  await desktop.waitForTimeout(5100);
  const settled = await stats(desktop);
  assert(settled.energy < 0.03 && settled.energy < held.energy / 10);
  check("mouse-click-hold-decay", {
    changedPixels,
    particleBaseline,
    held,
    settled,
  });
  check("desktop-word-mask", await nameMatch(desktop, "hp-napis.png"));
  await swipeGlitch(desktop);
  await desktop.setViewportSize({ width: 900, height: 700 });
  await desktop.waitForTimeout(500);
  check("narrow-desktop", {
    layout: await layout(desktop),
    mask: await nameMatch(desktop, "hp-desktop-900.png"),
  });

  const mobile = await (
    await context({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    })
  ).newPage();
  await ready(mobile);
  const mobileCDP = await mobile.context().newCDPSession(mobile);
  check("mobile", {
    stats: await stats(mobile),
    layout: await layout(mobile, true),
    hasTouch: await mobile.evaluate(() => navigator.maxTouchPoints > 0),
  });
  await mobile.screenshot({
    scale: "css",
    path: `${output}/hp-mobil.png`,
  });
  const mobileBefore = await pixels(mobile);
  const mobileBaseline = (await stats(mobile)).particles;
  assert((await stats(mobile)).fps >= 30);
  const touch = (type, points) =>
    mobileCDP.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map(([id, x, y]) => ({
        id,
        x,
        y,
        radiusX: 4,
        radiusY: 4,
        force: 0.7,
      })),
    });
  await touch("touchStart", [
    [1, 80, 190],
    [2, 280, 230],
  ]);
  await mobile.waitForTimeout(150);
  const multi = await stats(mobile);
  assert.equal(multi.pointers, 2);
  assert(multi.glitch > 0);
  for (let i = 0; i < 10; i++) {
    await touch("touchMove", [
      [1, 80 + i * 23, 190 + i * 6],
      [2, 280 - i * 14, 230 - i * 7],
    ]);
    await mobile.waitForTimeout(18);
  }
  const swipe = await stats(mobile);
  assert(swipe.energy > 0.5);
  assert(swipe.particles > mobileBaseline + 300);
  const touchPixels = difference(mobileBefore, await pixels(mobile));
  await touch("touchEnd", []);
  await mobile.waitForTimeout(300);
  assert.equal((await stats(mobile)).glitch, 0);
  await mobile.waitForTimeout(4800);
  assert((await stats(mobile)).energy < 0.03);
  check("touch-multitouch-swipe-decay", {
    pointers: multi.pointers,
    changedPixels: touchPixels,
    swipe,
    settled: await stats(mobile),
  });
  check("mobile-word-mask", await nameMatch(mobile, "hp-mobil-napis.png"));
  await mobile.locator('[name="nickname"]').tap();
  await mobile.keyboard.type("Pavel");
  assert.equal(await mobile.locator('[name="nickname"]').inputValue(), "Pavel");
  assert.equal(
    await mobile.evaluate(() => document.activeElement.name),
    "nickname",
  );
  await mobile.locator('[name="nickname"]').evaluate((e) => e.blur());
  const scrollBefore = await mobile
    .locator("main")
    .evaluate((e) => e.scrollTop);
  await touch("touchStart", [[1, 355, 700]]);
  for (let i = 0; i < 10; i++) {
    await touch("touchMove", [[1, 355, 700 - i * 38]]);
    await mobile.waitForTimeout(18);
  }
  await touch("touchEnd", []);
  await mobile.waitForTimeout(300);
  const scrollAfter = await mobile.locator("main").evaluate((e) => e.scrollTop);
  assert(scrollAfter > scrollBefore + 40);
  assert.equal((await stats(mobile)).pointers, 0);
  await mobile
    .getByRole("button", { name: "Identita", exact: true })
    .scrollIntoViewIfNeeded();
  await mobile.screenshot({
    scale: "css",
    path: `${output}/hp-mobil-formular.png`,
  });
  check("mobile-input-and-native-scroll", {
    nickname: "Pavel",
    scrollBefore,
    scrollAfter,
  });
  await mobile.setViewportSize({ width: 844, height: 390 });
  await mobile.locator("main").evaluate((e) => {
    e.scrollTop = 0;
  });
  await mobile.waitForTimeout(500);
  check("landscape", { layout: await layout(mobile) });
  await mobile.screenshot({
    scale: "css",
    path: `${output}/hp-na-sirku.png`,
  });
  check(
    "landscape-word-mask",
    await nameMatch(mobile, "hp-na-sirku-napis.png"),
  );
  await mobile
    .getByRole("button", { name: "Identita", exact: true })
    .scrollIntoViewIfNeeded();
  assert(
    await mobile
      .getByRole("button", { name: "Identita", exact: true })
      .isVisible(),
  );

  const reduced = await (
    await context({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    })
  ).newPage();
  await ready(reduced);
  await reduced.mouse.click(360, 430);
  await reduced.waitForTimeout(300);
  const calm = await stats(reduced);
  assert(calm.reducedMotion && calm.energy === 0 && calm.glitch === 0);
  await reduced.mouse.move(100, 350);
  await reduced.mouse.move(800, 300);
  await reduced.waitForTimeout(50);
  assert.equal((await stats(reduced)).glitch, 0);
  await reduced.screenshot({ path: `${output}/hp-reduced-motion.png` });
  check("reduced-motion", { stats: calm });

  const fallbackCtx = await context({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  await fallbackCtx.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
      return kind === "webgl2" ? null : get.call(this, kind, ...args);
    };
  });
  const fallback = await fallbackCtx.newPage();
  await ready(fallback);
  assert.equal((await stats(fallback)).mode, "canvas");
  const fallbackBefore = await pixels(fallback);
  await fallback.mouse.click(180, 200);
  await fallback.waitForTimeout(150);
  const fallbackPixels = difference(fallbackBefore, await pixels(fallback));
  await fallback.screenshot({ path: `${output}/hp-canvas-fallback.png` });
  check("canvas-fallback", {
    stats: await stats(fallback),
    changedPixels: fallbackPixels,
  });

  // Isolated mount of the same component: no app hooks or WebSocket/server dependencies.
  execFileSync(
    "npx",
    [
      "esbuild",
      "--bundle",
      "--minify",
      "--format=esm",
      "--jsx=automatic",
      "--outfile=dist/hp-lifecycle.js",
    ],
    {
      input: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {Vlna} from './frontend/src/Vlna';
      const root=createRoot(document.getElementById('test')); root.render(React.createElement(Vlna)); window.unmountVlna=()=>root.unmount();`,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  writeFileSync(
    "dist/hp-lifecycle.html",
    '<!doctype html><html><head><link rel="icon" href="/favicon.svg"><style>body{margin:0}.vlna{width:800px;height:500px}canvas{width:100%;height:100%;touch-action:none}</style></head><body><div id="test"></div><script type="module" src="/hp-lifecycle.js"></script></body></html>',
  );
  const lifecycleCtx = await context({ deviceScaleFactor: 3 });
  await lifecycleCtx.addInitScript(() => {
    const request = window.requestAnimationFrame.bind(window),
      cancel = window.cancelAnimationFrame.bind(window);
    window.pendingRaf = new Set();
    window.gpuResources = new Set();
    for (const kind of [
      "Buffer",
      "Shader",
      "Program",
      "VertexArray",
      "TransformFeedback",
      "Texture",
      "Framebuffer",
    ]) {
      const proto = WebGL2RenderingContext.prototype;
      const create = proto[`create${kind}`],
        destroy = proto[`delete${kind}`];
      proto[`create${kind}`] = function (...args) {
        const object = create.apply(this, args);
        if (object) window.gpuResources.add(object);
        return object;
      };
      proto[`delete${kind}`] = function (object) {
        window.gpuResources.delete(object);
        return destroy.call(this, object);
      };
    }
    window.requestAnimationFrame = (fn) => {
      const id = request((t) => {
        window.pendingRaf.delete(id);
        const start = performance.now();
        while (performance.now() - start < (window.rafDelay || 0)) {}
        fn(t);
      });
      window.pendingRaf.add(id);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      window.pendingRaf.delete(id);
      cancel(id);
    };
  });
  const lifecycle = await lifecycleCtx.newPage();
  await lifecycle.goto(`${url}/hp-lifecycle.html`);
  await lifecycle.waitForFunction(() => window.__vlnaStats?.fps > 0);
  assert(
    await lifecycle.evaluate(
      () => document.querySelector("canvas").width <= 1600,
    ),
  );
  const initialLimit = (await stats(lifecycle)).particleLimit;
  await lifecycle.evaluate(() => {
    window.rafDelay = 25;
  });
  await lifecycle.waitForFunction(() => window.__vlnaStats.renderScale < 1);
  await lifecycle.waitForFunction(
    (limit) => window.__vlnaStats.particleLimit < limit,
    initialLimit,
  );
  const adapted = await stats(lifecycle);
  assert(adapted.frameMs > 20);
  assert(adapted.particleLimit < initialLimit);
  await lifecycle.evaluate(() => {
    window.rafDelay = 0;
  });
  check("adaptive-resolution-and-dpr-cap", {
    initialLimit,
    stats: adapted,
    maxDpr: 2,
  });
  await lifecycle.locator(".vlna").evaluate((e) => {
    e.style.display = "none";
  });
  await lifecycle.waitForFunction(() => !window.__vlnaStats.running);
  const offscreen = await stats(lifecycle);
  await lifecycle.waitForTimeout(250);
  assert.equal((await stats(lifecycle)).frames, offscreen.frames);
  await lifecycle.locator(".vlna").evaluate((e) => {
    e.style.display = "";
  });
  await lifecycle.waitForFunction(() => window.__vlnaStats.fps > 0);
  await lifecycle.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hidden = await stats(lifecycle);
  await lifecycle.waitForTimeout(250);
  assert.equal((await stats(lifecycle)).frames, hidden.frames);
  await lifecycle.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await lifecycle.waitForFunction(() => window.__vlnaStats.fps > 0);
  // Also exercise context loss, where a new 2D canvas must replace WebGL.
  await lifecycle.evaluate(() =>
    document
      .querySelector("canvas")
      .getContext("webgl2")
      .getExtension("WEBGL_lose_context")
      .loseContext(),
  );
  await lifecycle.waitForFunction(() => window.__vlnaStats.mode === "canvas");
  await lifecycle.mouse.move(200, 200);
  await lifecycle.mouse.down();
  await lifecycle.evaluate(() => window.unmountVlna());
  const unmounted = await stats(lifecycle);
  await lifecycle.waitForTimeout(300);
  assert.equal((await stats(lifecycle)).frames, unmounted.frames);
  assert.equal(await lifecycle.evaluate(() => window.pendingRaf.size), 0);
  assert.equal(await lifecycle.locator("canvas").count(), 0);
  assert.equal(unmounted.running, false);
  assert.equal(unmounted.particles, 0);
  assert.equal(unmounted.glitch, 0);
  check("intersection-visibility-context-loss-unmount", {
    offscreenFrames: offscreen.frames,
    hiddenFrames: hidden.frames,
    unmounted,
    pendingRaf: 0,
  });
  await lifecycle.reload();
  await lifecycle.waitForFunction(
    () => window.__vlnaStats?.mode === "webgl2" && window.__vlnaStats.fps > 0,
  );
  await lifecycle.evaluate(() => window.unmountVlna());
  const webglUnmount = await stats(lifecycle);
  assert.equal(await lifecycle.evaluate(() => window.gpuResources.size), 0);
  await lifecycle.waitForTimeout(250);
  assert.equal((await stats(lifecycle)).frames, webglUnmount.frames);
  assert.equal(await lifecycle.evaluate(() => window.pendingRaf.size), 0);
  check("webgl-unmount", {
    pendingRaf: 0,
    gpuObjects: 0,
    frames: webglUnmount.frames,
  });
  assert.deepEqual(report.errors, []);
  report.result = "PASS";
} finally {
  writeFileSync(
    `${output}/hp-overeni.json`,
    JSON.stringify(report, null, 2) + "\n",
  );
  for (const ctx of contexts) await ctx.close();
  await browser.close();
}
