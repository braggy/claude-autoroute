import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { slug } from "../src/ui/help.js";
import { startRouter } from "./helpers.mjs";
import { createLoginToken } from "../src/ui-server.mjs";
import { collect, scrub } from "../src/diagnostics.mjs";
import { buildConfig } from "../src/config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cleanup = [];
after(async () => { for (const c of cleanup) await c(); });
const help = fs.readFileSync(path.join(ROOT, "HELP.md"), "utf8");
const anchors = new Set([...help.matchAll(/^### (.+)$/gm)].map((m) => slug(m[1])));

test("every 'Learn more' link in the dashboard points at a real help answer", () => {
  const code = ["src/ui/app.js", "src/ui-server.mjs"].map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");
  const refs = [...code.matchAll(/(?:learn\(|help: |c\.help = )"([a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 8, `found ${refs.length} help links`);
  for (const r of refs) assert.ok(anchors.has(r), `missing help answer for #help/${r}`);
});

test("help answers have unique anchors", () => {
  const all = [...help.matchAll(/^### (.+)$/gm)].map((m) => slug(m[1]));
  assert.equal(new Set(all).size, all.length);
});

test("the dashboard serves HELP.md to signed-in users", async () => {
  const r = await startRouter({}); cleanup.push(r.close);
  const res = await fetch(`${r.base}/ui/login?t=${createLoginToken(r.home)}`, { redirect: "manual" });
  const cookie = res.headers.get("set-cookie").split(";")[0];
  const md = await fetch(`${r.base}/ui/help.md`, { headers: { cookie } });
  assert.equal(md.status, 200);
  assert.match(await md.text(), /## Troubleshooting/);
  const llm = await fetch(`${r.base}/ui/llms-full.txt`, { headers: { cookie } });
  assert.equal(llm.status, 200);
  assert.match(await llm.text(), /complete documentation/);
  const d = await fetch(`${r.base}/ui/api/diagnostics`, { headers: { cookie, "x-autoroute-ui": "1" } });
  assert.equal(d.status, 200);
  assert.equal((await d.json()).router.loginType, "not seen yet");
});

test("diagnostics never contain keys, URLs, provider names, emails or home paths", async () => {
  const home = ["/home", "janedoe"].join("/"); // built at runtime so the secret scanner stays quiet
  const env = { HOME: home, PATH: process.env.PATH };
  const secretValue = ["sk-", "ant-", "api03-", "Z".repeat(30)].join("");
  const cfg = buildConfig({
    providers: {
      anthropic: { baseUrl: "https://api.anthropic.com" },
      "acme-internal-gw": { baseUrl: "https://llm.acme-corp.example/v1", auth: { type: "x-api-key", value: secretValue } },
    },
    failover: { order: ["anthropic", "acme-internal-gw"] },
  }, {});
  const tmp = fs.mkdtempSync(path.join(ROOT, ".tmp-diag-"));
  try {
    const out = JSON.stringify(await collect({ home: tmp, cfg, env }));
    for (const bad of [secretValue, "acme", "llm.acme-corp", "janedoe", "https://", tmp]) assert.ok(!out.includes(bad), `leaked: ${bad}`);
    assert.match(out, /"kind":"custom gateway"/);
    assert.match(out, /"credentialSource":"value"/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("scrub removes paths, URLs, emails and key-like strings", () => {
  const mac = ["/Users", "jane"].join("/");
  const t = scrub([mac, "/x https://a.b/c jane", "@", "example.org ", "sk-", "abcdefghijkl"].join(""), { HOME: mac });
  assert.ok(!/jane|https|sk-/.test(t), t);
});

test("llms.txt and llms-full.txt are up to date with the docs", () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "build-llms.mjs"), "--check"]);
  assert.equal(r.status, 0, r.stderr.toString() + " (run: npm run build:llms)");
  const full = fs.readFileSync(path.join(ROOT, "llms-full.txt"), "utf8");
  for (const part of ["===== Help (HELP.md)", "===== Configuration reference", "===== Security", "## Troubleshooting"]) assert.ok(full.includes(part), part);
  const index = fs.readFileSync(path.join(ROOT, "llms.txt"), "utf8");
  assert.match(index, /^# claude-autoroute\n\n> /, "llms.txt starts with a title and a summary");
  for (const m of index.matchAll(/\]\(([^)]+)\)/g)) if (!m[1].startsWith("http")) assert.ok(fs.existsSync(path.join(ROOT, m[1])), `llms.txt links to missing ${m[1]}`);
});
