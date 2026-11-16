import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { config } from '@services/config.ts';
import { db, sessions } from '@services/database/sqlite.ts';
import { services } from '@services/discord/services.ts';
import { authenticate, clearJwksCache, issuerFromPublishableKey, verifyJwt, type Jwks } from '@services/web/auth.ts';
import {
  canEditSetting,
  canManageAccess,
  isBotWide,
  resolvePrincipal,
  visibleGuilds,
  type Principal,
  type WebConfig,
} from '@services/web/principals.ts';
import { startWeb } from '@services/web/server.ts';
import { afterEach, describe, expect, test } from 'bun:test';

const ISSUER = 'https://clerk.test';
const tempDirs: string[] = [];
const savedGuildsFile = process.env.GUILDS_FILE;
const realFetch = globalThis.fetch;

/** A publishable key is the base64 Frontend API host: this is exactly what Clerk hands out (`pk_test_…$`). */
const publishableKey = (host: string): string => `pk_test_${Buffer.from(`${host}$`).toString('base64')}`;

const keyPair = async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      'name': 'RSASSA-PKCS1-v1_5',
      'modulusLength': 2048,
      'publicExponent': new Uint8Array([1, 0, 1]),
      'hash': 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as Record<string, unknown>;
  return { pair, 'jwks': { 'keys': [{ 'kid': 'test', 'kty': 'RSA', ...publicJwk }] } as Jwks };
};

