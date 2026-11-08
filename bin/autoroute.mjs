#!/usr/bin/env node
// autoroute: manage the router.
import fs from "node:fs";
import path from "node:path";
import { homeDir, configPath, loadConfig, validateConfig } from "../src/config.mjs";
import { createRouter, watchConfig } from "../src/server.mjs";
import { heuristic, OVERRIDE_RE } from "../src/classify.mjs";
import { savingsReport, loadLifetime, summarize } from "../src/stats.mjs";
import { health, routerStatus, startDaemon, stopDaemon, ensureSecret, secureHome, ROOT, VERSION } from "../src/util.mjs";
import { runChecks, installStatusline, removeStatusline } from "../src/setup.mjs";
import { createLoginToken } from "../src/ui-server.mjs";
import { installApp, removeApp } from "../src/launcher.mjs";
import { spawn } from "node:child_process";

const HELP = `autoroute ${VERSION}: per-message model routing and failover for Claude Code

Usage: autoroute <command>

  setup                guided first-time setup (login, shadow mode, status line, self-test)
  selftest             send one tiny message through Claude Code and the router, and check it all works
  ui [--no-open]       open the dashboard in your browser (setup, providers, savings, tuning)
  app install [--dock] add an "autoroute" app icon that opens the dashboard (macOS, Linux)
  app remove           remove it again
  mode [auto|router|subscription]  how claude-auto runs Claude Code (no argument: show the current mode)
  hints install|remove model tips in Claude Code for subscription mode (a local hook)
  usage [days] [--json] usage by model from Claude Code's own transcripts (any login, incl. Pro/Max)
  pause | resume       stop / restart changing models (failover keeps working)
  shadow on|off        decide but don't change models: see what routing would save, risk-free
  local on|off         use the free local model for easy tasks, or not
  provider <name> on|off   switch a provider on or off
  priority <name>      lowest-cost | balanced | fastest | best-quality
  init                 create ~/.claude-autoroute/config.jsonc from the documented example
  doctor               check your setup (config, providers, credentials, Claude Code)
  status [--json]      is the router running; providers; local model speed; last decision
  start | stop | restart
  log [lines]          follow the decision log
  explain "<prompt>"   which model a prompt would want, and why
  stats [--json]       lifetime value: money and time saved, cheaper-model share, failover rescues
  savings [days]       spend for a recent period (default 7 days)
  statusline install   add the status line to ~/.claude/settings.json
  statusline remove    remove it again
  llms                 print all the docs in one file for an AI assistant (llms-full.txt)
  diagnostics          print a support snapshot that's safe to share (no keys, prompts, URLs or paths)
  config path          print the config file location
  serve                run the router in the foreground (claude-auto does this for you)
  version

Run Claude Code through the router with:  claude-auto [any claude arguments]`;

const home = homeDir();
const [cmd, ...args] = process.argv.slice(2);

function cfgOrDie() {
  let cfg;
  try { cfg = loadConfig(home); } catch (e) { console.error(`Config error in ${configPath(home)}: ${e.message}`); process.exit(1); }
  const errors = validateConfig(cfg);
  if (errors.length) { console.error(`Config problems in ${configPath(home)}:\n  - ${errors.join("\n  - ")}`); process.exit(1); }
  return cfg;
}

