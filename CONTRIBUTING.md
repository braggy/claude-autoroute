# Contributing

Thanks for helping. A few ground rules keep this project easy to trust.

## Principles

1. **No runtime dependencies.** Everything uses the Node.js standard library, so users only have to audit this repo. Development tooling may use dev dependencies, but think twice.
2. **Privacy first.** Never write prompt text, code or credentials to disk or logs by default. Never send data anywhere except the provider a request is meant for.
3. **Every behavior change has a test.** Integration tests run the real router against mock providers (`test/helpers.mjs`).
4. **macOS and Linux.** No shell-specific commands in runtime code; use Node APIs. Where the OS differs (keychain, opening a browser), hide it behind one interface.
5. **Numbers must be measurable.** Any statistic shown to users comes from recorded data, and estimates are labeled as estimates.
6. **Respect providers' terms.** Never add features that carry Claude Free, Pro or Max credentials, or that bypass an organization's model restrictions.
7. **Dashboard values go in as text.** Use the `h()` helper, never `innerHTML`, and don't weaken the Content-Security-Policy.

## Development

```bash
npm test                 # unit, integration and CLI tests (about 5 seconds)
npm run test:coverage    # the same, failing below 90% lines / 75% branches / 85% functions (Node 22+)
npm run test:mutation    # puts known bugs back into security, policy and cost code; the tests must catch every one
npm run check:secrets    # nothing secret or personal in the repo
npm run check:pack       # the npm package only contains allowlisted files
npm run build:llms       # regenerate llms.txt / llms-full.txt after editing README, HELP, SECURITY or the example config
git config core.hooksPath .githooks   # before every commit: secret check + regenerate llms.txt files
```

To try changes against your own Claude Code without installing:

```bash
AUTOROUTE_HOME=/tmp/autoroute-dev node bin/claude-auto.mjs
```

## Tests

- **Integration tests start the real router** against mock providers (`test/helpers.mjs`). CLI tests run `bin/autoroute.mjs` as a process in a sandbox: their own `HOME`, autoroute folder, Claude settings folder and port. No test touches your real settings, keychain or the network.
- **No fixed sleeps.** Wait for a condition with `until()` from `test/helpers.mjs`, so slow CI machines don't cause flaky failures.
- **Security, policy and money code is mutation-checked.** If you change code listed in `scripts/mutation.mjs`, run `npm run test:mutation`. A "SURVIVED" line means a bug there would go unnoticed, so add a test. A "STALE" line means the code moved, so update the mutation.
- **Fix a bug with a test first.** It should fail before the fix and pass after. `test/hardening.test.mjs` has examples.

## Layout

| Path | What's there |
|---|---|
| `src/config.mjs` | Defaults, JSONC parsing, merging, validation |
| `src/classify.mjs` | Step 1: what a message needs |
| `src/cost.mjs` | Step 2: prices and the switch-or-stay decision |
| `src/providers.mjs` | Building requests for each provider; auth; model mapping |
| `src/upstream.mjs` | HTTP sending with timeouts; circuit breaker |
| `src/server.mjs` | The proxy: routing, failover, retries, accounting |
| `src/stats.mjs` | Spend tracking, lifetime value statistics, savings report |
| `src/ui-server.mjs` | Dashboard: login links, security checks, JSON API |
| `src/ui/` | Dashboard front end (plain JS/CSS, no build step); `help.js` renders HELP.md |
| `src/diagnostics.mjs` | Redacted support snapshot |
| `HELP.md` | User help. The single source for both GitHub and the dashboard; a test checks that every in-app "Learn more" link points at a real answer. |
| `src/secrets.mjs` | OS keychain (macOS Keychain / Linux Secret Service) |
| `src/launcher.mjs` | Dashboard app icon: macOS `.app` (with `.icns` writer), Linux `.desktop` |
| `assets/` | App icon (SVG source + rendered PNGs) |
| `src/quick.mjs` | Quick settings and priority presets (shared by dashboard and CLI), config saving |
| `src/policy.mjs` | Login-type checks and the organization's `availableModels` |
| `src/setup.mjs` | Setup checks and Claude Code status line, shared by CLI and dashboard |
| `src/util.mjs` | Local key, background process (start, safe stop), health checks |
| `src/limits.mjs` | What routing may use right now (allowed tiers, local model), shared by proxy and dashboard |
| `bin/` | `claude-auto`, `autoroute`, status line |
| `scripts/` | Secret scanner, package check, llms builder, mutation check |
| `examples/` | Provider configs (validated by the tests) |

