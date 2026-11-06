// The `autoroute` command, run as a real process in a sandbox: its own HOME, autoroute
// folder, Claude settings folder and port, so nothing on the developer's machine is touched.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFile } from "node:child_process";
import { tmpHome } from "./helpers.mjs";

const BIN = new URL("../bin/autoroute.mjs", import.meta.url).pathname;
const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const stops = [];
after(async () => { for (const s of stops) await s(); });

async function freePort() {
  const s = net.createServer(); await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address(); await new Promise((r) => s.close(r)); return port;
}

async function sandbox({ config } = {}) {
  const root = tmpHome();
  const env = {
    PATH: process.env.PATH, HOME: path.join(root, "home"), AUTOROUTE_HOME: path.join(root, "autoroute"),
    CLAUDE_CONFIG_DIR: path.join(root, "claude"), XDG_DATA_HOME: path.join(root, "xdg"), AUTOROUTE_PORT: String(await freePort()),
  };
  for (const d of [env.HOME, env.CLAUDE_CONFIG_DIR]) fs.mkdirSync(d, { recursive: true });
  // A dead local upstream keeps every command hermetic: nothing goes to the internet.
  const cfg = config ?? { providers: { anthropic: { baseUrl: `http://127.0.0.1:${await freePort()}` } } };
  fs.mkdirSync(env.AUTOROUTE_HOME, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(env.AUTOROUTE_HOME, "config.jsonc"), JSON.stringify(cfg), { mode: 0o600 });
  const run = (...args) => new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env, timeout: 20000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }));
  });
  return { env, run, root, home: env.AUTOROUTE_HOME };
}

test("cli: version, help and unknown commands", async () => {
  const { run } = await sandbox();
  assert.equal((await run("version")).stdout.trim(), VERSION);
  assert.equal((await run("--version")).stdout.trim(), VERSION);
  const help = await run("help");
  assert.equal(help.code, 0); assert.match(help.stdout, /Usage: autoroute <command>/);
  const bad = await run("definitely-not-a-command");
  assert.equal(bad.code, 1, "unknown commands fail so scripts notice");
  assert.match(bad.stdout, /Usage:/);
});

test("cli: init writes a private config from the example and won't overwrite it", async () => {
  const { run, home } = await sandbox();
  fs.rmSync(path.join(home, "config.jsonc"));
  const first = await run("init");
  assert.equal(first.code, 0); assert.match(first.stdout, /wrote/);
  const file = path.join(home, "config.jsonc");
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600");
  assert.equal(fs.readFileSync(file, "utf8"), fs.readFileSync(new URL("../config.example.jsonc", import.meta.url), "utf8"));
  assert.equal((fs.statSync(path.join(home, "local-key")).mode & 0o777).toString(8), "600");
  assert.match((await run("init")).stdout, /already exists/);
  assert.match((await run("init", "--force")).stdout, /wrote/);
  assert.equal((await run("config", "path")).stdout.trim(), file);
});

test("cli: a broken config is reported with its location, not a stack trace", async () => {
  const { run, home } = await sandbox();
  fs.writeFileSync(path.join(home, "config.jsonc"), "{ not json");
  const r = await run("explain", "hello");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Config error in .*config\.jsonc/);
  assert.doesNotMatch(r.stderr, /at .*\.mjs:\d+/);
  fs.writeFileSync(path.join(home, "config.jsonc"), JSON.stringify({ classifier: { type: "magic" } }));
  const v = await run("explain", "hello");
  assert.equal(v.code, 1); assert.match(v.stderr, /classifier\.type must be/);
});

test("cli: explain shows the tier, model and reason", async () => {
  const { run } = await sandbox();
  const hard = await run("explain", "design a new architecture and refactor the whole codebase");
  assert.match(hard.stdout, /^opus -> claude-opus-5-5/);
  assert.match((await run("explain", "!haiku", "anything")).stdout, /^haiku .*\n.*\n\s+why:\s+override tag/);
});

