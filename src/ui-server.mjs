// The dashboard: static files + a small JSON API, served by the router at /ui.
//
// Security model (the dashboard can change config and store API keys, so it is locked down):
//  - You get in only through a one-time link printed/opened by `autoroute ui`
//    (token file in ~/.claude-autoroute, 0600, valid 2 minutes, single use).
//  - The session is an HttpOnly, SameSite=Strict cookie scoped to /ui.
//  - Host header must be this machine (blocks DNS-rebinding attacks).
//  - API calls need a custom header (blocks cross-site form posts) and, when they
//    change anything, a matching Origin header. No CORS headers are ever sent.
//  - Strict Content-Security-Policy; no inline scripts.
//  - API keys go into the OS keychain and are never sent back to the browser.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DEFAULTS, buildConfig, validateConfig, configPath, parseJsonc, TIERS, activeOrder } from "./config.mjs";
import { heuristic, OVERRIDE_RE } from "./classify.mjs";
import { buildRequest, providerModel, forgetCredential } from "./providers.mjs";
import { send, readAll } from "./upstream.mjs";
import { savingsData, summarize } from "./stats.mjs";
import { runChecks, installStatusline, removeStatusline, statuslineState } from "./setup.mjs";
import { backendInfo, setSecret, removeSecret, hasSecret } from "./secrets.mjs";
import { VERSION } from "./util.mjs";
import { installApp } from "./launcher.mjs";
import { subscriptionAllowed } from "./policy.mjs";
import { allowedTiers, perfSummary } from "./limits.mjs";
import { applyQuick, PRESETS, readUserConfig as readUserCfg, saveUserConfig } from "./quick.mjs";
import { collect } from "./diagnostics.mjs";

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui");
const HELP_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "HELP.md");
const STATIC = { "/ui/app.js": ["app.js", "text/javascript"], "/ui/help.js": ["help.js", "text/javascript"], "/ui/app.css": ["app.css", "text/css"], "/ui/favicon.svg": ["favicon.svg", "image/svg+xml"] };
const SESSION_MS = 12 * 3600 * 1000;
const REDACTED = "__redacted__";
const MAX_BODY = 256 * 1024;

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

// ------------------------------------------------------------- one-time links ---
export function createLoginToken(home) {
  const token = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(path.join(home, "ui-token"), JSON.stringify({ token, expires: Date.now() + 120000 }), { mode: 0o600 });
  return token;
}
function consumeLoginToken(home, given) {
  const p = path.join(home, "ui-token");
  let rec;
  try { rec = JSON.parse(fs.readFileSync(p, "utf8")); } catch { return false; }
  const a = Buffer.from(String(given || "")), b = Buffer.from(rec.token || "");
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b) && rec.expires > Date.now();
  if (ok) { try { fs.unlinkSync(p); } catch {} }
  return ok;
}

// ----------------------------------------------------------------- helpers ---
function send404(res) { res.writeHead(404, { ...SECURITY_HEADERS, "content-type": "text/plain" }); res.end("not found"); }
function json(res, status, body, extra = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json", ...extra });
  res.end(JSON.stringify(body));
}
function page(res, status, title, message) {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" });
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
    `<link rel="stylesheet" href="/ui/app.css"><main class="gate"><h1>${esc(title)}</h1><p>${esc(message)}</p></main>`);
}
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
async function body(req) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > MAX_BODY) throw Object.assign(new Error("request too large"), { status: 413 }); chunks.push(c); }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw Object.assign(new Error("invalid JSON"), { status: 400 }); }
}

function allowedHost(req) {
  const port = req.socket.localPort;
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(String(req.headers.host || "").toLowerCase());
}

// Config shown to the browser: secrets replaced, internal fields removed.
function redact(obj) {
  const o = JSON.parse(JSON.stringify(obj ?? {}));
  for (const p of Object.values(o.providers || {})) if (p?.auth?.value) p.auth.value = REDACTED;
  return o;
}
function unredact(incoming, onDisk) {
  for (const [name, p] of Object.entries(incoming.providers || {})) {
    if (p?.auth?.value === REDACTED) {
      const prev = onDisk.providers?.[name]?.auth?.value;
      if (prev) p.auth.value = prev; else delete p.auth.value;
    }
  }
  return incoming;
}
const readUserConfig = readUserCfg;
const writeUserConfig = saveUserConfig;
function keychainNames(cfg) {
  return [...new Set(Object.values(cfg.providers).map((p) => p.auth?.keychain).filter(Boolean))];
}

