import { config, guildDefaults } from '@services/config.ts';
import { parseProfileValue } from '@services/policy/access.ts';
import { setSetting } from '@services/policy/dotted.ts';
import { PROFILE_KEYS, profilePath, type ProfileKey } from '@services/policy/profile.ts';

import { requireStr, show, str, type Extension, type ExtensionCapability } from './protocol.ts';

/**
 * Per-account permissions, for the agent. These are the same writes `/access` and the dashboard make — the
 * delegation rules live in the gate (`accessRule`), so "may this person arrange that person" is answered in one
 * place regardless of who asks: a slash command, the web page, or the model.
 */
const tools: ExtensionCapability[] = [
  {
    'name': 'access_show',
    'summary': 'Show who may do what here',
    'description':
      'The accounts blocked from this server, and every per-account profile (rank, risk ceiling, allowed/denied tools and commands).',
    'risk': 'read',
    'params': [{ 'name': 'user_id', 'kind': 'string', 'description': 'optional: one account instead of all' }],
    'run': async (ctx, args) => {
      const access = config.access(ctx.guild.id);
      const who = str(args, 'user_id');
      const describe = (id: string): string => {
        const profile = access.users[id];
        const lines = [`${id}${access.blocked.includes(id) ? '  blocked' : ''}`];
        if (!profile) return `${lines[0]}  (guild defaults)`;
        if (profile.rank) lines.push(`  rank: ${profile.rank}`);
        if (profile.risk) lines.push(`  max risk: ${profile.risk}`);
        if (profile.tools.allow.length > 0) lines.push(`  tools only: ${profile.tools.allow.join(', ')}`);
        if (profile.tools.deny.length > 0) lines.push(`  tools denied: ${profile.tools.deny.join(', ')}`);
        if (profile.commands.allow.length > 0) lines.push(`  commands only: ${profile.commands.allow.join(', ')}`);
        if (profile.commands.deny.length > 0) lines.push(`  commands denied: ${profile.commands.deny.join(', ')}`);
        return lines.join('\n');
      };
      if (who) return describe(who);
      const ids = [...new Set([...access.blocked, ...Object.keys(access.users)])];
      if (ids.length === 0) return 'no per-account permissions here: everyone gets their rank';
      return ids.map(describe).join('\n');
    },
  },
  {
    'name': 'access_set',
    'summary': 'Set one permission rule for one account',
    'description':
      'Set one per-account rule: rank, risk ceiling, allowed or denied tools, allowed or denied commands. Values are validated against the same tables the slash commands use.',
    'risk': 'admin',
    'params': [
      { 'name': 'user_id', 'kind': 'string', 'description': 'the account to configure', 'required': true },
      {
        'name': 'key',
        'kind': 'string',
        'description': 'which rule',
        'required': true,
        'choices': [...PROFILE_KEYS],
      },
      {
        'name': 'value',
        'kind': 'string',
        'description': 'rank/risk name, or a comma-separated list; "none" clears it',
        'required': true,
      },
    ],
    'run': async (ctx, args) => {
      const userId = requireStr(args, 'user_id');
      const key = PROFILE_KEYS.find(entry => entry === str(args, 'key'));
      if (!key) throw new Error(`key must be one of ${PROFILE_KEYS.join(', ')}`);
      const raw = requireStr(args, 'value');
      const cleared = raw.trim().toLowerCase() === 'none';
      const parsed = cleared ? undefined : await parseProfileValue(key as ProfileKey, raw);
      const next = setSetting(config.guild(ctx.guild.id) ?? guildDefaults(), profilePath(userId, key), parsed);
      config.patchGuild(ctx.guild.id, { ...next });
      return `${key} for ${userId} → ${cleared ? 'cleared (guild default)' : JSON.stringify(parsed)}`;
    },
  },
  {
    'name': 'access_block',
    'summary': 'Block or unblock an account',
    'description': 'Block an account from this server entirely, or let it back in. Unblocking keeps its profile.',
    'risk': 'admin',
    'params': [
      { 'name': 'user_id', 'kind': 'string', 'description': 'the account', 'required': true },
      { 'name': 'blocked', 'kind': 'boolean', 'description': 'true blocks, false unblocks', 'required': true },
    ],
    'run': async (ctx, args) => {
      const userId = requireStr(args, 'user_id');
      const blocked = args.blocked !== false;
      const current = config.guild(ctx.guild.id) ?? guildDefaults();
      const list = blocked
        ? [...new Set([...current.access.blocked, userId])]
        : current.access.blocked.filter(id => id !== userId);
      config.patchGuild(ctx.guild.id, { ...setSetting(current, 'access.blocked', list) });
      return `${show(userId)} is now ${blocked ? 'blocked' : 'allowed to use the bot'} here`;
    },
  },
];

export const accessExtension: Extension = {
  'id': 'access',
  'name': 'Per-account permissions',
  'description': 'Read and change who may use which tools in this server — the same profiles `/access` writes.',
  'capabilities': tools,
};
