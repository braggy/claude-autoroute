#!/usr/bin/env node
// claude-auto: run Claude Code through the router. All arguments go to `claude`.
import { spawn } from "node:child_process";
import { homeDir, loadConfig, validateConfig, configPath } from "../src/config.mjs";
import { startDaemon, ensureSecret, onPath } from "../src/util.mjs";
import { LOCAL_KEY_HEADER } from "../src/providers.mjs";

const home = homeDir();
let cfg;
try { cfg = loadConfig(home); } catch (e) { console.error(`claude-auto: config error in ${configPath(home)}: ${e.message}`); process.exit(1); }
const errors = validateConfig(cfg);
if (errors.length) { console.error(`claude-auto: config problems:\n  - ${errors.join("\n  - ")}\nRun: autoroute doctor`); process.exit(1); }

const claude = process.env.AUTOROUTE_CLAUDE_BIN || onPath("claude");
if (!claude) { console.error("claude-auto: Claude Code (`claude`) not found on PATH"); process.exit(1); }

// If you already point Claude Code at a gateway, the router forwards to it.
const env = { ...process.env };
if (env.ANTHROPIC_BASE_URL && !env.AUTOROUTE_UPSTREAM && !/^http:\/\/127\.0\.0\.1:/.test(env.ANTHROPIC_BASE_URL)) {
  env.AUTOROUTE_UPSTREAM = env.ANTHROPIC_BASE_URL;
}
if (!(await startDaemon(cfg, home, env))) {
  console.error(`claude-auto: router failed to start; see ${home}/router.out. Starting Claude Code without routing.`);
} else {
  env.ANTHROPIC_BASE_URL = `http://${cfg.host}:${cfg.port}`;
  env.AUTOROUTE_ACTIVE = "1";
  if (cfg.requireLocalKey) {
    const line = `${LOCAL_KEY_HEADER}: ${ensureSecret(home)}`;
    env.ANTHROPIC_CUSTOM_HEADERS = env.ANTHROPIC_CUSTOM_HEADERS ? `${env.ANTHROPIC_CUSTOM_HEADERS}\n${line}` : line;
  }
}

const child = spawn(claude, process.argv.slice(2), { stdio: "inherit", env });
// Claude Code handles Ctrl-C itself; don't let it kill this wrapper first.
for (const sig of ["SIGINT", "SIGQUIT"]) process.on(sig, () => {});
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
child.on("error", (e) => { console.error(`claude-auto: ${e.message}`); process.exit(1); });
