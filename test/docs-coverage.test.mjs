// Docs can't fall behind the code: new settings, commands and doc files must be
// documented before the build passes. Whatever is documented flows into llms-full.txt.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "../src/config.mjs";
import { DOCS, OPTIONAL } from "../scripts/build-llms.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

test("every setting is documented in config.example.jsonc", () => {
  const example = read("config.example.jsonc");
  const missing = [];
  (function walk(obj, prefix) {
    for (const [k, v] of Object.entries(obj)) {
      if (!example.includes(`"${k}"`)) missing.push(prefix + k);
      // prices/models/providers are data tables, not settings to explain one by one
      if (v && typeof v === "object" && !Array.isArray(v) && !["prices", "models", "providers"].includes(k)) walk(v, prefix + k + ".");
    }
  })(DEFAULTS, "");
  assert.deepEqual(missing, [], "add these to config.example.jsonc (then: npm run build:llms)");
});

test("every command is in the README's command table", () => {
  const src = read("bin/autoroute.mjs");
  const usage = src.slice(src.indexOf("Usage: autoroute"), src.indexOf("Run Claude Code through"));
  const commands = [...new Set([...usage.matchAll(/^ {2}([a-z]+)/gm)].map((m) => m[1]))].filter((c) => c !== "serve");
  const readme = read("README.md");
  assert.deepEqual(commands.filter((c) => !readme.includes(`autoroute ${c}`)), [], "document these commands in the README");
});

test("every user-facing doc is included in the files for AI assistants", () => {
  const listed = new Set([...DOCS, ...OPTIONAL].map(([f]) => f));
  const docs = fs.readdirSync(ROOT).filter((f) => f.endsWith(".md"));
  assert.deepEqual(docs.filter((f) => !listed.has(f)), [], "add these to DOCS or OPTIONAL in scripts/build-llms.mjs");
});

test("every quick setting and priority is explained in the help", () => {
  const help = read("HELP.md");
  for (const word of ["autoroute pause", "autoroute local on", "autoroute provider", "autoroute priority", "Lowest cost", "Balanced", "Fastest", "Best quality"]) {
    assert.ok(help.includes(word), `HELP.md should explain "${word}"`);
  }
});

test("the GitHub workflow regenerates the AI files whenever any of their sources change", () => {
  const wf = read(".github/workflows/llms.yml");
  const watched = [...wf.slice(wf.indexOf("paths:"), wf.indexOf("workflow_dispatch")).matchAll(/^\s+- (\S+)$/gm)].map((m) => m[1]);
  const sources = [...DOCS, ...OPTIONAL].map(([f]) => f).filter((f) => !f.endsWith("/"));
  assert.deepEqual(sources.filter((f) => !watched.includes(f)), [], "add these to the workflow's paths");
  for (const f of ["scripts/build-llms.mjs", "package.json"]) assert.ok(watched.includes(f), f);
  assert.match(wf, /permissions:\s*\n\s*contents: write/, "write access is limited to repository contents");
  assert.ok(!/pull_request/.test(wf), "never runs for pull requests (fork code must not get write access)");
});
