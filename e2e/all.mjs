// Úplné regresní kroky běží v obou vyjednaných transportech proti skutečnému TS3.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, symlinkSync, rmSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
const report = new URL("../docs/e2e-vysledky.json", import.meta.url);
const partial = ["E2E_FOCUS", "E2E_TAIL", "E2E_NATIVE"].some((key) => !!process.env[key]);
const results = [],
  errors = [],
  runs = [];
// Jedna TS3 instance zůstává rezervovaná přes oba transporty; samostatné
// pracovní stromy jinak mohou obsadit local accounting mezi dvěma průchody.
const admin = randomBytes(18).toString("hex");
const bundle = process.env.TS3_DIR || resolve(import.meta.dirname, "../tmp-ts3/teamspeak3-server_mac");
// default_voice_port se používá jen při vytvoření DB. Starší sdílená DB by
// ignorovala TS3_VOICE_PORT, proto má každý úplný běh vlastní prázdnou DB.
const directory = mkdtempSync(resolve(import.meta.dirname, "../tmp-ts3/ts3-e2e-"));
for (const name of ["ts3server", "sql", ...readdirSync(bundle).filter((name) => /^lib.*\.(dylib|so)$/.test(name))])
  symlinkSync(resolve(bundle, name), resolve(directory, name));
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
          env: { ...process.env, E2E_CODEC: codec, E2E_TS_ADMIN: admin, TS3_DIR: directory },
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
    writeFileSync(
      report,
      JSON.stringify(
        {
          date: new Date().toISOString(),
          complete:
            !partial && runs.length === 2 && runs.every((run) => run.exitCode === 0),
          runs,
          results,
          errors,
        },
        null,
        2,
      ) + "\n",
    );
    if (status !== 0) {
      process.exitCode = status || 1;
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
  rmSync(directory, { recursive: true, force: true });
}
