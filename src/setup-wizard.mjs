// `autoroute setup`: a short guided setup that leaves you with a safe, working config.
// Every question has a flag, so it can also run unattended:
//   autoroute setup --login enterprise --admin-approved --yes
import { configPath, buildConfig, validateConfig } from "./config.mjs";
import { readUserConfig, saveUserConfig, applyQuick } from "./quick.mjs";
import { ensureSecret, secureHome } from "./util.mjs";
import { installStatusline, statuslineState } from "./setup.mjs";

export const LOGINS = {
  "api-key": "Claude API key (Claude Console)",
  enterprise: "Company login: Claude Team or Enterprise",
  personal: "Personal Claude Pro or Max",
  cloud: "Amazon Bedrock, Google Vertex AI or a company LLM gateway",
  unsure: "Not sure",
};

export function parseSetupArgs(args) {
  const o = { yes: args.includes("--yes") || args.includes("-y") };
  const i = args.indexOf("--login");
  if (i >= 0) o.login = args[i + 1];
  if (args.includes("--admin-approved")) o.adminApproved = true;
  if (args.includes("--no-shadow")) o.shadow = false;
  if (args.includes("--shadow")) o.shadow = true;
  if (args.includes("--no-statusline")) o.statusline = false;
  if (args.includes("--no-selftest")) o.selftest = false;
  return o;
}

/**
 * opts: answers from flags. ask(question, choices|null, def) returns the answer
 * (only called for questions without a flag, and never with --yes).
 * Returns { ok, stop, config, selftest: bool, lines }.
 */
export async function runSetup({ home, env = process.env, opts = {}, ask, print = console.log }) {
  const q = async (key, question, choices, def) => {
    if (opts[key] !== undefined) return opts[key];
    if (opts.yes || !ask) return def;
    return ask(question, choices, def);
  };
  print("autoroute setup: about a minute. Press Enter to accept the [default].\n");

  // 1. Which login? This decides whether autoroute can work for you at all.
  print("How does Claude Code sign you in? (Not sure? Run `claude`, then type /status.)");
  const login = await q("login", "Your login", Object.keys(LOGINS), "unsure");
  if (!LOGINS[login]) { print(`Unknown login "${login}". Use one of: ${Object.keys(LOGINS).join(", ")}`); return { ok: false, stop: true }; }

  if (login === "personal") {
    print("\nautoroute can't be used with a personal Claude Pro or Max login. Anthropic doesn't allow third-party tools to");
    print("route those requests. Nothing was changed. Keep using `claude` as normal, or use a Claude API key instead.");
    return { ok: false, stop: true };
  }

  const { user } = readUserConfig(home);
  let next = JSON.parse(JSON.stringify(user));
  if (login === "enterprise") {
    print("\nTeam and Enterprise logins need your Claude admin's OK before a tool like this may carry them.");
    print("Until then autoroute refuses them, and nothing is sent. (HELP.md: \"What do I ask my admin?\")");
    const approved = await q("adminApproved", "Has your admin approved it? (y/N)", null, false);
    if (approved === true || /^y/i.test(String(approved))) {
      next.subscriptionLogin = "allow-team-enterprise";
      print("  -> Enterprise login allowed (subscriptionLogin: allow-team-enterprise).");
    } else {
      next.subscriptionLogin = "refuse";
      print("  -> Left off. Ask your admin, then run: autoroute setup --login enterprise --admin-approved");
    }
  } else if (login === "cloud") {
    print("\nAdd your provider on the dashboard's Providers page (autoroute ui), or copy one of the files in examples/.");
  } else if (login === "unsure") {
    print("\nNo problem. The self-test at the end will tell you which login Claude Code uses.");
  }

  // 2. Shadow mode first: no risk, real numbers.
  print("\nStart in shadow mode? autoroute works out which model it would pick and what that would save,");
  print("but changes nothing. Recommended for your first day.");
  const shadow = await q("shadow", "Shadow mode (Y/n)", null, true);
  const shadowOn = shadow === true || (typeof shadow === "string" && !/^n/i.test(shadow));
  next = applyQuick(next, buildConfig(next, env), { type: "mode", value: shadowOn ? "shadow" : "on" });
  if (!next.priority) next = applyQuick(next, buildConfig(next, env), { type: "priority", name: "balanced" });

  const built = buildConfig(next, env);
  const errors = validateConfig(built);
  if (errors.length) { print(`\nNot saved, the config has problems:\n  - ${errors.join("\n  - ")}`); return { ok: false, stop: true }; }
  secureHome(home);
  saveUserConfig(home, next);
  ensureSecret(home);
  print(`\nSaved ${configPath(home)}${shadowOn ? " (shadow mode on)" : " (routing on)"}.`);

  // 3. Status line: see each decision as it happens.
  if (statuslineState(env) === "none") {
    const sl = await q("statusline", "\nShow autoroute's pick in Claude Code's status line? (Y/n)", null, true);
    if (sl === true || (typeof sl === "string" && !/^n/i.test(sl))) print("  -> " + installStatusline(env).message);
  }

  // 4. Self-test: one real, tiny message (the caller runs it).
  const st = await q("selftest", "\nRun a quick self-test now? It sends one tiny message through Claude Code (under a cent). (Y/n)", null, true);
  const wantsTest = st === true || (typeof st === "string" && !/^n/i.test(st));
  return { ok: true, config: built, login, shadow: shadowOn, selftest: wantsTest && !(login === "enterprise" && next.subscriptionLogin === "refuse") };
}
