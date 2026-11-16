import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { config } from '@services/config.ts';
import { services } from '@services/discord/services.ts';
import { extensionStatus } from '@services/extensions/registry.ts';
import { applySetting } from '@services/policy/panel.ts';
import { SETTINGS, describeSetting, domainOf, readSetting } from '@services/policy/settings.ts';
import { CLERK_PUBLISHABLE_KEY, WEB_HOST, WEB_PORT } from '@utils/env.ts';
import { log } from '@utils/logger.ts';

import { authenticate, issuerFromPublishableKey } from './auth.ts';
import {
  BOT_WIDE_PATHS,
  BOT_WIDE_PREFIXES,
  canEditSetting,
  canManageAccess,
  loadWebConfig,
  resolvePrincipal,
  visibleGuilds,
  type Principal,
} from './principals.ts';

import type { GuildSettings } from '@services/config.ts';
import type { Server as BunServer } from 'bun';

const logger = log('web');

const PAGE = readFileSync(resolve(import.meta.dirname, 'ui.html'), 'utf8');

export type WebServer = BunServer<unknown>;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, 'headers': { 'content-type': 'application/json' } });

const currentSettings = (guildId: string): GuildSettings => config.guild(guildId) ?? ({} as GuildSettings);
const guildEnabled = (guildId: string): boolean => config.guild(guildId)?.enabled === true;

/** Guild names and Discord owner ids come from the live client when the bot is up, config only otherwise. */
function guildFacts(): Array<{ id: string; name: string; enabled: boolean; discordOwnerId?: string }> {
  const ids = Object.keys(config.raw());
  let cache: Map<string, { name: string; ownerId: string }> | undefined;
  try {
    cache = services.get().client.guilds.cache;
  } catch {
    cache = undefined;
  }
  return ids.map(id => {
    const guild = cache?.get(id);
    return {
      id,
      'name': guild?.name ?? id,
      'enabled': guildEnabled(id),
      ...(guild?.ownerId ? { 'discordOwnerId': guild.ownerId } : {}),
    };
  });
}

/** Settings a person may see, with the value in force and whether this principal may write it. */
function settingsSnapshot(principal: Principal, guildId: string) {
  const settings = currentSettings(guildId);
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const setting of SETTINGS) {
    const category = setting.path.split('.')[0] ?? '';
    const verdict = canEditSetting(principal, { guildId, 'path': setting.path, 'guildEnabled': guildEnabled(guildId) });
    const domain = domainOf(setting.path);
    const bucket = groups.get(category) ?? [];
    bucket.push({
      'path': setting.path,
      'label': setting.path.slice(category.length + 1),
      'description': setting.description,
      'kind': domain?.kind ?? 'text',
      'choices': domain?.choices ?? [],
      'placeholder': domain?.placeholder ?? '',
      'value': readSetting(settings, setting.path) ?? null,
      'shown': describeSetting(settings, setting.path),
      'scope': setting.scope,
      'editable': verdict.allowed,
      'reason': verdict.reason,
    });
    groups.set(category, bucket);
  }
  return [...groups.entries()].map(([category, entries]) => ({ category, entries }));
}

async function principalOf(request: Request, issuer: string): Promise<Principal | Response> {
  const claims = await authenticate(request.headers.get('authorization'), { issuer });
  if (!claims) return json({ 'error': 'unauthorized — sign in again', 'detail': 'no valid Clerk session token' }, 401);
  return resolvePrincipal(claims, { 'config': loadWebConfig(), 'guilds': guildFacts() });
}

/**
 * The dashboard: Clerk for identity, `config/web.json` for who may do what, and the same `applySetting`
 * write path the Discord commands use. Every `/api` request re-verifies the token; nothing is trusted because
 * a previous request was.
 */
