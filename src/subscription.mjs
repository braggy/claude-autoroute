// Subscription mode: for Claude Free, Pro and Max (and unapproved Team/Enterprise)
// logins, which a third-party tool must not route. In this mode claude-autoroute never
// sees your login or your traffic: Claude Code talks to Anthropic directly. Instead it
//   1. picks the model Claude Code starts on, from the prompt you start with,
//   2. suggests `/model` switches through a Claude Code hook (bin/hint.mjs), and
//   3. reports usage by model from Claude Code's own local transcripts (src/usage.mjs).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TIERS, parseJsonc } from "./config.mjs";
import { heuristic, OVERRIDE_RE, tierOf } from "./classify.mjs";
import { readAvailableModels, defaultPolicyPaths, tierAllowed, subscriptionAllowed } from "./policy.mjs";
import { ROOT } from "./util.mjs";

export const MODES = ["auto", "router", "subscription"];

const truthy = (v) => !!v && !/^(0|false|no)?$/i.test(String(v).trim());
const readJson = (p) => { try { return parseJsonc(fs.readFileSync(p, "utf8")); } catch { return null; } };
export const claudeDir = (env = process.env) => env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".claude");

/**
 * How is Claude Code likely signed in? Never reads a secret: only environment variable
 * names, Claude Code's settings, the account summary in ~/.claude.json (no token), and
 * what the router itself saw last time.
 * Returns { kind: "cloud"|"api-key"|"token"|"gateway"|"subscription"|"unknown", source }.
 */
export function detectLogin(env = process.env, { home } = {}) {
  if (["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"].some((k) => truthy(env[k]))) return { kind: "cloud", source: "environment" };
  if (env.ANTHROPIC_API_KEY) return { kind: "api-key", source: "ANTHROPIC_API_KEY" };
  if (env.ANTHROPIC_AUTH_TOKEN) return { kind: "token", source: "ANTHROPIC_AUTH_TOKEN" };
  if (env.ANTHROPIC_BASE_URL && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):/.test(env.ANTHROPIC_BASE_URL)) return { kind: "gateway", source: "ANTHROPIC_BASE_URL" };
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { kind: "subscription", source: "CLAUDE_CODE_OAUTH_TOKEN" };
  const settings = readJson(path.join(claudeDir(env), "settings.json")) || {};
  if (settings.apiKeyHelper) return { kind: "api-key", source: "apiKeyHelper in Claude Code settings" };
  const se = settings.env || {};
  if (se.ANTHROPIC_API_KEY) return { kind: "api-key", source: "Claude Code settings" };
  if (se.ANTHROPIC_AUTH_TOKEN) return { kind: "token", source: "Claude Code settings" };
  if (["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"].some((k) => truthy(se[k]))) return { kind: "cloud", source: "Claude Code settings" };
  // What the router saw on its last request (state.json never holds credentials).
  if (home) {
    const st = readJson(path.join(home, "state.json"));
    if (st?.blocked === "subscription" || st?.login === "subscription") return { kind: "subscription", source: "seen by the router" };
    if (st?.login === "api-key" || st?.login === "token") return { kind: st.login, source: "seen by the router" };
  }
  // Claude Code keeps a summary of a claude.ai account login (name, plan; no token) here.
  const account = readJson(env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(env.HOME || os.homedir(), ".claude.json"));
  if (account?.oauthAccount && !account.primaryApiKey) return { kind: "subscription", source: "Claude Code account login" };
  return { kind: "unknown", source: null };
}

/** Which mode claude-auto should use. Returns { mode: "router"|"subscription", login, why }. */
export function resolveMode(cfg, env = process.env, home) {
  const login = detectLogin(env, { home });
  if (cfg.mode === "router") return { mode: "router", login, why: "mode is set to router" };
  if (cfg.mode === "subscription") return { mode: "subscription", login, why: "mode is set to subscription" };
  if (login.kind === "subscription" && !subscriptionAllowed(cfg)) {
    return { mode: "subscription", login, why: `Claude subscription login (${login.source})` };
  }
  return { mode: "router", login, why: login.kind === "unknown" ? "login not known yet" : `${login.kind} login (${login.source})` };
}

// ------------------------------------------------------ claude arguments ---
// Claude Code options that take a value, so the value isn't mistaken for the prompt.
const VALUE_FLAGS = new Set(["--model", "--fallback-model", "--permission-mode", "--output-format", "--input-format",
  "--append-system-prompt", "--system-prompt", "--system-prompt-file", "--append-system-prompt-file", "--session-id",
  "--settings", "--setting-sources", "--agents", "--agent", "--max-turns", "--max-budget-usd", "--plugin-dir",
  "--permission-prompt-tool", "--json-schema", "--from-pr", "--debug-file", "--worktree"]);
// Options that take several values; after one of these we can't tell where the prompt is.
const LIST_FLAGS = new Set(["--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools", "--tools",
  "--add-dir", "--mcp-config", "--betas"]);
const SUBCOMMANDS = new Set(["mcp", "config", "doctor", "update", "upgrade", "install", "plugin", "plugins",
  "setup-token", "migrate-installer", "agents", "remote-control", "auth", "login", "logout"]);

