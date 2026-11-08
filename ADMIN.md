# For admins: approving claude-autoroute

This page is for the person who decides whether staff may run claude-autoroute with your organisation's Claude Code accounts. It covers where data goes, the risks the tool can't remove, and a checklist for a cautious approval. The full threat model is in [SECURITY.md](SECURITY.md).

## What it is, and what it isn't

claude-autoroute is a small Node.js process that runs on one person's computer, between the Claude Code CLI and Anthropic. For each message it picks Haiku, Sonnet or Opus, to spend less. It can also fail over to a backup provider when the primary is down.

It is **not a multi-vendor router**. It routes between Claude models. Non-Claude models appear only as an optional last-resort backup through a gateway such as LiteLLM, or as an optional local model for easy tasks. Both are off by default.

It has no runtime dependencies, no install scripts, and no telemetry. It is **alpha** software maintained by one person.

## Where data goes

```
Claude Code ──(plain HTTP, 127.0.0.1 only)──► claude-autoroute ──(HTTPS)──► primary provider
                                                     │                      (Anthropic, or your gateway)
                                                     ├──(HTTPS)──► backup providers   (off by default)
                                                     └──(HTTP)───► local model server (off by default)
```

| Path | What travels | Credential used |
|---|---|---|
| Claude Code → router | The full request: prompts, code, tool results | Claude Code's own: API key, gateway token, or OAuth token. Plus a random local key that proves the caller is `claude-auto`. |
| Router → primary provider | The same request, with the `model` field changed | Claude Code's own credential, passed through |
| Router → backup provider (if you configure one) | The same request | The backup's own credential. Claude Code's credential is removed first. |
| Router → local model (if enabled) | Easy messages only | None, or the local server's own |

Nothing else leaves the machine. The router makes no other network requests.

**On disk** (`~/.claude-autoroute`, folder `0700`, files `0600`): the config, the local key, a decision log (chosen model and reason, no prompt text), and statistics (token counts, timings, a hash of each conversation's first message). Prompt text is never written to disk unless the user turns on `logPromptSnippets`, which logs the first 60 characters of each prompt.

## Risks you accept by approving it

The tool can't remove these. Each one is stated here so you can weigh it.

1. **The router sees everything.** On the loopback interface it receives prompts, code and the user's credential (including an OAuth token on Team and Enterprise) over plain HTTP. Only processes on the same machine can reach it. Any program running as that user can already read the same credential from Claude Code's own files.
2. **It keeps running in the background.** `claude-auto` starts the router if it isn't running, and the router keeps running after the Claude Code session ends, until `autoroute stop` or a reboot. While it runs, it accepts only requests that carry the local key.
3. **Credentials follow the configured address.** The primary provider receives Claude Code's credential at whatever address `ANTHROPIC_BASE_URL`, `AUTOROUTE_UPSTREAM` or the primary's `baseUrl` names. There is no allow-list. Anyone who can change the user's environment or config file can send that credential elsewhere. Claude Code behaves the same way with `ANTHROPIC_BASE_URL`.
4. **`auth.command` runs a shell command.** A backup provider can get its token from a command, such as `gcloud auth print-access-token`. The command runs with the user's permissions. Only the config file can set or change one; the dashboard refuses.
5. **The Team and Enterprise opt-in is the user's word.** Subscription logins look the same for every plan, so the router can't tell whether your organisation approved it. A Team or Enterprise login stays refused until the user runs `autoroute setup --login enterprise --admin-approved`. Nothing checks that you approved it.
6. **It is alpha.** Read the change log before each upgrade.

## Approval checklist

- [ ] **Pin a version.** Install from a reviewed commit, not a moving branch: `git clone https://github.com/braggy/claude-autoroute && cd claude-autoroute && git checkout <commit> && ./install.sh`. From `v0.1.0`, release tags are signed: check one with `git tag -v <tag>` before you install. Review the diff before each upgrade.
- [ ] **Start in shadow mode.** Setup turns it on by default. The router decides but changes nothing, and records what routing would have saved. After a week, `autoroute stats` shows whether it pays for itself.
- [ ] **Keep failover off.** By default `failover.order` is `["anthropic"]`, which means no backups. Add a backup only if that provider is separately approved for your code.
- [ ] **Keep the local model off** (`local.enabled: false`, the default) unless the local model is approved.
- [ ] **Keep `logPromptSnippets` off** (the default).
- [ ] **Keep `host` at `127.0.0.1`** (the default).
- [ ] **Set allowed models centrally.** The router honours `availableModels` from Claude Code's managed settings and never routes outside that list.
- [ ] **Record the Team or Enterprise approval**, then tell the user to run `autoroute setup --login enterprise --admin-approved`.
- [ ] **Check the result** on the user's machine: `autoroute doctor` and `autoroute selftest`.
- [ ] **Licence.** Internal use at any organisation, including a company, is allowed: see [ADDITIONAL-PERMISSION.md](ADDITIONAL-PERMISSION.md).

## Removing it

`autoroute stop`, `autoroute statusline remove`, `npm uninstall -g claude-autoroute`, then delete `~/.claude-autoroute`. Plain `claude` never goes through the router.
