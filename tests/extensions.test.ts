import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { capabilityByName } from '@services/bridge/lookup.ts';
import { config } from '@services/config.ts';
import {
  EXTENSIONS,
  TOOL_SETS,
  capabilityAvailability,
  capabilityNames,
  capabilities,
  extensionOf,
  extensionStatus,
  setsOf,
  toolListed,
} from '@services/extensions/registry.ts';
import { hardCheck } from '@services/policy/hard.ts';
import { domainOf, parseSetting } from '@services/policy/settings.ts';
import { renderAgentsFile, renderDiscordToolFile } from '@services/workspace/codegen.ts';
import { afterEach, describe, expect, test } from 'bun:test';

const tempDirs: string[] = [];
const savedGuildsFile = process.env.GUILDS_FILE;

const useGuilds = (guilds: Record<string, unknown>): void => {
  const dir = mkdtempSync(resolve(tmpdir(), 'castellan-ext-'));
  tempDirs.push(dir);
  const file = resolve(dir, 'guilds.json');
  writeFileSync(file, JSON.stringify(guilds));
  process.env.GUILDS_FILE = file;
};

afterEach(() => {
  if (savedGuildsFile === undefined) delete process.env.GUILDS_FILE;
  else process.env.GUILDS_FILE = savedGuildsFile;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { 'recursive': true, 'force': true });
});

const gate = (guildId: string, tool: string, args: Record<string, unknown> = {}) =>
  hardCheck({
    'tier': 4,
    'capability': capabilityByName(tool),
    args,
    'policy': config.policy(guildId),
    'features': config.features(guildId),
    'pterodactyl': config.pterodactyl(guildId),
    'available': (name: string) => capabilityAvailability(guildId, name),
  });

