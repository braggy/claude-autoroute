// First-run experience: shadow mode, the trial check, guided setup and the self-test.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { mockUpstream, startRouter, tmpHome, TOOLS, userMsg, until } from "./helpers.mjs";
import { summarize, emptyLifetime, accumulate, trialCheck, TRIAL_TARGETS } from "../src/stats.mjs";
import { applyQuick } from "../src/quick.mjs";
import { buildConfig } from "../src/config.mjs";
import { runSetup, parseSetupArgs } from "../src/setup-wizard.mjs";
import { selftest } from "../src/selftest.mjs";
import { stopDaemon } from "../src/util.mjs";
import { costOf, priceTable } from "../src/cost.mjs";

const FAKE_CLAUDE = new URL("./fixtures/fake-claude.mjs", import.meta.url).pathname;
const STATUSLINE = new URL("../bin/statusline.mjs", import.meta.url).pathname;
const cleanup = [];
after(async () => { for (const c of cleanup.reverse()) await c(); });

// ------------------------------------------------------------- shadow mode ---
async function shadowRouter(extra = {}) {
  const up = await mockUpstream();
  const r = await startRouter({ providers: { anthropic: { baseUrl: up.url } }, shadow: true, ...extra });
  cleanup.push(up.close, r.close);
  const rowsFile = path.join(r.home, "stats.jsonl");
  const rows = () => (fs.existsSync(rowsFile) ? fs.readFileSync(rowsFile, "utf8").trim().split("\n").map(JSON.parse) : []);
  return { up, r, rows };
}

test("shadow: keeps Claude Code's model, records what routing would have used and cost", async () => {
  const { up, r, rows } = await shadowRouter();
  const res = await r.post({ model: "claude-opus-5-5", tools: TOOLS, stream: true, messages: [userMsg("git status")] });
  assert.equal(res.model, "claude-opus-5-5", "the model is not changed");
  assert.equal(up.calls.at(-1).body.model, "claude-opus-5-5");
  await until(() => rows().length === 1, { what: "shadow row" });
  const row = rows()[0];
  assert.equal(row.kind, "shadow");
  assert.equal(row.wouldTier, "haiku");
  assert.ok(row.would < row.actual, "haiku would have been cheaper");
  assert.equal(row.baseline, row.actual, "nothing was actually saved");
  const v = summarize(r.server.ctx.stats.lifetime);
  assert.equal(v.messages, 0, "shadow messages don't count as routed");
  assert.equal(v.saved, 0, "real savings stay at zero");
  assert.equal(v.shadow.messages, 1);
  assert.equal(v.shadow.cheaperModelShare, 100);
  assert.ok(v.shadow.wouldSave > 0);
  const state = JSON.parse(fs.readFileSync(path.join(r.home, "state.json"), "utf8"));
  assert.equal(state.shadow, true); assert.equal(state.wouldTier, "haiku");
  assert.ok(state.today.would < state.today.actual);
});

test("shadow: a would-be switch is charged a cache rebuild, so estimates aren't flattering", async () => {
  const { r, rows } = await shadowRouter();
  const msgs = [userMsg("design a new architecture and refactor the whole codebase " + "context ".repeat(400))];
  await r.post({ model: "claude-opus-5-5", tools: TOOLS, stream: true, messages: msgs });
  msgs.push({ role: "assistant", content: [{ type: "text", text: "ok" }] });
  await r.post({ model: "claude-opus-5-5", tools: TOOLS, stream: true, messages: [...msgs, userMsg("git status")] });
  await until(() => rows().length === 2, { what: "two rows" });
  const [first, second] = rows();
  assert.equal(first.wouldTier, "opus");
  assert.equal(second.cacheMiss, true, "routing would have switched models here");
  const hyp = { ...second.usage, cache_creation_input_tokens: second.usage.cache_creation_input_tokens + second.usage.cache_read_input_tokens, cache_read_input_tokens: 0 };
  const cfg = r.cfg;
  assert.equal(second.would, costOf(priceTable(cfg, second.wouldTier, "anthropic"), hyp), "reads are re-priced as cache writes");
  assert.ok(summarize(r.server.ctx.stats.lifetime).shadow.rebuilds >= 1);
});

