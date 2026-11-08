# Help

Answers to common questions, fixes for common problems, and the words this project uses. This page is also built into the dashboard (`autoroute ui` → **Help**).

## Getting started

### What does claude-autoroute do?

It sits between Claude Code and the model provider, on your own computer. For each message you send, it picks the cheapest model that can handle it (Haiku, Sonnet or Opus). It only switches when switching actually saves money. If your provider has an outage, it can send requests to a backup you set up.

### How do I start?

About five minutes, and nothing changes until you decide.

1. **Check how Claude Code signs you in.** Run `claude`, type `/status`, and look at the login line. If it's a personal **Pro or Max** plan, stop here: autoroute can't be used with those.
2. **Install.** In the downloaded folder, run `./install.sh`. You don't need admin rights.
3. **Answer the setup questions.** The installer starts `autoroute setup`. Press Enter to accept the recommended answers. It turns on **shadow mode** (nothing changes yet), adds the status line, and runs a self-test.
4. **Use Claude Code as normal, but start it with `claude-auto`.** All the usual arguments work.
5. **After a day,** run `autoroute stats` to see what routing would have saved. If you like it, run `autoroute shadow off`.

On a work laptop with Claude Team or Enterprise, read "Set up on a work laptop (Claude Team or Enterprise)" first. On Claude Pro or Max, read "I have Claude Pro or Max".

### I have Claude Pro or Max

autoroute works in **subscription mode**. Anthropic doesn't allow third-party tools to route Free, Pro or Max logins, so autoroute doesn't: `claude-auto` starts Claude Code just like `claude`, and Claude Code signs in and talks to Anthropic directly. autoroute never sees your login or messages.

What you get:

- **The right starting model.** Start with your first message: `claude-auto "fix the typo in README"` starts on Haiku, and `claude-auto "work out why the tests deadlock"` starts on Opus. Add `!opus`, `!sonnet` or `!haiku` to choose yourself. With no message, Claude Code uses its own default, or `subscription.startModel` if you set it (`opusplan` is a good choice: Opus while planning, Sonnet while doing).
- **Model tips.** Run `autoroute hints install`. When a message looks harder or easier than the current model, Claude Code shows a tip such as "/model haiku would use less of your plan's limits". You decide whether to switch. There are no "smaller model" tips in long chats, because switching re-reads the whole chat on the new model. Only want tips for stronger models? Set `subscription.hints` to `"upgrades"`.
- **Usage by model.** Run `autoroute usage` (or `autoroute usage 30` for 30 days). It reads Claude Code's own transcripts on your computer and shows how your usage splits between Haiku, Sonnet and Opus, the last 5 hours (the window plan limits reset on), and roughly how much less you'd use by starting messages on the model they need.

What you don't get: per-message switching and failover. Those need the router, which needs a Claude API key, Bedrock or Vertex.

To set it up, run `autoroute setup` and choose **Personal Claude Pro or Max**. You don't have to, though: `claude-auto` uses subscription mode automatically when it can tell you're signed in with a subscription. `autoroute mode` shows which mode it will use; `autoroute mode subscription` forces it.

### How does claude-auto know I'm on a subscription?

It looks for API-style credentials first (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, Bedrock or Vertex settings, a gateway in `ANTHROPIC_BASE_URL`, an `apiKeyHelper`). If there are none, it checks what the router saw last time, then the account summary Claude Code keeps in `~/.claude.json`. It never reads a token. If it can't tell, it uses the router, which refuses a subscription login and remembers it, so the next `claude-auto` starts in subscription mode. Set `"mode"` to skip the guessing.

### Set up on a work laptop (Claude Team or Enterprise)

If Claude Code signs you in with your company's Claude account, follow these steps.

