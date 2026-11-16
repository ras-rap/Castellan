import { importx } from '@discordx/importer';
import { DISCORD_CLIENT_ID, DISCORD_TOKEN, IS_PRODUCTION, optionalEnv } from '@utils/env.ts';
import { log } from '@utils/logger.ts';
import { REST, Routes } from 'discord.js';
import { Client } from 'discordx';

import { buildCommandMetadata } from './registry.ts';

import type { DeployScope } from './registry.ts';
import type { ApplicationCommandDataResolvable } from 'discord.js';

const logger = log('cli/deploy');

const rest = new REST({ 'version': '10' }).setToken(DISCORD_TOKEN);

export type DeployFlags = { scope?: DeployScope; force?: boolean };

/** Where a payload goes: the global command list, or one guild's. */
export type CommandTarget = { kind: 'global' } | { kind: 'guild'; guildId: string };

export type DeployPlan = {
  scope: DeployScope;
  register: CommandTarget[];
  /** Scopes to empty, so the same command never appears twice (global + guild commands stack in the UI). */
  clear: CommandTarget[];
};

/**
 * Which scope this deployment writes to. `COMMAND_SCOPE` wins; otherwise a development guild is used for the
 * fast feedback loop, and every server the bot is in gets the commands (`all`) — one guild is a special case of
 * that, not the default.
 */
export function resolveScope(override?: DeployScope): DeployScope {
  if (override) return override;
  const configured = optionalEnv('COMMAND_SCOPE')?.toLowerCase();
  if (configured === 'guild' || configured === 'global' || configured === 'all') return configured;
  if (configured) logger.warn('COMMAND_SCOPE is not one of guild, global, all; ignoring it', { configured });
  const developmentGuild = optionalEnv('DISCORD_DEVELOPMENT_GUILD_ID', 'REGISTER_GUILD_ID');
  return developmentGuild && !IS_PRODUCTION ? 'guild' : 'all';
}

/**
 * The registration plan, kept pure so it is testable without Discord. `all` means "every guild the bot is in";
 * a bot in no guilds registers globally instead, which is where a fresh install starts.
 */
export function planDeployment(input: {
  scope: DeployScope;
  developmentGuildId?: string;
  guildIds: readonly string[];
}): DeployPlan {
  const globals: CommandTarget = { 'kind': 'global' };
  const inGuild = (guildId: string): CommandTarget => ({ 'kind': 'guild', guildId });
  const dev = input.developmentGuildId;

  switch (input.scope) {
    case 'guild':
      // Development scope touches exactly one guild and the global list. It must not clear other servers: a
      // developer running against a production token would wipe every real guild's commands.
      return { 'scope': input.scope, 'register': dev ? [inGuild(dev)] : [], 'clear': [globals] };
    case 'global':
      // Any guild-level copy would duplicate every command in that guild, so they all go.
      return { 'scope': input.scope, 'register': [globals], 'clear': input.guildIds.map(inGuild) };
    case 'all':
      return input.guildIds.length > 0
        ? { 'scope': input.scope, 'register': input.guildIds.map(inGuild), 'clear': [globals] }
        : { 'scope': input.scope, 'register': [globals], 'clear': [] };
  }
}

const routeFor = (target: CommandTarget): `/${string}` =>
  target.kind === 'global'
    ? Routes.applicationCommands(DISCORD_CLIENT_ID)
    : Routes.applicationGuildCommands(DISCORD_CLIENT_ID, target.guildId);

const labelFor = (target: CommandTarget): string =>
  target.kind === 'global' ? 'globally' : `to guild ${target.guildId}`;

/** Guilds the bot is a member of, straight from REST — this runs before the gateway is connected. */
async function guildIdsFromRest(): Promise<string[]> {
  try {
    const guilds = (await rest.get(Routes.userGuilds())) as Array<{ id: string }>;
    return guilds.map(guild => guild.id);
  } catch (error) {
    logger.warn('could not list guilds; falling back to global registration', {
      'error': String(error).slice(0, 200),
    });
    return [];
  }
}

const payloadFor = () =>
  Client.applicationCommandSlashes.map(command => command.toJSON()) as ApplicationCommandDataResolvable[];

/**
 * Publishes the decorated commands to exactly one *scope* — global, one guild, or every guild the bot is in
 * (`all`, the default outside development). The other scopes are emptied, because Discord lists global and
 * guild commands as separate entries and the duplicate is what makes every command appear twice.
 */
export async function syncCommands(flags: DeployFlags = {}): Promise<void> {
  // Loading the decorations must happen here, not at module scope: `main.ts` imports this module for its
  // boot-time sync, and module-scope work would run before `events/` is imported.
  await importx(`${import.meta.dirname}/../../{commands,guards}/**/*.ts`);
  await buildCommandMetadata();
  const payload = payloadFor();
  const scope = resolveScope(flags.scope);
  const developmentGuildId = optionalEnv('DISCORD_DEVELOPMENT_GUILD_ID', 'REGISTER_GUILD_ID');
  const plan = planDeployment({
    scope,
    ...(developmentGuildId ? { developmentGuildId } : {}),
    'guildIds': scope === 'guild' ? [] : await guildIdsFromRest(),
  });

  try {
    const stale: string[] = [];
    for (const target of plan.register) {
      if (!flags.force) {
        const remote = await rest.get(routeFor(target)).catch(() => undefined);
        if (Array.isArray(remote) && JSON.stringify(remote) === JSON.stringify(payload)) continue;
      }
      await rest.put(routeFor(target), { 'body': payload });
      logger.info(`✅ registered ${payload.length} command(s) ${labelFor(target)}`);
    }
    for (const target of plan.clear) {
      const remote = await rest.get(routeFor(target)).catch(() => undefined);
      if (Array.isArray(remote) && remote.length === 0) continue;
      await rest.put(routeFor(target), { 'body': [] });
      stale.push(labelFor(target));
    }
    if (stale.length > 0) logger.info('cleared duplicate command scope(s)', { stale });
    if (plan.register.length === 0) logger.warn('nothing to register to: set COMMAND_SCOPE or invite the bot');
  } catch (error) {
    logger.error('failed to register commands', { 'error': String(error).slice(0, 300), scope });
    throw error;
  }
}

/** Used when the bot joins a guild while `COMMAND_SCOPE=all`: that guild gets the commands immediately. */
export async function registerCommandsForGuild(guildId: string): Promise<boolean> {
  if (resolveScope() !== 'all') return false;
  try {
    await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, guildId), { 'body': payloadFor() });
    logger.info('registered commands in a newly joined guild', { guildId });
    return true;
  } catch (error) {
    logger.warn('could not register commands in a newly joined guild', {
      guildId,
      'error': String(error).slice(0, 200),
    });
    return false;
  }
}
