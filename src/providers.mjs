// Turning one Anthropic Messages request into a request for a specific provider.
import { exec } from "node:child_process";
import { TIERS } from "./config.mjs";
import { getSecret } from "./secrets.mjs";

// Headers that carry the caller's Anthropic credentials. They are only ever
// forwarded to a provider using "passthrough" auth.
const CREDENTIAL_HEADERS = ["authorization", "x-api-key"];
const HOP_HEADERS = ["host", "content-length", "connection", "accept-encoding", "keep-alive", "transfer-encoding"];
export const LOCAL_KEY_HEADER = "x-autoroute-key";

// Model ID for a tier on a provider; falls back to the nearest tier it has (preferring up).
export function providerModel(cfg, providerName, tier) {
  const p = cfg.providers[providerName];
  const map = p.models || {};
  if (map[tier]) return { model: map[tier], tier };
  if (!Object.keys(map).length) return { model: cfg.models[tier], tier };
  const i = TIERS.indexOf(tier);
  const order = [...TIERS.slice(i + 1), ...TIERS.slice(0, i).reverse()];
  for (const t of order) if (map[t]) return { model: map[t], tier: t };
  return { model: cfg.models[tier], tier };
}

// -------------------------------------------------------------- auth ---
const tokenCache = new Map(); // provider -> { value, expires }

function runCommand(cmd, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs, windowsHide: true }, (e, stdout, stderr) => {
      if (e) return reject(new Error(`auth command failed: ${cmd}: ${(stderr || e.message).trim()}`));
      const v = stdout.trim();
      if (!v) return reject(new Error(`auth command printed nothing: ${cmd}`));
      resolve(v);
    });
  });
}

export async function credential(name, auth, env = process.env) {
  if (auth.value) return auth.value;
  if (auth.keychain) {
    const hit = tokenCache.get(name);
    if (hit && hit.expires > Date.now()) return hit.value;
    const value = await getSecret(auth.keychain);
    tokenCache.set(name, { value, expires: Date.now() + (auth.cacheSeconds ?? 300) * 1000 });
    return value;
  }
  if (auth.env) {
    const v = env[auth.env];
    if (!v) throw new Error(`environment variable ${auth.env} is not set (needed by provider "${name}")`);
    return v;
  }
  if (auth.command) {
    const hit = tokenCache.get(name);
    if (hit && hit.expires > Date.now()) return hit.value;
    const value = await runCommand(auth.command);
    tokenCache.set(name, { value, expires: Date.now() + (auth.cacheSeconds ?? 3000) * 1000 });
    return value;
  }
  throw new Error(`provider "${name}" has no credential configured`);
}
export function forgetCredential(name) { tokenCache.delete(name); }

// --------------------------------------------------------- build ---
/**
 * Build the outgoing request.
 *   body: parsed Anthropic request (will be copied), model already chosen by caller
 *   clientHeaders: headers from Claude Code
 * Returns { url, headers, body (string) }.
 */
export async function buildRequest(cfg, providerName, { pathname, body, clientHeaders, env = process.env }) {
  const p = cfg.providers[providerName];
  const headers = {};
  for (const [k, v] of Object.entries(clientHeaders || {})) {
    const key = k.toLowerCase();
    if (HOP_HEADERS.includes(key) || key === LOCAL_KEY_HEADER) continue;
    headers[key] = v;
  }
  const auth = p.auth || { type: "passthrough" };
  if (auth.type !== "passthrough") {
    for (const h of CREDENTIAL_HEADERS) delete headers[h];
    // Claude Code's subscription login also advertises itself in anthropic-beta.
    if (headers["anthropic-beta"]) {
      const kept = String(headers["anthropic-beta"]).split(",").map((s) => s.trim()).filter((s) => s && !/^oauth-/.test(s));
      if (kept.length) headers["anthropic-beta"] = kept.join(","); else delete headers["anthropic-beta"];
    }
  }
  const forwardBeta = p.forwardBetaHeaders ?? (p.type === "anthropic");
  if (!forwardBeta) delete headers["anthropic-beta"];
  if (auth.type !== "passthrough" && auth.type !== "none") {
    const value = await credential(providerName, auth, env);
    if (auth.type === "bearer") headers["authorization"] = `Bearer ${value}`;
    else if (auth.type === "x-api-key") headers["x-api-key"] = value;
    else if (auth.type === "header") headers[auth.name.toLowerCase()] = value;
  }
  for (const [k, v] of Object.entries(p.headers || {})) headers[k.toLowerCase()] = v;
  headers["accept-encoding"] = "identity";

  let url, out = body;
  if (p.type === "vertex") {
    const isMessages = /^\/v1\/messages(\?|$)/.test(pathname);
    if (!isMessages) throw new Error(`Vertex provider "${providerName}" only supports /v1/messages`);
    out = { ...body };
    const model = out.model;
    delete out.model;
    out.anthropic_version = p.anthropicVersion || "vertex-2023-10-16";
    const host = p.baseUrl || (p.region === "global" ? "https://aiplatform.googleapis.com" : `https://${p.region}-aiplatform.googleapis.com`);
    const verb = body?.stream ? "streamRawPredict" : "rawPredict";
    url = `${host.replace(/\/$/, "")}/v1/projects/${encodeURIComponent(p.projectId)}/locations/${encodeURIComponent(p.region)}` +
          `/publishers/anthropic/models/${encodeURIComponent(model)}:${verb}`;
  } else {
    const base = p.baseUrl.replace(/\/$/, "");
    const route = p.path && p.path !== "/v1/messages" ? pathname.replace(/^\/v1\/messages/, p.path) : pathname;
    url = base + route;
  }
  const text = out === undefined ? undefined : typeof out === "string" ? out : JSON.stringify(out);
  if (text !== undefined) headers["content-length"] = Buffer.byteLength(text);
  if (text !== undefined && !headers["content-type"]) headers["content-type"] = "application/json";
  return { url, headers, body: text };
}
