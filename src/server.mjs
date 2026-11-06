// The proxy: classify -> cost check -> pick provider -> send (with failover) -> account.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TIERS, loadConfig, validateConfig, configPath, activeOrder } from "./config.mjs";
import { inspect, sessionSalt, heuristic, OVERRIDE_RE, LLM_SYSTEM, stripOverrides, stripThinking, tierOf, sha } from "./classify.mjs";
import { chooseTier, priceTable, costOf, turnCost } from "./cost.mjs";
import { buildRequest, providerModel, forgetCredential, LOCAL_KEY_HEADER } from "./providers.mjs";
import { send, readAll, Breaker, NetworkError, TooLargeError } from "./upstream.mjs";
import { Stats, summarize } from "./stats.mjs";
import { ensureSecret, secureHome, PRIVATE, VERSION } from "./util.mjs";
import { handleUi } from "./ui-server.mjs";
import { allowedTiers, perfSummary, localPermitted } from "./limits.mjs";

export { allowedTiers, perfSummary, localPermitted };
import { Policy, defaultPolicyPaths, credentialKind, subscriptionAllowed, SUBSCRIPTION_REFUSED } from "./policy.mjs";

const tierIdx = (t) => TIERS.indexOf(t);

export function createRouter({ cfg, home, env = process.env, logToStderr = false, policyPaths } = {}) {
  secureHome(home);
  const ctx = {
    cfg, home, env,
    breaker: new Breaker(activeOrder(cfg), cfg.failover.cooldownSeconds),
    perf: { local: [], claude: [], skipped: 0 }, // measured response times on easy tasks
    convs: new Map(),
    llmCache: new Map(),
    stats: new Stats(home, { keepDays: cfg.limits.statsDays }),
    state: {},
    recent: [],          // last decisions for the dashboard (no prompt text)
    sessions: new Map(), // dashboard sessions
    policy: new Policy(policyPaths || defaultPolicyPaths(env)),
    credential: null,    // kind of login Claude Code used most recently
    localKey: cfg.requireLocalKey ? ensureSecret(home) : null,
    logWrites: 0,
    log(...a) {
      const line = `[${new Date().toISOString()}] ${a.join(" ")}\n`;
      const file = path.join(home, "router.log");
      try {
        if (ctx.logWrites++ % 100 === 0) rotateIfLarge(file, ctx.cfg.limits.logMB);
        fs.appendFileSync(file, line, PRIVATE);
      } catch {}
      if (logToStderr) process.stderr.write(line);
    },
    writeState(s = {}) {
      ctx.state = { ...ctx.state, ...s };
      const snapshot = { ...ctx.state, paused: !!ctx.cfg.paused, shadow: !!ctx.cfg.shadow && !ctx.cfg.paused, today: ctx.stats.totals, primary: activeOrder(ctx.cfg)[0], providers: ctx.breaker.status() };
      try { fs.writeFileSync(path.join(home, "state.json"), JSON.stringify(snapshot), PRIVATE); } catch {}
    },
  };

  const server = http.createServer((req, res) => handle(ctx, req, res).catch((e) => {
    ctx.log("handler crash:", e.stack);
    try { ctx.stats.record({ kind: "error", where: "router" }); } catch {}
    if (!res.headersSent) jsonError(res, 500, "api_error", "claude-autoroute internal error: " + e.message);
    else res.destroy();
  }));
  server.ctx = ctx;
  ctx.reload = (next) => server.reload(next);
  server.reload = (next) => {
    const sameOrder = JSON.stringify(activeOrder(next)) === JSON.stringify(activeOrder(ctx.cfg));
    ctx.cfg = next;
    if (!sameOrder || next.failover.cooldownSeconds !== ctx.breaker.cooldownMs / 1000) {
      ctx.breaker = new Breaker(activeOrder(next), next.failover.cooldownSeconds);
    }
    for (const name of Object.keys(next.providers)) forgetCredential(name);
  };
  return server;
}

export function watchConfig(server, home, env) {
  const p = configPath(home);
  fs.watchFile(p, { interval: 2000 }, () => {
    try {
      const next = loadConfig(home, env);
      const errors = validateConfig(next);
      if (errors.length) return server.ctx.log("config change ignored, invalid:", errors.join("; "));
      server.reload(next);
      server.ctx.log("config reloaded");
    } catch (e) { server.ctx.log("config change ignored:", e.message); }
  });
}

