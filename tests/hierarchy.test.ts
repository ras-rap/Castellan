import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { capabilityByName } from '@services/bridge/lookup.ts';
import { decide } from '@services/policy/gate.ts';
import { tierOf } from '@services/policy/hard.ts';
import { afterEach, describe, expect, test } from 'bun:test';

import type { GuildMember } from 'discord.js';

const temp: string[] = [];
const saved = process.env.GUILDS_FILE;
const BOT_OWNER = process.env.OWNER_ID ?? '';

const useGuilds = (guilds: Record<string, unknown>): void => {
  const dir = mkdtempSync(resolve(tmpdir(), 'castellan-hier-'));
  temp.push(dir);
  const file = resolve(dir, 'guilds.json');
  writeFileSync(file, JSON.stringify(guilds));
  process.env.GUILDS_FILE = file;
};

const member = (id: string, roleIds: string[] = [], ownerId = 'server-owner') =>
  ({
    'id': id,
    'roles': { 'cache': new Map(roleIds.map(roleId => [roleId, { 'id': roleId }])) },
    'guild': { 'ownerId': ownerId },
  }) as unknown as GuildMember;

afterEach(() => {
  if (saved === undefined) delete process.env.GUILDS_FILE;
  else process.env.GUILDS_FILE = saved;
  const { rmSync } = require('node:fs');
  for (const dir of temp.splice(0)) rmSync(dir, { 'recursive': true, 'force': true });
});

describe('the hierarchy has two ranks nothing can move', () => {
  test('a profile cannot demote or block the server owner, and cannot touch the bot owner', () => {
    useGuilds({
      'g': {
        'enabled': true,
        'roles': { 'admin': ['r-admin'] },
        'access': {
          // hostile/naive state: the server owner pinned to guest, the bot owner blocked
          'blocked': [BOT_OWNER || 'bot-owner'],
          'users': { 'server-owner': { 'rank': 'guest' }, 'some-admin': { 'rank': 'owner' } },
        },
      },
    });
    // structural ranks are read before profiles, in both directions
    expect(tierOf('g', member('server-owner'))).toBe(4);
    if (BOT_OWNER) expect(tierOf('g', member(BOT_OWNER))).toBe(4);
    // everyone else still follows their profile
    expect(tierOf('g', member('some-admin'))).toBe(4);
    expect(tierOf('g', member('plain', ['r-admin']))).toBe(3);
  });
});

describe('permissions the agent may change', () => {
  const chat = (id: string, ownerId = 'server-owner', roleIds: string[] = []) => member(id, roleIds, ownerId);

  test('a server owner can narrow their own people', async () => {
    useGuilds({ 'g': { 'enabled': true } });
    const decision = await decide('g', chat('server-owner'), capabilityByName('access_set'), {
      'user_id': 'someone',
      'key': 'tools-deny',
      'value': 'shell,git',
    });
    expect(decision.verdict).toBe('allow');
  });

  test('nobody but the bot owner can pin someone to owner', async () => {
    useGuilds({ 'g': { 'enabled': true } });
    const decision = await decide('g', chat('server-owner'), capabilityByName('access_set'), {
      'user_id': 'friend',
      'key': 'rank',
      'value': 'owner',
    });
    expect(decision.verdict).toBe('deny');
    expect(decision.reason).toContain('only the bot owner can pin');
  });

  test('a delegate cannot edit the server owner or an owner-pinned account', async () => {
    useGuilds({ 'g': { 'enabled': true, 'access': { 'users': { 'boss': { 'rank': 'owner' } } } } });
    const againstOwner = await decide('g', chat('server-owner'), capabilityByName('access_block'), {
      'user_id': 'server-owner',
      'blocked': true,
    });
    expect(againstOwner.verdict).toBe('deny');
    expect(againstOwner.reason).toContain('server owner ranks above every delegate');

    const againstPinned = await decide('g', chat('server-owner'), capabilityByName('access_set'), {
      'user_id': 'boss',
      'key': 'risk',
      'value': 'read',
    });
    expect(againstPinned.verdict).toBe('deny');
    expect(againstPinned.reason).toContain('pinned to `owner`');
  });

  test('a plain member cannot change anyone, and reads stay open', async () => {
    useGuilds({ 'g': { 'enabled': true } });
    const write = await decide('g', chat('member'), capabilityByName('access_set'), {
      'user_id': 'someone',
      'key': 'risk',
      'value': 'read',
    });
    expect(write.verdict).toBe('deny');
    const read = await decide('g', chat('member'), capabilityByName('access_show'), {});
    expect(read.verdict).toBe('allow');
  });
});