1. **Get your admin's OK first.** Team and Enterprise logins may only go through a tool like this if your organization allows it. Until you confirm that, autoroute refuses the login and sends nothing. "What do I ask my admin?" has a message you can send.
2. **Check Node.js.** Run `node -v`. You need version 20 or later. If your company uses a web proxy (`HTTPS_PROXY` is set), you need 22.21 or later.
3. **Install:** in the downloaded folder, run `./install.sh`. If it asks you to add a folder to your PATH, run the line it shows, then open a new terminal.
4. **Set up:** when asked "How does Claude Code sign you in?", choose **Company login: Claude Team or Enterprise**. When asked if your admin approved it, answer **y** only if they have. autoroute can't check this, so it relies on your answer. Accept the other defaults.
5. **Self-test:** it sends one tiny message through Claude Code, at well under a cent. It should end with "All good". If it doesn't, see "The self-test failed".
6. **Day 1, shadow mode:** start Claude Code with `claude-auto` and work as usual. Nothing changes: the status line shows 👁 and what routing would have picked.
7. **Day 2, turn it on** if the numbers look good: `autoroute shadow off`. Then follow "Your first week: how do I know it's working?".

To undo at any time, run plain `claude` instead of `claude-auto`. Or run `autoroute pause`, which sends everything through unchanged.

### What do I ask my admin?

Something like this, which you can copy and edit. Send [ADMIN.md](ADMIN.md) with it: it explains where data goes and has an approval checklist.

> I'd like to use claude-autoroute, a source-available tool that runs only on my laptop, with Claude Code. It picks a cheaper Claude model (Haiku or Sonnet) for simple messages, to make our Claude Code usage go further. It runs at 127.0.0.1 and sends requests only to Anthropic, using my normal Claude Code login. It doesn't store prompts or code, and it follows our organization's allowed-models settings. Is it OK to use it with my Enterprise login?

If they say no, you can still use autoroute with a Claude API key from the Claude Console, if your company provides one.

### What is shadow mode?

It's a no-risk trial. autoroute decides which model it would use for each message, but sends every message with the model Claude Code asked for. It records what that would have cost, and you see the result in `autoroute stats` and on the dashboard.

The estimate is cautious: whenever routing would have switched models, it counts the cost of rebuilding the prompt cache, so it doesn't flatter itself. Your `!opus` / `!sonnet` / `!haiku` still work as usual.

- **Turn it on:** `autoroute shadow on`, or **Routing → Shadow** on the dashboard.
- **Turn routing on:** `autoroute shadow off`, or **Routing → On**.

About 30 messages give a reliable picture.

### How do I run the self-test?

Run `autoroute selftest`. It sends one tiny message ("reply with AUTOROUTE-OK") through your real Claude Code and the router, using your normal login. Then it checks:

- that the router is running and saw the message
- which login Claude Code uses
- that a reply came back
- whether the status line is installed

It costs well under a cent. Run it whenever something seems off, for example after updating Claude Code or changing networks.

### Your first week: how do I know it's working?

Run `autoroute stats`. Once there are 30 routed messages, the **Trial check** at the bottom compares your numbers with four simple targets:

| Target | Why it matters |
|---|---|
| **Saves 20% or more** | It's worth having |
| **Regret rate under 5%** | Cheaper models are good enough for what you send them |
| **Router overhead under 5 ms** | You won't notice it |
| **No router errors** | It never gets in your way |

What to do with the result:

- **"On track":** keep it on. Check once a week.
- **Regret rate too high:** choose `autoroute priority best-quality`, which never uses Haiku, or add words you use for hard tasks to `classifier.opusKeywords`.
- **Savings below target:** you may mostly do hard work that needs Opus anyway. Keep it as an outage backup, or uninstall it. Both are fine outcomes.
- **Router errors:** run `autoroute log` and `autoroute diagnostics`, and report the problem. Meanwhile, `autoroute pause` makes it pass everything through unchanged.

### Is it for me?

It's built for the **Claude Code CLI** on **macOS or Linux**, signed in with a **Claude API key**, **Amazon Bedrock**, **Google Vertex AI**, or a **company LLM gateway**.

With Claude **Free, Pro or Max** subscription logins it works in subscription mode only: Anthropic doesn't allow third-party tools to route those, so autoroute picks the starting model and gives tips instead (see "I have Claude Pro or Max"). **Team or Enterprise** logins need your admin's approval. It doesn't work with the Claude desktop app, claude.ai on the web, or the mobile apps. The README's "What's supported" section has the full list.

## Using it

### Why did it pick this model?

The **Recent messages** list on the Overview page shows the model each message got, and why. To test a prompt without sending it, use **Try a prompt** on the Routing page, or run `autoroute explain "your prompt"`.

