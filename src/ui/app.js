// autoroute dashboard. Plain JS, no dependencies.
// Everything from the server is inserted as text (never as HTML).

import { parseHelp, slug } from "/ui/help.js";

// ------------------------------------------------------------------ utils ---
const $ = (s) => document.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v; // CSSOM: allowed under the strict CSP, unlike a style attribute
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
const svg = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
};
const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
const money = (n) => (n == null ? "–" : Math.abs(n) > 0 && Math.abs(n) < 0.01 ? "$" + n.toFixed(4) : "$" + n.toFixed(2));
const pct = (saved, base) => (base > 0 ? Math.round((saved / base) * 100) + "%" : "–");
const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const ktok = (n) => (n >= 1000 ? Math.round(n / 1000) + "k" : String(n));
const TIER_LABEL = { haiku: "Haiku", sonnet: "Sonnet", opus: "Opus" };
const learn = (id, text = "Learn more") => h("a", { href: `#help/${id}`, class: "learn" }, text);
const tierPill = (t) => h("span", { class: `pill ${t}` }, TIER_LABEL[t] || t || "?");

function getIn(o, p) { return p.reduce((a, k) => (a == null ? undefined : a[k]), o); }
function setIn(o, p, v) {
  let cur = o;
  p.slice(0, -1).forEach((k) => { if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {}; cur = cur[k]; });
  if (v === undefined) delete cur[p.at(-1)]; else cur[p.at(-1)] = v;
}

let toastTimer;
function toast(msg, error = false) {
  const t = $("#toast");
  t.textContent = msg; t.className = "toast" + (error ? " error" : ""); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), error ? 9000 : 3500);
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch("/ui/api/" + path, {
    method, credentials: "same-origin",
    headers: { "x-autoroute-ui": "1", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (res.status === 401) { sessionExpired(); throw new Error("session expired"); }
  if (!res.ok) throw Object.assign(new Error(data.error || (data.errors || []).join("\n") || `HTTP ${res.status}`), { data, status: res.status });
  return data;
}

function sessionExpired() {
  clearInterval(state.timer);
  $("#savebar").hidden = true;
  $("#view").replaceChildren(h("div", { class: "gate" }, h("h1", {}, "Your session has ended"),
    h("p", {}, "For security, dashboard sessions end when the router restarts or after 12 hours. In a terminal, run ", h("code", {}, "autoroute ui"), " to open a new one.")));
}

// ------------------------------------------------------------------ state ---
const state = { cfg: null, user: null, overview: null, savingsDays: 7, dirty: false, timer: null, results: {} };
const get = (p) => { const u = getIn(state.user, p); return u !== undefined ? u : getIn(state.cfg.effective, p); };
function set(p, v) { setIn(state.user, p, v); markDirty(); }
function markDirty(on = true) {
  state.dirty = on;
  $("#savebar").hidden = !on;
}
function ensureProviders() {
  if (!state.user.providers) state.user.providers = clone(state.cfg.effective.providers);
  if (!getIn(state.user, ["failover", "order"])) setIn(state.user, ["failover", "order"], clone(state.cfg.effective.failover.order));
}

async function loadConfig() {
  state.cfg = await api("config");
  state.user = clone(state.cfg.user) || {};
  markDirty(false);
}

async function save() {
  const btn = $("#save"); btn.disabled = true;
  try {
    const r = await api("config", { method: "PUT", body: { config: state.user } });
    await loadConfig();
    toast(r.restartNeeded ? "Saved. Restart the router for the new address to apply: autoroute restart" : "Saved. Changes are live.");
    render();
  } catch (e) {
    toast("Not saved:\n" + e.message, true);
  } finally { btn.disabled = false; }
}

// ----------------------------------------------------------------- header ---
function renderStatus() {
  const o = state.overview;
  if (!o) return;
  const down = o.providers.filter((p) => !p.up).length;
  const saved = (o.today.baseline || 0) - (o.today.actual || 0);
  $("#status").replaceChildren(
    h("span", { class: "dot" + (down === o.providers.length ? " down" : "") }),
    h("span", {}, down ? `${down} provider${down > 1 ? "s" : ""} down` : "Running"),
    h("span", {}, "·"), h("span", {}, `saved ${money(saved)} today`),
  );
}

// --------------------------------------------------------------- overview ---
function providerKind(p) {
  if (!p) return "";
  if (p.type === "vertex") return "Google Vertex AI";
  const url = String(p.baseUrl || "");
  if (/bedrock/.test(url)) return "Amazon Bedrock";
  if (/api\.anthropic\.com/.test(url)) return "Anthropic API";
  return "Gateway";
}

const dur = (ms) => {
  const s = Math.round(Math.abs(ms) / 1000);
  const t = s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : s >= 60 ? `${Math.round(s / 60)}m` : `${s}s`;
  return (ms < 0 ? "−" : "") + t;
};
const since = (ts) => new Date(ts).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });

// Quick settings: one click, saved immediately.
async function quickSet(action, okMsg) {
  if (state.dirty) return toast("Save or discard your other changes first (bottom of the screen).", true);
  try {
    await api("quick", { method: "POST", body: action });
    await loadConfig();
    state.overview = await api("overview");
    renderStatus(); render();
    if (okMsg) toast(okMsg);
  } catch (e) { toast(e.message, true); }
}
const secs = (ms) => (ms == null ? "–" : (ms / 1000).toFixed(1) + " s");