export function startWeb(input: {
  port: number;
  issuer: string;
  publishableKey: string;
  /** Loopback by default: put a TLS proxy in front rather than exposing the port. */
  hostname?: string;
}): WebServer {
  return Bun.serve({
    'port': input.port,
    'hostname': input.hostname ?? '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      // `HEAD` is `GET` without a body — `curl -I`, uptime monitors and some proxies probe that way, and a 404 for
      // them would look like a dead dashboard. Routing treats them alike; Bun drops the body for HEAD.
      const method = request.method === 'HEAD' ? 'GET' : request.method;

      // Unauthenticated liveness only: the proxy and systemd need something to poll, and it says nothing else.
      if (method === 'GET' && url.pathname === '/healthz') return json({ 'ok': true, 'service': 'dashboard' });
      if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        // Both values are public: the publishable key, and the Frontend API host it encodes (the issuer).
        const page = PAGE.replaceAll('__CLERK_KEY__', input.publishableKey).replaceAll('__CLERK_FAPI__', input.issuer);
        return new Response(page, {
          'headers': { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
      if (!url.pathname.startsWith('/api/')) return json({ 'error': 'not found' }, 404);

      const principal = await principalOf(request, input.issuer);
      if (principal instanceof Response) return principal;

      const guilds = guildFacts();
      const visible = visibleGuilds(
        principal,
        guilds.map(guild => guild.id),
      );

      if (method === 'GET' && url.pathname === '/api/me') {
        if (principal.kind === 'nobody')
          return json({ 'error': 'no access', 'detail': 'your account has no permissions here' }, 403);
        return json({
          'role': principal.kind,
          'email': principal.email ?? null,
          'botWide': [...BOT_WIDE_PATHS, ...BOT_WIDE_PREFIXES.map(prefix => `${prefix}*`)],
          'guilds': guilds.filter(guild => visible.includes(guild.id)),
        });
      }

      const guildMatch = /^\/api\/guilds\/(\d+)(\/access)?$/.exec(url.pathname);
      if (!guildMatch) return json({ 'error': 'not found' }, 404);
      const guildId = guildMatch[1] ?? '';
      const wantsAccess = guildMatch[2] !== undefined;

      if (!visible.includes(guildId))
        return json({ 'error': 'forbidden', 'detail': 'this account does not manage that server' }, 403);

      if (method === 'GET' && !wantsAccess) {
        const verdict = canEditSetting(principal, {
          guildId,
          'path': 'features.clarify',
          'guildEnabled': guildEnabled(guildId),
        });
        return json({
          'guild': guilds.find(guild => guild.id === guildId) ?? { 'id': guildId },
          'canEdit': verdict,
          // Which extensions exist here, whether they are switched on, and why not — the toggle list.
          'extensions': extensionStatus(guildId),
          'groups': settingsSnapshot(principal, guildId),
        });
      }

      if (method === 'GET' && wantsAccess) {
        const verdict = canManageAccess(principal, guildId, guildEnabled(guildId));
        return json({ 'access': config.access(guildId), 'canEdit': verdict });
      }

      if (method === 'PATCH' && !wantsAccess) {
        const body = (await request.json().catch(() => undefined)) as { path?: unknown; raw?: unknown } | undefined;
        const path = typeof body?.path === 'string' ? body.path : '';
        if (path.length === 0) return json({ 'error': 'bad request', 'detail': 'path is required' }, 400);
        const verdict = canEditSetting(principal, { guildId, path, 'guildEnabled': guildEnabled(guildId) });
        if (!verdict.allowed) return json({ 'error': 'forbidden', 'detail': verdict.reason }, 403);
        const raw = typeof body?.raw === 'string' ? body.raw : body?.raw === null ? undefined : undefined;
        const applied = await applySetting({
          guildId,
          'userId': principal.clerkId,
          path,
          raw,
          'authorize': () => true,
          'actor': `web:${principal.email ?? principal.clerkId} (${principal.kind})`,
        });
        if (!applied.ok) return json({ 'error': 'rejected', 'detail': applied.error }, 400);
        return json({ 'ok': true, 'value': applied.value, 'reloaded': applied.reloaded });
      }

      if (method === 'PUT' && wantsAccess) {
        const verdict = canManageAccess(principal, guildId, guildEnabled(guildId));
        if (!verdict.allowed) return json({ 'error': 'forbidden', 'detail': verdict.reason }, 403);
        const body = (await request.json().catch(() => undefined)) as Record<string, unknown> | undefined;
        const blocked = Array.isArray(body?.blocked)
          ? body.blocked.filter((id): id is string => typeof id === 'string')
          : [];
        const users = typeof body?.users === 'object' && body.users !== null ? body.users : {};
        try {
          config.patchGuild(guildId, { ...currentSettings(guildId), 'access': { blocked, users } });
        } catch (error) {
          return json({ 'error': 'rejected', 'detail': String(error).slice(0, 300) }, 400);
        }
        logger.info('access written from the dashboard', {
          guildId,
          'by': principal.email ?? principal.clerkId,
          'blocked': blocked.length,
          'profiles': Object.keys(users).length,
        });
        return json({ 'ok': true, 'access': config.access(guildId) });
      }

      return json({ 'error': 'method not allowed' }, 405);
    },
  });
}

/** Boot hook: no publishable key or port means the dashboard simply does not exist. */
export function startWebFromEnv(): WebServer | undefined {
  if (WEB_PORT <= 0) return undefined;
  const publishableKey = CLERK_PUBLISHABLE_KEY ?? '';
  const issuer = issuerFromPublishableKey(publishableKey);
  if (!issuer) {
    logger.warn('WEB_PORT is set but CLERK_PUBLISHABLE_KEY is missing or unreadable; dashboard disabled');
    return undefined;
  }
  const server = startWeb({ 'port': WEB_PORT, issuer, publishableKey, 'hostname': WEB_HOST });
  logger.info('dashboard listening', {
    'host': WEB_HOST,
    'port': server.port ?? WEB_PORT,
    issuer,
    'botWide': BOT_WIDE_PREFIXES,
  });
  return server;
}
