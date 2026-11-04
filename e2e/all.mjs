// Úplné regresní kroky běží v obou vyjednaných transportech proti skutečnému TS3.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const report = new URL("../docs/e2e-vysledky.json", import.meta.url);
const results = [],
  errors = [],
  runs = [];
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
      { env: { ...process.env, E2E_CODEC: codec }, stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("exit", resolve);
  });
  runs.push({ codec, exitCode: status ?? 1 });
  const run = JSON.parse(readFileSync(report, "utf8"));
  results.push(...run.results.map((result) => ({ ...result, runCodec: codec })));
  errors.push(...run.errors);
  writeFileSync(
    report,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        complete: runs.length === 2 && runs.every((run) => run.exitCode === 0),
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
    break;
  }
}