async function main() {
  switch (cmd) {
    case "serve": {
      const cfg = cfgOrDie();
      secureHome(home);
      const server = createRouter({ cfg, home, logToStderr: !!process.env.AUTOROUTE_DEBUG });
      watchConfig(server, home);
      server.listen(cfg.port, cfg.host, () => {
        server.ctx.log(`autoroute ${VERSION} listening on ${cfg.host}:${cfg.port}; providers: ${cfg.failover.order.join(" -> ")}; classifier: ${cfg.classifier.type}; switching: ${cfg.switching.mode}`);
        console.log(`autoroute listening on http://${cfg.host}:${cfg.port}`);
      });
      server.on("error", (e) => {
        const msg = e.code === "EADDRINUSE" ? `port ${cfg.port} is already in use; set "port" in ${configPath(home)} or AUTOROUTE_PORT` : e.message;
        server.ctx.log("router failed to start:", msg);
        console.error("autoroute: " + msg);
        process.exit(1);
      });
      // Graceful stop: finish in-flight responses (streams can be long), then exit.
      let stopping = false;
      const bye = (signal) => {
        if (stopping) return;
        stopping = true;
        server.ctx.log(`${signal}: stopping`);
        server.ctx.stats.flush();
        server.close(() => process.exit(0));
        server.closeIdleConnections?.();
        setTimeout(() => { server.ctx.log("stop timed out; closing open streams"); process.exit(0); }, 10000).unref();
      };
      process.on("SIGTERM", () => bye("SIGTERM")); process.on("SIGINT", () => bye("SIGINT"));
      return;
    }
    case "start": {
      const cfg = cfgOrDie();
      if (await startDaemon(cfg, home)) console.log(`running on http://${cfg.host}:${cfg.port}`);
      else { console.error(`failed to start; see ${path.join(home, "router.out")}`); process.exit(1); }
      return;
    }
    case "stop": { const cfg = cfgOrDie(); console.log((await stopDaemon(cfg, home)) ? "stopped" : "not running"); return; }
    case "restart": {
      const cfg = cfgOrDie(); await stopDaemon(cfg, home);
      if (await startDaemon(cfg, home)) console.log(`running on http://${cfg.host}:${cfg.port}`); else process.exit(1);
      return;
    }
    case "status": {
      const cfg = cfgOrDie();
      const st = await routerStatus(cfg.port, cfg.host, home);
      if (args.includes("--json")) { console.log(JSON.stringify(st, null, 2)); if (!st) process.exitCode = 1; return; }
      if (!st) { console.log((await health(cfg.port, cfg.host)) ? "running, but status needs the local key (try: autoroute restart)" : "not running (claude-auto starts it automatically)"); return; }
      console.log(`running on http://${cfg.host}:${cfg.port} (v${st.version}) · ${st.paused ? "PAUSED" : "routing on"} · priority: ${st.priority} · switching: ${st.switching}`);
      for (const p of st.providers) console.log(`  ${p.up ? "up  " : "DOWN"} ${p.provider}${p.up ? "" : ` (retry in ${p.retryInSeconds}s: ${p.lastError})`}`);
      if (st.local.enabled) console.log(`  local model: ${st.local.model}${st.local.localSamples >= 5 && st.local.claudeSamples >= 5 ? ` (avg ${(st.local.localAvgMs / 1000).toFixed(1)}s vs Claude ${(st.local.claudeAvgMs / 1000).toFixed(1)}s)` : ""}`);
      console.log(`  today: paid $${st.today.actual.toFixed(2)}, est. without routing $${st.today.baseline.toFixed(2)}`);
      if (st.last) console.log(`  last: ${st.last.local ? "local " + st.last.model : st.last.tier} on ${st.last.provider} (${st.last.reason})`);
      return;
    }
    case "log": {
      const file = path.join(home, "router.log");
      const n = Number(args[0]) || 30;
      let size = 0;
      try { const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n"); process.stdout.write(lines.slice(-n).join("\n") + "\n"); size = fs.statSync(file).size; }
      catch { console.log("(no log yet)"); }
      fs.watchFile(file, { interval: 500 }, (cur) => {
        if (cur.size < size) size = 0;
        if (cur.size > size) {
          const fd = fs.openSync(file, "r"); const buf = Buffer.alloc(cur.size - size);
          fs.readSync(fd, buf, 0, buf.length, size); fs.closeSync(fd); size = cur.size; process.stdout.write(buf);
        }
      });
      return;
    }
    case "explain": {
      const cfg = cfgOrDie();
      const text = args.join(" ");
      const ov = text.match(OVERRIDE_RE);
      const d = ov ? { tier: ov[2].toLowerCase(), reason: "override tag", score: "-" } : heuristic(text, cfg);
      console.log(`${d.tier} -> ${cfg.models[d.tier]}\n  score: ${d.score}\n  why:   ${d.reason}`);
      console.log("  (in a long, active chat the cost check may keep the current model instead)");
      return;
    }
    case "savings": savingsReport(home, Number(args[0]) || 7); return;
    case "stats": {
      const v = summarize(loadLifetime(home));
      if (args.includes("--json")) { console.log(JSON.stringify(v, null, 2)); return; }
      const $ = (n) => "$" + n.toFixed(2), p = (n) => (n == null ? "–" : n.toFixed(0) + "%");
      const sh = v.shadow;
      if (sh) {
        console.log(`Shadow mode (nothing was changed; estimates from your real requests)\n`);
        console.log(`  would have saved   ${$(Math.max(0, sh.wouldSave))}  (${p(sh.percentCheaper)} of the ${$(sh.paid)} you paid)`);
        console.log(`  cheaper model      ${p(sh.cheaperModelShare)} of ${sh.messages} message(s)${sh.localMessages ? `, ${sh.localMessages} on your local model` : ""}`);
        console.log(`  cache rebuilds     ${sh.rebuilds} counted (switching isn't free)`);
        console.log(sh.messages >= 30 ? "  -> Enough data to decide. Turn routing on with: autoroute shadow off\n" : `  -> About ${30 - sh.messages} more message(s) for a reliable picture.\n`);
      }
      if (!v.messages) {
        let shadowOn = false;
        try { shadowOn = !!loadConfig(home).shadow; } catch {}
        if (!sh) console.log(shadowOn ? "Shadow mode is on. Use Claude Code with claude-auto as normal; what routing would save shows here after a few messages." : "No messages routed yet. Use claude-auto, then check back.");
        return;
      }
      const dur = (ms) => { const m = Math.round(Math.abs(ms) / 60000); return (ms < 0 ? "-" : "") + (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`); };
      console.log(`autoroute since ${new Date(v.since).toLocaleDateString()}\n`);
      console.log(`  saved              ${$(v.saved)}  (${p(v.percentCheaper)} cheaper than without autoroute)`);
      console.log(`  paid               ${$(v.paid)}  vs ${$(v.withoutAutoroute)} estimated without it`);
      console.log(`  messages           ${v.messages}  (${p(v.cheaperModelShare)} handled by a cheaper model)`);
      console.log(`  upgraded           ${v.upgraded} hard message(s) given a stronger model`);
      console.log(`  regrets            ${v.regrets} time(s) you typed !opus/!sonnet right after a cheaper pick${v.regretRate == null ? "" : ` (${p(v.regretRate)} of cheaper picks)`}`);
      console.log(`  failover rescues   ${v.failoverRequests} request(s) served by a backup when the primary failed`);
      console.log(`  time saved         ${v.timeSavedMs == null ? "collecting data" : "~" + dur(v.timeSavedMs) + " (estimated from your measured response times)"}`);
      console.log(`  router overhead    ${v.avgOverheadMs == null ? "–" : v.avgOverheadMs.toFixed(1) + " ms per request"}`);
      console.log(`  cache rebuilds     ${$(v.cacheRebuildCost)} across ${v.switches} switch(es), already subtracted`);
      const { trialCheck } = await import("../src/stats.mjs");
      const t = trialCheck(v);
      console.log(`\nTrial check (${t.days} day(s), ${v.messages} messages): ${t.verdict}`);
      for (const c of t.checks) console.log(`  ${{ pass: "ok  ", fail: "MISS", wait: "... " }[c.state]} ${c.label.padEnd(26)} ${c.detail}`);
      return;
    }
    case "init": {
      const target = path.join(home, "config.jsonc");
      if (fs.existsSync(target) && args[0] !== "--force") { console.log(`${target} already exists (use --force to overwrite)`); return; }
      secureHome(home);
      fs.copyFileSync(path.join(ROOT, "config.example.jsonc"), target);
      fs.chmodSync(target, 0o600);
      ensureSecret(home);
      console.log(`wrote ${target}\nEdit it, then run: autoroute doctor`);
      return;
    }
    case "doctor": return doctor();
    case "pause": case "resume": return quick({ type: "pause", value: cmd === "pause" }, cmd === "pause" ? "Paused: Claude Code's requests go through unchanged (failover still works). Undo with: autoroute resume" : "Resumed: routing is on.");
    case "setup": {
      const { runSetup, parseSetupArgs, LOGINS } = await import("../src/setup-wizard.mjs");
      const opts = parseSetupArgs(args);
      let rl = null;
      const ask = async (question, choices, def) => {
        const { createInterface } = await import("node:readline/promises");
        rl ||= createInterface({ input: process.stdin, output: process.stdout });
        if (!choices) return (await rl.question(`${question} `)).trim() || def;
        choices.forEach((c, i) => console.log(`  ${i + 1}. ${LOGINS[c] || c}${c === def ? "  [default]" : ""}`));
        for (;;) {
          const a = (await rl.question(`${question} (1-${choices.length}): `)).trim();
          if (!a) return def;
          if (choices[Number(a) - 1]) return choices[Number(a) - 1];
          if (choices.includes(a)) return a;
        }
      };
      const interactive = process.stdin.isTTY && !opts.yes;
      const r = await runSetup({ home, opts, ask: interactive ? ask : null });
      rl?.close();
      if (!r.ok) { process.exitCode = r.stop ? 0 : 1; return; }
      if (r.selftest) { console.log(""); return selftestCmd(); }
      if (r.subscription) { console.log("\nDone. Start Claude Code with:  claude-auto   (or claude-auto \"your first message\")\nSee your usage by model with:  autoroute usage\n"); return; }
      console.log(`\nDone. From now on, start Claude Code with:  claude-auto\n${r.shadow ? "Check what it would save any time with:      autoroute stats\n" : ""}`);
      return;
    }
    case "selftest": return selftestCmd();
    case "mode": {
      const { resolveMode, MODES } = await import("../src/subscription.mjs");
      if (!args[0]) {
        const cfg = cfgOrDie();
        const r = resolveMode(cfg, process.env, home);
        console.log(`mode setting: ${cfg.mode}\nclaude-auto will use: ${r.mode} mode (${r.why})`);
        console.log(r.mode === "subscription"
          ? "  Claude Code talks to Anthropic directly; autoroute picks the starting model and suggests /model switches."
          : "  Claude Code goes through the local router, which picks the model for each message.");
        return;
      }
      if (!MODES.includes(args[0])) { console.log("usage: autoroute mode [auto|router|subscription]"); process.exitCode = 1; return; }
      return quick({ type: "claude-auto-mode", value: args[0] }, {
        auto: "Mode: auto. Subscription logins get subscription mode; API keys, Bedrock, Vertex and gateways get the router.",
        router: "Mode: router. claude-auto always runs Claude Code through the router.",
        subscription: "Mode: subscription. claude-auto runs Claude Code straight to Anthropic, picks the starting model, and (with `autoroute hints install`) suggests /model switches.",
      }[args[0]]);
    }
    case "hints": {
      const { installHints, removeHints } = await import("../src/subscription.mjs");
      if (args[0] === "install") console.log(installHints().message);
      else if (args[0] === "remove") console.log(removeHints().message);
      else { console.log("usage: autoroute hints install|remove"); process.exitCode = 1; }
      return;
    }
    case "usage": {
      const { usageReport, printUsage } = await import("../src/usage.mjs");
      const days = Number(args.find((a) => /^\d+$/.test(a))) || 7;
      const r = usageReport(cfgOrDie(), { days });
      if (args.includes("--json")) console.log(JSON.stringify(r, null, 2)); else printUsage(r);
      return;
    }
    case "shadow": {
      if (!["on", "off"].includes(args[0])) { console.log("usage: autoroute shadow on|off"); process.exitCode = 1; return; }
      return quick({ type: "shadow", value: args[0] === "on" }, args[0] === "on"
        ? "Shadow mode on: Claude Code keeps its own model, and autoroute records what it would have picked and saved. See: autoroute stats"
        : "Shadow mode off: routing now picks the model for each message.");
    }
    case "local": {
      if (!["on", "off"].includes(args[0])) { console.log("usage: autoroute local on|off"); process.exitCode = 1; return; }
      return quick({ type: "local", value: args[0] === "on" }, `Local model ${args[0] === "on" ? "on for easy tasks" : "off"}.`);
    }
    case "provider": {
      if (!args[0] || !["on", "off"].includes(args[1])) { console.log("usage: autoroute provider <name> on|off"); process.exitCode = 1; return; }
      return quick({ type: "provider", name: args[0], value: args[1] === "on" }, `Provider ${args[0]} ${args[1]}.`);
    }
    case "priority": {
      const { PRESETS } = await import("../src/quick.mjs");
      if (!PRESETS[args[0]]) {
        console.log("usage: autoroute priority <name>\n");
        for (const [k, v] of Object.entries(PRESETS)) console.log(`  ${k.padEnd(13)} ${v.description}`);
        process.exitCode = 1; return;
      }
      return quick({ type: "priority", name: args[0] }, `Priority: ${PRESETS[args[0]].label}. ${PRESETS[args[0]].description}`);
    }
    case "app": {
      secureHome(home);
      const r = args[0] === "install" ? installApp({ home, dock: args.includes("--dock"), reveal: !args.includes("--no-open") })
              : args[0] === "remove" ? removeApp({ home })
              : { ok: false, messages: ["usage: autoroute app install [--dock] | autoroute app remove"] };
      for (const m of r.messages) console.log(m);
      if (!r.ok) process.exitCode = 1;
      return;
    }
    case "ui": {
      const cfg = cfgOrDie();
      if (!(await startDaemon(cfg, home))) { console.error(`router failed to start; see ${path.join(home, "router.out")}`); process.exit(1); }
      const host = cfg.host === "::1" ? "[::1]" : cfg.host;
      const url = `http://${host}:${cfg.port}/ui/login?t=${createLoginToken(home)}`;
      console.log(`Dashboard: ${url}\n(one-time link, valid for 2 minutes)`);
      if (!args.includes("--no-open")) openBrowser(url);
      if (process.env.SSH_CONNECTION) {
        console.log(`\nOn a remote machine? Forward the port from your computer first:\n  ssh -L ${cfg.port}:127.0.0.1:${cfg.port} <this host>\nthen open the link above in your local browser.`);
      }
      return;
    }
    case "statusline": {
      if (args[0] === "install") console.log(installStatusline().message);
      else if (args[0] === "remove") console.log(removeStatusline().message);
      else { console.log("usage: autoroute statusline install|remove"); process.exitCode = 1; }
      return;
    }
    case "llms": process.stdout.write(fs.readFileSync(path.join(ROOT, "llms-full.txt"), "utf8")); return;
    case "diagnostics": {
      const { collect } = await import("../src/diagnostics.mjs");
      console.log(JSON.stringify(await collect({ home, cfg: cfgOrDie() }), null, 2));
      return;
    }
    case "config": console.log(configPath(home)); return;
    case "version": case "--version": case "-v": console.log(VERSION); return;
    default: console.log(HELP); if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") process.exit(1);
  }
}

// Quick settings write the config file; a running router picks the change up within ~2 s.
async function quick(action, message) {
  const { applyQuick, readUserConfig, saveUserConfig } = await import("../src/quick.mjs");
  const { buildConfig } = await import("../src/config.mjs");
  const cfg = cfgOrDie();
  let next;
  try { next = applyQuick(readUserConfig(home).user, cfg, action); } catch (e) { console.error(e.message); process.exitCode = 1; return; }
  const errors = validateConfig(buildConfig(next));
  if (errors.length) { console.error(`Not changed:\n  - ${errors.join("\n  - ")}`); process.exitCode = 1; return; }
  secureHome(home);
  saveUserConfig(home, next);
  console.log(message);
}

// Same behaviour on both platforms: the system's "open this URL" command.
function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return;
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    child.on("error", () => console.log(`(couldn't open a browser automatically; open the link above)`));
    child.unref();
  } catch {}
}

async function selftestCmd() {
  const { selftest } = await import("../src/selftest.mjs");
  const cfg = cfgOrDie();
  const { resolveMode } = await import("../src/subscription.mjs");
  const m = resolveMode(cfg, process.env, home);
  if (m.mode === "subscription") {
    console.log(`autoroute selftest: claude-auto uses subscription mode (${m.why}), so the router isn't involved and there's`);
    console.log("nothing to test. Claude Code talks to Anthropic directly. Check your setup with: autoroute doctor");
    return;
  }
  console.log("autoroute selftest\n");
  const r = await selftest({ cfg, home, print: (l) => console.log(l) });
  if (r.ok) {
    console.log(`\nAll good. Start Claude Code with:  claude-auto${cfg.shadow ? "\nShadow mode is on: nothing changes yet. See what it would save with: autoroute stats" : ""}`);
  } else {
    console.log("\nSomething needs fixing (see the -> lines above). HELP.md: \"The self-test failed\" has more.");
    process.exitCode = 1;
  }
}

async function doctor() {
  console.log(`autoroute ${VERSION} doctor\n`);
  const checks = await runChecks(home);
  const tag = { ok: "  ok   ", warn: "  warn ", fail: "  FAIL ", info: "  tip  " };
  for (const c of checks) console.log(`${tag[c.level]} ${c.text}${c.fix ? `  ->  ${c.fix}` : ""}`);
  const failed = checks.some((c) => c.level === "fail");
  console.log(failed ? "\nFix the FAIL items above." : "\nAll good.");
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
