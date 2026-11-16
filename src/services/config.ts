import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { BRIDGE_PORT, JEV_MODE, OPENCODE_BIN, OPENCODE_CLI, OWNER_ID, optionalEnv } from '@utils/env.ts';
import { z } from 'zod';

const root = resolve(import.meta.dirname, '../..');

export const paths = {
  root,
  'data': resolve(root, '.data'),
  'workspaces': resolve(root, '.data/workspaces'),
  'config': resolve(root, 'config'),
  'db': resolve(root, '.data/agent.db'),
  'token': resolve(root, '.data/console-token.json'),
};

export const RISK_NAMES = ['read', 'reversible', 'destructive', 'admin'] as const;
export const RANK_NAMES = ['guest', 'member', 'trusted', 'admin', 'owner'] as const;
export const VERDICTS = ['allow', 'ask', 'deny'] as const;
export const POLICY_MODES = ['ask', 'vibe', 'locked'] as const;
/** How eagerly the agent asks instead of acting on its own reading of a request. */
export const CLARIFY_LEVELS = ['off', 'normal', 'high', 'always'] as const;

const Verdict = z.enum(VERDICTS);
const RankName = z.enum(RANK_NAMES);

/** One rank's override of the built-in risk ceiling; omitted cells keep the table value. */
const RiskCell = z.object({
  'read': Verdict.optional(),
  'reversible': Verdict.optional(),
  'destructive': Verdict.optional(),
  'admin': Verdict.optional(),
});

const PolicySchema = z
  .object({
    /**
     * ask    — anything the ceiling does not allow outright becomes an approval card
     * vibe   — the same actions run unattended; Jev screens them and only stops what looks destructive
     * locked — nothing above `read` ever runs, whatever the rank says
     */
    'mode': z.enum(POLICY_MODES).default('ask'),
    'matrix': z.record(RankName, RiskCell).default({}),
    'tools': z
      .object({
        /** Run without an approval card for every rank. Safety-critical: owner-only. */
        'allow': z.array(z.string()).default([]),
        /** Never run, not even for the owner. */
        'deny': z.array(z.string()).default([]),
      })
      .default({}),
    'vibe': z
      .object({
        /** The riskiest class vibe mode will run unattended; anything above still asks. */
        'maxRisk': z.enum(['read', 'reversible', 'destructive']).default('destructive'),
        'screen': z.enum(['off', 'shadow', 'enforce']).default('enforce'),
        /**
         * Jev's "would an admin approve this" score has to reach this before vibe runs it. Calibrated against
         * real readings: a plain `message_send` scores ~0.66, a shell `rm` ~0.23, an out-of-repo edit ~0.08.
         */
        'minApproval': z.number().min(0).max(1).default(0.4),
        /** When Jev cannot be reached: `true` asks a human, `false` trusts the ceiling. */
        'askOnUncertain': z.boolean().default(true),
      })
      .default({}),
    /**
     * Layer 3: the guild's own primary agent reviews the call it is about to make. off = never ask it,
     * shadow = record what it would have said, enforce = it can tighten (never loosen) the verdict.
     */
    'review': z
      .object({
        'mode': z.enum(['off', 'shadow', 'enforce']).default('enforce'),
        /** A reviewer "allow" below this confidence is downgraded to "ask". */
        'minConfidence': z.number().min(0).max(1).default(0.5),
        /** Which role answers the review: the main agent (`primary`) or the cheap one (`fast`). */
        'model': z.enum(['primary', 'fast']).default('primary'),
      })
      .default({}),
  })
  .default({});

/**
 * Per-account permissions. `access.blocked` means the bot ignores the account everywhere (turns, commands,
 * approvals); a profile can only tighten what the guild already allows, except `rank`, which pins a tier
 * without a Discord role. Owner-authored, because pinning a rank grants capability.
 */
const UserAccessSchema = z
  .object({
    /** Pins the rank for this account instead of deriving it from roles. */
    'rank': z.enum(RANK_NAMES).optional(),
    /** Highest risk class this account may reach; `read` is "may look, may not change". */
    'risk': z.enum(RISK_NAMES).optional(),
    /** `allow` is a whitelist (empty = inherit), `deny` always wins. */
    'tools': z
      .object({ 'allow': z.array(z.string()).default([]), 'deny': z.array(z.string()).default([]) })
      .default({}),
    /** Slash commands this account may run; same rule as tools. */
    'commands': z
      .object({ 'allow': z.array(z.string()).default([]), 'deny': z.array(z.string()).default([]) })
      .default({}),
  })
  .default({});

