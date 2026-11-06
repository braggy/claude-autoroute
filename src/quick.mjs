// Quick settings: one-step changes shared by the dashboard and the command line.
// Each takes the user's config (as saved on disk) and returns the changed copy.
import fs from "node:fs";
import path from "node:path";
import { configPath, parseJsonc } from "./config.mjs";

export const PRESETS = {
  "lowest-cost": {
    label: "Lowest cost",
    description: "Use the free local model for easy tasks even if it's slower, switch to cheaper models more readily, and spend less on cache rebuilds to move up.",
    apply(u, hasLocal) {
      set(u, ["switching", "mode"], "cost-aware");
      set(u, ["switching", "returnProbability"], 0.3);
      set(u, ["switching", "maxUpgradeCacheCostUSD"], 0.25);
      u.allowedTiers = ["haiku", "sonnet", "opus"];
      if (hasLocal) { set(u, ["local", "enabled"], true); set(u, ["local", "maxSlowdown"], 0); }
    },
  },
  balanced: {
    label: "Balanced",
    description: "The default. Switch only when it saves money, and use the local model only while it's no more than twice as slow as Claude.",
    apply(u) {
      set(u, ["switching", "mode"], "cost-aware");
      set(u, ["switching", "returnProbability"], 0.5);
      set(u, ["switching", "maxUpgradeCacheCostUSD"], 0.5);
      u.allowedTiers = ["haiku", "sonnet", "opus"];
      set(u, ["local", "maxSlowdown"], 2);
    },
  },
  fastest: {
    label: "Fastest",
    description: "Keep everything on Claude (no local model) and always use the model each message needs, even when switching costs a little more.",
    apply(u) {
      set(u, ["switching", "mode"], "always");
      set(u, ["switching", "returnProbability"], 0.5);
      set(u, ["switching", "maxUpgradeCacheCostUSD"], 0.5);
      u.allowedTiers = ["haiku", "sonnet", "opus"];
      set(u, ["local", "enabled"], false);
    },
  },
  "best-quality": {
    label: "Best quality",
    description: "Never use Haiku or the local model, and move up to Opus whenever a message needs it. Costs more.",
    apply(u) {
      set(u, ["switching", "mode"], "cost-aware");
      set(u, ["switching", "maxUpgradeCacheCostUSD"], 2);
      u.allowedTiers = ["sonnet", "opus"];
      set(u, ["local", "enabled"], false);
    },
  },
};

function set(o, p, v) {
  let cur = o;
  p.slice(0, -1).forEach((k) => { if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {}; cur = cur[k]; });
  cur[p.at(-1)] = v;
}

/**
 * action: { type: "pause", value: bool } | { type: "shadow", value: bool } | { type: "mode", value: "on"|"shadow"|"paused" }
 *       | { type: "local", value: bool }
 *       | { type: "provider", name, value: bool } | { type: "priority", name }
 * effective: the full current config (for provider lists and defaults).
 */
export function applyQuick(user, effective, action) {
  const u = JSON.parse(JSON.stringify(user || {}));
  switch (action.type) {
    case "pause": u.paused = !!action.value; break;
    case "shadow": u.shadow = !!action.value; if (action.value) u.paused = false; break;
    case "mode": // the dashboard's Routing control: on | shadow | paused
      if (!["on", "shadow", "paused"].includes(action.value)) throw Object.assign(new Error(`unknown mode "${action.value}" (use on, shadow or paused)`), { status: 422 });
      u.paused = action.value === "paused";
      u.shadow = action.value === "shadow";
      break;
    case "local":
      if (action.value && !effective.providers[effective.local?.provider || "local"]) {
        throw Object.assign(new Error("Set up a local model first (Providers page, or HELP.md: \"How do I set up a free local model?\")."), { status: 422 });
      }
      set(u, ["local", "enabled"], !!action.value);
      break;
    case "provider": {
      if (!effective.providers[action.name]) throw Object.assign(new Error(`unknown provider "${action.name}"`), { status: 422 });
      if (!u.providers) u.providers = JSON.parse(JSON.stringify(effective.providers));
      if (!u.failover?.order) set(u, ["failover", "order"], [...effective.failover.order]);
      u.providers[action.name].enabled = !!action.value;
      break;
    }
    case "priority": {
      const p = PRESETS[action.name];
      if (!p) throw Object.assign(new Error(`unknown priority "${action.name}" (use ${Object.keys(PRESETS).join(", ")})`), { status: 422 });
      p.apply(u, !!effective.providers[effective.local?.provider || "local"]);
      u.priority = action.name;
      break;
    }
    default: throw Object.assign(new Error("unknown quick setting"), { status: 400 });
  }
  return u;
}

// ------------------------------------------------- reading & saving config ---
export function readUserConfig(home) {
  const p = configPath(home);
  if (!fs.existsSync(p)) return { path: p, user: {}, hasComments: false };
  const text = fs.readFileSync(p, "utf8");
  const body = text.split("\n").filter((l) => !l.startsWith("// Managed by autoroute") && !l.startsWith("// not kept when") && !l.startsWith("// Every setting is documented")).join("\n");
  return { path: p, user: parseJsonc(text), hasComments: /^\s*\/\/|\/\*/m.test(body) };
}

export function saveUserConfig(home, user) {
  const p = path.join(home, "config.jsonc");
  const existing = configPath(home);
  if (fs.existsSync(existing)) { fs.copyFileSync(existing, p + ".bak"); fs.chmodSync(p + ".bak", 0o600); }
  const header = "// Managed by autoroute (dashboard or quick commands). You can still edit this file by hand, but comments are\n" +
                 "// not kept when autoroute saves. The previous version is in config.jsonc.bak.\n" +
                 "// Every setting is documented in config.example.jsonc.\n";
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, header + JSON.stringify(user, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, p);
  if (existing !== p && fs.existsSync(existing)) fs.renameSync(existing, existing + ".old");
}
