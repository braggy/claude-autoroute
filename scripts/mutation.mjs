#!/usr/bin/env node
// Mutation check for the code that must never regress: security boundaries, policy
// compliance and money maths. Each mutation puts a realistic bug back into a scratch
// copy of the repo and runs the related tests, which MUST fail. A mutation that
// "survives" means the tests can't see that bug, and this script exits non-zero.
//
//   npm run test:mutation            all mutations
//   npm run test:mutation -- local   only mutations whose name contains "local"
//
// Zero dependencies, and it never modifies the working tree.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const MUTATIONS = [
  // --- security boundaries
  { name: "proxy: local key not checked", file: "src/server.mjs", from: "if (ctx.localKey && !sameSecret(req.headers[LOCAL_KEY_HEADER], ctx.localKey)) {", to: "if (false) {", tests: ["proxy"] },
  { name: "backups: Claude credentials not stripped", file: "src/providers.mjs", from: "for (const h of CREDENTIAL_HEADERS) delete headers[h];", to: "", tests: ["providers", "proxy"] },
  { name: "backups: oauth beta not stripped", file: "src/providers.mjs", from: "filter((s) => s && !/^oauth-/.test(s))", to: "filter((s) => s)", tests: ["providers", "proxy"] },
  { name: "local key forwarded upstream", file: "src/providers.mjs", from: "if (HOP_HEADERS.includes(key) || key === LOCAL_KEY_HEADER) continue;", to: "if (HOP_HEADERS.includes(key)) continue;", tests: ["providers", "proxy"] },
  { name: "dashboard: Host check off (DNS rebinding)", file: "src/ui-server.mjs", from: "if (!allowedHost(req)) return", to: "if (false) return", tests: ["ui"] },
  { name: "dashboard: CSRF header not required", file: "src/ui-server.mjs", from: `if (req.headers["x-autoroute-ui"] !== "1")`, to: "if (false)", tests: ["ui"] },
  { name: "dashboard: Origin not checked", file: "src/ui-server.mjs", from: "if (!origin || origin.toLowerCase() !==", to: "if (false && origin.toLowerCase() !==", tests: ["ui"] },
  { name: "help: javascript: links allowed", file: "src/ui/help.js", from: `if (/^https:\\/\\//.test(href) || href.startsWith("#help/"))`, to: "if (true)", tests: ["help-render"] },
  { name: "oversized requests accepted", file: "src/upstream.mjs", from: "if (size > maxBytes)", to: "if (false)", tests: ["hardening"] },
  // --- policy compliance
  { name: "policy: subscription login forwarded", file: "src/policy.mjs", from: `return cfg.subscriptionLogin === "allow-team-enterprise";`, to: "return true;", tests: ["policy", "proxy"] },
  { name: "policy: model prefix matching", file: "src/policy.mjs", from: "return id === e || id.endsWith(\".\" + e);", to: "return id.startsWith(e) || id.endsWith(\".\" + e);", tests: ["policy"] },
  { name: "policy: override bypasses org list", file: "src/server.mjs", from: "if (!allowed.includes(pick.tier) && requested) {", to: "if (!forced && !allowed.includes(pick.tier) && requested) {", tests: ["policy"] },
  // --- money and routing
  { name: "cost: downgrade ignores cache rebuild", file: "src/cost.mjs", from: "const net = perTurn * turns - build - comeBack;", to: "const net = perTurn * turns;", tests: ["classify-cost", "proxy"] },
  { name: "cost: upgrade cap ignored", file: "src/cost.mjs", from: "if (rebuild <= cfg.switching.maxUpgradeCacheCostUSD) {", to: "if (true) {", tests: ["classify-cost", "proxy"] },
  { name: "stats: baseline prices rebuilds as reads off", file: "src/server.mjs", from: "baseline = costOf(baseTable, u, d.c.ttl1h, cacheMiss)", to: "baseline = costOf(baseTable, u, d.c.ttl1h, false)", tests: ["proxy", "stats"] },
  { name: "turn: tool loop not kept on one model", file: "src/server.mjs", from: "if (c.promptKey === promptKey && c.decision) return", to: "if (false) return", tests: ["proxy"] },
  { name: "regret not counted", file: "src/server.mjs", from: "const regret = !!(!cfg.shadow && forced", to: "const regret = false && !!(!cfg.shadow && forced", tests: ["hardening"] },
  { name: "sessions share state", file: "src/classify.mjs", from: `sha(salt + "\\u0000" + first.slice(0, 2000))`, to: "sha(first.slice(0, 2000))", tests: ["hardening"] },
  // --- first run
  { name: "shadow mode changes the model", file: "src/server.mjs", from: "tier = d.shadow ? originalTier : d.tier;", to: "tier = d.tier;", tests: ["firstrun"] },
  { name: "shadow estimate skips cache rebuilds", file: "src/server.mjs", from: "const hyp = cacheMiss ?", to: "const hyp = false ?", tests: ["firstrun"] },
  { name: "shadow calls the local model", file: "src/server.mjs", from: "if (d?.local && !d.shadow) {", to: "if (d?.local) {", tests: ["firstrun"] },
  { name: "router ignores company proxy", file: "src/util.mjs", from: `if (proxyVar(env) && !env.NODE_USE_ENV_PROXY) out.NODE_USE_ENV_PROXY = "1";`, to: "", tests: ["hardening"] },
  { name: "setup allows Enterprise without approval", file: "src/setup-wizard.mjs", from: `next.subscriptionLogin = "refuse";`, to: `next.subscriptionLogin = "allow-team-enterprise";`, tests: ["firstrun"] },
  { name: "selftest misses refusals", file: "src/selftest.mjs", from: `if (after.blocked === "subscription") {`, to: "if (false) {", tests: ["firstrun"] },
  // --- housekeeping
  { name: "JSONC eats commas in strings", file: "src/config.mjs", from: "  return stripTrailingCommas(out);", to: `  return out.replace(/,(\\s*[}\\]])/g, "$1");`, tests: ["hardening", "config"] },
  { name: "stats never pruned", file: "src/stats.mjs", from: "    if (!rows.some((r) => r.ts < cutoff)) return;", to: "    return;", tests: ["hardening"] },
  { name: "log never rotated", file: "src/server.mjs", from: `fs.renameSync(file, file + ".1")`, to: "void 0", tests: ["hardening"] },
  { name: "stop signals an unrelated process", file: "src/util.mjs", from: "if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;", to: "return true;", tests: ["util"] },
];

function copyRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoroute-mutant-"));
  for (const entry of ["bin", "src", "test", "scripts", "assets", "examples", "package.json", "config.example.jsonc",
    "README.md", "HELP.md", "SECURITY.md", "CHANGELOG.md", "CONTRIBUTING.md", "LICENSE", "llms.txt", "llms-full.txt", ".github", ".githooks"]) {
    const from = path.join(ROOT, entry);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dir, entry), { recursive: true });
  }
  return dir;
}

function testsPass(dir, tests) {
  const files = tests.map((t) => `test/${t}.test.mjs`).filter((f) => fs.existsSync(path.join(dir, f)));
  try {
    execFileSync(process.execPath, ["--test", ...files], { cwd: dir, stdio: "ignore", timeout: 120000, env: { ...process.env, NODE_V8_COVERAGE: "" } });
    return true;
  } catch { return false; }
}

export function run(filter = "") {
  const selected = MUTATIONS.filter((m) => m.name.includes(filter));
  const pristine = copyRepo();
  try {
    let survived = 0, missing = 0;
    for (const m of selected) {
      const file = path.join(pristine, m.file);
      const original = fs.readFileSync(file, "utf8");
      if (!original.includes(m.from)) {
        if (m.optional) { console.log(`  skip     ${m.name} (code moved)`); continue; }
        console.log(`  STALE    ${m.name}: "${m.from.slice(0, 60)}" not found in ${m.file}; update scripts/mutation.mjs`);
        missing++; continue;
      }
      fs.writeFileSync(file, original.replace(m.from, m.to));
      const caught = !testsPass(pristine, m.tests);
      fs.writeFileSync(file, original);
      console.log(`  ${caught ? "caught  " : "SURVIVED"} ${m.name}`);
      if (!caught) survived++;
    }
    console.log(`\n${selected.length - survived - missing}/${selected.length} mutations caught`);
    if (!testsPass(pristine, [...new Set(selected.flatMap((m) => m.tests))])) { console.log("baseline tests fail: fix them first"); return 1; }
    return survived || missing ? 1 : 0;
  } finally {
    fs.rmSync(pristine, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = run(process.argv[2] || "");