/** Returns { prompt, promptIndex, hasModel, skip } for a claude command line. */
export function parseClaudeArgs(args = []) {
  const out = { prompt: null, promptIndex: -1, hasModel: false, skip: null };
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a === "--") { if (i + 1 < args.length) { out.prompt = String(args[i + 1]); out.promptIndex = i + 1; } break; }
    if (a === "--model" || a.startsWith("--model=")) { out.hasModel = true; if (a === "--model") i++; continue; }
    if (["-c", "--continue", "-r", "--resume", "--fork-session", "--teleport"].includes(a) || a.startsWith("--resume=")) { out.skip ||= "resuming a conversation"; continue; }
    if (["-h", "--help", "-v", "--version"].includes(a)) { out.skip ||= "not a chat"; continue; }
    if (LIST_FLAGS.has(a)) { out.skip ||= "can't find the prompt"; break; }
    if (VALUE_FLAGS.has(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    if (out.promptIndex < 0) {
      if (SUBCOMMANDS.has(a)) { out.skip ||= "not a chat"; break; }
      out.prompt = a; out.promptIndex = i;
    }
  }
  return out;
}

// ------------------------------------------------------------- choosing ---
/** Tiers you may use: autoroute's allowedTiers and your organization's availableModels. */
export function permittedTiers(cfg, env = process.env, policyPaths = defaultPolicyPaths(env)) {
  const { list } = readAvailableModels(policyPaths);
  return TIERS.filter((t) => cfg.allowedTiers.includes(t) && tierAllowed(list, t, [cfg.models[t]]));
}

/** Nearest permitted tier, preferring a stronger one when the wanted tier isn't allowed. */
export function clampTier(tier, permitted) {
  if (!permitted.length) return null;
  if (permitted.includes(tier)) return tier;
  const i = TIERS.indexOf(tier);
  return TIERS.slice(i + 1).find((t) => permitted.includes(t)) || [...TIERS.slice(0, i)].reverse().find((t) => permitted.includes(t));
}

/** What a prompt wants. Override tags (!opus etc.) win. */
export function wantedTier(text, cfg) {
  const ov = String(text || "").match(OVERRIDE_RE);
  if (ov) return { tier: ov[2].toLowerCase(), reason: `you typed !${ov[2].toLowerCase()}`, override: true };
  const d = heuristic(text, cfg);
  return { tier: d.tier, reason: d.reason, override: false };
}

/**
 * The arguments claude-auto passes to `claude` in subscription mode.
 * Returns { args, model, reason } (model null = leave Claude Code's choice alone).
 */
export function launchPlan(cfg, args = [], permitted = TIERS) {
  const s = cfg.subscription;
  const p = parseClaudeArgs(args);
  if (p.hasModel) return { args, model: null, reason: "you chose a model with --model" };
  if (p.skip) return { args, model: null, reason: p.skip };
  if (p.prompt != null && s.pickStartModel) {
    const w = wantedTier(p.prompt, cfg);
    const tier = clampTier(w.tier, permitted);
    if (!tier) return { args, model: null, reason: "no permitted model" };
    const next = [...args];
    if (w.override) next[p.promptIndex] = p.prompt.replace(OVERRIDE_RE, "$1").trim() || p.prompt;
    return { args: ["--model", tier, ...next], model: tier, reason: w.reason + (tier !== w.tier ? ` (${w.tier} isn't permitted)` : "") };
  }
  if (s.startModel && s.startModel !== "default") return { args: ["--model", s.startModel, ...args], model: s.startModel, reason: "subscription.startModel" };
  return { args, model: null, reason: "Claude Code's default model" };
}

