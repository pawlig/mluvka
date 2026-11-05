import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  applyCorrection,
  editable,
  formatCorrection,
  parseCorrection,
} from "../frontend/src/oprava.ts";

const msg = (thread, from, text, uid) => ({ thread, from, uid, text });
const sender = (from, uid) => ({ from, uid });

test("formát: krátký text se necituje zkráceně", () => {
  assert.equal(
    formatCorrection("Ahoj všichni", "Ahoj všem"),
    "✎ oprava „Ahoj všichni“: Ahoj všem",
  );
});
test("formát: 40 znaků bez …, 41 znaků zkrátit s …", () => {
  const a = "a".repeat(40);
  assert.equal(formatCorrection(a, "x"), `✎ oprava „${a}“: x`);
  assert.equal(formatCorrection(a + "b", "x"), `✎ oprava „${a}…“: x`);
});
test("formát: code pointy, zalomení a uvozovky", () => {
  const emoji = "😀".repeat(41);
  assert.equal(
    formatCorrection(emoji, "x"),
    `✎ oprava „${"😀".repeat(40)}…“: x`,
  );
  assert.equal(
    formatCorrection("řádek\ndruhý „citát“", "x"),
    '✎ oprava „řádek druhý "citát"“: x',
  );
});
test("parser: přijme jen přesný tvar", () => {
  assert.deepEqual(parseCorrection("✎ oprava „Ahoj“: Čau"), {
    quote: "Ahoj",
    text: "Čau",
  });
  assert.deepEqual(parseCorrection("✎ oprava „abc…“: nový\ntext"), {
    quote: "abc",
    text: "nový\ntext",
  });
  for (const bad of [
    "ahoj",
    "✎ oprava „Ahoj“:Čau",
    "✎ oprava „“: Čau",
    "oprava „Ahoj“: Čau",
    " ✎ oprava „Ahoj“: Čau",
    '✎ oprava "Ahoj": Čau',
    "✎ oprava „Ahoj“: ",
  ])
    assert.equal(parseCorrection(bad), null, bad);
});
test("párování: nejnovější shoda se nahradí a označí upraveno", () => {
  const list = [
    msg("server", 1, "Ahoj všichni"),
    msg("server", 1, "Ahoj všichni znovu"),
    msg("server", 1, "jiná"),
  ];
  const c = parseCorrection(formatCorrection("Ahoj všichni znovu", "Čau"));
  const r = applyCorrection(list, c, sender(1), "server");
  assert.deepEqual(
    r.map((m) => m.text),
    ["Ahoj všichni", "Čau", "jiná"],
  );
  assert.equal(r[1].edited, true);
  assert.equal(r[0].edited, undefined);
});
test("párování: nejnovější z více shod", () => {
  const list = [msg("t", 1, "Ahoj"), msg("t", 1, "Ahoj"), msg("t", 1, "x")];
  const r = applyCorrection(
    list,
    { quote: "Ahoj", text: "Čau" },
    sender(1),
    "t",
  );
  assert.deepEqual(
    r.map((m) => m.text),
    ["Ahoj", "Čau", "x"],
  );
});
test("párování: jiný odesílatel a jiná konverzace se nepáruje", () => {
  const list = [msg("t", 1, "Ahoj")];
  const c = { quote: "Ahoj", text: "Čau" };
  assert.equal(applyCorrection(list, c, sender(2), "t"), null);
  assert.equal(applyCorrection(list, c, sender(1), "jiná"), null);
});
test("párování: uid má přednost před id klienta", () => {
  const list = [msg("t", 1, "Ahoj", "U1")];
  const c = { quote: "Ahoj", text: "Čau" };
  assert.ok(applyCorrection(list, c, sender(9, "U1"), "t"));
  assert.equal(applyCorrection(list, c, sender(1, "U2"), "t"), null);
});
test("párování: zalomený původní text a opakovaná úprava", () => {
  let list = [msg("t", 1, "první\ndruhý")];
  list = applyCorrection(
    list,
    parseCorrection(formatCorrection("první\ndruhý", "A")),
    sender(1),
    "t",
  );
  assert.equal(list[0].text, "A");
  list = applyCorrection(
    list,
    parseCorrection(formatCorrection(list[0].text, "B")),
    sender(1),
    "t",
  );
  assert.equal(list[0].text, "B");
  assert.equal(list[0].edited, true);
});
test("párování: zkrácený citát odpovídá dlouhému originálu", () => {
  const long = "x".repeat(60);
  const r = applyCorrection(
    [msg("t", 1, long)],
    parseCorrection(formatCorrection(long, "kratší")),
    sender(1),
    "t",
  );
  assert.equal(r[0].text, "kratší");
});
test("párování: bez původní zprávy null", () => {
  assert.equal(
    applyCorrection([], { quote: "Ahoj", text: "Čau" }, sender(1), "t"),
    null,
  );
});
test("editable: přílohy a obrázky ne", () => {
  const f = (u) => u.startsWith("ts3file:");
  assert.equal(editable("obyčejný text", f), true);
  assert.equal(editable("odkaz https://example.org/a", f), true);
  assert.equal(editable("https://example.org/a.png", f), false);
  assert.equal(editable("[IMG]https://x/y[/IMG]", f), false);
  assert.equal(editable("📎 a.zip (1 kB)\nhttps://x/f/y", f), false);
  assert.equal(
    editable("🖥 Adam sdílí obrazovku v Mluvce — sledovat: https://example.org/#pozvanka=abc", f),
    false,
  );
  assert.equal(editable("ts3file://x", f), false);
  assert.equal(editable('{"msg_type":"ts.file.myts"}', f), false);
});
