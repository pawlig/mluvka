import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
function buildCommit() {
  const supplied = process.env.VITE_BUILD_COMMIT;
  if (supplied && /^[a-f0-9]{7,40}$/i.test(supplied)) return supplied;
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch { return "unknown"; }
}
const workletSource = readFileSync(new URL("./public/audio-worklet.js", import.meta.url), "utf8");
const workletVersion = createHash("sha256").update(workletSource).digest("hex").slice(0, 12);
const workletUrl = `/audio-worklet.js?v=${workletVersion}`;
export default defineConfig({
  define: {
    "import.meta.env.VITE_BUILD_COMMIT": JSON.stringify(buildCommit()),
    "import.meta.env.VITE_AUDIO_WORKLET_URL": JSON.stringify(workletUrl),
    "import.meta.env.VITE_AUDIO_WORKLET_HASH": JSON.stringify(workletVersion),
  },
  plugins: [
    {
      name: "mluvka-sw-version",
      closeBundle() {
        const dist = fileURLToPath(new URL("../dist/", import.meta.url));
        const worklet = workletSource.replace('/*__WORKLET_VERSION__*/ "dev"', JSON.stringify(workletVersion));
        writeFileSync(`${dist}/audio-worklet.js`, worklet);
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
          .replace(
            /\/\*__ASSETS__\*\/\s*\[\]/,
            JSON.stringify(
              [...assets.filter((asset) => !asset.includes("codec-worker")), workletUrl],
            ),
          );
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
      "/api": "http://localhost:3000",
      "/img": "http://localhost:3000",
    },
  },
});