const mode = (o) => (o.paused ? "paused" : o.shadow ? "shadow" : "on");
function quickCard(o) {
  const L = o.local || {};
  const pr = o.presets || {};
  const cur = o.priority || "balanced";
  const speed = L.localSamples >= 5 && L.claudeSamples >= 5
    ? `Measured on easy tasks: local ${secs(L.localAvgMs)} vs Claude ${secs(L.claudeAvgMs)} on average${L.maxSlowdown ? ` (limit: ${L.maxSlowdown}x slower)` : " (no speed limit)"}.`
    : L.enabled ? "Measuring speed: after a few easy tasks on each, this shows local vs Claude response times." : null;
  return h("section", { class: "card quick", "aria-label": "Quick settings" },
    h("div", { class: "spread" }, h("h2", {}, "Quick settings"), h("span", { class: "muted small" }, "Saved instantly. ", learn("how-do-i-choose-what-gets-used-when"))),
    h("div", { class: "quick-grid" },
      h("div", {}, h("div", { class: "qlabel" }, "Routing"),
        h("div", { class: "seg" },
          ...[["on", "On", "Routing is on."], ["shadow", "Shadow", "Shadow mode: nothing changes; autoroute records what it would save."], ["paused", "Paused", "Paused: requests go through unchanged. Failover still works."]]
            .map(([m, label, msg]) => h("button", { "aria-pressed": String(mode(o) === m), onclick: () => mode(o) !== m && quickSet({ type: "mode", value: m }, msg) }, label))),
        h("div", { class: "help" }, { on: "Picks a model for each message.", shadow: h("span", {}, "Claude Code keeps its own model; autoroute shows what it would have saved. ", learn("what-is-shadow-mode")), paused: "Claude Code's choice of model is used as-is." }[mode(o)])),
      h("div", {}, h("div", { class: "qlabel" }, "Free local model"),
        L.configured
          ? h("div", { class: "seg" },
              h("button", { "aria-pressed": String(!!L.enabled), onclick: () => !L.enabled && quickSet({ type: "local", value: true }, "Local model on for easy tasks.") }, "On"),
              h("button", { "aria-pressed": String(!L.enabled), onclick: () => L.enabled && quickSet({ type: "local", value: false }, "Local model off.") }, "Off"))
          : h("a", { href: "#providers", class: "learn" }, "Set up a local model →"),
        speed && h("div", { class: "help" }, speed)),
      h("div", { class: "quick-wide" }, h("div", { class: "qlabel" }, "Priority"),
        h("div", { class: "seg wrap" }, Object.entries(pr).map(([k, v]) =>
          h("button", { "aria-pressed": String(cur === k), onclick: () => cur !== k && quickSet({ type: "priority", name: k }, `Priority: ${v.label}.`) }, v.label))),
        h("div", { class: "help" }, pr[cur]?.description || "")),
      h("div", { class: "quick-wide" }, h("div", { class: "qlabel" }, "Providers, in order of use"),
        h("div", { class: "row" }, (o.providerList || []).map((p, i) =>
          h("label", { class: "chip" + (p.enabled ? "" : " off") },
            h("input", { type: "checkbox", checked: p.enabled, onchange: (e) => quickSet({ type: "provider", name: p.name, value: e.target.checked }, `${p.name} ${e.target.checked ? "on" : "off"}.`) }),
            `${i + 1}. ${p.name}`)),
          h("a", { href: "#providers", class: "learn" }, "Change order")))));
}

// Brave-style headline: what autoroute has done for you, from measured data.
// Shadow mode results: what routing would have done, measured on your real requests.
function shadowCard(o) {
  const sh = o.lifetime?.shadow;
  if (!o.shadow && !sh) return null;
  const head = h("div", { class: "spread" },
    h("h2", {}, o.shadow ? "👁 Shadow mode is on" : "Shadow mode results"),
    h("span", { class: "muted small" }, learn("what-is-shadow-mode")));
  if (!sh) {
    return h("section", { class: "card shadow" }, head,
      h("p", { class: "muted" }, "Nothing is being changed. Use Claude Code with ", h("code", {}, "claude-auto"), " as normal, and this card will show what routing would have saved, measured on your real requests."));
  }
  const tile = (value, label, sub) => h("div", { class: "hero-tile" }, h("div", { class: "hero-value" }, value), h("div", { class: "hero-label" }, label), sub && h("div", { class: "hero-sub" }, sub));
  return h("section", { class: "card shadow", "aria-label": "Shadow mode results" }, head,
    h("div", { class: "hero-grid shadow-grid" },
      tile(money(Math.max(0, sh.wouldSave)), "would have saved", sh.percentCheaper != null ? `${Math.round(sh.percentCheaper)}% of ${money(sh.paid)} · estimate` : null),
      tile(sh.cheaperModelShare != null ? Math.round(sh.cheaperModelShare) + "%" : "–", "of messages would use a cheaper model", `${sh.messages.toLocaleString()} messages so far`),
      tile(sh.rebuilds.toLocaleString(), "cache rebuilds counted", "switching isn't free; these are already subtracted")),
    o.shadow && h("div", { class: "row" },
      h("span", { class: "muted small" }, sh.messages >= 30 ? "Enough data to decide. Happy with this?" : `Give it about ${30 - sh.messages} more messages for a reliable picture.`),
      h("button", { class: "small primary", onclick: () => quickSet({ type: "mode", value: "on" }, "Routing is on. Watch the regret rate over the next few days.") }, "Turn routing on")));
}

function valueHero(v) {
  if (!v || !v.messages) {
    return h("div", { class: "card hero empty-hero" },
      h("div", { class: "hero-title" }, "Your savings will show up here"),
      h("p", { class: "muted" }, "Start Claude Code with ", h("code", {}, "claude-auto"), ". Every number on this page is measured from your own traffic."));
  }
  const tile = (value, label, sub, cls = "") => h("div", { class: "hero-tile " + cls }, h("div", { class: "hero-value" }, value), h("div", { class: "hero-label" }, label), sub && h("div", { class: "hero-sub" }, sub));
  return h("section", { class: "card hero", "aria-label": "Value since you started using autoroute" },
    h("div", { class: "spread" }, h("div", { class: "hero-title" }, "Since ", since(v.since)),
      h("span", { class: "muted small" }, `${v.messages.toLocaleString()} messages · ${v.requests.toLocaleString()} requests`)),
    h("div", { class: "hero-grid" },
      tile(money(v.saved), "saved", v.percentCheaper != null ? `${Math.round(v.percentCheaper)}% cheaper than without autoroute` : null, "accent"),
      tile(v.cheaperModelShare != null ? Math.round(v.cheaperModelShare) + "%" : "–", "of messages on a cheaper model", `${v.downgraded.toLocaleString()} messages` + (v.localMessages ? `, ${v.localMessages.toLocaleString()} free on your local model` : "")),
      tile(v.timeSavedMs != null ? "~" + dur(v.timeSavedMs) : "…", "time saved", v.timeSavedMs != null ? "estimated from your measured response times" : h("span", {}, "collecting response times · ", learn("why-does-time-saved-say-collecting", "why?"))),
      tile(v.failoverRequests.toLocaleString(), "failover rescues", v.failoverRequests ? "requests a backup served when the primary failed" : "no outages so far"),
      tile(v.upgraded.toLocaleString(), "upgraded to a stronger model", "hard messages given more capability"),
      tile(v.regretRate != null ? Math.round(v.regretRate) + "%" : "–", "regret rate", h("span", {}, `${(v.regrets || 0).toLocaleString()} overrides right after a cheaper pick · `, learn("what-is-the-regret-rate", "what's this?")), (v.regretRate || 0) > 10 ? "warn" : "")),
    h("div", { class: "hero-foot" },
      h("span", {}, `Without autoroute: ${money(v.withoutAutoroute)} · paid: ${money(v.paid)}`),
      h("span", {}, `Cache rebuilds: ${money(v.cacheRebuildCost)} (already subtracted)`),
      h("span", {}, `Router overhead: ${v.avgOverheadMs != null ? v.avgOverheadMs.toFixed(1) + " ms" : "–"} per request`)));
}

