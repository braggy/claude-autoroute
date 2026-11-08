# Security

claude-autoroute sits between Claude Code and your model providers, so it handles your credentials and your code. This page explains how it protects them and how to report a problem.

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Use GitHub's private vulnerability reporting: the **Security** tab of this repository, then **Report a vulnerability**. Include steps to reproduce if you can. We aim to respond within a week.

## What the router protects, and how

| Risk | Protection |
|---|---|
| Your Anthropic API key or login reaching another company | Credential headers (`authorization`, `x-api-key`, and OAuth markers in `anthropic-beta`) are removed from every request to a provider that doesn't use `passthrough` auth. The config validator rejects `passthrough` on any provider except the primary. Covered by tests. |
| Other local programs using the router to spend your backup credentials | Every request must carry a random secret header (`x-autoroute-key`), stored in `~/.claude-autoroute/local-key` with mode `0600`. `claude-auto` adds it through `ANTHROPIC_CUSTOM_HEADERS`. Requests without it get `401`. |
| Using an account in a way its provider prohibits | Claude Free, Pro and Max subscription logins are detected and refused before anything is forwarded, because Anthropic doesn't allow third-party tools to route them. Team/Enterprise logins need an explicit opt-in. That opt-in is the user's own statement that their admin approved it: subscription logins look the same for every plan, so the router can't check it. Subscription mode never puts the router in the path: Claude Code talks to Anthropic directly, and login detection never reads a token. Your organization's `availableModels` restriction is always honored, with exact model matches only. Covered by tests. |
| Other local programs reading your usage | The open `/__autoroute/health` check only says the router is running (version and process ID). Spending, provider health and decisions are at `/__autoroute/status`, which needs the local key. |
| Remote access | The router binds to `127.0.0.1` by default. Changing `host` exposes it to your network, so don't. |
| Your code or prompts persisting on disk | Prompt text is never written to disk, or shown in the dashboard. The log has the chosen tier and reason; stats have token counts, timings and a hash of the conversation's first message. `logPromptSnippets` (off by default) adds 60 characters of each prompt to the log. |
| Other users on the machine reading runtime data | `~/.claude-autoroute` is created `0700` and its files `0600`. |
| A malicious website in your browser talking to the dashboard | The dashboard opens only through a one-time, 2-minute link from `autoroute ui`. The session is an HttpOnly, SameSite=Strict cookie. The Host header must be this machine (blocks DNS rebinding). API calls need a custom header and, when they change anything, a matching Origin header (blocks CSRF). No CORS headers are sent. A strict Content-Security-Policy with no inline scripts, plus `frame-ancestors 'none'`, blocks injection and clickjacking. Covered by tests. |
| API keys entered in the dashboard | Stored in the OS keychain: macOS Keychain, or the Secret Service on Linux. The key is passed to `security` / `secret-tool` on stdin, never as a command-line argument other users could see. The dashboard can't read a key back. There is no plaintext fallback. |
| Secrets in config files | Credentials come from `env` (an environment variable) or `command` (e.g. `gcloud auth print-access-token`). A literal `value` is supported for local gateways, and `autoroute doctor` warns if it holds something that looks like a secret. |
| Supply-chain attacks | Zero runtime dependencies. The npm package contains only the files listed in `package.json` `files`, which `npm run check:pack` verifies. |
| Accidentally publishing secrets or personal data | `npm run check:secrets` scans everything git would commit for API keys, tokens, private keys, email addresses, home-directory paths and runtime files. It runs in CI, before `npm publish`, and as an optional pre-commit hook (`git config core.hooksPath .githooks`). |

## What the router can't protect against

- **Anything running as your user** can read `~/.claude-autoroute/local-key`, your environment variables and your shell history. It has the same access you do.
- **Your providers' own data handling.** Read each provider's data-use terms. Some free tiers use your prompts for training.
- **Commands in `auth.command`** run with your permissions. Only put commands you trust in your config. The dashboard can't add or change one; only the config file can.
- **Plain HTTP on loopback.** Claude Code talks to the router over `http://127.0.0.1`, so the router sees prompts, code and Claude Code's credential, including an OAuth token on Team and Enterprise.
- **The background router outlives the session.** It keeps running until `autoroute stop` or a reboot, answering only requests that carry the local key.
- **Where credentials go.** The primary provider gets Claude Code's credential at whatever address `ANTHROPIC_BASE_URL`, `AUTOROUTE_UPSTREAM` or its `baseUrl` names. There is no allow-list, so anyone who can change your environment or config can redirect it.

For a one-page data-flow summary and an approval checklist, see [ADMIN.md](ADMIN.md).

## Supported versions

Security fixes go into the latest release.
