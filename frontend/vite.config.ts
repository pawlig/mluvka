import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  plugins: [
    {
      name: "mluvka-sw-version",
      closeBundle() {
        const dist = fileURLToPath(new URL("../dist/", import.meta.url));
        const assets = readdirSync(`${dist}/assets`).map(
          (name) => `/assets/${name}`,
        );
        const version = createHash("sha256");
        for (const file of [
          "/index.html",
          "/audio-worklet.js",
          "/sounds/zprava.mp3",
          "/sounds/poke.mp3",
          "/sw.js",
          "/manifest.webmanifest",
          "/favicon.svg",
          "/apple-touch-icon.png",
          "/icons/192.png",
          "/icons/512.png",
          "/icons/maskable-512.png",
          ...assets,
        ])
          version.update(readFileSync(dist + file));
        const sw = readFileSync(`${dist}/sw.js`, "utf8")
          .replace("__CACHE_VERSION__", version.digest("hex").slice(0, 16))
          .replace(/\/\*__ASSETS__\*\/\s*\[\]/, JSON.stringify(assets));
        writeFileSync(`${dist}/sw.js`, sw);
      },
    },
  ],
  root: fileURLToPath(new URL(".", import.meta.url)),
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    proxy: {
      "/ws": { target: "ws://localhost:3000", ws: true, rewriteWsOrigin: true },
      "/healthz": "http://localhost:3000",
    },
  },
});