function viewOverview() {
  const o = state.overview;
  if (!o) return h("p", { class: "muted" }, "Loading…");
  const saved = (o.today.baseline || 0) - (o.today.actual || 0);
  const eff = state.cfg.effective;

  const providers = h("div", { class: "card" }, h("h2", {}, "Providers"),
    h("ul", { class: "checks" }, o.providers.map((p, i) => h("li", { class: p.up ? "ok" : "fail" },
      h("span", { class: "icon", "aria-hidden": "true" }, p.up ? "●" : "●"),
      h("div", { style: "flex:1" },
        h("div", { class: "spread" },
          h("strong", {}, p.provider),
          h("span", { class: "muted small" }, i === 0 ? "primary" : `backup ${i}`)),
        h("div", { class: "muted small" }, providerKind(eff.providers[p.provider]) + (p.auth === "passthrough" ? " · uses Claude Code's login" : "")),
        !p.up && h("div", { class: "fix" }, `Skipped for ${p.retryInSeconds}s more: ${p.lastError || "failed"}`),
        !p.up && h("button", { class: "small", style: "margin-top:6px", onclick: async () => { await api("providers/reset", { method: "POST", body: { name: p.provider } }); refresh(); } }, "Retry now"),
      )))));

  const checks = h("div", { class: "card" }, h("h2", {}, "Setup"),
    h("ul", { class: "checks" }, o.checks.map((c) => h("li", { class: c.level },
      h("span", { class: "icon", "aria-hidden": "true" }, { ok: "✓", warn: "!", fail: "✕", info: "+" }[c.level]),
      h("div", {}, h("div", {}, c.text), c.fix && h("div", { class: "fix" }, c.fix), c.help && h("div", { class: "small" }, learn(c.help)),
        /app icon/.test(c.text) && c.level === "info" &&
          h("button", { class: "small", style: "margin-top:6px", onclick: async () => {
            const r = await api("app", { method: "POST", body: { dock: true } });
            toast(r.messages.join("\n"), !r.ok); refresh();
          } }, "Add app icon"),
        /Status line/.test(c.text) && c.level !== "ok" && o.statusline === "none" &&
          h("button", { class: "small", style: "margin-top:6px", onclick: async () => { const r = await api("statusline", { method: "POST", body: { action: "install" } }); toast(r.message, !r.ok); refresh(); } }, "Install status line"))))));

  const rows = o.recent.map((r) => h("tr", {},
    h("td", { class: "mono when" }, time(r.ts)),
    h("td", {}, r.local ? h("span", { class: "pill local", title: r.model }, "Local model") : tierPill(r.tier),
      r.shadow ? h("div", { class: "muted small" }, `👁 would use ${r.wouldTier === "local" ? "local model" : TIER_LABEL[r.wouldTier] || r.wouldTier}`)
        : !r.local && r.wanted && r.wanted !== r.tier && h("div", { class: "muted small" }, `wanted ${TIER_LABEL[r.wanted]}`)),
    h("td", {}, r.local ? h("span", { class: "pill local" }, "local") : r.failover ? h("span", { class: "pill failover" }, r.provider) : r.provider),
    h("td", { class: "num" }, ktok(r.tokens || 0)),
    h("td", { class: "num" }, r.requests ? money(r.actual) : "…",
      r.shadow ? r.requests && r.would < r.actual && h("div", { class: "muted small" }, `would be ${money(r.would)}`)
        : r.requests && r.baseline > r.actual && h("div", { class: "muted small good" }, `−${money(r.baseline - r.actual)}`)),
    h("td", { class: "reason" }, r.reason)));

  return h("div", {},
    h("div", { class: "lede" }, h("h1", {}, "Overview"), h("p", { class: "muted" }, "What autoroute has done for you, and what it's doing right now.")),
    shadowCard(o),
    (o.lifetime?.messages || !(o.shadow || o.lifetime?.shadow)) && valueHero(o.lifetime),
    quickCard(o),
    h("h2", { class: "section" }, "Today"),
    h("div", { class: "grid cols-3" },
      stat("Paid today", money(o.today.actual), "API-equivalent cost"),
      stat("Without routing", money(o.today.baseline), "estimate"),
      stat("Saved today", money(saved), pct(saved, o.today.baseline) + " less", saved > 0)),
    h("div", { class: "grid cols-2", style: "margin-top:16px" }, providers, checks),
    h("div", { class: "card" }, h("div", { class: "spread" }, h("h2", {}, "Recent messages"), h("span", { class: "muted small" }, `classifier: ${o.classifier} · switching: ${o.switching}`)),
      o.recent.length
        ? h("div", { class: "table-wrap" }, h("table", { class: "recent" }, h("thead", {}, h("tr", {}, h("th", {}, "Time"), h("th", {}, "Model"), h("th", {}, "Provider"), h("th", { class: "num" }, "Context"), h("th", { class: "num" }, "Cost"), h("th", {}, "Why"))), h("tbody", {}, rows)))
        : h("div", { class: "empty" }, "No messages yet. Start Claude Code with ", h("code", {}, "claude-auto"), " and each message will show up here, with the model it got and why.")),
  );
}
function stat(label, value, sub, good) {
  return h("div", { class: "card stat" }, h("div", { class: "label" }, label), h("div", { class: "value" + (good ? " good" : "") }, value), h("div", { class: "sub" }, sub));
}

