// Fixes from the 2026-11 engineering review: each test pins one defect so it can't come back.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseJsonc, buildConfig, validateConfig } from "../src/config.mjs";
import { inspect, sessionSalt } from "../src/classify.mjs";
import { rotateIfLarge } from "../src/server.mjs";
import { Stats, summarize } from "../src/stats.mjs";
import { readAll, TooLargeError } from "../src/upstream.mjs";
import { Readable } from "node:stream";
import { mockUpstream, startRouter, tmpHome, TOOLS, userMsg, until } from "./helpers.mjs";

const cleanup = [];
after(async () => { for (const c of cleanup) await c(); });

// ------------------------------------------------------------------ JSONC ---
test("JSONC: trailing commas are removed, but commas inside strings are kept", () => {
  const text = `{
    "a": "x, ]",          // comma-bracket inside a string
    "b": "y,}",
    "re": "(a,|b,)",
    "list": [1, 2, ],
    "nested": { "k": "v", },
    "esc": "quote \\" , ]",
  }`;
  assert.deepEqual(parseJsonc(text), { a: "x, ]", b: "y,}", re: "(a,|b,)", list: [1, 2], nested: { k: "v" }, esc: 'quote " , ]' });
});

test("JSONC: a regex setting with ',]' survives a round trip through the config", () => {
  const cfg = buildConfig(parseJsonc(`{ "classifier": { "followUpPattern": "^(ok|yes)[,!. ]*$", }, }`));
  assert.equal(cfg.classifier.followUpPattern, "^(ok|yes)[,!. ]*$");
  assert.ok(cfg._re.follow.test("ok, "));
});

// ----------------------------------------------------------------- limits ---
test("limits: defaults are present and validated", () => {
  const cfg = buildConfig({});
  assert.deepEqual(cfg.limits, { maxRequestMB: 50, logMB: 5, statsDays: 90 });
  assert.deepEqual(validateConfig(cfg), []);
  for (const bad of [0, -1, "5", null]) {
    const errs = validateConfig(buildConfig({ limits: { logMB: bad } }));
    assert.ok(errs.some((e) => e.includes("limits.logMB")), `rejects ${JSON.stringify(bad)}`);
  }
});

test("readAll refuses bodies over the limit and still drains the stream", async () => {
  const src = Readable.from([Buffer.alloc(600), Buffer.alloc(600)]);
  await assert.rejects(readAll(src, 1000), TooLargeError);
  assert.equal((await readAll(Readable.from([Buffer.from("ok")]), 10)).toString(), "ok");
});

test("an oversized request gets HTTP 413 and never reaches a provider", async () => {
  const up = await mockUpstream();
  const r = await startRouter({ providers: { anthropic: { baseUrl: up.url } }, limits: { maxRequestMB: 0.01 } });
  cleanup.push(up.close, r.close);
  const big = await r.post({ model: "claude-opus-5-5", tools: TOOLS, messages: [userMsg("x".repeat(20000))] });
  assert.equal(big.status, 413);
  assert.match(big.text, /limits\.maxRequestMB/);
  assert.equal(up.calls.length, 0);
  const small = await r.post({ model: "claude-opus-5-5", tools: TOOLS, stream: true, messages: [userMsg("git status")] });
  assert.equal(small.status, 200, "the router keeps working after a refusal");
});

// ---------------------------------------------------------- conversations ---
test("sessionSalt prefers Claude Code's session header, then metadata.user_id", () => {
  assert.equal(sessionSalt({ metadata: { user_id: "u1" } }, { "x-claude-code-session-id": "s1" }), "s1");
  assert.equal(sessionSalt({ metadata: { user_id: "u1" } }, {}), "u1");
  assert.equal(sessionSalt({}, {}), "");
});

test("two sessions that open with the same message don't share routing state", async () => {
  const msgs = [userMsg("fix the failing test")];
  assert.notEqual(inspect(msgs, "session-a").convKey, inspect(msgs, "session-b").convKey);
  assert.equal(inspect(msgs, "session-a").convKey, inspect(msgs, "session-a").convKey);

  const up = await mockUpstream();
  const r = await startRouter({ providers: { anthropic: { baseUrl: up.url } } });
  cleanup.push(up.close, r.close);
  const send = (session) => r.post({ model: "claude-opus-5-5", tools: TOOLS, stream: true, messages: msgs, metadata: { user_id: session } });
  await send("user_x_session_aaaa"); await send("user_x_session_bbbb"); await send("user_x_session_aaaa");
  assert.equal(r.server.ctx.convs.size, 2);
});

