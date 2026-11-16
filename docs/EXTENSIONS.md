# Extensions

An **extension** is one file that owns a set of tools. The bot has four: `discord`, `shell`, `git`, `pterodactyl`.
Adding a fifth is two steps — a file, and one line in the registry:

```ts
// src/services/extensions/registry.ts
export const EXTENSIONS: Extension[] = [discordExtension, shellExtension, gitExtension, pterodactylExtension, myExtension];
```

Everything else follows automatically:

| Consumer | What it does with the extension |
| --- | --- |
| `bridge/server.ts` | validates arguments against the declared `params`, and refuses an unavailable extension |
| `workspace/codegen.ts` | writes the model's tool file from it, and leaves out what is switched off |
| `policy/hard.ts` | refuses a call from an extension the guild disabled (`layer: tools` in `/audit`) |
| `policy/settings.ts` | offers it in `/settings`, the dashboard and `/config set features.extensions.disabled` |
| `commands/help.ts` | lists its tools under their risk class |
| per-account access | `access.users.<id>.tools.allow/deny` accept the extension id as a set |

## The contract

```ts
export type Extension = {
  id: string;                       // also the set name: `features.tools.disabled: ["mythic"]`
  name: string;                     // what a human sees
  description: string;
  capabilities: ExtensionCapability[];
  /** Optional: is this extension usable in this guild at all? */
  available?: (guildId: string) => { ok: boolean; reason: string };
};

export type ExtensionCapability = {
  name: string;                     // the model-facing tool name, unique across all extensions
  summary: string;                  // one line, shown in the tool description
  description: string;              // the full description the model reads
  risk: 'read' | 'reversible' | 'destructive' | 'admin';
  params: ParamSpec[];              // typed arguments; the bridge validates them with zod
  run: (ctx: CapabilityContext, args: Record<string, unknown>) => Promise<string>;
  /** Optional: a narrower set the tool also belongs to (e.g. `pterodactyl-admin`). */
  sets?: string[];
  /** Optional: per-tool availability inside an available extension. */
  available?: (guildId: string) => { ok: boolean; reason: string };
};
```

`run()` gets a `CapabilityContext`: the Discord `client`, the `guild` the call came from, the `actorId` who asked,
the `channelId` it came from — and `ctx.shell(command)`, which runs in **that guild's** shell.

## Rules that keep it safe

1. **Never spawn processes yourself.** Use `ctx.shell(command)`; it routes through the guild's sandbox mode
   (a per-guild docker container by default, the host only where the owner opted in). A tool that calls
   `Bun.spawn` directly escapes the sandbox decision the rest of the bot honours.
2. **Never read files outside the guild workspace.** `.data/workspaces/<guildId>` is the tenant boundary; there is
   no helper for "read any file", and there should not be.
3. **Credentials come from `.env`, never from `config/guilds.json`**, and never from tool arguments. Resolve them
   the way `git/forge.ts` and `pterodactyl/api.ts` do, and pass them through `redact()` before they reach a log
   line or the model.
4. **Declare the risk honestly.** `read` runs for everyone; `destructive` costs an approval card below admin;
   `admin` costs one even for an admin. Getting this wrong is the one mistake the gate cannot catch for you.
5. **Declare availability instead of failing.** If the extension cannot work in a guild (no key, no base URL, a
   switch off), say so in `available` — the tool is then absent from the model's list *and* refused by the gate,
   which is better than a tool that always errors.
6. **Per-server is the default.** Read guild-scoped switches from `config.<something>(guildId)`; a deployment-wide
   constant is a decision only the owner can make, so it belongs behind a `.env` key and a config switch.

## Worked example: a `weather` extension

```ts
// src/services/extensions/weather.ts
import { config } from '@services/config.ts';
import { requireStr, str, type Extension, type ExtensionCapability } from './protocol.ts';

const endpoint = () => Bun.env.WEATHER_BASE_URL ?? '';

const tools: ExtensionCapability[] = [
  {
    'name': 'weather_now',
    'summary': 'Current weather',
    'description': 'Current conditions for one city, in metric units.',
    'risk': 'read',
    'params': [{ 'name': 'city', 'kind': 'string', 'description': 'city name', 'required': true }],
    'run': async (_ctx, args) => {
      const base = endpoint();
      if (!base) throw new Error('WEATHER_BASE_URL is not set');
      const response = await fetch(`${base}/now?city=${encodeURIComponent(requireStr(args, 'city'))}`, {
        'signal': AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`weather API answered ${response.status}`);
      const body = (await response.json()) as { temp_c?: number; summary?: string };
      return `${str(args, 'city')}: ${body.temp_c ?? '?'}°C, ${body.summary ?? 'no summary'}`;
    },
  },
];

export const weatherExtension: Extension = {
  'id': 'weather',
  'name': 'Weather',
  'description': 'Current conditions, one city at a time.',
  'available': () =>
    endpoint().length > 0 ? { 'ok': true, 'reason': '' } : { 'ok': false, 'reason': 'WEATHER_BASE_URL is not set' },
  'capabilities': tools,
};
```

Then in `registry.ts`:

```ts
export const EXTENSIONS: Extension[] = [discordExtension, shellExtension, gitExtension, pterodactylExtension, weatherExtension];
```

That is the whole change: `/settings` shows a `weather` toggle per server, `/config set features.extensions.disabled
weather` switches it off, `access.users.<id>.tools.deny: ["weather"]` limits one person, `/help` lists
`weather_now` under "read", and the policy gate charges it as `read` without any further wiring.

## Testing one

Follow `tests/extensions.test.ts`: assert the registry invariants (`setsOf`, `extensionOf`, availability per guild),
then drive `hardCheck` with `available: name => capabilityAvailability(guildId, name)` and
`renderDiscordToolFile(guildId)` to prove the tool appears for one server and not another. Extension code that only
reads/writes through `ctx.shell` needs no Docker in the test: pass a stub context whose `shell` returns a fixture
string.
