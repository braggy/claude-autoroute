import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyLifetime, accumulate, summarize } from "../src/stats.mjs";

const row = (o) => ({ kind: "turn", ts: 1, newTurn: true, actual: 0.01, baseline: 0.05, ...o });

test("lifetime value: money, cheaper-model share, upgrades, rescues", () => {
  const lt = emptyLifetime();
  accumulate(lt, row({ tier: "haiku", originalTier: "opus" }));
  accumulate(lt, row({ tier: "sonnet", originalTier: "opus" }));
  accumulate(lt, row({ tier: "opus", originalTier: "sonnet", actual: 0.05, baseline: 0.03 }));
  accumulate(lt, row({ tier: "opus", originalTier: "opus", actual: 0.04, baseline: 0.04, failover: true }));
  accumulate(lt, row({ tier: "opus", originalTier: "opus", newTurn: false, actual: 0.02, baseline: 0.02 }));
  accumulate(lt, { kind: "background", ts: 2, failover: true });
  const v = summarize(lt);
  assert.equal(v.messages, 4);
  assert.equal(v.requests, 5);
  assert.equal(v.downgraded, 2);
  assert.equal(v.upgraded, 1);
  assert.equal(v.cheaperModelShare, 50);
  assert.equal(v.failoverRequests, 2, "routed + background rescues");
  assert.equal(v.failoverMessages, 1);
  assert.ok(Math.abs(v.saved - (0.19 - 0.13)) < 1e-9);
});

test("time saved is only estimated once there are enough measurements of the requested model", () => {
  const lt = emptyLifetime();
  for (let i = 0; i < 3; i++) accumulate(lt, row({ tier: "opus", originalTier: "opus", ms: 10000 }));
  accumulate(lt, row({ tier: "haiku", originalTier: "opus", ms: 2000 }));
  assert.equal(summarize(lt).timeSavedMs, null, "too few opus samples");
  for (let i = 0; i < 2; i++) accumulate(lt, row({ tier: "opus", originalTier: "opus", ms: 10000 }));
  const v = summarize(lt);
  assert.equal(v.timeSavedMs, 8000);
  assert.equal(v.timeSavedBasis, 1);
});

test("router overhead is averaged from measurements", () => {
  const lt = emptyLifetime();
  accumulate(lt, row({ tier: "sonnet", originalTier: "sonnet", overheadMs: 1 }));
  accumulate(lt, row({ tier: "sonnet", originalTier: "sonnet", overheadMs: 3 }));
  assert.equal(summarize(lt).avgOverheadMs, 2);
});
