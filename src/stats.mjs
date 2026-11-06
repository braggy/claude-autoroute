// Spend tracking: one JSON line per routed response, plus a live "today" total.
import fs from "node:fs";
import path from "node:path";
import { TIERS } from "./config.mjs";
import { usd, costOf } from "./cost.mjs";

const today = () => new Date().toISOString().slice(0, 10);
const tierIdx = (t) => TIERS.indexOf(t);

// ------------------------------------------------------------ lifetime ---
// Running totals since the router was first used, kept in totals.json so the
// dashboard can show them instantly. Rebuilt from stats.jsonl if missing.
export function emptyLifetime() {
  return {
    version: 1, since: null, updated: null,
    messages: 0, requests: 0, actual: 0, baseline: 0, cacheRebuildCost: 0, switches: 0,
    byTier: {}, downgraded: 0, upgraded: 0, unchanged: 0,
    failoverRequests: 0, failoverMessages: 0, localMessages: 0, regrets: 0,
    overheadMs: 0, overheadN: 0,
    shadow: { messages: 0, requests: 0, actual: 0, would: 0, cheaper: 0, local: 0, rebuilds: 0 }, // shadow mode: what routing would have done
    errors: 0,     // requests the router answered with an error of its own (not a provider's)
    latency: {},   // tier -> { ms, n }   measured response times per request
    pairs: {},     // "requested>used" -> { n, ms }   for the time-saved estimate
  };
}

export function accumulate(lt, r) {
  lt.since = lt.since ?? r.ts; lt.updated = r.ts;
  if (r.kind === "background") { if (r.failover) lt.failoverRequests++; return lt; }
  if (r.kind === "error") { lt.errors = (lt.errors || 0) + 1; return lt; }
  lt.actual += r.actual || 0;
  lt.baseline += r.baseline ?? r.actual ?? 0;
  if (r.kind === "shadow") {
    const sh = (lt.shadow ||= { messages: 0, requests: 0, actual: 0, would: 0, cheaper: 0, local: 0, rebuilds: 0 });
    sh.requests++; sh.actual += r.actual || 0; sh.would += r.would ?? r.actual ?? 0;
    if (r.cacheMiss) sh.rebuilds++;
    if (r.newTurn) {
      sh.messages++;
      if (r.wouldTier === "local") { sh.local++; sh.cheaper++; }
      else if (tierIdx(r.wouldTier) < tierIdx(r.originalTier)) sh.cheaper++;
    }
    return lt;
  }
  if (r.kind !== "turn") return lt;
  lt.requests++;
  if (r.failover) lt.failoverRequests++;
  if (r.cacheMiss) {
    lt.switches++;
    if (r.table && r.usage) lt.cacheRebuildCost += Math.max(0, (r.actual || 0) - (costOf(r.table, r.usage, false, true) || 0));
  }
  if (r.newTurn) {
    lt.messages++;
    lt.byTier[r.tier] = (lt.byTier[r.tier] || 0) + 1;
    if (r.failover) lt.failoverMessages++;
    if (r.local) lt.localMessages = (lt.localMessages || 0) + 1;
    if (r.regret) lt.regrets = (lt.regrets || 0) + 1;
    if (r.originalTier && r.tier) {
      const d = r.local ? -1 : tierIdx(r.tier) - tierIdx(r.originalTier); // the local model counts as cheaper
      if (d < 0) lt.downgraded++; else if (d > 0) lt.upgraded++; else lt.unchanged++;
    }
  }
  if (r.overheadMs != null) { lt.overheadMs += r.overheadMs; lt.overheadN++; }
  if (r.ms != null && r.tier) {
    const l = (lt.latency[r.tier] ||= { ms: 0, n: 0 }); l.ms += r.ms; l.n++;
    if (r.originalTier) { const k = `${r.originalTier}>${r.tier}`; const p = (lt.pairs[k] ||= { n: 0, ms: 0 }); p.n++; p.ms += r.ms; }
  }
  return lt;
}

