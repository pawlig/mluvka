import net from "node:net";
import { fork } from "node:child_process";
import { strict as assert } from "node:assert";

export async function shaperChecks(ok) {
  const payload = Buffer.from(Array.from({ length: 12000 }, (_, i) => i % 251));
  let header = "", child, socket;
  const server = net.createServer((peer) => peer.on("data", (data) => {
    header += data.toString();
    if (header.includes("\r\n\r\n")) peer.end(payload);
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    child = fork(new URL("./ws-shaper.mjs", import.meta.url), {
      execArgv: [],
      env: {
        ...process.env,
        SHAPER_HOST: "127.0.0.1",
        SHAPER_PORT: String(server.address().port),
        SHAPER_HOST_HEADER: "localhost:3000",
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const message = (predicate) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Shaper timeout")), 3000);
      const listener = (data) => {
        if (!predicate(data)) return;
        clearTimeout(timer);
        child.off("message", listener);
        resolve(data);
      };
      child.on("message", listener);
    });
    const { port } = await message((data) => data.port);
    const configured = message((data) => data.configured);
    child.send({ type: "profile", latency: 80, bitsPerSecond: 1500000 });
    await configured;
    socket = net.connect(port, "127.0.0.1");
    const chunks = [];
    let first = 0, last = 0;
    const start = performance.now();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Shaper neodeslal data / FIN")), 3000);
      socket.on("error", reject);
      socket.on("data", (data) => {
        if (!first) first = performance.now();
        last = performance.now();
        chunks.push(data);
      });
      socket.once("end", () => { clearTimeout(timer); resolve(); });
      socket.write("GET /ws HTTP/1.1\r\nHost: proxy\r\n\r\n");
    });
    assert.deepEqual(Buffer.concat(chunks), payload);
    assert.match(header, /Host: localhost:3000/);
    assert.ok(first - start >= 70);
    assert.ok(last - first >= 55);
    ok("TCP shaper 80 ms / 1,5 Mb/s: pořadí, rychlost a FIN bez ztráty", {
      latencyMs: first - start, transferMs: last - first, bytes: payload.length,
    });
  } finally {
    socket?.destroy();
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 1000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        if (child.connected) child.disconnect();
        else child.kill("SIGTERM");
      });
    }
    await new Promise((resolve) => server.close(resolve));
  }
}