test("shadow: typed overrides still apply, and aren't counted as regrets", async () => {
  const { r } = await shadowRouter();
  const msgs = [userMsg("git status")];
  await r.post({ model: "claude-opus-5-5", tools: TOOLS, stream: true, messages: msgs });
  msgs.push({ role: "assistant", content: [{ type: "text", text: "ok" }] }, userMsg("!sonnet explain it"));
  const res = await r.post({ model: "claude-opus-5-5", tools: TOOLS, stream: true, messages: msgs });
  assert.equal(res.model, "claude-sonnet-5-5", "!sonnet is your explicit choice");
  await until(() => r.server.ctx.stats.lifetime.requests >= 1, { what: "override recorded" });
  assert.equal(summarize(r.server.ctx.stats.lifetime).regrets, 0);
});

test("shadow: the local model is never called, but shows as a would-be free pick", async () => {
  const local = await mockUpstream(), claude = await mockUpstream();
  cleanup.push(local.close, claude.close);
  const { r, rows } = await shadowRouter({
    providers: { anthropic: { baseUrl: claude.url }, local: { type: "anthropic", baseUrl: local.url, auth: { type: "none" }, priceMultiplier: 0 } },
    failover: { order: ["anthropic"] }, local: { enabled: true, provider: "local", model: "qwen3-coder" },
  });
  await r.post({ model: "claude-opus-5-5", tools: TOOLS, stream: true, messages: [userMsg("git status")] });
  await until(() => rows().length === 1, { what: "row" });
  assert.equal(local.calls.length, 0);
  assert.equal(rows()[0].wouldTier, "local");
  assert.equal(rows()[0].would, 0);
});

test("quick: the Routing control switches between on, shadow and paused", () => {
  const eff = buildConfig({});
  assert.deepEqual(pick(applyQuick({}, eff, { type: "mode", value: "shadow" })), { paused: false, shadow: true });
  assert.deepEqual(pick(applyQuick({ shadow: true }, eff, { type: "mode", value: "paused" })), { paused: true, shadow: false });
  assert.deepEqual(pick(applyQuick({ paused: true }, eff, { type: "shadow", value: true })), { paused: false, shadow: true });
  assert.deepEqual(pick(applyQuick({ shadow: true }, eff, { type: "mode", value: "on" })), { paused: false, shadow: false });
  assert.throws(() => applyQuick({}, eff, { type: "mode", value: "sideways" }), /unknown mode/);
  function pick(u) { return { paused: !!u.paused, shadow: !!u.shadow }; }
});

test("status line: shadow mode shows the would-be pick and saving", () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, "state.json"), JSON.stringify({ shadow: true, wouldTier: "haiku", today: { actual: 1.5, baseline: 1.5, would: 0.5 } }));
  const r = spawnSync(process.execPath, [STATUSLINE], { input: JSON.stringify({ workspace: { current_dir: "/x/proj" } }), env: { ...process.env, AUTOROUTE_ACTIVE: "1", AUTOROUTE_HOME: home }, encoding: "utf8" });
  assert.equal(r.stdout.trim(), "proj  👁 shadow · would use haiku · would save $1.00 today");
});