const AccessSchema = z
  .object({
    'blocked': z.array(z.string()).default([]),
    'users': z.record(z.string(), UserAccessSchema).default({}),
  })
  .default({});

/**
 * Per-guild feature switches. Everything here is resolved at provisioning time: `tools.disabled` decides what
 * the model is even offered, `clarify` what the persona tells it to do. Narrowing only — no flag here grants a
 * capability, so a guild admin may own them.
 */
const FeatureSchema = z
  .object({
    'tools': z
      .object({
        /** Tool names and/or set names (`discord`, `channels`, `shell`, …); see `TOOL_SETS`. */
        'disabled': z.array(z.string()).default([]),
      })
      .default({}),
    /** Extensions (tool sets) switched off for this guild: `discord`, `shell`, `git`, `pterodactyl`, … */
    'extensions': z.object({ 'disabled': z.array(z.string()).default([]) }).default({}),
    /** off = act on the obvious reading; always = never act on an interpretation, ask first. */
    'clarify': z.enum(CLARIFY_LEVELS).default('normal'),
  })
  .default({});

/**
 * Optional hosted git server. The token is a per-server secret (dashboard → Secrets, sealed in the database),
 * falling back to `.env`; this only says whether the guild may use it and what it may do with it.
 */
const GitSchema = z
  .object({
    'enabled': z.boolean().default(false),
    'provider': z.enum(['gitea', 'forgejo', 'gitlab']).default('forgejo'),
    /** Scheme + host, e.g. `https://git.example.com`; empty falls back to `GIT_BASE_URL`. */
    'baseUrl': z.string().default(''),
    /** Group/user that owns repos this bot creates; empty falls back to `GIT_OWNER`. */
    'owner': z.string().default(''),
    /** Push after every commit (each turn, each artifact write). */
    'push': z.boolean().default(false),
    /** Let the agent create repositories on the server. */
    'createRepos': z.boolean().default(false),
    'visibility': z.enum(['private', 'public']).default('private'),
  })
  .default({});

/**
 * Optional Pterodactyl panel. The keys are per-server secrets (dashboard → Secrets, sealed in the database),
 * falling back to `.env` (`PTERO_CLIENT_KEY` / `PTERO_ADMIN_KEY`); this says whether the guild may use them,
 * which servers it may touch, and whether the file and admin tools exist at all.
 */
const PterodactylSchema = z
  .object({
    'enabled': z.boolean().default(false),
    /** Scheme + host, e.g. `https://panel.example.com`; empty falls back to `PTERO_BASE_URL`. */
    'baseUrl': z.string().default(''),
    /** Enable the application-API tools (needs `PTERO_ADMIN_KEY`). Off by default: it is the whole panel. */
    'admin': z.boolean().default(false),
    /** Enable the file tools. Off by default: a write is arbitrary content inside a running server. */
    'files': z.boolean().default(false),
    /** Allow-list of server identifiers/uuids (client) or ids (admin). Empty means everything the key can see. */
    'servers': z.array(z.string()).default([]),
  })
  .default({});

const GuildConfigSchema = z.object({
  'enabled': z.boolean().default(false),
  'shell': z
    .object({
      'mode': z.enum(['docker', 'host']).default('docker'),
      'image': z.string().default('debian:bookworm-slim'),
      'fallback': z.enum(['error', 'host']).default('error'),
    })
    .default({}),
  'roles': z
    .object({ 'admin': z.array(z.string()).default([]), 'trusted': z.array(z.string()).default([]) })
    .default({}),
  /** `/model set` writes here; unset roles fall back to the deployment defaults in MODELS. */
  'model': z.object({ 'primary': z.string().min(3).optional(), 'fast': z.string().min(3).optional() }).default({}),
  'policy': PolicySchema,
  'features': FeatureSchema,
  'access': AccessSchema,
  'git': GitSchema,
  'pterodactyl': PterodactylSchema,
});

export type GuildPolicy = z.infer<typeof PolicySchema>;
export type GuildFeatures = z.infer<typeof FeatureSchema>;
export type UserAccess = z.infer<typeof UserAccessSchema>;
export type GuildAccess = z.infer<typeof AccessSchema>;
export type GuildGit = z.infer<typeof GitSchema>;
export type GuildPterodactyl = z.infer<typeof PterodactylSchema>;

/** Every default in one object, so `/config reset` restores exactly what the schema says. */
export const guildDefaults = (): GuildSettings => GuildConfigSchema.parse({});
export type SettingMatrix = z.infer<typeof RiskCell>;

