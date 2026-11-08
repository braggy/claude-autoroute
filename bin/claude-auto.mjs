#!/usr/bin/env node
// claude-auto: run Claude Code through the router (or, for subscription logins, straight to
// Anthropic with a model picked for you). All arguments go to `claude`.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { homeDir, loadConfig, validateConfig, configPath } from "../src/config.mjs";
import { startDaemon, ensureSecret, onPath } from "../src/util.mjs";
import { LOCAL_KEY_HEADER } from "../src/providers.mjs";
import { resolveMode, launchPlan, permittedTiers } from "../src/subscription.mjs";

const home = homeDir();
let cfg;
try { cfg = loadConfig(home); } catch (e) { console.error(`claude-auto: config error in ${configPath(home)}: ${e.message}`); process.exit(1); }
const errors = validateConfig(cfg);
if (errors.length) { console.error(`claude-auto: config problems:\n  - ${errors.join("\n  - ")}\nRun: autoroute doctor`); process.exit(1); }

const claude = process.env.AUTOROUTE_CLAUDE_BIN || onPath("claude");
if (!claude) { console.error("claude-auto: Claude Code (`claude`) not found on PATH"); process.exit(1); }

const env = { ...process.env };
let args = process.argv.slice(2);
const { mode, why } = resolveMode(cfg, env, home);

if (mode === "subscription") {
  // Subscription mode: Claude Code talks to Anthropic directly; the router isn't involved.
  // autoroute only chooses the model Claude Code starts on.
  if (/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):/.test(env.ANTHROPIC_BASE_URL || "")) delete env.ANTHROPIC_BASE_URL;
  delete env.AUTOROUTE_ACTIVE;
  env.AUTOROUTE_MODE = "subscription";
  const plan = launchPlan(cfg, args, permittedTiers(cfg, env));
  args = plan.args;
  if (plan.model) env.AUTOROUTE_START_MODEL = plan.model;
  if (process.stderr.isTTY && !env.AUTOROUTE_QUIET) {
    const notice = path.join(home, "subscription-mode-seen");
    if (!fs.existsSync(notice)) {
      console.error(`claude-auto: subscription mode (${why}). Claude Code signs in and talks to Anthropic directly;\n` +
        "autoroute never sees your login or messages. It picks the starting model and can suggest /model switches.\n" +
        "Tips: autoroute hints install · usage by model: autoroute usage · more: HELP.md \"I have Claude Pro or Max\"");
      try { fs.mkdirSync(home, { recursive: true, mode: 0o700 }); fs.writeFileSync(notice, "", { mode: 0o600 }); } catch {}
    }
    if (plan.model) console.error(`claude-auto: starting on ${plan.model} (${plan.reason})`);
  }
} else {
  // If you already point Claude Code at a gateway, the router forwards to it.
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
}

const child = spawn(claude, args, { stdio: "inherit", env });
// Claude Code handles Ctrl-C itself; don't let it kill this wrapper first.
for (const sig of ["SIGINT", "SIGQUIT"]) process.on(sig, () => {});
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
child.on("error", (e) => { console.error(`claude-auto: ${e.message}`); process.exit(1); });
