import {
  RANK_NAMES,
  config,
  isOwner,
  type GuildFeatures,
  type GuildPolicy,
  type GuildPterodactyl,
  type UserAccess,
} from '@services/config.ts';
import { toolListed } from '@services/extensions/registry.ts';

import type { Capability, Risk } from '@services/extensions/protocol.ts';
import type { GuildMember } from 'discord.js';

export type Tier = 0 | 1 | 2 | 3 | 4;
export type Verdict = 'allow' | 'ask' | 'deny';

/**
 * deny > ask > allow. Every layer of the gate returns one verdict and the pipeline takes the strictest, so no
 * layer can loosen what another one refused: a Jev "reversible" cannot unlock a rank ceiling, and an agent
 * self-review cannot unlock Jev.
 */
const SEVERITY: Record<Verdict, number> = { 'allow': 0, 'ask': 1, 'deny': 2 };

export const strictest = <T extends { verdict: Verdict }>(candidates: readonly T[]): T | undefined =>
  candidates.reduce<T | undefined>(
    (worst, candidate) =>
      worst === undefined || SEVERITY[candidate.verdict] > SEVERITY[worst.verdict] ? candidate : worst,
    undefined,
  );

const RISK_ORDER: Risk[] = ['read', 'reversible', 'destructive', 'admin'];

/** Static ceiling table: what each rank may do without a human in the loop (layers 1–2 of PLAN.md §4). */
/** Exported so `/config show` can print the effective table instead of describing it in prose. */
export const CEILING: Record<Risk, Record<Tier, Verdict>> = {
  'read': { '0': 'allow', '1': 'allow', '2': 'allow', '3': 'allow', '4': 'allow' },
  'reversible': { '0': 'deny', '1': 'ask', '2': 'allow', '3': 'allow', '4': 'allow' },
  'destructive': { '0': 'deny', '1': 'deny', '2': 'ask', '3': 'allow', '4': 'allow' },
  'admin': { '0': 'deny', '1': 'deny', '2': 'deny', '3': 'ask', '4': 'allow' },
};

export const riskAtMost = (risk: Risk, max: GuildPolicy['vibe']['maxRisk']): boolean =>
  RISK_ORDER.indexOf(risk) <= RISK_ORDER.indexOf(max);

export function tierOf(guildId: string, member: GuildMember | null): Tier {
  if (!member) return 0;
  const guildConfig = config.guild(guildId);
  // A blocked account is a guest everywhere: `/config`, approvals and the ceiling all read through here.
  if (guildConfig?.access.blocked.includes(member.id)) return 0;
  // An owner-authored rank pin beats the role-derived rank, in both directions.
  const pinned = guildConfig?.access.users[member.id]?.rank;
  if (pinned) return RANK_NAMES.indexOf(pinned) as Tier;
  if (isOwner(member.id) || member.id === member.guild.ownerId) return 4;
  if (guildConfig?.roles.admin.some(id => member.roles.cache.has(id))) return 3;
  if (guildConfig?.roles.trusted.some(id => member.roles.cache.has(id))) return 2;
  return 1;
}

/**
 * The ceiling a policy applies to one rank and risk class. A guild may override any single cell in
 * `policy.matrix`, which is how "trusted may not delete" is expressed without touching the code table.
 */
export function ceilingFor(
  policy: GuildPolicy,
  tier: Tier,
  risk: Risk,
): { verdict: Verdict; source: 'matrix' | 'tier' } {
  const override = policy.matrix[RANK_NAMES[tier]]?.[risk];
  return override ? { 'verdict': override, 'source': 'matrix' } : { 'verdict': CEILING[risk][tier], 'source': 'tier' };
}

export type HardLayer = 'user' | 'tools' | 'pattern' | 'matrix' | 'tier' | 'mode';

export type HardDecision = { verdict: Verdict; layer: HardLayer; reason: string };

/** `rm` against a root, home or device path is the one command shape that has no safe reading. */
const rmHitsRoot = (command: string): boolean =>
  command.split(/[\n;]|&&|\|\|/).some(segment => {
    const words = segment
      .trim()
      .split(/\s+/)
      .filter(word => word.length > 0);
    const at = words[0] === 'sudo' ? 2 : 1;
    if (words[at - 1] !== 'rm') return false;
    return words
      .slice(at)
      .some(word =>
        ['/', '/*', '~', '~/*', '$HOME', '$HOME/*', '--no-preserve-root', '/etc', '/usr', '/var'].includes(word),
      );
  });

/**
 * Deterministic command shapes, checked before any model is consulted. Each entry is a fixed rule with a
 * stable id so `/audit` can say *why* a call was refused without referring to a model's opinion.
 */
