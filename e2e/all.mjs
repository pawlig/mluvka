// Úplné regresní kroky běží v obou vyjednaných transportech proti skutečnému TS3.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
const report = new URL("../docs/e2e-vysledky.json", import.meta.url);
const results = [],
  errors = [],
  runs = [],
  knownAudioFailures = [];
// Jedna TS3 instance zůstává rezervovaná přes oba transporty; samostatné
// pracovní stromy jinak mohou obsadit local accounting mezi dvěma průchody.
const admin = randomBytes(18).toString("hex");
const directory =
  process.env.TS3_DIR ||
  resolve(import.meta.dirname, "../tmp-ts3/teamspeak3-server_mac");
const server = spawn(
  resolve(directory, "ts3server"),
  [
    "license_accepted=1",
    `serveradmin_password=${admin}`,
    "query_ip=127.0.0.1",
    "voice_ip=127.0.0.1",
    "query_protocols=raw",
    "filetransfer_ip=127.0.0.1",
    `default_voice_port=${process.env.TS3_VOICE_PORT || "9987"}`,
    `query_port=${process.env.TS3_QUERY_PORT || "10011"}`,
    `filetransfer_port=${process.env.TS3_FT_PORT || "30033"}`,
  ],
  { cwd: directory, stdio: "ignore" },
);
server.on("error", () => {});
try {
  for (const codec of ["opus", "pcm"]) {
    console.log(`\nAudio transport: ${codec}`);
    writeFileSync(
      report,
      JSON.stringify({
        date: new Date().toISOString(),
        results: [],
        errors: [],
      }) + "\n",
    );
    const status = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [new URL("./run.mjs", import.meta.url).pathname],
        {
          env: { ...process.env, E2E_CODEC: codec, E2E_TS_ADMIN: admin },
          stdio: "inherit",
        },
      );
      child.on("error", reject);
      child.on("exit", resolve);
    });
    runs.push({ codec, exitCode: status ?? 1 });
    const run = JSON.parse(readFileSync(report, "utf8"));
    results.push(
      ...run.results.map((result) => ({ ...result, runCodec: codec })),
    );
    errors.push(...run.errors);
    knownAudioFailures.push(
      ...(run.knownAudioFailures || []).map((failure) => ({
        ...failure,
        runCodec: codec,
      })),
    );
    writeFileSync(
      report,
      JSON.stringify(
        {
          date: new Date().toISOString(),
          scope: process.env.E2E_FOCUS === "files" ? "files" : "all",
          complete:
            runs.length === 2 && runs.every((run) => run.exitCode === 0),
          runs,
          results,
          errors,
          knownAudioFailures,
        },
        null,
        2,
      ) + "\n",
    );
    if (status !== 0) {
      process.exitCode = status || 1;
      break;
    }
  }
} finally {
  if (server.exitCode === null && server.signalCode === null)
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        server.kill("SIGKILL");
        resolve();
      }, 5000);
      server.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      server.kill("SIGTERM");
    });
}
