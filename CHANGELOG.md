# Changelog

## 0.1.0 (unreleased)

First release.

**Subscription mode for Claude Free, Pro and Max (2026-11-08)**

Pro and Max logins can't be routed, so `claude-auto` used to start Claude Code and then refuse every request. Now:

- **`"mode": "auto"`** (new default): `claude-auto` detects a subscription login (never reading a token) and runs Claude Code straight to Anthropic, without the router. `autoroute mode [auto|router|subscription]` shows or sets it.
- **Starting model:** in subscription mode, `claude-auto "<prompt>"` starts Claude Code on the model the prompt needs (`--model`), honoring `allowedTiers`, your organization's `availableModels` and `!opus`-style tags. `subscription.startModel` sets the model for chats started without a prompt (`opusplan` included).
- **Model tips:** `autoroute hints install` adds a local Claude Code hook that suggests `/model` switches; quiet in long chats and never repeated. Shown in the status line too.
- **`autoroute usage`:** usage by model from Claude Code's own transcripts (any login), the last 5 hours, and an estimate of what better-fitting models would have used.
- **Setup:** "Personal Claude Pro or Max" now sets up subscription mode instead of stopping. Unapproved Team/Enterprise logins fall back to it as well. `doctor`, `selftest` and the dashboard explain the mode.
- The router remembers the kind of login it last saw (never the credential), so `claude-auto` can choose the mode.

**Licence (2026-11-06):** PolyForm Noncommercial 1.0.0, copyright Steve Bragg, replacing MIT. Contributions are licensed to the maintainer under MIT (see `CONTRIBUTING.md`).

**First-run experience (2026-11-06)**

- **`./install.sh`:**
  - one step, no admin rights needed: falls back to `~/.local`
  - checks Node.js
  - uses a private npm cache, which avoids a broken `~/.npm`
  - then starts the guided setup
- **`autoroute setup`:**
  - asks how Claude Code signs you in
  - handles Team/Enterprise admin approval
  - starts in shadow mode
  - adds the status line and runs the self-test
  - every question also has a flag
- **Shadow mode** (`autoroute shadow on|off`, dashboard Routing → Shadow):
  - decides without changing anything, and records what routing would have cost, cache rebuilds included
  - results are shown in `stats`, on the dashboard and in the status line
- **`autoroute selftest`:**
  - sends one tiny real message through your Claude Code and the router
  - reports your login type, and explains refusals with the exact fix
- **Trial check in `autoroute stats`:** four first-week targets (savings, regret rate, overhead, router errors) with a verdict.
- **Company proxies:** the router uses `HTTPS_PROXY` automatically (Node 22.21+/24.5+), and `doctor`/`selftest` flag older Node versions.
- **Help:**
  - new guides: "Set up on a work laptop", "What do I ask my admin?", "What is shadow mode?", "Your first week", Enterprise credit limits
  - troubleshooting for install, PATH, self-test and proxy problems

**Engineering review fixes (2026-11-06)**

- **Regret rate:** a new quality statistic. It counts how often you override upward (`!opus`, `!sonnet`) right after the router picked a cheaper model. Shown in the dashboard, `autoroute stats` and `--json`.
- **Request size limit:** requests over `limits.maxRequestMB` (default 50) are refused with HTTP 413 instead of being buffered.
- **Config parsing:** trailing commas inside strings were wrongly removed, which could change a regex setting. Fixed.
- **Separate sessions:** two chats that start with the same message no longer share routing state. The key now includes Claude Code's session ID.
- **Housekeeping:** `router.log` rotates at `limits.logMB`; `stats.jsonl` keeps `limits.statsDays` of history. Lifetime totals are kept separately, so nothing is lost.
- **Safe stop:** `autoroute stop` only signals a process that really is the router, never a stale PID that now belongs to another program.
- **Graceful shutdown:** in-flight responses finish (up to 10 s), and stats are flushed. A port already in use gives a clear message.
- **Node.js 20+:** Node 18 is end-of-life and is no longer listed as supported.
- **Tests:** 92 → 126. New CLI, help-renderer and hardening tests. Sleeps are replaced with polling. A coverage floor and a mutation check run in CI.
- **CI/CD:**
  - all actions pinned to commit SHAs, with Dependabot
  - job timeouts and concurrency
  - packaged-install smoke test
  - shellcheck and actionlint
  - a tag-driven release workflow with checksums and build-provenance attestation

