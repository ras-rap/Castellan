import { modelRef } from '@services/agent/models.ts';
import {
  CLARIFY_LEVELS,
  RISK_NAMES,
  RANK_NAMES,
  POLICY_MODES,
  VERDICTS,
  guildDefaults,
  isOwner,
  type GuildSettings,
} from '@services/config.ts';
import { EXTENSIONS, TOOL_SETS, capabilityNames, toolSetNames } from '@services/extensions/registry.ts';

import { readSetting } from './dotted.ts';

/**
 * Who may change a setting. `admin` means a guild admin (tier 3, or the bot owner); `owner` means the bot
 * owner alone — anything that widens what the agent may do to the machine or the server lives there, so a
 * guild admin cannot turn the sandbox off or hand themselves a capability.
 */
export type SettingScope = 'owner' | 'admin';

export type Setting = {
  path: string;
  scope: SettingScope;
  description: string;
  /** Parses the raw slash-command string; throws an `Error` with a message fit to show in Discord. */
  parse: (raw: string) => unknown;
};

const TOOL_NAMES = capabilityNames;

const nonEmpty = (value: string, what: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${what} cannot be empty`);
  return trimmed;
};

const boolean = (raw: string): boolean => {
  const value = raw.trim().toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(value)) return true;
  if (['false', 'no', 'off', '0'].includes(value)) return false;
  throw new Error(`expected true or false, got "${raw}"`);
};

const snowflakes = (raw: string): string[] => {
  const ids = raw
    .split(/[\s,]+/)
    .map(id => id.trim())
    .filter(id => id.length > 0);
  const bad = ids.find(id => !/^\d{16,20}$/.test(id));
  if (bad) throw new Error(`"${bad}" is not a Discord id`);
  return ids;
};

const toolNames = (raw: string): string[] => {
  const names = raw
    .split(/[\s,]+/)
    .map(name => name.trim())
    .filter(name => name.length > 0);
  const unknown = names.find(name => !TOOL_NAMES.includes(name));
  if (unknown) throw new Error(`"${unknown}" is not one of the ${TOOL_NAMES.length} tools`);
  return names;
};

/** Extensions are switched off by id, so a typo fails at `/config set` instead of silently doing nothing. */
const extensionNames = (raw: string): string[] => {
  const ids = raw
    .split(/[\s,]+/)
    .map(entry => entry.trim().toLowerCase())
    .filter(entry => entry.length > 0);
  const known = EXTENSIONS.map(extension => extension.id);
  const unknown = ids.find(id => !known.includes(id));
  if (unknown) throw new Error(`"${unknown}" is not an extension; extensions are ${known.join(', ')}`);
  return ids;
};

/** `features.tools.disabled` accepts one tool, one set, or a mix — "discord" is the whole Discord surface. */
const toolOrSets = (raw: string): string[] => {
  const names = raw
    .split(/[\s,]+/)
    .map(name => name.trim())
    .filter(name => name.length > 0);
  const known = toolSetNames();
  const unknown = names.find(name => !known.includes(name));
  if (unknown) throw new Error(`"${unknown}" is not a tool; sets are ${TOOL_SETS.join(', ')}`);
  return names;
};

const oneOf =
  <T extends string>(allowed: readonly T[], what: string) =>
  (raw: string): T => {
    const value = raw.trim().toLowerCase() as T;
    if (!allowed.includes(value)) throw new Error(`${what} must be one of ${allowed.join(', ')}`);
    return value;
  };

/** Rank × risk overrides are generated so `/config set` can address any single cell of the table. */
const matrixSettings: Setting[] = RANK_NAMES.flatMap(rank =>
  RISK_NAMES.map(risk => ({
    'path': `policy.matrix.${rank}.${risk}`,
    'scope': 'owner' as const,
    'description': `what a ${rank} may do with ${risk} actions`,
    'parse': oneOf(VERDICTS, 'verdict'),
  })),
);

export const SETTINGS: Setting[] = [
  {
    'path': 'enabled',
    'scope': 'owner',
    'description': 'whether the agent answers in this server at all',
    'parse': boolean,
  },
  {
    'path': 'policy.mode',
    'scope': 'admin',
    'description': 'ask = approval cards, vibe = run unattended with a Jev veto, locked = read only',
    'parse': oneOf(POLICY_MODES, 'mode'),
  },
  {
    'path': 'policy.vibe.maxRisk',
    'scope': 'admin',
    'description': 'riskiest class vibe mode runs unattended',
    'parse': oneOf(['read', 'reversible', 'destructive'] as const, 'maxRisk'),
  },
  {
    'path': 'policy.vibe.screen',
    'scope': 'admin',
    'description': 'Jev screening in vibe mode: off, shadow (log only) or enforce',
    'parse': oneOf(['off', 'shadow', 'enforce'] as const, 'screen'),
  },
  {
    'path': 'policy.vibe.minApproval',
    'scope': 'admin',
    'description': 'Jev approval score (0-1) a call must reach in vibe mode; below it the call is refused',
    'parse': raw => {
      const value = Number(raw.trim());
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('minApproval must be a number 0-1');
      return value;
    },
  },
  {
    'path': 'policy.vibe.askOnUncertain',
    'scope': 'admin',
    'description': 'ask a human when Jev cannot be reached or is unsure',
    'parse': boolean,
  },
  {
    'path': 'policy.review.mode',
    'scope': 'admin',
    'description': "the agent's own review of each call: off, shadow (log only) or enforce (can block)",
    'parse': oneOf(['off', 'shadow', 'enforce'] as const, 'review mode'),
  },
  {
    'path': 'policy.review.minConfidence',
    'scope': 'admin',
    'description': 'how sure the review must be to let a call run without a human (0-1)',
    'parse': raw => {
      const value = Number(raw.trim());
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('minConfidence must be a number 0-1');
      return value;
    },
  },
  {
    'path': 'policy.review.model',
    'scope': 'admin',
    'description': 'which model answers the review: primary (the agent itself) or fast',
    'parse': oneOf(['primary', 'fast'] as const, 'review model'),
  },
  {
    'path': 'policy.tools.deny',
    'scope': 'admin',
    'description': 'comma-separated tools nobody may run here',
    'parse': toolNames,
  },
  {
    'path': 'policy.tools.allow',
    'scope': 'owner',
    'description': 'comma-separated tools that skip the approval card for everyone',
    'parse': toolNames,
  },
  {
    'path': 'features.tools.disabled',
    'scope': 'admin',
    'description': 'tools or whole sets switched off here — not even offered to the model',
    'parse': toolOrSets,
  },
  {
    'path': 'features.extensions.disabled',
    'scope': 'admin',
    'description': 'extensions switched off here — the whole tool set goes with them',
    'parse': extensionNames,
  },
  {
    'path': 'features.clarify',
    'scope': 'admin',
    'description': 'how eagerly the agent asks before acting: off, normal, high, always',
    'parse': oneOf(CLARIFY_LEVELS, 'clarify'),
  },
  ...matrixSettings,
  {
    'path': 'shell.mode',
    'scope': 'owner',
    'description': 'sandbox for shell calls: docker (isolated) or host (runs as the bot user)',
    'parse': oneOf(['docker', 'host'] as const, 'shell mode'),
  },
  {
    'path': 'shell.image',
    'scope': 'owner',
    'description': 'container image used for the shell sandbox',
    'parse': raw => nonEmpty(raw, 'image'),
  },
  {
    'path': 'shell.fallback',
    'scope': 'owner',
    'description': 'what to do when docker is missing: error (refuse) or host (run anyway)',
    'parse': oneOf(['error', 'host'] as const, 'fallback'),
  },
  {
    'path': 'git.enabled',
    'scope': 'owner',
    'description': 'use the git server in .env (GIT_TOKEN) for pushes and repository creation',
    'parse': boolean,
  },
  {
    'path': 'git.provider',
    'scope': 'owner',
    'description': 'which API the server speaks: gitea, forgejo or gitlab',
    'parse': oneOf(['gitea', 'forgejo', 'gitlab'] as const, 'provider'),
  },
  {
    'path': 'git.baseUrl',
    'scope': 'owner',
    'description': 'scheme and host of the git server, e.g. https://git.example.com (empty = GIT_BASE_URL)',
    'parse': raw => {
      const value = raw.trim();
      if (value.length === 0) return '';
      try {
        const url = new URL(value);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('scheme');
        return value.replace(/\/+$/, '');
      } catch {
        throw new Error(`"${raw}" is not an http(s) URL`);
      }
    },
  },
  {
    'path': 'git.owner',
    'scope': 'owner',
    'description': 'group/user that owns repos this bot creates (empty = GIT_OWNER)',
    'parse': raw => raw.trim(),
  },
  {
    'path': 'git.push',
    'scope': 'owner',
    'description': 'push after every commit: each turn and each artifact write',
    'parse': boolean,
  },
  {
    'path': 'git.createRepos',
    'scope': 'owner',
    'description': 'let the agent create repositories on the git server',
    'parse': boolean,
  },
  {
    'path': 'git.visibility',
    'scope': 'owner',
    'description': 'visibility of repositories the agent creates: private or public',
    'parse': oneOf(['private', 'public'] as const, 'visibility'),
  },
  {
    'path': 'pterodactyl.enabled',
    'scope': 'owner',
    'description': 'use the panel in .env (PTERO_CLIENT_KEY) for server tools',
    'parse': boolean,
  },
  {
    'path': 'pterodactyl.baseUrl',
    'scope': 'owner',
    'description': 'scheme and host of the panel, e.g. https://panel.example.com (empty = PTERO_BASE_URL)',
    'parse': raw => {
      const value = raw.trim();
      if (value.length === 0) return '';
      try {
        const url = new URL(value);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('scheme');
        return value.replace(/\/+$/, '');
      } catch {
        throw new Error(`"${raw}" is not an http(s) URL`);
      }
    },
  },
  {
    'path': 'pterodactyl.admin',
    'scope': 'owner',
    'description': 'enable the application-API tools (needs PTERO_ADMIN_KEY): the whole panel',
    'parse': boolean,
  },
  {
    'path': 'pterodactyl.files',
    'scope': 'owner',
    'description': 'enable the panel file tools: read and OVERWRITE files inside a server',
    'parse': boolean,
  },
  {
    'path': 'pterodactyl.servers',
    'scope': 'owner',
    'description': 'comma-separated allow-list of server identifiers/ids (empty = every server the key sees)',
    'parse': raw => {
      const names = raw
        .split(/[\s,]+/)
        .map(entry => entry.trim())
        .filter(entry => entry.length > 0 && entry.toLowerCase() !== 'none');
      const bad = names.find(name => !/^[A-Za-z0-9-]{1,64}$/.test(name));
      if (bad) throw new Error(`"${bad}" is not a server identifier`);
      return names;
    },
  },
  {
    'path': 'roles.admin',
    'scope': 'owner',
    'description': 'comma-separated role ids treated as admins',
    'parse': snowflakes,
  },
  {
    'path': 'roles.trusted',
    'scope': 'owner',
    'description': 'comma-separated role ids treated as trusted',
    'parse': snowflakes,
  },
  {
    'path': 'access.blocked',
    'scope': 'owner',
    'description': 'comma-separated user ids that may not use the bot here at all',
    'parse': snowflakes,
  },
  {
    'path': 'model.primary',
    'scope': 'admin',
    'description': 'provider/model for chat, code and tool use',
    'parse': raw => {
      modelRef(nonEmpty(raw, 'model'));
      return raw.trim();
    },
  },
  {
    'path': 'model.fast',
    'scope': 'admin',
    'description': 'provider/model for reflection and memory',
    'parse': raw => {
      modelRef(nonEmpty(raw, 'model'));
      return raw.trim();
    },
  },
];

export const settingByPath = (path: string): Setting | undefined => SETTINGS.find(setting => setting.path === path);

/** What `/config reset` writes: the schema default for that exact path. */
export function defaultFor(path: string): unknown {
  return readSetting(guildDefaults(), path);
}

/** Parses a raw value against the registry entry, so `/config set` fails before anything is written. */
export function parseSetting(path: string, raw: string): unknown {
  const setting = settingByPath(path);
  if (!setting) throw new Error(`unknown setting "${path}"`);
  return setting.parse(raw);
}

/** Human-readable current value, used by `/config show` and the confirmations. */
export function describeSetting(settings: GuildSettings, path: string): string {
  const value = readSetting(settings, path);
  if (value === undefined) return 'unset';
  if (Array.isArray(value)) return value.length === 0 ? 'empty' : value.join(', ');
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value);
}

/** Who may write a setting: admins for the narrowing keys, the bot owner for everything that grants. */
export const writableBy = (setting: Setting, userId: string): boolean => setting.scope === 'admin' || isOwner(userId);

/**
 * How a value is chosen, which is what makes the `/settings` panel possible: booleans become two buttons, known
 * value sets become a select menu, everything else a modal. `parse` stays the only validator — the panel never
 * invents a value the slash command would refuse, and a test asserts every listed choice parses.
 */
export type ValueDomain = {
  /** `multi` is a set of choices (checkboxes / a multi-select), stored as a comma-separated list. */
  kind: 'boolean' | 'choice' | 'multi' | 'text' | 'list' | 'number';
  choices?: readonly string[];
  /** Shown in the modal for free-text entry: what the value should look like. */
  placeholder?: string;
};

const MATRIX_DOMAIN: ValueDomain = { 'kind': 'choice', 'choices': VERDICTS };

export const VALUE_DOMAINS: Record<string, ValueDomain> = {
  'enabled': { 'kind': 'boolean' },
  'policy.mode': { 'kind': 'choice', 'choices': POLICY_MODES },
  'policy.vibe.maxRisk': { 'kind': 'choice', 'choices': ['read', 'reversible', 'destructive'] },
  'policy.vibe.screen': { 'kind': 'choice', 'choices': ['off', 'shadow', 'enforce'] },
  'policy.vibe.minApproval': { 'kind': 'number', 'placeholder': '0 - 1, e.g. 0.4' },
  'policy.vibe.askOnUncertain': { 'kind': 'boolean' },
  'policy.review.mode': { 'kind': 'choice', 'choices': ['off', 'shadow', 'enforce'] },
  'policy.review.minConfidence': { 'kind': 'number', 'placeholder': '0 - 1, e.g. 0.5' },
  'policy.review.model': { 'kind': 'choice', 'choices': ['primary', 'fast'] },
  'policy.tools.deny': { 'kind': 'list', 'placeholder': 'tool names, comma separated' },
  'policy.tools.allow': { 'kind': 'list', 'placeholder': 'tool names, comma separated' },
  'features.tools.disabled': { 'kind': 'list', 'placeholder': 'tools or sets, e.g. channels, shell, git' },
  'features.extensions.disabled': { 'kind': 'multi', 'choices': EXTENSIONS.map(extension => extension.id) },
  'features.clarify': { 'kind': 'choice', 'choices': CLARIFY_LEVELS },
  'shell.mode': { 'kind': 'choice', 'choices': ['docker', 'host'] },
  'shell.image': { 'kind': 'text', 'placeholder': 'debian:bookworm-slim' },
  'shell.fallback': { 'kind': 'choice', 'choices': ['error', 'host'] },
  'git.enabled': { 'kind': 'boolean' },
  'git.provider': { 'kind': 'choice', 'choices': ['forgejo', 'gitea', 'gitlab'] },
  'git.baseUrl': { 'kind': 'text', 'placeholder': 'https://git.example.com' },
  'git.owner': { 'kind': 'text', 'placeholder': 'group or user that owns new repos' },
  'git.push': { 'kind': 'boolean' },
  'git.createRepos': { 'kind': 'boolean' },
  'git.visibility': { 'kind': 'choice', 'choices': ['private', 'public'] },
  'pterodactyl.enabled': { 'kind': 'boolean' },
  'pterodactyl.baseUrl': { 'kind': 'text', 'placeholder': 'https://panel.example.com' },
  'pterodactyl.admin': { 'kind': 'boolean' },
  'pterodactyl.files': { 'kind': 'boolean' },
  'pterodactyl.servers': { 'kind': 'list', 'placeholder': 'server identifiers, comma separated' },
  'roles.admin': { 'kind': 'list', 'placeholder': 'role ids, comma separated' },
  'roles.trusted': { 'kind': 'list', 'placeholder': 'role ids, comma separated' },
  'access.blocked': { 'kind': 'list', 'placeholder': 'user ids, comma separated' },
  'model.primary': { 'kind': 'text', 'placeholder': 'provider/model' },
  'model.fast': { 'kind': 'text', 'placeholder': 'provider/model' },
  ...Object.fromEntries(
    RANK_NAMES.flatMap(rank => RISK_NAMES.map(risk => [`policy.matrix.${rank}.${risk}`, MATRIX_DOMAIN])),
  ),
};

export const domainOf = (path: string): ValueDomain | undefined => VALUE_DOMAINS[path];

/** The first segment of a path is its panel category (`policy`, `features`, `git`, …). */
export const categoryOf = (path: string): string => path.split('.')[0] ?? path;

/** Settings a person may change, grouped by category, in registry order. */
export function settingsByCategory(userId: string): Map<string, Setting[]> {
  const grouped = new Map<string, Setting[]>();
  for (const setting of SETTINGS) {
    if (!writableBy(setting, userId)) continue;
    const category = categoryOf(setting.path);
    const bucket = grouped.get(category) ?? [];
    bucket.push(setting);
    grouped.set(category, bucket);
  }
  return grouped;
}
