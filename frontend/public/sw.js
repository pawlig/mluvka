// Verzi i seznam hashovaných assetů při buildu doplní Vite.
const CACHE = "mluvka-__CACHE_VERSION__";
const SHELL = [
  "/",
  "/index.html",
  "/audio-worklet.js",
  "/favicon.svg",
  "/manifest.webmanifest",
  "/apple-touch-icon.png",
  "/icons/192.png",
  "/icons/512.png",
  "/icons/maskable-512.png",
  .../*__ASSETS__*/ [],
];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  // Žádné skipWaiting při instalaci: hovor v libovolném tabu má přednost.
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith("mluvka-") && key !== CACHE)
          await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});
function idle(client) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve(false);
    }, 1500);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(event.data?.idle === true);
    };
    client.postMessage({ type: "CAN_UPDATE" }, [channel.port2]);
  });
}
self.addEventListener("message", (event) => {
  if (event.data?.type !== "ACTIVATE_WHEN_IDLE") return;
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      if ((await Promise.all(clients.map(idle))).every(Boolean))
        await self.skipWaiting();
    })(),
  );
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Explicitní výjimky před respondWith; WS upgrade se běžně fetch událostí ani nestává.
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname === "/ws" ||
    url.pathname === "/healthz"
  )
    return;
  const index =
    event.request.mode === "navigate" ||
    url.pathname === "/" ||
    url.pathname === "/index.html";
  if (
    !index &&
    !url.pathname.startsWith("/assets/") &&
    !SHELL.includes(url.pathname)
  )
    return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (index) {
        try {
          const response = await fetch(event.request, { cache: "no-cache" });
          if (!response.ok) throw Error("index");
          await cache.put("/index.html", response.clone());
          return response;
        } catch {
          return (await cache.match("/index.html")) || Response.error();
        }
      }
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const response = await fetch(event.request);
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    })(),
  );
});