// --------------------------------------------------------------------- API ---
async function testProvider(ctx, name) {
  const { cfg } = ctx;
  const p = cfg.providers[name];
  if (!p) return { ok: false, message: `unknown provider "${name}"` };
  if (p.auth?.type === "passthrough") {
    return { ok: null, message: "Uses Claude Code's own login, so it's tested automatically whenever you use Claude Code." };
  }
  const started = Date.now();
  try {
    const model = name === cfg.local?.provider ? cfg.local.model : providerModel(cfg, name, "haiku").model;
    const reqSpec = await buildRequest(cfg, name, {
      pathname: "/v1/messages",
      body: { model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
      clientHeaders: { "anthropic-version": "2023-06-01", "content-type": "application/json" },
      env: ctx.env,
    });
    const res = await send({ ...reqSpec, method: "POST" }, { connectTimeoutMs: 8000, responseTimeoutMs: 30000 });
    const text = (await readAll(res)).toString();
    const ms = Date.now() - started;
    if (res.statusCode === 200) { ctx.breaker.ok(name); return { ok: true, message: `Connected to ${model} in ${ms} ms`, ms }; }
    let msg = text.slice(0, 300);
    try { const j = JSON.parse(text); msg = j.error?.message || j.message || j[0]?.error?.message || msg; } catch {}
    if (res.statusCode === 401 || res.statusCode === 403) forgetCredential(name);
    return { ok: false, status: res.statusCode, message: `HTTP ${res.statusCode}: ${msg}` };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

async function api(ctx, req, res, route) {
  const { cfg, home } = ctx;
  const method = req.method;

  if (route === "overview" && method === "GET") {
    const checks = await runChecks(home, ctx.env, { probeCredentials: false, insideRouter: true });
    const cred = ctx.credential;
    const credText = { "api-key": "Claude Code is using an API key", token: "Claude Code is using a gateway token", subscription: "Claude Code is using a Claude subscription login" }[cred];
    if (!cred) checks.unshift({ level: "info", text: "Login type: checked when Claude Code first connects" });
    else if (cred === "subscription" && !subscriptionAllowed(cfg)) checks.unshift({ level: "fail", text: credText + ", which autoroute can't carry", fix: "Use an API key, Bedrock or Vertex. Team/Enterprise with admin approval: set subscriptionLogin to allow-team-enterprise", help: "claude-code-says-the-router-cant-carry-a-subscription-login" });
    else checks.unshift({ level: "ok", text: credText + (cred === "subscription" ? " (allowed as Team/Enterprise with admin approval)" : "") });
    const av = ctx.policy.available();
    const tiers = allowedTiers(ctx);
    checks.splice(1, 0, av.list || tiers.length < 3
      ? { level: "ok", text: `Model restrictions honored: routing only to ${tiers.join(", ")}`, fix: av.source ? `from ${av.source}` : "from your autoroute allowedTiers" }
      : { level: "ok", text: "No model restrictions set" });
    for (const c of checks) {
      if (!c.help && /secure key storage/i.test(c.text)) c.help = "keys-cant-be-saved-on-linux";
      if (!c.help && /status line/i.test(c.text) && c.level !== "ok") c.help = /different status line/i.test(c.text) ? "i-already-have-my-own-status-line-can-i-keep-it" : "what-does-the-status-line-show";
    }
    return json(res, 200, {
      version: VERSION, uptimeSeconds: Math.round(process.uptime()), platform: process.platform,
      classifier: cfg.classifier.type, switching: cfg.switching.mode, primary: cfg.failover.order[0],
      providers: ctx.breaker.status().map((s) => ({ ...s, type: cfg.providers[s.provider]?.type, auth: cfg.providers[s.provider]?.auth?.type })),
      paused: !!cfg.paused, shadow: !!cfg.shadow, priority: cfg.priority, presets: Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, { label: v.label, description: v.description }])),
      local: { configured: !!cfg.providers[cfg.local?.provider], enabled: !!cfg.local?.enabled, model: cfg.local?.model, maxSlowdown: cfg.local?.maxSlowdown, ...perfSummary(ctx) },
      providerList: cfg.failover.order.map((n) => ({ name: n, enabled: cfg.providers[n]?.enabled !== false, active: activeOrder(cfg).includes(n) })),
      today: ctx.stats.totals, lifetime: summarize(ctx.stats.lifetime), recent: ctx.recent.slice(-50).reverse(), checks, statusline: statuslineState(ctx.env),
    });
  }
  if (route === "savings" && method === "GET") {
    const days = Math.min(Math.max(Number(new URL(req.url, "http://x").searchParams.get("days")) || 7, 1), 90);
    return json(res, 200, savingsData(home, days));
  }
  if (route === "config" && method === "GET") {
    const { path: p, user, hasComments } = readUserConfig(home);
    return json(res, 200, { path: p, hasComments, user: redact(user), effective: redact(cfg), defaults: DEFAULTS, tiers: TIERS });
  }
  if (route === "config" && method === "PUT") {
    const { config } = await body(req);
    if (!config || typeof config !== "object" || Array.isArray(config)) return json(res, 400, { error: "expected { config: {...} }" });
    const onDisk = readUserConfig(home).user;
    const user = unredact(config, onDisk);
    let next;
    try { next = buildConfig(user, ctx.env); } catch (e) { return json(res, 422, { errors: [e.message] }); }
    const errors = validateConfig(next);
    if (errors.length) return json(res, 422, { errors });
    writeUserConfig(home, user);
    const restart = next.port !== cfg.port || next.host !== cfg.host;
    ctx.reload(next);
    ctx.log("config saved from dashboard");
    return json(res, 200, { ok: true, restartNeeded: restart });
  }
  if (route === "quick" && method === "POST") {
    const action = await body(req);
    const next = applyQuick(readUserConfig(home).user, cfg, action);
    let built;
    try { built = buildConfig(next, ctx.env); } catch (e) { return json(res, 422, { errors: [e.message] }); }
    const errors = validateConfig(built);
    if (errors.length) return json(res, 422, { errors });
    writeUserConfig(home, next);
    ctx.reload(built);
    ctx.writeState({ paused: !!built.paused, shadow: !!built.shadow });
    ctx.log(`quick setting: ${action.type}${action.name ? " " + action.name : ""}${"value" in action ? " " + action.value : ""}`);
    return json(res, 200, { ok: true });
  }
  if (route === "explain" && method === "POST") {
    const { text } = await body(req);
    const t = String(text || "").slice(0, 20000);
    const ov = t.match(OVERRIDE_RE);
    const d = ov ? { tier: ov[2].toLowerCase(), reason: "override tag", score: null } : heuristic(t, cfg);
    return json(res, 200, { ...d, model: cfg.models[d.tier] });
  }
  if (route === "providers/test" && method === "POST") {
    const { name } = await body(req);
    return json(res, 200, await testProvider(ctx, String(name || "")));
  }
  if (route === "providers/reset" && method === "POST") {
    const { name } = await body(req);
    ctx.breaker.ok(String(name || ""));
    ctx.writeState({});
    return json(res, 200, { ok: true });
  }
  if (route === "keys" && method === "GET") {
    const names = keychainNames(cfg);
    const keys = {};
    for (const n of names) keys[n] = await hasSecret(n);
    return json(res, 200, { backend: backendInfo(), keys });
  }
  if (route === "keys" && method === "POST") {
    const { name, value } = await body(req);
    await setSecret(String(name || ""), String(value || ""));
    for (const [pname, p] of Object.entries(cfg.providers)) if (p.auth?.keychain === name) forgetCredential(pname);
    ctx.log(`API key "${name}" saved to the keychain from the dashboard`);
    return json(res, 200, { ok: true });
  }
  if (route === "keys" && method === "DELETE") {
    const { name } = await body(req);
    await removeSecret(String(name || ""));
    for (const [pname, p] of Object.entries(cfg.providers)) if (p.auth?.keychain === name) forgetCredential(pname);
    return json(res, 200, { ok: true });
  }
  if (route === "app" && method === "POST") {
    const { dock } = await body(req);
    return json(res, 200, installApp({ home, env: ctx.env, dock: !!dock, reveal: true }));
  }
  if (route === "diagnostics" && method === "GET") {
    return json(res, 200, await collect({ home, cfg, env: ctx.env, live: {
      credential: ctx.credential, health: ctx.breaker.status(), lifetime: summarize(ctx.stats.lifetime), policyPaths: ctx.policy.paths,
    } }));
  }
  if (route === "statusline" && method === "POST") {
    const { action } = await body(req);
    return json(res, 200, action === "remove" ? removeStatusline(ctx.env) : installStatusline(ctx.env));
  }
  return json(res, 404, { error: "unknown endpoint" });
}

