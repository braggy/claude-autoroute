import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { mockUpstream, startRouter, TOOLS, userMsg, wait, until } from "./helpers.mjs";
import { costOf, priceTable } from "../src/cost.mjs";

const cleanup = [];
after(async () => { for (const c of cleanup) await c(); });

async function freePortUrl() {
  const s = net.createServer(); await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port; await new Promise((r) => s.close(r));
  return `http://127.0.0.1:${port}`; // nothing listens here any more
}

function twoProviders(primaryUrl, backupUrl, failover = {}) {
  return {
    providers: {
      anthropic: { type: "anthropic", baseUrl: primaryUrl },
      backup: { type: "anthropic", baseUrl: backupUrl, auth: { type: "bearer", env: "TEST_BACKUP_TOKEN" },
                models: { haiku: "b-haiku", sonnet: "b-sonnet", opus: "b-opus" } },
    },
    failover: { order: ["anthropic", "backup"], cooldownSeconds: 1, ...failover },
  };
}
const ENV = { TEST_BACKUP_TOKEN: "test-backup-token" };

test("requests without the local key are rejected", async () => {
  const up = await mockUpstream(); const r = await startRouter({ providers: { anthropic: { baseUrl: up.url } } });
  cleanup.push(up.close, r.close);
  const res = await fetch(r.base + "/v1/messages", { method: "POST", body: "{}" });
  assert.equal(res.status, 401);
  assert.equal(up.calls.length, 0);
});

test("routes per message, keeps a turn's tool calls on one model, strips override tags", async () => {
  const up = await mockUpstream(); const r = await startRouter({ providers: { anthropic: { baseUrl: up.url } } });
  cleanup.push(up.close, r.close);
  const msgs = [userMsg("git status")];
  const a = await r.post({ model: "claude-opus-5-5", tools: TOOLS, stream: true, messages: msgs });
  assert.equal(a.model, "claude-haiku-5-5");
  msgs.push({ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] });
  msgs.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] });
  const b = await r.post({ model: "claude-opus-5-5", tools: TOOLS, stream: true, messages: msgs });
  assert.equal(b.model, "claude-haiku-5-5", "tool call stays on the turn's model");
  const c = await r.post({ model: "claude-sonnet-5-5", tools: TOOLS, stream: true, messages: [userMsg("!opus rename x")] });
  assert.equal(c.model, "claude-opus-5-5");
  assert.ok(!JSON.stringify(up.calls.at(-1).body).includes("!opus"));
});

test("background calls (no tools / haiku) are not re-routed", async () => {
  const up = await mockUpstream(); const r = await startRouter({ providers: { anthropic: { baseUrl: up.url } } });
  cleanup.push(up.close, r.close);
  const a = await r.post({ model: "claude-haiku-5-5", messages: [userMsg("summarize this as a title: refactor the architecture")] });
  assert.equal(up.calls.at(-1).body.model, "claude-haiku-5-5");
  assert.equal(a.status, 200);
});

test("fails over on 529, sticks to the backup, then returns to the primary after cooldown", async () => {
  let primaryDown = true;
  const primary = await mockUpstream(() => (primaryDown ? { status: 529, json: { error: { type: "overloaded_error" } } } : { status: 200, sse: true }));
  const backup = await mockUpstream();
  const r = await startRouter(twoProviders(primary.url, backup.url), ENV);
  cleanup.push(primary.close, backup.close, r.close);

  const body = { model: "claude-sonnet-5-5", tools: TOOLS, stream: true, messages: [userMsg("add a unit test for parseDate")] };
  const a = await r.post(body, { "x-api-key": "client-anthropic-key" });
  assert.equal(a.status, 200);
  assert.equal(a.provider, "backup");
  assert.equal(a.model, "b-sonnet");
  const sent = backup.calls.at(-1);
  assert.equal(sent.headers.authorization, "Bearer test-backup-token");
  assert.equal(sent.headers["x-api-key"], undefined, "client's Anthropic key must not reach the backup");

  const before = primary.calls.length;
  const b = await r.post(body);
  assert.equal(b.provider, "backup");
  assert.equal(primary.calls.length, before, "primary is skipped during cooldown");

  primaryDown = false;
  await wait(1100);
  const c = await r.post(body);
  assert.equal(c.provider, "anthropic");
  const state = JSON.parse(fs.readFileSync(path.join(r.home, "state.json"), "utf8"));
  assert.equal(state.provider, "anthropic");
});

test("fails over when the primary is unreachable", async () => {
  const backup = await mockUpstream();
  const r = await startRouter(twoProviders(await freePortUrl(), backup.url), ENV);
  cleanup.push(backup.close, r.close);
  const a = await r.post({ model: "claude-opus-5-5", tools: TOOLS, stream: true, messages: [userMsg("design the architecture for plugins")] });
  assert.equal(a.status, 200);
  assert.equal(a.provider, "backup");
  assert.equal(a.model, "b-opus");
});