// ---------------------------------------------------------------- savings ---
async function viewSavings() {
  const d = await api(`savings?days=${state.savingsDays}`);
  const seg = h("div", { class: "seg", role: "group", "aria-label": "Time range" },
    [7, 30, 90].map((n) => h("button", { "aria-pressed": String(state.savingsDays === n), onclick: () => { state.savingsDays = n; render(); } }, `${n} days`)));
  const head = h("div", { class: "lede spread" }, h("div", {}, h("h1", {}, "Savings"), h("p", { class: "muted" }, "What you paid, compared with sending every message to the model Claude Code asked for.")), seg);
  if (!d.rows) return h("div", {}, head, h("div", { class: "card empty" }, "No data for this period yet."));

  const W = 900, H = 220, P = { l: 44, r: 8, t: 10, b: 26 };
  const max = Math.max(...d.series.map((s) => s.baseline), 0.0001);
  const bw = (W - P.l - P.r) / d.series.length;
  const y = (v) => H - P.b - (v / max) * (H - P.t - P.b);
  const every = Math.ceil(d.series.length / 10);
  const chart = svg("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Daily cost: paid versus without routing" },
    [0, 0.5, 1].map((f) => [svg("line", { class: "axis", x1: P.l, x2: W - P.r, y1: y(max * f), y2: y(max * f) }), svg("text", { x: P.l - 6, y: y(max * f) + 4, "text-anchor": "end" }, money(max * f))]),
    d.series.map((s, i) => {
      const x = P.l + i * bw + bw * 0.15, w = bw * 0.7;
      return [
        svg("rect", { class: "bar-base", x, width: w, y: y(s.baseline), height: Math.max(0, H - P.b - y(s.baseline)), rx: 3 }, svg("title", {}, `${s.date}: ${money(s.baseline)} without routing`)),
        svg("rect", { class: "bar-paid", x: x + w * 0.2, width: w * 0.6, y: y(s.actual), height: Math.max(0, H - P.b - y(s.actual)), rx: 2 }, svg("title", {}, `${s.date}: paid ${money(s.actual)}`)),
        i % every === 0 ? svg("text", { x: x + w / 2, y: H - 8, "text-anchor": "middle" }, s.date.slice(5)) : null,
      ];
    }));

  const total = Object.values(d.byTier).reduce((a, b) => a + b, 0) || 1;
  const colors = { haiku: "var(--haiku)", sonnet: "var(--sonnet)", opus: "var(--opus)" };
  return h("div", {}, head,
    h("div", { class: "grid cols-3" },
      stat("You paid", money(d.actual), `${d.turns} messages`),
      stat("Without routing", money(d.baseline), "estimate"),
      stat("Saved", money(d.saved), pct(d.saved, d.baseline) + " less", d.saved > 0)),
    h("div", { class: "card" }, h("h2", {}, "Per day"), chart,
      h("div", { class: "legend" }, h("span", {}, h("i", { style: "background:var(--accent)" }), "Paid"), h("span", {}, h("i", { style: "background:color-mix(in srgb, var(--muted) 25%, transparent)" }), "Without routing"))),
    h("div", { class: "grid cols-2", style: "margin-top:16px" },
      h("div", { class: "card" }, h("h2", {}, "Model mix"),
        h("div", { class: "mix" }, ["haiku", "sonnet", "opus"].map((t) => h("span", { style: `width:${((d.byTier[t] || 0) / total) * 100}%;background:${colors[t]}`, title: `${TIER_LABEL[t]}: ${d.byTier[t] || 0}` }))),
        h("div", { class: "row" }, ["haiku", "sonnet", "opus"].map((t) => h("span", { class: "muted small" }, tierPill(t), " ", d.byTier[t] || 0)))),
      h("div", { class: "card" }, h("h2", {}, "Switching and failover"),
        h("p", {}, `${d.misses} switch${d.misses === 1 ? "" : "es"} cost ${money(d.penalty)} in cache rebuilds (already counted above).`),
        h("p", { class: "muted" }, Object.entries(d.byProvider).map(([p, n]) => `${p}: ${n} requests`).join(" · ") + (d.failovers ? ` · ${d.failovers} on a backup` : "")))),
    h("p", { class: "muted small", style: "margin-top:16px" }, "\"Without routing\" assumes the requested model would have used the same number of tokens. Dollars are at the configured list prices. ", learn("how-are-the-savings-calculated-are-they-real")),
  );
}

