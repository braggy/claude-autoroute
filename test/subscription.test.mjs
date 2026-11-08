// Subscription mode: for logins the router may not carry. Claude Code talks to Anthropic
// directly; autoroute only picks the starting model, gives /model tips and reads usage.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildConfig, validateConfig } from "../src/config.mjs";
import { detectLogin, resolveMode, parseClaudeArgs, launchPlan, clampTier, hintFor, transcriptTail,
  installHints, removeHints, hintsState, saveHint, readHints, permittedTiers } from "../src/subscription.mjs";
import { usageReport, parseTranscript } from "../src/usage.mjs";
import { tmpHome, policyPaths } from "./helpers.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const cfg = buildConfig({});

function sandbox() {
  const root = tmpHome();
  const env = { PATH: process.env.PATH, HOME: path.join(root, "home"), CLAUDE_CONFIG_DIR: path.join(root, "claude"), AUTOROUTE_HOME: path.join(root, "autoroute") };
  for (const d of [env.HOME, env.CLAUDE_CONFIG_DIR, env.AUTOROUTE_HOME]) fs.mkdirSync(d, { recursive: true });
  return { root, env, home: env.AUTOROUTE_HOME };
}

// ---------------------------------------------------------------- login ---
test("login detection: API-style credentials win, and no secret is ever read", () => {
  const { env, home } = sandbox();
  assert.equal(detectLogin({ ...env, ANTHROPIC_API_KEY: "x" }, { home }).kind, "api-key");
  assert.equal(detectLogin({ ...env, ANTHROPIC_AUTH_TOKEN: "x" }, { home }).kind, "token");
  assert.equal(detectLogin({ ...env, CLAUDE_CODE_USE_BEDROCK: "1" }, { home }).kind, "cloud");
  assert.equal(detectLogin({ ...env, CLAUDE_CODE_USE_VERTEX: "0" }, { home }).kind, "unknown", "0 means off");
  assert.equal(detectLogin({ ...env, ANTHROPIC_BASE_URL: "https://gw.example.com" }, { home }).kind, "gateway");
  assert.equal(detectLogin({ ...env, ANTHROPIC_BASE_URL: "http://127.0.0.1:8787" }, { home }).kind, "unknown", "our own router isn't a gateway");
  assert.equal(detectLogin({ ...env, CLAUDE_CODE_OAUTH_TOKEN: "x" }, { home }).kind, "subscription");
  assert.equal(detectLogin(env, { home }).kind, "unknown");
});

test("login detection: Claude Code settings, what the router saw, and the account summary", () => {
  const { env, home } = sandbox();
  fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "a@b.c" } }));
  assert.deepEqual(detectLogin(env, { home }), { kind: "subscription", source: "Claude Code account login" });
  fs.writeFileSync(path.join(home, "state.json"), JSON.stringify({ login: "api-key" }));
  assert.equal(detectLogin(env, { home }).kind, "api-key", "the router's observation beats the account summary");
  fs.writeFileSync(path.join(home, "state.json"), JSON.stringify({ blocked: "subscription" }));
  assert.equal(detectLogin(env, { home }).kind, "subscription");
  fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, "settings.json"), JSON.stringify({ apiKeyHelper: "echo k" }));
  assert.equal(detectLogin(env, { home }).kind, "api-key");
});

test("mode: auto picks subscription mode only for logins the router may not carry", () => {
  const { env, home } = sandbox();
  const sub = { ...env, CLAUDE_CODE_OAUTH_TOKEN: "x" };
  assert.equal(resolveMode(cfg, sub, home).mode, "subscription");
  assert.equal(resolveMode(buildConfig({ subscriptionLogin: "allow-team-enterprise" }), sub, home).mode, "router", "approved Team/Enterprise keeps the router");
  assert.equal(resolveMode(cfg, { ...env, ANTHROPIC_API_KEY: "k" }, home).mode, "router");
  assert.equal(resolveMode(cfg, env, home).mode, "router", "unknown login: the router finds out");
  assert.equal(resolveMode(buildConfig({ mode: "subscription" }), { ...env, ANTHROPIC_API_KEY: "k" }, home).mode, "subscription");
  assert.equal(resolveMode(buildConfig({ mode: "router" }), sub, home).mode, "router");
});

