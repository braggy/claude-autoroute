#!/usr/bin/env node
// Claude Code status line. Shows the router's real pick (Claude Code's own model
// label doesn't change), the provider when failed over, and today's spend.
import fs from "node:fs";
import path from "node:path";
import { homeDir } from "../src/config.mjs";

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let dir = "";
  try { const j = JSON.parse(input); dir = path.basename(j.workspace?.current_dir || j.cwd || ""); } catch {}
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
  const icon = { haiku: "🟢", sonnet: "🔵", opus: "🟣" }[s.tier] || "⚪";
  const where = s.local ? ` · 🏠 local: ${s.model}` : s.failover ? ` · 🟠 failover: ${s.provider}` : "";
  const why = (s.reason || "").length > 55 ? s.reason.slice(0, 52) + "..." : s.reason || "";
  const t = s.today || {};
  const money = t.baseline ? ` · today $${t.actual.toFixed(2)} (saved $${(t.baseline - t.actual).toFixed(2)})` : "";
  console.log(`${dir}  ${icon} auto:${s.tier || "?"}${where} · ${why}${money}`);
});
