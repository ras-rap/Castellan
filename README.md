# open-discord-agent

A Discord-native agent that answers in chat **and acts** — creates channels, reads the member list, manages
roles, writes code — on an opencode backend. Any model from any provider it is given a credential for: the
keyless OpenCode free tier by default, the OpenCode Go subscription, or OpenAI, Anthropic, Gemini, OpenRouter,
a local Ollama/vLLM endpoint, or anything else that speaks the OpenAI API.

Built on the [`discord-bot-template`](https://github.com/ras-rap/discord-bot-template/tree/rewrite) conventions:
discordx decorators discovered by `@discordx/importer`, reusable guards, pino logging, a command-registration
CLI, ESLint + Prettier, and Bun as the runtime.

Design and the measurements behind it: [`PLAN.md`](./PLAN.md).

**Status:** chat/streaming, the 26 Discord tools, tier policy + Jev shadow gate, approval cards, memory v1,
per-guild model selection and the learning loop with its A/B eval gate are implemented and exercised
(`bun test`, `bun run smoke`, `bun run e2e` against the live gateway). Cross-day recall verification remains;
`PLAN.md` §8 tracks it.

## Requirements

| Need | Why |
| --- | --- |
| Bun ≥ 1.1 | runtime (`bun:sqlite`, `Bun.spawn`, `Bun.serve`) |
| A Discord bot token | Dev Portal → your app → Bot → Reset Token |
| `GuildMembers` + `MessageContent` intents | member listing, and reading what a mention actually says |
| One model provider | default is the keyless OpenCode free tier; `bun run auth` adds the Go subscription; a plain API key works too |
| Docker daemon | default shell sandbox; `shell.mode: "host"` opts out per guild |

## Quick start

```bash
bun install
bun run setup          # validates the token, picks a provider, writes .env, publishes the commands
bun run auth           # for the OpenCode Go models (the default fast model): stores the credential Go accepts
bun run doctor         # preflight: binary, token, providers, role models, docker, clock skew
bun run start          # run the bot
```

Then in your server: `/enable` (owner only), and `/ask <prompt>` or mention the bot. `/help` describes itself.

`bun run setup` is a conversation, not a config file: it checks the token against Discord, warns when the
privileged intents are still off, fills in the application id and your owner id automatically, writes `.env`
(mode `0600`) without touching anything else already in it, and offers to publish the slash commands.

### Manual setup

If you would rather edit files:

```bash
cp .env.example .env    # DISCORD_TOKEN, DISCORD_CLIENT_ID, OWNER_ID, DISCORD_DEVELOPMENT_GUILD_ID
bun run commands deploy # guild scope in development, global in production
bun run doctor
bun run smoke           # offline end-to-end: server, prompt, stream, approval, question, jev
bun run start
```

## Models and providers

The bot asks for **roles**, never for a model name:

| Role | Env | Default | Used for |
| --- | --- | --- | --- |
| primary | `MODEL_PRIMARY` | `opencode/mimo-v2.6-flash-free` | chat, code, tool use |
| fast | `MODEL_FAST` | `opencode-go/beam-free` | reflection, memory extraction, consolidation |
| jev | `MODEL_JEV` | `jev-1.13-free` | typed safety decisions (called directly, so no `provider/` prefix) |

`/model current` shows what a server is running, `/model list` shows everything the guild's agent server can
actually run, and `/model set` switches one guild (admins). The guild's server restarts on the next prompt so
the new default is loaded; the session and its memory survive. The override lands in `config/guilds.json`:

```jsonc
{ "123456789012345678": { "enabled": true, "model": { "primary": "opencode-go/gpt-5.6-luna" } } }
```

### Catalogue providers

These are known to the pinned server; a credential in `.env` is all it takes. The variable names are the ones
the server itself reads, so a key stored under another name is ignored.

| Provider id | Credential | Example model |
| --- | --- | --- |
| `opencode-go` | `bun run auth` (or `OPENCODE_GO_API_KEY`) | `opencode-go/gpt-5.6-luna` |
| `opencode` | keyless free tier | `opencode/mimo-v2.6-flash-free` |
| `openai` | `OPENAI_API_KEY` | `openai/gpt-5.3-codex` |
| `anthropic` | `ANTHROPIC_API_KEY` | `anthropic/claude-sonnet-4-5` |
| `google` | `GOOGLE_GENERATIVE_AI_API_KEY` | `google/gemini-2.5-pro` |
| `openrouter` | `OPENROUTER_API_KEY` | `openrouter/anthropic/claude-sonnet-4.5` |
| `deepseek` | `DEEPSEEK_API_KEY` | `deepseek/deepseek-chat` |
| `groq` | `GROQ_API_KEY` | — |
| `mistral` | `MISTRAL_API_KEY` | — |
| `xai` | `XAI_API_KEY` | — |
| `cerebras` | `CEREBRAS_API_KEY` | — |
| `togetherai` | `TOGETHER_API_KEY` | — |

Provider ids never contain a slash, model ids may (`openrouter/anthropic/claude-sonnet-4.5`), and the resolver
matches the longest known provider id — a typo like `opengai/gpt-5` fails at `/model set` and in `doctor`
instead of at answer time. `MODEL_ALLOWLIST` pins the whole deployment to an exact comma-separated list when
you want the old hard allowlist back.

### Local runtimes and private gateways

Anything that speaks the OpenAI API but is not in the catalogue is declared in `config/providers.json`
(copy [`config/providers.example.json`](./config/providers.example.json) — it ships Ollama, vLLM and LM Studio
entries). Keys are *named*, never inlined:

```jsonc
{
  "ollama": {
    "label": "Ollama (local)",
    "baseUrl": "http://127.0.0.1:11434/v1",
    "models": {
      "qwen3-coder:30b": { "name": "Qwen3 Coder 30B", "toolCall": true, "contextLimit": 262144 }
    }
  }
}
```

`apiKeyEnv` names the variable holding the key (omit it for a keyless local runtime), `npm` defaults to
`@ai-sdk/openai-compatible`, and `toolCall`/`reasoning`/`attachment`/`contextLimit`/`outputLimit` describe the
model so `/model list` and the tool loop behave. Workspace configs reference credentials as `{env:NAME}`, so no
secret is ever written into a workspace repository. `bun run setup` asks the endpoint for `/v1/models` and
writes the entry for you.

## Scripts

| Command | Effect |
| --- | --- |
| `bun dev` | watch mode |
| `bun start` | run once |
| `bun run setup` | interactive first-run: token check, provider + model choice, `.env`, command deploy |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` / `bun run format` | ESLint (with Prettier) / Prettier |
| `bun test` | unit tests |
| `bun run commands deploy\|clear\|list` | slash-command registration (`--global`, `--guild`, `--force`) |
| `bun run commands auth\|doctor\|smoke\|e2e\|backup` | agent tooling (`auth` probes Go first then Jev; `backup` writes a consistent SQLite snapshot, keeping 14) |

Fixtures live in `config/fixtures/*.json` and are loaded by `/eval` and the promotion gate.

## Project layout

```text
src/
  main.ts                  entry: env check, instance lock, importer, client.build(), deploy, login
  client.ts                discordx Client (intents/partials from utils/constants)
  commands/                slash commands and component interactables (agent, model, help, admin, approvals)
  events/                  ready, mention prompts, interaction safety net
  guards/                  cooldown, guildOnly, ownerOnly, guildEnabled, managerOnly
  cli/                     `bun run commands …` dispatcher + setup/deploy/clear/list, auth/doctor/smoke/e2e
  services/
    config.ts              guilds.json, paths, role models, shell defaults
    agent/                 binary, client, provider registry, model resolver, error diagnosis, supervisor, runtime
    bridge/                26 Discord capabilities + loopback RPC server
    policy/                tier ceilings, Jev client (shadow/enforce)
    memory/                FTS5 store, retrieval injection, reflector
    workspace/             provisioning, generated tool file, docker/host shell
    discord/               approvals, stream renderer, service registry
    database/sqlite.ts     schema and stores
  utils/                   env, logger (pino), constants, instance lock
```

Path aliases (`@services/*`, `@utils/*`, `@guards/*`, `@cli/*`, `@/*`) come from `tsconfig.json`.

## Commands

| Command | Effect |
| --- | --- |
| `/ask <prompt>` | run a task in this channel — one progress message is edited live, then the answer arrives as a new message that pings you |
| `/help` | what the agent can do, grouped by tool risk |
| `/model current` | roles, their source, and which providers are ready |
| `/model list [filter]` | every model this server can run |
| `/model set model:<id> [role]` · `/model reset [role]` | switch or drop a guild's model (admin) |
| `/vibe on\|off` | run tool calls without approval cards, Jev screening the dangerous ones (admin) |
| `/settings` | point-and-click settings: category → key → on/off buttons, a choice menu, or a form (admin, owner for the dangerous keys) |
| `/config show` · `/config set <key> <value>` · `/config reset <key>` | the same keys as text — handy for scripts and exact paths — scope-checked (admin, or bot owner for the dangerous keys) |
| `/access show [user]` · `/access set <user> <key> <value>` · `/access block\|unblock\|clear <user>` | per-account permissions: rank, risk ceiling, tool and command lists (bot owner) |
| `/new` | fresh opencode session for this channel |
| `/abort` | interrupt the running task |
| `/status` | servers, sessions, approvals, sandbox, policy, models, gateway, recent decisions |
| `/audit` | last 10 policy decisions in this server |
| `/remember <text>` | store a durable fact (rewrites the workspace `MEMORY.md`) |
| `/memory [query] [forget]` | search, show stats, or delete a memory by id |
| `/learn` | compile stored lessons into a `SKILL.md` proposal and review the diff (admin) |
| `/skills [revert] [name]` | list artifacts, feedback counts, current skill file; restore a version |
| `/eval` | replay `config/fixtures` against the current agent and print pass rate + failing checks |
| `/undo` | revert the last turn's file changes in this server's workspace (admin) |
| `/skill-file [name]` | print the learned skill file |
| `/ping` | interaction latency, gateway ping, pid |
| *(cards)* | the agent's `question` tool and `permission.asked` both arrive as answerable cards — buttons, or a select menu when a question offers more than five options |
| `/enable` | owner only: allow this server |

Mentioning the bot or replying to one of its messages also starts a task.

### What a turn looks like in the channel

1. one message says `🧠 thinking…` and is edited in place — the partial answer, the current tool call, and the
   model's reasoning as it is published — so the channel never fills with tool chatter;
2. when the turn ends that message stays as the turn's **log** (`🧠 log · 42s · 3 steps`, the tool calls in
   order, then the chain of thought as a quote) and the answer is posted as its **own message that pings
   whoever asked** (long answers continue in follow-up chunks, mention on the first only). Reasoning only
   appears for models that publish reasoning parts; a model that answers straight from context logs its steps
   alone;
3. approval cards are removed the moment they are decided, expired, or the turn ends — the record stays in
   `/audit` instead of in the channel;
4. a **round that ends on a failed tool call is continued, not accepted**: the same session is prompted again
   with the error in hand (`🔁 … asking it to finish`), twice at most. That is what turns "Plan confirmed —
   building…" plus a denied `write` into an actual result, or into an answer that says it could not do it;
5. if it still ends on failures, the answer carries a `⚠️ N tool call(s) failed` quote listing the tool and the
   error, so a turn can never read as a clean success when something broke. A policy refusal is recorded in
   `/audit` (`layer: vibe`) whether it was made by a human or by Jev;
6. a turn is abandoned only after `IDLE_TIMEOUT_MS` (10 min) of **silence** — continuous streaming or tool
   calls reset that clock, so slow work is never killed. On a timeout the session is aborted, the channel is
   rebound to a fresh session so the next message works normally, and the partial output is posted with a
   `⏱️ interrupted` note.

## Tools the agent has

30 capabilities, all authorised against the requester's rank before they run:

| Risk | Tools |
| --- | --- |
| read | `guild_info`, `channels_list`, `channel_info`, `roles_list`, `member_list`, `member_info`, `messages_fetch`, `git_status` |
| reversible | `channel_create`, `channel_update` (name/topic/slowmode/nsfw), `channel_move` (category/position), `thread_create`, `thread_update` (archive/lock/rename), `message_send`, `message_pin`, `role_create`, `role_update`, `role_assign`, `invite_create`, `git_commit`, `git_push`, `git_repo_create` |
| destructive | `channel_delete`, `permission_set` (allow/deny/clear overwrites), `role_delete`, `message_delete`, `member_timeout`, `member_kick`, `member_ban`, `bash` |

Permission names are validated (`allow: ["ViewChannel"], deny: ["SendMessages"]`), colours must be `#rrggbb`, and
`bash` is the shadowed builtin that runs through the sandbox. The three `git_*` write tools only appear once a git
server is configured (see [Git server](#git-server-optional)).

## Memory

Three write paths feed one SQLite store (`memory` + `memory_fts`):

- **reflection** — after a turn that used tools or asked for something durable, the `fast` role re-reads the turn
  and emits typed JSON (`facts`, `preferences`, `lessons`); entries that look like credentials are dropped
  before they reach the store.
- **explicit** — `/remember <text>`.
- **digest** — `MEMORY.md` in the workspace is rewritten from the top rows, so opencode also loads the most
  important facts as project instructions.

Retrieval scores `0.6·BM25 + 0.25·recency + 0.15·importance` under a 1500-char budget and injects a
`<memory>` block into the user turn. Corrections supersede rather than contradict: `superseded_by` keeps the
old row for audit but removes it from recall.

## Learning loop

Three signals feed one loop, and every change is gated:

1. **outcomes** — tool success/failure, permission denials, corrections (all already recorded).
2. **reactions** — 👍/👎/✅/❌ on the bot's own messages are stored (`feedback`), de-duplicated per user/message,
   and folded into the next reflection pass so a thumbs-down actually teaches something.
3. **lessons** — the `fast` role turns turns into `facts`/`preferences`/`lessons`.

`/learn` ranks those lessons and renders a diff. On approval the change goes through an **A/B gate** before it is
allowed to stay:

1. replay every fixture in `config/fixtures/*.json` against the incumbent skill state → baseline rate
2. write the candidate, restart that guild's opencode server (skills load at start-up), replay again
3. keep it only if the candidate is not worse; otherwise restore the previous bytes and say so

When it survives, the bot writes `.data/workspaces/<guild>/.opencode/skills/learned-playbook/SKILL.md`, records the
version (content + sha256) in `artifacts`, and **commits the workspace repo** — so `/skills revert:1` restores the
exact earlier bytes and the history of what it taught itself stays inspectable. Fixtures assert tool usage, output
patterns, and forbidden leaks, and can add a Jev yes/no judgement on the answer.

A scheduler runs deterministic upkeep: memory consolidation (dedupe, decay, prune, rewrite `MEMORY.md`) every 6 h
and a database snapshot every 24 h.

## Policy

Default ceilings — every cell is overridable per guild with `/config set policy.matrix.<rank>.<risk>`:

| Rank | read | reversible | destructive | admin |
| --- | --- | --- | --- | --- |
| owner / guild owner | allow | allow | allow | allow |
| admin (config role) | allow | allow | allow | ask |
| trusted (config role) | allow | allow | ask | deny |
| member | allow | ask | deny | deny |
| guest / DM | allow | deny | deny | deny |

### Three layers, strictest wins

Every call — a bridge capability, or the agent server's own `bash`/`edit`/`webfetch` ask — is judged by three
layers in order. Each returns `allow`, `ask` or `deny`; the pipeline takes the strictest, so no layer can loosen
what another one refused, and a layer that cannot answer fails to `ask`.

| Layer | What it is | Cost | Can it block? |
| --- | --- | --- | --- |
| **hard** | fixed rules in code: tool switches and deny/allow lists, command shapes, self-target rules, rank ceiling + matrix | free, deterministic | yes |
| **Jev** | the independent classifier (`policy.vibe.*`, `JEV_MODE`) | one small remote call | yes, vetoes on evidence |
| **agent review** | the guild's own primary model re-reads the call it is about to make (`policy.review.*`) | one turn on its own server | yes, `enforce` only |

Hard rules are literal, have stable ids, and show up in `/audit` instead of a model's opinion:

| Rule id | Refuses |
| --- | --- |
| `rm-root` | `rm` against `/`, `~`, `$HOME`, `/etc`, `/usr`, `/var` |
| `mkfs`, `dd-device`, `power`, `fork-bomb`, `chmod-777-root`, `pipe-to-shell`, `drop-database` | the command shapes that have no safe reading |
| `force-push`, `truncate-table`, `wipe-disk` | ask a human first |
| `protected-target` | banning, kicking, timing out or role-stripping the server owner or the bot itself |
| `administrator-grant` | `permission_set`/`role_create`/`role_update` that hands over `Administrator` |

The allow list (`policy.tools.allow`) and read-only calls are the two shortcuts: the owner's allow list means
"no cards for this tool, ever" and short-circuits the model layers, and reads have nothing to approve.

The review layer is a **self-check**: the same model family proposed the call, so it catches wrong targets and
actions nobody asked for — Jev remains the independent opinion. It runs in parallel with Jev, caches an identical
call for 30 s, and is only consulted for a call that would otherwise run **unattended** — when the hard layer
already says `ask`, a human is looking at the card anyway, so no model turn is spent there.

| `policy.review.mode` | Effect |
| --- | --- |
| `off` | never ask the agent |
| `shadow` | start the review and log the reading, never wait for it — the way to price the layer before enforcing |
| `enforce` (default) | it can tighten the verdict; a failed, timed-out or unparseable review becomes `ask` |

Measured on the default free-tier model, one review is **20-30 s** (a reasoning model answering one JSON
object), which is what a vibe-mode auto-run pays per tool call; the timeout is 45 s and a timeout is
fail-closed, so a slow provider degrades to a card rather than a silent run. A faster `model.primary`, or
`policy.review.model: fast`, brings that down. `REVIEW_MODE=off` in `.env` is the deployment kill switch for
the spend, and `policy.review.minConfidence` (0.5) decides how sure an "allow" has to be before it counts.

### Modes

| `policy.mode` | What a call the ceiling does not allow outright does |
| --- | --- |
| `ask` (default) | posts an approval card and waits for a human |
| `vibe` | runs it — Jev reads the call first and vetoes what looks dangerous |
| `locked` | refuses everything above `read`, whatever the rank says |

`/vibe on|off` is the one-word switch for `vibe`; `/config set policy.mode …` does the same and reaches the rest.

**Vibe is "run it unless it looks dangerous", not "run anything".** A rank ceiling that says `deny` still
denies — vibe removes the *approval step* for people already entitled, it never promotes anyone. Then, per
call, Jev is asked how destructive it is and whether an admin would approve:

| Jev reading | Vibe does |
| --- | --- |
| `catastrophic` | refuses, whatever the rank or score |
| `destructive` with approval below `policy.vibe.minApproval` (0.4) | refuses — the sandbox does not make `rm -rf` fine |
| destructive-class call Jev rates reversible/destructive | needs `minApproval + 0.2`, because Jev reads coarse classes loosely (a `permission_set Administrator` came back "reversible" at 0.45) |
| destructive-class call Jev calls `read_only` with low confidence | asks a human — an unconfident "it's safe" is not a green light for a delete |
| anything above `policy.vibe.maxRisk` | asks a human |
| Jev unreachable | asks, unless `policy.vibe.askOnUncertain` is false |
| otherwise | runs it |

The agent server's own permission asks (`bash`, `edit` outside `repo/`, `webfetch`) go through the same screen,
and a shell call is classed reversible inside the docker sandbox but destructive in `host` mode. Every
auto-decision lands in `/audit` with `layer: vibe`, so a refused write is explainable afterwards instead of
appearing as a bare `✗ write` in the log. Real readings
from a vibe-mode test: `message_send` allow (Jev: reversible, 0.67), `channel_delete` deny (destructive, 0.24),
`permission_set Administrator` deny (0.45), `bash bun test` allow, `bash rm -rf /` deny (catastrophic),
`edit /etc/passwd` ask (an unconfident "safe" reading).

### `/settings` — the panel, and `/config` — the same keys as text

`/settings` is the way in: an ephemeral panel that never leaves your screen.

```
/settings  →  [ policy · policy and approvals   ]
              [ features · tools and behaviour  ]
              [ shell · sandbox                 ]   ← only if you may change it
                       ↓ pick a category
           [ mode            ask — anything the ceiling does not allow outright… ]
           [ review.mode     enforce                                              ]
           [ rank ceilings…  5 ranks × 4 risk classes                            ]
                       ↓ pick a key
           [ ask ] [ vibe ] [ locked ]        ← a menu of the values that parse
           [ reset to default ] [ ← back ]
```

- the control matches the value type: **buttons** for on/off, a **menu** for a fixed set of values (with the
  current one pre-selected), a **form** (`modal`) for free text, ids, model names and numbers;
- the **rank ceilings** are two selects deep — rank, then risk class — instead of typing
  `policy.matrix.trusted.destructive deny`;
- every value shown is the value *in force*, and every value you can pick is one the parser accepts, because the
  panel and `/config set` share `parseSetting`: a menu can never offer something the text command would refuse;
- keys you may not change are not in the list at all, and the footer says why (`scopeNote`);
- a change applies immediately; a `features.*` change also stops that guild's server so the next prompt picks up
  the new tool list and persona.

`/config show` prints the mode, the effective rank table (with `*` on cells this guild overrides), the sandbox,
the feature switches, the models, and how many keys *you* may change. `/config set <key> <value>` and
`/config reset <key>` are the same keys, scope-checked the same way — reached through `applySetting`, the one
write path both surfaces use:

| Scope | Keys |
| --- | --- |
| guild admin | `policy.mode`, `policy.vibe.maxRisk|screen|minApproval|askOnUncertain`, `policy.review.mode|minConfidence`, `policy.tools.deny`, `features.tools.disabled`, `features.clarify`, `model.primary`, `model.fast` |
| **bot owner only** | `shell.mode` (`host` runs shell calls as the bot user), `shell.image`, `shell.fallback`, `policy.tools.allow` (bypasses the card for everyone), `policy.matrix.*` (20 cells), `roles.admin`, `roles.trusted`, `access.blocked`, `git.enabled`, `git.provider`, `git.baseUrl`, `git.owner`, `git.push`, `git.createRepos`, `git.visibility`, `enabled` |

So a guild admin can make the bot chattier or stricter, but cannot turn the sandbox off, grant themselves a
capability, rewrite the rank table, or widen what bypasses approval — those need `OWNER_ID` in `.env`.
`/config reset` restores the schema default exactly (empty containers included), and every value is validated
before the write, so a typo leaves the file untouched.

### One sandbox per server, or none

`shell.mode` is a **per-guild** key, so the same bot can run one server with the whole machine and every other
server in a container:

```
/config set shell.mode host          # in the server you trust — runs as the bot user, on the VPS itself
/config set shell.mode docker        # everywhere else: container oda-<guildId>, only that workspace mounted
```

Each guild's shell container is its own (`oda-<guildId>`), `shellStatus()` and the policy gate resolve the mode
through the same `shellModeOf()`, so `/status` reports *that server's* mode and a call is classed reversible in a
container but `destructive` on the host. `shell.fallback` decides what happens when the daemon is down (`error`
refuses; `host` degrades — leave it on `error` unless the whole VPS is trusted).

Host mode is not a bigger sandbox, it is *no* sandbox: the agent's shell runs with the bot's environment, so it
sees `DISCORD_TOKEN`, the git and panel keys and the console token, and can read anything the bot user can. Keep
it to servers whose operators you would give a bot-user shell to anyway.

### Per-account permissions

Ranks cover groups; `access` covers one Discord account, by user id. It is **bot-owner only** (`/access …`),
because `rank` pins a tier and that grants capability.

```
/access set user:<@someone> key:risk value:read                 # "may look, may not change anything"
/access set user:<@someone> key:tools-allow value:messages_fetch,guild_info,channels_list
/access set user:<@someone> key:rank value:admin                # full tools, no Discord role needed
/access set user:<@someone> key:commands-deny value:config:set,config:reset,model:set,vibe
/access block user:<@someone>                                   # may not use the bot at all
/access unblock user:<@someone> · /access clear user:<@someone> · /access show [user]
```

| Key | Meaning |
| --- | --- |
| `rank` | pins the tier (`guest`…`owner`), replacing whatever their roles say — in both directions |
| `risk` | highest risk class they may reach: `read`, `reversible`, `destructive`, `admin` |
| `tools-allow` | whitelist: only these tools **and/or sets** (empty = inherit the guild's) |
| `tools-deny` | blacklist: never these tools and/or sets; it wins over `tools-allow` |
| `commands-allow` / `commands-deny` | the same for slash commands — `config` blocks the whole group, `config:set` just that subcommand |

`tools-allow`/`tools-deny` take one tool, one set (`discord`, `channels`, `shell`, `git`, `pterodactyl`,
`pterodactyl-admin`, …), or a mix, so "these two panel tools" and "no shell, no git" are both one line:

```
/access set user:@helperA key:tools-allow value:pterodactyl     # the panel surface, nothing else
/access set user:@helperB key:tools-deny  value:ptero_power,ptero_command,ptero_file_write
/access set user:@helperC key:tools-deny  value:shell,git
/access set user:@helperD key:tools-allow value:messages_fetch,member_info,channels_list
```

So the three cases look like this:

| Want | Set |
| --- | --- |
| "can only look for problems" | `risk: read` (or `tools-allow` on the read tools) |
| "full access, cannot change settings" | `rank: admin` + `commands-deny: config:set,config:reset,model:set,vibe` |
| "cannot use the bot at all" | `/access block` — no turns, no commands, no approvals |

Precedence is the same everywhere: **blocked beats profile, profile beats guild.** A profile can only tighten
what the guild already allows, with one exception — an explicit `rank` pin. Blocked accounts read as `guest` for
every rank check, so `/config`, `/access` and approval buttons are closed to them automatically. The rules are
enforced in three places from one profile: `hardCheck` (every tool call, `layer: user` in `/audit`),
`accessGuard` (every slash command) and `promptAccess` (mentions and replies that would start a turn).

`/access set` validates against the real tables — rank names, risk classes, registered tool/set names and the
registered command list — so a typo fails loudly instead of silently leaving access on. Note the reminder: a
blocked account that is also in `access.users` keeps its profile, so unblocking restores the limits.

### Feature flags

Two switches change what the agent *is*, not what a rank may do. Both narrow only, so a guild admin owns them,
both are re-rendered at provisioning, and `/config set` stops that guild's server so the next prompt picks them up.

`features.tools.disabled` — a comma-separated list of tools and/or sets. A disabled tool is not in the model's
tool list at all (not described, not offered), and the gate refuses it anyway, so a stale client cannot slip one
through. Sets: `discord` (everything that talks to Discord), `server`, `channels`, `messages`, `threads`,
`members`, `roles`, `permissions`, `invites`, `shell` (the sandboxed `bash`), or any single tool name.

```
/config set features.tools.disabled discord     # read-only-ish: no Discord writes at all
/config set features.tools.disabled shell       # no shell; opencode's builtin bash is denied too
/config set features.tools.disabled channels,member_ban
/config reset features.tools.disabled
```

Switching `bash` off also writes `permission.bash: "deny"` into the workspace config: removing the generated
tool would otherwise let the pinned server's own bash (host, unsandboxed) back in.

`features.clarify` — how hard the persona pushes the agent to ask instead of assuming:

| Level | Behaviour |
| --- | --- |
| `off` | take the obvious reading, act, then say what was assumed |
| `normal` (default) | one clarifying question when a destructive target is ambiguous |
| `high` | state the reading used and what else it could have meant; ask before anything that changes state |
| `always` | never resolve an ambiguity itself: every state-changing request gets a question listing the exact options and ids first |

`clarify` shapes how the model talks to you; it does not change approvals. Approval strictness is the matrix
(`policy.matrix.<rank>.<risk>`) and `policy.mode`, which are owner-scoped on purpose.

Models run wherever `.env` points them. The default **primary** is the keyless free tier; the default
**fast** model runs on the **OpenCode Go** subscription: provider `opencode-go`, base URL
`https://opencode.ai/inference/go`, authenticated with a Console API key (`oc_sk_...`) that the supervisor
injects as `OPENCODE_GO_API_KEY`. Go is a different endpoint from the free tier — a keyless/free call answers
"Free usage exceeded, subscribe to Go", which is what `bun run doctor` checks explicitly (`go subscription`).
When no role runs on Go, `doctor` skips that check instead of reporting a failure.

`JEV_MODE=shadow` (default) logs Jev's reading of every non-read call while the tier table still decides;
`enforce` lets Jev auto-allow high-confidence low-risk calls and deny anything it rates catastrophic or
unlikely to be approved. Without a credential the gate degrades to "ask a human", never to allow.

`config/guilds.json` (created by `/enable`, not committed):

```jsonc
{
  "123456789012345678": {
    "enabled": true,
    "shell": { "mode": "docker", "image": "debian:bookworm-slim", "fallback": "error" },
    "roles": { "admin": ["111..."], "trusted": ["222..."] },
    "model": { "primary": "opencode-go/gpt-5.6-luna" }
  }
}
```

### File-edit policy

Every workspace is a git repo with an initial commit. Inside `repo/` the agent may write and edit **without an
approval card** — that is the code sandbox, each turn is committed (`agent: turn …`), and `/undo` reverts the last
turn. Control files stay denied to the agent (`opencode.json`, `AGENTS.md`, `.opencode/**`, `MEMORY.md`), and any
edit outside `repo/` still asks a human.

**Commits are written, not optional.** `commitWorkspace` (`src/services/git/workspace.ts`) runs after every turn,
after every learned-skill write and at provisioning, with the bot's own identity
(`open-discord-agent <agent@open-discord-agent>`). The workspace `AGENTS.md` says so in a `## Git` section, so the
agent knows its edits are snapshotted and that it may add an explicit commit of its own (`git_commit`) — it never
needs to commit to make edits safe, and `/undo` depends on that history existing.

### Git server (optional)

Any Forgejo, Gitea or GitLab instance can back the workspace. The token stays in `.env`; whether a guild may use
it is config, so no credential ever lands in `config/guilds.json` or in a workspace the agent can read.

```bash
# .env
GIT_TOKEN=<token>            # Gitea/Forgejo: write:repository (+ write:user to create repos); GitLab: api
GIT_BASE_URL=https://git.example.com
GIT_OWNER=some-group         # optional default owner for new repos
```

```
/config set git.enabled true          # both owner-only: this ships code off the machine
/config set git.provider forgejo      # forgejo | gitea | gitlab
/config set git.baseUrl https://git.example.com
/config set git.owner some-group      # repos the bot creates land here (empty = personal namespace)
/config set git.push true             # push after every commit: each turn, each artifact write
/config set git.createRepos true      # let the agent create repositories
/config set git.visibility private    # private | public
```

What the agent gets, and only when it is configured:

| Tool | Risk | Does |
| --- | --- | --- |
| `git_status` | read | branch, remote, uncommitted files, unpushed commits, last 5 commits |
| `git_commit` | reversible | commit with the agent's own message, then push |
| `git_push` | reversible | push the current branch (hidden when no server is configured) |
| `git_repo_create` | reversible | create a repo on the server, optionally attach it as `origin` (hidden unless `git.createRepos`) |

`git_push` and `git_repo_create` are not in the model's tool list at all until a server is configured — a tool
that can only fail is a tool the model wastes turns on. `features.tools.disabled: git` switches the whole set off.
The push URL is built per call (`authedRemote`), so the token is never written into the workspace `.git/config`,
and every error message passes through `redact` before it reaches a log line or the model.

`git_repo_create` creates a repository but never deletes one, and `attachOrigin` refuses to replace an existing
`origin` — one workspace, one home for its history.

### Pterodactyl panel (optional)

Game-server control for the servers you already run. Two keys, two APIs, and a guild has to ask for each part:

```bash
# .env  — ptlc_… is the client API (that account's servers), ptla_… is the application API (the whole panel)
PTERO_CLIENT_KEY=
PTERO_ADMIN_KEY=
PTERO_BASE_URL=https://panel.example.com
```

```
/config set pterodactyl.enabled true                 # owner-only: remote infrastructure
/config set pterodactyl.baseUrl https://panel.example.com
/config set pterodactyl.servers d3aac109,7           # allow-list; empty = everything the key can see
/config set pterodactyl.files false                  # read/overwrite files inside a server
/config set pterodactyl.admin false                  # application API: whole-panel tools
```

| Tool | API | Risk | Exists when |
| --- | --- | --- | --- |
| `ptero_servers`, `ptero_server` | client | read | panel enabled |
| `ptero_power` (start/stop/restart/kill), `ptero_command` (console) | client | destructive | panel enabled |
| `ptero_files`, `ptero_file_read`, `ptero_file_write` | client | read / read / destructive | `pterodactyl.files` |
| `ptero_admin_servers`, `ptero_admin_server`, `ptero_admin_users`, `ptero_admin_nodes`, `ptero_admin_nests` | application | read | `pterodactyl.admin` |
| `ptero_admin_suspend`, `ptero_admin_user_create`, `ptero_admin_server_create` | application | destructive / **admin** | `pterodactyl.admin` |

Gating is layered like everything else, and the hard layer is the authority:

- **switches** — a tool the guild has not switched on is absent from the model's list *and* refused by `hardCheck`
  (`layer: tools`), so an older tool list cannot reach it;
- **allow-list** — `pterodactyl.servers` is checked in code before any request leaves the bot
  (`layer: pattern`, reason starts `ptero-server:`), which is what keeps "one server" meaning one server;
- **paths** — file paths must be absolute and cannot contain `..`, so a write cannot climb out of the server root;
- **sets** — `features.tools.disabled: pterodactyl` hides the whole surface, `pterodactyl-admin` just the
  application-API half;
- **per-account** — the usual `access.users.<id>` profile (`risk: read` is "look, do not touch"); reads are
  `read`, power/command/file-write/suspend are `destructive`, user and server creation are `admin`-class, so the
  rank ceiling and `policy.matrix` apply unchanged.

There is deliberately **no delete**: no tool removes a server, a user, a node or a file tree. The keys are read
from `.env` (never `config/guilds.json`), never logged, and every error message is passed through `redact` before
it reaches the model.

## Web dashboard (Clerk)

An optional browser surface over the same settings, for people who would rather click than type slash commands.
Identity is Clerk; permissions are **not** Clerk roles — they are a people list you control, and the default is
nothing.

```bash
# .env
WEB_PORT=8080
CLERK_PUBLISHABLE_KEY=pk_test_…      # the Frontend API host is encoded in this key, so no second URL
WEB_OWNER_EMAILS=you@example.com     # additive to config/web.json
WEB_ADMIN_EMAILS=                     # "certain people given perms", same rights as the owner
```

```jsonc
// config/web.json — who is who. Credentials are never here, only people.
{
  "owners": ["you@example.com"],                 // full control, everything
  "admins": ["helper@example.com"],              // full control too
  "links": { "user_2abc…": "123456789012345678" }, // Clerk user id → Discord id: that Discord account's servers
  "guilds": { "1568699957…": ["mod@example.com"] } // extra people per server, without a Discord link
}
```

| Role | Sees | Can change |
| --- | --- | --- |
| **bot owner** (`owners`) | every server | everything, bot-wide included |
| **granted** (`admins`) | every server | everything, bot-wide included |
| **server owner** (Discord owner of an **approved** server, via `links`, or listed in `guilds`) | their servers | that server's guild-scoped settings and its per-account access |
| **anyone else** | nothing | nothing (the API answers 403, the page shows nothing) |

Bot-wide means the machine and the credentials, so a server owner cannot touch them: `shell.*` (docker vs host),
`model.*`, `git.*`, `pterodactyl.*`, `roles.*`, `enabled` (that is the *approval* flag — an unapproved server's
owner gets nothing) and `policy.tools.allow` (which skips every approval card). Everything else — `features.*`,
`policy.mode`, `policy.vibe.*`, `policy.review.*`, `policy.matrix.*`, `access.*` — is theirs, on their server only.

How it is built:

- `services/web/auth.ts` — Clerk session tokens verified with WebCrypto (RS256 against the issuer's published
  JWKS, issuer + `exp`/`nbf` checked, one retry on key rotation). No key, no session: `undefined` and a 401.
- `services/web/principals.ts` — `config/web.json` → `owner | admin | guild | nobody`, plus the bot-wide rule.
- `services/web/server.ts` — `GET /api/me`, `GET /api/guilds/:id`, `PATCH /api/guilds/:id`,
  `GET|PUT /api/guilds/:id/access`; every request re-verifies the token and every write goes through the same
  `applySetting` the Discord commands use, with `actor: web:<email>` in the log.
- `services/web/ui.html` — one page, no build step: guild list, settings grouped by category with the control that
  matches the value type (checkbox/select/text), bot-wide rows disabled with the reason, and a JSON box for
  per-account access profiles.

The dashboard is off unless `WEB_PORT` and `CLERK_PUBLISHABLE_KEY` are both set (`startWebFromEnv` returns
`undefined` and logs why). It binds `0.0.0.0` — put it behind the same TLS reverse proxy as anything else.

## Ops (Linux VM)

```bash
sudo cp deploy/oda.service /etc/systemd/system/oda.service
sudo systemctl enable --now oda
journalctl -u oda -f
```

- Data lives in `.data/` (SQLite `agent.db`, workspaces, console token, opencode runtime dirs). Snapshot it with
  `bun run commands backup` (`VACUUM INTO .data/backups/…`, keeps the last 14) — safer than copying a live DB.
- The bot never uses the globally installed `opencode`; the pinned 1.19.5 binary comes from `bun install` and
  the boot guard refuses to start on a version mismatch.
- Production logs: `logs/app.log` and `logs/error.log` (pino), console output is pretty-printed in development.

## Troubleshooting

The bot takes a lock at `.data/bot.lock` and refuses to start while another process holds it: a second login
invalidates the first gateway session, after which interactions arrive late and every reply fails with
`Unknown interaction` (10062).

Failures are classified before they reach the channel: a provider error is replaced by a one-line diagnosis and
the command that fixes it (`src/services/agent/errors.ts`), and the cause is logged as a stable code
(`go-subscription`, `auth`, `model-unavailable`, `rate-limit`, `context`, `network`, `tool-support`,
`interaction-expired`).

| Symptom | Cause |
| --- | --- |
| `opencode binary not found` | postinstall skipped → `bun pm trust opencode-ai && bun install` |
| `server reported version X, expected 1.19.5` | a different binary is being picked up → `bun run doctor`, check `OPENCODE_BIN` |
| member list is empty | `GuildMembers` intent not enabled in the Discord portal (`setup` warns about this) |
| a tool sits at "write · pending" | a `write`/`edit` outside `repo/` is waiting for an approval card — answer it, or move the work under `repo/` where edits are click-free; the streaming message says `🔒 waiting for approval` |
| shell refuses with "docker is not available" | start Docker or set `shell.mode: "host"` for that guild |
| "The model call fell through to the free tier" | the model call used the free tier: run `bun run auth` so a Go-entitled key is stored, then `bun run doctor` (expect `✅ go subscription 200`) |
| "The provider rejected the credential" | the key for the provider in `/model current` is wrong, revoked, or stored under another name — check `.env`, then `bun run doctor` |
| "That model is not available from this provider" | `/model list` for what the server offers, then `/model set` |
| `unknown provider "x"` | the provider has no credential and is not declared — add the key to `.env` or an entry to `config/providers.json` |
| a local model answers but never calls a tool | the runtime/model does not do function calling — mark it `"toolCall": true` only once it does, or pick another model |
| `Unknown interaction` (10062), or commands answer "The application did not respond" | the gateway delivered the interaction after Discord's 3s window — usually a second process on the same token (the lock file blocks that) or a paused host; `/ping` reports interaction latency, gateway ping and pid |
| the agent says "question · running" and nothing arrives | it used opencode's `question` tool; the card should be posted in the channel (answer buttons or a select). If it is missing, check the bot log for `could not post question card` |
| approvals never appear | check `/status` → `policy`; the event name is `permission.asked` (not `permission.updated`) |
| the log shows `0 steps` and no thinking | that turn used no tools and the model published no reasoning part — not an error |
| a turn says `⏱️ interrupted after 10 min without output` | the provider stopped emitting events; the session was aborted and a fresh one bound to the channel, so the next message runs normally. Raise `IDLE_TIMEOUT_MS` if your runtime is just slow |
| an answer arrives but pings nobody | the requester must still be in the channel — the mention is `<@id>` on the first chunk of the answer |
| commands appear twice | deploy once per scope: `bun run commands deploy --guild` clears the global set, `--global` clears the guild copy |
| slash commands lost their arguments | every `deploy`/`list` run now calls `MetadataStorage.build()` first; a payload published by an older build has to be redeployed (options and slash groups are attached there) |
| `/enable` says owner only | `OWNER_ID` in `.env` must be your Discord user id |