// ------------------------------------------------------------ housekeeping ---
test("router.log rotates to router.log.1 past limits.logMB", () => {
  const home = tmpHome(), file = path.join(home, "router.log");
  fs.writeFileSync(file, "x".repeat(2048));
  rotateIfLarge(file, 0.001); // ~1 KB
  assert.ok(!fs.existsSync(file));
  assert.equal(fs.readFileSync(file + ".1", "utf8").length, 2048);
  fs.writeFileSync(file, "small");
  rotateIfLarge(file, 0.001);
  assert.equal(fs.readFileSync(file, "utf8"), "small", "small logs are left alone");
  rotateIfLarge(path.join(home, "missing.log"), 1); // no throw
});

test("stats.jsonl keeps limits.statsDays of history without losing lifetime totals", () => {
  const home = tmpHome(), file = path.join(home, "stats.jsonl");
  const old = Date.now() - 100 * 864e5, recent = Date.now() - 864e5;
  const row = (ts) => JSON.stringify({ kind: "turn", ts, date: new Date(ts).toISOString().slice(0, 10), tier: "haiku", originalTier: "opus", newTurn: true, actual: 1, baseline: 3 });
  fs.writeFileSync(file, [row(old), row(old), row(recent)].join("\n") + "\n");
  const s = new Stats(home, { keepDays: 90 });
  const kept = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(kept.length, 1, "rows older than 90 days are dropped");
  assert.equal(s.lifetime.messages, 3, "lifetime still counts them");
  const onDisk = JSON.parse(fs.readFileSync(path.join(home, "totals.json"), "utf8"));
  assert.equal(onDisk.messages, 3, "lifetime totals were saved before pruning");
  assert.equal(new Stats(home, { keepDays: 90 }).lifetime.messages, 3, "and survive a restart");
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600");
});

// ------------------------------------------------------------------ regret ---
async function regretRouter() {
  const up = await mockUpstream();
  const r = await startRouter({ providers: { anthropic: { baseUrl: up.url } } });
  cleanup.push(up.close, r.close);
  const msgs = [];
  const say = async (text) => {
    msgs.push(userMsg(text));
    const before = r.server.ctx.stats.lifetime.requests;
    const res = await r.post({ model: "claude-opus-5-5", tools: TOOLS, stream: true, messages: [...msgs] });
    msgs.push({ role: "assistant", content: [{ type: "text", text: "done" }] });
    await until(() => r.server.ctx.stats.lifetime.requests > before, { what: "usage to be recorded" });
    return res;
  };
  return { r, say, lifetime: () => summarize(r.server.ctx.stats.lifetime) };
}

test("regret: overriding upward right after a cheaper pick is counted", async () => {
  const { say, lifetime } = await regretRouter();
  assert.equal((await say("git status")).model, "claude-haiku-5-5");
  assert.equal((await say("!opus explain why the build fails")).model, "claude-opus-5-5");
  const v = lifetime();
  assert.equal(v.regrets, 1);
  assert.equal(v.downgraded, 1);
  assert.equal(v.regretRate, 100);
});

test("regret: overrides that aren't a correction are not counted", async () => {
  const { say, lifetime } = await regretRouter();
  await say("!opus design the cache layer");   // first message: nothing to regret
  await say("!sonnet now rename it");          // previous was forced, not the router's pick
  await say("git status");                      // router downgrade
  await say("!haiku list files");              // overriding downward isn't a regret
  assert.equal(lifetime().regrets, 0);
});

// -------------------------------------------------------------- structure ---
test("src has no circular imports", () => {
  const dir = new URL("../src/", import.meta.url).pathname;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".mjs"));
  const graph = Object.fromEntries(files.map((f) => {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    return [f, [...text.matchAll(/^import .* from "\.\/([\w-]+\.mjs)";$/gm)].map((m) => m[1])];
  }));
  const seen = new Set(), stack = [];
  const visit = (f) => {
    if (stack.includes(f)) assert.fail("import cycle: " + [...stack.slice(stack.indexOf(f)), f].join(" -> "));
    if (seen.has(f)) return;
    stack.push(f); for (const d of graph[f] || []) visit(d); stack.pop(); seen.add(f);
  };
  for (const f of files) visit(f);
});