test("config: new settings are validated", () => {
  assert.deepEqual(validateConfig(cfg), []);
  const bad = validateConfig(buildConfig({ mode: "x", subscription: { startModel: "gpt", hints: "loud", pickStartModel: "yes", downgradeMaxContextTokens: -1 } }));
  for (const k of ["mode", "startModel", "hints", "pickStartModel", "downgradeMaxContextTokens"]) assert.ok(bad.some((e) => e.includes(k)), k);
});

// ------------------------------------------------------- start model ---
test("claude arguments: finds the prompt, skips option values and subcommands", () => {
  assert.equal(parseClaudeArgs(["fix the typo"]).prompt, "fix the typo");
  assert.equal(parseClaudeArgs(["-p", "fix the typo"]).prompt, "fix the typo");
  assert.equal(parseClaudeArgs(["--permission-mode", "plan", "design it"]).prompt, "design it");
  assert.equal(parseClaudeArgs(["--output-format", "json", "-p", "x"]).promptIndex, 3);
  assert.equal(parseClaudeArgs(["--model", "opus", "x"]).hasModel, true);
  assert.equal(parseClaudeArgs(["--model=opus"]).hasModel, true);
  assert.equal(parseClaudeArgs(["-c"]).skip, "resuming a conversation");
  assert.equal(parseClaudeArgs(["mcp", "list"]).skip, "not a chat");
  assert.equal(parseClaudeArgs(["--add-dir", "a", "b", "hello"]).skip, "can't find the prompt");
  assert.equal(parseClaudeArgs([]).prompt, null);
});

test("start model: picked from the first prompt; your own --model and resumes are left alone", () => {
  const easy = launchPlan(cfg, ["-p", "fix the typo in README"]);
  assert.deepEqual(easy.args, ["--model", "haiku", "-p", "fix the typo in README"]);
  const hard = launchPlan(cfg, ["refactor the architecture and find the root cause of the race condition"]);
  assert.equal(hard.model, "opus");
  assert.deepEqual(launchPlan(cfg, ["!opus rename x"]).args, ["--model", "opus", "rename x"], "override tag wins and is removed");
  assert.equal(launchPlan(cfg, ["--model", "sonnet", "fix typo"]).model, null);
  assert.equal(launchPlan(cfg, ["-c"]).model, null);
  assert.equal(launchPlan(cfg, []).model, null, "interactive start keeps Claude Code's default");
  assert.deepEqual(launchPlan(buildConfig({ subscription: { startModel: "opusplan" } }), []).args, ["--model", "opusplan"]);
  assert.equal(launchPlan(buildConfig({ subscription: { pickStartModel: false } }), ["fix typo"]).model, null);
});

test("start model: honors allowedTiers and your organization's availableModels", () => {
  assert.equal(clampTier("haiku", ["sonnet", "opus"]), "sonnet");
  assert.equal(clampTier("opus", ["haiku", "sonnet"]), "sonnet");
  assert.equal(clampTier("opus", []), null);
  const pp = policyPaths();
  fs.writeFileSync(pp.managedFile, JSON.stringify({ availableModels: ["sonnet", "opus"] }));
  const permitted = permittedTiers(cfg, {}, pp);
  assert.deepEqual(permitted, ["sonnet", "opus"]);
  assert.equal(launchPlan(cfg, ["fix the typo"], permitted).model, "sonnet");
});

