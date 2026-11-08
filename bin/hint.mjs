#!/usr/bin/env node
// Claude Code UserPromptSubmit hook: in subscription mode, suggests a /model switch when a
// message looks like it needs a different model. It runs on this computer, reads only the
// prompt Claude Code hands it and the model of the chat's last reply, stores no prompt
// text and sends nothing anywhere. Installed with `autoroute hints install`.
// It never blocks or changes your message, and stays silent on any error.
import { homeDir, loadConfig, validateConfig } from "../src/config.mjs";
import { hintFor, transcriptTail, readHints, saveHint, permittedTiers } from "../src/subscription.mjs";
import { tierOf } from "../src/classify.mjs";

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  try {
    // In router mode the router picks the model itself; nothing to suggest.
    if (process.env.AUTOROUTE_ACTIVE === "1") return;
    const j = JSON.parse(input || "{}");
    const home = homeDir();
    const cfg = loadConfig(home);
    if (validateConfig(cfg).length) return;
    const tail = j.transcript_path ? transcriptTail(j.transcript_path) : null;
    const start = tierOf(process.env.AUTOROUTE_START_MODEL || "");
    const current = tail?.tier ? tail : start ? { tier: start, contextTokens: 0 } : null;
    const last = readHints(home)[j.session_id]?.tier || null;
    const h = hintFor({ prompt: j.prompt, current, last, cfg, permitted: permittedTiers(cfg) });
    if (h.tier !== last) saveHint(home, j.session_id, h.tier);
    if (h.message) process.stdout.write(JSON.stringify({ systemMessage: h.message }));
  } catch {}
});
