import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { capabilityByName } from '@services/bridge/lookup.ts';
import { config } from '@services/config.ts';
import { db } from '@services/database/sqlite.ts';
import { capabilityAvailability } from '@services/extensions/registry.ts';
import { hardCheck } from '@services/policy/hard.ts';
import {
  POWER_SIGNALS,
  apiUrl,
  authHeaders,
  chmodMode,
  commandRequest,
  errorDetail,
  jsonRequest,
  powerRequest,
  pteroUpload,
  remoteUrl,
  safePath,
  safeRelative,
  serverAllowed,
  signedUrl,
  writeRequest,
  type PteroTarget,
} from '@services/pterodactyl/api.ts';
import { consoleLines, parseFrame, readConsole } from '@services/pterodactyl/console.ts';
import { setSecret } from '@services/secrets/store.ts';
import { renderAgentsFile, renderDiscordToolFile } from '@services/workspace/codegen.ts';
import { afterEach, describe, expect, test } from 'bun:test';

const tempDirs: string[] = [];
const savedGuildsFile = process.env.GUILDS_FILE;
/** A guild whose panel is a local stub, so the transport runs for real instead of being asserted by reading. */
const LIVE = 'ptero-live';
const LIVE_KEY = 'ptlc_livepanelkey1234';

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
  db.query('DELETE FROM guild_secrets WHERE guild_id = ?').run(LIVE);
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

  test('a name inside a directory cannot climb out of it, and a mode is octal', () => {
    expect(safeRelative('world.zip', 'file')).toBe('world.zip');
    expect(safeRelative('plugins/Essentials.jar', 'file')).toBe('plugins/Essentials.jar');
    expect(() => safeRelative('/etc/passwd', 'file')).toThrow(/relative/);
    expect(() => safeRelative('../server.properties', 'file')).toThrow(/\.\./);
    expect(() => safeRelative('  ', 'file')).toThrow(/empty/);
    // the panel wants a numeric mode, Wings then parses those digits as base 8 — so it stays octal text
    expect(chmodMode('0755')).toBe('755');
    expect(chmodMode('644')).toBe('644');
    expect(() => chmodMode('999')).toThrow(/octal/);
    expect(() => chmodMode('rwxr-xr-x')).toThrow(/octal/);
  });

  test('a pull cannot point the node at its own network', () => {
    expect(remoteUrl('https://cdn.example.com/plugin.jar')).toBe('https://cdn.example.com/plugin.jar');
    expect(() => remoteUrl('http://169.254.169.254/latest/meta-data')).toThrow(/private/);
    expect(() => remoteUrl('http://localhost:8080/x')).toThrow(/private/);
    expect(() => remoteUrl('http://10.1.2.3/x')).toThrow(/private/);
    expect(() => remoteUrl('http://192.168.0.5/x')).toThrow(/private/);
    expect(() => remoteUrl('http://[::1]/x')).toThrow(/private/);
    expect(() => remoteUrl('file:///etc/passwd')).toThrow(/http/);
    expect(() => remoteUrl('not a url')).toThrow(/http/);
  });

  test('every body except a raw file write is JSON, with the method its route wants', () => {
    const body = jsonRequest('PUT', { 'root': '/plugins', 'files': [{ 'from': 'a.jar', 'to': 'b.jar' }] });
    expect(body).toEqual({
      'method': 'PUT',
      'body': JSON.stringify({ 'root': '/plugins', 'files': [{ 'from': 'a.jar', 'to': 'b.jar' }] }),
    });
    expect(powerRequest('start')).toEqual(jsonRequest('POST', { 'signal': 'start' }));
    expect(commandRequest('say hi')).toEqual(jsonRequest('POST', { 'command': 'say hi' }));
  });

  test('a signed url the panel hands back unusable is an error, not a request', () => {
    expect(
      signedUrl(
        { 'object': 'signed_url', 'attributes': { 'url': 'https://node.test/download/file?token=x' } },
        'download',
      ),
    ).toBe('https://node.test/download/file?token=x');
    expect(() => signedUrl({ 'attributes': {} }, 'download')).toThrow(/usable download URL/);
    expect(() => signedUrl({ 'attributes': { 'url': 'javascript:alert(1)' } }, 'upload')).toThrow(/usable upload URL/);
  });

  test('wings frames are parsed and anything that is not a frame is dropped', () => {
    expect(parseFrame('{"event":"console output","args":["Done\\n"]}')).toEqual({
      'event': 'console output',
      'args': ['Done\n'],
    });
    expect(parseFrame('Starting the server')).toBeUndefined();
    expect(parseFrame('{"args":[]}')).toBeUndefined();
    expect(parseFrame('{"event":"status"}')).toEqual({ 'event': 'status', 'args': [] });
    expect(consoleLines('a\r\n\r\nb\n\n')).toEqual(['a', 'b']);
  });
});

