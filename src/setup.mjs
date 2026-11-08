// Setup checks and Claude Code integration, shared by `autoroute doctor` and the dashboard.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { configPath, loadConfig, validateConfig } from "./config.mjs";
import { credential } from "./providers.mjs";
import { backendInfo } from "./secrets.mjs";
import { health, onPath, proxyVar, envProxySupported, ROOT, VERSION } from "./util.mjs";
import { appState } from "./launcher.mjs";
import { readAvailableModels, defaultPolicyPaths } from "./policy.mjs";
import { resolveMode, hintsState } from "./subscription.mjs";

export function settingsPath(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".claude"), "settings.json");
}
const readSettings = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; } };
export const statuslineCommand = () => `node "${path.join(ROOT, "bin", "statusline.mjs")}"`;
const isOurs = (s) => String(s.statusLine?.command || "").includes("statusline.mjs");

export function statuslineState(env) {
  const s = readSettings(settingsPath(env));
  return isOurs(s) ? "installed" : s.statusLine ? "other" : "none";
}

export function installStatusline(env) {
  const p = settingsPath(env);
  const s = readSettings(p);
  if (s.statusLine && !isOurs(s)) {
    return { ok: false, message: `You already have a status line in ${p}; left it alone. To combine them, call this from your script: ${statuslineCommand()}` };
  }
  s.statusLine = { type: "command", command: statuslineCommand() };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
  return { ok: true, message: `status line added to ${p}` };
}

export function removeStatusline(env) {
  const p = settingsPath(env);
  const s = readSettings(p);
  if (!isOurs(s)) return { ok: false, message: "no autoroute status line found" };
  delete s.statusLine;
  fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
  return { ok: true, message: "status line removed" };
}

/** Returns [{ level: "ok"|"warn"|"fail", text, fix? }] */
export async function runChecks(home, env = process.env, { probeCredentials = true, insideRouter = false } = {}) {
  const out = [];
  const add = (level, text, fix) => out.push({ level, text, ...(fix ? { fix } : {}) });
  const major = Number(process.versions.node.split(".")[0]);
  major >= 20 ? add("ok", `Node ${process.versions.node}`) : add("fail", `Node ${process.versions.node}; 20 or later is required`, "install Node.js 22 or later from https://nodejs.org");
  if (proxyVar(env)) {
    envProxySupported() ? add("ok", "Company proxy (HTTPS_PROXY) will be used for provider requests")
      : add("fail", `A company proxy is set (HTTPS_PROXY), but Node ${process.versions.node} can't use it for the router`, "install Node.js 22.21+ or 24.5+ from https://nodejs.org");
  }
  onPath("claude", env) ? add("ok", "Claude Code is installed") : add("fail", "Claude Code (`claude`) not found on PATH", "install Claude Code");
  const cp = configPath(home);
  fs.existsSync(cp) ? add("ok", `Config file: ${cp}`) : add("warn", "No config file yet; using defaults", "autoroute init");
  let cfg;
  try { cfg = loadConfig(home, env); } catch (e) { add("fail", `Config does not parse: ${e.message}`); return out; }
  const errors = validateConfig(cfg);
  errors.length ? errors.forEach((e) => add("fail", e)) : add("ok", "Config is valid");
  if (fs.existsSync(cp) && (fs.statSync(cp).mode & 0o077)) add("warn", "Config file is readable by other users", `chmod 600 "${cp}"`);
  for (const name of cfg.failover.order) {
    const p = cfg.providers[name];
    if (!p) continue;
    const a = p.auth || {};
    if (a.value && a.value.length > 20) add("warn", `${name}: auth.value holds a literal secret; prefer the keychain or an environment variable`);
    if (a.type === "passthrough") { add("ok", `${name}: uses Claude Code's own credential`); continue; }
    if (a.type === "none") { add("ok", `${name}: no credential needed`); continue; }
    if (!probeCredentials) continue;
    try { await credential(name, a, env); add("ok", `${name}: credential found (${a.keychain ? "keychain" : a.env ? "env " + a.env : a.command ? "command" : "value"})`); }
    catch (e) { add("fail", `${name}: ${e.message}`); }
  }
  if (!insideRouter) {
    const m = resolveMode(cfg, env, home);
    add("ok", `claude-auto runs in ${m.mode} mode (${m.why})`);
    if (m.mode === "subscription") {
      add("ok", "Subscription mode: Claude Code talks to Anthropic directly; autoroute only picks the starting model and gives tips");
      hintsState(env) === "installed" ? add("ok", "Model tips installed") : add("info", "Optional: model tips that suggest /model switches", "autoroute hints install");
    }
    cfg.subscriptionLogin === "refuse"
      ? add("ok", "The router refuses Claude subscription logins (Free/Pro/Max can't be routed); subscription mode covers them")
      : add("warn", "Subscription logins allowed: only correct for Team/Enterprise plans whose admin approved routing tools");
    const av = readAvailableModels(defaultPolicyPaths(env));
    add("ok", av.list ? `Model restrictions from ${av.source} will be honored: ${av.list.join(", ")}` : "No model restrictions found in Claude Code settings");
  }
  if (cfg.local?.enabled) add("info", `Easy tasks can run on your local model (${cfg.local.model}). It isn't Claude, so results can differ.`, "test it on the Providers page");
  const kc = backendInfo();
  kc.available ? add("ok", `Secure key storage: ${kc.name}`) : add("warn", "No secure key storage available", kc.help);
  if (insideRouter) add("ok", "Router running");
  else (await health(cfg.port, cfg.host)) ? add("ok", `Router running on ${cfg.host}:${cfg.port}`) : add("warn", "Router not running", "claude-auto starts it automatically");
  const app = appState(env);
  if (app !== "unsupported") app === "installed" ? add("ok", "Dashboard app icon installed") : add("info", "Optional: add an app icon for the dashboard", "autoroute app install");
  const sl = statuslineState(env);
  sl === "installed" ? add("ok", "Status line installed") : add("warn", sl === "other" ? "You have a different status line" : "Status line not installed", "autoroute statusline install");
  return out;
}

export { VERSION };
