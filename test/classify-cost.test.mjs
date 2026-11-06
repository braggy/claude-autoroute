import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConfig } from "../src/config.mjs";
import { heuristic, humanText, inspect, tierOf, stripOverrides } from "../src/classify.mjs";
import { chooseTier, costOf, priceTable } from "../src/cost.mjs";

const cfg = buildConfig({}, {});

test("classifier: easy, normal and hard prompts", () => {
  assert.equal(heuristic("git status", cfg).tier, "haiku");
  assert.equal(heuristic("fix the typo in README", cfg).tier, "haiku");
  assert.equal(heuristic("add a unit test for parseDate", cfg).tier, "sonnet");
  assert.equal(heuristic("refactor the auth module across the codebase", cfg).tier, "opus");
  assert.equal(heuristic("We have a race condition in the job queue. Investigate the root cause.", cfg).tier, "opus");
});

test("humanText ignores Claude Code's injected reminders and tool results", () => {
  assert.equal(humanText({ role: "user", content: [{ type: "text", text: "<system-reminder>x</system-reminder>hello" }] }), "hello");
  assert.equal(humanText({ role: "user", content: [{ type: "tool_result", content: "ok" }] }), "");
  const { latest } = inspect([
    { role: "user", content: "first" }, { role: "assistant", content: "a" },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "out" }] },
  ]);
  assert.equal(latest, "first");
});

test("override tags are removed before the model sees them", () => {
  const msgs = [{ role: "user", content: [{ type: "text", text: "!opus why does this deadlock?" }] }];
  stripOverrides(msgs);
  assert.equal(msgs[0].content[0].text, " why does this deadlock?");
});

test("tierOf recognises model families from any provider's ID", () => {
  assert.equal(tierOf("claude-opus-5-5"), "opus");
  assert.equal(tierOf("global.anthropic.claude-haiku-5-5"), "haiku");
  assert.equal(tierOf("claude-fable-5-1"), null);
});

const warmAll = () => true;
const warmOnly = (t) => (x) => x === t;

test("cost check: small chats switch freely", () => {
  const r = chooseTier(cfg, { desired: "haiku", current: "opus", T: 3000, isWarm: warmOnly("opus"), provider: "anthropic" });
  assert.equal(r.tier, "haiku");
});

test("cost check: one easy message in a long, warm Opus chat stays on Opus", () => {
  const r = chooseTier(cfg, { desired: "haiku", current: "opus", T: 80000, isWarm: warmOnly("opus"), provider: "anthropic", streak: 1 });
  assert.equal(r.tier, "opus");
  assert.match(r.note, /staying on opus/);
});

test("cost check: a streak of easy messages eventually drops down", () => {
  const r = chooseTier(cfg, { desired: "haiku", current: "opus", T: 80000, isWarm: warmOnly("opus"), provider: "anthropic", streak: 3 });
  assert.equal(r.tier, "haiku");
});

test("cost check: upgrades are allowed unless the cache rebuild is too expensive", () => {
  assert.equal(chooseTier(cfg, { desired: "opus", current: "sonnet", T: 20000, isWarm: warmOnly("sonnet"), provider: "anthropic" }).tier, "opus");
  const big = chooseTier(cfg, { desired: "opus", current: "sonnet", T: 400000, isWarm: warmOnly("sonnet"), provider: "anthropic" });
  assert.equal(big.tier, "sonnet");
  assert.match(big.note, /!opus/);
});

test("cost check: forced and 'always' mode ignore cost", () => {
  assert.equal(chooseTier(cfg, { desired: "haiku", current: "opus", T: 500000, isWarm: warmAll, provider: "anthropic", forced: true }).tier, "haiku");
  const always = buildConfig({ switching: { mode: "always" } }, {});
  assert.equal(chooseTier(always, { desired: "haiku", current: "opus", T: 500000, isWarm: warmAll, provider: "anthropic" }).tier, "haiku");
});

test("pricing: cache reads are cheap, writes 1.25x, provider multipliers apply", () => {
  const sonnet = priceTable(cfg, "sonnet", "anthropic");
  const read = costOf(sonnet, { input_tokens: 0, cache_read_input_tokens: 1e6, output_tokens: 0 });
  const write = costOf(sonnet, { input_tokens: 0, cache_creation_input_tokens: 1e6, output_tokens: 0 });
  assert.equal(read.toFixed(2), "0.10");
  assert.equal(write.toFixed(2), "2.50");
  const c2 = buildConfig({ providers: { anthropic: { baseUrl: "x" }, b: { baseUrl: "y", auth: { type: "none" }, priceMultiplier: 1.1 } }, failover: { order: ["anthropic", "b"] } }, {});
  assert.equal(priceTable(c2, "opus", "b").in.toFixed(2), "4.40");
});

test("pricing: Haiku long-context rates kick in above 100k tokens", () => {
  const h = priceTable(cfg, "haiku", "anthropic");
  assert.equal(costOf(h, { input_tokens: 1e5, output_tokens: 0 }).toFixed(3), "0.010");
  assert.equal(costOf(h, { input_tokens: 2e5, output_tokens: 0 }).toFixed(3), "0.100");
});