// ----------------------------------------------------------------- handler ---
export async function handleUi(ctx, req, res) {
  if (!allowedHost(req)) return page(res, 421, "Not available", "The dashboard only answers on this machine (127.0.0.1 or localhost).");
  const url = new URL(req.url, "http://localhost");

  if ((url.pathname === "/ui/llms-full.txt" || url.pathname === "/ui/llms.txt") && req.method === "GET") {
    res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" });
    return res.end(fs.readFileSync(path.join(path.dirname(HELP_FILE), url.pathname.slice(4))));
  }
  if (url.pathname === "/ui/help.md" && req.method === "GET") {
    res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/markdown; charset=utf-8" });
    return res.end(fs.readFileSync(HELP_FILE));
  }
  if (STATIC[url.pathname] && req.method === "GET") {
    const [file, type] = STATIC[url.pathname];
    res.writeHead(200, { ...SECURITY_HEADERS, "content-type": `${type}; charset=utf-8` });
    return res.end(fs.readFileSync(path.join(UI_DIR, file)));
  }

  if (url.pathname === "/ui/login" && req.method === "GET") {
    if (!consumeLoginToken(ctx.home, url.searchParams.get("t"))) {
      return page(res, 403, "This link has expired", "Dashboard links work once, for two minutes. Run `autoroute ui` again to get a new one.");
    }
    const id = crypto.randomBytes(32).toString("hex");
    ctx.sessions.set(id, Date.now() + SESSION_MS);
    res.writeHead(303, { ...SECURITY_HEADERS, location: "/ui/", "set-cookie": `autoroute_ui=${id}; HttpOnly; SameSite=Strict; Path=/ui; Max-Age=${SESSION_MS / 1000}` });
    return res.end();
  }

  const sid = cookies(req).autoroute_ui;
  const exp = sid && ctx.sessions.get(sid);
  const valid = exp && exp > Date.now();
  if (valid) ctx.sessions.set(sid, Date.now() + SESSION_MS);

  if ((url.pathname === "/ui" || url.pathname === "/ui/") && req.method === "GET") {
    if (!valid) return page(res, 401, "Open the dashboard with autoroute ui", "For your security the dashboard opens only through a one-time link. In a terminal, run: autoroute ui");
    res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(path.join(UI_DIR, "index.html")));
  }

  if (url.pathname.startsWith("/ui/api/")) {
    if (!valid) return json(res, 401, { error: "session expired: run `autoroute ui` again" });
    if (req.headers["x-autoroute-ui"] !== "1") return json(res, 403, { error: "missing dashboard header" });
    if (req.method !== "GET") {
      const origin = req.headers.origin;
      if (!origin || origin.toLowerCase() !== `http://${String(req.headers.host).toLowerCase()}`) return json(res, 403, { error: "cross-origin request refused" });
    }
    try { return await api(ctx, req, res, url.pathname.slice("/ui/api/".length)); }
    catch (e) { return json(res, e.status || 400, { error: e.message }); }
  }
  return send404(res);
}
