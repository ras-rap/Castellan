import { config } from '@services/config.ts';
import { createRepo } from '@services/git/forge.ts';
import { attachOrigin, commitNow, describeWorkspace, pushWorkspace } from '@services/git/workspace.ts';
import {
  POWER_SIGNALS,
  attributesOf,
  commandRequest,
  describeServerLine,
  keyFor,
  listAttributes,
  powerRequest,
  pteroRequest,
  resolvePtero,
  safePath,
  serverAllowed,
  writeRequest,
  type PteroTarget,
} from '@services/pterodactyl/api.ts';
import { runShell } from '@services/workspace/shell.ts';
import {
  ChannelType,
  PermissionFlagsBits,
  TextChannel as TextChannelClass,
  type Client,
  type ColorResolvable,
  type Guild,
  type GuildMember,
  type TextChannel,
} from 'discord.js';

type PermissionName = keyof typeof PermissionFlagsBits;

export type Risk = 'read' | 'reversible' | 'destructive' | 'admin';

export type ParamKind = 'string' | 'number' | 'boolean' | 'string[]';

export type ParamSpec = {
  name: string;
  kind: ParamKind;
  description: string;
  required?: boolean;
  choices?: string[];
};

export type CapabilityContext = {
  client: Client;
  guild: Guild;
  actorId: string;
  channelId?: string;
};

export type Capability = {
  name: string;
  summary: string;
  description: string;
  risk: Risk;
  params: ParamSpec[];
  run: (ctx: CapabilityContext, args: Record<string, unknown>) => Promise<string>;
};

const str = (args: Record<string, unknown>, key: string): string | undefined => {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const num = (args: Record<string, unknown>, key: string): number | undefined => {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

const strArray = (args: Record<string, unknown>, key: string): string[] => {
  const value = args[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
};

/** Permission names are validated against discord.js's flag table, so a typo fails the call instead of no-oping. */
const permissionNames = (names: string[]): PermissionName[] =>
  names.map(name => {
    if (!(name in PermissionFlagsBits))
      throw new Error(
        `unknown permission "${name}"; expected a name like ViewChannel, SendMessages, ManageMessages, Administrator`,
      );

    return name as PermissionName;
  });

const overwritePayload = (allow: string[], deny: string[]): Partial<Record<PermissionName, boolean>> => {
  const payload: Partial<Record<PermissionName, boolean>> = {};
  for (const name of permissionNames(allow)) payload[name] = true;
  for (const name of permissionNames(deny)) payload[name] = false;
  return payload;
};

/** Colours arrive from the model as text; only #rrggbb is accepted so Discord never gets a bogus value. */
const hexColor = (value: string): ColorResolvable => {
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`"${value}" is not a hex colour like #ff8800`);
  return value as ColorResolvable;
};

const requireStr = (args: Record<string, unknown>, key: string): string => {
  const value = str(args, key);
  if (!value) throw new Error(`missing required argument: ${key}`);
  return value;
};

/** Renders one panel field: anything that is not a printable scalar is `?` rather than `[object Object]`. */
const show = (value: unknown, fallback = '?'): string =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : fallback;

/** Nested panel payloads (`attributes.user`, `attributes.resources`) are objects or nothing. */
const nested = (record: Record<string, unknown>, key: string): Record<string, unknown> => {
  const value = record[key];
  if (typeof value !== 'object' || value === null) return {};
  // `typeof` proves an object; `Object.entries` is the cheapest way to keep the copy shallow-but-honest.
  return Object.fromEntries(Object.entries(value));
};

const bytes = (value: unknown): string =>
  typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value / 1_048_576)}MB` : '?';

const minutes = (value: unknown): string =>
  typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value / 60_000)}m` : '?';

const pick = <T extends string>(allowed: readonly T[], raw: string, what: string): T => {
  const value = raw.trim().toLowerCase();
  const match = allowed.find(entry => entry === value);
  if (!match) throw new Error(`${what} must be one of ${allowed.join(', ')}`);
  return match;
};

const requirePtero = (guildId: string): PteroTarget => {
  const target = resolvePtero(guildId);
  if (!target?.clientKey)
    throw new Error('no pterodactyl panel here (pterodactyl.enabled + PTERO_CLIENT_KEY + PTERO_BASE_URL)');
  return target;
};

const requirePteroFiles = (guildId: string): PteroTarget => {
  const target = requirePtero(guildId);
  if (!target.files) throw new Error('the panel file tools are switched off here (pterodactyl.files)');
  return target;
};

const requirePteroAdmin = (guildId: string): PteroTarget => {
  const target = resolvePtero(guildId);
  if (!target?.admin || !target.adminKey)
    throw new Error('the panel admin tools are not enabled here (pterodactyl.admin + PTERO_ADMIN_KEY)');
  return target;
};

/** The guild's `pterodactyl.servers` allow-list, enforced before any request leaves the bot. */
const requirePteroServer = (target: PteroTarget, server: string): string => {
  if (!serverAllowed(target, server)) throw new Error(`${server} is not in this server's pterodactyl allow-list`);
  return server;
};

/**
 * Discord audits happen in Discord itself; this wrapper just makes the id/name formatting consistent
 * across capabilities so tool output stays skimmable inside a Discord message.
 */
const describeGuild = (guild: Guild) =>
  [
    `guild: ${guild.name} (${guild.id})`,
    `members: ${guild.memberCount}`,
    `owner: ${guild.ownerId}`,
    `created: ${guild.createdAt.toISOString()}`,
    `channels: ${guild.channels.cache.size}  roles: ${guild.roles.cache.size}  boost tier: ${guild.premiumTier}`,
  ].join('\n');

const resolveTextChannel = (guild: Guild, id: string): TextChannel => {
  const channel = guild.channels.cache.get(id);
  if (!channel) throw new Error(`channel ${id} not found in this guild`);
  if (!channel.isTextBased() || channel.isThread() || channel.isVoiceBased())
    if (!('send' in channel)) throw new Error(`channel ${id} (${channel.name}) cannot hold messages`);

  return channel as TextChannel;
};

const resolveMember = async (guild: Guild, id: string): Promise<GuildMember> => {
  const cached = guild.members.cache.get(id);
  if (cached) return cached;
  return guild.members.fetch(id);
};

const resolveThread = (guild: Guild, id: string) => {
  const channel = guild.channels.cache.get(id);
  if (!channel || !channel.isThread()) throw new Error(`${id} is not a thread in this guild`);
  return channel;
};

const channelLine = (channel: {
  id: string;
  name: string;
  type: ChannelType;
  parentId: string | null;
  position?: number;
}) =>
  `${ChannelType[channel.type] ?? channel.type}  ${channel.id}  #${channel.name}` +
  (channel.parentId ? `  parent=${channel.parentId}` : '') +
  (channel.position === undefined ? '' : `  pos=${channel.position}`);

