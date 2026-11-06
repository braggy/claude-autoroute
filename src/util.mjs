// Small cross-platform helpers: local secret, daemon start/stop, health checks.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

// The runtime folder holds logs, stats and the local key: owner-only access.
export function secureHome(home) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(home, 0o700); } catch {}
}
export const PRIVATE = { mode: 0o600 };

export function ensureSecret(home) {
  const p = path.join(home, "local-key");
  try { return fs.readFileSync(p, "utf8").trim(); } catch {}
  secureHome(home);
  const key = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(p, key + "\n", { mode: 0o600 });
  return key;
}

export function health(port, host = "127.0.0.1", timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: "/__autoroute/health", timeout: timeoutMs }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

// Full status from the running router (needs the local key from ~/.claude-autoroute).
export function routerStatus(port, host, home, timeoutMs = 1500) {
  let key = "";
  try { key = fs.readFileSync(path.join(home, "local-key"), "utf8").trim(); } catch {}
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: "/__autoroute/status", timeout: timeoutMs, headers: { "x-autoroute-key": key } }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { try { resolve(res.statusCode === 200 ? JSON.parse(b) : null); } catch { resolve(null); } });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Company networks often reach the internet through a proxy (HTTPS_PROXY). Claude Code
// honors it; Node's own HTTP client only does when NODE_USE_ENV_PROXY=1, which needs
// Node 22.21+ or 24.5+.
export const proxyVar = (env = process.env) => env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || "";
export function envProxySupported(version = process.versions.node) {
  const [a, b] = version.split(".").map(Number);
  return a > 24 || (a === 24 && b >= 5) || (a === 22 && b >= 21) || a === 23;
}
export function daemonEnv(env, home) {
  const out = { ...env, AUTOROUTE_HOME: home };
  if (proxyVar(env) && !env.NODE_USE_ENV_PROXY) out.NODE_USE_ENV_PROXY = "1";
  return out;
}

export async function startDaemon(cfg, home, env = process.env) {
  if (await health(cfg.port, cfg.host)) return true;
  secureHome(home);
  const out = fs.openSync(path.join(home, "router.out"), "a", 0o600);
  const child = spawn(process.execPath, [path.join(ROOT, "bin", "autoroute.mjs"), "serve"], {
    detached: true, stdio: ["ignore", out, out], env: daemonEnv(env, home),
  });
  child.unref();
  fs.writeFileSync(path.join(home, "router.pid"), String(child.pid), PRIVATE);
  for (let i = 0; i < 50; i++) { if (await health(cfg.port, cfg.host)) return true; await sleep(100); }
  return false;
}

// True only if pid is a live autoroute router. A stale router.pid can point at an
// unrelated program after a reboot or PID reuse, and we must never signal that.
export function isRouterProcess(pid, run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  try { return /autoroute\.mjs["']?\s+serve\b/.test(run("ps", ["-p", String(pid), "-o", "command="])); } catch { return false; }
}

export async function stopDaemon(cfg, home) {
  const h = await health(cfg.port, cfg.host);
  const pids = new Set();
  if (h?.pid && isRouterProcess(h.pid)) pids.add(h.pid); // something on our port, and it really is the router
  try {
    const p = Number(fs.readFileSync(path.join(home, "router.pid"), "utf8"));
    if (p !== h?.pid && isRouterProcess(p)) pids.add(p);
  } catch {}
  let stopped = false;
  for (const pid of pids) { try { process.kill(pid, "SIGTERM"); stopped = true; } catch {} }
  try { fs.unlinkSync(path.join(home, "router.pid")); } catch {}
  for (let i = 0; i < 20 && (await health(cfg.port, cfg.host)); i++) await sleep(100);
  return stopped;
}

// Find an executable on PATH (no `which` needed).
export function onPath(cmd, env = process.env) {
  for (const dir of (env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}
