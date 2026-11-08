// `autoroute usage`: how your Claude Code usage splits across models, read from Claude
// Code's own transcripts on this computer (~/.claude/projects). Works with any login,
// including subscriptions, because nothing goes through the router.
//
// Prompts are read in memory only, to estimate which model each message needed. Nothing
// is written to disk or sent anywhere.
//
// Anthropic doesn't publish how plan limits weigh each model, so usage is weighted by API
// list prices: a fair proxy for "Opus uses your limits faster than Sonnet".
import fs from "node:fs";
import path from "node:path";
import { TIERS } from "./config.mjs";
import { humanText, tierOf } from "./classify.mjs";
import { priceTable, costOf, rates } from "./cost.mjs";
import { claudeDir, wantedTier } from "./subscription.mjs";

const blank = () => ({ replies: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, weight: 0 });

function transcriptFiles(root, sinceMs) {
  let names = [];
  try { names = fs.readdirSync(root, { recursive: true }); } catch { return []; }
  return names.map(String).filter((n) => n.endsWith(".jsonl")).map((n) => path.join(root, n))
    .filter((f) => { try { return fs.statSync(f).mtimeMs >= sinceMs; } catch { return false; } });
}

/** Reads one transcript into turns: [{ wanted, replies: [{ tier, ts, usage }] }]. */
export function parseTranscript(text, cfg) {
  const turns = [];
  const seen = new Map(); // message id -> reply (streamed replies repeat the same id)
  let turn = null;
  const follow = (() => { try { return new RegExp(cfg.classifier.followUpPattern, "i"); } catch { return null; } })();
  for (const line of text.split("\n")) {
    if (!line) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === "user" && !j.isMeta && !j.isSidechain) {
      const t = humanText(j.message);
      if (!t) continue;
      const wanted = follow?.test(t) && turn ? turn.wanted : wantedTier(t, cfg).tier;
      turn = { wanted, replies: [] };
      turns.push(turn);
    } else if (j.type === "assistant" && j.message?.usage) {
      const tier = tierOf(j.message.model);
      if (!tier) continue;
      const ts = Date.parse(j.timestamp) || 0;
      const id = j.message.id || j.uuid;
      const prev = id && seen.get(id);
      if (prev) { prev.usage = j.message.usage; continue; }
      if (!turn) { turn = { wanted: null, replies: [] }; turns.push(turn); }
      const r = { tier, ts, usage: j.message.usage };
      turn.replies.push(r);
      if (id) seen.set(id, r);
    }
  }
  return turns;
}

function add(acc, u, w) {
  acc.replies++;
  acc.input += u.input_tokens || 0;
  acc.output += u.output_tokens || 0;
  acc.cacheRead += u.cache_read_input_tokens || 0;
  acc.cacheWrite += u.cache_creation_input_tokens || 0;
  acc.weight += w || 0;
}

/**
 * Usage by model over the last `days`, plus the last 5 hours (the window Claude plans
 * reset on), and an estimate of how much a better-fitting model would have used.
 */
export function usageReport(cfg, { env = process.env, days = 7, now = Date.now(), files } = {}) {
  const since = now - days * 86400e3;
  const fiveH = now - 5 * 3600e3;
  const list = files || transcriptFiles(path.join(claudeDir(env), "projects"), since);
  const byTier = Object.fromEntries(TIERS.map((t) => [t, blank()]));
  const recent = Object.fromEntries(TIERS.map((t) => [t, blank()]));
  let turns = 0, oversized = 0, actual = 0, fitted = 0;
  for (const f of list) {
    let text; try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
    for (const turn of parseTranscript(text, cfg)) {
      const inRange = turn.replies.filter((r) => r.ts >= since && r.ts <= now);
      if (!inRange.length) continue;
      turns++;
      let turnActual = 0, turnFitted = 0;
      inRange.forEach((r, i) => {
        const w = costOf(priceTable(cfg, r.tier), r.usage) || 0;
        add(byTier[r.tier], r.usage, w);
        if (r.ts >= fiveH) add(recent[r.tier], r.usage, w);
        turnActual += w;
        const fit = turn.wanted && TIERS.indexOf(turn.wanted) < TIERS.indexOf(r.tier) ? turn.wanted : r.tier;
        let fw = fit === r.tier ? w : costOf(priceTable(cfg, fit), r.usage) || 0;
        // Switching to the smaller model would have rebuilt its cache on the first reply.
        if (fit !== r.tier && i === 0) {
          const rt = rates(priceTable(cfg, fit), 0);
          if (rt) fw += (r.usage.cache_read_input_tokens || 0) * (rt.write - rt.read);
        }
        turnFitted += fw;
      });
      if (turn.wanted && inRange.some((r) => TIERS.indexOf(turn.wanted) < TIERS.indexOf(r.tier))) oversized++;
      actual += turnActual;
      fitted += Math.min(turnActual, turnFitted);
    }
  }
  const total = TIERS.reduce((s, t) => s + byTier[t].weight, 0);
  const share = Object.fromEntries(TIERS.map((t) => [t, total ? byTier[t].weight / total : 0]));
  return {
    days, files: list.length, turns, byTier, last5h: recent, share,
    oversizedTurns: oversized,
    // Rough: assumes the same tokens, and counts one cache rebuild per switched message.
    couldSavePercent: actual ? Math.max(0, (1 - fitted / actual) * 100) : null,
  };
}

const k = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(0) + "k" : String(n));

export function printUsage(r, print = console.log) {
  if (!r.turns) {
    print(`No Claude Code activity found in the last ${r.days} day(s). Transcripts are read from ~/.claude/projects (or CLAUDE_CONFIG_DIR).`);
    return;
  }
  print(`Claude Code usage, last ${r.days} day(s): ${r.turns} message(s) in ${r.files} chat(s)\n`);
  print("  model    replies   output   input+cache   share of usage*   last 5 h");
  for (const t of TIERS) {
    const a = r.byTier[t], b = r.last5h[t];
    if (!a.replies) continue;
    print(`  ${t.padEnd(8)} ${String(a.replies).padStart(7)} ${k(a.output).padStart(8)} ${k(a.input + a.cacheRead + a.cacheWrite).padStart(13)}   ${(r.share[t] * 100).toFixed(0).padStart(14)}%   ${b.replies ? b.replies + " replies" : "–"}`);
  }
  print("\n  * weighted by API list prices, as a stand-in for how fast each model uses your plan's limits.");
  if (r.couldSavePercent != null && r.oversizedTurns) {
    print(`\n${r.oversizedTurns} message(s) looked like they needed a smaller model than they ran on.`);
    print(`Starting those on the model they needed would have used roughly ${r.couldSavePercent.toFixed(0)}% less (estimate, cache rebuilds included).`);
    print("To get there: claude-auto picks the starting model for you, and `autoroute hints install` suggests /model switches.");
  } else {
    print("\nYour messages already ran on models that fit them.");
  }
}
