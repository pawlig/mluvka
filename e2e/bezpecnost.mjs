import { expect } from "@playwright/test";
import { request } from "node:http";
import { randomBytes } from "node:crypto";

async function open(url) {
  const ws = new WebSocket(url.replace(/^http/, "ws") + "/ws");
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(Error("WS nebyl přijat"));
  });
  return ws;
}
async function firstReply(ws, data) {
  const reply = new Promise((resolve, reject) => {
    ws.onmessage = (e) => resolve(JSON.parse(e.data));
    ws.onerror = reject;
  });
  ws.send(data);
  return reply;
}
export async function securityChecks(base, ok) {
  let ws = await open(base);
  const invalid = await firstReply(
    ws,
    JSON.stringify({
      type: "connect",
      nickname: "Test",
      server: "127.0.0.2",
      identity: null,
    }),
  );
  expect(invalid.message).toContain("není v seznamu povolených");
  ws.close();
  ok("ALLOWED_SERVERS odmítá nepovolený cíl před UDP připojením");
  ws = await open(base);
  const bad = await firstReply(ws, '{"type":"neplatny"}');
  expect(bad.type).toBe("error");
  ws.close();
  ok("Neplatný řídicí protokol → česká chyba a uzavření WS");
  ws = await open(base);
  const close = new Promise((resolve) => {
    ws.onclose = resolve;
  });
  ws.send("x".repeat(17000));
  const closed = await close;
  expect([1005, 1009]).toContain(closed.code);
  ok("Limit WS zprávy 16 KiB ukončí spojení");
  const originStatus = await new Promise((resolve, reject) => {
    const req = request(
      base + "/ws",
      {
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
          Origin: "https://cizi.example.org",
        },
      },
      (r) => {
        r.resume();
        resolve(r.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
  expect(originStatus).toBe(403);
  ok("Cizí Origin při WS upgradu → HTTP 403");
  // Vlastní testovací backend má MAX_SESSIONS=12, zatím není připojený žádný TS klient.
  if (!process.env.E2E_URL) {
    const slots = [];
    try {
      for (let i = 0; i < 12; i++) slots.push(await open(base));
      await expect(open(base)).rejects.toThrow("WS nebyl přijat");
      ok("MAX_SESSIONS=12 odmítne třináctý současný WS");
    } finally {
      for (const slot of slots) slot.close();
    }
  }
}
