// Configuration: defaults, JSONC parsing, merging and validation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TIERS = ["haiku", "sonnet", "opus"];

// Providers actually in use: failover.order minus any you've switched off.
export function activeOrder(cfg) {
  return (cfg.failover?.order || []).filter((n) => cfg.providers[n] && cfg.providers[n].enabled !== false);
}

export function homeDir() {
  return process.env.AUTOROUTE_HOME || path.join(os.homedir(), ".claude-autoroute");
}

export function configPath(home = homeDir()) {
  for (const name of ["config.jsonc", "config.json"]) {
    const p = path.join(home, name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(home, "config.jsonc");
}

export const DEFAULTS = {
  host: "127.0.0.1",
  port: 8787,
  // Listening on anything but loopback exposes the router to your network. Off unless you insist.
  allowNonLocalHost: false,
  // Reject requests that don't carry the secret header claude-auto adds, so other
  // programs on your machine can't spend your backup-provider credentials.
  requireLocalKey: true,
  // Claude subscription logins. Anthropic does not allow third-party tools to route
  // requests through Free, Pro or Max plan credentials, so they're refused.
  // "allow-team-enterprise": you confirm you're on a Team or Enterprise plan whose
  // admin has approved routing tools. (The router can't tell plan types apart.)
  subscriptionLogin: "refuse",
  // Pause routing: requests go through unchanged (failover still works).
  paused: false,
  shadow: false,       // decide, but don't change the model: shows what routing would save
  // Last priority preset chosen (lowest-cost, balanced, fastest, best-quality). Informational.
  priority: "balanced",
  // Only use these tiers, on top of any availableModels restriction from Claude Code.
  allowedTiers: ["haiku", "sonnet", "opus"],
  // Write the first 60 characters of each prompt to router.log (off = only tier + reason).
  logPromptSnippets: false,
  limits: {
    maxRequestMB: 50,    // largest request accepted from Claude Code
    logMB: 5,            // router.log is rotated to router.log.1 past this size
    statsDays: 90,       // stats.jsonl keeps this many days (lifetime totals are kept separately)
  },

  // Canonical model per tier. Providers can map these to their own IDs.
  models: {
    haiku: "claude-haiku-5-5",
    sonnet: "claude-sonnet-5-5",
    opus: "claude-opus-5-5",
  },

  // USD per million tokens. Cache writes are derived: 1.25x input (5 min), 2x (1 h).
  prices: {
    "claude-haiku-5-5": { in: 0.10, out: 0.50, read: 0.01, longAbove: 100000, longIn: 0.50, longOut: 2.50, longRead: 0.05 },
    "claude-sonnet-5-5": { in: 2.00, out: 10.00, read: 0.10 },
    "claude-opus-5-5": { in: 4.00, out: 20.00, read: 0.20 },
  },

  classifier: {
    type: "heuristic", // or "llm" (asks the haiku tier; ~0.5 s and ~$0.0001 per new message)
    opusScore: 3,      // score >= this wants opus
    haikuScore: -2,    // score <= this wants haiku
    opusKeywords: [
      "architect", "architecture", "design a", "design the", "system design",
      "refactor", "rewrite", "migrate", "migration", "root cause", "race condition",
      "deadlock", "concurrency", "memory leak", "performance", "optimi[sz]e",
      "security", "vulnerab", "threat model", "algorithm", "complexity",
      "debug", "why (is|does|doesn't|isn't|won't)", "investigate", "trade-?offs?",
      "plan", "strategy", "end-to-end", "across the (codebase|repo|project)",
      "entire (codebase|repo|project)", "from scratch", "think hard", "think deeply",
      "ultrathink", "carefully", "tricky", "subtle", "complex", "proof", "prove",
    ],
    haikuKeywords: [
      "^(what|where) is\\b", "^(list|show|print|cat|open|read) ", "rename",
      "typo", "spelling", "format(ting)?\\b", "lint", "add (a )?comment",
      "git (status|log|diff|add|commit|push|pull)", "commit (this|these|it)",
      "run (the )?(tests?|build|lint)", "bump (the )?version", "^explain this line",
      "translate", "convert .* to (json|yaml|csv)", "sort (the )?imports",
    ],
    followUpPattern:
      "^(y|yes|yep|yeah|ok|okay|sure|go|go ahead|do it|continue|proceed|next|" +
      "sounds good|looks good|lgtm|perfect|great|thanks|thank you|ty|please do|again|retry|try again)[.!\\s]*$",
  },

  switching: {
    mode: "cost-aware",          // or "always": follow the classifier, ignore cache cost
    expectedOutputTokens: 1500,  // per turn
    expectedRequestsPerTurn: 4,  // your message + Claude's tool calls
    returnProbability: 0.5,      // chance you'll soon need the bigger model again
    maxUpgradeCacheCostUSD: 0.5, // most we'll spend on a cache rebuild to move UP a tier
    maxStreakTurns: 5,           // how many easy turns can share a downgrade's cost
    bigContextTokens: 150000,    // above this, never go below bigContextMinTier
    bigContextMinTier: "sonnet",
  },

  // Optional: run easy tasks on a free local model (e.g. Ollama) instead of Claude.
  // Not a Claude model; Anthropic doesn't support Claude Code on other models, so
  // quality can differ. Off by default.
  local: {
    enabled: false,
    provider: "local",          // name of an entry in "providers"
    model: "qwen3-coder",       // model name as your local server knows it
    useFor: ["haiku"],          // which kinds of tasks: "haiku" = easy, "sonnet" = everyday
    maxContextTokens: 32000,    // larger chats stay on Claude (local models are slower with long input)
    fallbackToClaude: true,     // if the local model fails, send the request to Claude instead
    // Speed guard: skip the local model while its measured response time on easy tasks
    // is more than this many times Claude's. 0 = no limit (always use it).
    maxSlowdown: 2,
  },

  // Requests whose model matches this are Claude Code's own background calls.
  // They are never re-routed (but they still fail over).
  backgroundModelPattern: "haiku",

  providers: {
    anthropic: {
      type: "anthropic",
      baseUrl: "https://api.anthropic.com",
      auth: { type: "passthrough" }, // forward Claude Code's own API key / login
    },
  },

  failover: {
    order: ["anthropic"],           // first entry is the primary
    onStatus: [500, 502, 503, 504, 529],
    onRateLimit: false,             // also fail over on 429 (e.g. plan usage limits)
    onNetworkError: true,
    cooldownSeconds: 300,           // stay on the backup this long before retrying the primary
    connectTimeoutMs: 10000,
    responseTimeoutMs: 120000,      // until response headers arrive
  },
};

const PROVIDER_DEFAULTS = {
  anthropic: { enabled: true, baseUrl: "", path: "/v1/messages", auth: { type: "passthrough" }, models: {}, headers: {}, priceMultiplier: 1 },
  vertex: {
    enabled: true, projectId: "", region: "global", baseUrl: "", models: {}, headers: {}, priceMultiplier: 1,
    auth: { type: "bearer", command: "gcloud auth print-access-token", cacheSeconds: 3000 },
    forwardBetaHeaders: false,
  },
};

// ------------------------------------------------------------------ JSONC ---
export function stripJsonComments(text) {
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; continue; }
    out += c;
  }
  return stripTrailingCommas(out);
}

