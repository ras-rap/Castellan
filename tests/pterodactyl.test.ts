import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { capabilityByName } from '@services/bridge/lookup.ts';
import { config } from '@services/config.ts';
import { capabilityAvailability } from '@services/extensions/registry.ts';
import { hardCheck } from '@services/policy/hard.ts';
import {
  POWER_SIGNALS,
  apiUrl,
  authHeaders,
  errorDetail,
  powerRequest,
  safePath,
  serverAllowed,
  writeRequest,
  type PteroTarget,
} from '@services/pterodactyl/api.ts';
import { renderAgentsFile, renderDiscordToolFile } from '@services/workspace/codegen.ts';
import { afterEach, describe, expect, test } from 'bun:test';

const tempDirs: string[] = [];
const savedGuildsFile = process.env.GUILDS_FILE;

const useGuilds = (guilds: Record<string, unknown>): void => {
  const dir = mkdtempSync(resolve(tmpdir(), 'castellan-ptero-'));
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

const target = (over: Partial<PteroTarget> = {}): PteroTarget => ({
  'baseUrl': 'https://panel.test',
  'clientKey': 'ptlc_test',
  'adminKey': 'ptla_test',
  'servers': [],
  'files': false,
  'admin': false,
  ...over,
});

const panel = (over: Record<string, unknown> = {}) => ({
  'enabled': true,
  'git': { 'enabled': false },
  'pterodactyl': { 'enabled': true, 'servers': [], ...over },
});

/** The gate is the authority: it must refuse what the tool list hid, even for a stale client. */
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

describe('panel requests', () => {
  test('client and application APIs use their own base path and bearer header', () => {
    expect(apiUrl(target(), 'client', '/servers')).toBe('https://panel.test/api/client/servers');
    expect(apiUrl(target(), 'admin', 'servers')).toBe('https://panel.test/api/application/servers');
    // the collection root is `/api/client`, not `/api/client/`: a trailing slash 404s on stricter panels
    expect(apiUrl(target(), 'client', '')).toBe('https://panel.test/api/client');
    const headers = authHeaders('ptlc_abc');
    expect(headers.authorization).toBe('Bearer ptlc_abc');
    expect(headers.accept).toBe('Application/vnd.pterodactyl.v1+json');
    // a file write is raw text, not JSON
    expect(writeRequest('# comment').contentType).toBe('text/plain');
    expect(JSON.parse(powerRequest('restart').body)).toEqual({ 'signal': 'restart' });
    expect(POWER_SIGNALS).toEqual(['start', 'stop', 'restart', 'kill']);
  });

  test('the panel error shape is what the model sees, not the whole body', () => {
    expect(errorDetail({ 'errors': [{ 'detail': 'Cannot send command to stopped server.' }] }, 400)).toBe(
      'Cannot send command to stopped server.',
    );
    expect(errorDetail({ 'errors': [{ 'code': 'Bad' }] }, 422)).toBe('Bad');
    expect(errorDetail('<html>', 500)).toBe('HTTP 500');
  });

  test('file paths must be absolute and cannot climb out of the server root', () => {
    expect(safePath('/plugins/config.yml', 'file')).toBe('/plugins/config.yml');
    expect(() => safePath('plugins/config.yml', 'file')).toThrow(/absolute/);
    expect(() => safePath('/plugins/../../etc/passwd', 'file')).toThrow(/\.\./);
  });

  test('the allow-list matches identifiers case-insensitively and admits everything when empty', () => {
    expect(serverAllowed(target(), 'anything')).toBe(true);
    expect(serverAllowed(target({ 'servers': ['d3aac109', '7'] }), 'D3AAC109')).toBe(true);
    expect(serverAllowed(target({ 'servers': ['d3aac109'] }), 'someone-else')).toBe(false);
  });
});

describe('panel gating', () => {
  test('no panel configured means no panel tools in the model list', () => {
    useGuilds({ 'g': { 'enabled': true } });
    const file = renderDiscordToolFile('g');
    expect(file).not.toContain('ptero_servers');
    expect(file).not.toContain('ptero_power');
    // and the gate refuses them even if a client still has them
    expect(gate('g', 'ptero_power', { 'server': 'd3aac109', 'signal': 'stop' })).toMatchObject({
      'verdict': 'deny',
      'layer': 'tools',
    });
  });

  test('admin and file tools each need their own switch', () => {
    useGuilds({
      'client-only': panel(),
      'with-files': panel({ 'files': true }),
      'with-admin': panel({ 'admin': true }),
    });

    const clientOnly = renderDiscordToolFile('client-only');
    expect(clientOnly).toContain('ptero_servers');
    expect(clientOnly).toContain('ptero_power');
    expect(clientOnly).not.toContain('ptero_files');
    expect(clientOnly).not.toContain('ptero_admin_servers');

    expect(renderDiscordToolFile('with-files')).toContain('ptero_file_write');
    expect(renderDiscordToolFile('with-files')).not.toContain('ptero_admin_users');
    expect(renderDiscordToolFile('with-admin')).toContain('ptero_admin_users');

    expect(gate('client-only', 'ptero_file_write', { 'server': 'a', 'file': '/x', 'content': 'y' })).toMatchObject({
      'verdict': 'deny',
      'layer': 'tools',
    });
    expect(gate('client-only', 'ptero_admin_suspend', { 'id': '7', 'action': 'suspend' })).toMatchObject({
      'verdict': 'deny',
      'layer': 'tools',
    });
  });

  test('the server allow-list is enforced in code, before any request', () => {
    useGuilds({ 'g': panel({ 'servers': ['d3aac109'] }) });
    expect(gate('g', 'ptero_power', { 'server': 'd3aac109', 'signal': 'stop' }).verdict).toBe('allow');
    const other = gate('g', 'ptero_power', { 'server': 'aaaa1111', 'signal': 'stop' });
    expect(other.verdict).toBe('deny');
    expect(other.layer).toBe('pattern');
    expect(other.reason).toContain('allow-list');
  });

  test('the tool set is switchable like any other, and the risk classes are honest', () => {
    useGuilds({
      'off': {
        'enabled': true,
        'features': { 'tools': { 'disabled': ['pterodactyl'] } },
        'pterodactyl': { 'enabled': true },
      },
      'admin-only-off': { 'enabled': true, 'pterodactyl': { 'enabled': true, 'admin': true } },
    });
    expect(renderDiscordToolFile('off')).not.toContain('ptero_servers');
    // one name hides the client surface; the admin set stays behind its own switch
    expect(renderDiscordToolFile('admin-only-off')).toContain('ptero_admin_users');

    expect(capabilityByName('ptero_power').risk).toBe('destructive');
    expect(capabilityByName('ptero_command').risk).toBe('destructive');
    expect(capabilityByName('ptero_file_write').risk).toBe('destructive');
    expect(capabilityByName('ptero_admin_suspend').risk).toBe('destructive');
    expect(capabilityByName('ptero_admin_user_create').risk).toBe('admin');
    expect(capabilityByName('ptero_admin_server_create').risk).toBe('admin');
    expect(capabilityByName('ptero_server').risk).toBe('read');
  });

  test('the persona states the allow-list and what does not exist', () => {
    useGuilds({
      'g': panel({ 'files': true, 'servers': ['d3aac109', '7'] }),
    });
    const agents = renderAgentsFile('Test', 'g');
    expect(agents).toContain('## Pterodactyl panel');
    expect(agents).toContain('d3aac109, 7');
    expect(agents).toContain('There is no delete');
    expect(agents).toContain('`ptero_file_write` exist here');
    expect(agents).toContain('No application-API tools');
  });
});