/** Human-meaningful numbers derived from the raw totals. */
export function summarize(lt, minSamples = 5) {
  const saved = lt.baseline - lt.actual;
  const avg = (t) => (lt.latency[t]?.n >= minSamples ? lt.latency[t].ms / lt.latency[t].n : null);
  // Time saved: for requests that ran on a different model than requested, compare
  // with how long the requested model takes on average (measured on your own traffic).
  let timeSavedMs = 0, timeBasis = 0, missing = false;
  for (const [k, p] of Object.entries(lt.pairs)) {
    const [orig, used] = k.split(">");
    if (orig === used) continue;
    const a = avg(orig);
    if (a == null) { missing = true; continue; }
    timeSavedMs += p.n * a - p.ms; timeBasis += p.n;
  }
  return {
    since: lt.since, messages: lt.messages, requests: lt.requests,
    paid: lt.actual, withoutAutoroute: lt.baseline, saved, percentCheaper: lt.baseline > 0 ? (saved / lt.baseline) * 100 : null,
    cheaperModelShare: lt.messages ? (lt.downgraded / lt.messages) * 100 : null,
    downgraded: lt.downgraded, upgraded: lt.upgraded, unchanged: lt.unchanged, byTier: lt.byTier,
    failoverRequests: lt.failoverRequests, failoverMessages: lt.failoverMessages, localMessages: lt.localMessages || 0,
    shadow: shadowSummary(lt.shadow),
    errors: lt.errors || 0,
    regrets: lt.regrets || 0, regretRate: lt.downgraded ? ((lt.regrets || 0) / lt.downgraded) * 100 : null,
    switches: lt.switches, cacheRebuildCost: lt.cacheRebuildCost,
    avgOverheadMs: lt.overheadN ? lt.overheadMs / lt.overheadN : null,
    avgLatencyMs: Object.fromEntries(Object.keys(lt.latency).map((t) => [t, lt.latency[t].ms / lt.latency[t].n])),
    timeSavedMs: timeBasis ? timeSavedMs : null, timeSavedBasis: timeBasis, timeSavedPartial: missing,
  };
}

function shadowSummary(sh) {
  if (!sh || !sh.requests) return null;
  const saved = sh.actual - sh.would;
  return { messages: sh.messages, requests: sh.requests, paid: sh.actual, wouldPay: sh.would, wouldSave: saved,
           percentCheaper: sh.actual > 0 ? (saved / sh.actual) * 100 : null,
           cheaperModelShare: sh.messages ? (sh.cheaper / sh.messages) * 100 : null, localMessages: sh.local, rebuilds: sh.rebuilds };
}

function readRows(file) {
  const rows = [];
  try { for (const l of fs.readFileSync(file, "utf8").split("\n")) { if (l) { try { rows.push(JSON.parse(l)); } catch {} } } } catch {}
  return rows;
}

export function loadLifetime(home) {
  try {
    const lt = JSON.parse(fs.readFileSync(path.join(home, "totals.json"), "utf8"));
    if (lt.version === 1) return lt;
  } catch {}
  const lt = emptyLifetime();
  for (const r of readRows(path.join(home, "stats.jsonl"))) accumulate(lt, r);
  return lt;
}

export class Stats {
  constructor(home, { keepDays = 90 } = {}) {
    this.home = home;
    this.keepDays = keepDays;
    this.file = path.join(home, "stats.jsonl");
    this.totals = { date: today(), actual: 0, baseline: 0 };
    const d = today();
    for (const s of readRows(this.file)) {
      if (s.date !== d || s.kind === "background" || s.kind === "error") continue;
      this.totals.actual += s.actual || 0;
      this.totals.baseline += s.baseline ?? s.actual ?? 0;
      if (s.kind === "shadow") this.totals.would = (this.totals.would || 0) + (s.would ?? s.actual ?? 0);
    }
    this.lifetime = loadLifetime(home);
    this.flushTimer = null;
    this.prune();
  }
  /** Drop rows older than keepDays. Lifetime totals live in totals.json, so nothing is lost. */
  prune() {
    const cutoff = Date.now() - this.keepDays * 864e5;
    const rows = readRows(this.file);
    if (!rows.some((r) => r.ts < cutoff)) return;
    this.flush(); // make sure lifetime totals are on disk before history goes
    try {
      const keep = rows.filter((r) => r.ts >= cutoff).map((r) => JSON.stringify(r) + "\n").join("");
      fs.writeFileSync(this.file + ".tmp", keep, { mode: 0o600 });
      fs.renameSync(this.file + ".tmp", this.file);
    } catch {}
  }
  record(row) {
    const r = { date: today(), ts: Date.now(), ...row };
    if (this.totals.date !== r.date) { this.totals = { date: r.date, actual: 0, baseline: 0 }; this.prune(); }
    if (r.kind !== "background" && r.kind !== "error") {
      this.totals.actual += r.actual || 0;
      this.totals.baseline += r.baseline ?? r.actual ?? 0;
      if (r.kind === "shadow") this.totals.would = (this.totals.would || 0) + (r.would ?? r.actual ?? 0);
    }
    accumulate(this.lifetime, r);
    try { fs.appendFileSync(this.file, JSON.stringify(r) + "\n", { mode: 0o600 }); } catch {}
    this.scheduleFlush();
  }
  scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, 1000);
    this.flushTimer.unref?.();
  }
  flush() {
    try {
      const p = path.join(this.home, "totals.json");
      fs.writeFileSync(p + ".tmp", JSON.stringify(this.lifetime), { mode: 0o600 });
      fs.renameSync(p + ".tmp", p);
    } catch {}
  }
}