const SHELL_RULES: ReadonlyArray<{ id: string; verdict: Verdict; why: string; hit: (command: string) => boolean }> = [
  { 'id': 'rm-root', 'verdict': 'deny', 'why': 'recursive delete of /, ~ or a system directory', 'hit': rmHitsRoot },
  { 'id': 'mkfs', 'verdict': 'deny', 'why': 'formats a filesystem', 'hit': c => /\bmkfs(\.[a-z0-9]+)?\b/i.test(c) },
  {
    'id': 'dd-device',
    'verdict': 'deny',
    'why': 'writes raw bytes to a block device',
    'hit': c => /\bdd\b[^\n]*\bof=\/dev\//.test(c),
  },
  {
    'id': 'power',
    'verdict': 'deny',
    'why': 'takes the machine down',
    'hit': c => /\b(shutdown|reboot|halt|poweroff)\b/.test(c),
  },
  { 'id': 'fork-bomb', 'verdict': 'deny', 'why': 'fork bomb', 'hit': c => /:\s*\(\s*\)\s*\{[^}]*\}\s*;\s*:/.test(c) },
  {
    'id': 'chmod-777-root',
    'verdict': 'deny',
    'why': 'makes / world-writable',
    'hit': c => /\bchmod\s+(-[a-zA-Z]+\s+)?777\s+\/(\s|$)/.test(c),
  },
  {
    'id': 'pipe-to-shell',
    'verdict': 'deny',
    'why': 'pipes a download straight into a shell',
    'hit': c => /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|k|da)?sh\b/.test(c),
  },
  {
    'id': 'drop-database',
    'verdict': 'deny',
    'why': 'drops database state',
    'hit': c => /\bdrop\s+(database|table|schema)\b/i.test(c),
  },
  {
    'id': 'force-push',
    'verdict': 'ask',
    'why': 'force push rewrites shared history',
    'hit': c => /\bgit\s+push\b[^\n]*(\s--force\b|\s-f\b)/.test(c),
  },
  {
    'id': 'truncate-table',
    'verdict': 'ask',
    'why': 'truncates table data',
    'hit': c => /\btruncate\s+table\b/i.test(c),
  },
  { 'id': 'wipe-disk', 'verdict': 'ask', 'why': 'erases disk contents', 'hit': c => /\b(wipefs|shred)\b/.test(c) },
];

const MODERATION_TOOLS = ['member_ban', 'member_kick', 'member_timeout', 'role_assign'];
const PERMISSION_TOOLS = ['permission_set', 'role_create', 'role_update'];

/** Fixed rule for one shell command string; also used for opencode's own `bash` permission patterns. */
export function shellRule(command: string): HardDecision | undefined {
  const text = command.trim();
  if (text.length === 0) return undefined;
  const hit = SHELL_RULES.find(rule => rule.hit(text));
  return hit ? { 'verdict': hit.verdict, 'layer': 'pattern', 'reason': `${hit.id}: ${hit.why}` } : undefined;
}

/** Client tools address a server by `identifier`; the admin pair addresses it by panel `id`. */
const PTERO_SERVER_TOOLS = [
  'ptero_server',
  'ptero_power',
  'ptero_command',
  'ptero_files',
  'ptero_file_read',
  'ptero_file_write',
  'ptero_admin_server',
  'ptero_admin_suspend',
];

/**
 * Panel allow-list rule. Whether the extension exists at all is the registry's answer (`available`), so this only
 * keeps "one server" meaning one server instead of "whatever the API key can reach".
 */
function pterodactylRule(
  capability: Capability,
  args: Record<string, unknown>,
  settings: { enabled: boolean; admin: boolean; files: boolean; servers: string[] } | undefined,
): HardDecision | undefined {
  if (!capability.name.startsWith('ptero_')) return undefined;
  if (!PTERO_SERVER_TOOLS.includes(capability.name)) return undefined;
  if (!settings) return undefined;
  const server = typeof args.server === 'string' ? args.server : typeof args.id === 'string' ? args.id : '';
  if (server.length === 0) return undefined;
  if (settings.servers.length === 0) return undefined;
  if (settings.servers.some(entry => entry.toLowerCase() === server.toLowerCase())) return undefined;
  return {
    'verdict': 'deny',
    'layer': 'pattern',
    'reason': `ptero-server: ${server} is not in this server's allow-list (${settings.servers.join(', ')})`,
  };
}

/**
 * Fixed rule for the arguments of one capability call. These are the mistakes a model makes *despite* being
 * told the rules — banning the person who asked, deleting the channel the request came from, granting
 * Administrator "to fix permissions" — so they are refused in code, not in prose.
 */
