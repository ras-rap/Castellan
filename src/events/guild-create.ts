import { registerCommandsForGuild } from '@cli/commands/deploy.ts';
import { config } from '@services/config.ts';
import { log } from '@utils/logger.ts';
import { Events } from 'discord.js';
import { Discord, On } from 'discordx';

import type { Guild } from 'discord.js';

const logger = log('events/guild-create');

/**
 * A guild that invites the bot gets the slash commands straight away when `COMMAND_SCOPE=all` (the default
 * outside development). Without this, commands only appear after the next restart — which is exactly the
 * "it only works in one server" surprise.
 */
@Discord()
export class GuildCreateEvent {
  @On({ 'event': Events.GuildCreate })
  async onGuildCreate([guild]: [Guild]) {
    logger.info('joined guild', { 'guildId': guild.id, 'name': guild.name, 'members': guild.memberCount });
    const registered = await registerCommandsForGuild(guild.id);
    if (!registered) logger.info('commands not registered here (COMMAND_SCOPE is not "all")', { 'guildId': guild.id });
    // The workspace is created on first use; nothing is provisioned until someone actually asks for work.
    if (!config.guild(guild.id))
      logger.info('guild is not enabled yet — an owner runs `/enable`', { 'guildId': guild.id });
  }
}
