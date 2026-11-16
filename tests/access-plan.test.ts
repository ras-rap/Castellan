import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { capabilityByName } from '@services/bridge/lookup.ts';
import { config } from '@services/config.ts';
import { clearProposals } from '@services/policy/proposals.ts';
import { afterEach, describe, expect, test } from 'bun:test';

const temp: string[] = [];
const saved = process.env.GUILDS_FILE;

const useGuilds = (guilds: Record<string, unknown>): void => {
  const dir = mkdtempSync(resolve(tmpdir(), 'castellan-plan-'));
  temp.push(dir);
  const file = resolve(dir, 'guilds.json');
  writeFileSync(file, JSON.stringify(guilds));
  process.env.GUILDS_FILE = file;
};

const run = (guildId: string, tool: string, args: Record<string, unknown> = {}) =>
  capabilityByName(tool).run({ 'guild': { 'id': guildId } } as never, args);

afterEach(() => {
  clearProposals();
  if (saved === undefined) delete process.env.GUILDS_FILE;
  else process.env.GUILDS_FILE = saved;
  for (const dir of temp.splice(0)) rmSync(dir, { 'recursive': true, 'force': true });
});

describe('a permission change is planned, shown, then applied', () => {
  test('the plan describes the change and writes nothing', async () => {
    useGuilds({ 'g': { 'enabled': true } });
    const output = await run('g', 'access_plan', {
      'user_id': 'user1',
      'allow': 'messages_fetch,channels_list',
      'deny': 'channel_delete',
      'risk': 'read',
    });
    expect(output).toContain('nothing written yet');
    expect(output).toContain(
      'proposed: max risk read · tools only messages_fetch, channels_list · tools denied channel_delete',
    );
    expect(output).toContain('tools.allow +messages_fetch, channels_list');
    expect(output).toContain('Show this diff and ask for an explicit yes');
    // nothing reached the config
    expect(config.access('g').users['user1']).toBeUndefined();
  });

  test('applying writes exactly what was shown, in one go', async () => {
    useGuilds({ 'g': { 'enabled': true } });
    await run('g', 'access_plan', { 'user_id': 'user1', 'allow': 'messages_fetch', 'risk': 'read' });
    const applied = await run('g', 'access_apply', { 'user_id': 'user1' });
    expect(applied).toContain('applied for user1');
    const profile = config.access('g').users['user1'];
    expect(profile?.tools.allow).toEqual(['messages_fetch']);
    expect(profile?.risk).toBe('read');
  });

  test('a change cannot be applied without having been planned', async () => {
    useGuilds({ 'g': { 'enabled': true } });
    await expect(run('g', 'access_apply', { 'user_id': 'user2' })).rejects.toThrow(/no plan for user2/);
    expect(config.access('g').users['user2']).toBeUndefined();
  });

  test('a plan applies once, and the diff says when nothing would change', async () => {
    useGuilds({ 'g': { 'enabled': true, 'access': { 'users': { 'user1': { 'risk': 'read' } } } } });
    const plan = await run('g', 'access_plan', { 'user_id': 'user1', 'risk': 'read' });
    expect(plan).toContain('no change');
    await run('g', 'access_apply', { 'user_id': 'user1' });
    await expect(run('g', 'access_apply', { 'user_id': 'user1' })).rejects.toThrow(/no plan/);
  });

  test('the plan validates names the same way the slash command does', async () => {
    useGuilds({ 'g': { 'enabled': true } });
    await expect(run('g', 'access_plan', { 'user_id': 'user1', 'allow': 'not_a_tool' })).rejects.toThrow(/not a tool/);
    await expect(run('g', 'access_plan', { 'user_id': 'user1', 'risk': 'sometimes' })).rejects.toThrow(
      /must be one of/,
    );
    // and a failed plan leaves nothing to apply
    await expect(run('g', 'access_apply', { 'user_id': 'user1' })).rejects.toThrow(/no plan/);
  });
});
