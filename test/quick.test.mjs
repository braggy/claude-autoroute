import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mockUpstream, startRouter, tmpHome, TOOLS, userMsg } from "./helpers.mjs";
import { createLoginToken } from "../src/ui-server.mjs";
import { applyQuick } from "../src/quick.mjs";
import { buildConfig, validateConfig } from "../src/config.mjs";
import { parseJsonc } from "../src/config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cleanup = [];
after(async () => { for (const c of cleanup) await c(); });
const body = (text) => ({ model: "claude-opus-5-5", tools: TOOLS, stream: true, messages: [userMsg(text)] });

async function ui(r) {
  const res = await fetch(`${r.base}/ui/login?t=${createLoginToken(r.home)}`, { redirect: "manual" });
  const cookie = res.headers.get("set-cookie").split(";")[0];
  return (p, b) => fetch(`${r.base}/ui/api/${p}`, { method: b ? "POST" : "GET", headers: { cookie, "x-autoroute-ui": "1", origin: r.base, "content-type": "application/json" }, body: b && JSON.stringify(b) })
    .then(async (x) => ({ status: x.status, json: await x.json() }));
}

test("pause: requests go through unchanged; resume turns routing back on", async () => {
  const up = await mockUpstream(); const r = await startRouter({ providers: { anthropic: { baseUrl: up.url } } });
  cleanup.push(up.close, r.close);
  const api = await ui(r);
  assert.equal((await api("quick", { type: "pause", value: true })).status, 200);
  assert.equal((await r.post(body("git status"))).model, "claude-opus-5-5", "model untouched while paused");
  assert.equal(up.calls.at(-1).body.model, "claude-opus-5-5");
  assert.match(fs.readFileSync(path.join(r.home, "config.jsonc"), "utf8"), /"paused": true/);
  await api("quick", { type: "pause", value: false });
  assert.equal((await r.post(body("git status"))).model, "claude-haiku-5-5");
});

test("a provider switched off is skipped; switching all off is refused", async () => {
  const a = await mockUpstream(); const b = await mockUpstream();
  const r = await startRouter({ providers: { anthropic: { baseUrl: a.url }, backup: { baseUrl: b.url, auth: { type: "none" } } }, failover: { order: ["anthropic", "backup"] } });
  cleanup.push(a.close, b.close, r.close);
  const api = await ui(r);
  assert.equal((await api("quick", { type: "provider", name: "anthropic", value: false })).status, 200);
  assert.equal((await r.post(body("add a test"))).provider, "backup");
  const res = await api("quick", { type: "provider", name: "backup", value: false });
  assert.equal(res.status, 422);
  assert.match(res.json.errors.join(" "), /turn at least one back on/);
});

test("priority presets set clear, documented values", () => {
  const user = { providers: { anthropic: { baseUrl: "https://api.anthropic.com" }, local: { baseUrl: "http://127.0.0.1:11434", auth: { type: "none" } } } };
  const eff = buildConfig(user, {});
  const fast = applyQuick(user, eff, { type: "priority", name: "fastest" });
  assert.equal(fast.switching.mode, "always"); assert.equal(fast.local.enabled, false); assert.equal(fast.priority, "fastest");
  const cheap = applyQuick(user, eff, { type: "priority", name: "lowest-cost" });
  assert.equal(cheap.local.enabled, true); assert.equal(cheap.local.maxSlowdown, 0);
  const best = applyQuick(user, eff, { type: "priority", name: "best-quality" });
  assert.deepEqual(best.allowedTiers, ["sonnet", "opus"]);
  for (const u of [fast, cheap, best]) assert.deepEqual(validateConfig(buildConfig(u, {})), []);
  assert.throws(() => applyQuick({}, buildConfig({}, {}), { type: "local", value: true }), /Set up a local model first/);
  assert.throws(() => applyQuick({}, eff, { type: "priority", name: "turbo" }), /unknown priority/);
});

