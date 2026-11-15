import { capabilityNames, toolSetNames } from '@services/bridge/capabilities.ts';
import { RANK_NAMES, RISK_NAMES, config } from '@services/config.ts';
import { MetadataStorage } from 'discordx';

export type AccessCheck = { allowed: boolean; reason: string };

/**
 * Slash commands this process registered. `MetadataStorage.instance.build()` is what applies `@SlashGroup`, and
 * it is idempotent — the CLI deploy path calls it too. It must never run at module scope (see
 * `cli/commands/registry.ts`): building before `events/` is imported silently unbinds every `@On` handler.
 */
export async function knownCommands(): Promise<string[]> {
  await MetadataStorage.instance.build();
  return [...new Set(MetadataStorage.instance.applicationCommands.map(command => command.name))].sort();
}

/** `/config set` addresses the group (`config`), `/config set` also matches `config:set`. */
export const commandCandidates = (commandName: string, subcommand: string | null): string[] =>
  subcommand ? [commandName, `${commandName}:${subcommand}`] : [commandName];

const listed = (value: string[]): boolean => value.some(entry => entry.length > 0);

/**
 * Whether an account may run a slash command. Blocked wins over everything; a `commands.allow` list is a
 * whitelist for that account, and `commands.deny` takes precedence over it. An unknown name simply never
 * matches, which is why `/access set` validates against the registered command list first.
 */
export function commandAccess(guildId: string, userId: string, names: string[]): AccessCheck {
  const access = config.access(guildId);
  if (access.blocked.includes(userId))
    return { 'allowed': false, 'reason': '🚫 this account is blocked on this server' };

  const profile = access.users[userId];
  if (!profile) return { 'allowed': true, 'reason': 'no account profile' };

  const denied = names.find(name => profile.commands.deny.includes(name));
  if (denied) return { 'allowed': false, 'reason': `🚫 \`/${denied}\` is not enabled for your account` };

  if (listed(profile.commands.allow) && !names.some(name => profile.commands.allow.includes(name)))
    return {
      'allowed': false,
      'reason': `🔒 your account is limited to ${profile.commands.allow.map(name => `\`/${name}\``).join(', ')}`,
    };
  return { 'allowed': true, 'reason': 'not restricted' };
}

/** Whether an account may talk to the agent at all (a mention or a reply starts a turn). */
export function promptAccess(guildId: string, userId: string): AccessCheck {
  const access = config.access(guildId);
  return access.blocked.includes(userId)
    ? { 'allowed': false, 'reason': 'this account is blocked on this server' }
    : { 'allowed': true, 'reason': 'not blocked' };
}

export type ProfileKey = 'rank' | 'risk' | 'tools-allow' | 'tools-deny' | 'commands-allow' | 'commands-deny';

export const PROFILE_KEYS: ProfileKey[] = [
  'rank',
  'risk',
  'tools-allow',
  'tools-deny',
  'commands-allow',
  'commands-deny',
];

/** Where a key lives in the guild document, so `/access set` and `/config` share one shape. */
export const profilePath = (userId: string, key: ProfileKey): string => {
  const base = `access.users.${userId}`;
  switch (key) {
    case 'rank':
      return `${base}.rank`;
    case 'risk':
      return `${base}.risk`;
    case 'tools-allow':
      return `${base}.tools.allow`;
    case 'tools-deny':
      return `${base}.tools.deny`;
    case 'commands-allow':
      return `${base}.commands.allow`;
    case 'commands-deny':
      return `${base}.commands.deny`;
  }
};

const split = (raw: string): string[] =>
  raw
    .split(/[\s,]+/)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0 && entry.toLowerCase() !== 'none');

const oneOf = <T extends string>(allowed: readonly T[], what: string, raw: string): T => {
  const value = raw.trim().toLowerCase() as T;
  if (!allowed.includes(value)) throw new Error(`${what} must be one of ${allowed.join(', ')}`);
  return value;
};

const toolList = (raw: string): string[] => {
  const names = split(raw);
  const known = toolSetNames();
  const bad = names.find(name => !known.includes(name));
  if (bad) throw new Error(`"${bad}" is not a tool or set; tools are ${capabilityNames.join(', ')}`);
  return names;
};

/**
 * Parses the value for one profile key, validating against the same tables the gate uses. Commands are checked
 * against the registered list, so a typo in a deny list fails loudly instead of silently leaving access on.
 */
export async function parseProfileValue(key: ProfileKey, raw: string): Promise<unknown> {
  switch (key) {
    case 'rank':
      return oneOf(RANK_NAMES, 'rank', raw);
    case 'risk':
      return oneOf(RISK_NAMES, 'risk', raw);
    case 'tools-allow':
    case 'tools-deny':
      return toolList(raw);
    case 'commands-allow':
    case 'commands-deny': {
      const names = split(raw);
      const known = await knownCommands();
      const bad = names.find(name => !known.some(command => command === name || name.startsWith(`${command}:`)));
      if (bad) throw new Error(`"${bad}" is not a registered command; commands are ${known.join(', ')}`);
      return names;
    }
  }
}
