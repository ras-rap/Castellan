import { accessGuard, guildEnabled, guildOnly, ownerOnly } from '@guards/index.ts';
import { config, guildDefaults, type GuildSettings, type UserAccess } from '@services/config.ts';
import { parseProfileValue } from '@services/policy/access.ts';
import { readSetting, setSetting } from '@services/policy/dotted.ts';
import { PROFILE_KEYS, profilePath, type ProfileKey } from '@services/policy/profile.ts';
import { BRAND_COLOR, EPHEMERAL } from '@utils/constants.ts';
import { log } from '@utils/logger.ts';
import { ApplicationCommandOptionType, EmbedBuilder } from 'discord.js';
import { Discord, Guard, Slash, SlashChoice, SlashGroup, SlashOption } from 'discordx';

import type { ChatInputCommandInteraction, User } from 'discord.js';

const logger = log('commands/access');

/**
 * Per-account permissions. Owner-only: a profile can pin a rank, which grants capability, so handing that to a
 * guild admin would be a privilege escalation path. Everyone else is limited to what `/config` allows.
 */
const describe = (profile: UserAccess): string => {
  const parts: string[] = [];
  if (profile.rank) parts.push(`rank **${profile.rank}**`);
  if (profile.risk) parts.push(`max risk **${profile.risk}**`);
  if (profile.tools.allow.length > 0) parts.push(`tools only ${profile.tools.allow.join(', ')}`);
  if (profile.tools.deny.length > 0) parts.push(`no tools ${profile.tools.deny.join(', ')}`);
  if (profile.commands.allow.length > 0) parts.push(`commands only ${profile.commands.allow.join(', ')}`);
  if (profile.commands.deny.length > 0) parts.push(`no commands ${profile.commands.deny.join(', ')}`);
  return parts.length === 0 ? '_no restrictions_' : parts.join(' · ');
};

const current = (guildId: string): GuildSettings => config.guild(guildId) ?? guildDefaults();

async function save(interaction: ChatInputCommandInteraction, next: GuildSettings, note: string): Promise<void> {
  config.patchGuild(interaction.guildId ?? '', { ...next });
  logger.info('access changed', { 'guildId': interaction.guildId, 'by': interaction.user.id, 'note': note });
  await interaction.reply({ 'content': `✅ ${note}`, 'flags': EPHEMERAL });
}

@Discord()
@SlashGroup({ 'name': 'access', 'description': 'Per-account permissions in this server' })
export class AccessCommand {
  @Slash({ 'name': 'show', 'description': 'Who is blocked here, and what each profile allows' })
  @SlashGroup('access')
  @Guard(accessGuard, guildOnly, guildEnabled)
  async show(
    @SlashOption({
      'name': 'user',
      'description': 'show one account instead of the whole list',
      'required': false,
      'type': ApplicationCommandOptionType.User,
    })
    user: User | undefined,
    interaction: ChatInputCommandInteraction,
  ) {
    const guildId = interaction.guildId ?? '';
    const access = config.access(guildId);
    const embed = new EmbedBuilder().setTitle('access').setColor(BRAND_COLOR);

    if (user) {
      const profile = access.users[user.id];
      const blocked = access.blocked.includes(user.id);
      embed.addFields({
        'name': `${user.username} (${user.id})`,
        'value': `blocked: **${blocked ? 'yes' : 'no'}**\n${profile ? describe(profile) : '_no profile — guild defaults apply_'}`,
      });
    } else {
      embed.addFields({
        'name': 'blocked',
        'value': access.blocked.length > 0 ? access.blocked.map(id => `<@${id}> (\`${id}\`)`).join('\n') : '_nobody_',
      });
      const entries = Object.entries(access.users).slice(0, 12);
      for (const [id, profile] of entries)
        embed.addFields({ 'name': `<@${id}>`, 'value': describe(profile), 'inline': false });
      if (Object.keys(access.users).length > entries.length)
        embed.setFooter({ 'text': `+${Object.keys(access.users).length - entries.length} more profiles` });
      if (entries.length === 0) embed.addFields({ 'name': 'profiles', 'value': '_none — everyone gets their rank_' });
    }

    embed.setFooter({
      'text': '/access set user <key> <value> · /access block user · keys are rank, risk, tools-*, commands-*',
    });
    await interaction.reply({ 'embeds': [embed], 'flags': EPHEMERAL });
  }