test("speed guard: a slow local model is skipped for easy tasks, with periodic re-checks", async () => {
  const claude = await mockUpstream(); const local = await mockUpstream();
  const r = await startRouter({
    providers: { anthropic: { baseUrl: claude.url }, local: { baseUrl: local.url, auth: { type: "none" }, priceMultiplier: 0 } },
    local: { enabled: true, model: "m", maxSlowdown: 2 },
  });
  cleanup.push(claude.close, local.close, r.close);
  r.server.ctx.perf.local = [9000, 9000, 9000, 9000, 9000];
  r.server.ctx.perf.claude = [2000, 2000, 2000, 2000, 2000];
  const results = [];
  for (let i = 0; i < 10; i++) results.push((await r.post(body(`git status ${i}`))).provider);
  assert.equal(results.filter((p) => p === "anthropic").length, 9, "skipped while 4.5x slower");
  assert.equal(results.filter((p) => p === "local").length, 1, "but re-checked once in ten");
  assert.match(fs.readFileSync(path.join(r.home, "router.log"), "utf8"), /local model is 4\.5x slower/);
  r.server.ctx.cfg.local.maxSlowdown = 0;
  assert.equal((await r.post(body("git status again"))).provider, "local", "0 = no speed limit");
});

test("status endpoint: needs the local key, reports stats, never prompt text", async () => {
  const up = await mockUpstream(); const r = await startRouter({ providers: { anthropic: { baseUrl: up.url } } });
  cleanup.push(up.close, r.close);
  await r.post(body("codename heron: git status"));
  await new Promise((res) => setTimeout(res, 50));
  assert.equal((await fetch(`${r.base}/__autoroute/status`)).status, 401);
  const res = await fetch(`${r.base}/__autoroute/status`, { headers: { "x-autoroute-key": r.server.ctx.localKey } });
  assert.equal(res.status, 200);
  const st = await res.json();
  assert.equal(st.last.tier, "haiku");
  assert.equal(st.lifetime.messages, 1);
  assert.ok(st.today.baseline > st.today.actual);
  assert.ok(!JSON.stringify(st).includes("heron"));
  const h = await (await fetch(`${r.base}/__autoroute/health`)).json();
  assert.deepEqual(Object.keys(h).sort(), ["ok", "pid", "version"], "the open health check reveals nothing else");
});

test("command line: pause, local, provider and priority edit the config safely", () => {
  const home = tmpHome();
  const run = (...a) => spawnSync(process.execPath, [path.join(ROOT, "bin", "autoroute.mjs"), ...a], { env: { ...process.env, AUTOROUTE_HOME: home } });
  assert.equal(run("pause").status, 0);
  assert.equal(run("priority", "fastest").status, 0);
  const cfg = parseJsonc(fs.readFileSync(path.join(home, "config.jsonc"), "utf8"));
  assert.equal(cfg.paused, true);
  assert.equal(cfg.switching.mode, "always");
  assert.equal(fs.statSync(path.join(home, "config.jsonc")).mode & 0o077, 0);
  const bad = run("local", "on");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr.toString(), /Set up a local model first/);
  assert.equal(run("provider", "anthropic", "off").status, 1, "can't switch off the only provider");
});

test("the dashboard overview carries everything the Quick settings card needs", async () => {
  const up = await mockUpstream(); const local = await mockUpstream();
  const r = await startRouter({ providers: { anthropic: { baseUrl: up.url }, local: { baseUrl: local.url, auth: { type: "none" }, priceMultiplier: 0 } }, local: { enabled: true, model: "m" } });
  cleanup.push(up.close, local.close, r.close);
  const o = (await (await ui(r))("overview")).json;
  assert.equal(o.paused, false);
  assert.equal(o.priority, "balanced");
  assert.deepEqual(Object.keys(o.presets), ["lowest-cost", "balanced", "fastest", "best-quality"]);
  assert.deepEqual(o.providerList, [{ name: "anthropic", enabled: true, active: true }]);
  assert.equal(o.local.configured, true);
  assert.equal(o.local.enabled, true);
  assert.equal(o.local.maxSlowdown, 2);
});