// -------------------------------------------------------------- providers ---
const TEMPLATES = {
  bedrock: { label: "Amazon Bedrock", blurb: "Claude on AWS. Same models, separate infrastructure.", make: (kc) => ({
    type: "anthropic", baseUrl: "https://bedrock-mantle.us-east-1.api.aws/anthropic", forwardBetaHeaders: false,
    auth: kc ? { type: "bearer", keychain: "bedrock" } : { type: "bearer", env: "AWS_BEARER_TOKEN_BEDROCK" },
    models: { haiku: "anthropic.claude-haiku-5-5", sonnet: "anthropic.claude-sonnet-5-5", opus: "anthropic.claude-opus-5-5" } }) },
  vertex: { label: "Google Vertex AI", blurb: "Claude on Google Cloud. Uses your gcloud login.", make: () => ({
    type: "vertex", projectId: "", region: "global",
    auth: { type: "bearer", command: "gcloud auth print-access-token", cacheSeconds: 3000 },
    models: { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" } }) },
  gateway: { label: "Other gateway", blurb: "LiteLLM or similar, for another vendor as a last resort.", make: (kc) => ({
    type: "anthropic", baseUrl: "http://127.0.0.1:4000", forwardBetaHeaders: false,
    auth: kc ? { type: "x-api-key", keychain: "gateway" } : { type: "x-api-key", env: "GATEWAY_API_KEY" }, models: {} }) },
};

function input(p, attrs = {}) {
  return h("input", { type: "text", value: get(p) ?? "", ...attrs, oninput: (e) => set(p, attrs.type === "number" ? (e.target.value === "" ? undefined : Number(e.target.value)) : e.target.value) });
}
function field(labelText, control, help) {
  const id = "f" + Math.random().toString(36).slice(2, 8);
  control.id = id;
  return h("div", { class: "field" }, h("label", { for: id }, labelText), control, help && h("div", { class: "help" }, help));
}

async function viewProviders() {
  const keys = await api("keys");
  const order = get(["failover", "order"]) || [];
  const providers = get(["providers"]) || {};
  const health = Object.fromEntries((state.overview?.providers || []).map((p) => [p.provider, p]));
  const unused = Object.keys(providers).filter((n) => !order.includes(n));
  const kc = keys.backend.available;

  const move = (i, dir) => { ensureProviders(); const o = state.user.failover.order; [o[i], o[i + dir]] = [o[i + dir], o[i]]; markDirty(); render(); };
  const remove = (name) => { ensureProviders(); delete state.user.providers[name]; state.user.failover.order = state.user.failover.order.filter((n) => n !== name); markDirty(); render(); };
  const addTemplate = (key) => {
    ensureProviders();
    let name = key, i = 2;
    while (state.user.providers[name]) name = `${key}${i++}`;
    const p = TEMPLATES[key].make(kc);
    if (p.auth.keychain) p.auth.keychain = name;
    state.user.providers[name] = p;
    state.user.failover.order.push(name);
    markDirty(); render();
    toast(`Added "${name}". Fill in the details, then save and test it.`);
  };

  const card = (name, i) => {
    const P = (k) => ["providers", name, ...k];
    const p = providers[name] || {};
    const auth = p.auth || {};
    const isPrimary = i === 0;
    const hs = health[name];
    const result = state.results[name];
    const source = auth.keychain !== undefined ? "keychain" : auth.env !== undefined ? "env" : auth.command !== undefined ? "command" : auth.value !== undefined ? "value" : "keychain";
    const setSource = (s) => {
      ensureProviders();
      const a = state.user.providers[name].auth;
      delete a.keychain; delete a.env; delete a.command; delete a.value;
      if (s === "keychain") a.keychain = name; if (s === "env") a.env = "";
      markDirty(); render();
    };
    const edit = (p, v) => { ensureProviders(); set(p, v); };

    let cred;
    if (auth.type === "passthrough") {
      cred = h("p", { class: "muted" }, "Uses Claude Code's own credential: an API key or gateway token. (Claude Free, Pro and Max logins can't be routed; Team/Enterprise only with admin approval.)");
    } else if (auth.type === "none") {
      cred = h("p", { class: "muted" }, "No credential.");
    } else {
      const keyName = auth.keychain;
      const saved = keyName && keys.keys[keyName];
      const pw = h("input", { type: "password", placeholder: saved ? "Replace the saved key" : "Paste the API key", autocomplete: "off", spellcheck: "false" });
      cred = h("div", {},
        field("Credential", h("select", { onchange: (e) => setSource(e.target.value) },
          h("option", { value: "keychain", selected: source === "keychain" }, kc ? `Stored in ${keys.backend.name}` : "Stored in OS keychain (unavailable)"),
          h("option", { value: "env", selected: source === "env" }, "Environment variable"),
          source === "command" && h("option", { value: "command", selected: true }, "Command that prints a token"))),
        source === "keychain" && (kc
          ? h("div", { class: "field" },
              h("div", { class: "row" }, saved ? h("span", { class: "pill ok" }, "Key saved") : h("span", { class: "pill warn" }, "No key saved yet")),
              h("div", { class: "row", style: "margin-top:8px" }, pw,
                h("button", { onclick: async () => {
                  if (!pw.value.trim()) return toast("Paste a key first.", true);
                  if (state.dirty) return toast("Save your other changes first, so this key is linked to the saved provider.", true);
                  try { await api("keys", { method: "POST", body: { name: keyName, value: pw.value } }); pw.value = ""; toast("Key saved to " + keys.backend.name + ". It is never shown again."); render(); }
                  catch (e) { toast(e.message, true); }
                } }, "Save key"),
                saved && h("button", { class: "ghost danger", onclick: async () => { await api("keys", { method: "DELETE", body: { name: keyName } }); toast("Key removed."); render(); } }, "Remove")),
              h("div", { class: "help" }, "Kept in your operating system's secure storage, never in a file. The dashboard can't read it back."))
          : h("div", { class: "result fail" }, keys.backend.help)),
        source === "env" && field("Variable name", h("input", { type: "text", value: auth.env || "", placeholder: "e.g. AWS_BEARER_TOKEN_BEDROCK", oninput: (e) => edit(P(["auth", "env"]), e.target.value) }),
          "Export it in your shell profile (~/.zshrc or ~/.bashrc), then restart the router: autoroute restart"),
        source === "command" && field("Command", h("input", { type: "text", value: auth.command || "", readonly: true }),
          "Runs on your machine; its output is used as the token and cached for a while. For safety the dashboard can't change it: edit the config file instead."),
      );
    }

    const details = h("details", {}, h("summary", {}, "Connection details"),
      p.type === "vertex"
        ? [field("Project ID", h("input", { type: "text", value: p.projectId || "", oninput: (e) => edit(P(["projectId"]), e.target.value) })),
           field("Region", h("input", { type: "text", value: p.region || "global", oninput: (e) => edit(P(["region"]), e.target.value) }), "\"global\" or a region such as us-east5.")]
        : field("Endpoint URL", h("input", { type: "text", value: p.baseUrl || "", oninput: (e) => edit(P(["baseUrl"]), e.target.value) })),
      !isPrimary || p.models && Object.keys(p.models).length ? h("div", { class: "grid cols-3", style: "margin-top:14px" },
        ["haiku", "sonnet", "opus"].map((t) => field(`${TIER_LABEL[t]} model ID`, h("input", { type: "text", value: p.models?.[t] || "", placeholder: isPrimary ? state.cfg.effective.models[t] : "nearest tier", oninput: (e) => edit(P(["models", t]), e.target.value || undefined) })))) : null,
      h("div", { class: "grid cols-2", style: "margin-top:14px" },
        field("Price multiplier", h("input", { type: "number", step: "0.05", min: "0", value: p.priceMultiplier ?? 1, oninput: (e) => edit(P(["priceMultiplier"]), Number(e.target.value) || 1) }), "1.1 for +10% regional pricing."),
        h("div", { class: "field" }, h("label", { class: "toggle" }, h("input", { type: "checkbox", checked: p.forwardBetaHeaders ?? p.type === "anthropic", onchange: (e) => edit(P(["forwardBetaHeaders"]), e.target.checked) }), "Forward Anthropic beta headers"),
          h("div", { class: "help" }, "Turn off if this provider rejects Claude Code's beta features."))));

    return h("div", { class: "card provider" },
      h("div", { class: "order" },
        h("button", { "aria-label": `Move ${name} up`, disabled: i === 0, onclick: () => move(i, -1) }, "▲"),
        h("span", { class: "rank" }, i + 1),
        h("button", { "aria-label": `Move ${name} down`, disabled: i === order.length - 1, onclick: () => move(i, 1) }, "▼")),
      h("div", { class: "stack" },
        h("div", {}, h("div", { class: "row" }, h("h3", { style: "margin:0" }, name), h("span", { class: "muted" }, providerKind(p)),
            hs && h("span", { class: `pill ${hs.up ? "ok" : "down"}` }, hs.up ? "healthy" : `down, retry in ${hs.retryInSeconds}s`)),
          h("div", { class: "muted small" }, isPrimary ? "Primary: used whenever it's healthy." : `Backup ${i}: used if everything above it fails.`),
          h("label", { class: "toggle", style: "margin-top:6px" }, h("input", { type: "checkbox", checked: p.enabled !== false, onchange: (e) => edit(P(["enabled"]), e.target.checked) }), p.enabled === false ? "Switched off (skipped)" : "On")),
        cred, details,
        result && h("div", { class: "result " + (result.ok ? "ok" : result.ok === false ? "fail" : "") }, result.message)),
      h("div", { class: "row", style: "align-items:flex-start" },
        auth.type !== "passthrough" && h("button", { onclick: async (e) => {
          if (state.dirty) return toast("Save your changes first, then test.", true);
          e.target.disabled = true; e.target.textContent = "Testing…";
          state.results[name] = await api("providers/test", { method: "POST", body: { name } }).catch((err) => ({ ok: false, message: err.message }));
          render();
        } }, "Test"),
        !isPrimary && h("button", { class: "ghost danger", onclick: () => remove(name) }, "Remove")));
  };

  return h("div", {},
    h("div", { class: "lede" }, h("h1", {}, "Providers"),
      h("p", { class: "muted" }, "Each request goes to the first healthy provider. If it fails, the next one takes over, and the failed one is skipped for a while so your chat doesn't bounce back and forth. ", learn("what-happens-if-anthropic-has-an-outage"))),
    order.map(card),
    unused.length > 0 && h("div", { class: "card" }, h("h2", {}, "Configured but not in use"),
      unused.map((n) => h("div", { class: "spread", style: "padding:6px 0" }, h("span", {}, n), h("button", { class: "small", onclick: () => { ensureProviders(); state.user.failover.order.push(n); markDirty(); render(); } }, "Use as backup")))),
    localCard(health),
    h("div", { class: "card" }, h("h2", {}, "Add a backup"),
      h("p", { class: "muted" }, "Claude on Bedrock or Vertex is the best first backup: same models, so nothing about your results changes."),
      h("div", { class: "templates" }, Object.entries(TEMPLATES).map(([k, t]) => h("button", { class: "template", onclick: () => addTemplate(k) }, h("strong", {}, t.label), h("span", {}, t.blurb))))),
    h("div", { class: "card" }, h("h2", {}, "When to fail over"),
      h("div", { class: "grid cols-2" },
        h("div", {},
          h("label", { class: "toggle" }, h("input", { type: "checkbox", checked: get(["failover", "onRateLimit"]), onchange: (e) => set(["failover", "onRateLimit"], e.target.checked) }), "Also when rate-limited (429)"),
          h("div", { class: "help" }, "Useful to keep working after hitting your plan's usage limits."),
          h("label", { class: "toggle", style: "margin-top:12px" }, h("input", { type: "checkbox", checked: get(["failover", "onNetworkError"]), onchange: (e) => set(["failover", "onNetworkError"], e.target.checked) }), "On network errors and timeouts")),
        field("Skip a failed provider for (seconds)", input(["failover", "cooldownSeconds"], { type: "number", min: "10", step: "10" }),
          "Long enough that chats don't bounce: every switch costs a prompt-cache rebuild."))),
  );
}

// Free local model for easy tasks (opt-in).
function localCard(health) {
  const L = get(["local"]) || {};
  const name = L.provider || "local";
  const prov = (get(["providers"]) || {})[name];
  const result = state.results[name];
  const setLocal = (k, v) => set(["local", k], v);
  const enable = (on) => {
    ensureProviders();
    if (on && !state.user.providers[name]) {
      state.user.providers[name] = { type: "anthropic", baseUrl: "http://127.0.0.1:11434", auth: { type: "none" }, forwardBetaHeaders: false, priceMultiplier: 0 };
    }
    setLocal("enabled", on);
    if (on && !getIn(state.user, ["local", "model"])) setLocal("model", L.model || "qwen3-coder");
    render();
  };
  const useFor = new Set(L.useFor || ["haiku"]);
  const toggleUse = (t, on) => { on ? useFor.add(t) : useFor.delete(t); setLocal("useFor", [...useFor]); };

  return h("div", { class: "card" },
    h("div", { class: "spread" }, h("h2", {}, "Free local model for easy tasks"), h("span", { class: "pill plain" }, "optional")),
    h("p", { class: "muted" }, "Run easy tasks (git commands, renames, typos) on a model on your own computer, such as Ollama. They're free and your code stays on your machine. Claude still handles everything else. ",
      learn("how-do-i-set-up-a-free-local-model", "Setup guide and model suggestions")),
    h("p", { class: "small muted" }, "Local models aren't Claude, and Anthropic doesn't support Claude Code on other models, so results on easy tasks can differ. If the local model fails, the request goes to Claude automatically."),
    h("label", { class: "toggle", style: "margin-top:10px" }, h("input", { type: "checkbox", checked: !!L.enabled, onchange: (e) => enable(e.target.checked) }), "Use a local model for easy tasks"),
    L.enabled && h("div", { class: "stack", style: "margin-top:12px" },
      h("div", { class: "grid cols-2" },
        field("Local server address", h("input", { type: "text", value: prov?.baseUrl || "http://127.0.0.1:11434", oninput: (e) => { ensureProviders(); set(["providers", name, "baseUrl"], e.target.value); } }),
          "Ollama's default is http://127.0.0.1:11434. LM Studio's is http://127.0.0.1:1234."),
        field("Model name", h("input", { type: "text", value: L.model || "", placeholder: "e.g. qwen3-coder-32k", oninput: (e) => setLocal("model", e.target.value) }),
          "Exactly as your local server lists it (run: ollama list).")),
      h("div", {},
        h("label", {}, "Use it for"),
        h("label", { class: "toggle" }, h("input", { type: "checkbox", checked: useFor.has("haiku"), onchange: (e) => toggleUse("haiku", e.target.checked) }), "Easy tasks (what would go to Haiku)"),
        h("label", { class: "toggle", style: "margin-top:6px" }, h("input", { type: "checkbox", checked: useFor.has("sonnet"), onchange: (e) => toggleUse("sonnet", e.target.checked) }), "Everyday tasks too (what would go to Sonnet). Only with a strong model.")),
      slider(["local", "maxContextTokens"], "Largest chat to send to it", { min: 4000, max: 128000, step: 4000, fmt: (v) => ktok(v) + " tokens",
        help: "Keep this at or below the context length your local model is set to (see the setup guide). Bigger chats stay on Claude." }),
      slider(["local", "maxSlowdown"], "How much slower may it be than Claude?", { min: 0, max: 5, step: 0.5, fmt: (v) => (Number(v) === 0 ? "no limit" : `${v}x`),
        help: "Measured on your own easy tasks. If the local model gets slower than this, easy tasks go back to Claude (it's re-checked now and then). 0 = always use it." }),
      h("label", { class: "toggle" }, h("input", { type: "checkbox", checked: L.fallbackToClaude !== false, onchange: (e) => setLocal("fallbackToClaude", e.target.checked) }), "If it fails, use Claude instead"),
      h("div", { class: "row" },
        h("button", { onclick: async (e) => {
          if (state.dirty) return toast("Save your changes first, then test.", true);
          e.target.disabled = true; e.target.textContent = "Testing…";
          state.results[name] = await api("providers/test", { method: "POST", body: { name } }).catch((err) => ({ ok: false, message: err.message }));
          render();
        } }, "Test local model")),
      result && h("div", { class: "result " + (result.ok ? "ok" : "fail") }, result.message)));
}

// ---------------------------------------------------------------- routing ---
function seg(p, options) {
  const cur = get(p);
  return h("div", { class: "seg", role: "group" }, options.map(([v, label]) =>
    h("button", { "aria-pressed": String(cur === v), onclick: () => { set(p, v); render(); } }, label)));
}
function slider(p, label, { min, max, step, fmt = (v) => v, help }) {
  const out = h("output", {}, fmt(get(p)));
  const r = h("input", { type: "range", min, max, step, value: get(p), "aria-label": label, oninput: (e) => { const v = Number(e.target.value); out.textContent = fmt(v); set(p, v); } });
  return h("div", { class: "field" }, h("div", { class: "range-head" }, h("label", {}, label), out), r, help && h("div", { class: "help" }, help));
}

function viewRouting() {
  const tryBox = h("textarea", { placeholder: "e.g. refactor the payment module to use the strategy pattern", style: "min-height:80px;font-family:inherit;font-size:14px" });
  const tryOut = h("div", { class: "result", hidden: true });
  const lines = (p) => h("textarea", { value: (get(p) || []).join("\n"), oninput: (e) => set(p, e.target.value.split("\n").map((s) => s.trim()).filter(Boolean)) });

  return h("div", {},
    h("div", { class: "lede" }, h("h1", {}, "Routing"), h("p", { class: "muted" }, "How the router picks a model for each message, and when it's worth switching.")),
    h("div", { class: "grid cols-2" },
      h("div", { class: "card" }, h("h2", {}, "Step 1 · What does a message need?"),
        seg(["classifier", "type"], [["heuristic", "Rules"], ["llm", "Haiku classifier"]]),
        h("p", { class: "help", style: "margin-top:10px" }, get(["classifier", "type"]) === "llm"
          ? "Haiku reads each new message and picks a tier. Better with unusual phrasing; adds about half a second and ~$0.0001 per message. Falls back to the rules if it fails."
          : "Fast keyword and length rules. Free and instant. Tune them under Advanced below.")),
      h("div", { class: "card" }, h("h2", {}, "Step 2 · Is switching worth it?"),
        seg(["switching", "mode"], [["cost-aware", "Cost-aware"], ["always", "Always switch"]]),
        h("p", { class: "help", style: "margin-top:10px" }, get(["switching", "mode"]) === "always"
          ? "Always uses step 1's pick, even when rebuilding the prompt cache costs more than the cheaper model saves."
          : "Switches only when it saves money after counting the prompt-cache rebuild. Recommended.", " ", learn("why-didnt-it-switch-to-a-cheaper-model")))),
    h("div", { class: "card" }, h("div", { class: "spread" }, h("h2", {}, "Tuning"),
        h("button", { class: "small ghost", onclick: () => { delete state.user.switching; markDirty(); render(); } }, "Reset to defaults")),
      h("div", { class: "grid cols-2" },
        slider(["switching", "returnProbability"], "Chance you'll need the bigger model again", { min: 0, max: 1, step: 0.05, fmt: (v) => Math.round(v * 100) + "%", help: "Higher keeps long chats on the bigger model through short easy patches." }),
        slider(["switching", "maxUpgradeCacheCostUSD"], "Most to spend moving up a tier", { min: 0, max: 2, step: 0.05, fmt: (v) => "$" + Number(v).toFixed(2), help: "Cache rebuild cost limit for automatic upgrades. Above it, you'll see a suggestion to add !opus." }),
        slider(["switching", "expectedRequestsPerTurn"], "Requests per message", { min: 1, max: 12, step: 1, help: "Your message plus Claude's tool calls. More means each turn re-reads the context more often." }),
        slider(["switching", "expectedOutputTokens"], "Output per message", { min: 200, max: 8000, step: 100, fmt: (v) => ktok(v) + " tokens" }),
        slider(["switching", "bigContextTokens"], "Large chat threshold", { min: 20000, max: 1000000, step: 10000, fmt: (v) => ktok(v) + " tokens", help: "Above this size, never drop below the tier on the right." }),
        field("Minimum tier for large chats", h("select", { onchange: (e) => set(["switching", "bigContextMinTier"], e.target.value) },
          ["haiku", "sonnet", "opus"].map((t) => h("option", { value: t, selected: get(["switching", "bigContextMinTier"]) === t }, TIER_LABEL[t])))))),
    h("div", { class: "card" }, h("h2", {}, "Try a prompt"),
      h("p", { class: "muted" }, "See which model step 1 would pick (using saved settings). In a long, active chat, step 2 may keep the current model."),
      tryBox,
      h("div", { class: "row", style: "margin-top:10px" }, h("button", { class: "primary", onclick: async () => {
        const r = await api("explain", { method: "POST", body: { text: tryBox.value } });
        tryOut.hidden = false;
        tryOut.replaceChildren(tierPill(r.tier), " ", h("span", { class: "mono" }, r.model), h("div", { class: "muted", style: "margin-top:4px" }, r.reason + (r.score != null ? ` (score ${r.score})` : "")));
      } }, "Check")),
      tryOut),
    h("details", { class: "card" }, h("summary", {}, "Advanced: keyword rules"),
      h("p", { class: "help" }, "One regular expression per line, case-insensitive. Changing a list replaces the built-in one."),
      h("div", { class: "grid cols-2" },
        field("Signals a hard task (toward Opus)", lines(["classifier", "opusKeywords"])),
        field("Signals an easy task (toward Haiku)", lines(["classifier", "haikuKeywords"]))),
      h("div", { class: "grid cols-2", style: "margin-top:14px" },
        field("Score that wants Opus (at or above)", input(["classifier", "opusScore"], { type: "number", step: "0.5" })),
        field("Score that wants Haiku (at or below)", input(["classifier", "haikuScore"], { type: "number", step: "0.5" }))),
      h("button", { class: "small ghost", style: "margin-top:12px", onclick: () => { delete state.user.classifier; markDirty(); render(); } }, "Reset rules to defaults")),
  );
}

// ----------------------------------------------------------------- prices ---
function viewPrices() {
  const models = Object.keys(get(["prices"]) || {});
  const cols = [["in", "Input"], ["out", "Output"], ["read", "Cache read"]];
  const ensure = () => { if (!state.user.prices) state.user.prices = clone(state.cfg.effective.prices); };
  const num = (m, k) => h("input", { type: "number", step: "0.01", min: "0", value: get(["prices", m, k]), "aria-label": `${m} ${k}`,
    oninput: (e) => { ensure(); set(["prices", m, k], Number(e.target.value)); } });
  return h("div", {},
    h("div", { class: "lede" }, h("h1", {}, "Prices"), h("p", { class: "muted" }, "USD per million tokens. Used for switching decisions and savings reports. Cache writes are calculated: 1.25× input for the 5-minute cache, 2× for the 1-hour cache.")),
    h("div", { class: "card" },
      h("div", { class: "table-wrap" }, h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "Model"), cols.map(([, l]) => h("th", {}, l)))),
        h("tbody", {}, models.map((m) => [
          h("tr", {}, h("td", { class: "mono" }, m), cols.map(([k]) => h("td", {}, num(m, k)))),
          get(["prices", m, "longAbove"]) && h("tr", {}, h("td", { class: "muted small" }, `prompts over ${ktok(get(["prices", m, "longAbove"]))} tokens`),
            [["longIn"], ["longOut"], ["longRead"]].map(([k]) => h("td", {}, num(m, k)))),
        ])))),
      h("div", { class: "row", style: "margin-top:24px" },
        h("button", { class: "ghost", onclick: () => { delete state.user.prices; markDirty(); render(); } }, "Reset to built-in prices"),
        h("span", { class: "muted small" }, "Built-in prices are Anthropic's list prices as of this release."))),
  );
}

