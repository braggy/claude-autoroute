import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { mockUpstream, startRouter } from "./helpers.mjs";
import { createLoginToken } from "../src/ui-server.mjs";
import { setBackendForTests, securityQuote } from "../src/secrets.mjs";

const cleanup = [];
after(async () => { setBackendForTests(null); for (const c of cleanup) await c(); });

// An in-memory stand-in for the OS keychain.
const vault = new Map();
setBackendForTests({ name: "Test keychain", set: async (n, v) => vault.set(n, v), get: async (n) => vault.get(n) ?? null, remove: async (n) => vault.delete(n) });

async function session(r) {
  const res = await fetch(`${r.base}/ui/login?t=${createLoginToken(r.home)}`, { redirect: "manual" });
  assert.equal(res.status, 303);
  const cookie = res.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  return cookie.split(";")[0];
}
function apiFor(r, cookie) {
  return async (p, { method = "GET", body, headers = {} } = {}) => {
    const res = await fetch(`${r.base}/ui/api/${p}`, { method, headers: { cookie, "x-autoroute-ui": "1", origin: r.base, "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
  };
}
function rawGet(base, pathname, headers) {
  const u = new URL(base);
  return new Promise((resolve) => http.get({ host: u.hostname, port: u.port, path: pathname, headers }, (res) => { res.resume(); resolve(res.statusCode); }));
}

test("dashboard: only reachable through a one-time link", async () => {
  const r = await startRouter({}); cleanup.push(r.close);
  assert.equal((await fetch(`${r.base}/ui/`)).status, 401);
  assert.equal((await fetch(`${r.base}/ui/login?t=wrong`, { redirect: "manual" })).status, 403);
  const token = createLoginToken(r.home);
  assert.equal((await fetch(`${r.base}/ui/login?t=${token}`, { redirect: "manual" })).status, 303);
  assert.equal((await fetch(`${r.base}/ui/login?t=${token}`, { redirect: "manual" })).status, 403, "links work once");
  assert.equal(fs.statSync(path.join(r.home, "local-key")).mode & 0o077, 0);
});

test("dashboard: expired links are refused", async () => {
  const r = await startRouter({}); cleanup.push(r.close);
  createLoginToken(r.home);
  const p = path.join(r.home, "ui-token");
  const rec = JSON.parse(fs.readFileSync(p, "utf8")); rec.expires = Date.now() - 1; fs.writeFileSync(p, JSON.stringify(rec));
  assert.equal((await fetch(`${r.base}/ui/login?t=${rec.token}`, { redirect: "manual" })).status, 403);
});

test("dashboard: blocks DNS rebinding, CSRF and cross-origin calls; sends strict headers", async () => {
  const r = await startRouter({}); cleanup.push(r.close);
  const cookie = await session(r);
  assert.equal(await rawGet(r.base, "/ui/", { host: "evil.example.com", cookie }), 421);
  const page = await fetch(`${r.base}/ui/`, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal(page.headers.get("access-control-allow-origin"), null);
  // no custom header (what a cross-site form would send)
  assert.equal((await fetch(`${r.base}/ui/api/overview`, { headers: { cookie } })).status, 403);
  const api = apiFor(r, cookie);
  assert.equal((await api("config", { method: "PUT", body: { config: {} }, headers: { origin: "http://evil.example.com" } })).status, 403);
  assert.equal((await api("overview")).status, 200);
  // no session
  assert.equal((await fetch(`${r.base}/ui/api/overview`, { headers: { "x-autoroute-ui": "1" } })).status, 401);
});

test("dashboard: config is validated, saved privately with a backup, and applied live", async () => {
  const r = await startRouter({}); cleanup.push(r.close);
  fs.writeFileSync(path.join(r.home, "config.jsonc"), "// mine\n{}");
  const api = apiFor(r, await session(r));
  const bad = await api("config", { method: "PUT", body: { config: { failover: { order: ["nope"] } } } });
  assert.equal(bad.status, 422);
  assert.match(bad.json.errors.join(" "), /unknown provider/);
  assert.equal(fs.readFileSync(path.join(r.home, "config.jsonc"), "utf8"), "// mine\n{}", "invalid config is not written");
  const ok = await api("config", { method: "PUT", body: { config: { switching: { returnProbability: 0.8 } } } });
  assert.equal(ok.status, 200);
  assert.equal(r.server.ctx.cfg.switching.returnProbability, 0.8, "applied without restart");
  assert.equal(fs.statSync(path.join(r.home, "config.jsonc")).mode & 0o077, 0);
  assert.equal(fs.readFileSync(path.join(r.home, "config.jsonc.bak"), "utf8"), "// mine\n{}");
});

test("dashboard: literal secrets in config are never sent to the browser, and survive a save", async () => {
  const r = await startRouter({}); cleanup.push(r.close);
  const secret = "local-gateway-dummy-value-123456";
  fs.writeFileSync(path.join(r.home, "config.jsonc"), JSON.stringify({
    providers: { anthropic: { baseUrl: "https://api.anthropic.com" }, gw: { baseUrl: "http://127.0.0.1:4000", auth: { type: "x-api-key", value: secret } } },
    failover: { order: ["anthropic", "gw"] },
  }));
  const api = apiFor(r, await session(r));
  const got = await api("config");
  assert.ok(!JSON.stringify(got.json).includes(secret));
  const user = got.json.user; user.switching = { returnProbability: 0.7 };
  assert.equal((await api("config", { method: "PUT", body: { config: user } })).status, 200);
  assert.ok(fs.readFileSync(path.join(r.home, "config.jsonc"), "utf8").includes(secret), "redacted placeholder replaced with the original");
});

test("dashboard: API keys go to the keychain, are used by the provider, and are never returned", async () => {
  const backup = await mockUpstream();
  const r = await startRouter({
    providers: { anthropic: { baseUrl: "https://api.anthropic.com" }, bedrock: { baseUrl: backup.url, auth: { type: "bearer", keychain: "bedrock" } } },
    failover: { order: ["anthropic", "bedrock"] },
  });
  cleanup.push(backup.close, r.close);
  const api = apiFor(r, await session(r));
  assert.deepEqual((await api("keys")).json.keys, { bedrock: false });
  assert.equal((await api("keys", { method: "POST", body: { name: "bedrock", value: "test-keychain-token" } })).status, 200);
  const listed = await api("keys");
  assert.deepEqual(listed.json.keys, { bedrock: true });
  assert.ok(!JSON.stringify(listed.json).includes("test-keychain-token"));
  const t = await api("providers/test", { method: "POST", body: { name: "bedrock" } });
  assert.equal(t.json.ok, true);
  assert.equal(backup.calls.at(-1).headers.authorization, "Bearer test-keychain-token");
  assert.equal(backup.calls.at(-1).body.max_tokens, 1, "test sends a 1-token request");
  assert.equal((await api("keys", { method: "POST", body: { name: "../etc", value: "x" } })).status, 400);
  await api("keys", { method: "DELETE", body: { name: "bedrock" } });
  assert.deepEqual((await api("keys")).json.keys, { bedrock: false });
});

test("macOS keychain quoting can't be broken out of", () => {
  assert.equal(securityQuote('a"b\\c'), '"a\\"b\\\\c"');
  assert.throws(() => securityQuote("a\nb"));
});

test("dashboard: overview includes lifetime value and no prompt text", async () => {
  const up = await mockUpstream();
  const r = await startRouter({ providers: { anthropic: { baseUrl: up.url } } });
  cleanup.push(up.close, r.close);
  await r.post({ model: "claude-opus-5-5", tools: [{ name: "Bash" }], stream: true, messages: [{ role: "user", content: "codename zebra: git status" }] });
  await new Promise((res) => setTimeout(res, 50));
  const o = await apiFor(r, await session(r))("overview");
  assert.equal(o.json.lifetime.messages, 1);
  assert.equal(o.json.lifetime.downgraded, 1);
  assert.ok(o.json.lifetime.saved > 0);
  assert.ok(!JSON.stringify(o.json).includes("zebra"));
});

test("dashboard: can't add or change a credential command, only keep or remove one", async () => {
  const r = await startRouter({}); cleanup.push(r.close);
  const onDisk = {
    providers: { anthropic: { baseUrl: "https://api.anthropic.com" }, gw: { baseUrl: "http://127.0.0.1:4000", auth: { type: "bearer", command: "echo ok" } } },
    failover: { order: ["anthropic", "gw"] },
  };
  fs.writeFileSync(path.join(r.home, "config.jsonc"), JSON.stringify(onDisk));
  const api = apiFor(r, await session(r));
  const user = (await api("config")).json.user;

  const changed = structuredClone(user); changed.providers.gw.auth.command = "touch /tmp/pwned";
  const res = await api("config", { method: "PUT", body: { config: changed } });
  assert.equal(res.status, 403);
  assert.match(res.json.errors.join(" "), /can't set a credential command/);
  const added = structuredClone(user); added.providers.anthropic.auth = { type: "bearer", command: "id" };
  assert.equal((await api("config", { method: "PUT", body: { config: added } })).status, 403);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.home, "config.jsonc"), "utf8")).providers.gw.auth.command, "echo ok", "file untouched");

  const kept = structuredClone(user); kept.switching = { returnProbability: 0.7 };
  assert.equal((await api("config", { method: "PUT", body: { config: kept } })).status, 200, "an unchanged command saves fine");
  const removed = structuredClone(kept); removed.providers.gw.auth = { type: "bearer", env: "GW_TOKEN" };
  assert.equal((await api("config", { method: "PUT", body: { config: removed } })).status, 200, "removing a command is allowed");
});
