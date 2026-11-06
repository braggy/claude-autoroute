import { test } from "node:test";
import assert from "node:assert/strict";
import { scanText, scan } from "../scripts/check-secrets.mjs";

// Fake secrets are assembled at runtime so this file itself stays clean.
const j = (...p) => p.join("");

test("detects keys, tokens, emails and home paths", () => {
  const samples = [
    j("sk-", "ant-", "api03-", "A".repeat(30)),
    j("AKIA", "ABCDEFGHIJKLMNOP"),
    j("AIza", "B".repeat(35)),
    j("ghp_", "C".repeat(36)),
    j("-----BEGIN ", "RSA PRIVATE KEY-----"),
    j("jane.doe", "@", "gmail.com"),
    j("/Users/", "janedoe", "/projects"),
    j("/home/", "jdoe", "/.ssh"),
  ];
  for (const s of samples) assert.equal(scanText(`x = "${s}"`).length > 0, true, s);
});

test("allows placeholders and explicit opt-outs", () => {
  assert.equal(scanText("contact: someone@example.com").length, 0);
  assert.equal(scanText("path: /Users/you/project").length, 0);
  assert.equal(scanText(j("token ", "sk-", "ant-", "X".repeat(30), " // check-secrets: allow")).length, 0);
});

test("the repository itself contains nothing personal or secret", () => {
  assert.deepEqual(scan(), []);
});