export const capabilities: Capability[] = [
  {
    'name': 'guild_info',
    'summary': 'Server overview',
    'description': 'Get the name, id, member count, owner, creation date, and channel/role counts of this server.',
    'risk': 'read',
    'params': [],
    'run': async ctx => describeGuild(ctx.guild),
  },
  {
    'name': 'channels_list',
    'summary': 'List channels',
    'description': 'List channels in this server with type, id, name, parent category, and position. Max 200 shown.',
    'risk': 'read',
    'params': [],
    'run': async ctx =>
      [...ctx.guild.channels.cache.values()]
        .sort((a, b) => ('position' in a ? a.position : 0) - ('position' in b ? b.position : 0))
        .slice(0, 200)
        .map(channelLine)
        .join('\n') || 'no channels',
  },
  {
    'name': 'channel_info',
    'summary': 'Channel details',
    'description': 'Get details for one channel: type, topic, position, parent, slowmode, and permission overwrites.',
    'risk': 'read',
    'params': [{ 'name': 'channel_id', 'kind': 'string', 'description': 'channel id', 'required': true }],
    'run': async (ctx, args) => {
      const channel = ctx.guild.channels.cache.get(requireStr(args, 'channel_id'));
      if (!channel) throw new Error('channel not found in this guild');
      const overwrites =
        'permissionOverwrites' in channel
          ? channel.permissionOverwrites.cache
              .map(
                o => `  ${o.type === 0 ? 'role' : 'member'} ${o.id}: allow=${o.allow.bitfield} deny=${o.deny.bitfield}`,
              )
              .join('\n')
          : '';
      const topic = 'topic' in channel && channel.topic ? `\ntopic: ${channel.topic}` : '';
      return `${channelLine(channel)}${topic}\nrateLimitPerUser: ${'rateLimitPerUser' in channel ? channel.rateLimitPerUser : 'n/a'}\noverwrites:\n${overwrites || '  none'}`;
    },
  },
  {
    'name': 'roles_list',
    'summary': 'List roles',
    'description': 'List roles with id, name, color, position, and whether they are managed/mentionable.',
    'risk': 'read',
    'params': [],
    'run': async ctx =>
      ctx.guild.roles.cache
        .values()
        .toArray()
        .sort((a, b) => b.position - a.position)
        .map(
          role =>
            `${role.id}  @${role.name}  color=${role.hexColor} pos=${role.position}${role.managed ? ' managed' : ''}${role.mentionable ? ' mentionable' : ''}`,
        )
        .join('\n') || 'no roles',
  },
  {
    'name': 'member_list',
    'summary': 'List members',
    'description':
      'List server members (id, username, display name, joined date, roles). Requires the Guild Members intent.',
    'risk': 'read',
    'params': [
      { 'name': 'limit', 'kind': 'number', 'description': 'max members to return (1-200, default 50)' },
      { 'name': 'query', 'kind': 'string', 'description': 'optional username/display prefix filter' },
    ],
    'run': async (ctx, args) => {
      const limit = Math.min(Math.max(num(args, 'limit') ?? 50, 1), 200);
      const members = await ctx.guild.members.fetch({ limit, 'query': str(args, 'query') });
      return (
        [...members.values()]
          .slice(0, limit)
          .map(
            m =>
              `${m.id}  ${m.user.username}${m.nickname ? ` (${m.nickname})` : ''}  joined=${m.joinedAt?.toISOString().slice(0, 10) ?? '?'}  roles=${
                m.roles.cache
                  .filter(r => r.id !== ctx.guild.id)
                  .map(r => r.name)
                  .join(',') || 'none'
              }`,
          )
          .join('\n') || 'no members matched'
      );
    },
  },
  {
    'name': 'member_info',
    'summary': 'Member details',
    'description': "Get one member's id, username, display name, account age, join date, roles, and moderation status.",
    'risk': 'read',
    'params': [{ 'name': 'user_id', 'kind': 'string', 'description': 'user id', 'required': true }],
    'run': async (ctx, args) => {
      const member = await resolveMember(ctx.guild, requireStr(args, 'user_id'));
      return [
        `${member.id}  ${member.user.username}${member.nickname ? ` (${member.nickname})` : ''}`,
        `account created: ${member.user.createdAt.toISOString()}`,
        `joined: ${member.joinedAt?.toISOString() ?? '?'}`,
        `roles: ${
          member.roles.cache
            .filter(r => r.id !== ctx.guild.id)
            .map(r => `${r.name}(${r.id})`)
            .join(', ') || 'none'
        }`,
        `timed out until: ${member.communicationDisabledUntil?.toISOString() ?? 'no'}`,
        `bot: ${member.user.bot}`,
      ].join('\n');
    },
  },
  {
    'name': 'messages_fetch',
    'summary': 'Read recent messages',
    'description':
      'Fetch the most recent messages of a channel (author, timestamp, content) for context or summarising.',
    'risk': 'read',
    'params': [
      { 'name': 'channel_id', 'kind': 'string', 'description': 'channel id', 'required': true },
      { 'name': 'limit', 'kind': 'number', 'description': '1-50, default 20' },
    ],
    'run': async (ctx, args) => {
      const channel = resolveTextChannel(ctx.guild, requireStr(args, 'channel_id'));
      const limit = Math.min(Math.max(num(args, 'limit') ?? 20, 1), 50);
      const messages = await channel.messages.fetch({ limit });
      return (
        [...messages.values()]
          .reverse()
          .map(
            m =>
              `[${m.createdAt.toISOString()}] ${m.author.username}(${m.author.id}): ${m.content.replace(/\s+/g, ' ').slice(0, 400)}`,
          )
          .join('\n') || 'no messages'
      );
    },
  },
  {
    'name': 'message_send',
    'summary': 'Send a message',
    'description': 'Send a plain message to a channel as the bot.',
    'risk': 'reversible',
    'params': [
      { 'name': 'channel_id', 'kind': 'string', 'description': 'channel id', 'required': true },
      { 'name': 'content', 'kind': 'string', 'description': 'message text (max 2000 chars)', 'required': true },
    ],
    'run': async (ctx, args) => {
      const channel = resolveTextChannel(ctx.guild, requireStr(args, 'channel_id'));
      const content = requireStr(args, 'content').slice(0, 2000);
      const sent = await channel.send({ content, 'allowedMentions': { 'parse': [] } });
      return `sent message ${sent.id} in #${channel.name}`;
    },
  },
  {
    'name': 'channel_create',
    'summary': 'Create a channel',
    'description': 'Create a text, voice, forum, or category channel, optionally under a parent category.',
    'risk': 'reversible',
    'params': [
      { 'name': 'name', 'kind': 'string', 'description': 'channel name', 'required': true },
      {
        'name': 'type',
        'kind': 'string',
        'description': 'text | voice | forum | category (default text)',
        'choices': ['text', 'voice', 'forum', 'category'],
      },
      { 'name': 'parent_id', 'kind': 'string', 'description': 'optional category id' },
      { 'name': 'topic', 'kind': 'string', 'description': 'optional topic for text channels' },
    ],
    'run': async (ctx, args) => {
      const kind = str(args, 'type') ?? 'text';
      const name = requireStr(args, 'name');
      const parent = str(args, 'parent_id') ?? undefined;
      const reason = `requested by ${ctx.actorId} via open-discord-agent`;
      const common = { name, parent, reason };
      const created =
        kind === 'voice'
          ? await ctx.guild.channels.create({ ...common, 'type': ChannelType.GuildVoice })
          : kind === 'forum'
            ? await ctx.guild.channels.create({ ...common, 'type': ChannelType.GuildForum })
            : kind === 'category'
              ? await ctx.guild.channels.create({ ...common, 'type': ChannelType.GuildCategory })
              : kind === 'text'
                ? await ctx.guild.channels.create({
                    ...common,
                    'type': ChannelType.GuildText,
                    'topic': str(args, 'topic'),
                  })
                : undefined;
      if (!created) throw new Error(`unknown channel type: ${kind}`);
      return `created channel ${created.id} #${created.name} (${kind})`;
    },
  },
  {
    'name': 'thread_create',
    'summary': 'Create a thread',
    'description': 'Create a public thread, optionally from an existing message.',
    'risk': 'reversible',
    'params': [
      { 'name': 'channel_id', 'kind': 'string', 'description': 'channel the thread belongs to', 'required': true },
      { 'name': 'name', 'kind': 'string', 'description': 'thread name', 'required': true },
      { 'name': 'message_id', 'kind': 'string', 'description': 'optional message to start the thread from' },
    ],
    'run': async (ctx, args) => {
      const channel = resolveTextChannel(ctx.guild, requireStr(args, 'channel_id'));
      const thread = await channel.threads.create({
        'name': requireStr(args, 'name'),
        'startMessage': str(args, 'message_id') ?? undefined,
        'reason': `requested by ${ctx.actorId} via open-discord-agent`,
      });
      return `created thread ${thread.id} (${thread.name})`;
    },
  },
  {
    'name': 'message_delete',
    'summary': 'Delete a message',
    'description': 'Delete one message from a channel. Destructive: content is gone.',
    'risk': 'destructive',
    'params': [
      { 'name': 'channel_id', 'kind': 'string', 'description': 'channel id', 'required': true },
      { 'name': 'message_id', 'kind': 'string', 'description': 'message id', 'required': true },
    ],
    'run': async (ctx, args) => {
      const channel = resolveTextChannel(ctx.guild, requireStr(args, 'channel_id'));
      const message = await channel.messages.fetch(requireStr(args, 'message_id'));
      await message.delete();
      return `deleted message ${args.message_id} in #${channel.name}`;
    },
  },
  {
    'name': 'role_assign',
    'summary': 'Add/remove a role',
    'description': 'Add or remove one role from one member.',
    'risk': 'reversible',
    'params': [
      { 'name': 'user_id', 'kind': 'string', 'description': 'member id', 'required': true },
      { 'name': 'role_id', 'kind': 'string', 'description': 'role id', 'required': true },
      { 'name': 'add', 'kind': 'boolean', 'description': 'true to add (default), false to remove' },
    ],
    'run': async (ctx, args) => {
      const member = await resolveMember(ctx.guild, requireStr(args, 'user_id'));
      const roleId = requireStr(args, 'role_id');
      if (roleId === ctx.guild.id) throw new Error('@everyone cannot be assigned');
      const add = args.add !== false;
      if (add) await member.roles.add(roleId, `requested by ${ctx.actorId} via open-discord-agent`);
      else await member.roles.remove(roleId, `requested by ${ctx.actorId} via open-discord-agent`);
      return `${add ? 'added' : 'removed'} role ${roleId} ${add ? 'to' : 'from'} ${member.user.username}`;
    },
  },
  {
    'name': 'member_timeout',
    'summary': 'Time out a member',
    'description': 'Put a member in timeout for N minutes (0 clears). Destructive to their ability to speak.',
    'risk': 'destructive',
    'params': [
      { 'name': 'user_id', 'kind': 'string', 'description': 'member id', 'required': true },
      { 'name': 'minutes', 'kind': 'number', 'description': '1-40320, or 0 to clear', 'required': true },
    ],
    'run': async (ctx, args) => {
      const member = await resolveMember(ctx.guild, requireStr(args, 'user_id'));
      const minutes = Math.min(Math.max(num(args, 'minutes') ?? 0, 0), 40320);
      await member.timeout(
        minutes === 0 ? null : minutes * 60_000,
        `requested by ${ctx.actorId} via open-discord-agent`,
      );
      return minutes === 0
        ? `cleared timeout for ${member.user.username}`
        : `timed out ${member.user.username} for ${minutes} minutes`;
    },
  },
  {
    'name': 'bash',
    'summary': 'Run a shell command',
    'description':
      'Run a shell command in the workspace. Shadowed builtin: routed through the sandbox (docker by default).',
    'risk': 'destructive',
    'params': [{ 'name': 'command', 'kind': 'string', 'description': 'shell command to execute', 'required': true }],
    'run': async (ctx, args) => runShell(ctx.guild.id, requireStr(args, 'command')),
  },

  {
    'name': 'channel_update',
    'summary': 'Rename or retune a channel',
    'description': 'Change a channel name, topic, slowmode seconds, or NSFW flag. Omitted fields are left alone.',
    'risk': 'reversible',
    'params': [
      { 'name': 'channel_id', 'kind': 'string', 'description': 'channel id', 'required': true },
      { 'name': 'name', 'kind': 'string', 'description': 'new channel name' },
      { 'name': 'topic', 'kind': 'string', 'description': 'new topic (text and forum channels)' },
      { 'name': 'slowmode', 'kind': 'number', 'description': 'slowmode in seconds (0-21600)' },
      { 'name': 'nsfw', 'kind': 'boolean', 'description': 'mark the channel age-restricted' },
    ],
    'run': async (ctx, args) => {
      const channel = ctx.guild.channels.cache.get(requireStr(args, 'channel_id'));
      if (!channel) throw new Error('channel not found in this guild');
      const reason = `requested by ${ctx.actorId} via open-discord-agent`;
      const changed: string[] = [];
      const name = str(args, 'name');
      const topic = str(args, 'topic');
      const slowmode = num(args, 'slowmode');
      const nsfw = typeof args.nsfw === 'boolean' ? args.nsfw : undefined;
      const textChannel = channel instanceof TextChannelClass ? channel : undefined;

      if (name) {
        await channel.setName(name, reason);
        changed.push(`name=${name}`);
      }
      if (topic !== undefined) {
        if (!textChannel) throw new Error('topic can only be set on text channels');
        await textChannel.setTopic(topic, reason);
        changed.push('topic');
      }
      if (slowmode !== undefined) {
        if (!textChannel) throw new Error('slowmode can only be set on text channels');
        const value = Math.min(Math.max(slowmode, 0), 21600);
        await textChannel.setRateLimitPerUser(value, reason);
        changed.push(`slowmode=${value}`);
      }
      if (nsfw !== undefined) {
        if (!('setNSFW' in channel)) throw new Error('this channel type cannot be age-restricted');
        await channel.setNSFW(nsfw, reason);
        changed.push(`nsfw=${nsfw}`);
      }
      if (changed.length === 0) throw new Error('nothing to change: pass name, topic, slowmode, or nsfw');
      return `updated ${channel.name} (${channel.id}): ${changed.join(', ')}`;
    },
  },
  {
    'name': 'channel_move',
    'summary': 'Move or reorder a channel',
    'description': 'Move a channel under a category (or out of one) and/or set its position in the sidebar.',
    'risk': 'reversible',
    'params': [
      { 'name': 'channel_id', 'kind': 'string', 'description': 'channel id', 'required': true },
      {
        'name': 'parent_id',
        'kind': 'string',
        'description': 'category id to move under, or "none" to remove the parent',
      },
      { 'name': 'position', 'kind': 'number', 'description': 'zero-based position within its parent' },
    ],
    'run': async (ctx, args) => {
      const channel = ctx.guild.channels.cache.get(requireStr(args, 'channel_id'));
      if (!channel || !('setPosition' in channel)) throw new Error('channel not found or cannot be repositioned');
      const reason = `requested by ${ctx.actorId} via open-discord-agent`;
      const parent = str(args, 'parent_id');
      const position = num(args, 'position');
      if (parent !== undefined) await channel.setParent(parent === 'none' ? null : parent, { 'reason': reason });

      if (position !== undefined && 'setPosition' in channel)
        await channel.setPosition(Math.max(position, 0), { 'reason': reason });

      return `moved ${channel.name} (${channel.id})${parent !== undefined ? ` parent=${parent}` : ''}${position !== undefined ? ` position=${position}` : ''}`;
    },
  },
  {
    'name': 'channel_delete',
    'summary': 'Delete a channel',
    'description':
      'Delete a channel or category permanently, including its message history. Destructive and irreversible.',
    'risk': 'destructive',
    'params': [{ 'name': 'channel_id', 'kind': 'string', 'description': 'channel id', 'required': true }],
    'run': async (ctx, args) => {
      const channel = ctx.guild.channels.cache.get(requireStr(args, 'channel_id'));
      if (!channel) throw new Error('channel not found in this guild');
      const name = channel.name;
      await channel.delete(`requested by ${ctx.actorId} via open-discord-agent`);
      return `deleted channel #${name} (${args.channel_id})`;
    },
  },
  {
    'name': 'permission_set',
    'summary': 'Change channel permissions',
    'description':
      'Set or clear a channel permission overwrite for a role or member. Pass permission names to allow and/or deny, e.g. allow ["ViewChannel"], deny ["SendMessages"].',
    'risk': 'destructive',
    'params': [
      { 'name': 'channel_id', 'kind': 'string', 'description': 'channel id', 'required': true },
      { 'name': 'target_id', 'kind': 'string', 'description': 'role or member id', 'required': true },
      { 'name': 'allow', 'kind': 'string[]', 'description': 'permission names to allow' },
      { 'name': 'deny', 'kind': 'string[]', 'description': 'permission names to deny' },
      { 'name': 'clear', 'kind': 'boolean', 'description': 'delete the overwrite entirely instead of editing it' },
    ],
    'run': async (ctx, args) => {
      const channel = ctx.guild.channels.cache.get(requireStr(args, 'channel_id'));
      if (!channel || !('permissionOverwrites' in channel))
        throw new Error('channel not found or has no permission overwrites');
      const targetId = requireStr(args, 'target_id');
      const reason = `requested by ${ctx.actorId} via open-discord-agent`;
      const target = ctx.guild.roles.cache.get(targetId)
        ? `role @${ctx.guild.roles.cache.get(targetId)?.name}`
        : `member ${targetId}`;

      if (args.clear === true) {
        await channel.permissionOverwrites.delete(targetId);
        return `cleared ${target} overwrite on #${channel.name}`;
      }
      const payload = overwritePayload(strArray(args, 'allow'), strArray(args, 'deny'));
      if (Object.keys(payload).length === 0) throw new Error('nothing to apply: pass allow, deny, or clear');
      await channel.permissionOverwrites.edit(targetId, payload, { 'reason': reason });
      return `updated ${target} on #${channel.name}: ${Object.entries(payload)
        .map(([key, value]) => `${key}=${value}`)
        .join(', ')}`;
    },
  },
  {
    'name': 'role_create',
    'summary': 'Create a role',
    'description':
      'Create a role with a name, colour (#rrggbb or "default"), hoist/mentionable flags, and permission names.',
    'risk': 'reversible',
    'params': [
      { 'name': 'name', 'kind': 'string', 'description': 'role name', 'required': true },
      { 'name': 'color', 'kind': 'string', 'description': 'hex colour like #ff8800, or "default"' },
      { 'name': 'hoist', 'kind': 'boolean', 'description': 'show separately in the member list' },
      { 'name': 'mentionable', 'kind': 'boolean', 'description': 'allow @role mentions' },
      { 'name': 'permissions', 'kind': 'string[]', 'description': 'permission names to grant' },
    ],
    'run': async (ctx, args) => {
      const color = str(args, 'color');
      const created = await ctx.guild.roles.create({
        'name': requireStr(args, 'name'),
        'color': color && color !== 'default' ? hexColor(color) : undefined,
        'hoist': args.hoist === true,
        'mentionable': args.mentionable === true,
        'permissions': permissionNames(strArray(args, 'permissions')),
        'reason': `requested by ${ctx.actorId} via open-discord-agent`,
      });
      return `created role @${created.name} (${created.id}) color=${created.hexColor}`;
    },
  },
  {
    'name': 'role_update',
    'summary': 'Edit a role',
    'description': 'Rename a role, change its colour, hoist/mentionable flags, or replace its permission set.',
    'risk': 'reversible',
    'params': [
      { 'name': 'role_id', 'kind': 'string', 'description': 'role id', 'required': true },
      { 'name': 'name', 'kind': 'string', 'description': 'new role name' },
      { 'name': 'color', 'kind': 'string', 'description': 'hex colour like #ff8800, or "default"' },
      { 'name': 'hoist', 'kind': 'boolean', 'description': 'show separately in the member list' },
      { 'name': 'mentionable', 'kind': 'boolean', 'description': 'allow @role mentions' },
      { 'name': 'permissions', 'kind': 'string[]', 'description': 'replacement permission set' },
    ],
    'run': async (ctx, args) => {
      const role = ctx.guild.roles.cache.get(requireStr(args, 'role_id'));
      if (!role) throw new Error('role not found in this guild');
      if (role.managed) throw new Error(`@${role.name} is managed by an integration and cannot be edited`);
      const reason = `requested by ${ctx.actorId} via open-discord-agent`;
      const changed: string[] = [];
      const name = str(args, 'name');
      const color = str(args, 'color');
      if (name) {
        await role.setName(name, reason);
        changed.push(`name=${name}`);
      }
      if (color !== undefined) {
        if (color === 'default') await role.setColors({ 'primaryColor': 0 }, reason);
        else await role.setColor(hexColor(color), reason);
        changed.push(`color=${color}`);
      }
      if (typeof args.hoist === 'boolean') {
        await role.setHoist(args.hoist, reason);
        changed.push(`hoist=${args.hoist}`);
      }
      if (typeof args.mentionable === 'boolean') {
        await role.setMentionable(args.mentionable, reason);
        changed.push(`mentionable=${args.mentionable}`);
      }
      const permissions = strArray(args, 'permissions');
      if (permissions.length > 0) {
        await role.setPermissions(permissionNames(permissions), reason);
        changed.push(`permissions=${permissions.length} flags`);
      }
      if (changed.length === 0)
        throw new Error('nothing to change: pass name, color, hoist, mentionable, or permissions');
      return `updated role @${role.name} (${role.id}): ${changed.join(', ')}`;
    },
  },
  {
    'name': 'role_delete',
    'summary': 'Delete a role',
    'description': 'Delete a role permanently; everyone who had it loses it. Destructive and irreversible.',
    'risk': 'destructive',
    'params': [{ 'name': 'role_id', 'kind': 'string', 'description': 'role id', 'required': true }],
    'run': async (ctx, args) => {
      const role = ctx.guild.roles.cache.get(requireStr(args, 'role_id'));
      if (!role) throw new Error('role not found in this guild');
      if (role.managed) throw new Error(`@${role.name} is managed by an integration and cannot be deleted`);
      const name = role.name;
      await role.delete(`requested by ${ctx.actorId} via open-discord-agent`);
      return `deleted role @${name} (${args.role_id})`;
    },
  },
  {
    'name': 'thread_update',
    'summary': 'Archive, lock, or rename a thread',
    'description': 'Archive/unarchive a thread, lock it, or rename it.',
    'risk': 'reversible',
    'params': [
      { 'name': 'thread_id', 'kind': 'string', 'description': 'thread id', 'required': true },
      { 'name': 'archived', 'kind': 'boolean', 'description': 'archive the thread' },
      { 'name': 'locked', 'kind': 'boolean', 'description': 'lock the thread (requires archived)' },
      { 'name': 'name', 'kind': 'string', 'description': 'new thread name' },
    ],
    'run': async (ctx, args) => {
      const thread = resolveThread(ctx.guild, requireStr(args, 'thread_id'));
      const reason = `requested by ${ctx.actorId} via open-discord-agent`;
      const changed: string[] = [];
      if (typeof args.archived === 'boolean') {
        await thread.setArchived(args.archived, reason);
        changed.push(`archived=${args.archived}`);
      }
      if (typeof args.locked === 'boolean') {
        await thread.setLocked(args.locked, reason);
        changed.push(`locked=${args.locked}`);
      }
      const name = str(args, 'name');
      if (name) {
        await thread.setName(name, reason);
        changed.push(`name=${name}`);
      }
      if (changed.length === 0) throw new Error('nothing to change: pass archived, locked, or name');
      return `updated thread ${thread.name} (${thread.id}): ${changed.join(', ')}`;
    },
  },
  {
    'name': 'message_pin',
    'summary': 'Pin or unpin a message',
    'description': 'Pin or unpin one message in a channel.',
    'risk': 'reversible',
    'params': [
      { 'name': 'channel_id', 'kind': 'string', 'description': 'channel id', 'required': true },
      { 'name': 'message_id', 'kind': 'string', 'description': 'message id', 'required': true },
      { 'name': 'pin', 'kind': 'boolean', 'description': 'true to pin (default), false to unpin' },
    ],
    'run': async (ctx, args) => {
      const channel = resolveTextChannel(ctx.guild, requireStr(args, 'channel_id'));
      const message = await channel.messages.fetch(requireStr(args, 'message_id'));
      const pin = args.pin !== false;
      if (pin) await message.pin(`requested by ${ctx.actorId}`);
      else await message.unpin(`requested by ${ctx.actorId}`);
      return `${pin ? 'pinned' : 'unpinned'} message ${message.id} in #${channel.name}`;
    },
  },
  {
    'name': 'invite_create',
    'summary': 'Create an invite',
    'description': 'Create a channel invite link with an optional lifetime and use limit.',
    'risk': 'reversible',
    'params': [
      { 'name': 'channel_id', 'kind': 'string', 'description': 'channel id', 'required': true },
      { 'name': 'max_age', 'kind': 'number', 'description': 'lifetime in seconds (0 = never, default 86400)' },
      { 'name': 'max_uses', 'kind': 'number', 'description': 'use limit (0 = unlimited)' },
    ],
    'run': async (ctx, args) => {
      const channel = resolveTextChannel(ctx.guild, requireStr(args, 'channel_id'));
      const invite = await channel.createInvite({
        'maxAge': Math.max(num(args, 'max_age') ?? 86_400, 0),
        'maxUses': Math.max(num(args, 'max_uses') ?? 0, 0),
        'reason': `requested by ${ctx.actorId} via open-discord-agent`,
      });
      return `invite https://discord.gg/${invite.code} for #${channel.name} expires=${invite.expiresAt?.toISOString() ?? 'never'} maxUses=${invite.maxUses}`;
    },
  },
  {
    'name': 'member_kick',
    'summary': 'Kick a member',
    'description': 'Remove a member from the server (they can rejoin with an invite). Destructive.',
    'risk': 'destructive',
    'params': [
      { 'name': 'user_id', 'kind': 'string', 'description': 'member id', 'required': true },
      { 'name': 'reason', 'kind': 'string', 'description': 'audit-log reason' },
    ],
    'run': async (ctx, args) => {
      const member = await resolveMember(ctx.guild, requireStr(args, 'user_id'));
      const name = member.user.username;
      await member.kick(str(args, 'reason') ?? `requested by ${ctx.actorId} via open-discord-agent`);
      return `kicked ${name} (${member.id})`;
    },
  },
  {
    'name': 'member_ban',
    'summary': 'Ban a member',
    'description':
      'Ban a member and optionally delete their recent messages. Destructive and reversible only by an unban.',
    'risk': 'destructive',
    'params': [
      { 'name': 'user_id', 'kind': 'string', 'description': 'member id', 'required': true },
      {
        'name': 'delete_message_seconds',
        'kind': 'number',
        'description': 'delete this many seconds of their messages (0-604800)',
      },
      { 'name': 'reason', 'kind': 'string', 'description': 'audit-log reason' },
    ],
    'run': async (ctx, args) => {
      const member = await resolveMember(ctx.guild, requireStr(args, 'user_id'));
      const name = member.user.username;
      const seconds = Math.min(Math.max(num(args, 'delete_message_seconds') ?? 0, 0), 604_800);
      await member.ban({
        'deleteMessageSeconds': seconds,
        'reason': str(args, 'reason') ?? `requested by ${ctx.actorId} via open-discord-agent`,
      });
      return `banned ${name} (${member.id}) deletedMessages=${seconds}s`;
    },
  },
  {
    'name': 'git_status',
    'summary': 'Workspace git state',
    'description':
      "This server's workspace repository: branch, remote, uncommitted files, unpushed commits and the last few commits.",
    'risk': 'read',
    'params': [],
    'run': async ctx => describeWorkspace(ctx.guild.id),
  },
  {
    'name': 'git_commit',
    'summary': 'Commit workspace changes',
    'description':
      'Commit everything in the workspace with your own message. Each turn is committed automatically; use this for an explicit checkpoint, and it is pushed when auto-push is on.',
    'risk': 'reversible',
    'params': [{ 'name': 'message', 'kind': 'string', 'description': 'commit message', 'required': true }],
    'run': async (ctx, args) =>
      commitNow({ 'guildId': ctx.guild.id, 'message': requireStr(args, 'message').slice(0, 200) }),
  },
  {
    'name': 'git_push',
    'summary': 'Push the workspace',
    'description':
      'Push the current branch to the git server configured for this server. Refuses when no server is configured.',
    'risk': 'reversible',
    'params': [],
    'run': async ctx => {
      const pushed = pushWorkspace(ctx.guild.id);
      if (!pushed.ok) throw new Error(pushed.detail);
      return pushed.detail;
    },
  },
  {
    'name': 'git_repo_create',
    'summary': 'Create a repository on the git server',
    'description':
      'Create a new repository for this server on the configured git server, optionally pointing the workspace at it as origin.',
    'risk': 'reversible',
    'params': [
      { 'name': 'name', 'kind': 'string', 'description': 'repository name (letters, digits, . _ -)', 'required': true },
      {
        'name': 'attach',
        'kind': 'boolean',
        'description': 'set it as the workspace origin, only when the workspace has none',
      },
    ],
    'run': async (ctx, args) => {
      if (!config.git(ctx.guild.id).createRepos)
        throw new Error('creating repositories is off here (git.createRepos is false)');
      const name = requireStr(args, 'name');
      if (!/^[\w.-]{1,64}$/.test(name)) throw new Error(`"${name}" is not a usable repository name`);
      const repo = await createRepo(ctx.guild.id, name);
      if (!repo) throw new Error('the git server refused the create request (see the bot log)');
      const attached = args.attach === true ? attachOrigin(ctx.guild.id, repo.cloneUrl) : undefined;
      return [
        `created ${repo.name}: ${repo.htmlUrl}`,
        attached ? `origin: ${attached.ok ? repo.cloneUrl : `not attached — ${attached.detail}`}` : 'origin unchanged',
      ].join('\n');
    },
  },
  {
    'name': 'ptero_servers',
    'summary': 'List panel servers',
    'description':
      'Servers this panel account can see: identifier, name, status, node, memory/disk limits and whether they are suspended.',
    'risk': 'read',
    'params': [],
    'run': async ctx => {
      const target = requirePtero(ctx.guild.id);
      const payload = await pteroRequest(ctx.guild.id, 'client', keyFor(target, 'client'), '/');
      const rows = listAttributes(payload);
      if (rows.length === 0) return 'no servers are visible to this panel account';
      return rows.map(describeServerLine).join('\n');
    },
  },
  {
    'name': 'ptero_server',
    'summary': 'Panel server details',
    'description':
      'One server: state, resource usage (memory, cpu, disk, network, uptime), limits, node and sftp details.',
    'risk': 'read',
    'params': [{ 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true }],
    'run': async (ctx, args) => {
      const target = requirePtero(ctx.guild.id);
      const key = keyFor(target, 'client');
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const details = attributesOf(await pteroRequest(ctx.guild.id, 'client', key, `/servers/${server}`));
      const stats = attributesOf(await pteroRequest(ctx.guild.id, 'client', key, `/servers/${server}/resources`));
      const usage = nested(stats, 'resources');
      return [
        describeServerLine(details),
        `state=${show(stats.current_state, 'unknown')} suspended=${stats.is_suspended === true}`,
        `usage: memory=${bytes(usage.memory_bytes)} cpu=${show(usage.cpu_absolute)}% disk=${bytes(usage.disk_bytes)}`,
        `network: rx=${bytes(usage.network_rx_bytes)} tx=${bytes(usage.network_tx_bytes)} uptime=${minutes(usage.uptime)}`,
        `invocation: ${show(details.invocation, '-')}`,
      ].join('\n');
    },
  },
  {
    'name': 'ptero_power',
    'summary': 'Start, stop or restart a server',
    'description':
      'Send a power signal to a panel server: start, stop, restart or kill (kill is an immediate SIGKILL).',
    'risk': 'destructive',
    'params': [
      { 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true },
      {
        'name': 'signal',
        'kind': 'string',
        'description': 'start | stop | restart | kill',
        'required': true,
        'choices': ['start', 'stop', 'restart', 'kill'],
      },
    ],
    'run': async (ctx, args) => {
      const target = requirePtero(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const signal = pick(POWER_SIGNALS, requireStr(args, 'signal'), 'signal');
      await pteroRequest(
        ctx.guild.id,
        'client',
        keyFor(target, 'client'),
        `/servers/${server}/power`,
        powerRequest(signal),
      );
      return `sent ${signal} to ${server}`;
    },
  },
  {
    'name': 'ptero_command',
    'summary': 'Send a console command',
    'description': 'Run one command on a server console, exactly as if typed there. Only works while the server runs.',
    'risk': 'destructive',
    'params': [
      { 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true },
      { 'name': 'command', 'kind': 'string', 'description': 'console command, e.g. "say hello"', 'required': true },
    ],
    'run': async (ctx, args) => {
      const target = requirePtero(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const command = requireStr(args, 'command').slice(0, 2000);
      await pteroRequest(
        ctx.guild.id,
        'client',
        keyFor(target, 'client'),
        `/servers/${server}/command`,
        commandRequest(command),
      );
      return `sent to ${server} console: ${command}`;
    },
  },
  {
    'name': 'ptero_files',
    'summary': 'List server files',
    'description': 'List one directory of a server: name, size, type and modified time.',
    'risk': 'read',
    'params': [
      { 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true },
      { 'name': 'directory', 'kind': 'string', 'description': 'absolute path, default /' },
    ],
    'run': async (ctx, args) => {
      const target = requirePteroFiles(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const directory = safePath(str(args, 'directory') ?? '/', 'directory');
      const payload = await pteroRequest(
        ctx.guild.id,
        'client',
        keyFor(target, 'client'),
        `/servers/${server}/files/list?directory=${encodeURIComponent(directory)}`,
      );
      const rows = listAttributes(payload);
      if (rows.length === 0) return `${directory}: empty`;
      return rows
        .map(
          file =>
            `${file.is_file === true ? 'file' : 'dir '}  ${show(file.size)}B  ${show(file.name)}${file.is_symlink === true ? '  (symlink)' : ''}`,
        )
        .join('\n');
    },
  },
  {
    'name': 'ptero_file_read',
    'summary': 'Read a server file',
    'description': 'Read one file from a server, truncated to keep it skimmable.',
    'risk': 'read',
    'params': [
      { 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true },
      { 'name': 'file', 'kind': 'string', 'description': 'absolute path to the file', 'required': true },
    ],
    'run': async (ctx, args) => {
      const target = requirePteroFiles(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const file = safePath(requireStr(args, 'file'), 'file');
      const content = await pteroRequest<string>(
        ctx.guild.id,
        'client',
        keyFor(target, 'client'),
        `/servers/${server}/files/contents?file=${encodeURIComponent(file)}`,
        { 'accept': 'text/plain' },
      );
      const text = typeof content === 'string' ? content : JSON.stringify(content);
      return `${file} (${text.length} bytes)\n${text.slice(0, 8000)}${text.length > 8000 ? '\n… truncated' : ''}`;
    },
  },
  {
    'name': 'ptero_file_write',
    'summary': 'Write a server file',
    'description':
      'Overwrite one file on a server with the given contents. The previous contents are lost; there is no undo.',
    'risk': 'destructive',
    'params': [
      { 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true },
      { 'name': 'file', 'kind': 'string', 'description': 'absolute path to the file', 'required': true },
      { 'name': 'content', 'kind': 'string', 'description': 'the complete new contents', 'required': true },
    ],
    'run': async (ctx, args) => {
      const target = requirePteroFiles(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const file = safePath(requireStr(args, 'file'), 'file');
      const content = requireStr(args, 'content');
      const request = writeRequest(content);
      await pteroRequest(
        ctx.guild.id,
        'client',
        keyFor(target, 'client'),
        `/servers/${server}/files/write?file=${encodeURIComponent(file)}`,
        request,
      );
      return `wrote ${content.length} bytes to ${file} on ${server}`;
    },
  },
  {
    'name': 'ptero_admin_servers',
    'summary': 'List every server on the panel',
    'description': 'Application API: all servers with their owner, node, allocation and suspension state.',
    'risk': 'read',
    'params': [{ 'name': 'filter', 'kind': 'string', 'description': 'optional name filter' }],
    'run': async (ctx, args) => {
      const target = requirePteroAdmin(ctx.guild.id);
      const filter = str(args, 'filter');
      const query = filter ? `?filter[name]=${encodeURIComponent(filter)}` : '';
      const payload = await pteroRequest(ctx.guild.id, 'admin', keyFor(target, 'admin'), `/servers${query}`);
      const rows = listAttributes(payload);
      if (rows.length === 0) return 'no servers on the panel';
      return rows
        .map(
          row =>
            `id=${show(row.id)} uuid=${show(row.uuid)} ${describeServerLine(row)} owner=${show(nested(row, 'user').username, '-')}`,
        )
        .join('\n');
    },
  },
  {
    'name': 'ptero_admin_server',
    'summary': 'One server, as an administrator',
    'description': 'Application API: full configuration of one server, including owner, node and allocations.',
    'risk': 'read',
    'params': [{ 'name': 'id', 'kind': 'string', 'description': 'panel server id', 'required': true }],
    'run': async (ctx, args) => {
      const target = requirePteroAdmin(ctx.guild.id);
      const id = requireStr(args, 'id');
      const server = attributesOf(
        await pteroRequest(ctx.guild.id, 'admin', keyFor(target, 'admin'), `/servers/${id}?include=user,allocations`),
      );
      const owner = nested(server, 'user');
      const allocations = nested(server, 'relationships').allocations;
      return [
        describeServerLine(server),
        `owner: ${show(owner.username)} <${show(owner.email)}>`,
        `docker image: ${show(server.docker_image, '-')}`,
        `startup: ${show(server.startup, '-')}`,
        `allocations: ${JSON.stringify(allocations).slice(0, 400)}`,
      ].join('\n');
    },
  },
  {
    'name': 'ptero_admin_users',
    'summary': 'List panel users',
    'description': 'Application API: panel accounts with their id, username, email and whether they are root admins.',
    'risk': 'read',
    'params': [{ 'name': 'query', 'kind': 'string', 'description': 'optional email or username filter' }],
    'run': async (ctx, args) => {
      const target = requirePteroAdmin(ctx.guild.id);
      const query = str(args, 'query');
      const payload = await pteroRequest(
        ctx.guild.id,
        'admin',
        keyFor(target, 'admin'),
        `/users${query ? `?filter[email]=${encodeURIComponent(query)}` : ''}`,
      );
      const rows = listAttributes(payload);
      if (rows.length === 0) return 'no panel users';
      return rows
        .map(
          row => `id=${show(row.id)} ${show(row.username)} <${show(row.email)}> root_admin=${row.root_admin === true}`,
        )
        .join('\n');
    },
  },
  {
    'name': 'ptero_admin_nodes',
    'summary': 'List panel nodes',
    'description': 'Application API: Wings nodes, their memory/disk capacity and how many servers each holds.',
    'risk': 'read',
    'params': [],
    'run': async ctx => {
      const target = requirePteroAdmin(ctx.guild.id);
      const payload = await pteroRequest(ctx.guild.id, 'admin', keyFor(target, 'admin'), '/nodes');
      const rows = listAttributes(payload);
      if (rows.length === 0) return 'no nodes';
      return rows
        .map(
          node =>
            `id=${show(node.id)} ${show(node.name)} public=${show(node.public, '-')} mainteance=${node.maintenance_mode === true} memory=${show(node.memory)}MB disk=${show(node.disk)}MB`,
        )
        .join('\n');
    },
  },
  {
    'name': 'ptero_admin_nests',
    'summary': 'List nests and eggs',
    'description':
      'Application API: nest ids and their eggs, which are what a new server needs (egg id + docker image).',
    'risk': 'read',
    'params': [{ 'name': 'nest', 'kind': 'string', 'description': 'nest id; omit to list nests' }],
    'run': async (ctx, args) => {
      const target = requirePteroAdmin(ctx.guild.id);
      const key = keyFor(target, 'admin');
      const nest = str(args, 'nest');
      if (!nest) {
        const nests = listAttributes(await pteroRequest(ctx.guild.id, 'admin', key, '/nests'));
        return nests.map(row => `nest id=${show(row.id)} ${show(row.name)}`).join('\n') || 'no nests';
      }
      const eggs = listAttributes(await pteroRequest(ctx.guild.id, 'admin', key, `/nests/${nest}/eggs`));
      return (
        eggs
          .map(
            egg =>
              `egg id=${show(egg.id)} ${show(egg.name)} docker=${JSON.stringify(egg.docker_images ?? {}).slice(0, 160)}`,
          )
          .join('\n') || 'no eggs'
      );
    },
  },
  {
    'name': 'ptero_admin_user_create',
    'summary': 'Create a panel user',
    'description':
      "Application API: create a panel account. The password is the caller's choice and is passed through as given.",
    'risk': 'admin',
    'params': [
      { 'name': 'email', 'kind': 'string', 'description': 'email address', 'required': true },
      { 'name': 'username', 'kind': 'string', 'description': 'username', 'required': true },
      { 'name': 'first_name', 'kind': 'string', 'description': 'first name', 'required': true },
      { 'name': 'last_name', 'kind': 'string', 'description': 'last name', 'required': true },
      { 'name': 'password', 'kind': 'string', 'description': 'initial password', 'required': true },
      { 'name': 'root_admin', 'kind': 'boolean', 'description': 'grant full panel administration' },
    ],
    'run': async (ctx, args) => {
      const target = requirePteroAdmin(ctx.guild.id);
      const body = JSON.stringify({
        'email': requireStr(args, 'email'),
        'username': requireStr(args, 'username'),
        'first_name': requireStr(args, 'first_name'),
        'last_name': requireStr(args, 'last_name'),
        'password': requireStr(args, 'password'),
        'root_admin': args.root_admin === true,
      });
      const created = attributesOf(
        await pteroRequest(ctx.guild.id, 'admin', keyFor(target, 'admin'), '/users', { 'method': 'POST', body }),
      );
      return `created panel user ${show(created.username)} (id ${show(created.id)}) root_admin=${created.root_admin === true}`;
    },
  },
  {
    'name': 'ptero_admin_suspend',
    'summary': 'Suspend or unsuspend a server',
    'description': 'Application API: suspend (stops it and blocks the owner) or unsuspend one server.',
    'risk': 'destructive',
    'params': [
      { 'name': 'id', 'kind': 'string', 'description': 'panel server id', 'required': true },
      {
        'name': 'action',
        'kind': 'string',
        'description': 'suspend | unsuspend',
        'required': true,
        'choices': ['suspend', 'unsuspend'],
      },
    ],
    'run': async (ctx, args) => {
      const target = requirePteroAdmin(ctx.guild.id);
      const id = requireStr(args, 'id');
      const action = pick(['suspend', 'unsuspend'] as const, requireStr(args, 'action'), 'action');
      await pteroRequest(ctx.guild.id, 'admin', keyFor(target, 'admin'), `/servers/${id}/${action}`, {
        'method': 'POST',
      });
      return `${action}ed panel server ${id}`;
    },
  },
  {
    'name': 'ptero_admin_server_create',
    'summary': 'Create a panel server',
    'description':
      'Application API: create a server from an egg. Needs the user id, nest id, egg id, docker image, startup line and one allocation id.',
    'risk': 'admin',
    'params': [
      { 'name': 'name', 'kind': 'string', 'description': 'server name', 'required': true },
      { 'name': 'user_id', 'kind': 'string', 'description': 'panel user id that owns it', 'required': true },
      { 'name': 'nest_id', 'kind': 'string', 'description': 'nest id', 'required': true },
      { 'name': 'egg_id', 'kind': 'string', 'description': 'egg id', 'required': true },
      { 'name': 'docker_image', 'kind': 'string', 'description': 'docker image for the egg', 'required': true },
      { 'name': 'startup', 'kind': 'string', 'description': 'startup command', 'required': true },
      { 'name': 'allocation_id', 'kind': 'string', 'description': 'allocation (port) id to use', 'required': true },
      { 'name': 'memory_mb', 'kind': 'number', 'description': 'memory limit in MB (default 1024)' },
      { 'name': 'disk_mb', 'kind': 'number', 'description': 'disk limit in MB (default 5120)' },
      { 'name': 'cpu_percent', 'kind': 'number', 'description': 'cpu limit in percent (default 100)' },
      {
        'name': 'environment',
        'kind': 'string',
        'description': 'JSON object of egg variables, e.g. {"SERVER_JARFILE":"server.jar"}',
      },
    ],
    'run': async (ctx, args) => {
      const target = requirePteroAdmin(ctx.guild.id);
      const environment = str(args, 'environment');
      const body = JSON.stringify({
        'name': requireStr(args, 'name'),
        'user': Number(requireStr(args, 'user_id')),
        'egg': Number(requireStr(args, 'egg_id')),
        'docker_image': requireStr(args, 'docker_image'),
        'startup': requireStr(args, 'startup'),
        'environment': environment ? (JSON.parse(environment) as unknown) : {},
        'limits': {
          'memory': num(args, 'memory_mb') ?? 1024,
          'swap': 0,
          'disk': num(args, 'disk_mb') ?? 5120,
          'io': 500,
          'cpu': num(args, 'cpu_percent') ?? 100,
        },
        'feature_limits': { 'databases': 0, 'backups': 0, 'allocations': 0 },
        'allocation': { 'default': Number(requireStr(args, 'allocation_id')) },
        'start_on_completion': false,
      });
      const created = attributesOf(
        await pteroRequest(ctx.guild.id, 'admin', keyFor(target, 'admin'), '/servers', { 'method': 'POST', body }),
      );
      return `created panel server ${show(created.name)} id=${show(created.id)} uuid=${show(created.uuid)}`;
    },
  },
];

export const capabilityNames = capabilities.map(capability => capability.name);

/**
 * Coarse sets a guild can switch off in one go (`features.tools.disabled`). `discord` is every capability
 * that talks to Discord; the rest are the areas inside it, plus `shell` for the sandboxed `bash` tool.
 */
export const TOOL_SETS = [
  'discord',
  'server',
  'channels',
  'messages',
  'threads',
  'members',
  'roles',
  'permissions',
  'invites',
  'shell',
  'git',
  'pterodactyl',
  'pterodactyl-admin',
] as const;
export type ToolSet = (typeof TOOL_SETS)[number];

/**
 * Which sets each tool belongs to. Kept as one table so the taxonomy is readable in one place; `TOOL_SETS`
 * coverage is enforced by a test, so a new capability cannot ship without deciding its sets.
 */
const SETS: Record<string, ToolSet[]> = {
  'guild_info': ['discord', 'server'],
  'channels_list': ['discord', 'channels'],
  'channel_info': ['discord', 'channels'],
  'channel_create': ['discord', 'channels'],
  'channel_update': ['discord', 'channels'],
  'channel_move': ['discord', 'channels'],
  'channel_delete': ['discord', 'channels'],
  'roles_list': ['discord', 'roles'],
  'role_assign': ['discord', 'roles'],
  'role_create': ['discord', 'roles'],
  'role_update': ['discord', 'roles'],
  'role_delete': ['discord', 'roles'],
  'member_list': ['discord', 'members'],
  'member_info': ['discord', 'members'],
  'member_timeout': ['discord', 'members'],
  'member_kick': ['discord', 'members'],
  'member_ban': ['discord', 'members'],
  'messages_fetch': ['discord', 'messages'],
  'message_send': ['discord', 'messages'],
  'message_delete': ['discord', 'messages'],
  'message_pin': ['discord', 'messages'],
  'thread_create': ['discord', 'threads'],
  'thread_update': ['discord', 'threads'],
  'permission_set': ['discord', 'permissions'],
  'invite_create': ['discord', 'invites'],
  'bash': ['shell'],
  'git_status': ['git'],
  'git_commit': ['git'],
  'git_push': ['git'],
  'git_repo_create': ['git'],
  'ptero_servers': ['pterodactyl'],
  'ptero_server': ['pterodactyl'],
  'ptero_power': ['pterodactyl'],
  'ptero_command': ['pterodactyl'],
  'ptero_files': ['pterodactyl'],
  'ptero_file_read': ['pterodactyl'],
  'ptero_file_write': ['pterodactyl'],
  'ptero_admin_servers': ['pterodactyl', 'pterodactyl-admin'],
  'ptero_admin_server': ['pterodactyl', 'pterodactyl-admin'],
  'ptero_admin_users': ['pterodactyl', 'pterodactyl-admin'],
  'ptero_admin_nodes': ['pterodactyl', 'pterodactyl-admin'],
  'ptero_admin_nests': ['pterodactyl', 'pterodactyl-admin'],
  'ptero_admin_user_create': ['pterodactyl', 'pterodactyl-admin'],
  'ptero_admin_suspend': ['pterodactyl', 'pterodactyl-admin'],
  'ptero_admin_server_create': ['pterodactyl', 'pterodactyl-admin'],
};

export const setsOf = (name: string): ToolSet[] => SETS[name] ?? [];

/** Names a guild may put in `features.tools.disabled`: one tool, or one set that covers several. */
export const toolSetNames = (): string[] => [...capabilityNames, ...TOOL_SETS];

/** Disabled by name, or by any set it belongs to. Naming a set is the "all channel tools" switch. */
export const toolDisabled = (name: string, disabled: readonly string[]): boolean =>
  disabled.includes(name) || setsOf(name).some(set => disabled.includes(set));