Two steps decide the model:

1. **What does the message need?** Easy tasks (git commands, renames, typos) want Haiku. Everyday coding wants Sonnet. Hard tasks (architecture, refactors, tricky bugs) want Opus.
2. **Is switching worth it?** See "Why didn't it switch to a cheaper model?" below.

### How do I force a particular model?

Put `!opus`, `!sonnet` or `!haiku` anywhere in your message. The tag is removed before Claude sees it. Your organization's model rules still apply.

### Why didn't it switch to a cheaper model?

Each model keeps its own **prompt cache**: a saved copy of the conversation that makes re-reading it cheap. When you switch models, the new model has to read the whole conversation at full price. In a long, active chat that can cost more than the cheaper model saves.

So a single easy message in a long Opus chat stays on Opus. A run of easy messages does switch, because the one-time cost is spread across them. The reason is shown in the Recent messages list, for example "staying on opus: switching costs ~$0.11 more". You can tune this on the Routing page.

### How do I choose what gets used when?

Use **Quick settings** on the dashboard's Overview. Every change is saved instantly.

- **Routing: On / Shadow / Paused.**
  - **Shadow** changes nothing, but shows what routing would save. See "What is shadow mode?". From a terminal: `autoroute shadow on` or `autoroute shadow off`.
  - **Paused** sends Claude Code's requests through unchanged. Failover to a backup still works. From a terminal: `autoroute pause` and `autoroute resume`.
- **Free local model: On / Off.** From a terminal: `autoroute local on` or `autoroute local off`.
- **Priority:** picks a sensible set of settings in one click. The description under the buttons says exactly what each one does. From a terminal: `autoroute priority <name>`.
  - **Lowest cost:** uses the local model for easy tasks even when it's slower, and switches to cheaper models more readily.
  - **Balanced** (the default): switches only when it saves money, and uses the local model only while it's no more than twice as slow as Claude.
  - **Fastest:** keeps everything on Claude, with no local model, and always uses the model each message needs.
  - **Best quality:** never uses Haiku or the local model, and moves up to Opus whenever a message needs it. It costs more.
- **Providers, in order of use:** switch an account off to skip it, or back on. From a terminal: `autoroute provider <name> off`. To change the order, use the arrows on the Providers page.

You can fine-tune any of these afterwards on the Routing and Providers pages.

### Will the local model slow my chats down?

It can, so claude-autoroute measures it. It times the local model and Claude on the same kind of easy task, using your own messages. If the local model is more than **2x slower** than Claude on average (you can change this on the Providers page), easy tasks go back to Claude. Every tenth easy task still tries the local model, so it notices when it speeds up again.

The Overview shows both average times once there are at least 5 tasks on each. Set the limit to **no limit** to always use the local model, or choose the **Fastest** priority to keep everything on Claude.

### Can other tools show autoroute's stats?

Yes. Besides the Claude Code status line, there's a read-only status address for scripts, terminal status bars and menu-bar widgets: `http://127.0.0.1:8787/__autoroute/status`. It reports:

- today's spending and the lifetime savings
- provider health
- local model speed
- the last decision

It needs the header `x-autoroute-key` with the value from `~/.claude-autoroute/local-key`, so only programs that can read that file get in. It never includes prompt text. From a terminal: `autoroute status --json`.

### Why does Claude Code still show the model I started with?

Claude Code doesn't know the router changed the model. The **status line** shows the router's actual pick. Install it from the setup checklist, or run `autoroute statusline install`.

### What does the status line show?

The status line is the line at the bottom of Claude Code. With claude-autoroute's status line installed, it looks like this:

```
myproject  🟢 auto:haiku · saves ~$0.07 · today $1.03 (saved $0.44)
```

From left to right:

- **The project folder name.**
- **The model your last message actually ran on:** 🟢 Haiku, 🔵 Sonnet or 🟣 Opus.
- **🏠 local** when it ran on your free local model, or **🟠 failover** and the provider's name when a backup handled it.
- **The reason**, shortened, for example "saves ~$0.07" or "staying on opus: switching costs …".
- **Today's spending**, and how much less that is than without autoroute.

Two other states you may see:

