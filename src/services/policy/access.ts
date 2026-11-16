import { RANK_NAMES, RISK_NAMES, config } from '@services/config.ts';
import { capabilityNames, toolSetNames } from '@services/extensions/registry.ts';
import { MetadataStorage } from 'discordx';

import { type ProfileKey } from './profile.ts';

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

/**
 * The two fixed ranks, as a reusable check for every writer that is not the gate (the dashboard writes whole
 * access objects, so it cannot lean on `accessRule`). Returns the reason to refuse, or `undefined` to allow.
 *
 * `actor` is the bot owner's id when the caller is the bot owner, `undefined` otherwise.
 */
export function protectedAccessWrite(input: {
  guildOwnerId?: string;
  botOwnerId?: string;
  actorIsBotOwner: boolean;
  next: { blocked: string[]; users: Record<string, { rank?: string }> };
  current: { blocked: string[]; users: Record<string, { rank?: string }> };
}): string | undefined {
  if (input.actorIsBotOwner) return undefined;
  const protectedIds = [input.guildOwnerId, input.botOwnerId].filter((id): id is string => Boolean(id));
  for (const id of protectedIds) {
    if (input.next.blocked.includes(id))
      return `${id} is a fixed rank (${id === input.botOwnerId ? 'bot owner' : 'server owner'}); only the bot owner can block it`;
    const before = input.current.users[id];
    const after = input.next.users[id];
    if (JSON.stringify(before ?? null) !== JSON.stringify(after ?? null))
      return `${id} is a fixed rank (${id === input.botOwnerId ? 'bot owner' : 'server owner'}); only the bot owner can change it`;
  }
  for (const [id, profile] of Object.entries(input.next.users)) {
    if (profile?.rank !== 'owner') continue;
    if (input.current.users[id]?.rank === 'owner') continue;
    return `${id} cannot be pinned to \`owner\`: only the bot owner can grant that rank`;
  }
  for (const [id, profile] of Object.entries(input.current.users)) {
    if (profile?.rank !== 'owner') continue;
    if (input.next.users[id]?.rank === 'owner') continue;
    return `${id} is pinned to \`owner\`; only the bot owner can change it`;
  }
  return undefined;
}

/** Whether an account may talk to the agent at all (a mention or a reply starts a turn). */
export function promptAccess(guildId: string, userId: string): AccessCheck {
  const access = config.access(guildId);
  return access.blocked.includes(userId)
    ? { 'allowed': false, 'reason': 'this account is blocked on this server' }
    : { 'allowed': true, 'reason': 'not blocked' };
}

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