test("cli: quick settings change the config and reject bad input", async () => {
  const { run, home } = await sandbox();
  const read = () => JSON.parse(fs.readFileSync(path.join(home, "config.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  assert.match((await run("pause")).stdout, /Paused/); assert.equal(read().paused, true);
  assert.match((await run("resume")).stdout, /Resumed/); assert.equal(read().paused, false);
  const noLocal = await run("local", "on");
  assert.equal(noLocal.code, 1, "can't turn on a local model that isn't set up"); assert.match(noLocal.stderr, /Set up a local model first/);
  fs.writeFileSync(path.join(home, "config.jsonc"), JSON.stringify({ ...read(), providers: { ...read().providers,
    local: { type: "anthropic", baseUrl: "http://127.0.0.1:11434", auth: { type: "none" }, priceMultiplier: 0, models: { haiku: "qwen3-coder", sonnet: "qwen3-coder", opus: "qwen3-coder" } } } }));
  assert.match((await run("local", "on")).stdout, /Local model on/); assert.equal(read().local.enabled, true);
  assert.match((await run("priority", "best-quality")).stdout, /Priority: /); assert.equal(read().priority, "best-quality");
  for (const args of [["local"], ["local", "maybe"], ["provider", "anthropic"], ["priority", "cheapest-ever"], ["statusline", "sideways"]]) {
    const r = await run(...args);
    assert.equal(r.code, 1, `${args.join(" ")} should fail`); assert.match(r.stdout, /usage:/);
  }
  const off = await run("provider", "anthropic", "off");
  assert.equal(off.code, 1, "can't switch off the only provider"); assert.match(off.stderr, /Not changed|switched off/);
  assert.ok(fs.existsSync(path.join(home, "config.jsonc.bak")), "a backup is kept");
});

test("cli: stats and savings with no data, then with data", async () => {
  const { run, home } = await sandbox();
  assert.match((await run("stats")).stdout, /No messages routed yet/);
  assert.match((await run("savings")).stdout, /No routed requests/);
  const ts = Date.now(), date = new Date(ts).toISOString().slice(0, 10);
  const row = (o) => JSON.stringify({ kind: "turn", ts, date, provider: "anthropic", newTurn: true, actual: 0.01, baseline: 0.05, ...o });
  fs.writeFileSync(path.join(home, "stats.jsonl"), [row({ tier: "haiku", originalTier: "opus" }), row({ tier: "opus", originalTier: "opus", regret: true })].join("\n") + "\n");
  const s = await run("stats");
  assert.match(s.stdout, /saved\s+\$0\.08/);
  assert.match(s.stdout, /messages\s+2\s+\(50% handled by a cheaper model\)/);
  assert.match(s.stdout, /regrets\s+1 time/);
  const json = JSON.parse((await run("stats", "--json")).stdout);
  assert.equal(json.messages, 2); assert.equal(json.regrets, 1); assert.equal(json.regretRate, 100);
  assert.match((await run("savings", "3")).stdout, /Last 3 day\(s\), 2 messages routed/);
});

test("cli: start, status, restart and stop manage one router process", async () => {
  const { run, env } = await sandbox();
  stops.push(() => run("stop"));
  assert.match((await run("status")).stdout, /not running/);
  assert.equal((await run("status", "--json")).code, 1);
  const start = await run("start");
  assert.equal(start.code, 0, start.stderr); assert.match(start.stdout, new RegExp(`running on http://127.0.0.1:${env.AUTOROUTE_PORT}`));
  const st = await run("status");
  assert.match(st.stdout, /routing on/); assert.match(st.stdout, /up\s+anthropic/);
  const json = JSON.parse((await run("status", "--json")).stdout);
  assert.equal(json.version, VERSION);
  assert.ok(!JSON.stringify(json).includes(env.HOME), "status never prints local paths");
  assert.match((await run("ui", "--no-open")).stdout, /Dashboard: http:\/\/127\.0\.0\.1:\d+\/ui\/login\?t=[0-9a-f]{32,}/);
  assert.equal((await run("restart")).code, 0);
  assert.match((await run("stop")).stdout, /stopped/);
  assert.match((await run("stop")).stdout, /not running/);
});

test("cli: diagnostics are safe to share", async () => {
  const { run, env } = await sandbox({ config: { providers: { anthropic: { baseUrl: "https://gateway.internal.example.com/v1" } } } });
  const r = await run("diagnostics");
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotThrow(() => JSON.parse(r.stdout));
  for (const secret of [env.HOME, env.AUTOROUTE_HOME, "gateway.internal.example.com"]) assert.ok(!r.stdout.includes(secret), `leaked ${secret}`);
});

test("cli: statusline install and remove only touch the sandboxed Claude settings", async () => {
  const { run, env } = await sandbox();
  const settings = path.join(env.CLAUDE_CONFIG_DIR, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ theme: "dark" }));
  assert.equal((await run("statusline", "install")).code, 0);
  const s = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.equal(s.theme, "dark", "other settings are kept"); assert.match(s.statusLine.command, /statusline\.mjs/);
  await run("statusline", "remove");
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, "utf8")), { theme: "dark" });
});

test("cli: llms prints the bundled docs", async () => {
  const { run } = await sandbox();
  const r = await run("llms");
  assert.equal(r.stdout, fs.readFileSync(new URL("../llms-full.txt", import.meta.url), "utf8"));
});