const sign = async (pair: CryptoKeyPair, claims: Record<string, unknown>): Promise<string> => {
  const header = Buffer.from(JSON.stringify({ 'alg': 'RS256', 'typ': 'JWT', 'kid': 'test' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    pair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${Buffer.from(new Uint8Array(signature)).toString('base64url')}`;
};

/** JWKS is the one network call auth makes; everything else in these tests is a real HTTP round trip. */
const stubJwks = (jwks: Jwks) => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith('/.well-known/jwks.json')) return new Response(JSON.stringify(jwks));
    return realFetch(input as never, init);
  }) as typeof fetch;
};

const useGuilds = (guilds: Record<string, unknown>): void => {
  const dir = mkdtempSync(resolve(tmpdir(), 'castellan-web-'));
  tempDirs.push(dir);
  const file = resolve(dir, 'guilds.json');
  writeFileSync(file, JSON.stringify(guilds));
  process.env.GUILDS_FILE = file;
};

/** `config/web.json` is read from `config/`, so the suite writes and removes it around each case. */
const withWebConfig = (value: WebConfig) => {
  const file = resolve('config/web.json');
  mkdirSync('config', { 'recursive': true });
  writeFileSync(file, JSON.stringify(value));
  return () => rmSync(file, { 'force': true });
};

afterEach(() => {
  globalThis.fetch = realFetch;
  clearJwksCache();
  if (savedGuildsFile === undefined) delete process.env.GUILDS_FILE;
  else process.env.GUILDS_FILE = savedGuildsFile;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { 'recursive': true, 'force': true });
});

describe('clerk session tokens', () => {
  test('the publishable key is enough to find the issuer', () => {
    expect(issuerFromPublishableKey(publishableKey('clerk.test'))).toBe('https://clerk.test');
    expect(issuerFromPublishableKey('pk_live_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk')).toBe(
      'https://example.clerk.accounts.dev',
    );
    expect(issuerFromPublishableKey('nonsense')).toBeUndefined();
  });

  test('a signed token verifies, and every kind of tampering does not', async () => {
    const { pair, jwks } = await keyPair();
    const now = Math.floor(Date.now() / 1000);
    const token = await sign(pair, { 'sub': 'user_1', 'email': 'A@Example.com', 'iss': ISSUER, 'exp': now + 60 });
    const claims = await verifyJwt(token, jwks, { 'issuer': ISSUER, now });
    expect(claims?.sub).toBe('user_1');
    expect(claims?.email).toBe('a@example.com');

    // wrong issuer, expired, tampered payload, unknown signature
    const otherIssuer = await sign(pair, { 'sub': 'user_1', 'iss': 'https://evil.test', 'exp': now + 60 });
    expect(await verifyJwt(otherIssuer, jwks, { 'issuer': ISSUER, now })).toBeUndefined();
    const expired = await sign(pair, { 'sub': 'user_1', 'iss': ISSUER, 'exp': now - 3600 });
    expect(await verifyJwt(expired, jwks, { 'issuer': ISSUER, now })).toBeUndefined();
    const tampered = `${token.split('.')[0]}.${Buffer.from(JSON.stringify({ 'sub': 'user_2', 'iss': ISSUER, 'exp': now + 60 })).toString('base64url')}.${token.split('.')[2]}`;
    expect(await verifyJwt(tampered, jwks, { 'issuer': ISSUER, now })).toBeUndefined();
    const unsigned = `${token.split('.')[0]}.${token.split('.')[1]}.${Buffer.from('nope').toString('base64url')}`;
    expect(await verifyJwt(unsigned, jwks, { 'issuer': ISSUER, now })).toBeUndefined();
    expect(await verifyJwt('not.a.token', jwks, { 'issuer': ISSUER, now })).toBeUndefined();
  });
});

describe('identity when the token has no email', () => {
  test('the email comes from the Clerk Backend API and satisfies the people lists', async () => {
    const { pair, jwks } = await keyPair();
    stubJwks(jwks);
    const calls: string[] = [];
    const previous = { 'base': process.env.CLERK_API_BASE, 'secret': process.env.CLERK_SECRET_KEY };
    process.env.CLERK_API_BASE = 'https://clerk.api.test';
    process.env.CLERK_SECRET_KEY = 'sk_test_probe';

    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://clerk.api.test/v1/users/')) {
        calls.push(url);
        expect((init?.headers as Record<string, string>).authorization).toBe('Bearer sk_test_probe');
        return Response.json({
          'email_addresses': [
            { 'id': 'idn_2', 'email_address': 'Other@Example.com' },
            { 'id': 'idn_1', 'email_address': 'Boss@Example.com' },
          ],
          'primary_email_address_id': 'idn_1',
        });
      }
      return real(input as never, init);
    }) as typeof fetch;

    try {
      const now = Math.floor(Date.now() / 1000);
      // a Clerk default token: sub + iss + exp, no email claim
      const token = await sign(pair, { 'sub': 'user_boss', 'iss': ISSUER, 'exp': now + 600 });
      const claims = await authenticate(`Bearer ${token}`, { 'issuer': ISSUER });
      expect(claims?.email).toBe('boss@example.com');
      expect(claims?.emailSource).toBe('clerk-backend-api');
      // the primary address is the one chosen, and the lookup is cached
      await authenticate(`Bearer ${token}`, { 'issuer': ISSUER });
      expect(calls).toHaveLength(1);
    } finally {
      globalThis.fetch = real;
      if (previous.base === undefined) delete process.env.CLERK_API_BASE;
      else process.env.CLERK_API_BASE = previous.base;
      if (previous.secret === undefined) delete process.env.CLERK_SECRET_KEY;
      else process.env.CLERK_SECRET_KEY = previous.secret;
    }
  });
});

describe('failures stay readable', () => {
  const token = [
    Buffer.from(JSON.stringify({ 'alg': 'RS256', 'kid': 'k' })).toString('base64url'),
    'payload',
    'sig',
  ].join('.');

  test('a JWKS without a usable RSA key is "no session", never a throw', async () => {
    // an EC key or a malformed modulus used to reach crypto.subtle.importKey and throw, which dropped the socket
    await expect(
      verifyJwt(
        token,
        { 'keys': [{ 'kid': 'k', 'kty': 'EC', 'crv': 'P-256', 'x': 'x', 'y': 'y' }] },
        { 'issuer': ISSUER },
      ),
    ).resolves.toBeUndefined();
    await expect(
      verifyJwt(
        token,
        { 'keys': [{ 'kid': 'k', 'kty': 'RSA', 'n': 'not base64', 'e': 'AQAB' }] },
        { 'issuer': ISSUER },
      ),
    ).resolves.toBeUndefined();
  });
});

describe('who may do what', () => {
  const baseConfig: WebConfig = {
    'owners': ['boss@example.com'],
    'admins': ['helper@example.com'],
    'links': { 'user_discord_owner': 'discord-owner-id' },
    'guilds': { '222': ['explicit@example.com'] },
  };
  const guilds = [
    { 'id': '111', 'discordOwnerId': 'discord-owner-id' },
    { 'id': '222' },
    { 'id': '333', 'discordOwnerId': 'someone-else' },
  ];

  test('owner, granted admin, linked server owner, and nobody', () => {
    const owner = resolvePrincipal({ 'sub': 'user_a', 'email': 'boss@example.com' }, { 'config': baseConfig, guilds });
    expect(owner.kind).toBe('owner');
    const admin = resolvePrincipal(
      { 'sub': 'user_b', 'email': 'helper@example.com' },
      { 'config': baseConfig, guilds },
    );
    expect(admin.kind).toBe('admin');
    const serverOwner = resolvePrincipal({ 'sub': 'user_discord_owner' }, { 'config': baseConfig, guilds });
    expect(serverOwner.kind).toBe('guild');
    expect(serverOwner.kind === 'guild' ? serverOwner.guilds : []).toEqual(['111']);
    const explicit = resolvePrincipal(
      { 'sub': 'user_c', 'email': 'explicit@example.com' },
      { 'config': baseConfig, guilds },
    );
    expect(explicit.kind === 'guild' ? explicit.guilds : []).toEqual(['222']);
    expect(
      resolvePrincipal({ 'sub': 'user_d', 'email': 'stranger@example.com' }, { 'config': baseConfig, guilds }).kind,
    ).toBe('nobody');
  });

  test('a stranger sees nothing, a server owner sees their server', () => {
    expect(visibleGuilds({ 'kind': 'nobody', 'clerkId': 'x' }, ['111', '222'])).toEqual([]);
    expect(visibleGuilds({ 'kind': 'guild', 'clerkId': 'x', 'guilds': ['222'] }, ['111', '222'])).toEqual(['222']);
    expect(visibleGuilds({ 'kind': 'admin', 'clerkId': 'x' }, ['111', '222'])).toEqual(['111', '222']);
  });

  test('a server owner gets their own settings and never the bot-wide ones', () => {
    const owner: Principal = { 'kind': 'guild', 'clerkId': 'x', 'guilds': ['111'] };
    const check = (path: string, guildEnabled = true, guildId = '111') =>
      canEditSetting(owner, { guildId, path, guildEnabled });

    expect(check('features.clarify').allowed).toBe(true);
    expect(check('policy.mode').allowed).toBe(true);
    expect(check('policy.matrix.trusted.destructive').allowed).toBe(true);
    // the machine, the models, the credentials and the two capability grants stay with the bot owner
    for (const path of ['shell.mode', 'model.primary', 'git.enabled', 'pterodactyl.admin', 'roles.admin', 'enabled'])
      expect([path, check(path).allowed]).toEqual([path, false]);
    expect(check('policy.tools.allow').allowed).toBe(false);
    expect(isBotWide('git.push')).toBe(true);
    expect(isBotWide('features.tools.disabled')).toBe(false);

    // their server only, and only once it is approved
    expect(check('features.clarify', true, '222').allowed).toBe(false);
    expect(check('features.clarify', false).reason).toContain('not approved');
    expect(canManageAccess(owner, '111', true).allowed).toBe(true);
    expect(canManageAccess({ 'kind': 'nobody', 'clerkId': 'y' }, '111', true).allowed).toBe(false);

    const admin: Principal = { 'kind': 'admin', 'clerkId': 'z' };
    expect(canEditSetting(admin, { 'guildId': '222', 'path': 'shell.mode', 'guildEnabled': false }).allowed).toBe(true);
  });
});

describe('the dashboard over http', () => {
  const boot = async () => {
    const { pair, jwks } = await keyPair();
    stubJwks(jwks);
    useGuilds({
      '111': { 'enabled': true, 'features': { 'clarify': 'normal' } },
      '222': { 'enabled': true },
    });
    services.set({
      'client': {
        'guilds': {
          'cache': new Map([
            [
              '111',
              {
                'name': 'Alpha',
                'ownerId': 'discord-owner-id',
                'channels': { 'cache': new Map([['chan-1', { 'name': 'general' }]]) },
              },
            ],
            ['222', { 'name': 'Beta', 'ownerId': 'someone-else' }],
          ]),
        },
      },
    } as never);
    const server = startWeb({ 'port': 0, 'issuer': ISSUER, 'publishableKey': publishableKey('clerk.test') });
    const call = async (path: string, init: RequestInit = {}, token?: string) => {
      const response = await realFetch(`http://127.0.0.1:${server.port}${path}`, {
        ...init,
        'headers': {
          'content-type': 'application/json',
          ...(token ? { 'authorization': `Bearer ${token}` } : {}),
          ...(init.headers ?? {}),
        },
      });
      return {
        'status': response.status,
        'body': (await response.json().catch(() => ({}))) as Record<string, unknown>,
      };
    };
    const now = Math.floor(Date.now() / 1000);
    const tokens = {
      'owner': await sign(pair, { 'sub': 'u_owner', 'email': 'boss@example.com', 'iss': ISSUER, 'exp': now + 600 }),
      'guild': await sign(pair, { 'sub': 'user_discord_owner', 'iss': ISSUER, 'exp': now + 600 }),
      'stranger': await sign(pair, { 'sub': 'u_rand', 'email': 'rand@example.com', 'iss': ISSUER, 'exp': now + 600 }),
    };
    return { server, call, tokens };
  };

  test('unauthenticated, nobody, owner and server owner get different answers', async () => {
    const remove = withWebConfig({
      'owners': ['boss@example.com'],
      'admins': [],
      'links': { 'user_discord_owner': 'discord-owner-id' },
      'guilds': {},
    });
    const { server, call, tokens } = await boot();
    try {
      expect((await call('/api/me')).status).toBe(401);

      // `curl -I` and uptime monitors probe with HEAD: that must not read as "dashboard down" (it did once)
      const head = await realFetch(`http://127.0.0.1:${server.port}/healthz`, { 'method': 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('content-type')).toContain('application/json');
      expect(await realFetch(`http://127.0.0.1:${server.port}/`, { 'method': 'HEAD' })).toMatchObject({
        'status': 200,
      });

      // the page is public (it must be, to start a sign-in) and carries the publishable key, nothing else
      const page = await realFetch(`http://127.0.0.1:${server.port}/`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toContain('text/html');
      const html = await page.text();
      expect(html).toContain(publishableKey('clerk.test'));
      expect(html).toContain(ISSUER);
      // the template tokens are gone after injection — if one survives inside a guard, the page compares a value
      // to itself and dies with a confusing message (that happened once)
      expect(html).not.toContain('__CLERK_KEY__');
      expect(html).not.toContain('__CLERK_FAPI__');
      // and it uses Clerk's documented bundles, served by the Frontend API host — not a CDN of our choosing
      expect(html).toContain('/npm/@clerk/ui@1/dist/ui.browser.js');
      expect(html).toContain('/npm/@clerk/clerk-js@6/dist/clerk.browser.js');
      expect(html).toContain('data-clerk-publishable-key');
      expect(html).toContain('mountSignIn');
      expect(html).toContain('mountUserButton');
      expect(html).not.toContain('jsdelivr');

      const nobody = await call('/api/me', {}, tokens.stranger);
      expect(nobody.status).toBe(403);

      const owner = await call('/api/me', {}, tokens.owner);
      expect(owner.status).toBe(200);
      expect(owner.body.role).toBe('owner');
      expect((owner.body.guilds as Array<{ id: string }>).map(guild => guild.id)).toEqual(['111', '222']);

      const guildOwner = await call('/api/me', {}, tokens.guild);
      expect(guildOwner.body.role).toBe('guild');
      expect((guildOwner.body.guilds as Array<{ id: string }>).map(guild => guild.id)).toEqual(['111']);
      // the server they do not own is invisible and unwritable
      expect((await call('/api/guilds/222', {}, tokens.guild)).status).toBe(403);
      expect(
        (
          await call(
            '/api/guilds/222',
            { 'method': 'PATCH', 'body': JSON.stringify({ 'path': 'features.clarify', 'raw': 'high' }) },
            tokens.guild,
          )
        ).status,
      ).toBe(403);
    } finally {
      remove();
      server.stop(true);
    }
  });

  test('secrets: the server stores its own key, reads back only a hint, and the value reaches no response', async () => {
    const remove = withWebConfig({
      'owners': ['boss@example.com'],
      'admins': [],
      'links': { 'user_discord_owner': 'discord-owner-id' },
      'guilds': {},
    });
    const { server, call, tokens } = await boot();
    const wipe = () => {
      db.query("DELETE FROM guild_secrets WHERE guild_id = '111'").run();
      db.query("DELETE FROM audit WHERE guild_id = '111' AND tool LIKE 'secret_%'").run();
    };
    // the suite shares one database: start from a known audit trail for this guild
    wipe();
    try {
      const before = await call('/api/guilds/111/secrets', {}, tokens.guild);
      expect(before.status).toBe(200);
      const names = (before.body.secrets as Array<{ name: string; source: string }>).map(s => s.name);
      expect(names).toContain('pterodactyl.clientKey');
      // nothing stored yet for this server: whatever the deployment's .env holds is the only possible source
      expect(
        (before.body.secrets as Array<{ name: string; source: string }>).find(s => s.name === 'pterodactyl.clientKey')
          ?.source,
      ).not.toBe('guild');

      const key = 'ptlc_abcdefgh12345678xyz';
      const stored = await call(
        '/api/guilds/111/secrets/pterodactyl.clientKey',
        { 'method': 'PUT', 'body': JSON.stringify({ 'value': key }) },
        tokens.guild,
      );
      expect(stored.status).toBe(200);
      expect(stored.body.hint).toBe('••••8xyz');

      const after = await call('/api/guilds/111/secrets', {}, tokens.guild);
      // the value is nowhere in the response, not even the part of it the panel would reuse
      expect(JSON.stringify(after.body)).not.toContain(key);
      expect(JSON.stringify(after.body)).not.toContain('abcdefgh');
      const row = (after.body.secrets as Array<{ name: string; source: string; hint: string }>).find(
        s => s.name === 'pterodactyl.clientKey',
      );
      expect(row?.source).toBe('guild');
      expect(row?.hint).toBe('••••8xyz');

      // a bad key is refused with the reason, and it is not stored
      const rejected = await call(
        '/api/guilds/111/secrets/git.token',
        { 'method': 'PUT', 'body': JSON.stringify({ 'value': 'short' }) },
        tokens.guild,
      );
      expect(rejected.status).toBe(400);
      expect(String(rejected.body.detail)).toContain('must be at least 16 characters');

      // another server's owner cannot touch it
      expect((await call('/api/guilds/222/secrets', {}, tokens.guild)).status).toBe(403);

      const cleared = await call('/api/guilds/111/secrets/pterodactyl.clientKey', { 'method': 'DELETE' }, tokens.guild);
      expect(cleared.body.removed).toBe(true);
      const gone = await call('/api/guilds/111/secrets', {}, tokens.guild);
      expect(
        (gone.body.secrets as Array<{ name: string; source: string }>).find(s => s.name === 'pterodactyl.clientKey')
          ?.source,
      ).not.toBe('guild');

      // and both changes are in the audit trail, by name only
      const audited = db
        .query<{ tool: string; args: string }, [string]>(
          "SELECT tool, args FROM audit WHERE guild_id = '111' AND tool LIKE 'secret_%' ORDER BY ts",
        )
        .all('111');
      expect(audited.map(row => row.tool)).toEqual(['secret_set', 'secret_set', 'secret_clear']);
      expect(JSON.stringify(audited)).not.toContain(key);
    } finally {
      wipe();
      remove();
      server.stop(true);
    }
  });

  test('conversations: the guild’s sessions, and a transcript that says why it cannot load', async () => {
    const remove = withWebConfig({
      'owners': ['boss@example.com'],
      'admins': [],
      'links': { 'user_discord_owner': 'discord-owner-id' },
      'guilds': {},
    });
    const { server, call, tokens } = await boot();
    try {
      sessions.set({
        'chat_key': '111:chan-1',
        'guild_id': '111',
        'channel_id': 'chan-1',
        'session_id': 'ses_web_probe',
        'actor_id': 'user-a',
      });
      const list = await call('/api/guilds/111/sessions', {}, tokens.owner);
      expect(list.status).toBe(200);
      expect((list.body.sessions as Array<{ sessionId: string; channelName?: string }>).map(s => s.sessionId)).toEqual([
        'ses_web_probe',
      ]);
      // the channel name comes from the live client
      expect((list.body.sessions as Array<{ channelName?: string }>)[0]?.channelName).toBe('general');

      // the agent server is idle, so the transcript explains itself instead of erroring
      const transcript = await call('/api/guilds/111/sessions/ses_web_probe', {}, tokens.owner);
      expect(transcript.status).toBe(200);
      expect(String(transcript.body.unavailable)).toContain('not running');

      // another guild's owner cannot read it, and a session from elsewhere is not served under this guild
      expect((await call('/api/guilds/222/sessions', {}, tokens.guild)).status).toBe(403);
      const other = await call('/api/guilds/222/sessions/ses_web_probe', {}, tokens.owner);
      expect(String(other.body.unavailable)).toContain('not in this server');
    } finally {
      remove();
      server.stop(true);
    }
  });

  test('a server owner edits their own guild settings but not the sandbox', async () => {
    const remove = withWebConfig({
      'owners': [],
      'admins': [],
      'links': { 'user_discord_owner': 'discord-owner-id' },
      'guilds': {},
    });
    const { server, call, tokens } = await boot();
    try {
      const detail = await call('/api/guilds/111', {}, tokens.guild);
      expect(detail.status).toBe(200);
      const groups = detail.body.groups as Array<{
        category: string;
        entries: Array<{ path: string; editable: boolean; reason: string }>;
      }>;
      const entry = (path: string) => groups.flatMap(group => group.entries).find(item => item.path === path);
      expect(entry('features.clarify')?.editable).toBe(true);
      expect(entry('shell.mode')?.editable).toBe(false);
      expect(entry('shell.mode')?.reason).toContain('bot-wide');

      const saved = await call(
        '/api/guilds/111',
        { 'method': 'PATCH', 'body': JSON.stringify({ 'path': 'features.clarify', 'raw': 'always' }) },
        tokens.guild,
      );
      expect(saved.status).toBe(200);
      expect(config.features('111').clarify).toBe('always');

      const refused = await call(
        '/api/guilds/111',
        { 'method': 'PATCH', 'body': JSON.stringify({ 'path': 'shell.mode', 'raw': 'host' }) },
        tokens.guild,
      );
      expect(refused.status).toBe(403);
      expect(config.guild('111')?.shell.mode).toBe('docker');

      const bad = await call(
        '/api/guilds/111',
        { 'method': 'PATCH', 'body': JSON.stringify({ 'path': 'features.clarify', 'raw': 'sometimes' }) },
        tokens.guild,
      );
      expect(bad.status).toBe(400);
      expect(config.features('111').clarify).toBe('always');
    } finally {
      remove();
      server.stop(true);
    }
  });

  test('the owner can change bot-wide settings, and access profiles belong to the server owner', async () => {
    const remove = withWebConfig({
      'owners': ['boss@example.com'],
      'admins': [],
      'links': { 'user_discord_owner': 'discord-owner-id' },
      'guilds': {},
    });
    const { server, call, tokens } = await boot();
    try {
      const sandbox = await call(
        '/api/guilds/111',
        { 'method': 'PATCH', 'body': JSON.stringify({ 'path': 'shell.mode', 'raw': 'host' }) },
        tokens.owner,
      );
      expect(sandbox.status).toBe(200);
      expect(config.guild('111')?.shell.mode).toBe('host');

      const access = await call(
        '/api/guilds/111/access',
        {
          'method': 'PUT',
          'body': JSON.stringify({
            'blocked': ['999'],
            'users': { '888': { 'risk': 'read' } },
          }),
        },
        tokens.guild,
      );
      expect(access.status).toBe(200);
      expect(config.access('111').blocked).toEqual(['999']);
      expect(config.access('111').users['888']?.risk).toBe('read');

      // a stranger cannot touch it
      const denied = await call('/api/guilds/111/access', { 'method': 'PUT', 'body': '{}' }, tokens.stranger);
      expect(denied.status).toBe(403);

      // and a server owner cannot mint `owner`, nor block themselves: those ranks are fixed
      const mint = await call(
        '/api/guilds/111/access',
        { 'method': 'PUT', 'body': JSON.stringify({ 'blocked': [], 'users': { 'friend': { 'rank': 'owner' } } }) },
        tokens.guild,
      );
      expect(mint.status).toBe(403);
      expect(String(mint.body.detail)).toContain('only the bot owner can grant that rank');

      const selfBlock = await call(
        '/api/guilds/111/access',
        { 'method': 'PUT', 'body': JSON.stringify({ 'blocked': ['discord-owner-id'], 'users': {} }) },
        tokens.guild,
      );
      expect(selfBlock.status).toBe(403);
      expect(String(selfBlock.body.detail)).toContain('fixed rank');

      // the bot owner can
      const ownerMint = await call(
        '/api/guilds/111/access',
        { 'method': 'PUT', 'body': JSON.stringify({ 'blocked': [], 'users': { 'friend': { 'rank': 'owner' } } }) },
        tokens.owner,
      );
      expect(ownerMint.status).toBe(200);
    } finally {
      remove();
      server.stop(true);
    }
  });
});