// Keep one previous log (router.log.1) once the current one passes maxMB.
export function rotateIfLarge(file, maxMB) {
  try {
    if (fs.statSync(file).size > maxMB * 1024 * 1024) fs.renameSync(file, file + ".1");
  } catch {}
}

function sameSecret(given, expected) {
  const a = Buffer.from(String(given || "")), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function jsonError(res, status, type, message) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

// ------------------------------------------------------------ conversations ---
function conv(ctx, key) {
  let c = ctx.convs.get(key);
  if (!c) {
    c = { current: null, promptKey: null, decision: null, lastUsed: {}, lastPromptTokens: 0, lastChars: 0, streak: 0, lastSent: null, ttl1h: false };
    ctx.convs.set(key, c);
    if (ctx.convs.size > 300) ctx.convs.delete(ctx.convs.keys().next().value);
  }
  return c;
}

// Speed guard: compare measured response times of the local model and Claude on the
// same kind of (easy) task. Re-check the local model every 10th skipped message.
function speedCheck(ctx) {
  const max = ctx.cfg.local.maxSlowdown;
  const { localAvgMs: l, claudeAvgMs: c, localSamples, claudeSamples } = perfSummary(ctx);
  if (!max || localSamples < 5 || claudeSamples < 5) return { tooSlow: false, note: "" };
  const ratio = l / c;
  if (ratio <= max) return { tooSlow: false, note: "" };
  ctx.perf.skipped++;
  if (ctx.perf.skipped % 10 === 0) return { tooSlow: false, note: "re-checking local model speed" };
  return { tooSlow: true, note: `kept on Claude: local model is ${ratio.toFixed(1)}x slower (limit ${max}x)` };
}
function recordPerf(ctx, d, out, ms) {
  const L = ctx.cfg.local;
  if (!L?.useFor?.includes(d.wanted)) return;
  const bucket = out.local ? ctx.perf.local : out.tier === d.wanted ? ctx.perf.claude : null;
  if (!bucket) return;
  bucket.push(ms);
  if (bucket.length > 20) bucket.shift();
}


// Claude-only request fields and history that local servers don't understand.
const CLAUDE_ONLY_FIELDS = ["metadata", "tool_choice", "thinking", "context_management", "output_config", "mcp_servers", "container", "betas", "service_tier"];
function forLocal(body) {
  for (const f of CLAUDE_ONLY_FIELDS) delete body[f];
  stripThinking(body.messages || []);
  return body;
}


async function classify(ctx, latest, headers) {
  const { cfg } = ctx;
  if (cfg.classifier.type !== "llm" || !allowedTiers(ctx).includes("haiku")) return heuristic(latest, cfg);
  const key = sha(latest);
  if (ctx.llmCache.has(key)) return ctx.llmCache.get(key);
  try {
    const body = { model: cfg.models.haiku, max_tokens: 5, system: LLM_SYSTEM, messages: [{ role: "user", content: latest.slice(0, 6000) }] };
    const out = await dispatch(ctx, { pathname: "/v1/messages", method: "POST", json: body, headers, tier: "haiku" });
    if (out.error) throw new Error(`HTTP ${out.error.status}`);
    const json = JSON.parse((await readAll(out.res)).toString());
    ctx.stats.record({ kind: "classifier", provider: out.provider, actual: costOf(priceTable(cfg, "haiku", out.provider), json.usage), baseline: 0 });
    const word = (json.content?.[0]?.text || "").toLowerCase();
    const tier = TIERS.find((t) => word.includes(t));
    if (!tier) throw new Error("unexpected classifier reply: " + word);
    const d = { tier, reason: "llm classifier", score: null };
    ctx.llmCache.set(key, d);
    if (ctx.llmCache.size > 1000) ctx.llmCache.delete(ctx.llmCache.keys().next().value);
    return d;
  } catch (e) {
    ctx.log("llm classifier failed, using heuristic:", e.message);
    return heuristic(latest, cfg);
  }
}

async function decide(ctx, body, headers) {
  const { cfg } = ctx;
  const msgs = body.messages || [];
  const { latest, latestIdx, convKey } = inspect(msgs, sessionSalt(body, headers));
  const c = conv(ctx, convKey);
  const now = Date.now();
  const chars = JSON.stringify([body.system, body.tools, msgs]).length;
  const T = c.lastPromptTokens && chars >= c.lastChars ? c.lastPromptTokens + Math.round((chars - c.lastChars) / 4) : Math.round(chars / 4);
  if (/"ttl"\s*:\s*"1h"/.test(JSON.stringify(body.system || "")) || /"ttl"\s*:\s*"1h"/.test(JSON.stringify(msgs.slice(-2)))) c.ttl1h = true;
  const base = { convKey, c, T, chars };

  // Same typed message as the previous request = Claude's tool loop: keep the turn on one model.
  const promptKey = sha(latest) + ":" + latestIdx;
  if (c.promptKey === promptKey && c.decision) return { ...c.decision, ...base, sameTurn: true };

  let d, forced = false;
  const ov = latest.match(OVERRIDE_RE);
  if (ov) { d = { tier: ov[2].toLowerCase(), reason: `you asked for !${ov[2].toLowerCase()}` }; forced = true; }
  else if (!latest) d = { tier: c.current || "sonnet", reason: "no new prompt" };
  else if (cfg._re.follow.test(latest) && c.current) d = { tier: c.current, reason: "follow-up keeps model" };
  else d = await classify(ctx, latest, headers);

  if (!forced && T > cfg.switching.bigContextTokens && tierIdx(d.tier) < tierIdx(cfg.switching.bigContextMinTier)) {
    d = { ...d, tier: cfg.switching.bigContextMinTier, reason: d.reason + "; large context" };
  }
  c.streak = c.current && tierIdx(d.tier) < tierIdx(c.current) ? c.streak + 1 : 0;

  const provider = ctx.breaker.active();
  const ttlMs = (c.ttl1h ? 3600 : 300) * 1000 * 0.9;
  const isWarm = (tier) => now - (c.lastUsed[`${provider}|${providerModel(cfg, provider, tier).model}`] || 0) < ttlMs;
  const pick = chooseTier(cfg, { desired: d.tier, current: c.current, T, isWarm, provider, ttl1h: c.ttl1h, streak: c.streak, forced });

  // Never route outside what your organization (or your config) allows. The model
  // Claude Code asked for has already passed Claude Code's own checks, so fall back to it.
  const allowed = allowedTiers(ctx);
  const requested = tierOf(body.model);
  if (!allowed.includes(pick.tier) && requested) {
    const src = ctx.policy.available().source || "your autoroute allowedTiers";
    pick.note = `${pick.tier} isn't allowed by ${src}; kept ${requested}`;
    pick.tier = requested;
  }
  // Optional free local model for easy tasks. Worth it unless leaving Claude would
  // throw away a warm Claude cache that costs more to rebuild than this turn saves.
  let local = false;
  const L = cfg.local;
  if (L?.enabled && !forced && L.useFor.includes(d.tier) && T <= L.maxContextTokens) {
    if (!localPermitted(ctx)) pick.note = [pick.note, "local model not on your organization's allowed list"].filter(Boolean).join("; ");
    else {
      const stay = turnCost(cfg, pick.tier, provider, T, isWarm(pick.tier), c.ttl1h);
      const back = c.claudeTier && isWarm(c.claudeTier) ? turnCost(cfg, c.claudeTier, provider, T, true, c.ttl1h) : null;
      const comeBack = back ? cfg.switching.returnProbability * T * (back.r.write - back.r.read) : 0;
      const turns = Math.min(Math.max(c.streak, 1), cfg.switching.maxStreakTurns);
      const speed = speedCheck(ctx);
      if (speed.tooSlow) pick.note = [pick.note, speed.note].filter(Boolean).join("; ");
      else if (!stay || stay.total * turns > comeBack) { local = true; pick.note = [pick.note, `free on your local model (${L.model})`, speed.note].filter(Boolean).join("; "); }
      else pick.note = [pick.note, "kept on Claude: leaving would cost a cache rebuild"].filter(Boolean).join("; ");
    }
  }
  // "Regret": you overrode upward right after the router picked something cheaper than
  // you asked for. The best signal we have that a cheaper model wasn't good enough.
  const prev = c.decision;
  const regret = !!(!cfg.shadow && forced && prev && !prev.forced && (prev.local || tierIdx(prev.tier) < tierIdx(prev.requested))
    && (prev.local || tierIdx(d.tier) > tierIdx(prev.tier)));
  const decision = { tier: pick.tier, wanted: d.tier, reason: [d.reason, pick.note].filter(Boolean).join("; "), latest, local, forced, requested, regret };
  c.promptKey = promptKey;
  c.decision = decision;
  return { ...decision, ...base, sameTurn: false };
}

// ---------------------------------------------------------------- sending ---
const isFailoverStatus = (cfg, s) => cfg.failover.onStatus.includes(s) || (s === 429 && cfg.failover.onRateLimit);

/**
 * Try providers in breaker order. Returns { res, provider, model, tier, failover }
 * on success, or { error: { status, headers, body } } when every provider failed.
 */
async function dispatch(ctx, { pathname, method, json, raw, headers, tier, originalTier, local = false }) {
  const { cfg, breaker } = ctx;
  const primary = activeOrder(cfg)[0];
  const isMessages = /^\/v1\/messages(\?|$)/.test(pathname);
  let candidates = breaker.candidates();
  if (local) candidates = [cfg.local.provider];
  else if (!isMessages) candidates = [primary];        // count_tokens etc. only go to the primary
  else if (!tier) candidates = candidates.filter((p) => p === primary); // unknown model: can't map it
  if (!candidates.length) candidates = [primary];
  let lastErr = null;

  for (const p of candidates) {
    let useTier = tier;
    let body = json ? structuredClone(json) : undefined;
    let mapped = null;
    if (body && local) { body.model = cfg.local.model; forLocal(body); }
    else if (body && tier) { mapped = providerModel(cfg, p, tier); body.model = mapped.model; useTier = mapped.tier; }
    const retried = { thinking: false, original: false };

    for (;;) {
      let reqSpec;
      try {
        reqSpec = await buildRequest(cfg, p, { pathname, body: body ?? (raw?.length ? raw.toString() : undefined), clientHeaders: headers, env: ctx.env });
      } catch (e) {
        ctx.log(`provider ${p} skipped: ${e.message}`);
        breaker.fail(p, e.message);
        lastErr = { status: 502, headers: {}, body: Buffer.from(JSON.stringify({ type: "error", error: { type: "api_error", message: `claude-autoroute: ${e.message}` } })) };
        break;
      }
      let res;
      try {
        res = await send({ ...reqSpec, method }, cfg.failover);
      } catch (e) {
        if (!(e instanceof NetworkError)) throw e;
        ctx.log(`provider ${p} unreachable: ${e.message}`);
        lastErr = { status: 502, headers: {}, body: Buffer.from(JSON.stringify({ type: "error", error: { type: "api_error", message: `claude-autoroute: ${p}: ${e.message}` } })) };
        if (cfg.failover.onNetworkError) { breaker.fail(p, e.message); break; }
        return { error: lastErr };
      }

      if (isFailoverStatus(cfg, res.statusCode)) {
        const errBody = await readAll(res);
        ctx.log(`provider ${p} returned ${res.statusCode}${candidates.length > 1 ? ", failing over" : ""}: ${errBody.toString().slice(0, 160)}`);
        breaker.fail(p, `HTTP ${res.statusCode}`);
        lastErr = { status: res.statusCode, headers: res.headers, body: errBody };
        break;
      }
      if ((res.statusCode === 401 || res.statusCode === 403) && cfg.providers[p].auth?.command) forgetCredential(p);

      if (local && res.statusCode >= 400) {
        const errBody = await readAll(res);
        return { error: { status: res.statusCode, headers: res.headers, body: errBody } };
      }
      if (res.statusCode === 400 && body) {
        const errText = (await readAll(res)).toString();
        if (!retried.thinking && /thinking|signature/i.test(errText)) {
          retried.thinking = true; stripThinking(body.messages || []);
          ctx.log(`retry on ${p}: stripped old thinking blocks`);
          continue;
        }
        if (!retried.original && originalTier && useTier !== originalTier) {
          retried.original = true;
          mapped = providerModel(cfg, p, originalTier); body.model = mapped.model; useTier = mapped.tier;
          ctx.log(`retry on ${p}: routed model rejected request (${errText.slice(0, 120)}), using ${body.model}`);
          ctx.writeState({ tier: useTier, reason: "routed model rejected request; used original", ts: Date.now() });
          continue;
        }
        return { error: { status: 400, headers: res.headers, body: Buffer.from(errText) } };
      }
      if (res.statusCode < 500) breaker.ok(p);
      return { res, provider: p, model: body?.model, tier: useTier, failover: !local && p !== primary, local };
    }
  }
  return { error: lastErr || { status: 502, headers: {}, body: Buffer.from('{"type":"error","error":{"type":"api_error","message":"claude-autoroute: no provider available"}}') } };
}

// Read usage from the response stream as it passes through.
function tapUsage(res, done) {
  const isSSE = /event-stream/.test(res.headers["content-type"] || "");
  let buf = "", usage = null;
  const whole = [];
  res.on("data", (chunk) => {
    if (!isSSE) { whole.push(chunk); return; }
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.startsWith("data:") || !line.includes("usage")) continue;
      try {
        const ev = JSON.parse(line.slice(5));
        if (ev.type === "message_start" && ev.message?.usage) usage = { ...ev.message.usage };
        else if (ev.type === "message_delta" && ev.usage) usage = { ...(usage || {}), ...ev.usage };
      } catch {}
    }
  });
  res.on("end", () => {
    if (!isSSE) { try { usage = JSON.parse(Buffer.concat(whole).toString()).usage || null; } catch {} }
    done(usage);
  });
}