// ------------------------------------------------------------- trial check ---
test("trial check: waits for data, then judges each target", () => {
  const lt = emptyLifetime();
  const now = Date.now();
  const add = (n, o) => { for (let i = 0; i < n; i++) accumulate(lt, { kind: "turn", ts: now - 2 * 864e5, newTurn: true, tier: "haiku", originalTier: "opus", actual: 0.01, baseline: 0.05, overheadMs: 1.2, ...o }); };
  add(10);
  let t = trialCheck(summarize(lt), TRIAL_TARGETS, now);
  assert.match(t.verdict, /collecting \(10\/30/);
  assert.equal(t.checks.find((c) => /saves/.test(c.label)).state, "wait");
  add(25);
  t = trialCheck(summarize(lt), TRIAL_TARGETS, now);
  assert.equal(t.verdict, "on track: keep it on");
  assert.equal(t.days, 2);
  assert.ok(t.checks.every((c) => c.state === "pass"));
  add(5, { regret: true });
  accumulate(lt, { kind: "error", ts: now });
  t = trialCheck(summarize(lt), TRIAL_TARGETS, now);
  assert.equal(t.checks.find((c) => /regret/.test(c.label)).state, "fail");
  assert.equal(t.checks.find((c) => /errors/.test(c.label)).state, "fail");
  assert.match(t.verdict, /needs attention/);
});

test("trial check: savings below target is reported as working but below target", () => {
  const lt = emptyLifetime();
  for (let i = 0; i < 40; i++) accumulate(lt, { kind: "turn", ts: Date.now(), newTurn: true, tier: "opus", originalTier: "opus", actual: 0.05, baseline: 0.052, overheadMs: 1 });
  assert.match(trialCheck(summarize(lt)).verdict, /savings below target/);
});

// ---------------------------------------------------------------- setup ---
function sandboxEnv() {
  const root = tmpHome();
  const env = { PATH: process.env.PATH, HOME: path.join(root, "home"), CLAUDE_CONFIG_DIR: path.join(root, "claude"), AUTOROUTE_HOME: path.join(root, "autoroute") };
  fs.mkdirSync(env.HOME); fs.mkdirSync(env.CLAUDE_CONFIG_DIR);
  return { env, home: env.AUTOROUTE_HOME };
}
const readCfg = (home) => JSON.parse(fs.readFileSync(path.join(home, "config.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));

test("setup: an API key user gets shadow mode, balanced priority, a key and a status line", async () => {
  const { env, home } = sandboxEnv();
  const lines = [];
  const r = await runSetup({ home, env, opts: { login: "api-key", yes: true }, print: (l) => lines.push(l) });
  assert.equal(r.ok, true); assert.equal(r.shadow, true); assert.equal(r.selftest, true);
  const cfg = readCfg(home);
  assert.equal(cfg.shadow, true); assert.equal(cfg.paused, false); assert.equal(cfg.priority, "balanced");
  assert.equal(cfg.subscriptionLogin, undefined, "subscription login untouched for API key users");
  assert.equal((fs.statSync(path.join(home, "local-key")).mode & 0o777).toString(8), "600");
  assert.match(JSON.parse(fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8")).statusLine.command, /statusline/);
});

test("setup: Enterprise with admin approval allows the login; without it, stays refused and skips the self-test", async () => {
  const a = sandboxEnv();
  const yes = await runSetup({ home: a.home, env: a.env, opts: { login: "enterprise", adminApproved: true, yes: true }, print: () => {} });
  assert.equal(readCfg(a.home).subscriptionLogin, "allow-team-enterprise"); assert.equal(yes.selftest, true);
  const b = sandboxEnv();
  const lines = [];
  const no = await runSetup({ home: b.home, env: b.env, opts: { login: "enterprise", yes: true }, print: (l) => lines.push(l) });
  assert.equal(readCfg(b.home).subscriptionLogin, "refuse"); assert.equal(no.selftest, false);
  assert.ok(lines.some((l) => /What do I ask my admin/.test(l)));
});

test("setup: personal Pro/Max gets subscription mode (no router, no self-test); answers can come from prompts", async () => {
  const { env, home } = sandboxEnv();
  const r = await runSetup({ home, env, opts: { login: "personal", yes: true }, print: () => {} });
  assert.equal(r.ok, true); assert.equal(r.subscription, true); assert.equal(r.selftest, false);
  assert.equal(readCfg(home).mode, "subscription");
  assert.equal(readCfg(home).subscriptionLogin, undefined, "never allows the login itself through the router");
  const c = sandboxEnv();
  const asked = [];
  const answers = { "Your login": "api-key", "Shadow mode (Y/n)": "n" };
  const r2 = await runSetup({ home: c.home, env: c.env, ask: async (q, choices, def) => { asked.push(q.trim()); return answers[q.trim()] ?? def; }, print: () => {} });
  assert.equal(r2.shadow, false); assert.equal(readCfg(c.home).shadow, false);
  assert.ok(asked.includes("Your login") && asked.some((q) => /self-test/.test(q)));
  assert.deepEqual(parseSetupArgs(["--login", "enterprise", "--admin-approved", "--no-shadow", "-y"]), { yes: true, login: "enterprise", adminApproved: true, shadow: false });
});

// --------------------------------------------------------------- selftest ---
async function freePort() {
  const s = net.createServer(); await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address(); await new Promise((r) => s.close(r)); return port;
}
async function selftestSandbox(userCfg = {}, fakeEnv = {}, timeoutMs = 15000) {
  const up = await mockUpstream();
  const { env, home } = sandboxEnv();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const port = await freePort();
  const cfg = buildConfig({ port, providers: { anthropic: { baseUrl: up.url } }, ...userCfg });
  fs.writeFileSync(path.join(home, "config.jsonc"), JSON.stringify({ port, providers: { anthropic: { baseUrl: up.url } }, ...userCfg }));
  const fullEnv = { ...env, AUTOROUTE_CLAUDE_BIN: FAKE_CLAUDE, ...fakeEnv };
  cleanup.push(up.close, () => stopDaemon(cfg, home));
  const lines = [];
  const result = await selftest({ cfg, home, env: fullEnv, print: (l) => lines.push(l), timeoutMs });
  return { result, lines, up };
}

test("selftest: passes end to end with an API key, through the real router process", async () => {
  const { result, lines, up } = await selftestSandbox();
  assert.equal(result.ok, true, lines.join("\n"));
  assert.equal(result.loginType, "api-key");
  assert.ok(up.calls.some((c) => c.body?.messages?.[0]?.content?.[0]?.text?.includes("AUTOROUTE-OK")), "the request reached the provider");
  assert.ok(lines.some((l) => /Router saw it: /.test(l)), lines.join("\n"));
});

test("selftest: an unapproved Enterprise login is explained, with the exact fix", async () => {
  const { result, lines, up } = await selftestSandbox({}, { FAKE_CLAUDE_LOGIN: "subscription" });
  assert.equal(result.ok, false);
  assert.ok(lines.some((l) => /autoroute setup --login enterprise --admin-approved/.test(l)), lines.join("\n"));
  assert.equal(up.calls.length, 0, "nothing was forwarded");
});

test("selftest: an approved Enterprise login works", async () => {
  const { result, lines } = await selftestSandbox({ subscriptionLogin: "allow-team-enterprise" }, { FAKE_CLAUDE_LOGIN: "subscription" });
  assert.equal(result.ok, true, lines.join("\n"));
  assert.equal(result.loginType, "subscription");
});

test("selftest: falls back to the default model when Haiku isn't allowed", async () => {
  const { result, lines } = await selftestSandbox({}, { FAKE_CLAUDE_MODE: "fail-haiku" });
  assert.equal(result.ok, true, lines.join("\n"));
});

test("selftest: notices when the reply didn't go through the router", async () => {
  const { result, lines } = await selftestSandbox({}, { FAKE_CLAUDE_MODE: "ignore-base-url" });
  assert.equal(result.ok, false);
  assert.ok(lines.some((l) => /didn't go through the router/.test(l)));
});

test("selftest: missing Claude Code and timeouts give clear next steps", async () => {
  const { env, home } = sandboxEnv();
  const cfg = buildConfig({ port: await freePort() });
  const lines = [];
  const r = await selftest({ cfg, home, env: { ...env, PATH: "/nonexistent" }, print: (l) => lines.push(l) });
  assert.equal(r.ok, false); assert.ok(lines.some((l) => /isn't on your PATH/.test(l)));
  const slow = await selftestSandbox({}, { FAKE_CLAUDE_MODE: "hang" }, 1500);
  assert.equal(slow.result.ok, false);
  assert.ok(slow.lines.some((l) => /no reply within 2 s/.test(l)), slow.lines.join("\n"));
});

test("cli: setup --yes and selftest work end to end", async () => {
  const up = await mockUpstream();
  const { env, home } = sandboxEnv();
  const port = String(await freePort());
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, "config.jsonc"), JSON.stringify({ providers: { anthropic: { baseUrl: up.url } } }));
  const runEnv = { ...env, AUTOROUTE_PORT: port, AUTOROUTE_CLAUDE_BIN: FAKE_CLAUDE };
  cleanup.push(up.close, () => stopDaemon(buildConfig({ port: Number(port) }), home));
  const run = (...args) => new Promise((resolve) => execFile(process.execPath, [new URL("../bin/autoroute.mjs", import.meta.url).pathname, ...args], { env: runEnv, timeout: 30000 },
    (e, stdout, stderr) => resolve({ code: e ? e.code ?? 1 : 0, stdout, stderr })));
  const r = await run("setup", "--login", "api-key", "--yes");
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /shadow mode on/);
  assert.match(r.stdout, /All good\. Start Claude Code with:\s+claude-auto/);
  assert.match((await run("stats")).stdout, /Shadow mode is on\. Use Claude Code with claude-auto as normal/);
  assert.match((await run("shadow", "off")).stdout, /Shadow mode off/);
  assert.equal(readCfg(home).shadow, false);
  assert.equal((await run("shadow")).code, 1);
});
