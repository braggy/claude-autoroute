// Test helpers: a mock Anthropic-style upstream and a router on a random port.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildConfig } from "../src/config.mjs";
import { createRouter } from "../src/server.mjs";

// behavior(req, body) may return { status, json } / { status, sse: true } / "hangup".
export async function mockUpstream(behavior = () => ({ status: 200, sse: true })) {
  const calls = [];
  const cache = {};
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      let body = null; try { body = JSON.parse(b); } catch {}
      const call = { url: req.url, headers: req.headers, body };
      calls.push(call);
      const r = behavior(call) || { status: 200, sse: true };
      if (r === "hangup") return req.socket.destroy();
      if (r.sse) {
        const model = body?.model || "vertex-model";
        const P = Math.round(b.length / 4);
        const prev = cache[model] || 0; cache[model] = P;
        const read = Math.min(prev, P);
        const usage = { input_tokens: 5, cache_read_input_tokens: read, cache_creation_input_tokens: Math.max(0, P - read - 5), output_tokens: 1 };
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model, usage } })}\n\n`);
        res.end(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 1500 } })}\n\n`);
        return;
      }
      res.writeHead(r.status || 200, { "content-type": "application/json" });
      res.end(JSON.stringify(r.json ?? {}));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, calls, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

export function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "autoroute-test-"));
}

// Policy files live in a temp folder so a developer's real Claude Code settings never affect tests.
export function policyPaths(dir = tmpHome()) {
  return { managedFile: path.join(dir, "managed-settings.json"), managedDropIns: path.join(dir, "managed-settings.d"),
           serverManaged: path.join(dir, "remote-settings.json"), user: path.join(dir, "user-settings.json"), dir };
}

export async function startRouter(userConfig, env = {}, { policy = policyPaths() } = {}) {
  const home = tmpHome();
  // Keep the config file in step with the in-memory config, as in real use.
  fs.writeFileSync(path.join(home, "config.jsonc"), JSON.stringify(userConfig || {}), { mode: 0o600 });
  const cfg = buildConfig(userConfig, env);
  const server = createRouter({ cfg, home, env, policyPaths: policy });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const key = server.ctx.localKey;
  async function post(body, headers = {}, pathname = "/v1/messages") {
    const res = await fetch(base + pathname, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { "x-autoroute-key": key } : {}), ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, model: res.headers.get("x-autoroute-model"), provider: res.headers.get("x-autoroute-provider") };
  }
  const close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  return { server, base, home, post, close, cfg };
}

export const TOOLS = [{ name: "Bash", description: "run a command", input_schema: { type: "object" } }];
export const userMsg = (text) => ({ role: "user", content: [{ type: "text", text: `<system-reminder>ctx</system-reminder>${text}` }] });
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll until check() is truthy. Use instead of fixed sleeps so slow CI machines don't flake.
export async function until(check, { timeoutMs = 3000, everyMs = 10, what = "condition" } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await wait(everyMs);
  }
}