  @Slash({ 'name': 'block', 'description': 'Refuse everything this account asks (owner only)' })
  @SlashGroup('access')
  @Guard(accessGuard, guildOnly, guildEnabled, ownerOnly)
  async block(
    @SlashOption({
      'name': 'user',
      'description': 'account to block',
      'required': true,
      'type': ApplicationCommandOptionType.User,
    })
    user: User,
    interaction: ChatInputCommandInteraction,
  ) {
    const next = current(interaction.guildId ?? '');
    const blocked = [...new Set([...next.access.blocked, user.id])];
    await save(
      interaction,
      setSetting(next, 'access.blocked', blocked),
      `blocked \`${user.id}\` — it can no longer talk to the bot or run commands`,
    );
  }

  @Slash({ 'name': 'unblock', 'description': 'Let a blocked account back in (owner only)' })
  @SlashGroup('access')
  @Guard(accessGuard, guildOnly, guildEnabled, ownerOnly)
  async unblock(
    @SlashOption({
      'name': 'user',
      'description': 'account to unblock',
      'required': true,
      'type': ApplicationCommandOptionType.User,
    })
    user: User,
    interaction: ChatInputCommandInteraction,
  ) {
    const next = current(interaction.guildId ?? '');
    if (!next.access.blocked.includes(user.id)) {
      await interaction.reply({ 'content': `<@${user.id}> is not blocked`, 'flags': EPHEMERAL });
      return;
    }
    const blocked = next.access.blocked.filter(id => id !== user.id);
    await save(
      interaction,
      setSetting(next, 'access.blocked', blocked.length === 0 ? undefined : blocked),
      `unblocked \`${user.id}\``,
    );
  }

  @Slash({ 'name': 'set', 'description': 'Set one rule for one account (owner only)' })
  @SlashGroup('access')
  @Guard(accessGuard, guildOnly, guildEnabled, ownerOnly)
  async set(
    @SlashOption({
      'name': 'user',
      'description': 'account to configure',
      'required': true,
      'type': ApplicationCommandOptionType.User,
    })
    user: User,
    @SlashOption({
      'name': 'key',
      'description': 'which rule',
      'required': true,
      'type': ApplicationCommandOptionType.String,
    })
    @SlashChoice({ 'name': 'rank', 'value': 'rank' })
    @SlashChoice({ 'name': 'risk', 'value': 'risk' })
    @SlashChoice({ 'name': 'tools-allow', 'value': 'tools-allow' })
    @SlashChoice({ 'name': 'tools-deny', 'value': 'tools-deny' })
    @SlashChoice({ 'name': 'commands-allow', 'value': 'commands-allow' })
    @SlashChoice({ 'name': 'commands-deny', 'value': 'commands-deny' })
    key: string,
    @SlashOption({
      'name': 'value',
      'description': 'rank/risk name, or a comma-separated list; "none" clears it',
      'required': true,
      'type': ApplicationCommandOptionType.String,
    })
    value: string,
    interaction: ChatInputCommandInteraction,
  ) {
    const profileKey = PROFILE_KEYS.find(entry => entry === key) as ProfileKey | undefined;
    if (!profileKey) {
      await interaction.reply({ 'content': `unknown key \`${key}\``, 'flags': EPHEMERAL });
      return;
    }

    const cleared = value.trim().length === 0 || value.trim().toLowerCase() === 'none';
    let parsed: unknown;
    try {
      parsed = cleared ? undefined : await parseProfileValue(profileKey, value);
    } catch (error) {
      await interaction.reply({
        'content': `⚠️ ${error instanceof Error ? error.message : String(error)}`,
        'flags': EPHEMERAL,
      });
      return;
    }

    const next = setSetting(current(interaction.guildId ?? ''), profilePath(user.id, profileKey), parsed);
    const shown = readSetting(next, profilePath(user.id, profileKey));
    await save(
      interaction,
      next,
      `\`${profileKey}\` for \`${user.id}\` → ${shown === undefined ? '_cleared_' : `\`${JSON.stringify(shown)}\``}`,
    );
  }

  @Slash({ 'name': 'clear', 'description': 'Remove an account profile, back to guild defaults (owner only)' })
  @SlashGroup('access')
  @Guard(accessGuard, guildOnly, guildEnabled, ownerOnly)
  async clear(
    @SlashOption({
      'name': 'user',
      'description': 'account whose profile is removed',
      'required': true,
      'type': ApplicationCommandOptionType.User,
    })
    user: User,
    interaction: ChatInputCommandInteraction,
  ) {
    const next = setSetting(current(interaction.guildId ?? ''), `access.users.${user.id}`, undefined);
    await save(interaction, next, `profile for \`${user.id}\` cleared — guild defaults apply again`);
  }
}
