import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { config, paths } from '@services/config.ts';
import { permissionRisk, screenPermission } from '@services/policy/gate.ts';
import { runShell, shellModeOf, shellStatus } from '@services/workspace/shell.ts';
import { afterEach, describe, expect, test } from 'bun:test';

const tempDirs: string[] = [];
const savedGuildsFile = process.env.GUILDS_FILE;
const GUILD_HOST = `test-host-${Date.now().toString(36)}`;
const GUILD_DOCKER = `test-docker-${Date.now().toString(36)}`;

const useGuilds = (guilds: Record<string, unknown>): void => {
  const dir = mkdtempSync(resolve(tmpdir(), 'castellan-shell-'));
  tempDirs.push(dir);
  const file = resolve(dir, 'guilds.json');
  writeFileSync(file, JSON.stringify(guilds));
  process.env.GUILDS_FILE = file;
};

afterEach(() => {
  if (savedGuildsFile === undefined) delete process.env.GUILDS_FILE;
  else process.env.GUILDS_FILE = savedGuildsFile;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { 'recursive': true, 'force': true });
  for (const guild of [GUILD_HOST, GUILD_DOCKER]) {
    const workspace = resolve(paths.workspaces, guild);
    rmSync(workspace, { 'recursive': true, 'force': true });
  }
});

describe('shell mode is per server, not per deployment', () => {
  test('one guild can be on the host while the next stays sandboxed', () => {
    useGuilds({
      [GUILD_HOST]: { 'enabled': true, 'shell': { 'mode': 'host' } },
      [GUILD_DOCKER]: { 'enabled': true },
      'undeclared': { 'enabled': true },
    });

    expect(shellModeOf(GUILD_HOST)).toBe('host');
    expect(shellModeOf(GUILD_DOCKER)).toBe('docker');
    // a guild that has never been touched follows the deployment default, which is docker
    expect(shellModeOf('undeclared')).toBe('docker');
    expect(shellModeOf()).toBe(config.shellDefaults.mode);
    // the resolved mode is what the gate reasons about, so the same call is classed differently per server
    expect(config.guild(GUILD_HOST)?.shell.mode).toBe('host');
    expect(config.guild(GUILD_DOCKER)).toBeDefined();
  });

  test('host mode actually runs in the workspace, and the runner says which mode it used', async () => {
    useGuilds({ [GUILD_HOST]: { 'enabled': true, 'shell': { 'mode': 'host' } } });
    mkdirSync(resolve(paths.workspaces, GUILD_HOST), { 'recursive': true });

    const output = await runShell(GUILD_HOST, 'echo shell-mode-ok');
    expect(output).toContain('[host] exit=0');
    expect(output).toContain('shell-mode-ok');
    expect(output).not.toContain('[docker');

    // and `/status` would report this guild's mode, not the deployment default
    expect((await shellStatus(GUILD_HOST)).mode).toBe('host');
  });

  test('the permission screen charges host mode as destructive and docker as reversible', async () => {
    useGuilds({
      [GUILD_HOST]: { 'enabled': true, 'shell': { 'mode': 'host' }, 'policy': { 'mode': 'vibe' } },
      [GUILD_DOCKER]: { 'enabled': true, 'policy': { 'mode': 'vibe' } },
    });
    // both guilds refuse an unapproved destructive command shape identically…
    for (const guild of [GUILD_HOST, GUILD_DOCKER]) {
      const decision = await screenPermission({
        'guildId': guild,
        'tier': 4,
        'permission': 'bash',
        'patterns': ['rm -rf /'],
      });
      expect(decision.verdict).toBe('deny');
      expect(decision.reason).toContain('rm-root');
    }
    // …and the class the gate reasons about comes from the guild's mode, not from a global switch
    expect(permissionRisk(GUILD_DOCKER, 'bash')).toBe('reversible');
    expect(permissionRisk(GUILD_HOST, 'bash')).toBe('destructive');
    // a file edit is destructive either way: it is the sandbox that makes a shell "reversible", nothing else
    expect(permissionRisk(GUILD_HOST, 'edit')).toBe('destructive');
    expect(permissionRisk(GUILD_DOCKER, 'edit')).toBe('destructive');
    expect(permissionRisk(GUILD_HOST, 'webfetch')).toBe('reversible');
  });
});