// Allow trailing commas, without touching commas inside strings.
function stripTrailingCommas(text) {
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += c;
  }
  return out;
}

export function parseJsonc(text) {
  return JSON.parse(stripJsonComments(text));
}

// ------------------------------------------------------------------ merge ---
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
export function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}

export function buildConfig(user = {}, env = process.env) {
  const cfg = deepMerge(DEFAULTS, user);
  // Providers: replace the default set if the user defines any, then fill per-type defaults.
  const providers = isObj(user.providers) ? user.providers : DEFAULTS.providers;
  cfg.providers = {};
  for (const [name, p] of Object.entries(providers)) {
    const type = p.type || "anthropic";
    cfg.providers[name] = deepMerge(PROVIDER_DEFAULTS[type] || {}, { ...p, type });
  }
  // Environment overrides (handy for tests and for people who already use a gateway).
  if (env.AUTOROUTE_PORT) cfg.port = Number(env.AUTOROUTE_PORT);
  if (env.AUTOROUTE_UPSTREAM && cfg.providers[cfg.failover.order[0]]) {
    cfg.providers[cfg.failover.order[0]].baseUrl = env.AUTOROUTE_UPSTREAM;
  }
  if (env.AUTOROUTE_CLASSIFIER) cfg.classifier.type = env.AUTOROUTE_CLASSIFIER;
  return compile(cfg);
}

// Invalid patterns compile to "never matches"; validateConfig reports them.
const NEVER = /(?!)/;
function re(src) { try { return new RegExp(src, "i"); } catch { return NEVER; } }

function compile(cfg) {
  const c = cfg.classifier;
  Object.defineProperty(cfg, "_re", {
    enumerable: false,
    value: {
      opus: (c.opusKeywords || []).map(re),
      haiku: (c.haikuKeywords || []).map(re),
      follow: re(c.followUpPattern),
      background: cfg.backgroundModelPattern ? re(cfg.backgroundModelPattern) : null,
    },
  });
  return cfg;
}

export function loadConfig(home = homeDir(), env = process.env) {
  const p = configPath(home);
  let user = {};
  if (fs.existsSync(p)) user = parseJsonc(fs.readFileSync(p, "utf8"));
  return buildConfig(user, env);
}

