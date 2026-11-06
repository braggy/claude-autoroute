import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mockUpstream, startRouter, policyPaths, TOOLS, userMsg } from "./helpers.mjs";
import { credentialKind, tierAllowed, readAvailableModels } from "../src/policy.mjs";

const cleanup = [];
after(async () => { for (const c of cleanup) await c(); });
const j = (...p) => p.join(""); // fake tokens built at runtime so the secret scanner stays quiet
const SUB = { authorization: j("Bearer sk-", "ant-", "oat01-", "x".repeat(24)) };
const SUB_BETA = { authorization: "Bearer something", "anthropic-beta": "interleaved-thinking,oauth-2025-04-20" };
const body = (text, model = "claude-opus-5-5") => ({ model, tools: TOOLS, stream: true, messages: [userMsg(text)] });

test("credential kinds", () => {
  assert.equal(credentialKind(SUB), "subscription");
  assert.equal(credentialKind(SUB_BETA), "subscription");
  assert.equal(credentialKind({ "x-api-key": "k" }), "api-key");
  assert.equal(credentialKind({ authorization: "Bearer gateway-token" }), "token");
  assert.equal(credentialKind({}), "none");
});

test("subscription logins are refused by default, with an explanation, and nothing is forwarded", async () => {
  const up = await mockUpstream(); const r = await startRouter({ providers: { anthropic: { baseUrl: up.url } } });
  cleanup.push(up.close, r.close);
  for (const h of [SUB, SUB_BETA]) {
    const res = await r.post(body("git status"), h);
    assert.equal(res.status, 403);
    assert.match(res.text, /Free, Pro or Max/);
    assert.match(res.text, /API key/);
  }
  assert.equal(up.calls.length, 0);
  const ok = await r.post(body("git status"), { "x-api-key": "test-console-key" });
  assert.equal(ok.status, 200, "API keys work");
});

test("Team/Enterprise subscription logins work only after an explicit opt-in", async () => {
  const up = await mockUpstream();
  const r = await startRouter({ subscriptionLogin: "allow-team-enterprise", providers: { anthropic: { baseUrl: up.url } } });
  cleanup.push(up.close, r.close);
  const res = await r.post(body("git status"), SUB);
  assert.equal(res.status, 200);
});

test("organization model restrictions: never routes to a model the admin blocked", async () => {
  const pol = policyPaths();
  fs.writeFileSync(pol.managedFile, JSON.stringify({ availableModels: ["sonnet", "opus"] }));
  const up = await mockUpstream(); const r = await startRouter({ providers: { anthropic: { baseUrl: up.url } } }, {}, { policy: pol });
  cleanup.push(up.close, r.close);
  const res = await r.post(body("git status"));
  assert.equal(res.model, "claude-opus-5-5", "haiku isn't allowed, so it keeps the requested model");
  const forced = await r.post(body("!haiku rename x", "claude-sonnet-5-5"));
  assert.equal(forced.model, "claude-sonnet-5-5", "even an explicit !haiku can't bypass the organization's list");
  assert.match(fs.readFileSync(path.join(r.home, "router.log"), "utf8"), /isn't allowed by organization/);
});

test("restrictions from the admin console cache and drop-in files are honored", async () => {
  const pol = policyPaths();
  fs.writeFileSync(pol.serverManaged, JSON.stringify({ availableModels: ["claude-sonnet-5-5"] }));
  assert.deepEqual(readAvailableModels(pol).list, ["claude-sonnet-5-5"]);
  fs.mkdirSync(pol.managedDropIns); fs.writeFileSync(path.join(pol.managedDropIns, "10-models.json"), JSON.stringify({ availableModels: ["haiku"] }));
  assert.deepEqual(readAvailableModels(pol).list.sort(), ["claude-sonnet-5-5", "haiku"]);
  const up = await mockUpstream(); const r = await startRouter({ providers: { anthropic: { baseUrl: up.url } } }, {}, { policy: pol });
  cleanup.push(up.close, r.close);
  const hard = await r.post(body("refactor the auth module across the codebase", "claude-sonnet-5-5"));
  assert.equal(hard.model, "claude-sonnet-5-5", "opus isn't allowed");
});

test("user-level availableModels and autoroute allowedTiers also apply", async () => {
  const pol = policyPaths();
  fs.writeFileSync(pol.user, JSON.stringify({ availableModels: ["opus", "sonnet"] }));
  assert.equal(readAvailableModels(pol).source, "your Claude Code settings");
  const up = await mockUpstream();
  const r = await startRouter({ allowedTiers: ["sonnet", "opus"], providers: { anthropic: { baseUrl: up.url } } });
  cleanup.push(up.close, r.close);
  assert.equal((await r.post(body("git status"))).model, "claude-opus-5-5");
});

test("allow-list entries match aliases, model IDs and provider IDs", () => {
  assert.equal(tierAllowed(null, "opus"), true);
  assert.equal(tierAllowed(["opus"], "opus"), true);
  assert.equal(tierAllowed(["opus[1m]"], "opus"), true);
  assert.equal(tierAllowed(["claude-opus-5-5"], "opus", ["claude-opus-5-5"]), true);
  assert.equal(tierAllowed(["claude-opus-5"], "opus", ["claude-opus-5-5"]), false, "an older version on the list doesn't allow a newer one");
  assert.equal(tierAllowed(["claude-haiku-5-5"], "opus", ["claude-opus-5-5"]), false);
  assert.equal(tierAllowed(["claude-sonnet-5-5"], "sonnet", ["anthropic.claude-sonnet-5-5"]), true);
});