test("background calls fail over too", async () => {
  const backup = await mockUpstream();
  const r = await startRouter(twoProviders(await freePortUrl(), backup.url), ENV);
  cleanup.push(backup.close, r.close);
  const a = await r.post({ model: "claude-haiku-5-5", messages: [userMsg("title please")] });
  assert.equal(a.provider, "backup");
  assert.equal(backup.calls.at(-1).body.model, "b-haiku");
});

test("429 only fails over when onRateLimit is enabled", async () => {
  const primary = await mockUpstream(() => ({ status: 429, json: { error: { type: "rate_limit_error" } } }));
  const backup = await mockUpstream();
  const off = await startRouter(twoProviders(primary.url, backup.url), ENV);
  const on = await startRouter(twoProviders(primary.url, backup.url, { onRateLimit: true }), ENV);
  cleanup.push(primary.close, backup.close, off.close, on.close);
  const body = { model: "claude-sonnet-5-5", tools: TOOLS, stream: true, messages: [userMsg("add a test")] };
  assert.equal((await off.post(body)).status, 429);
  const r = await on.post(body);
  assert.equal(r.status, 200);
  assert.equal(r.provider, "backup");
});

test("when every provider fails, the last error is returned", async () => {
  const primary = await mockUpstream(() => ({ status: 503, json: { error: { message: "primary down" } } }));
  const backup = await mockUpstream(() => ({ status: 500, json: { error: { message: "backup down" } } }));
  const r = await startRouter(twoProviders(primary.url, backup.url), ENV);
  cleanup.push(primary.close, backup.close, r.close);
  const a = await r.post({ model: "claude-sonnet-5-5", tools: TOOLS, stream: true, messages: [userMsg("add a test")] });
  assert.equal(a.status, 500);
  assert.match(a.text, /backup down/);
});

test("a backup with a missing credential is skipped with a clear log line", async () => {
  const primary = await mockUpstream(() => ({ status: 503, json: {} }));
  const backup = await mockUpstream();
  const r = await startRouter(twoProviders(primary.url, backup.url), {}); // TEST_BACKUP_TOKEN unset
  cleanup.push(primary.close, backup.close, r.close);
  const a = await r.post({ model: "claude-sonnet-5-5", tools: TOOLS, stream: true, messages: [userMsg("add a test")] });
  assert.equal(backup.calls.length, 0);
  assert.equal(a.status, 502);
  assert.match(fs.readFileSync(path.join(r.home, "router.log"), "utf8"), /TEST_BACKUP_TOKEN is not set/);
});

test("400 about thinking signatures is retried once without old thinking blocks", async () => {
  const up = await mockUpstream(({ body }) =>
    JSON.stringify(body?.messages || []).includes('"thinking"') ? { status: 400, json: { error: { message: "invalid signature in thinking block" } } } : { status: 200, sse: true });
  const r = await startRouter({ providers: { anthropic: { baseUrl: up.url } } });
  cleanup.push(up.close, r.close);
  const a = await r.post({ model: "claude-opus-5-5", tools: TOOLS, stream: true, messages: [
    userMsg("first"), { role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "s" }, { type: "text", text: "hi" }] }, userMsg("git status"),
  ] });
  assert.equal(a.status, 200);
  assert.equal(up.calls.length, 2);
});

test("vertex backup gets the right URL and body", async () => {
  const primary = await mockUpstream(() => ({ status: 503, json: {} }));
  const vertex = await mockUpstream();
  const r = await startRouter({
    providers: {
      anthropic: { baseUrl: primary.url },
      v: { type: "vertex", projectId: "proj", region: "us-east5", baseUrl: vertex.url, auth: { type: "bearer", command: "echo test-vertex-token" } },
    },
    failover: { order: ["anthropic", "v"] },
  });
  cleanup.push(primary.close, vertex.close, r.close);
  const a = await r.post({ model: "claude-sonnet-5-5", tools: TOOLS, stream: true, messages: [userMsg("add a test")] });
  assert.equal(a.provider, "v");
  const call = vertex.calls.at(-1);
  assert.equal(call.url, "/v1/projects/proj/locations/us-east5/publishers/anthropic/models/claude-sonnet-5-5:streamRawPredict");
  assert.equal(call.body.anthropic_version, "vertex-2023-10-16");
  assert.equal(call.body.model, undefined);
  assert.equal(call.headers.authorization, "Bearer test-vertex-token");
});