- **👁 shadow · would use haiku · would save $0.40 today** means shadow mode is on. Claude Code keeps its own model, and this shows what routing would have picked. Turn routing on with `autoroute shadow off`.
- **⏸ auto-route paused** means routing is paused. Undo with `autoroute resume` or the Quick settings.
- **🟣 opus · subscription mode · 💡 /model haiku** means `claude-auto` is in subscription mode. It shows Claude Code's own model and, if there is one, the latest model tip for this chat.
- **auto-route off** means this Claude Code session didn't start through `claude-auto`, so the router isn't involved.

It updates after each message and reads a small file the router keeps up to date, so it never slows Claude Code down.

### How do I add or remove the status line?

- **Add:** run `autoroute statusline install`, or click **Install status line** in the dashboard's setup checklist. Then start a new Claude Code session with `claude-auto`.
- **Remove:** run `autoroute statusline remove`. This only removes claude-autoroute's status line, never one of your own.

It's stored in Claude Code's settings file (`~/.claude/settings.json`) as the `statusLine` setting.

### I already have my own status line. Can I keep it?

Yes. claude-autoroute won't replace a status line you already have. To show both, call claude-autoroute's script from your own. Claude Code sends status information to your script on standard input, so pass the same input along:

```
input=$(cat)
echo "$input" | node "/path/to/claude-autoroute/bin/statusline.mjs"
```

`autoroute statusline install` prints the exact command for your installation when it finds an existing status line.

### Does it slow Claude Code down?

Barely. The router measures its own overhead, shown on the Overview page; it's typically a few milliseconds per request. Cheaper models also tend to answer faster.

### What happens if Anthropic has an outage?

If you've added a backup provider (Bedrock, Vertex or a gateway), requests move to it automatically. The failed provider is skipped for a cooldown period (5 minutes by default), so your chat doesn't bounce back and forth. Without a backup, you see the provider's error as usual.

A reply that's already being written when the outage hits can't move over. Claude Code's retry goes to the backup.

### Can I use it in VS Code, JetBrains or the Claude desktop app?

Not yet. Those apps start Claude Code their own way, so requests don't go through `claude-auto`. Only the Claude Code CLI in a terminal is supported.

## Free local models

### Can I use a free local model?

Yes, for easy tasks. It's optional and off by default. Easy messages (git commands, renames, typos) can run on a model on your own computer through Ollama, LM Studio or llama.cpp, while Claude handles everything else.

What you get: those tasks cost nothing, and your code stays on your machine. What to know: a local model isn't Claude, and Anthropic doesn't support Claude Code on other models, so answers can differ. You also need a fairly powerful computer. If the local model returns an error, the request goes to Claude automatically.

### How do I set up a free local model?

These steps work the same way on macOS and Linux.

1. **Check your computer.** You need at least 16 GB of memory: unified memory on Apple Silicon Macs, or graphics-card memory on other machines. With less, easy tasks are better left on Haiku, which costs a fraction of a cent each.
2. **Install Ollama 0.14.3 or later** from https://ollama.com/download. On a Mac, install the app. On Linux, use the install command shown on that page; it's a good habit to read a script before running it. Check the version with `ollama --version`. Older versions don't handle Claude Code's tool calls properly.
3. **Download a model.** See "Which local model should I use?" below. For example: `ollama pull gpt-oss:20b`
4. **Give it room for Claude Code's instructions.** Claude Code sends a long set of instructions with every request, much more than Ollama's default of 4,096 tokens on most computers. Make a copy of the model with a larger context length:

```
printf 'FROM gpt-oss:20b\nPARAMETER num_ctx 32768\n' > Modelfile
ollama create gpt-oss-32k -f Modelfile
```

5. **Connect it.** Run `autoroute ui`, open **Providers**, and turn on **Free local model for easy tasks**. Enter the model name from step 4 (`gpt-oss-32k`), click **Save changes**, then **Test local model**.
6. **Use Claude Code as usual** with `claude-auto`. Easy messages show **Local model** in the Overview's Recent messages, and the status line shows 🏠 local.

### Which local model should I use?

These are starting points as of November 2026. Local models improve quickly, so check Ollama's model library for newer ones. Claude Code needs **tool calling** (the "tools" label in Ollama's library), so skip models without it.

