#!/usr/bin/env node
// Verifies exactly what `npm publish` would upload: only allowlisted paths,
// and none of them containing anything secret or personal.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scan } from "./check-secrets.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED = [/^bin\/[\w-]+\.mjs$/, /^src\/[\w-]+\.mjs$/, /^src\/ui\/(index\.html|app\.js|help\.js|app\.css|favicon\.svg)$/, /^assets\/icon(-\d+\.png|\.svg)$/, /^config\.example\.jsonc$/, /^(README|SECURITY|CHANGELOG|HELP)\.md$/, /^LICENSE$/, /^llms(-full)?\.txt$/, /^package\.json$/];

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const out = JSON.parse(execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString());
const files = out[0].files.map((f) => f.path);
const unexpected = files.filter((f) => !ALLOWED.some((re) => re.test(f)));
const problems = [...unexpected.map((f) => `${f}: not on the publish allowlist`), ...scan(files)];
if (problems.length) {
  console.error("check-pack: the npm package would include problems:\n");
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}
console.log(`check-pack: ${files.length} file(s) would be published, all allowlisted and clean:\n  ${files.join("\n  ")}`);