// ---------------------------------------------------------------- hints ---
test("hints: suggest stronger and lighter models, once, and stay quiet when it wouldn't pay", () => {
  const up = hintFor({ prompt: "refactor the architecture to fix the race condition", current: { tier: "sonnet", contextTokens: 1000 }, cfg });
  assert.equal(up.tier, "opus"); assert.match(up.message, /\/model opus/);
  const down = hintFor({ prompt: "fix the typo", current: { tier: "opus", contextTokens: 1000 }, cfg });
  assert.equal(down.tier, "haiku"); assert.match(down.message, /\/model haiku.*\/model opus/);
  assert.equal(hintFor({ prompt: "fix the typo", current: { tier: "opus", contextTokens: 1000 }, last: "haiku", cfg }).message, undefined, "no repeats");
  assert.equal(hintFor({ prompt: "fix the typo", current: { tier: "opus", contextTokens: 90000 }, cfg }).tier, null, "long chat: switching costs more than it saves");
  assert.equal(hintFor({ prompt: "fix the typo", current: { tier: "haiku" }, cfg }).tier, null);
  assert.equal(hintFor({ prompt: "fix the typo", current: null, cfg }).tier, null, "unknown current model: no guess");
  assert.equal(hintFor({ prompt: "yes", current: { tier: "opus" }, cfg }).message, undefined, "follow-ups never hint");
  assert.equal(hintFor({ prompt: "fix the typo", current: { tier: "opus" }, cfg: buildConfig({ subscription: { hints: "upgrades" } }) }).tier, null);
  assert.equal(hintFor({ prompt: "refactor the architecture to fix the race condition", current: { tier: "haiku" }, cfg: buildConfig({ subscription: { hints: "off" } }) }).tier, null);
  assert.match(hintFor({ prompt: "!opus do it", current: { tier: "sonnet" }, cfg }).message, /router mode.*\/model opus/);
  assert.equal(hintFor({ prompt: "fix the typo", current: { tier: "opus" }, cfg, permitted: ["sonnet", "opus"] }).tier, "sonnet");
});

function transcript(dir, lines) {
  const f = path.join(dir, "projects", "p", "s.jsonl");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return f;
}
const now = Date.now();
const u = (text) => ({ type: "user", message: { role: "user", content: text }, timestamp: new Date(now - 60000).toISOString() });
const a = (id, model, usage, ago = 30000) => ({ type: "assistant", message: { id, model, usage }, timestamp: new Date(now - ago).toISOString() });

test("hints: the chat's current model comes from the transcript tail", () => {
  const { env } = sandbox();
  const f = transcript(env.CLAUDE_CONFIG_DIR, [u("hi"), a("m1", "claude-opus-5-5", { input_tokens: 10, cache_read_input_tokens: 500, output_tokens: 5 }), a("m2", "<synthetic>", {})]);
  assert.deepEqual(transcriptTail(f), { model: "claude-opus-5-5", tier: "opus", contextTokens: 510 });
  assert.equal(transcriptTail(path.join(env.HOME, "missing.jsonl")), null);
});

test("hints: hook script prints a tip for Claude Code, stores no prompt text, and installs/removes cleanly", () => {
  const { env, home } = sandbox();
  fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, "settings.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "mine.sh" }] }] } }));
  assert.equal(hintsState(env), "none");
  installHints(env); installHints(env);
  const s = JSON.parse(fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8"));
  assert.equal(s.hooks.UserPromptSubmit.length, 2, "added once, next to your own hook");
  assert.equal(hintsState(env), "installed");

  const f = transcript(env.CLAUDE_CONFIG_DIR, [u("hi"), a("m1", "claude-opus-5-5", { input_tokens: 10, output_tokens: 5 })]);
  const run = (prompt, extra = {}) => spawnSync(process.execPath, [path.join(ROOT, "bin", "hint.mjs")],
    { input: JSON.stringify({ prompt, session_id: "s1", transcript_path: f }), env: { ...env, ...extra }, encoding: "utf8" });
  const r = run("fix the secret typo in README");
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).systemMessage, /\/model haiku/);
  assert.deepEqual(Object.keys(readHints(home)), ["s1"]);
  assert.ok(!fs.readFileSync(path.join(home, "hints.json"), "utf8").includes("secret"), "no prompt text on disk");
  assert.equal(run("fix the typo again").stdout, "", "not repeated");
  assert.equal(run("fix the typo", { AUTOROUTE_ACTIVE: "1" }).stdout, "", "router mode handles it itself");
  assert.equal(spawnSync(process.execPath, [path.join(ROOT, "bin", "hint.mjs")], { input: "not json", env, encoding: "utf8" }).status, 0, "never breaks Claude Code");

  removeHints(env);
  const after = JSON.parse(fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8"));
  assert.deepEqual(after.hooks.UserPromptSubmit, [{ hooks: [{ type: "command", command: "mine.sh" }] }], "your own hook is kept");
  assert.equal(removeHints(env).ok, false);
});