function argumentRule(
  input: HardInput,
  capability: Capability,
  args: Record<string, unknown>,
  protectedIds: readonly string[],
  pterodactyl: HardInput['pterodactyl'],
): HardDecision | undefined {
  // An extension the guild switched off, or never configured, is refused before its arguments matter.
  const availability = input.available?.(capability.name);
  if (availability && !availability.ok) return { 'verdict': 'deny', 'layer': 'tools', 'reason': availability.reason };

  const panel = pterodactylRule(capability, args, pterodactyl);
  if (panel) return panel;

  if (capability.name === 'bash') {
    const command = typeof args.command === 'string' ? args.command : '';
    return shellRule(command);
  }

  if (MODERATION_TOOLS.includes(capability.name)) {
    const target = typeof args.user_id === 'string' ? args.user_id : '';
    if (target.length > 0 && protectedIds.includes(target))
      return {
        'verdict': 'deny',
        'layer': 'pattern',
        'reason': 'protected-target: moderation against the server owner or the bot itself',
      };
  }

  if (PERMISSION_TOOLS.includes(capability.name)) {
    const granted = [args.permissions, args.allow].filter(Array.isArray).flat() as unknown[];
    if (granted.some(name => typeof name === 'string' && name.toLowerCase() === 'administrator'))
      return {
        'verdict': 'ask',
        'layer': 'pattern',
        'reason': 'administrator-grant: hands over the whole permission set, so a human signs it',
      };
  }

  return undefined;
}

export type HardInput = {
  tier: Tier;
  capability: Capability;
  args: Record<string, unknown>;
  policy: GuildPolicy;
  features: GuildFeatures;
  /** The account's own profile (`access.users.<id>`), and whether it is blocked outright. */
  account?: { blocked: boolean; profile?: UserAccess };
  /** The server owner and the bot's own user id: never valid moderation targets. */
  protectedIds?: readonly string[];
  /** This guild's panel switches, so a stale client cannot use a tool the guild has since switched off. */
  pterodactyl?: GuildPterodactyl;
  /**
   * Per-guild extension availability: switched off here, or not configured here. Answered by the registry, so a
   * disabled extension is refused in code and not merely absent from the model's tool list.
   */
  available?: (name: string) => { ok: boolean; reason: string };
};

/**
 * Layer 1: every check that needs no model and no network. Account rules, tool switches, explicit lists, fixed
 * argument rules, then the rank ceiling. This is what "hard" means here: the same inputs always give the same
 * verdict, and a per-account profile can only tighten what the guild allows.
 */
export function hardCheck(input: HardInput): HardDecision {
  const { capability, args, policy, features, tier } = input;

  // Account rules come first: a blocked account cannot reach anything, and a profile whitelist/deny list is
  // narrower than the guild's, so it is enforced before the owner's allow list can hand out a shortcut.
  if (input.account?.blocked)
    return { 'verdict': 'deny', 'layer': 'user', 'reason': 'user-blocked: this account may not use the bot here' };
  const profile = input.account?.profile;
  if (profile) {
    if (toolListed(capability.name, profile.tools.deny))
      return {
        'verdict': 'deny',
        'layer': 'user',
        'reason': `user-tools: this account may not use ${capability.name}`,
      };
    if (profile.tools.allow.length > 0 && !toolListed(capability.name, profile.tools.allow))
      return {
        'verdict': 'deny',
        'layer': 'user',
        'reason': `user-tools: this account is limited to ${profile.tools.allow.join(', ')}`,
      };
    if (profile.risk && RISK_ORDER.indexOf(capability.risk) > RISK_ORDER.indexOf(profile.risk))
      return {
        'verdict': 'deny',
        'layer': 'user',
        'reason': `user-risk: this account may only reach ${profile.risk} actions`,
      };
  }

  if (toolListed(capability.name, features.tools.disabled))
    return { 'verdict': 'deny', 'layer': 'tools', 'reason': `${capability.name} is switched off in this server` };
  if (policy.tools.deny.includes(capability.name))
    return { 'verdict': 'deny', 'layer': 'tools', 'reason': `${capability.name} is on this guild's deny list` };

  // Argument rules sit between the lists and the allow-list on purpose: an owner who allow-lists `bash` for
  // everyone did not thereby allow `rm -rf /`.
  const argument = argumentRule(input, capability, args, input.protectedIds ?? [], input.pterodactyl);
  if (argument) return argument;

  if (policy.tools.allow.includes(capability.name))
    return { 'verdict': 'allow', 'layer': 'tools', 'reason': `${capability.name} is on this guild's allow list` };

  if (policy.mode === 'locked')
    return capability.risk === 'read'
      ? { 'verdict': 'allow', 'layer': 'mode', 'reason': 'locked mode: reads are allowed' }
      : { 'verdict': 'deny', 'layer': 'mode', 'reason': `locked mode: ${capability.risk} does not run here` };

  const ceiling = ceilingFor(policy, tier, capability.risk);
  if (ceiling.verdict === 'deny')
    return {
      'verdict': 'deny',
      'layer': ceiling.source,
      'reason': `rank ${RANK_NAMES[tier]} may not run ${capability.risk} actions`,
    };
  if (capability.risk === 'read') return { 'verdict': 'allow', 'layer': 'tier', 'reason': 'read is always allowed' };

  return {
    'verdict': ceiling.verdict,
    'layer': ceiling.source,
    'reason': `rank ${RANK_NAMES[tier]} ceiling for ${capability.risk} is ${ceiling.verdict}`,
  };
}