test("no module imports the same file twice", () => {
  for (const base of ["../src/", "../bin/"]) {
    const dir = new URL(base, import.meta.url).pathname;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".mjs"))) {
      const deps = [...fs.readFileSync(path.join(dir, f), "utf8").matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
      assert.equal(new Set(deps).size, deps.length, `${base}${f} has duplicate imports`);
    }
  }
});

// ---------------------------------------------------------------- CI / CD ---
test("workflows: every action is pinned to a commit SHA, and every job has a timeout", () => {
  const dir = new URL("../.github/workflows/", import.meta.url).pathname;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".yml"))) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    for (const [, ref] of text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
      assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${f}: ${ref} must be pinned to a full commit SHA`);
    }
    const jobs = text.split(/^jobs:\s*$/m)[1] || "";
    const jobNames = [...jobs.matchAll(/^  ([\w-]+):\s*$/gm)].map((m) => m[1]);
    assert.ok(jobNames.length, `${f} has jobs`);
    assert.equal((jobs.match(/^    timeout-minutes:\s*\d+/gm) || []).length, jobNames.length, `${f}: every job needs timeout-minutes`);
    assert.match(text, /^permissions:/m, `${f}: top-level permissions must be explicit`);
  }
});

// ----------------------------------------------------------- company proxy ---
import { envProxySupported, daemonEnv, startDaemon, stopDaemon } from "../src/util.mjs";
import http from "node:http";
import net from "node:net";

test("proxy: Node versions that can use HTTPS_PROXY, and the router's environment", () => {
  for (const [v, ok] of [["20.19.0", false], ["22.20.0", false], ["22.21.0", true], ["23.1.0", true], ["24.4.0", false], ["24.5.0", true], ["26.0.0", true]]) {
    assert.equal(envProxySupported(v), ok, v);
  }
  assert.equal(daemonEnv({ HTTPS_PROXY: "http://proxy:8080" }, "/h").NODE_USE_ENV_PROXY, "1");
  assert.equal(daemonEnv({ https_proxy: "http://proxy:8080" }, "/h").NODE_USE_ENV_PROXY, "1");
  assert.equal(daemonEnv({}, "/h").NODE_USE_ENV_PROXY, undefined, "no proxy, no change");
  assert.equal(daemonEnv({ HTTPS_PROXY: "x", NODE_USE_ENV_PROXY: "0" }, "/h").NODE_USE_ENV_PROXY, "0", "an explicit choice is kept");
  assert.equal(daemonEnv({}, "/h").AUTOROUTE_HOME, "/h");
});

test("proxy: the background router sends provider requests through HTTP_PROXY", { skip: !envProxySupported() && "needs Node 22.21+ or 24.5+" }, async () => {
  const up = await mockUpstream();
  let viaProxy = 0;
  // A tiny forward proxy that sends every request to the mock provider.
  const proxy = http.createServer((req, res) => {
    viaProxy++;
    const f = http.request({ host: "127.0.0.1", port: new URL(up.url).port, path: new URL(req.url).pathname, method: req.method, headers: req.headers },
      (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    f.on("error", () => res.destroy());
    req.pipe(f);
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const s = net.createServer(); await new Promise((r) => s.listen(0, "127.0.0.1", r)); const port = s.address().port; await new Promise((r) => s.close(r));
  const home = tmpHome();
  const user = { port, providers: { anthropic: { baseUrl: "http://provider.example.invalid" } } };
  fs.writeFileSync(path.join(home, "config.jsonc"), JSON.stringify(user));
  const cfg = buildConfig(user);
  cleanup.push(up.close, () => new Promise((r) => proxy.close(r)), () => stopDaemon(cfg, home));
  const env = { PATH: process.env.PATH, HOME: home, HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`, NO_PROXY: "127.0.0.1,localhost" };
  assert.ok(await startDaemon(cfg, home, env), "router started");
  const key = fs.readFileSync(path.join(home, "local-key"), "utf8").trim();
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-autoroute-key": key, "x-api-key": "k" },
    body: JSON.stringify({ model: "claude-opus-5-5", tools: TOOLS, stream: true, messages: [userMsg("git status")] }) });
  assert.equal(res.status, 200, await res.text());
  assert.ok(viaProxy >= 1, "the request went through the proxy");
  assert.equal(up.calls.length, 1);
});