// ----------------------------------------------------------------- handler ---
async function handle(ctx, req, res) {
  const { cfg } = ctx;
  if (req.url === "/ui" || req.url.startsWith("/ui/") || req.url.startsWith("/ui?")) return handleUi(ctx, req, res);
  // Minimal liveness check, open to local programs (used to see if the router is running).
  if (req.url === "/__autoroute/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, version: VERSION, pid: process.pid }));
  }
  // Read-only status for status lines, tmux, menu-bar widgets and scripts. Needs the local key.
  if (req.url === "/__autoroute/status" && req.method === "GET") {
    if (!ctx.localKey || !sameSecret(req.headers[LOCAL_KEY_HEADER], ctx.localKey)) {
      return jsonError(res, 401, "authentication_error", "claude-autoroute: send the x-autoroute-key header (its value is in ~/.claude-autoroute/local-key)");
    }
    const st = ctx.state;
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({
      version: VERSION, paused: !!cfg.paused, shadow: !!cfg.shadow, priority: cfg.priority,
      classifier: cfg.classifier.type, switching: cfg.switching.mode,
      last: st.ts ? { tier: st.tier, wanted: st.wanted, provider: st.provider, local: !!st.local, failover: !!st.failover, model: st.model, reason: st.reason, at: new Date(st.ts).toISOString() } : null,
      today: ctx.stats.totals, lifetime: summarize(ctx.stats.lifetime),
      providers: ctx.breaker.status(), local: { enabled: !!cfg.local?.enabled, model: cfg.local?.model, ...perfSummary(ctx) },
      messagesSeen: ctx.messagesSeen || 0, loginType: ctx.credential, blocked: ctx.state.blocked || null, subscriptionLogin: cfg.subscriptionLogin,
    }));
  }
  if (ctx.localKey && !sameSecret(req.headers[LOCAL_KEY_HEADER], ctx.localKey)) {
    return jsonError(res, 401, "authentication_error",
      "claude-autoroute: missing or wrong local key. Start Claude Code with `claude-auto`, or set requireLocalKey to false.");
  }

  // Which login is Claude Code using? Subscription logins are refused unless allowed.
  const kind = credentialKind(req.headers);
  if (kind !== "none") ctx.credential = kind;
  if (kind === "subscription" && !subscriptionAllowed(cfg)) {
    if (ctx.state.blocked !== "subscription") { ctx.log("refused a Claude subscription login (see subscriptionLogin in the config)"); ctx.writeState({ blocked: "subscription" }); }
    req.resume();
    return jsonError(res, 403, "permission_error", SUBSCRIPTION_REFUSED);
  }
  if (ctx.state.blocked) ctx.writeState({ blocked: null });

  let raw;
  try { raw = await readAll(req, cfg.limits.maxRequestMB * 1024 * 1024); }
  catch (e) {
    if (!(e instanceof TooLargeError)) throw e;
    ctx.log(`refused a request over limits.maxRequestMB (${cfg.limits.maxRequestMB} MB)`);
    res.setHeader("connection", "close");
    return jsonError(res, 413, "request_too_large", `claude-autoroute: request is larger than limits.maxRequestMB (${cfg.limits.maxRequestMB} MB)`);
  }
  const t0 = Date.now();
  const pathname = req.url;
  const isMessages = req.method === "POST" && /^\/v1\/messages(\?|$)/.test(pathname);
  let json = null, d = null, tier = null, originalTier = null;

  if (isMessages) {
    ctx.messagesSeen = (ctx.messagesSeen || 0) + 1;
    try { json = JSON.parse(raw.toString()); } catch { return jsonError(res, 400, "invalid_request_error", "claude-autoroute: request body is not JSON"); }
    originalTier = tierOf(json.model);
    tier = originalTier;
    const background = !Array.isArray(json.tools) || json.tools.length === 0 || (cfg._re.background && cfg._re.background.test(json.model || ""));
    if (cfg.paused) {
      if (!ctx.state.paused) ctx.writeState({ paused: true });
    } else if (originalTier && !background) {
      try {
        d = await decide(ctx, json, req.headers);
        // Shadow mode: keep Claude Code's own model and only record what routing would have
        // done. Typed overrides (!opus etc.) are your explicit choice, so they still apply.
        d.shadow = !!cfg.shadow && !d.forced;
        tier = d.shadow ? originalTier : d.tier;
        stripOverrides(json.messages || []);
      } catch (e) { ctx.log("routing error, using requested model:", e.message); d = null; }
    }
    if (!cfg.paused && ctx.state.shadow !== !!cfg.shadow) ctx.writeState({ shadow: !!cfg.shadow });
  }

  const overheadMs = Date.now() - t0; // time spent deciding (classification + cost check)
  const tSend = Date.now();
  let out = null;
  if (d?.local && !d.shadow) {
    out = await dispatch(ctx, { pathname, method: req.method, json, raw, headers: req.headers, tier, originalTier, local: true }).catch((e) => ({ error: { status: 502, headers: {}, body: Buffer.from(e.message) } }));
    if (out.error) {
      ctx.log(`local model failed (HTTP ${out.error.status}: ${out.error.body.toString().slice(0, 120)})${cfg.local.fallbackToClaude ? ", using Claude for this turn" : ""}`);
      if (d.c.decision) { d.c.decision.local = false; d.c.decision.reason += "; local model failed, used Claude"; }
      d.local = false; d.reason += "; local model failed, used Claude";
      if (cfg.local.fallbackToClaude) out = null;
    }
  }
  if (!out) out = await dispatch(ctx, { pathname, method: req.method, json, raw, headers: req.headers, tier, originalTier });

  if (out.error) {
    const h = { ...out.error.headers };
    for (const k of ["content-length", "transfer-encoding", "connection"]) delete h[k];
    res.writeHead(out.error.status, h);
    return res.end(out.error.body);
  }

  const up = out.res;
  if (d) {
    // In shadow mode the conversation follows the model routing WOULD have used, so later
    // decisions (and the would-have-cost) see the cache state they would really have had.
    const eff = d.shadow
      ? { tier: d.tier, local: !!d.local, model: d.local ? cfg.local.model : providerModel(cfg, out.provider, d.tier).model, provider: d.local ? cfg.local.provider : out.provider }
      : { tier: out.tier, local: !!out.local, model: out.model, provider: out.provider };
    const key = `${eff.provider}|${eff.model}`;
    const cacheMiss = !!d.c.lastSent && d.c.lastSent !== key;
    d.c.lastSent = key;
    d.c.lastUsed[key] = Date.now();
    d.c.current = eff.tier;
    if (!eff.local) d.c.claudeTier = eff.tier;
    if (!d.sameTurn && d.latest) {
      const tag = d.shadow ? `shadow: kept ${out.tier}, would use ${eff.local ? "local " + eff.model : eff.tier}`
        : out.local ? `local ${out.model}` : out.tier !== d.wanted ? `${out.tier} (wanted ${d.wanted})` : out.tier;
      const snippet = cfg.logPromptSnippets ? ` <- "${d.latest.slice(0, 60).replace(/\s+/g, " ")}"` : "";
      ctx.log(`${tag}${out.failover ? ` via ${out.provider}` : ""}${snippet} ~${Math.round(d.T / 1000)}k tok (${d.reason})`);
      ctx.writeState({ tier: out.tier, wanted: d.wanted, provider: out.provider, failover: out.failover, local: !!out.local, model: out.model, reason: d.reason, ts: Date.now(),
                       shadow: d.shadow, wouldTier: d.shadow ? (eff.local ? "local" : eff.tier) : null });
      d.c.entry = { ts: Date.now(), tier: out.tier, wanted: d.wanted, provider: out.provider, failover: out.failover, local: !!out.local, model: out.model,
                    reason: d.reason, tokens: d.T, actual: 0, baseline: 0, requests: 0, shadow: d.shadow, wouldTier: d.shadow ? (eff.local ? "local" : eff.tier) : null };
      ctx.recent.push(d.c.entry);
      if (ctx.recent.length > 200) ctx.recent.shift();
    } else if (out.failover !== ctx.state.failover) {
      ctx.writeState({ provider: out.provider, failover: out.failover });
    }
    if (up.statusCode === 200) {
      tapUsage(up, (u) => {
        if (!u) return;
        d.c.lastPromptTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        d.c.lastChars = d.chars;
        const table = priceTable(cfg, out.tier, out.provider);
        const baseTable = priceTable(cfg, originalTier, activeOrder(cfg)[0]);
        const actual = costOf(table, u, d.c.ttl1h), baseline = costOf(baseTable, u, d.c.ttl1h, cacheMiss);
        if (d.shadow) {
          // What this request would have cost on the model routing picked. If routing would
          // have switched, the cache reads become cache writes (a rebuild): counted, not hidden.
          const hyp = cacheMiss ? { ...u, cache_creation_input_tokens: (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), cache_read_input_tokens: 0 } : u;
          const would = eff.local ? 0 : costOf(priceTable(cfg, eff.tier, eff.provider), hyp, d.c.ttl1h);
          if (d.c.entry) { d.c.entry.actual += actual || 0; d.c.entry.baseline += actual || 0; d.c.entry.would = (d.c.entry.would || 0) + (would ?? actual ?? 0); d.c.entry.requests++; }
          ctx.stats.record({
            kind: "shadow", conv: d.convKey, tier: out.tier, wouldTier: eff.local ? "local" : eff.tier, provider: out.provider, originalTier,
            cacheMiss, newTurn: !d.sameTurn, usage: u, ms: Date.now() - tSend, overheadMs, actual, baseline: actual, would: would ?? actual,
          });
          ctx.writeState({});
          return;
        }
        recordPerf(ctx, d, out, Date.now() - tSend);
        if (d.c.entry) { d.c.entry.actual += actual || 0; d.c.entry.baseline += baseline ?? actual ?? 0; d.c.entry.requests++; }
        ctx.stats.record({
          kind: "turn", conv: d.convKey, tier: out.tier, model: out.model, provider: out.provider, failover: out.failover, local: !!out.local,
          originalTier, cacheMiss, newTurn: !d.sameTurn, regret: !d.sameTurn && !!d.regret, usage: u, table, ms: Date.now() - tSend, overheadMs,
          actual, baseline,
        });
        ctx.writeState({});
      });
    }
  } else {
    if (out.failover !== (ctx.state.failover ?? false)) ctx.writeState({ provider: out.provider, failover: out.failover });
    if (out.failover && isMessages) ctx.stats.record({ kind: "background", provider: out.provider, failover: true });
  }

  const h = { ...up.headers };
  for (const k of ["content-length", "transfer-encoding", "connection"]) delete h[k];
  if (out.model) h["x-autoroute-model"] = out.model;
  h["x-autoroute-provider"] = out.provider;
  res.writeHead(up.statusCode, h);
  res.on("close", () => { if (!up.complete) up.destroy(); });
  up.pipe(res);
}