// ------------------------------------------------------------- validation ---
export function validateConfig(cfg) {
  const errors = [];
  const err = (m) => errors.push(m);
  for (const t of TIERS) if (!cfg.models?.[t]) err(`models.${t} is missing`);
  if (!["127.0.0.1", "localhost", "::1"].includes(cfg.host) && !cfg.allowNonLocalHost) {
    err(`host "${cfg.host}" would expose the router beyond this machine; use 127.0.0.1 (or set allowNonLocalHost: true if you really mean it)`);
  }
  if (!cfg.requireLocalKey && cfg.failover.order.some((n) => cfg.providers[n] && cfg.providers[n].auth?.type !== "passthrough" && cfg.providers[n].auth?.type !== "none")) {
    // Allowed, but worth knowing: any local program could then spend backup credentials.
  }
  if (!["heuristic", "llm"].includes(cfg.classifier.type)) err(`classifier.type must be "heuristic" or "llm"`);
  if (typeof cfg.shadow !== "boolean") err("shadow must be true or false");
  if (!["refuse", "allow-team-enterprise"].includes(cfg.subscriptionLogin)) err(`subscriptionLogin must be "refuse" or "allow-team-enterprise"`);
  if (!Array.isArray(cfg.allowedTiers) || !cfg.allowedTiers.length || cfg.allowedTiers.some((t) => !TIERS.includes(t))) err(`allowedTiers must list one or more of ${TIERS.join(", ")}`);
  if (!["cost-aware", "always"].includes(cfg.switching.mode)) err(`switching.mode must be "cost-aware" or "always"`);
  if (!TIERS.includes(cfg.switching.bigContextMinTier)) err(`switching.bigContextMinTier must be one of ${TIERS.join(", ")}`);
  for (const k of ["opusKeywords", "haikuKeywords"]) {
    for (const src of cfg.classifier[k] || []) { try { new RegExp(src); } catch { err(`classifier.${k}: invalid regex ${src}`); } }
  }
  for (const k of ["followUpPattern"]) { try { new RegExp(cfg.classifier[k]); } catch { err(`classifier.${k}: invalid regex`); } }
  try { if (cfg.backgroundModelPattern) new RegExp(cfg.backgroundModelPattern); } catch { err("backgroundModelPattern: invalid regex"); }
  for (const k of ["maxRequestMB", "logMB", "statsDays"]) {
    const v = cfg.limits?.[k];
    if (typeof v !== "number" || !(v > 0)) err(`limits.${k} must be a positive number`);
  }
  const order = cfg.failover.order || [];
  if (!order.length) err("failover.order needs at least one provider");
  else if (!activeOrder(cfg).length) err("all providers are switched off; turn at least one back on");
  for (const name of order) if (!cfg.providers[name]) err(`failover.order references unknown provider "${name}"`);
  for (const [name, p] of Object.entries(cfg.providers)) {
    const at = `providers.${name}`;
    if (!["anthropic", "vertex"].includes(p.type)) err(`${at}.type must be "anthropic" or "vertex"`);
    if (p.type === "anthropic" && !p.baseUrl) err(`${at}.baseUrl is required`);
    if (p.type === "vertex" && !p.projectId) err(`${at}.projectId is required for Vertex AI`);
    const a = p.auth || {};
    if (!["passthrough", "bearer", "x-api-key", "header", "none"].includes(a.type)) {
      err(`${at}.auth.type must be passthrough, bearer, x-api-key, header or none`);
    }
    if (["bearer", "x-api-key", "header"].includes(a.type) && !a.keychain && !a.env && !a.command && !a.value) {
      err(`${at}.auth needs one of "keychain", "env", "command" or "value"`);
    }
    if (a.keychain && !/^[A-Za-z0-9._-]{1,64}$/.test(a.keychain)) err(`${at}.auth.keychain: use letters, numbers, dot, dash, underscore`);
    if (a.type === "header" && !a.name) err(`${at}.auth.name (header name) is required`);
    if (a.type === "passthrough" && name !== order[0]) {
      err(`${at} uses passthrough auth but isn't the primary; that would send your Anthropic credentials to another service`);
    }
    for (const t of Object.keys(p.models || {})) if (!TIERS.includes(t)) err(`${at}.models.${t}: unknown tier`);
  }
  const L = cfg.local || {};
  if (L.enabled) {
    const lp = cfg.providers[L.provider];
    if (!lp) err(`local.provider "${L.provider}" isn't defined in providers`);
    else {
      if (lp.auth?.type === "passthrough") err(`providers.${L.provider} can't use passthrough auth (it would send your Claude credentials to the local server)`);
      if (order.includes(L.provider)) err(`local.provider "${L.provider}" shouldn't also be in failover.order`);
    }
    if (!L.model) err("local.model is required");
    if (!Array.isArray(L.useFor) || !L.useFor.length || L.useFor.some((t) => !["haiku", "sonnet"].includes(t))) err(`local.useFor must list "haiku" and/or "sonnet"`);
    if (!(L.maxContextTokens > 0)) err("local.maxContextTokens must be a positive number");
    if (!(L.maxSlowdown >= 0)) err("local.maxSlowdown must be 0 (no limit) or more");
  }
  return errors;
}
