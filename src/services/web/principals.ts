import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { paths } from '@services/config.ts';
import { WEB_ADMIN_EMAILS, WEB_OWNER_EMAILS } from '@utils/env.ts';
import { log } from '@utils/logger.ts';

import type { ClerkClaims } from './auth.ts';

const logger = log('web/principals');

/**
 * Who may do what on the dashboard. The bot owner is always in control; `admins` are people the owner handed the
 * same rights; `links` maps a Clerk identity to the Discord account it belongs to, which is how a Discord server
 * owner is recognised; `guilds` adds people per server without a Discord link.
 *
 * Credentials live in `.env`; this file only lists people, so it is safe to keep next to the guild config.
 */
export type WebConfig = {
  owners: string[];
  admins: string[];
  /** Clerk id or email → Discord user id. */
  links: Record<string, string>;
  /** Guild id → extra Clerk ids/emails that may manage that server. */
  guilds: Record<string, string[]>;
};

const split = (value: string | undefined): string[] =>
  (value ?? '')
    .split(/[\s,]+/)
    .map(entry => entry.trim().toLowerCase())
    .filter(entry => entry.length > 0);

export const webConfigPath = (): string => resolve(paths.config, 'web.json');

/**
 * `config/web.json` if it exists, plus the deployment's env lists. Env is additive rather than replacing so a
 * container can be granted access without editing a file that may be mounted read-only.
 */
export function loadWebConfig(): WebConfig {
  const file = webConfigPath();
  let parsed: Partial<WebConfig> = {};
  if (existsSync(file))
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<WebConfig>;
    } catch (error) {
      logger.warn('config/web.json is not valid json; ignoring it', { 'error': String(error).slice(0, 120) });
    }

  const normalise = (list: unknown): string[] =>
    Array.isArray(list)
      ? list.filter((entry): entry is string => typeof entry === 'string').map(entry => entry.toLowerCase())
      : [];
  const record = (value: unknown): Record<string, string[]> =>
    typeof value === 'object' && value !== null
      ? Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [
            key,
            typeof entry === 'string' ? [entry.toLowerCase()] : normalise(entry),
          ]),
        )
      : {};
  const links: Record<string, string> = {};
  if (typeof parsed.links === 'object' && parsed.links !== null)
    for (const [key, value] of Object.entries(parsed.links))
      if (typeof value === 'string' && value.length > 0) links[key.toLowerCase()] = value;

  return {
    'owners': [...new Set([...normalise(parsed.owners), ...split(WEB_OWNER_EMAILS)])],
    'admins': [...new Set([...normalise(parsed.admins), ...split(WEB_ADMIN_EMAILS)])],
    links,
    'guilds': record(parsed.guilds),
  };
}

export type Principal =
  | { kind: 'owner'; clerkId: string; email?: string }
  | { kind: 'admin'; clerkId: string; email?: string }
  | { kind: 'guild'; clerkId: string; email?: string; guilds: string[] }
  | { kind: 'nobody'; clerkId: string; email?: string };

/** Every way this identity can be named: Clerk's user id, and the email if the session carries one. */
export const identifiersOf = (claims: ClerkClaims): string[] =>
  [claims.sub, claims.email]
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    .map(id => id.toLowerCase());

export type ResolveInput = {
  config: WebConfig;
  /** Guilds this dashboard knows about, with their Discord owner id (unknown when the bot has not cached it). */
  guilds: Array<{ id: string; discordOwnerId?: string }>;
};

/**
 * Resolved once per request: owner and admins get everything, a Discord server owner gets their own server, and
 * everyone else gets nothing at all.
 */
export function resolvePrincipal(claims: ClerkClaims, input: ResolveInput): Principal {
  const ids = identifiersOf(claims);
  const base = { 'clerkId': claims.sub, ...(claims.email ? { 'email': claims.email } : {}) };

  if (input.config.owners.some(entry => ids.includes(entry))) return { 'kind': 'owner', ...base };
  if (input.config.admins.some(entry => ids.includes(entry))) return { 'kind': 'admin', ...base };

  const viaLink = new Set(
    input.guilds
      .filter(
        guild => guild.discordOwnerId !== undefined && ids.some(id => input.config.links[id] === guild.discordOwnerId),
      )
      .map(guild => guild.id),
  );
  const explicit = input.guilds
    .filter(guild => (input.config.guilds[guild.id] ?? []).some(entry => ids.includes(entry)))
    .map(guild => guild.id);
  const managed = [...new Set([...viaLink, ...explicit])];
  if (managed.length > 0) return { 'kind': 'guild', ...base, 'guilds': managed };

  return { 'kind': 'nobody', ...base };
}

/**
 * Settings that are not a guild's business: the machine, the models, the credentials, and the two keys that can
 * hand out capability (`enabled` approves a server; `policy.tools.allow` skips every approval card).
 */
export const BOT_WIDE_PREFIXES = ['shell.', 'model.', 'git.', 'pterodactyl.', 'roles.'];
export const BOT_WIDE_PATHS = ['enabled', 'policy.tools.allow'];

export const isBotWide = (path: string): boolean =>
  BOT_WIDE_PATHS.includes(path) || BOT_WIDE_PREFIXES.some(prefix => path.startsWith(prefix));

export type Verdict = { allowed: boolean; reason: string };

const DENY_NOBODY: Verdict = { 'allowed': false, 'reason': 'your account has no access to this dashboard' };

/** One setting, one guild, one principal. The `enabled` flag is Discord's `/enable`: approval by the owner. */
export function canEditSetting(
  principal: Principal,
  input: { guildId: string; path: string; guildEnabled: boolean },
): Verdict {
  if (principal.kind === 'owner') return { 'allowed': true, 'reason': 'bot owner' };
  if (principal.kind === 'admin') return { 'allowed': true, 'reason': 'granted full access' };
  if (principal.kind === 'nobody') return DENY_NOBODY;
  if (!principal.guilds.includes(input.guildId))
    return { 'allowed': false, 'reason': 'this account does not manage that server' };
  if (!input.guildEnabled) return { 'allowed': false, 'reason': 'this server is not approved (see /enable)' };
  if (isBotWide(input.path))
    return { 'allowed': false, 'reason': `${input.path} is bot-wide, so it needs the bot owner` };
  return { 'allowed': true, 'reason': 'server owner' };
}

/** Access profiles are per guild, so a server owner manages their own; blocked accounts are bot-wide-ish but
 * scoped to the guild they are blocked in, so the same rule applies. */
export const canManageAccess = (principal: Principal, guildId: string, guildEnabled: boolean): Verdict =>
  canEditSetting(principal, { guildId, 'path': 'access.blocked', guildEnabled });

/** Which guilds a principal may even see. */
export function visibleGuilds(principal: Principal, guildIds: readonly string[]): string[] {
  if (principal.kind === 'owner' || principal.kind === 'admin') return [...guildIds];
  if (principal.kind === 'nobody') return [];
  return guildIds.filter(id => principal.guilds.includes(id));
}