- **16 GB of memory:** `gpt-oss:20b`
- **24 to 32 GB:** `qwen3-coder:30b` or `devstral-small-2:24b`. Newer models in this size, such as Qwen3.8 27B, are also worth trying.
- **64 GB or more:** larger models can handle everyday tasks too. Turn on **Everyday tasks too** only after you've tried it for a while.
- **Less than 16 GB:** keep easy tasks on Haiku.

A larger context length uses more memory. 32,768 tokens is a good balance for easy tasks. Keep **Largest chat to send to it** at or below the context length you chose.

### My local model gives empty, strange or cut-off answers

This is almost always the context length.

1. Make sure you created the larger-context copy (step 4 of the setup) and entered **its** name, not the original model's.
2. Make sure **Largest chat to send to it** on the Providers page isn't bigger than that context length.
3. Make sure the model supports tool calling and that Ollama is 0.14.3 or later.

The router can tell when the local model returns an error, and switches to Claude. It can't tell when the model gives a poor answer. If the quality isn't good enough for you, turn the local model off or try a stronger one.

### Does a local model keep my code private?

Yes, as long as the model runs on your computer: nothing leaves your machine. Be careful with Ollama's **cloud** models (names ending in `:cloud`). They run on Ollama's servers, so your code is sent there.

### Can I use LM Studio or llama.cpp instead of Ollama?

Yes, if the version you use accepts Anthropic-style requests (`/v1/messages`). LM Studio does from version 0.4.1, and its address is usually `http://127.0.0.1:1234`. Set the server address and model name on the Providers page to match.

### How much does a local model save?

Usually not much money: easy tasks on Haiku already cost a fraction of a cent each. The main benefits are privacy, working offline, and lower usage. The Overview shows how many messages ran free on your local model, and the savings figures include them.

## Money and statistics

### How are the savings calculated? Are they real?

**"Paid"** is real. It comes from the token counts your provider reports on every response, multiplied by the prices on the Prices page.

**"Without autoroute"** is an estimate. It prices the same tokens at the model Claude Code asked for. It assumes that model would have used the same number of tokens, which is close but not exact.

The extra cost of every switch (cache rebuilds) is already subtracted. Upgrades to a stronger model, which cost more, are counted too.

### What is the regret rate?

It's how often a cheaper model wasn't good enough. Each time you type `!opus` or `!sonnet` straight after the router picked a cheaper model than Claude Code asked for, that's one regret. The rate is regrets divided by all the cheaper picks.

- **Under 5%:** the router is choosing well.
- **Above 10%:** the dashboard shows it in amber. Pick the **Best quality** priority, or add words you often use for hard tasks to `classifier.opusKeywords`.

Savings only count if the answers stay good, so check this alongside "saved".

### Why does "time saved" say "collecting"?

Time saved compares your actual response times with the requested model's **measured** average. It needs at least 5 responses from that model before it shows a number, so the estimate is based on your own data, not guesses.

### My costs look wrong. What should I check?

Check the **Prices** page. Prices change, and the built-in ones are list prices from this release. If your organization has negotiated rates, enter them there. Backups that cost more, such as regional pricing, can use a **price multiplier** on the Providers page.

### I'm on a subscription plan. What do the dollar figures mean?

They're calculated at API list prices, as if you paid per token. They're still a fair way to compare how much routing reduces usage. On Pro or Max, `autoroute usage` uses the same prices to weigh each model's share of your usage, since Anthropic doesn't publish how plan limits weigh each model.

### I'm on Claude Enterprise with credit or spend limits. Does this help?

Usually, yes. On Team and Enterprise plans, Claude Code usage comes out of each member's allowance, or out of your organization's usage credits. When you reach a spend limit, Claude Code stops until the limit resets or an admin raises it.

Bigger models generally use your allowance faster than smaller ones. Running easy messages on Haiku or Sonnet, instead of Opus, should make the same allowance last longer.

Two things to know:

- **The dollar figures are estimates at API list prices,** not your company's rates or credit units. Use them to compare with and without routing. Your admin's usage page is the source of truth for what was actually used.
- **Start in shadow mode** to see the likely effect before changing anything.

## Privacy and security

