import { planDeployment, resolveScope } from '@cli/commands/deploy.ts';
import { afterEach, describe, expect, test } from 'bun:test';

const saved = {
  'scope': process.env.COMMAND_SCOPE,
  'guild': process.env.DISCORD_DEVELOPMENT_GUILD_ID,
  'register': process.env.REGISTER_GUILD_ID,
  'prod': process.env.NODE_ENV,
};

afterEach(() => {
  for (const [key, value] of [
    ['COMMAND_SCOPE', saved.scope],
    ['DISCORD_DEVELOPMENT_GUILD_ID', saved.guild],
    ['REGISTER_GUILD_ID', saved.register],
    ['NODE_ENV', saved.prod],
  ] as const)
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});

describe('where commands are published', () => {
  test('one guild is a special case of every guild, not the default', () => {
    delete process.env.COMMAND_SCOPE;
    delete process.env.DISCORD_DEVELOPMENT_GUILD_ID;
    delete process.env.REGISTER_GUILD_ID;
    process.env.NODE_ENV = 'production';
    // a bot in several servers registers in all of them — this is what "only one server" got wrong
    expect(resolveScope()).toBe('all');
    expect(resolveScope('global')).toBe('global');
  });

  test('the development guild still wins outside production, and the env knob still wins', () => {
    delete process.env.COMMAND_SCOPE;
    process.env.REGISTER_GUILD_ID = '111';
    process.env.NODE_ENV = 'development';
    expect(resolveScope()).toBe('guild');
    process.env.COMMAND_SCOPE = 'all';
    expect(resolveScope()).toBe('all');
    process.env.COMMAND_SCOPE = 'nonsense';
    expect(resolveScope()).toBe('guild');
  });

  test('`all` registers in every guild and clears the global list', () => {
    const plan = planDeployment({ 'scope': 'all', 'guildIds': ['1', '2', '3'] });
    expect(plan.register).toEqual([
      { 'kind': 'guild', 'guildId': '1' },
      { 'kind': 'guild', 'guildId': '2' },
      { 'kind': 'guild', 'guildId': '3' },
    ]);
    expect(plan.clear).toEqual([{ 'kind': 'global' }]);
  });

  test('a bot in no guilds falls back to global instead of registering nowhere', () => {
    expect(planDeployment({ 'scope': 'all', 'guildIds': [] })).toEqual({
      'scope': 'all',
      'register': [{ 'kind': 'global' }],
      'clear': [],
    });
  });

  test('global clears every guild copy, and the dev guild does not touch other servers', () => {
    expect(planDeployment({ 'scope': 'global', 'guildIds': ['1', '2'] })).toEqual({
      'scope': 'global',
      'register': [{ 'kind': 'global' }],
      'clear': [
        { 'kind': 'guild', 'guildId': '1' },
        { 'kind': 'guild', 'guildId': '2' },
      ],
    });
    // a developer deploying to their dev guild must never wipe production guilds
    expect(planDeployment({ 'scope': 'guild', 'developmentGuildId': 'dev', 'guildIds': ['1', '2'] })).toEqual({
      'scope': 'guild',
      'register': [{ 'kind': 'guild', 'guildId': 'dev' }],
      'clear': [{ 'kind': 'global' }],
    });
  });
});