test("status line: subscription mode shows Claude Code's model and the latest tip", () => {
  const { env, home } = sandbox();
  saveHint(home, "s1", "haiku");
  const r = spawnSync(process.execPath, [path.join(ROOT, "bin", "statusline.mjs")], {
    input: JSON.stringify({ session_id: "s1", model: { id: "claude-opus-5-5", display_name: "Opus" }, workspace: { current_dir: "/x/proj" } }),
    env: { ...env, AUTOROUTE_MODE: "subscription" }, encoding: "utf8" });
  assert.equal(r.stdout.trim(), "proj  🟣 opus · subscription mode · 💡 /model haiku");
});

// ---------------------------------------------------------------- usage ---
test("usage: by model from transcripts, streamed replies counted once, estimate includes cache rebuilds", () => {
  const { env } = sandbox();
  const big = { input_tokens: 100, cache_read_input_tokens: 20000, output_tokens: 800 };
  transcript(env.CLAUDE_CONFIG_DIR, [
    u("fix the typo in README"),
    a("m1", "claude-opus-5-5", { input_tokens: 100, output_tokens: 10 }), a("m1", "claude-opus-5-5", big),
    { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } },
    a("m2", "claude-opus-5-5", big),
    u("add a feature to export CSV"), a("m3", "claude-sonnet-5-5", big),
    u("old message"), a("m4", "claude-sonnet-5-5", big, 30 * 86400e3),
  ]);
  const r = usageReport(cfg, { env, days: 7, now });
  assert.equal(r.turns, 2);
  assert.equal(r.byTier.opus.replies, 2, "m1 counted once, with its final usage");
  assert.equal(r.byTier.opus.output, 1600);
  assert.equal(r.byTier.sonnet.replies, 1, "older than the window is left out");
  assert.equal(r.oversizedTurns, 1);
  assert.ok(r.couldSavePercent > 0 && r.couldSavePercent < 100);
  assert.ok(Math.abs(r.share.opus + r.share.sonnet - 1) < 1e-9);
  assert.equal(r.last5h.opus.replies, 2);
  assert.equal(usageReport(cfg, { env: { ...env, CLAUDE_CONFIG_DIR: path.join(env.HOME, "none") } }).turns, 0);
});

test("usage: follow-ups inherit the previous message's need", () => {
  const turns = parseTranscript([u("refactor the architecture to fix the race condition"), a("m1", "claude-opus-5-5", {}), u("yes"), a("m2", "claude-opus-5-5", {})].map((l) => JSON.stringify(l)).join("\n"), cfg);
  assert.deepEqual(turns.map((t) => t.wanted), ["opus", "opus"]);
});

// ---------------------------------------------------------- claude-auto ---
test("claude-auto: subscription mode never starts the router or touches the login", () => {
  const { env, home } = sandbox();
  fs.writeFileSync(path.join(home, "config.jsonc"), JSON.stringify({ mode: "subscription" }));
  const r = spawnSync(process.execPath, [path.join(ROOT, "bin", "claude-auto.mjs"), "-p", "fix the typo"], {
    env: { ...env, AUTOROUTE_CLAUDE_BIN: path.join(ROOT, "test", "fixtures", "fake-claude.mjs"), FAKE_CLAUDE_MODE: "echo", ANTHROPIC_BASE_URL: "http://127.0.0.1:8787" },
    encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out, { args: ["--model", "haiku", "-p", "fix the typo"], base: null, mode: "subscription", start: "haiku" });
  assert.ok(!fs.existsSync(path.join(home, "router.pid")) && !fs.existsSync(path.join(home, "local-key")), "no router, no key");
});