### Is my code or prompt stored or sent anywhere?

Your prompts go only to the model provider, exactly as they would without claude-autoroute. The router never writes prompt text to disk. The log records which model was chosen and why, and the statistics record token counts and timings. Nothing is sent to the authors of this project; there's no telemetry.

### Where are my API keys stored?

Keys you enter in the dashboard go into your operating system's secure storage: **macOS Keychain**, or the **Secret Service** keyring (GNOME Keyring or KWallet) on Linux. They're never written to a file, and the dashboard can't read them back. You can also use environment variables or a command that prints a token.

### Can other programs or websites use the router?

No. The router only answers on your own machine, and every request needs a secret key that `claude-auto` adds. The dashboard opens only through a one-time link from `autoroute ui`. It refuses requests from other websites.

### Will it use a model my company has blocked?

No. If your admin limits models (Claude Code's `availableModels` setting), the router only routes to allowed models, even when you use `!opus`. The setup checklist shows which restrictions are being honored.

## Troubleshooting

### "Router failed to start"

Something else may be using port 8787. Change `port` in the config (`autoroute config` shows where it is), then run `autoroute restart`. The startup error is in `~/.claude-autoroute/router.out`.

### The installer says it doesn't have permission

The installer handles this itself: if npm can't write to its global folder, it installs into `~/.local` instead, with no admin rights needed. If it still fails, copy the message it printed and run `./install.sh` again. As a last resort, install by hand: `npm install --global --prefix ~/.local .`

### "autoroute: command not found" after installing

The folder autoroute was installed into isn't on your PATH yet. The installer printed the line to fix it, usually:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

Use `~/.bashrc` if you use bash. Then open a new terminal window.

### The self-test failed

Read the line starting with `->`: it says what to do. The most common causes:

- **"autoroute refused it"**: Claude Code uses a Team or Enterprise login, and setup didn't record your admin's approval. Once your admin has approved it, run `autoroute setup --login enterprise --admin-approved`.
- **"`claude` isn't on your PATH"**: install Claude Code, or open a new terminal.
- **"no reply"** or an API error: run `claude -p hello` without autoroute. If that fails too, the problem is Claude Code, your login or your network, not autoroute.
- **"Company proxy … can't use it"**: your Node.js is too old to use your company's web proxy. Install Node.js 22.21 or later.
- **"didn't go through the router"**: something forces Claude Code to another address. Check `ANTHROPIC_BASE_URL` in your shell profile and in `~/.claude/settings.json`.

### My company uses a web proxy or inspects HTTPS traffic

autoroute uses the same settings as Claude Code, as long as they're set in your shell (for example in `~/.zshrc`), not only inside Claude Code's own settings:

- **A web proxy (`HTTPS_PROXY`)** is used automatically. This needs Node.js 22.21+ or 24.5+, and `autoroute doctor` tells you if yours is too old.
- **A company certificate (`NODE_EXTRA_CA_CERTS`)** is passed on to the router.

After changing these, run `autoroute restart`.

### Claude Code says the router can't carry a subscription login

Claude Code is signed in with a Claude subscription, and Anthropic doesn't allow third-party tools to route Free, Pro or Max credentials. Your options:

- Run `claude-auto` again. With the default `"mode": "auto"`, it now knows you're on a subscription and starts in subscription mode (see "I have Claude Pro or Max"). Or run `autoroute mode subscription`.
- Sign in with a Claude API key instead: run `/logout` in Claude Code, then set `ANTHROPIC_API_KEY`.
- Use Bedrock or Vertex.
- Run plain `claude` without claude-autoroute.

On a **Team or Enterprise** plan whose admin has approved routing tools, run `autoroute setup --login enterprise --admin-approved`. That sets `"subscriptionLogin": "allow-team-enterprise"` for you.

### "Missing or wrong local key"

Claude Code reached the router without the secret key, usually because it was started with plain `claude` while `ANTHROPIC_BASE_URL` still pointed at the router. Start it with `claude-auto`, or remove the router address from `ANTHROPIC_BASE_URL`.

### The dashboard link says it has expired

Dashboard links work once, for 2 minutes. Run `autoroute ui` again. Sessions also end when the router restarts.

### A backup provider shows as down

1. On the Providers page, click **Test** next to it. The result explains what's wrong.
2. Check its credential: a saved key, an environment variable, or a command such as `gcloud auth print-access-token`.
3. If you use environment variables, restart the router afterwards (`autoroute restart`) so it sees them.
4. Run `autoroute doctor` for a full check.

### Keys can't be saved on Linux

The dashboard uses the Secret Service keyring through `secret-tool`. Install it (Debian/Ubuntu: `sudo apt install libsecret-tools`; Fedora: `sudo dnf install libsecret`) and make sure your keyring is unlocked. Over SSH there's usually no keyring; use an environment variable instead.

### The status line doesn't show or says "auto-route off"

1. **Check it's installed:** run `autoroute doctor`. If it says the status line isn't installed, run `autoroute statusline install`.
2. **Start Claude Code with `claude-auto`,** not plain `claude`. A session started without it shows "auto-route off".
3. **Start a new session** after installing. Claude Code reads its settings when a session starts.
4. **If you have your own status line,** claude-autoroute left it in place. See "I already have my own status line. Can I keep it?"
5. **If it shows "auto-route on" but no model yet,** send a message first. The status line fills in after the router handles one.

### The app icon does nothing

The app remembers where Node.js and claude-autoroute were installed. If either moved (for example after a Node.js upgrade with nvm), run `autoroute app install` again.

### The model never changes in a long chat

That's usually the cost check working as intended (see "Why didn't it switch to a cheaper model?"). To switch more readily, lower **Chance you'll need the bigger model again** on the Routing page. To always follow the classifier, set **Is switching worth it?** to **Always switch**.

### How do I stop or uninstall it?

- Stop the router: `autoroute stop`
- Remove the app icon: `autoroute app remove`
- Remove the status line: `autoroute statusline remove`
- Uninstall: `npm uninstall -g claude-autoroute`, then delete `~/.claude-autoroute` if you want to remove your settings and statistics.

## Words used here

### Tier

The model size: **Haiku** (fastest, cheapest), **Sonnet** (everyday) or **Opus** (most capable).

### Prompt cache

A provider-side saved copy of the conversation so far. Reading from it costs a small fraction of the normal price. Each model has its own cache, and it expires after about 5 minutes without use.

### Cache rebuild

The one-time full-price read when a different model (or provider) has to read the conversation from scratch.

### Primary and backup providers

The **primary** is where requests normally go. **Backups** take over, in order, when the ones above them fail.

### Failover and cooldown

**Failover** is moving requests to a backup after a failure. The **cooldown** is how long the failed provider is skipped before it's tried again.

### Local model

An open-source model running on your own computer, through Ollama, LM Studio or llama.cpp. claude-autoroute can send easy tasks to it for free. It isn't Claude.

### Subscription mode

How `claude-auto` runs Claude Code for Claude Free, Pro and Max logins: straight to Anthropic, without the router. autoroute only picks the starting model, suggests `/model` switches and reports usage by model.

### Passthrough

The provider gets the credential Claude Code is using: your API key or gateway token. Only the primary provider can use passthrough.

## Getting more help

### Can I ask my own AI assistant for help with claude-autoroute?

Yes. All the documentation is available in one file made for AI assistants, `llms-full.txt`. Give it to any assistant (Claude, ChatGPT, a local model) and ask your question.

- **In the dashboard:** on the Help page, click **Copy help for an AI assistant**, then paste it into your assistant before your question.
- **In a terminal:** `autoroute llms` prints it. On macOS, `autoroute llms | pbcopy` copies it.
- **In the project:** `llms-full.txt` and the shorter index `llms.txt` are at the top of the repository.

For better answers, also paste the output of `autoroute doctor` and `autoroute diagnostics`. Both are safe to share. Never paste API keys, your config file or logs into an AI assistant.

### How do I report a problem?

Open an issue on the project's GitHub page. On the dashboard's Help page, use **Copy diagnostics** and paste the result into the issue. It contains versions, settings and health checks, with keys, prompts, URLs and your username removed. Please don't paste logs or config files that contain keys.

### How do I report a security issue?

Privately, please. Use **Report a vulnerability** on the project's GitHub Security tab, not a public issue. See SECURITY.md.
