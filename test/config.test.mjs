import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc, buildConfig, validateConfig } from "../src/config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("JSONC: comments and trailing commas are allowed; strings are left alone", () => {
  const v = parseJsonc(`{
    // line comment
    "url": "https://example.com/a//b", /* block */
    "s": "not /* a comment */",
    "list": [1, 2,],
  }`);
  assert.equal(v.url, "https://example.com/a//b");
  assert.equal(v.s, "not /* a comment */");
  assert.deepEqual(v.list, [1, 2]);
});

test("the shipped example config parses and validates", () => {
  const cfg = buildConfig(parseJsonc(fs.readFileSync(path.join(ROOT, "config.example.jsonc"), "utf8")), {});
  assert.deepEqual(validateConfig(cfg), []);
  assert.equal(cfg.failover.order[0], "anthropic");
});

test("defaults apply when no config exists", () => {
  const cfg = buildConfig({}, {});
  assert.deepEqual(validateConfig(cfg), []);
  assert.equal(cfg.providers.anthropic.auth.type, "passthrough");
  assert.equal(cfg.requireLocalKey, true);
  assert.equal(cfg.logPromptSnippets, false);
});

test("partial overrides merge with defaults", () => {
  const cfg = buildConfig({ switching: { returnProbability: 0.9 }, classifier: { type: "llm" } }, {});
  assert.equal(cfg.switching.returnProbability, 0.9);
  assert.equal(cfg.switching.expectedRequestsPerTurn, 4);
  assert.equal(cfg.classifier.type, "llm");
  assert.ok(cfg.classifier.opusKeywords.length > 10);
});

test("validation: passthrough auth on a backup is refused (would leak Anthropic credentials)", () => {
  const cfg = buildConfig({
    providers: {
      a: { type: "anthropic", baseUrl: "https://one.example.com", auth: { type: "bearer", env: "X" } },
      b: { type: "anthropic", baseUrl: "https://two.example.com", auth: { type: "passthrough" } },
    },
    failover: { order: ["a", "b"] },
  }, {});
  assert.ok(validateConfig(cfg).some((e) => e.includes("providers.b") && e.includes("credentials")));
});

test("validation catches common mistakes", () => {
  const cfg = buildConfig({
    providers: { v: { type: "vertex" }, g: { type: "anthropic", baseUrl: "http://x", auth: { type: "bearer" } } },
    failover: { order: ["v", "missing"] },
    classifier: { opusKeywords: ["("] },
  }, {});
  const errs = validateConfig(cfg).join("\n");
  assert.match(errs, /unknown provider "missing"/);
  assert.match(errs, /projectId is required/);
  assert.match(errs, /needs one of "keychain", "env", "command" or "value"/);
  assert.match(errs, /invalid regex/);
});

test("vertex providers get sensible defaults", () => {
  const cfg = buildConfig({ providers: { anthropic: { baseUrl: "https://api.anthropic.com" }, v: { type: "vertex", projectId: "p" } }, failover: { order: ["anthropic", "v"] } }, {});
  assert.equal(cfg.providers.v.region, "global");
  assert.equal(cfg.providers.v.auth.command, "gcloud auth print-access-token");
  assert.equal(cfg.providers.anthropic.auth.type, "passthrough");
  assert.deepEqual(validateConfig(cfg), []);
});

test("every example config parses and validates", () => {
  const dir = path.join(ROOT, "examples");
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".jsonc"))) {
    const cfg = buildConfig(parseJsonc(fs.readFileSync(path.join(dir, f), "utf8")), {});
    assert.deepEqual(validateConfig(cfg), [], f);
  }
});

test("validation: refuses to listen beyond this machine unless explicitly allowed", () => {
  assert.ok(validateConfig(buildConfig({ host: "0.0.0.0" }, {})).some((e) => e.includes("expose")));
  assert.deepEqual(validateConfig(buildConfig({ host: "0.0.0.0", allowNonLocalHost: true }, {})), []);
});
