#!/usr/bin/env node
// Fails if anything that looks personal or secret is about to be committed or published:
// API keys and tokens, private keys, email addresses, home-directory paths,
// and runtime files (configs, logs, stats, local keys).
//
// Scans what git would commit (tracked + untracked-but-not-ignored files) when run
// inside a git repo, otherwise every file under the project root.
// To allow a deliberate match, put "check-secrets: allow" on the same line.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PATTERNS = [
  ["Anthropic API key", /sk-ant-[A-Za-z0-9_-]{16,}/],
  ["OpenAI-style API key", /\bsk-(proj-)?[A-Za-z0-9]{32,}/],
  ["AWS access key ID", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["AWS secret access key", /aws_secret_access_key\s*[=:]\s*\S{20,}/i],
  ["Bedrock API key", /\bABSK[A-Za-z0-9+/=]{20,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Google OAuth token", /\bya29\.[0-9A-Za-z_-]{20,}/],
  ["GitHub token", /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ["Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["Private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["JSON Web Token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["Bearer token", /Bearer\s+[A-Za-z0-9._~+/=-]{40,}/],
  ["Email address", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
  ["Home directory path", /(\/home\/|\/Users\/|C:\\Users\\)(?!you\b|your-?name\b|USER\b|runner\b|me\b)[A-Za-z0-9._-]+/],
];

// Safe, generic addresses that may appear in docs.
const EMAIL_ALLOW = [/@example\.(com|org|net)\b/i, /@users\.noreply\.github\.com\b/i];

export const FORBIDDEN_FILES = [
  /(^|\/)config\.jsonc?$/, /(^|\/)local-key$/, /(^|\/)stats\.jsonl$/, /(^|\/)state\.json$/,
  /(^|\/)router\.(log|out|pid)$/, /(^|\/)ui-token$/, /(^|\/)totals\.json$/, /(^|\/)config\.jsonc?\.(bak|tmp|old)$/, /(^|\/)\.env(\..*)?$/, /\.pem$/, /(^|\/)id_(rsa|ed25519)/,
];

const SKIP_DIRS = new Set([".git", "node_modules", "coverage"]);

function listFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] });
    return out.toString().split("\n").filter(Boolean);
  } catch {
    const files = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        if (SKIP_DIRS.has(e.name)) continue;
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) walk(rel); else files.push(rel);
      }
    })("");
    return files;
  }
}

export function scanText(text) {
  const hits = [];
  text.split("\n").forEach((line, i) => {
    if (line.includes("check-secrets: allow")) return;
    for (const [label, re] of PATTERNS) {
      const m = line.match(re);
      if (!m) continue;
      if (label === "Email address" && EMAIL_ALLOW.some((a) => a.test(m[0]))) continue;
      hits.push({ line: i + 1, label, match: m[0].slice(0, 12) + (m[0].length > 12 ? "…" : "") });
    }
  });
  return hits;
}

export function scan(files = listFiles()) {
  const problems = [];
  for (const f of files) {
    if (FORBIDDEN_FILES.some((re) => re.test(f)) && !f.endsWith("config.example.jsonc")) {
      problems.push(`${f}: runtime/secret file must not be committed`);
      continue;
    }
    const full = path.join(ROOT, f);
    let buf;
    try { buf = fs.readFileSync(full); } catch { continue; }
    if (buf.includes(0)) continue; // binary
    for (const h of scanText(buf.toString("utf8"))) problems.push(`${f}:${h.line}: possible ${h.label} (${h.match})`);
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = process.argv.length > 2 ? process.argv.slice(2) : listFiles();
  const problems = scan(files);
  if (problems.length) {
    console.error(`check-secrets: ${problems.length} problem(s) found. Nothing should be published until these are fixed:\n`);
    for (const p of problems) console.error("  " + p);
    console.error('\nIf a match is a deliberate, harmless example, add "check-secrets: allow" to that line.');
    process.exit(1);
  }
  console.log(`check-secrets: scanned ${files.length} file(s), nothing personal or secret found.`);
}
