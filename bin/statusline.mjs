#!/usr/bin/env node
// Claude Code status line. Shows the router's real pick (Claude Code's own model
// label doesn't change), the provider when failed over, and today's spend.
import fs from "node:fs";
import path from "node:path";
import { homeDir } from "../src/config.mjs";
import { tierOf } from "../src/classify.mjs";
import { readHints } from "../src/subscription.mjs";

const ICON = { haiku: "🟢", sonnet: "🔵", opus: "🟣" };

// Subscription mode: Claude Code's own model, plus the last model tip for this chat.
function subscriptionLine(dir, j) {
  const tier = tierOf(j.model?.id || j.model?.display_name || "");
  const name = tier || j.model?.display_name || "?";
  const tip = readHints(homeDir())[j.session_id]?.tier;
  const hint = tip && tier && tip !== tier ? ` · 💡 /model ${tip}` : "";
  return `${dir}  ${ICON[tier] || "⚪"} ${name} · subscription mode${hint}`;
}

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let dir = "", j = {};
  try { j = JSON.parse(input); dir = path.basename(j.workspace?.current_dir || j.cwd || ""); } catch {}
  if (process.env.AUTOROUTE_MODE === "subscription") return console.log(subscriptionLine(dir, j));
  if (process.env.AUTOROUTE_ACTIVE !== "1") return console.log(`${dir}  auto-route off`);
  let s;
  try { s = JSON.parse(fs.readFileSync(path.join(homeDir(), "state.json"), "utf8")); } catch { return console.log(`${dir}  auto-route on`); }
  if (s.paused) return console.log(`${dir}  ⏸ auto-route paused (autoroute resume)`);
  const t0 = s.today || {};
  if (s.shadow) {
    const would = s.wouldTier ? ` · would use ${s.wouldTier}` : "";
    const save = t0.would != null && t0.actual ? ` · would save $${Math.max(0, t0.actual - t0.would).toFixed(2)} today` : "";
    return console.log(`${dir}  👁 shadow${would}${save}`);
  }
  const icon = ICON[s.tier] || "⚪";
  const where = s.local ? ` · 🏠 local: ${s.model}` : s.failover ? ` · 🟠 failover: ${s.provider}` : "";
  const why = (s.reason || "").length > 55 ? s.reason.slice(0, 52) + "..." : s.reason || "";
  const t = s.today || {};
  const money = t.baseline ? ` · today $${t.actual.toFixed(2)} (saved $${(t.baseline - t.actual).toFixed(2)})` : "";
  console.log(`${dir}  ${icon} auto:${s.tier || "?"}${where} · ${why}${money}`);
});