## Adding or changing a feature

The docs are part of the feature. Tests enforce most of this, so the build fails if something is missed.

1. **Settings:** add each new setting to `DEFAULTS` in `src/config.mjs`, and explain it in `config.example.jsonc`. A test checks every setting is there.
2. **Commands:** add each new command to the usage text in `bin/autoroute.mjs` and to the README's command table. A test checks this.
3. **Help:** add or update answers in `HELP.md`, and troubleshooting for anything that can go wrong. If the dashboard links to a new answer ("Learn more"), a test checks the answer exists.
4. **Docs for AI assistants:** `llms.txt` and `llms-full.txt` are generated from the docs, never edited by hand.
   - **On your machine:** the pre-commit hook regenerates them, or run `npm run build:llms`.
   - **On GitHub:** the "Keep docs for AI assistants up to date" workflow regenerates and commits them whenever docs change on `main`, including edits made in GitHub's web editor.
   - **Pull requests:** CI fails if the files are out of date. If what the project does or supports has changed, update the summary in `scripts/build-llms.mjs`. A new top-level `.md` file must be added to its lists, which a test checks.
5. **Changelog:** add a line to `CHANGELOG.md`.

## Repository setup (maintainers)

Once, after creating the GitHub repository:

1. **Turn on private vulnerability reporting:** Settings → Security → Private vulnerability reporting.
2. **Let the docs workflow commit:** the "Keep docs for AI assistants up to date" workflow pushes regenerated `llms.txt` / `llms-full.txt` to `main`. If you protect `main` with required pull requests, either allow GitHub Actions to bypass that rule, or rely on the `--check` step, which fails pull requests with out-of-date files.
3. **Turn on the hook on your machine:** `git config core.hooksPath .githooks`.
4. **Protect `main` and release tags:** a ruleset requires pull requests with passing CI and code-owner review (`.github/CODEOWNERS`), and blocks force-pushes and deletion; only the maintainer may bypass it. (A personal-account repo can't let GitHub Actions bypass a ruleset, so the docs workflow's push only succeeds when the maintainer's commit left the files stale; the pre-commit hook and the required CI check keep that from happening.) Another ruleset lets only the maintainer create `v*` tags.
5. **Releases:** update `version` in `package.json`, turn the top `CHANGELOG.md` section from "unreleased" into that version, commit, then `git tag vX.Y.Z && git push --tags`. The Release workflow re-runs every check, builds the package once, attests where it was built, and attaches it with a SHA-256 checksum to a GitHub Release. Publishing to npm is a manual step using that same file.
6. **Dependabot** proposes monthly updates to the pinned GitHub Actions. All actions are pinned to commit SHAs, and a test fails if one isn't.

GitHub Actions is free for public repositories on standard runners. While the repository is private, the free plan's 2,000 monthly minutes apply, and macOS minutes count 10x, which is why CI runs macOS on one Node version only.

## Contribution terms

claude-autoroute is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE), and its maintainer may also offer it under separate commercial licences. So that both stay possible, by opening a pull request you confirm that:

- you wrote the contribution, or otherwise have the right to submit it;
- you license it to Steve Bragg under the [MIT License](https://opensource.org/license/mit), so it can be distributed under this project's licence and under any other licence the maintainer chooses.

Only the maintainer reviews and merges pull requests.

## Pull requests

- Keep them focused, and describe the user-visible change.
- Update `README.md`, `config.example.jsonc` and `CHANGELOG.md` when behavior or settings change.
- Don't include real keys, emails, paths or logs in code, tests or issues. Tests build fake secrets at runtime; see `test/secrets.test.mjs`.
