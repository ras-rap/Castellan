import { memoryExtension } from '@services/extensions/memory.ts';
import { capabilities } from '@services/extensions/registry.ts';
import { memory } from '@services/memory/store.ts';
import { afterEach, describe, expect, test } from 'bun:test';

import type { CapabilityContext } from '@services/extensions/protocol.ts';

const GUILD = 'mem-tool-test';

const ctx = {
  'guild': { 'id': GUILD, 'name': 'Test' },
  'actorId': 'user-1',
  'channelId': 'chan',
  'shell': async () => '',
} as unknown as CapabilityContext;

const tool = (name: string) => {
  const found = memoryExtension.capabilities.find(candidate => candidate.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};

afterEach(() => {
  for (const hit of memory.search(GUILD, '', 100)) memory.forget(GUILD, hit.id);
});

describe('memory tools', () => {
  test('the registry offers them to the bridge and the codegen', () => {
    const names = capabilities
      .filter(capability => capability.extension === 'memory')
      .map(capability => capability.name);
    expect(names.sort()).toEqual(['memory_forget', 'memory_save', 'memory_search', 'memory_stats']);
    // saving is safe to undo, forgetting is not — the gate must see that difference
    expect(tool('memory_save').risk).toBe('reversible');
    expect(tool('memory_forget').risk).toBe('destructive');
  });

  test('save → search → stats → forget round trip', async () => {
    const saved = await tool('memory_save').run(ctx, { 'text': 'deploys go to staging first', 'kind': 'preference' });
    expect(String(saved)).toContain('remembered #');
    expect(String(saved)).toContain('preference');

    const hits = await tool('memory_search').run(ctx, { 'query': 'staging' });
    expect(String(hits)).toContain('deploys go to staging first');
    const id = Number(/#(\d+)/.exec(String(hits))?.[1]);
    expect(id).toBeGreaterThan(0);

    expect(String(await tool('memory_stats').run(ctx, {}))).toContain('1 memories');

    // a corrected fact with the same key replaces the old one instead of piling up
    await tool('memory_save').run(ctx, { 'text': 'deploys go to staging, then prod', 'key': 'deploy target' });
    await tool('memory_save').run(ctx, { 'text': 'deploys go straight to prod', 'key': 'Deploy target' });
    const after = String(await tool('memory_search').run(ctx, { 'query': 'prod' }));
    expect(after).toContain('straight to prod');
    expect(after).not.toContain('staging, then prod');

    expect(String(await tool('memory_forget').run(ctx, { id }))).toBe(`forgot #${id}`);
    expect(String(await tool('memory_search').run(ctx, { 'query': 'staging first' }))).toContain('nothing in memory');
  });

  test('forgetting an id that is not there fails loudly', async () => {
    await expect(tool('memory_forget').run(ctx, { 'id': 999_999 })).rejects.toThrow('no memory #999999');
  });
});
