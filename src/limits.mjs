// What the router is allowed to do right now: shared by the proxy and the dashboard.
// Kept separate so neither imports the other.

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/** Measured response times of the local model and Claude on easy tasks. */
export function perfSummary(ctx) {
  const p = ctx.perf;
  return { localAvgMs: avg(p.local), claudeAvgMs: avg(p.claude), localSamples: p.local.length, claudeSamples: p.claude.length };
}

// If your organization restricts models, the local model is only used when it's on the list.
export function localPermitted(ctx) {
  const { list } = ctx.policy.available();
  return !list || list.some((e) => String(e).toLowerCase() === String(ctx.cfg.local.model).toLowerCase());
}

// Tiers we may route to: your autoroute setting AND your organization's availableModels.
export function allowedTiers(ctx) {
  const { cfg } = ctx;
  const idsFor = (t) => Object.values(cfg.providers).map((p) => p.models?.[t]).filter(Boolean);
  return ctx.policy.allowedTiers(cfg, idsFor).filter((t) => cfg.allowedTiers.includes(t));
}