- **Routing:** per-message routing between Haiku, Sonnet and Opus. Uses keyword rules or a Haiku classifier, honors `!opus` / `!sonnet` / `!haiku` overrides, and keeps follow-up replies on the current model.
- **Cost-aware switching:** before switching, estimates the turn's cost from real prices and prompt-cache state. Switch costs are spread over streaks of easy messages, and upgrades are capped when the cache rebuild is expensive.
- **Turn consistency:** all tool calls for one message stay on the same model.
- **Failover:** multi-provider failover with a circuit breaker and cooldown. Supports any Anthropic-compatible endpoint (Anthropic, Amazon Bedrock Mantle, LiteLLM and similar gateways) and Google Vertex AI.
- **Credential isolation:** your Anthropic credentials are stripped from requests to backups, each provider gets only its own credential (from env or a command), and a local key guards the router.
- **Spend tracking:** `autoroute savings`, plus a status line showing the router's pick, the provider and today's spend.
- **Commands:** `autoroute init`, `doctor`, `status`, `log`, `explain`, `start` / `stop` / `restart`, `statusline install` / `remove`.
- **Supported services and apps documented:** Claude Code CLI on macOS and Linux, with an API key, Bedrock, Vertex or a company gateway.
- **Subscription logins refused:** Claude Free, Pro and Max logins are refused with an explanation, per Anthropic's terms. Team/Enterprise logins work only with an explicit opt-in.
- **Organization model rules:** `availableModels` restrictions from managed settings, the admin console cache and user settings are honored, and so is the new `allowedTiers` setting.
- **Dashboard:** `autoroute ui` opens it, identical on macOS and Linux. It covers setup checks, provider management with connection tests, tuning, prices, and a live decision feed. It's locked down with one-time links, Host/Origin/CSRF checks and a strict CSP.
- **Quick settings:** in the dashboard and as terminal commands.
  - **Routing:** pause or resume.
  - **Local model:** on or off.
  - **Providers:** switch each one on or off.
  - **Priority presets:** Lowest cost, Balanced, Fastest and Best quality, each with a plain description of what it changes.
- **Speed guard for the local model:** compares measured local and Claude response times on easy tasks, keeps easy tasks on Claude while the local model is more than `local.maxSlowdown` (default 2x) slower, and re-checks periodically.
- **Status endpoint:** `/__autoroute/status` for other tools. It needs the local key and never includes prompt text. The open health check now reveals only that the router is running.
- **Free local model for easy tasks (optional):** works with Ollama, LM Studio or llama.cpp.
  - **Decisions:** it goes through the same cost check, a context-size cap and your organization's model rules.
  - **Requests to it:** Claude-only fields and credentials are removed, and errors fall back to Claude automatically.
  - **Visibility:** messages on it are labeled "local" in the dashboard and status line, and counted at $0.
  - **Setup:** a dashboard setup card, plus a setup guide with model suggestions by memory size.
- **GitHub Actions workflow** regenerates and commits `llms.txt` / `llms-full.txt` when docs change on `main`, including web-editor edits. It's write-scoped to repository contents, never runs for fork pull requests, and installs no dependencies. CI runs macOS on one Node version to fit private-repo free minutes.
- **Docs can't fall behind:** tests require every setting to be in `config.example.jsonc`, every command to be in the README, and every doc file to be in the AI-assistant files. The pre-commit hook regenerates `llms.txt` / `llms-full.txt`, and there's a pull-request checklist.
- **Docs for AI assistants:** `llms.txt` (index) and `llms-full.txt` (all user docs), generated from the Markdown docs and checked for freshness in tests. A dashboard "Copy help for an AI assistant" button and `autoroute llms`.
- **Help:** HELP.md, covering getting started, FAQ, troubleshooting and a glossary. It's also built into the dashboard, with search, a setup summary, "Learn more" links from every page, and **Copy diagnostics** (also `autoroute diagnostics`), a redacted support snapshot.
- **App icon:** `autoroute app install` creates a native launcher for the dashboard: a `.app` bundle on macOS, or a `.desktop` entry with icons on Linux, with an optional GNOME dock pin. No extra tools needed.
- **OS keychain storage for API keys:** macOS Keychain, or the Secret Service on Linux. Keys never go through command-line arguments, and there is no plaintext fallback.
- **Measured value statistics:** money saved, cheaper-model share, upgrades, failover rescues, estimated time saved from your own response times, router overhead and cache-rebuild cost. Shown in the dashboard and in `autoroute stats [--json]`.
- **Publishing safeguards:** secret and personal-data scanner, npm package allowlist check, pre-commit hook, and CI on Linux and macOS.