// ------------------------------------------------------------------- help ---
let helpCache = null;
async function viewHelp(anchor) {
  if (!helpCache) {
    const res = await fetch("/ui/help.md", { credentials: "same-origin" });
    helpCache = await res.text();
  }
  const sections = parseHelp(helpCache);
  const o = state.overview;
  const problems = (o?.checks || []).filter((c) => c.level === "fail" || c.level === "warn");

  const blocks = sections.map((sec) => {
    const items = sec.items.map((it) => {
      const d = h("details", { class: "qa", id: `help-${it.id}`, "data-text": (sec.title + " " + it.text).toLowerCase() },
        h("summary", {}, it.question), h("div", { class: "answer" }, it.body));
      return d;
    });
    return h("section", { class: "card help-section", "data-section": "" }, h("h2", {}, sec.title), sec.intro, items);
  });

  const empty = h("div", { class: "card empty", hidden: true }, "No answers match. Try different words, or ", learn("how-do-i-report-a-problem", "ask for help"), ".");
  const search = h("input", { type: "search", placeholder: "Search help, e.g. \"subscription\", \"keys\", \"outage\"", "aria-label": "Search help",
    oninput: (e) => {
      const q = e.target.value.trim().toLowerCase();
      let any = false;
      for (const sec of blocks) {
        let shown = 0;
        for (const d of sec.querySelectorAll("details.qa")) {
          const hit = !q || q.split(/\s+/).every((w) => d.dataset.text.includes(w));
          d.hidden = !hit; d.open = !!q && hit; if (hit) shown++;
        }
        sec.hidden = shown === 0; any ||= shown > 0;
      }
      empty.hidden = any;
    } });

  const aiCard = h("div", { class: "card" }, h("h2", {}, "Ask your own AI assistant"),
    h("p", { class: "muted" }, "Copy all of claude-autoroute's documentation in a form made for AI assistants, then paste it into Claude, ChatGPT or another assistant before your question. Add the output of ", h("code", {}, "autoroute diagnostics"), " for better answers. Never paste API keys or your config file."),
    h("div", { class: "row" },
      h("button", { class: "primary", onclick: async (e) => {
        const text = await (await fetch("/ui/llms-full.txt", { credentials: "same-origin" })).text();
        try { await navigator.clipboard.writeText(text); e.target.textContent = `Copied ✓ (${Math.round(text.length / 1000)}k characters)`; }
        catch { toast("Couldn't copy automatically. Use the download link instead.", true); }
      } }, "Copy help for an AI assistant"),
      h("a", { href: "/ui/llms-full.txt", download: "claude-autoroute-llms-full.txt" }, "Download llms-full.txt"),
      h("span", { class: "muted small" }, "or run ", h("code", {}, "autoroute llms"))),
    h("p", { class: "small muted", style: "margin-top:8px" }, learn("can-i-ask-my-own-ai-assistant-for-help-with-claude-autoroute")));
  const diagOut = h("pre", { class: "diag", hidden: true });
  const diag = h("div", { class: "card" }, h("h2", {}, "Report a problem"),
    h("p", { class: "muted" }, "Copies a snapshot of versions, settings and health checks for a bug report. Keys, prompts, web addresses, provider names and your username are removed. You can see exactly what's included before pasting it anywhere."),
    h("div", { class: "row" },
      h("button", { class: "primary", onclick: async (e) => {
        const d = await api("diagnostics");
        const text = JSON.stringify(d, null, 2);
        diagOut.textContent = text; diagOut.hidden = false;
        try { await navigator.clipboard.writeText(text); e.target.textContent = "Copied ✓"; }
        catch { e.target.textContent = "Select the text below to copy"; }
      } }, "Copy diagnostics"),
      h("span", { class: "muted small" }, "or run ", h("code", {}, "autoroute diagnostics"))),
    diagOut);

  const glance = h("div", { class: "card" }, h("h2", {}, "Your setup at a glance"),
    problems.length
      ? h("ul", { class: "checks" }, problems.slice(0, 6).map((c) => h("li", { class: c.level },
          h("span", { class: "icon", "aria-hidden": "true" }, c.level === "fail" ? "✕" : "!"),
          h("div", {}, h("div", {}, c.text), c.fix && h("div", { class: "fix" }, c.fix), c.help && h("div", { class: "small" }, learn(c.help))))))
      : h("p", { class: "good" }, "✓ Everything looks good."),
    h("p", { class: "small muted", style: "margin-top:8px" }, "Full list on the ", h("a", { href: "#overview" }, "Overview"), " page."));

  const node = h("div", {},
    h("div", { class: "lede" }, h("h1", {}, "Help"), h("p", { class: "muted" }, "Answers, fixes and the words this project uses. The same text is in HELP.md in the project.")),
    h("div", { class: "help-search" }, search),
    glance, blocks, empty, aiCard, diag);

  return node;
}

