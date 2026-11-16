import { readFileSync } from 'node:fs';

import { ensureGuardPlugin, guardPath } from '@services/workspace/guard.ts';
import { describe, expect, test } from 'bun:test';

/** The plugin file the bot hands opencode, exercised where opencode runs it: as a module in that process. */
const loadGuard = async () => {
  ensureGuardPlugin();
  // what the supervisor puts in the server's environment; the guard is inert without it
  process.env.BRIDGE_TOKEN = 'test-token';
  const module = await import(`${guardPath()}?v=${Date.now()}`);
  return module.CastellanGuard as () => Promise<Record<string, (input: any, output: any) => Promise<void>>>;
};

describe('the host-shell guard plugin', () => {
  test('is written once and does not churn on restart', () => {
    const first = ensureGuardPlugin();
    const before = readFileSync(first, 'utf8');
    expect(ensureGuardPlugin()).toBe(first);
    expect(readFileSync(first, 'utf8')).toBe(before);
  });

  test('refuses opencode’s own bash, so no command reaches the host', async () => {
    const guard = await loadGuard();
    const before = (await guard())['tool.execute.before'];
    expect(before).toBeDefined();
    await expect(before!({ 'tool': 'bash' }, { 'args': { 'command': 'echo hi' } })).rejects.toThrow(/no host shell/);
  });

  test('lets the sandboxed tool and the workspace through, and refuses paths outside it', async () => {
    const guard = await loadGuard();
    const before = (await guard())['tool.execute.before']!;
    await before({ 'tool': 'discord_shell' }, { 'args': { 'command': 'ls' } });
    await before({ 'tool': 'read' }, { 'args': { 'filePath': 'repo/index.ts' } });
    await before({ 'tool': 'edit' }, { 'args': { 'filePath': 'repo/src/a.ts' } });
    await expect(before({ 'tool': 'read' }, { 'args': { 'filePath': '../outside.txt' } })).rejects.toThrow(
      /points outside the workspace/,
    );
    await expect(before({ 'tool': 'write' }, { 'args': { 'filePath': '/etc/passwd' } })).rejects.toThrow(
      /points outside the workspace/,
    );
  });

  test('is inert when the bot did not start the server', async () => {
    const guard = await loadGuard();
    const token = process.env.BRIDGE_TOKEN;
    delete process.env.BRIDGE_TOKEN;
    try {
      // a hand-run opencode keeps its own shell: the guard exists for our sessions, not for the owner's
      expect(Object.keys(await guard())).toEqual([]);
    } finally {
      if (token !== undefined) process.env.BRIDGE_TOKEN = token;
    }
  });
});
