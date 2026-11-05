// Samostatný proces: časování linky nesmí záviset na Playwright RPC / GC runneru.
import net from "node:net";
import { performance } from "node:perf_hooks";

const sockets = new Set();
let latency = 0, bytesPerSecond = Infinity, jitter = false;
let seed = 1291, gateCount = 0;
function jitterGap() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return ++gateCount % 17 === 0 ? 400 : 50 + seed / 4294967296 * 250;
}
let inputAt, outputAt, inputGapMs = 0, outputGapMs = 0;
const server = net.createServer((client) => {
  const upstream = net.connect({
    host: process.env.SHAPER_HOST,
    port: Number(process.env.SHAPER_PORT),
  });
  process.send?.({ connection: true });
  sockets.add(client);
  sockets.add(upstream);
  client.setNoDelay(true);
  upstream.setNoDelay(true);
  let header = Buffer.alloc(0), ready = false, next = 0, nextWriteAt = 0, queued = 0;
  let timer, blocked = false, ending = false, releasing = false, batchThrough;
  const queue = [];
  const close = () => {
    clearTimeout(timer);
    client.destroy();
    upstream.destroy();
    sockets.delete(client);
    sockets.delete(upstream);
  };
  const pump = () => {
    timer = undefined;
    if (blocked || client.destroyed) return;
    if (queue.length && jitter && !releasing) {
      releasing = true;
      timer = setTimeout(() => { batchThrough = performance.now(); pump(); }, jitterGap());
      return;
    }
    while (queue.length) {
      if (jitter && batchThrough !== undefined && queue[0].at > batchThrough) {
        releasing = false;
        batchThrough = undefined;
        pump();
        return;
      }
      const delay = Math.max(queue[0].at, nextWriteAt) - performance.now();
      if (delay > 0.5) {
        timer = setTimeout(pump, delay);
        return;
      }
      const { data } = queue.shift();
      queued -= data.length;
      const now = performance.now();
      if (outputAt !== undefined) outputGapMs = Math.max(outputGapMs, now - outputAt);
      outputAt = now;
      nextWriteAt = now + data.length * 1000 / bytesPerSecond;
      if (queued < 512 * 1024) upstream.resume();
      if (!client.write(data)) {
        blocked = true;
        return;
      }
    }
    releasing = false;
    batchThrough = undefined;
    if (ending) client.end();
  };
  client.on("drain", () => { blocked = false; pump(); });
  client.on("data", (data) => {
    if (!ready) {
      header = Buffer.concat([header, data]);
      const end = header.indexOf("\r\n\r\n");
      if (end < 0) {
        if (header.length > 16384) close();
        return;
      }
      // URL proxy má jiný port; backend stále ověřuje skutečný Origin proti Host.
      const request = header.subarray(0, end).toString("latin1")
        .replace(/^Host:[^\r\n]*/im, `Host: ${process.env.SHAPER_HOST_HEADER}`);
      data = Buffer.concat([Buffer.from(request + "\r\n\r\n", "latin1"), header.subarray(end + 4)]);
      header = undefined;
      ready = true;
    }
    if (!upstream.write(data)) client.pause();
  });
  upstream.on("drain", () => client.resume());
  let response = Buffer.alloc(0), wire = Buffer.alloc(0), protocol;
  const enqueue = (data, now) => {
    const at = Math.max(now + latency, next);
    for (let offset = 0; offset < data.length; offset += 1200) {
      const part = data.subarray(offset, offset + 1200);
      next = at + data.length * 1000 / bytesPerSecond;
      // Celý WS rámec má jeden deadline; hold nesmí rozdělit jeho tělo napůl.
      queue.push({ data: part, at });
      queued += part.length;
    }
  };
  upstream.on("data", (data) => {
    const now = performance.now();
    if (inputAt !== undefined) inputGapMs = Math.max(inputGapMs, now - inputAt);
    inputAt = now;
    if (!protocol) {
      response = Buffer.concat([response, data]);
      if (response.length < 5 && "HTTP/".startsWith(response.toString("latin1"))) return;
      if (response.subarray(0, 5).toString("latin1") !== "HTTP/") {
        protocol = "raw"; data = response;
      } else {
        const end = response.indexOf("\r\n\r\n");
        if (end < 0) { if (response.length > 16384) close(); return; }
        protocol = /^HTTP\/1\.1 101/.test(response.toString("latin1")) ? "ws" : "raw";
        enqueue(response.subarray(0, end + 4), now);
        data = response.subarray(end + 4);
      }
      response = undefined;
    }
    if (protocol === "ws") {
      wire = Buffer.concat([wire, data]);
      while (wire.length >= 2) {
        let headerSize = 2, length = wire[1] & 127;
        if (length === 126) {
          if (wire.length < 4) break;
          length = wire.readUInt16BE(2); headerSize = 4;
        } else if (length === 127) {
          if (wire.length < 10) break;
          const wide = wire.readBigUInt64BE(2);
          if (wide > 1024n * 1024n) { close(); return; }
          length = Number(wide); headerSize = 10;
        }
        if (wire[1] & 128) headerSize += 4;
        const size = headerSize + length;
        if (wire.length < size) break;
        enqueue(wire.subarray(0, size), now);
        wire = wire.subarray(size);
      }
    } else enqueue(data, now);
    if (queued > 1024 * 1024) upstream.pause();
    if (!timer && !blocked) pump();
  });
  client.on("error", close);
  upstream.on("error", close);
  client.on("close", close);
  upstream.on("end", () => {
    ending = true;
    if (!timer && !blocked) pump();
  });
  upstream.on("close", () => { if (!ending) close(); });
});

process.on("message", (message) => {
  if (message.type === "profile") {
    latency = message.latency;
    jitter = !!message.jitter;
    bytesPerSecond = message.bitsPerSecond ? message.bitsPerSecond / 8 : Infinity;
    process.send?.({ configured: true });
  }
  if (message.type === "snapshot") process.send?.({ id: message.id, inputGapMs, outputGapMs });
  if (message.type === "reset") {
    inputAt = outputAt = undefined;
    inputGapMs = outputGapMs = 0;
  }
});
const metrics = setInterval(() => process.send?.({ inputGapMs, outputGapMs }), 1000);
const stop = () => {
  clearInterval(metrics);
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
};
process.on("disconnect", stop);
process.on("SIGTERM", stop);
server.listen(0, "127.0.0.1", () => process.send?.({ port: server.address().port }));
