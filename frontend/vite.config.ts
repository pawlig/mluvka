import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    proxy: {
      "/ws": { target: "ws://localhost:3000", ws: true, rewriteWsOrigin: true },
      "/healthz": "http://localhost:3000",
    },
  },
});