// ---------------------------------------------------------------- hints ---
const contextOf = (u = {}) => (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
const assistantReply = (line) => {
  if (!line.includes('"assistant"')) return null;
  let j; try { j = JSON.parse(line); } catch { return null; }
  const m = j?.message;
  return j?.type === "assistant" && m?.model && m.model !== "<synthetic>" ? m : null;
};
// Claude Code logs a /model switch as local command output: "Set model to `Opus 5.5` ...".
const modelSwitch = (line) => {
  if (!line.includes("Set model to")) return null;
  let j; try { j = JSON.parse(line); } catch { return null; }
  const c = j?.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => b?.text || "").join("") : "";
  const m = text.match(/<local-command-stdout>[^<]*Set model to\W*([^`*\n]+)/);
  return m && tierOf(m[1]) ? m[1].trim() : null;
};

function readChunk(fd, pos, len) {
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, pos);
  return buf.toString("utf8").split("\n");
}

/**
 * The chat's current model and how much it has grown, from a Claude Code transcript.
 * Reads only the start and end of the file. contextTokens counts the chat itself: the
 * latest reply's context minus the first reply's, which is mostly Claude Code's own
 * system prompt and tools (about 40k tokens before you type anything).
 */
export function transcriptTail(file, maxBytes = 256 * 1024) {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, maxBytes);
      let first = null;
      // Claude Code writes ~70 KB of setup records before the first reply, so look well past that.
      for (const line of readChunk(fd, 0, Math.min(size, 1024 * 1024))) { const m = assistantReply(line); if (m) { first = m; break; } }
      const lines = readChunk(fd, size - len, len);
      let switched = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        switched ||= modelSwitch(lines[i]);
        const m = assistantReply(lines[i]);
        if (!m) continue;
        const total = contextOf(m.usage);
        const model = switched || m.model;
        return { model, tier: tierOf(model), contextTokens: Math.max(0, total - (first ? contextOf(first.usage) : 0)), totalTokens: total };
      }
      if (switched) return { model: switched, tier: tierOf(switched), contextTokens: 0, totalTokens: 0 };
    } finally { fs.closeSync(fd); }
  } catch {}
  return null;
}

const TIER_NAME = { haiku: "Haiku", sonnet: "Sonnet", opus: "Opus" };

/**
 * Should the hook suggest a /model switch for this prompt? Pure, so it's easy to test.
 *   current: { tier, contextTokens } of the chat so far (or null if unknown)
 *   last:    the tier suggested last time in this session (to avoid repeating it)
 * Returns { tier, message } or { tier: null }.
 */
export function hintFor({ prompt, current, last, cfg, permitted = TIERS }) {
  const s = cfg.subscription;
  if (s.hints === "off" || !prompt) return { tier: null };
  const text = String(prompt).trim();
  try { if (new RegExp(cfg.classifier.followUpPattern, "i").test(text)) return { tier: last || null, quiet: true }; } catch {}
  const w = wantedTier(text, cfg);
  const tier = clampTier(w.tier, permitted);
  if (w.override) {
    return { tier, message: `autoroute: !${w.tier} tags only change the model in router mode. Here, type /model ${tier || w.tier} to switch.` };
  }
  const cur = current?.tier;
  if (!tier || !cur || tier === cur) return { tier: null };
  const up = TIERS.indexOf(tier) > TIERS.indexOf(cur);
  if (!up && s.hints === "upgrades") return { tier: null };
  // Switching models re-reads the whole chat on the new model. In a long chat that costs
  // more of your limits than a cheaper model saves on one message. (contextTokens is the
  // chat's growth, so Claude Code's own fixed system prompt doesn't count.)
  if (!up && (current.contextTokens || 0) > s.downgradeMaxContextTokens) return { tier: null };
  if (tier === last) return { tier, quiet: true };
  const message = up
    ? `autoroute: this looks like ${tier === "opus" ? "an" : "a"} ${TIER_NAME[tier]}-level task (${w.reason}). For a stronger answer, type /model ${tier} and ask again.`
    : `autoroute: this looks simple (${w.reason}). /model ${tier} would use less of your plan's limits; /model ${cur} switches back.`;
  return { tier, message };
}

// Small per-session note of the last suggestion, for de-duplication and the status line.
// Holds session IDs and tier names only, never prompt text.
export const hintsFile = (home) => path.join(home, "hints.json");
export function readHints(home) { return readJson(hintsFile(home)) || {}; }
export function saveHint(home, sessionId, tier, now = Date.now()) {
  if (!sessionId) return;
  const all = readHints(home);
  for (const [k, v] of Object.entries(all)) if (!v || now - (v.at || 0) > 24 * 3600e3) delete all[k];
  if (tier) all[sessionId] = { tier, at: now }; else delete all[sessionId];
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const tmp = hintsFile(home) + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
    fs.renameSync(tmp, hintsFile(home));
  } catch {}
}

// ------------------------------------------------------ hook install ---
export function settingsFile(env = process.env) { return path.join(claudeDir(env), "settings.json"); }
export const hintCommand = () => `node "${path.join(ROOT, "bin", "hint.mjs")}"`;
const isHintHook = (h) => String(h?.command || "").includes("hint.mjs");
const readSettings = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; } };

export function hintsState(env = process.env) {
  const s = readSettings(settingsFile(env));
  return (s.hooks?.UserPromptSubmit || []).some((g) => (g.hooks || []).some(isHintHook)) ? "installed" : "none";
}

export function installHints(env = process.env) {
  const p = settingsFile(env);
  const s = readSettings(p);
  if (hintsState(env) === "installed") return { ok: true, message: `model tips already installed in ${p}` };
  s.hooks ||= {};
  s.hooks.UserPromptSubmit ||= [];
  s.hooks.UserPromptSubmit.push({ hooks: [{ type: "command", command: hintCommand(), timeout: 5 }] });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
  return { ok: true, message: `model tips added to ${p} (a UserPromptSubmit hook; it runs on this computer and sends nothing anywhere)` };
}

export function removeHints(env = process.env) {
  const p = settingsFile(env);
  const s = readSettings(p);
  if (hintsState(env) !== "installed") return { ok: false, message: "no autoroute model tips found" };
  s.hooks.UserPromptSubmit = s.hooks.UserPromptSubmit
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isHintHook(h)) }))
    .filter((g) => g.hooks.length);
  if (!s.hooks.UserPromptSubmit.length) delete s.hooks.UserPromptSubmit;
  if (!Object.keys(s.hooks).length) delete s.hooks;
  fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
  return { ok: true, message: "model tips removed" };
}
