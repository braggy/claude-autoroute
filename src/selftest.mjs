// `autoroute selftest`: one real, tiny request through Claude Code and the router.
// It uses your own Claude Code and login exactly as daily use does, so it checks the
// parts unit tests can't: your login type, streaming, and that the router saw it.
import { spawn, execFile } from "node:child_process";
import path from "node:path";
import { ROOT, VERSION, onPath, routerStatus, startDaemon, proxyVar, envProxySupported } from "./util.mjs";
import { statuslineState } from "./setup.mjs";

export const SELFTEST_PROMPT = "This is a connection test. Reply with exactly: AUTOROUTE-OK";
const LOGIN = { "api-key": "Claude API key", subscription: "Claude Team/Enterprise (subscription) login", token: "gateway or auth token", none: "unknown" };

function run(cmd, args, { env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", timedOut = false;
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.on("error", (e) => { clearTimeout(t); resolve({ code: 1, out, err: err + e.message, timedOut }); });
    child.on("close", (code) => { clearTimeout(t); resolve({ code: code ?? 1, out, err, timedOut }); });
  });
}

const version = (bin, env) => new Promise((resolve) =>
  execFile(bin, ["--version"], { env, timeout: 15000 }, (e, out) => resolve(e ? null : String(out).trim().split("\n")[0])));

/**
 * Returns { ok, steps: [{ ok, label, detail, fix }], loginType }.
 * print(line) is called as each step finishes, so a person sees progress.
 */
export async function selftest({ cfg, home, env = process.env, print = () => {}, timeoutMs = 120000 } = {}) {
  const steps = [];
  const step = (ok, label, detail = "", fix = "") => {
    steps.push({ ok, label, detail, fix });
    print(`${ok === true ? "  ok  " : ok === null ? "  --  " : "  FAIL"} ${label}${detail ? `: ${detail}` : ""}${fix ? `\n         -> ${fix}` : ""}`);
    return ok;
  };
  const finish = (loginType = null) => ({ ok: steps.every((s) => s.ok !== false), steps, loginType });

  step(true, `autoroute ${VERSION}`, `config is valid`);

  const claude = env.AUTOROUTE_CLAUDE_BIN || onPath("claude", env);
  if (!claude) return (step(false, "Claude Code", "`claude` isn't on your PATH", "Install Claude Code first: https://code.claude.com/docs/en/setup"), finish());
  const v = await version(claude, env);
  step(!!v, "Claude Code", v || "found, but `claude --version` failed", v ? "" : "Run `claude` once on its own to finish setting it up");
  if (!v) return finish();

  if (proxyVar(env)) {
    if (!step(envProxySupported() ? true : false, "Company proxy", envProxySupported() ? "HTTPS_PROXY will be used" : `set, but Node ${process.versions.node} can't use it`,
      envProxySupported() ? "" : "Install Node.js 22.21+ or 24.5+ from https://nodejs.org, then run ./install.sh again")) return finish();
  }
  if (!(await startDaemon(cfg, home, env))) {
    return (step(false, "Router", "didn't start", `See ${path.join(home, "router.out")}. Another program may be using port ${cfg.port}.`), finish());
  }
  step(true, "Router", `running on http://${cfg.host}:${cfg.port}`);
  const before = await routerStatus(cfg.port, cfg.host, home);
  if (!before) return (step(false, "Router status", "no answer with the local key", "Run: autoroute restart"), finish());

  print("  ...  Sending one tiny message through Claude Code (a few seconds; costs well under a cent)");
  const attempt = (extra) => run(process.execPath, [path.join(ROOT, "bin", "claude-auto.mjs"), "-p", SELFTEST_PROMPT, ...extra],
    { env: { ...env, AUTOROUTE_HOME: home }, timeoutMs });
  // Haiku keeps the test cheap. If your organization doesn't allow it, use your default model.
  let r = await attempt(["--model", "haiku"]);
  if ((r.code !== 0 || !r.out.includes("AUTOROUTE-OK")) && !r.timedOut && (await routerStatus(cfg.port, cfg.host, home))?.blocked !== "subscription") r = await attempt([]);
  const after = (await routerStatus(cfg.port, cfg.host, home)) || {};
  const login = after.loginType || "none";
  const seen = (after.messagesSeen || 0) > (before.messagesSeen || 0);
  const decided = !!after.last && after.last.at !== before.last?.at;

  if (after.blocked === "subscription") {
    step(false, "Your login", LOGIN.subscription,
      "autoroute refused it, because Team/Enterprise logins need your admin's approval first. Once approved, run: autoroute setup --login enterprise --admin-approved");
    return finish(login);
  }
  if (r.timedOut) return (step(false, "Test message", `no reply within ${Math.round(timeoutMs / 1000)} s`, "Check your network, then run `claude` on its own to see if it works without autoroute"), finish(login));
  if (r.code !== 0 || !r.out.includes("AUTOROUTE-OK")) {
    const msg = (r.err || r.out).trim().split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300) || `exit code ${r.code}`;
    return (step(false, "Test message", msg, "Run `claude -p hello` without autoroute. If that also fails, it's a Claude Code or login problem; if not, send the output of `autoroute diagnostics`."), finish(login));
  }
  step(true, "Test message", "Claude Code replied through the router");
  const how = !decided ? "Claude Code's choice kept (Haiku requests aren't re-routed)"
    : `${after.last.shadow ? "shadow mode: kept" : "routed to"} ${after.last.local ? "local model" : after.last.tier} via ${after.last.provider}`;
  step(seen, "Router saw it", seen ? how : "the reply didn't go through the router",
    seen ? "" : "Check ANTHROPIC_BASE_URL isn't forced elsewhere in your shell or Claude Code settings");
  step(login !== "none", "Your login", LOGIN[login] || login);
  const sl = statuslineState(env);
  step(sl === "installed" ? true : null, "Status line", { installed: "installed", other: "you have your own status line (left alone)", none: "not installed (optional)" }[sl],
    sl === "none" ? "See each pick as it happens: autoroute statusline install" : "");
  return finish(login);
}
