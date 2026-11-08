// Account and organization policy:
//  1. Which kind of credential Claude Code is using, and whether the router may carry it.
//  2. Which models your organization allows (Claude Code's `availableModels`), so the
//     router never routes a request to a model your admin has blocked.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TIERS, parseJsonc } from "./config.mjs";

// ------------------------------------------------------------ credentials ---
// Anthropic does not allow third-party tools to route requests through Claude
// Free, Pro or Max plan logins. Subscription logins all look the same on the
// wire (an OAuth bearer token), so Team/Enterprise use needs an explicit opt-in
// confirming your organization has approved it.
export function credentialKind(headers = {}) {
  const auth = String(headers.authorization || "");
  const beta = String(headers["anthropic-beta"] || "");
  if (/^Bearer\s+sk-ant-oat/i.test(auth) || /(^|,)\s*oauth-/i.test(beta)) return "subscription";
  if (headers["x-api-key"]) return "api-key";
  if (auth) return "token"; // ANTHROPIC_AUTH_TOKEN, e.g. a company gateway key
  return "none";
}

export const SUBSCRIPTION_REFUSED =
  "claude-autoroute can't carry a Claude subscription login. Anthropic does not allow third-party tools to route " +
  "requests through Free, Pro or Max plan credentials. Use a Claude API key (Claude Console), Amazon Bedrock or Google " +
  "Vertex AI instead. Or just run claude-auto again: it now starts Claude Code in subscription mode, which never touches " +
  "your login and only picks the model and suggests /model switches (`autoroute mode subscription`). On a Team or Enterprise plan whose admin has approved " +
  "routing tools, set \"subscriptionLogin\": \"allow-team-enterprise\" in ~/.claude-autoroute/config.jsonc.";

export function subscriptionAllowed(cfg) {
  return cfg.subscriptionLogin === "allow-team-enterprise";
}

// ------------------------------------------------------- allowed models ---
export function defaultPolicyPaths(env = process.env) {
  const home = env.HOME || os.homedir();
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  const managedDir = process.platform === "darwin" ? "/Library/Application Support/ClaudeCode" : "/etc/claude-code";
  return {
    managedFile: path.join(managedDir, "managed-settings.json"),
    managedDropIns: path.join(managedDir, "managed-settings.d"),
    serverManaged: path.join(claudeDir, "remote-settings.json"),
    user: path.join(claudeDir, "settings.json"),
  };
}

function readJson(p) {
  try { return parseJsonc(fs.readFileSync(p, "utf8")); } catch { return null; }
}

/**
 * Returns { list: string[] | null, source } where list is the effective
 * availableModels (null = no restriction). Mirrors Claude Code: a managed list
 * applies as-is; otherwise lists from other scopes merge. Project-level settings
 * aren't visible to a shared router, so they're not included.
 */
export function readAvailableModels(paths) {
  const managed = [];
  const file = readJson(paths.managedFile);
  if (file?.availableModels) managed.push(...file.availableModels);
  try {
    for (const f of fs.readdirSync(paths.managedDropIns).filter((n) => n.endsWith(".json")).sort()) {
      const j = readJson(path.join(paths.managedDropIns, f));
      if (j?.availableModels) managed.push(...j.availableModels);
    }
  } catch {}
  const server = readJson(paths.serverManaged);
  if (server?.availableModels) managed.push(...server.availableModels);
  if (managed.length) return { list: [...new Set(managed)], source: "organization (managed settings)" };
  const user = readJson(paths.user);
  if (Array.isArray(user?.availableModels) && user.availableModels.length) return { list: user.availableModels, source: "your Claude Code settings" };
  return { list: null, source: null };
}

/** Is a tier allowed, given its model ID(s)? Entries can be aliases ("opus") or model IDs. */
export function tierAllowed(list, tier, modelIds = []) {
  if (!list) return true;
  return list.some((entry) => {
    const e = String(entry).toLowerCase().replace(/\[.*\]$/, "");
    if (e === tier) return true;
    // Exact IDs only (a provider prefix like "anthropic." or "global.anthropic." is fine).
    // No prefix matching: allowing "claude-opus-5" must not also allow "claude-opus-5-5".
    return modelIds.some((m) => { const id = String(m).toLowerCase(); return id === e || id.endsWith("." + e); });
  });
}

export class Policy {
  constructor(paths, ttlMs = 30000) { this.paths = paths; this.ttlMs = ttlMs; this.loaded = 0; this.value = { list: null, source: null }; }
  available() {
    if (Date.now() - this.loaded > this.ttlMs) { this.value = readAvailableModels(this.paths); this.loaded = Date.now(); }
    return this.value;
  }
  allowedTiers(cfg, providerModelsFor) {
    const { list } = this.available();
    return TIERS.filter((t) => tierAllowed(list, t, [cfg.models[t], ...providerModelsFor(t)]));
  }
}