test("spend is recorded and prompts are not logged by default", async () => {
  const up = await mockUpstream(); const r = await startRouter({ providers: { anthropic: { baseUrl: up.url } } });
  cleanup.push(up.close, r.close);
  await r.post({ model: "claude-opus-5-5", tools: TOOLS, stream: true, messages: [userMsg("secret project codename bluebird: git status")] });
  await until(() => fs.existsSync(path.join(r.home, "stats.jsonl")), { what: "stats row" });
  const rows = fs.readFileSync(path.join(r.home, "stats.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.at(-1).kind, "turn");
  assert.ok(rows.at(-1).actual > 0);
  assert.ok(rows.at(-1).baseline > rows.at(-1).actual, "haiku is cheaper than the requested opus");
  const everything = fs.readdirSync(r.home).map((f) => fs.readFileSync(path.join(r.home, f), "utf8")).join("\n");
  assert.ok(!everything.includes("bluebird"), "prompt text must not be written to disk");
});

test("runtime files are private to the user", { skip: process.platform === "win32" }, async () => {
  const up = await mockUpstream(); const r = await startRouter({ providers: { anthropic: { baseUrl: up.url } } });
  cleanup.push(up.close, r.close);
  await r.post({ model: "claude-opus-5-5", tools: TOOLS, stream: true, messages: [userMsg("git status")] });
  // Wait for every runtime file, including the lifetime totals written a moment later.
  await until(() => ["stats.jsonl", "totals.json", "state.json", "router.log"].every((f) => fs.existsSync(path.join(r.home, f))), { what: "runtime files" });
  assert.equal(fs.statSync(r.home).mode & 0o077, 0, "home folder");
  for (const f of fs.readdirSync(r.home)) assert.equal(fs.statSync(path.join(r.home, f)).mode & 0o077, 0, f);
});

test("a wrong local key is rejected too", async () => {
  const up = await mockUpstream(); const r = await startRouter({ providers: { anthropic: { baseUrl: up.url } } });
  cleanup.push(up.close, r.close);
  const res = await fetch(r.base + "/v1/messages", { method: "POST", headers: { "x-autoroute-key": "nope" }, body: "{}" });
  assert.equal(res.status, 401);
  assert.equal(up.calls.length, 0);
});

test("a turn's tool loop stays on one model even when re-deciding would pick another", async () => {
  // Small bigContextTokens: a big tool result would push a fresh decision up to sonnet.
  const up = await mockUpstream();
  const r = await startRouter({ providers: { anthropic: { baseUrl: up.url } }, switching: { bigContextTokens: 1000 } });
  cleanup.push(up.close, r.close);
  const msgs = [userMsg("git status")];
  assert.equal((await r.post({ model: "claude-opus-5-5", tools: TOOLS, stream: true, messages: msgs })).model, "claude-haiku-5-5");
  msgs.push({ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] });
  msgs.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "M file.txt\n".repeat(1500) }] });
  assert.equal((await r.post({ model: "claude-opus-5-5", tools: TOOLS, stream: true, messages: msgs })).model, "claude-haiku-5-5", "same turn, same model");
  msgs.push({ role: "assistant", content: [{ type: "text", text: "done" }] });
  msgs.push(userMsg("git status again"));
  const next = await r.post({ model: "claude-opus-5-5", tools: TOOLS, stream: true, messages: msgs });
  assert.equal(next.model, "claude-sonnet-5-5", "the next typed message is decided afresh (large context)");
});

test("savings are honest: a rebuild caused by switching is priced as reads in the baseline", async () => {
  const up = await mockUpstream();
  const r = await startRouter({ providers: { anthropic: { baseUrl: up.url } } });
  cleanup.push(up.close, r.close);
  const stats = path.join(r.home, "stats.jsonl");
  const rows = () => (fs.existsSync(stats) ? fs.readFileSync(stats, "utf8").trim().split("\n").map(JSON.parse) : []);
  const msgs = [userMsg("!opus " + "design notes ".repeat(400))];
  await r.post({ model: "claude-opus-5-5", tools: TOOLS, stream: true, messages: msgs });
  await until(() => rows().length === 1, { what: "first row" });
  msgs.push({ role: "assistant", content: [{ type: "text", text: "ok" }] }, userMsg("!haiku git status"));
  await r.post({ model: "claude-opus-5-5", tools: TOOLS, stream: true, messages: msgs });
  await until(() => rows().length === 2, { what: "second row" });
  const row = rows()[1];
  assert.equal(row.cacheMiss, true, "switching models is a cache miss");
  assert.ok(row.usage.cache_creation_input_tokens > 0);
  const opus = priceTable(r.cfg, "opus", "anthropic");
  assert.equal(row.baseline, costOf(opus, row.usage, false, true), "baseline treats the rebuild as the reads it would have been");
  assert.ok(row.baseline < costOf(opus, row.usage), "so the switch isn't counted as a saving");
});
