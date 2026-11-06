// A support snapshot that is safe to paste into a public bug report.
// Contains versions, settings and health. Never: keys, prompts, URLs, emails,
// usernames or home-folder paths.
import os from "node:os";
import { VERSION } from "./util.mjs";
import { runChecks } from "./setup.mjs";
import { readAvailableModels, defaultPolicyPaths } from "./policy.mjs";

export function scrub(text, env = process.env, extraPaths = []) {
  let t = String(text ?? "");
  for (const p of extraPaths.filter((x) => x && x.length > 1)) t = t.split(p).join("<autoroute folder>");
  for (const h of [env.HOME, os.homedir()].filter((x) => x && x.length > 1)) t = t.split(h).join("~");
  t = t.replace(/(\/Users\/|\/home\/)[^/\s"']+/g, "~");
  t = t.replace(/\bhttps?:\/\/[^\s"')]+/g, "[url]");
  t = t.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email]");
  t = t.replace(/\b(sk-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{8,}|AIza[0-9A-Za-z_-]{10,}|ya29\.[0-9A-Za-z_-]+)/g, "[secret]");
  return t;
}

function providerKind(p) {
  if (p.type === "vertex") return "vertex";
  const u = String(p.baseUrl || "");
  if (/api\.anthropic\.com/.test(u)) return "anthropic";
  if (/bedrock/.test(u)) return "bedrock";
  if (/^https?:\/\/(127\.0\.0\.1|localhost)/.test(u)) return "local gateway";
  return "custom gateway";
}

export async function collect({ home, cfg, env = process.env, live = null }) {
  const checks = await runChecks(home, env, { probeCredentials: false, insideRouter: !!live });
  // Provider names are user-chosen (they could name a company), so swap them for positions.
  const label = new Map(cfg.failover.order.map((n, i) => [n, i === 0 ? "primary" : `backup ${i}`]));
  for (const n of Object.keys(cfg.providers)) if (!label.has(n)) label.set(n, "unused provider");
  const anon = (t) => { let out = t; for (const [n, l] of label) out = out.split(`${n}:`).join(`${l}:`).split(`"${n}"`).join(`"${l}"`); return out; };
  const av = readAvailableModels(live?.policyPaths || defaultPolicyPaths(env));
  const d = {
    autoroute: VERSION,
    node: process.versions.node,
    platform: `${process.platform} ${os.release()} ${process.arch}`,
    settings: {
      classifier: cfg.classifier.type,
      switching: cfg.switching.mode,
      subscriptionLogin: cfg.subscriptionLogin,
      allowedTiers: cfg.allowedTiers,
      requireLocalKey: cfg.requireLocalKey,
      customPrices: JSON.stringify(cfg.prices) !== JSON.stringify((await import("./config.mjs")).DEFAULTS.prices),
      failover: { order: cfg.failover.order.map((_, i) => (i === 0 ? "primary" : `backup ${i}`)), onRateLimit: cfg.failover.onRateLimit, cooldownSeconds: cfg.failover.cooldownSeconds },
    },
    providers: cfg.failover.order.map((name, i) => {
      const p = cfg.providers[name] || {};
      const a = p.auth || {};
      return {
        position: i === 0 ? "primary" : `backup ${i}`,
        kind: providerKind(p),
        auth: a.type,
        credentialSource: a.keychain ? "keychain" : a.env ? "env" : a.command ? "command" : a.value ? "value" : a.type === "passthrough" ? "Claude Code" : "none",
        modelMap: Object.keys(p.models || {}).length ? "custom" : "default",
      };
    }),
    modelRestrictions: av.list ? { source: av.source, count: av.list.length } : null,
    checks: checks.map((c) => `${c.level}: ${anon(scrub(c.text, env, [home]))}`),
  };
  if (live) {
    d.router = {
      uptimeMinutes: Math.round(process.uptime() / 60),
      loginType: live.credential || "not seen yet",
      providerHealth: live.health.map((h, i) => ({ position: i === 0 ? "primary" : `backup ${i}`, up: h.up, lastError: h.lastError ? anon(scrub(h.lastError, env, [home])) : null })),
      lifetime: live.lifetime ? { messages: live.lifetime.messages, percentCheaper: live.lifetime.percentCheaper != null ? Math.round(live.lifetime.percentCheaper) : null, switches: live.lifetime.switches, failoverRequests: live.lifetime.failoverRequests, avgOverheadMs: live.lifetime.avgOverheadMs } : null,
    };
  }
  return d;
}
