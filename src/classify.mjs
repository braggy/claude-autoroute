// Step 1: what does this message need? (haiku / sonnet / opus)
import crypto from "node:crypto";

// Matches at the start, after whitespace, or right after an injected tag like </system-reminder>.
export const OVERRIDE_RE = /(^|[\s>])!(opus|sonnet|haiku)\b/i;
export const sha = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

// Text the human actually typed. Claude Code also injects <system-reminder> blocks etc.
export function humanText(msg) {
  if (!msg || msg.role !== "user") return "";
  const blocks = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content || [];
  return blocks
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
      .replace(/<command-[a-z-]+>[\s\S]*?<\/command-[a-z-]+>/g, "")
      .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, ""))
    .join("\n").trim();
}

// Session identity Claude Code sends with each request (if any), so two chats that
// open with the same message don't share routing state.
export function sessionSalt(body = {}, headers = {}) {
  return String(headers["x-claude-code-session-id"] || body.metadata?.user_id || "");
}

// Latest typed prompt, its index, and a stable key for the conversation.
export function inspect(messages = [], salt = "") {
  let latest = "", latestIdx = -1, first = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = humanText(messages[i]);
    if (t) { latest = t; latestIdx = i; break; }
  }
  for (const m of messages) { const t = humanText(m); if (t) { first = t; break; } }
  return { latest, latestIdx, convKey: sha(salt + "\u0000" + first.slice(0, 2000)) };
}

export function heuristic(text, cfg) {
  const reasons = [];
  let score = 0;
  const t = (text || "").trim();
  const len = t.length;
  const opusHits = cfg._re.opus.filter((r) => r.test(t)).length;
  if (len > 2500) { score += 3; reasons.push("very long prompt"); }
  else if (len > 900) { score += 2; reasons.push("long prompt"); }
  else if (len < 80 && !opusHits) { score -= 1; reasons.push("short prompt"); }
  if ((t.match(/```/g) || []).length >= 4) { score += 1; reasons.push("multiple code blocks"); }
  if (/(Traceback|Exception|Error:|at .+:\d+:\d+|panic:|segfault)/.test(t)) { score += 1; reasons.push("stack trace"); }
  if (opusHits) { score += Math.min(opusHits, 3) * 1.5; reasons.push(`${opusHits} hard-task signal(s)`); }
  const haikuHits = cfg._re.haiku.filter((r) => r.test(t)).length;
  if (haikuHits) { score -= Math.min(haikuHits, 2) * 1.5; reasons.push(`${haikuHits} simple-task signal(s)`); }
  const steps = (t.match(/\b(and then|then|also|after that|finally)\b/gi) || []).length +
                (t.match(/^\s*(\d+[.)]|[-*])\s/gm) || []).length;
  if (steps >= 3) { score += 1; reasons.push("multi-step request"); }
  const { opusScore, haikuScore } = cfg.classifier;
  const tier = score >= opusScore ? "opus" : score <= haikuScore ? "haiku" : "sonnet";
  return { tier, reason: reasons.join(", ") || "default", score };
}

export const LLM_SYSTEM =
  "You route coding-assistant requests to a model. Reply with exactly one word: " +
  "haiku (trivial: lookups, renames, formatting, git, running commands), " +
  "sonnet (normal coding: features, fixes, tests, explanations), or " +
  "opus (hard: architecture, deep debugging, large refactors, subtle bugs, planning, ambiguous design).";

export function stripOverrides(messages = []) {
  for (const m of messages) {
    if (m.role !== "user") continue;
    if (typeof m.content === "string") m.content = m.content.replace(OVERRIDE_RE, "$1").trim() || m.content;
    else for (const b of m.content || []) if (b && b.type === "text" && b.text) b.text = b.text.replace(OVERRIDE_RE, "$1");
  }
}

export function stripThinking(messages = []) {
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      m.content = m.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
      if (!m.content.length) m.content = [{ type: "text", text: "(continued)" }];
    }
  }
}

export function tierOf(model = "") {
  const m = String(model).toLowerCase();
  return m.includes("haiku") ? "haiku" : m.includes("sonnet") ? "sonnet" : m.includes("opus") ? "opus" : null;
}
