// Izolovaný coturn pouze po dobu E2E. Žádná služba ani produkční konfigurace.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
export async function localTurn() {
  const binary =
    process.env.TURNSERVER ||
    (existsSync("/opt/homebrew/opt/coturn/bin/turnserver")
      ? "/opt/homebrew/opt/coturn/bin/turnserver"
      : "turnserver");
  const dir = mkdtempSync(join(tmpdir(), "mluvka-turn-")),
    secret = randomBytes(32).toString("hex");
  const port = Number(process.env.E2E_TURN_PORT || 3479);
  const config = join(dir, "turn.conf");
  writeFileSync(
    config,
    [
      `listening-port=${port}`,
      "listening-ip=127.0.0.1",
      "relay-ip=127.0.0.1",
      "min-port=49220",
      "max-port=49260",
      "realm=example.org",
      "use-auth-secret",
      `static-auth-secret=${secret}`,
      "fingerprint",
      "no-cli",
      "no-tls",
      "no-dtls",
      // Nutné výhradně pro test dvou klientů a relay na jednom loopback hostiteli.
      "allow-loopback-peers",
      "no-multicast-peers",
      "user-quota=12",
      "total-quota=30",
      "no-stdout-log",
      "log-file=/dev/null",
      `pidfile=${join(dir, "pid")}`,
    ].join("\n"),
    { mode: 0o600 },
  );
  const child = spawn(binary, ["-c", config], { stdio: "ignore" });
  let spawnError;
  child.on("error", (error) => {
    spawnError = error;
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null && child.pid)
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill("SIGTERM");
      });
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    let ready = false;
    for (let i = 0; i < 40; i++) {
      if (spawnError || child.exitCode !== null)
        throw Error(
          "Lokální coturn nelze spustit (nainstalujte coturn, ověřte port 3479).",
        );
      ready = await new Promise((resolve) => {
        const s = connect(port, "127.0.0.1");
        s.on("connect", () => {
          s.destroy();
          resolve(true);
        });
        s.on("error", () => resolve(false));
      });
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (!ready) throw Error("Lokální coturn nezačal naslouchat.");
    return {
      env: {
        TURN_URLS: `turn:127.0.0.1:${port}?transport=udp,turn:127.0.0.1:${port}?transport=tcp`,
        TURN_SECRET: secret,
        STUN_URLS: "",
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