describe('panel transport', () => {
  test('an upload is a signed node URL plus one multipart `files` field', async () => {
    const seen: { path: string; query: string; authorization: string | null }[] = [];
    const uploaded: { name: string; size: number }[] = [];
    let port = 0;
    const stub = Bun.serve({
      'port': 0,
      'hostname': '127.0.0.1',
      async fetch(request): Promise<Response> {
        const url = new URL(request.url);
        seen.push({
          'path': url.pathname,
          'query': url.searchParams.get('directory') ?? '',
          'authorization': request.headers.get('authorization'),
        });
        if (url.pathname === '/api/client/servers/srv/files/upload')
          return Response.json({
            'object': 'signed_url',
            'attributes': { 'url': `http://127.0.0.1:${port}/upload/file?token=signed` },
          });
        if (url.pathname === '/upload/file') {
          const file = (await request.formData()).get('files');
          if (file instanceof File) uploaded.push({ 'name': file.name, 'size': (await file.arrayBuffer()).byteLength });
          return new Response(null, { 'status': 204 });
        }
        return new Response('not found', { 'status': 404 });
      },
    });
    port = stub.port ?? 0;
    useGuilds({
      [LIVE]: panel({ 'files': true, 'baseUrl': `http://127.0.0.1:${port}` }),
    });
    setSecret({ 'guildId': LIVE, 'name': 'pterodactyl.clientKey', 'value': LIVE_KEY, 'by': 'test' });
    try {
      const written = await pteroUpload(LIVE, LIVE_KEY, 'srv', '/plugins', 'plugin.jar', new Uint8Array([1, 2, 3]));
      expect(written).toBe(3);
      // the panel signs, and only the panel ever sees the key
      expect(seen[0]).toMatchObject({
        'path': '/api/client/servers/srv/files/upload',
        'authorization': `Bearer ${LIVE_KEY}`,
      });
      // the bytes go to the node with the destination in the query string and no panel key
      expect(seen[1]).toMatchObject({ 'path': '/upload/file', 'query': '/plugins', 'authorization': null });
      expect(uploaded).toEqual([{ 'name': 'plugin.jar', 'size': 3 }]);
    } finally {
      stub.stop(true);
    }
  });

  test('the console is read over the node socket, with the panel as the origin', async () => {
    const socket: { origin: string; auth: string } = { 'origin': '', 'auth': '' };
    let port = 0;
    const stub = Bun.serve({
      'port': 0,
      'hostname': '127.0.0.1',
      fetch(request, server): Response | undefined {
        const url = new URL(request.url);
        if (url.pathname === '/api/client/servers/srv/websocket')
          return Response.json({
            'data': { 'token': 'jwt-token', 'socket': `ws://127.0.0.1:${port}/api/servers/uuid/ws` },
          });
        if (url.pathname === '/api/servers/uuid/ws') {
          socket.origin = request.headers.get('origin') ?? '';
          if (server.upgrade(request)) return undefined;
        }
        return new Response('not found', { 'status': 404 });
      },
      'websocket': {
        message(connection, raw) {
          socket.auth = String(raw);
          connection.send(JSON.stringify({ 'event': 'auth success' }));
          connection.send(JSON.stringify({ 'event': 'status', 'args': ['running'] }));
          connection.send(
            JSON.stringify({ 'event': 'console output', 'args': ['Done (3.21s)! For help, type "help"\n'] }),
          );
        },
        open() {},
      },
    });
    port = stub.port ?? 0;
    useGuilds({ [LIVE]: panel({ 'baseUrl': `http://127.0.0.1:${port}` }) });
    setSecret({ 'guildId': LIVE, 'name': 'pterodactyl.clientKey', 'value': LIVE_KEY, 'by': 'test' });
    try {
      const tail = await readConsole(LIVE, 'srv', { 'seconds': 10, 'lines': 1 });
      expect(tail.lines).toEqual(['Done (3.21s)! For help, type "help"']);
      expect(tail.state).toBe('running');
      expect(JSON.parse(socket.auth)).toEqual({ 'event': 'auth', 'args': ['jwt-token'] });
      // Wings refuses a socket that does not come from the panel, so the origin is the panel's own URL
      expect(socket.origin).toBe(`http://127.0.0.1:${port}`);
    } finally {
      stub.stop(true);
    }
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
    // the rule reads the tool's own `server` argument, so a newer tool is covered without a second list
    const backup = gate('g', 'ptero_backup_restore', { 'server': 'aaaa1111', 'backup': 'uuid' });
    expect(backup).toMatchObject({ 'verdict': 'deny', 'layer': 'pattern' });
    expect(backup.reason).toContain('allow-list');
  });

  test('the new client tools follow the same two switches', () => {
    useGuilds({ 'client-only': panel(), 'with-files': panel({ 'files': true }) });
    const clientOnly = renderDiscordToolFile('client-only');
    // console, activity, backups, schedules, startup and allocations are client surface, not file surface
    for (const tool of ['ptero_console', 'ptero_activity', 'ptero_backups', 'ptero_schedules', 'ptero_startup']) {
      expect(clientOnly).toContain(tool);
      expect(clientOnly).not.toContain(`ptero_file_`);
    }
    const withFiles = renderDiscordToolFile('with-files');
    for (const tool of ['ptero_file_upload', 'ptero_file_pull', 'ptero_file_delete', 'ptero_file_compress'])
      expect(withFiles).toContain(tool);

    expect(withFiles).not.toContain('ptero_admin_users');
    expect(gate('client-only', 'ptero_file_delete', { 'server': 'a', 'files': ['x'] })).toMatchObject({
      'verdict': 'deny',
      'layer': 'tools',
    });
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
    expect(capabilityByName('ptero_file_delete').risk).toBe('destructive');
    expect(capabilityByName('ptero_backup_restore').risk).toBe('destructive');
    expect(capabilityByName('ptero_file_mkdir').risk).toBe('reversible');
    expect(capabilityByName('ptero_admin_suspend').risk).toBe('destructive');
    expect(capabilityByName('ptero_admin_user_create').risk).toBe('admin');
    expect(capabilityByName('ptero_admin_server_create').risk).toBe('admin');
    expect(capabilityByName('ptero_server').risk).toBe('read');
    // reading the console or the audit trail changes nothing
    expect(capabilityByName('ptero_console').risk).toBe('read');
    expect(capabilityByName('ptero_activity').risk).toBe('read');
  });

  test('the persona states the allow-list and what does not exist', () => {
    useGuilds({
      'g': panel({ 'files': true, 'servers': ['d3aac109', '7'] }),
      'no-files': panel({ 'servers': ['d3aac109'] }),
    });
    const agents = renderAgentsFile('Test', 'g');
    expect(agents).toContain('## Pterodactyl panel');
    expect(agents).toContain('d3aac109, 7');
    expect(agents).toContain('The file tools exist here');
    expect(agents).toContain('ptero_console');
    expect(agents).toContain('No application-API tools');
    // the gaps that remain are named, so the model does not improvise around them
    expect(agents).toContain('no tool deletes a server');
    expect(renderAgentsFile('Test', 'no-files')).toContain('The file tools are off here');
  });
});