export type GuildSettings = z.infer<typeof GuildConfigSchema>;

const GuildsFile = z.record(z.string(), GuildConfigSchema);

/** `GUILDS_FILE` exists so a deployment (and the policy tests) can point at a different registry. */
export const guildsFilePath = () => optionalEnv('GUILDS_FILE') ?? `${paths.config}/guilds.json`;

function readGuilds(): z.infer<typeof GuildsFile> {
  const file = guildsFilePath();
  if (file.startsWith(paths.config)) mkdirSync(paths.config, { 'recursive': true });
  if (!existsSync(file)) {
    writeFileSync(file, '{}\n');
    return {};
  }
  const parsed = GuildsFile.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) throw new Error(`config/guilds.json invalid: ${parsed.error.message}`);
  return parsed.data;
}

/**
 * Role → `provider/model`. Every role is overridable from `.env`, and `/model set` overrides a role for one
 * guild. `MODEL_FAST` is used for reflection/consolidation so bulk text never touches the expensive model.
 *
 * The defaults: primary on the keyless free tier, fast on the OpenCode Go subscription, whose provider is
 * served from https://opencode.ai/inference/go — a different base URL from the free tier, which is what
 * "Free usage exceeded, subscribe to Go" means. Point these at any other provider (see
 * `config/providers.example.json`).
 */
export const MODELS = {
  'primary': optionalEnv('MODEL_PRIMARY') ?? 'opencode/mimo-v2.6-flash-free',
  'fast': optionalEnv('MODEL_FAST') ?? 'opencode-go/beam-free',
  /** Bare id: Jev is called directly, not through opencode, so it has no provider prefix. */
  'jev': optionalEnv('MODEL_JEV') ?? 'jev-1.13-free',
} as const;

/** Go is served separately from pay-as-you-go and the free tier; this is the endpoint the doctor probes. */
export const GO_CHAT_ENDPOINT = 'https://opencode.ai/inference/go/openai/v1/chat/completions';

export const config = {
  'bridge': { 'host': '127.0.0.1', 'port': BRIDGE_PORT },
  'opencode': {
    'host': '127.0.0.1',
    'binary': OPENCODE_BIN,
    'cli': OPENCODE_CLI,
    'version': '1.19.5',
    'portRange': [4100, 4300] as [number, number],
    'idleUnloadMs': 30 * 60_000,
    'startupTimeoutMs': 30_000,
  },
  'jevMode': JEV_MODE,
  'models': MODELS,
  'shellDefaults': { 'mode': 'docker' as const, 'image': 'debian:bookworm-slim', 'fallback': 'error' as const },
  /** Effective policy for a guild: schema defaults when the guild has never been touched. */
  'policy': (id: string): GuildPolicy => GuildConfigSchema.parse(readGuilds()[id] ?? {}).policy,
  /** Effective feature switches, resolved the same way so a missing key is never a crash. */
  'features': (id: string): GuildFeatures => GuildConfigSchema.parse(readGuilds()[id] ?? {}).features,
  /** Per-account permissions for a guild, defaults included. */
  'access': (id: string): GuildAccess => GuildConfigSchema.parse(readGuilds()[id] ?? {}).access,
  /** Git server switches (credentials come from `.env`, never from this file). */
  'git': (id: string): GuildGit => GuildConfigSchema.parse(readGuilds()[id] ?? {}).git,
  /** Panel switches for this guild (keys again from `.env`). */
  'pterodactyl': (id: string): GuildPterodactyl => GuildConfigSchema.parse(readGuilds()[id] ?? {}).pterodactyl,
  paths,
  'raw': () => readGuilds(),
  'guild': (id: string): GuildSettings | undefined => readGuilds()[id],
  'setGuild': (id: string, value: unknown): void => {
    const all = readGuilds();
    all[id] = GuildConfigSchema.parse(value);
    writeFileSync(guildsFilePath(), `${JSON.stringify(all, null, 2)}\n`);
  },
  /** Partial update that keeps the other guild keys, so `/model set` cannot drop `/enable`'s settings. */
  'patchGuild': (id: string, patch: Record<string, unknown>): GuildSettings => {
    const all = readGuilds();
    const next = GuildConfigSchema.parse({ ...(all[id] ?? {}), ...patch });
    all[id] = next;
    writeFileSync(guildsFilePath(), `${JSON.stringify(all, null, 2)}\n`);
    return next;
  },
};

mkdirSync(paths.data, { 'recursive': true });
mkdirSync(paths.workspaces, { 'recursive': true });
export const isOwner = (userId: string) => userId === OWNER_ID;