/** Aggregated spend for the last `days` days, including a per-day series. */
export function savingsData(home, days = 7) {
  const file = path.join(home, "stats.jsonl");
  let rows = [];
  try {
    for (const l of fs.readFileSync(file, "utf8").split("\n")) { if (l) { try { rows.push(JSON.parse(l)); } catch {} } }
  } catch {}
  rows = rows.filter((r) => r.ts >= Date.now() - days * 864e5 && r.kind !== "background" && r.kind !== "error");
  let actual = 0, baseline = 0, penalty = 0, turns = 0, misses = 0, unknown = 0, failovers = 0;
  const byTier = {}, byProvider = {}, byDay = {};
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    byDay[d] = { date: d, actual: 0, baseline: 0, messages: 0 };
  }
  for (const r of rows) {
    actual += r.actual || 0;
    const day = byDay[r.date];
    if (day) { day.actual += r.actual || 0; day.baseline += r.baseline ?? r.actual ?? 0; if (r.newTurn) day.messages++; }
    if (r.baseline == null) unknown++; else baseline += r.baseline;
    if (r.kind !== "turn") continue;
    byProvider[r.provider] = (byProvider[r.provider] || 0) + 1;
    if (r.failover) failovers++;
    if (r.newTurn) { turns++; byTier[r.tier] = (byTier[r.tier] || 0) + 1; }
    if (r.cacheMiss && r.table) {
      misses++;
      penalty += Math.max(0, (r.actual || 0) - (costOf(r.table, r.usage, false, true) || 0));
    }
  }
  return { days, rows: rows.length, actual, baseline, saved: baseline - actual, penalty, turns, misses, unknown, failovers,
           byTier, byProvider, series: Object.values(byDay) };
}

export function savingsReport(home, days = 7, print = console.log) {
  const d = savingsData(home, days);
  if (!d.rows) { print(`No routed requests in the last ${days} day(s) yet.`); return null; }
  const { actual, baseline, saved, penalty, turns, misses, unknown, failovers, byTier, byProvider } = d;
  print(`Last ${days} day(s), ${turns} messages routed`);
  print(`  models:            ${TIERS.map((t) => `${t} ${byTier[t] || 0}`).join(" · ")}`);
  print(`  providers:         ${Object.entries(byProvider).map(([p, n]) => `${p} ${n}`).join(" · ")}${failovers ? `  (${failovers} request(s) on a backup)` : ""}`);
  print(`  you paid:          ${usd(actual)}`);
  print(`  without routing:   ${usd(baseline)}  (estimate)`);
  print(`  saved:             ${usd(saved)}  (${baseline ? ((saved / baseline) * 100).toFixed(0) : 0}%)`);
  print(`  switch cache cost: ${usd(penalty)} across ${misses} model/provider switch(es), already included above`);
  if (unknown) print(`  note: ${unknown} request(s) had no price configured and aren't in the baseline`);
  print(`\nDollars are at the configured list prices.`);
  return d;
}

/**
 * The first-week success check (HELP.md: "How do I know if it's working for me?").
 * Targets are deliberately simple; each check waits until there's enough data.
 */
export const TRIAL_TARGETS = { minMessages: 30, savedPercent: 20, regretPercent: 5, overheadMs: 5 };
export function trialCheck(v, T = TRIAL_TARGETS, now = Date.now()) {
  const enough = v.messages >= T.minMessages;
  const days = v.since ? Math.max(1, Math.ceil((now - v.since) / 864e5)) : 0;
  const check = (label, ok, detail, ready = enough) => ({ label, state: !ready ? "wait" : ok ? "pass" : "fail", detail });
  const checks = [
    check(`saves ${T.savedPercent}% or more`, (v.percentCheaper ?? 0) >= T.savedPercent, v.percentCheaper == null ? "no data yet" : `${v.percentCheaper.toFixed(0)}% saved`),
    check(`regret rate under ${T.regretPercent}%`, (v.regretRate ?? 0) < T.regretPercent, v.regretRate == null ? "no cheaper picks yet" : `${v.regretRate.toFixed(1)}% (${v.regrets} override(s))`),
    check(`router overhead under ${T.overheadMs} ms`, v.avgOverheadMs != null && v.avgOverheadMs < T.overheadMs, v.avgOverheadMs == null ? "no data yet" : `${v.avgOverheadMs.toFixed(1)} ms`, v.avgOverheadMs != null),
    check("no router errors", !v.errors, v.errors ? `${v.errors} error(s): see autoroute log` : "none", true),
  ];
  const verdict = !enough ? `collecting (${v.messages}/${T.minMessages} messages)`
    : checks.every((c) => c.state === "pass") ? "on track: keep it on"
    : checks.some((c) => c.state === "fail" && /errors|regret/.test(c.label)) ? "needs attention (see HELP.md: Your first week)"
    : "working, savings below target (see HELP.md: Your first week)";
  return { days, enough, checks, verdict };
}
