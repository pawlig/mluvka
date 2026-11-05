import { test } from "node:test";
import { strict as assert } from "node:assert";
import { reconnectDelay } from "../frontend/src/reconnect.ts";
test("první návrat po výpadku má jitter 0–10 s, další exponenciální prodlevu", () => {
  assert.equal(
    reconnectDelay(1, () => 0),
    0,
  );
  assert.equal(
    reconnectDelay(1, () => 1),
    10000,
  );
  assert.equal(
    reconnectDelay(1, () => 0.37),
    3700,
  );
  assert.equal(
    reconnectDelay(2, () => 0),
    2000,
  );
  assert.equal(
    reconnectDelay(3, () => 0),
    4000,
  );
  assert.equal(
    reconnectDelay(4, () => 0.5),
    13000,
  );
  assert.equal(
    reconnectDelay(100, () => 1),
    40000,
  );
  assert.equal(
    reconnectDelay(100, () => 0),
    30000,
  );
});