describe('the extension registry', () => {
  test('every tool belongs to exactly one extension, and every set resolves', () => {
    for (const extension of EXTENSIONS) expect(extension.capabilities.length).toBeGreaterThan(0);
    // ids are unique, so `features.extensions.disabled` cannot be ambiguous
    const ids = EXTENSIONS.map(extension => extension.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(capabilities.length).toBe(EXTENSIONS.reduce((total, extension) => total + extension.capabilities.length, 0));

    for (const capability of capabilities) {
      expect(capability.extension.length).toBeGreaterThan(0);
      expect(capability.sets[0]).toBe(capability.extension);
      expect(extensionOf(capability.name)).toBe(capability.extension);
      // every declared set is a name a guild may write in a tool list
      for (const set of setsOf(capability.name)) expect(TOOL_SETS).toContain(set);
    }
    // and _every_ extension is itself a set, which is what makes "switch off discord" a one-word answer
    for (const id of ids) expect(TOOL_SETS).toContain(id);
    expect(capabilityNames.length).toBe(new Set(capabilityNames).size);
  });

  test('the shipped extensions and their reach', () => {
    expect(EXTENSIONS.map(extension => extension.id)).toEqual([
      'discord',
      'access',
      'shell',
      'git',
      'pterodactyl',
      'memory',
    ]);
    expect(setsOf('channel_delete')).toEqual(['discord', 'channels']);
    expect(setsOf('shell')).toEqual(['shell']);
    expect(setsOf('git_push')).toEqual(['git']);
    expect(setsOf('ptero_power')).toEqual(['pterodactyl']);
    expect(setsOf('memory_save')).toEqual(['memory']);
    expect(setsOf('ptero_admin_suspend')).toEqual(['pterodactyl', 'pterodactyl-admin']);
    // an extension id is a set, so `features.tools.disabled: ["pterodactyl"]` covers both halves
    expect(toolListed('ptero_admin_suspend', ['pterodactyl'])).toBe(true);
    expect(toolListed('ptero_admin_suspend', ['pterodactyl-admin'])).toBe(true);
    expect(toolListed('ptero_power', ['pterodactyl-admin'])).toBe(false);
  });

  test('status is resolved per server, from that server’s switches and configuration', () => {
    useGuilds({
      'plain': { 'enabled': true },
      'no-git': { 'enabled': true, 'features': { 'extensions': { 'disabled': ['git'] } } },
      'panel': { 'enabled': true, 'pterodactyl': { 'enabled': true } },
      'panel-admin': { 'enabled': true, 'pterodactyl': { 'enabled': true, 'admin': true, 'files': true } },
    });

    const plain = extensionStatus('plain');
    expect(plain.find(entry => entry.id === 'shell')).toMatchObject({ 'enabled': true, 'available': true });
    // no git server and no panel keys in this deployment: present as extensions, not available to be used
    expect(plain.find(entry => entry.id === 'git')).toMatchObject({ 'enabled': true, 'available': true });
    expect(plain.find(entry => entry.id === 'pterodactyl')).toMatchObject({ 'enabled': true, 'available': false });

    expect(extensionStatus('no-git').find(entry => entry.id === 'git')?.enabled).toBe(false);
    expect(extensionStatus('panel').find(entry => entry.id === 'pterodactyl')?.available).toBe(true);
    // the admin/file halves are tools, not extensions, so the extension is "available" either way
    expect(capabilityAvailability('panel', 'ptero_servers').ok).toBe(true);
    expect(capabilityAvailability('panel', 'ptero_admin_users').ok).toBe(false);
    expect(capabilityAvailability('panel', 'ptero_file_write').ok).toBe(false);
    expect(capabilityAvailability('panel-admin', 'ptero_admin_users').ok).toBe(true);
    expect(capabilityAvailability('panel-admin', 'ptero_file_write').ok).toBe(true);
  });
});

describe('switching an extension off is one setting, per server', () => {
  test('it disappears from that server’s tool list and is refused by the gate', () => {
    useGuilds({
      'with-shell': { 'enabled': true },
      'no-shell': { 'enabled': true, 'features': { 'extensions': { 'disabled': ['shell'] } } },
    });

    expect(renderDiscordToolFile('with-shell')).toContain('export const shell');
    const stripped = renderDiscordToolFile('no-shell');
    expect(stripped).not.toContain('export const shell');
    expect(stripped).toContain('export const channel_delete');

    const refused = gate('no-shell', 'shell', { 'command': 'ls' });
    expect(refused.verdict).toBe('deny');
    expect(refused.layer).toBe('tools');
    expect(refused.reason).toContain('shell extension is switched off');
    // the same call is fine on the server that kept it
    expect(gate('with-shell', 'shell', { 'command': 'ls' }).verdict).toBe('allow');
  });

  test('the setting is validated, offered as a multi-choice, and the persona says what is gone', () => {
    useGuilds({ 'g': { 'enabled': true } });
    expect(parseSetting('features.extensions.disabled', 'git,pterodactyl')).toEqual(['git', 'pterodactyl']);
    expect(() => parseSetting('features.extensions.disabled', 'git,not_an_extension')).toThrow(/not an extension/);
    expect(domainOf('features.extensions.disabled')).toMatchObject({
      'kind': 'multi',
      'choices': EXTENSIONS.map(extension => extension.id),
    });

    useGuilds({ 'g': { 'enabled': true, 'features': { 'extensions': { 'disabled': ['git'] } } } });
    const agents = renderAgentsFile('Test', 'g');
    expect(agents).toContain('features.extensions.disabled');
    expect(agents).toContain('`git`');
    expect(agents).toContain('that whole extension is gone');
  });

  test('a per-account list can name an extension too', () => {
    useGuilds({
      'g': { 'enabled': true, 'access': { 'users': { 'u': { 'tools': { 'deny': ['pterodactyl'] } } } } },
    });
    // the account profile is checked first, so an extension name in `tools.deny` covers every panel tool
    const decision = hardCheck({
      'tier': 4,
      'capability': capabilityByName('ptero_power'),
      'args': { 'server': 'x', 'signal': 'stop' },
      'policy': config.policy('g'),
      'features': config.features('g'),
      'pterodactyl': config.pterodactyl('g'),
      'available': (name: string) => capabilityAvailability('g', name),
      'account': { 'blocked': false, 'profile': config.access('g').users['u'] },
    });
    expect(decision.verdict).toBe('deny');
    expect(decision.reason).toContain('user-tools');
  });
});
