import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mockUpstream, startRouter, policyPaths, TOOLS, userMsg, wait, until } from "./helpers.mjs";
import { buildConfig, validateConfig } from "../src/config.mjs";

const cleanup = [];
after(async () => { for (const c of cleanup) await c(); });

function cfgWith(claudeUrl, localUrl, local = {}) {
  return {
    providers: {
      anthropic: { baseUrl: claudeUrl },
      local: { type: "anthropic", baseUrl: localUrl, auth: { type: "none" }, forwardBetaHeaders: false, priceMultiplier: 0 },
    },
    local: { enabled: true, model: "qwen3-coder", ...local },
  };
}
const body = (text, extra = []) => ({ model: "claude-opus-5-5", tools: TOOLS, stream: true, metadata: { user_id: "u" }, thinking: { type: "enabled", budget_tokens: 1000 },
  messages: [...extra, userMsg(text)] });
const withThinking = [userMsg("earlier"), { role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "s" }, { type: "text", text: "ok" }] }];

test("easy tasks go to the local model, cleaned of Claude-only fields and credentials, at $0", async () => {
  const claude = await mockUpstream(); const local = await mockUpstream();
  const r = await startRouter(cfgWith(claude.url, local.url));
  cleanup.push(claude.close, local.close, r.close);
  const res = await r.post(body("git status", withThinking), { "x-api-key": "client-claude-key" });
  assert.equal(res.status, 200);
  assert.equal(res.provider, "local");
  assert.equal(res.model, "qwen3-coder");
  const sent = local.calls.at(-1);
  assert.equal(sent.body.model, "qwen3-coder");
  for (const f of ["metadata", "thinking"]) assert.equal(sent.body[f], undefined, f);
  assert.ok(!JSON.stringify(sent.body.messages).includes('"thinking"'), "old thinking blocks removed");
  assert.equal(sent.headers["x-api-key"], undefined, "Claude credentials never reach the local server");
  assert.equal(claude.calls.length, 0);
  await until(() => fs.existsSync(path.join(r.home, "stats.jsonl")), { what: "stats row" });
  const row = fs.readFileSync(path.join(r.home, "stats.jsonl"), "utf8").trim().split("\n").map(JSON.parse).at(-1);
  assert.equal(row.local, true);
  assert.equal(row.actual, 0);
  assert.ok(row.baseline > 0);
  assert.equal(r.server.ctx.stats.lifetime.localMessages, 1);
});

test("hard tasks stay on Claude", async () => {
  const claude = await mockUpstream(); const local = await mockUpstream();
  const r = await startRouter(cfgWith(claude.url, local.url));
  cleanup.push(claude.close, local.close, r.close);
  const res = await r.post(body("design the architecture for a plugin system across the codebase"));
  assert.equal(res.provider, "anthropic");
  assert.equal(local.calls.length, 0);
});

test("if the local model fails, the same request goes to Claude, and the rest of the turn stays there", async () => {
  const claude = await mockUpstream(); const local = await mockUpstream(() => ({ status: 500, json: { error: "model not found" } }));
  const r = await startRouter(cfgWith(claude.url, local.url));
  cleanup.push(claude.close, local.close, r.close);
  const msgs = [userMsg("git status")];
  const a = await r.post({ ...body("x"), messages: msgs });
  assert.equal(a.status, 200);
  assert.equal(a.provider, "anthropic");
  assert.equal(a.model, "claude-haiku-5-5");
  msgs.push({ role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] });
  const b = await r.post({ ...body("x"), messages: msgs });
  assert.equal(b.provider, "anthropic");
  assert.equal(local.calls.length, 1, "local isn't retried mid-turn");
  assert.match(fs.readFileSync(path.join(r.home, "router.log"), "utf8"), /local model failed/);
});

test("large chats stay on Claude", async () => {
  const claude = await mockUpstream(); const local = await mockUpstream();
  const r = await startRouter(cfgWith(claude.url, local.url, { maxContextTokens: 1000 }));
  cleanup.push(claude.close, local.close, r.close);
  const res = await r.post(body("git status", [{ role: "user", content: "x".repeat(20000) }, { role: "assistant", content: "ok" }]));
  assert.equal(res.provider, "anthropic");
});

test("organization model rules apply to the local model too", async () => {
  const claude = await mockUpstream(); const local = await mockUpstream();
  const pol = policyPaths();
  fs.writeFileSync(pol.managedFile, JSON.stringify({ availableModels: ["haiku", "sonnet", "opus"] }));
  const r = await startRouter(cfgWith(claude.url, local.url), {}, { policy: pol });
  cleanup.push(claude.close, local.close, r.close);
  assert.equal((await r.post(body("git status"))).provider, "anthropic", "not on the list");
  const pol2 = policyPaths();
  fs.writeFileSync(pol2.managedFile, JSON.stringify({ availableModels: ["haiku", "qwen3-coder"] }));
  const r2 = await startRouter(cfgWith(claude.url, local.url), {}, { policy: pol2 });
  cleanup.push(r2.close);
  assert.equal((await r2.post(body("git status", []))).provider, "local", "listed by name");
});

test("off by default; validation catches unsafe setups", () => {
  assert.equal(buildConfig({}, {}).local.enabled, false);
  const bad = buildConfig({
    providers: { anthropic: { baseUrl: "https://api.anthropic.com" }, local: { baseUrl: "http://127.0.0.1:11434", auth: { type: "passthrough" } } },
    failover: { order: ["anthropic", "local"] },
    local: { enabled: true, useFor: ["opus"] },
  }, {});
  const errs = validateConfig(bad).join("\n");
  assert.match(errs, /can't use passthrough/);
  assert.match(errs, /shouldn't also be in failover.order/);
  assert.match(errs, /local.useFor/);
  assert.match(validateConfig(buildConfig({ local: { enabled: true } }, {})).join("\n"), /isn't defined in providers/);
});