// ----------------------------------------------------------------- router ---
const VIEWS = { overview: viewOverview, savings: viewSavings, providers: viewProviders, routing: viewRouting, prices: viewPrices, help: viewHelp };
async function render() {
  const [name, anchor] = (location.hash.slice(1) || "overview").split("?")[0].split("/");
  const view = VIEWS[name] || viewOverview;
  for (const a of document.querySelectorAll("#nav a")) a.toggleAttribute("aria-current", a.getAttribute("href") === "#" + name) && a.setAttribute("aria-current", "page");
  try {
    const node = await view(anchor);
    const scroll = window.scrollY;
    $("#view").replaceChildren(node);
    const target = anchor && document.getElementById(`help-${anchor}`);
    if (target) { target.open = true; target.scrollIntoView({ block: "start" }); target.querySelector("summary")?.focus({ preventScroll: true }); }
    else window.scrollTo(0, scroll);
  } catch (e) {
    if (e.message !== "session expired") $("#view").replaceChildren(h("div", { class: "card result fail" }, e.message));
  }
}
async function refresh() {
  try { state.overview = await api("overview"); renderStatus(); } catch { return; }
  const name = location.hash.slice(1) || "overview";
  const editing = document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if (name === "overview" && !editing) render();
}

async function start() {
  $("#save").addEventListener("click", save);
  $("#discard").addEventListener("click", async () => { await loadConfig(); render(); });
  window.addEventListener("hashchange", () => { render(); $("#view").focus({ preventScroll: true }); });
  window.addEventListener("beforeunload", (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ""; } });
  try { await loadConfig(); state.overview = await api("overview"); } catch { return; }
  if (state.cfg.hasComments) toast("Note: saving from the dashboard rewrites config.jsonc without its comments. The previous version is kept as config.jsonc.bak.");
  renderStatus();
  render();
  state.timer = setInterval(refresh, 4000);
}
start();
