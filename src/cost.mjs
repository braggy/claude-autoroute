// Step 2: is switching worth it once prompt-cache effects are counted?
import { TIERS } from "./config.mjs";

const tierIdx = (t) => TIERS.indexOf(t);
export const usd = (n) => (n == null ? "?" : "$" + (Math.abs(n) < 0.01 && n !== 0 ? n.toFixed(4) : n.toFixed(2)));

// Price table for a tier on a provider. Providers may override per tier
// (e.g. a free or non-Claude backup) or apply a multiplier (e.g. regional +10%).
export function priceTable(cfg, tier, providerName) {
  const p = providerName ? cfg.providers[providerName] : null;
  if (p?.prices?.[tier]) return p.prices[tier];
  const base = cfg.prices[cfg.models[tier]];
  if (!base) return null;
  const m = p?.priceMultiplier ?? 1;
  if (m === 1) return base;
  const out = {};
  for (const [k, v] of Object.entries(base)) out[k] = k === "longAbove" ? v : v * m;
  return out;
}

export function rates(table, promptTokens, ttl1h = false) {
  if (!table) return null;
  const long = table.longAbove && promptTokens > table.longAbove;
  const inn = (long ? table.longIn : table.in) / 1e6;
  return {
    in: inn,
    out: (long ? table.longOut : table.out) / 1e6,
    read: (long ? table.longRead : table.read) / 1e6,
    write: inn * (ttl1h ? 2 : 1.25),
  };
}

// Cost of one response from its usage block.
export function costOf(table, u, ttl1h = false, writesAsReads = false) {
  if (!table || !u) return null;
  const prompt = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const r = rates(table, prompt, ttl1h);
  let write;
  const cc = u.cache_creation;
  if (writesAsReads) write = (u.cache_creation_input_tokens || 0) * r.read;
  else if (cc && (cc.ephemeral_5m_input_tokens != null || cc.ephemeral_1h_input_tokens != null)) {
    write = (cc.ephemeral_5m_input_tokens || 0) * r.in * 1.25 + (cc.ephemeral_1h_input_tokens || 0) * r.in * 2;
  } else write = (u.cache_creation_input_tokens || 0) * r.write;
  return (u.input_tokens || 0) * r.in + (u.cache_read_input_tokens || 0) * r.read + write + (u.output_tokens || 0) * r.out;
}

// Estimated cost of the coming turn on `tier`. `warm` says whether that model's
// cache (on this provider) is still alive.
export function turnCost(cfg, tier, provider, T, warm, ttl1h) {
  const r = rates(priceTable(cfg, tier, provider), T, ttl1h);
  if (!r) return null;
  const { expectedOutputTokens: O, expectedRequestsPerTurn: R } = cfg.switching;
  const firstRead = T * (warm ? r.read : r.write);
  return { total: firstRead + (R - 1) * T * r.read + O * r.out, firstRead, r };
}

/**
 * Decide the tier to actually use.
 *   desired  - what the classifier wants
 *   current  - tier used last turn in this chat (or null)
 *   T        - estimated prompt size in tokens
 *   isWarm   - (tier) => boolean, is that tier's cache alive on the active provider
 *   streak   - consecutive turns that wanted a lower tier than current
 */
export function chooseTier(cfg, { desired, current, T, isWarm, provider, ttl1h = false, streak = 1, forced = false }) {
  if (forced || !current || desired === current || cfg.switching.mode === "always") return { tier: desired, note: "" };
  const stay = turnCost(cfg, current, provider, T, isWarm(current), ttl1h);
  const go = turnCost(cfg, desired, provider, T, isWarm(desired), ttl1h);
  if (!stay || !go) return { tier: desired, note: "" };

  if (tierIdx(desired) > tierIdx(current)) {
    const rebuild = go.firstRead - T * go.r.read;
    if (rebuild <= cfg.switching.maxUpgradeCacheCostUSD) {
      return { tier: desired, note: rebuild > 0.005 ? `cache rebuild ~${usd(rebuild)}` : "" };
    }
    return { tier: current, suggested: desired,
             note: `${desired} suggested, but rebuilding its cache costs ~${usd(rebuild)}. Add !${desired} to force` };
  }

  const comeBack = cfg.switching.returnProbability * T * (stay.r.write - stay.r.read);
  const build = go.firstRead - T * go.r.read;
  const perTurn = stay.total - (go.total - build);
  const turns = Math.min(Math.max(streak, 1), cfg.switching.maxStreakTurns);
  const net = perTurn * turns - build - comeBack;
  if (net > 0) return { tier: desired, note: `saves ~${usd(net)}` };
  return { tier: current, suggested: desired, note: `staying on ${current}: switching costs ~${usd(-net)} more in cache rebuilds` };
}
