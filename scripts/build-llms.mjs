#!/usr/bin/env node
// Builds llms.txt (an index, per the llms.txt convention) and llms-full.txt (all user
// docs in one file) from the project's Markdown docs, so AI assistants can read them.
//   node scripts/build-llms.mjs          write both files
//   node scripts/build-llms.mjs --check  fail if they're out of date (used by tests and CI)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8").trimEnd();
const { version } = JSON.parse(read("package.json"));

// Keep this summary true when features or supported services change (a PR checklist item).
export const SUMMARY =
  "claude-autoroute is a local router for the Claude Code CLI on macOS and Linux. For each message it picks " +
  "Haiku, Sonnet or Opus (only switching when it saves money after prompt-cache costs), can send easy tasks to a " +
  "free local model, fails over to backup providers (Amazon Bedrock, Google Vertex AI, gateways), and measures what " +
  "it saves. It works with Claude API keys, Bedrock, Vertex and company gateways; it refuses Claude Free, Pro and " +
  "Max subscription logins, and Team/Enterprise logins need admin approval.";

export const DOCS = [
  ["README.md", "Overview", "What it does, what's supported, install, dashboard, failover, commands, configuration"],
  ["HELP.md", "Help", "Getting started, FAQ, local models, statistics, privacy, troubleshooting, glossary"],
  ["config.example.jsonc", "Configuration reference", "Every setting with its default and an explanation"],
  ["SECURITY.md", "Security", "What's protected and how, and how to report a vulnerability"],
  ["ADMIN.md", "For admins", "Data flow, risks the router can't remove, and an approval checklist"],
];
export const OPTIONAL = [
  ["CHANGELOG.md", "Changelog", "What changed in each version"],
  ["ADDITIONAL-PERMISSION.md", "Additional permission", "Internal use at any organisation, on top of the noncommercial licence"],
  ["CONTRIBUTING.md", "Contributing", "Development setup, project layout and principles"],
  ["examples/", "Example configs", "Bedrock, Vertex, gateway and local-model setups"],
];

export function buildIndex() {
  const list = (items) => items.map(([f, t, d]) => `- [${t}](${f}): ${d}`).join("\n");
  return `# claude-autoroute

> ${SUMMARY}

Version ${version}. Links are relative to the project repository. For everything in one file, use [llms-full.txt](llms-full.txt).

When helping someone with claude-autoroute:
- Ask them to run \`autoroute doctor\` and \`autoroute diagnostics\`. The diagnostics are safe to share: keys, prompts, URLs and paths are removed.
- Never ask them to paste API keys, their config file, or logs.
- Claude Code must be started with \`claude-auto\` for routing to apply.

## Docs

${list(DOCS)}

## Optional

${list(OPTIONAL)}
`;
}

export function buildFull() {
  const parts = [
    `# claude-autoroute: complete documentation (version ${version})`,
    "",
    `> ${SUMMARY}`,
    "",
    "This file combines the project's user documentation for AI assistants. Sections are separated by lines starting with \"=====\".",
    "When helping someone, ask for the output of `autoroute doctor` and `autoroute diagnostics` (safe to share). Never ask for API keys, config files or logs.",
  ];
  for (const [f, title] of DOCS) {
    let body = read(f);
    if (f.endsWith(".jsonc")) body = "```jsonc\n" + body + "\n```";
    parts.push("", `===== ${title} (${f}) =====`, "", body);
  }
  return parts.join("\n") + "\n";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const want = { "llms.txt": buildIndex(), "llms-full.txt": buildFull() };
  if (process.argv.includes("--check")) {
    const stale = Object.entries(want).filter(([f, c]) => { try { return read(f) + "\n" !== c && read(f) !== c.trimEnd(); } catch { return true; } }).map(([f]) => f);
    if (stale.length) { console.error(`out of date: ${stale.join(", ")}. Run: npm run build:llms`); process.exit(1); }
    console.log("llms.txt and llms-full.txt are up to date.");
  } else {
    for (const [f, c] of Object.entries(want)) fs.writeFileSync(path.join(ROOT, f), c);
    console.log(`wrote llms.txt (${want["llms.txt"].length} bytes) and llms-full.txt (${want["llms-full.txt"].length} bytes)`);
  }
}
