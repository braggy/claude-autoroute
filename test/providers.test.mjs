import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConfig } from "../src/config.mjs";
import { buildRequest, providerModel, credential } from "../src/providers.mjs";

const cfg = buildConfig({
  providers: {
    anthropic: { type: "anthropic", baseUrl: "https://api.anthropic.com" },
    bedrock: {
      type: "anthropic", baseUrl: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
      auth: { type: "bearer", env: "TEST_BEDROCK_TOKEN" }, forwardBetaHeaders: false,
      models: { sonnet: "anthropic.claude-sonnet-5-5", opus: "anthropic.claude-opus-5-5" },
    },
    vertex: { type: "vertex", projectId: "my-proj", region: "us-east5", auth: { type: "bearer", command: "echo test-vertex-token" } },
    gw: { type: "anthropic", baseUrl: "http://127.0.0.1:4000", auth: { type: "x-api-key", env: "TEST_GW_KEY" }, headers: { "x-extra": "1" } },
  },
  failover: { order: ["anthropic", "bedrock", "vertex", "gw"] },
}, {});

const client = {
  host: "127.0.0.1:8787", "x-api-key": "client-anthropic-key", authorization: "Bearer client-oauth-token",
  "anthropic-beta": "oauth-2025-04-20,interleaved-thinking", "anthropic-version": "2023-06-01",
  "x-autoroute-key": "local-secret", "content-type": "application/json",
};
const body = { model: "anthropic.claude-sonnet-5-5", stream: true, messages: [{ role: "user", content: "hi" }] };
const env = { TEST_BEDROCK_TOKEN: "test-bedrock-token", TEST_GW_KEY: "test-gw-key" };

test("passthrough keeps the caller's credentials but drops the local key", async () => {
  const r = await buildRequest(cfg, "anthropic", { pathname: "/v1/messages?beta=true", body, clientHeaders: client, env });
  assert.equal(r.url, "https://api.anthropic.com/v1/messages?beta=true");
  assert.equal(r.headers["x-api-key"], "client-anthropic-key");
  assert.equal(r.headers["anthropic-beta"], "oauth-2025-04-20,interleaved-thinking");
  assert.equal(r.headers["x-autoroute-key"], undefined);
  assert.equal(r.headers.host, undefined);
});

test("backups never receive the caller's Anthropic credentials", async () => {
  for (const p of ["bedrock", "vertex", "gw"]) {
    const r = await buildRequest(cfg, p, { pathname: "/v1/messages", body, clientHeaders: client, env });
    assert.notEqual(r.headers["x-api-key"], "client-anthropic-key", p);
    assert.ok(!String(r.headers.authorization || "").includes("client-oauth-token"), p);
    assert.ok(!String(r.headers["anthropic-beta"] || "").includes("oauth"), p);
    assert.equal(r.headers["x-autoroute-key"], undefined, p);
  }
});

test("bedrock: bearer token from env, Mantle URL, beta headers dropped", async () => {
  const r = await buildRequest(cfg, "bedrock", { pathname: "/v1/messages", body, clientHeaders: client, env });
  assert.equal(r.url, "https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages");
  assert.equal(r.headers.authorization, "Bearer test-bedrock-token");
  assert.equal(r.headers["anthropic-beta"], undefined);
});

test("gateway: x-api-key auth, custom headers, betas kept (minus oauth)", async () => {
  const r = await buildRequest(cfg, "gw", { pathname: "/v1/messages", body, clientHeaders: client, env });
  assert.equal(r.headers["x-api-key"], "test-gw-key");
  assert.equal(r.headers.authorization, undefined);
  assert.equal(r.headers["x-extra"], "1");
  assert.equal(r.headers["anthropic-beta"], "interleaved-thinking");
});

test("vertex: URL, body transform and command-based token", async () => {
  const r = await buildRequest(cfg, "vertex", { pathname: "/v1/messages", body: { ...body, model: "claude-opus-5-5" }, clientHeaders: client, env });
  assert.equal(r.url, "https://us-east5-aiplatform.googleapis.com/v1/projects/my-proj/locations/us-east5/publishers/anthropic/models/claude-opus-5-5:streamRawPredict");
  const sent = JSON.parse(r.body);
  assert.equal(sent.model, undefined);
  assert.equal(sent.anthropic_version, "vertex-2023-10-16");
  assert.equal(r.headers.authorization, "Bearer test-vertex-token");
});

test("missing env credential is a clear error", async () => {
  await assert.rejects(credential("bedrock", { env: "DEFINITELY_NOT_SET_123" }, {}), /DEFINITELY_NOT_SET_123 is not set/);
});

test("model mapping falls back to the nearest tier the provider has", () => {
  assert.deepEqual(providerModel(cfg, "bedrock", "opus"), { model: "anthropic.claude-opus-5-5", tier: "opus" });
  assert.deepEqual(providerModel(cfg, "bedrock", "haiku"), { model: "anthropic.claude-sonnet-5-5", tier: "sonnet" });
  assert.deepEqual(providerModel(cfg, "anthropic", "haiku"), { model: "claude-haiku-5-5", tier: "haiku" });
});
