#!/usr/bin/env node
// A stand-in for Claude Code in tests. Like the real one, it reads ANTHROPIC_BASE_URL and
// ANTHROPIC_CUSTOM_HEADERS, sends a tool-enabled streaming request, and prints the reply.
// FAKE_CLAUDE_LOGIN: "api-key" (default) | "subscription"
// FAKE_CLAUDE_MODE:  "ok" (default) | "ignore-base-url" | "hang" | "fail-haiku"
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
const mode = process.env.FAKE_CLAUDE_MODE || "ok";
if (mode === "hang") setInterval(() => {}, 1000);
else {
  const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "default";
  if (mode === "fail-haiku" && model === "haiku") { console.error("Error: model haiku is not available for your organization"); process.exit(1); }
  if (mode === "ignore-base-url") { console.log("AUTOROUTE-OK"); process.exit(0); }
  const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
  for (const line of (process.env.ANTHROPIC_CUSTOM_HEADERS || "").split("\n")) {
    const i = line.indexOf(":"); if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  if (process.env.FAKE_CLAUDE_LOGIN === "subscription") { headers.authorization = "Bearer sk-ant-oat01-" + "f".repeat(20); headers["anthropic-beta"] = "oauth-2025-04-20"; }
  else headers["x-api-key"] = "fake-api-key-for-tests";
  const prompt = args[args.indexOf("-p") + 1];
  const body = { model: model === "haiku" ? "claude-haiku-5-5" : "claude-opus-5-5", stream: true, max_tokens: 100,
    tools: [{ name: "Bash", description: "run", input_schema: { type: "object" } }], messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] };
  const res = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (res.status !== 200) { console.error(`API Error: ${res.status} ${text.slice(0, 200)}`); process.exit(1); }
  console.log("AUTOROUTE-OK");
}
