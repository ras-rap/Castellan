import { config } from '@services/config.ts';
import { PTERO_ADMIN_KEY, PTERO_BASE_URL, PTERO_CLIENT_KEY } from '@utils/env.ts';
import { log } from '@utils/logger.ts';

const logger = log('pterodactyl');

/** `client` is the user-scoped API (`ptlc_`), `admin` is the application API (`ptla_`). */
export type PteroApi = 'client' | 'admin';

export type PteroTarget = {
  /** Scheme + host, no trailing slash. */
  baseUrl: string;
  clientKey?: string;
  adminKey?: string;
  /** Allow-list of server identifiers (client) or ids (admin); empty means "whatever the key can see". */
  servers: string[];
  files: boolean;
  admin: boolean;
};

/**
 * The guild's panel settings resolved against the deployment's keys. `undefined` means "not configured", and
 * every caller treats that as the feature being off rather than as an error.
 */
export function resolvePtero(guildId: string): PteroTarget | undefined {
  const settings = config.pterodactyl(guildId);
  const rawBase = settings.baseUrl.length > 0 ? settings.baseUrl : (PTERO_BASE_URL ?? '');
  const baseUrl = rawBase.replace(/\/+$/, '');
  const clientKey = PTERO_CLIENT_KEY;
  const adminKey = PTERO_ADMIN_KEY;
  if (!settings.enabled || baseUrl.length === 0) return undefined;
  // A client key is the floor: without it there is nothing to talk to.
  if (!clientKey && !adminKey) return undefined;
  return {
    baseUrl,
    clientKey,
    adminKey,
    'servers': settings.servers,
    'files': settings.files,
    'admin': settings.admin,
  };
}

/** The key a call may use: the application key only exists for `admin` calls when the guild enabled them. */
export const keyFor = (target: PteroTarget, api: PteroApi): string | undefined =>
  api === 'client' ? target.clientKey : target.admin ? target.adminKey : undefined;

/** Header set the panel expects; the key is never logged. */
export function authHeaders(key: string, contentType = 'application/json'): Record<string, string> {
  return {
    'authorization': `Bearer ${key}`,
    'accept': 'Application/vnd.pterodactyl.v1+json',
    'content-type': contentType,
  };
}

/** `/api/client/...` and `/api/application/...`, so callers only write the resource part. */
export function apiUrl(target: PteroTarget, api: PteroApi, path: string): string {
  const prefix = api === 'client' ? '/api/client' : '/api/application';
  // An empty path is the collection root (`GET /api/client` lists servers); a trailing slash there 404s on
  // stricter panels and means nothing to the API either way.
  const suffix = path.length === 0 ? '' : path.startsWith('/') ? path : `/${path}`;
  return `${target.baseUrl}${prefix}${suffix}`;
}

export const redact = (text: string, key: string | undefined): string =>
  key === undefined || key.length === 0 ? text : text.replaceAll(key, '***');

type PanelError = { errors?: Array<{ code?: string; detail?: string }> };

/** Pterodactyl puts the human reason in `errors[].detail`; that is what the model should see. */
export function errorDetail(payload: unknown, status: number): string {
  if (typeof payload === 'object' && payload !== null && 'errors' in payload) {
    const errors = (payload as PanelError).errors ?? [];
    const detail = errors
      .map(error => error.detail ?? error.code ?? '')
      .filter(text => text.length > 0)
      .join('; ');
    if (detail.length > 0) return detail;
  }
  return `HTTP ${status}`;
}

/**
 * One request, one error shape. Returns parsed JSON when there is a body (204 for power/command/write is the
 * normal success case, so that is not an error).
 */
export async function pteroRequest<T = unknown>(
  guildId: string,
  api: PteroApi,
  key: string | undefined,
  path: string,
  init: { method?: string; body?: string; contentType?: string; accept?: string } = {},
): Promise<T | undefined> {
  const target = resolvePtero(guildId);
  if (!target) throw new Error('no pterodactyl panel configured here (pterodactyl.enabled + a key in .env)');
  if (!key) throw new Error(`no ${api === 'client' ? 'client' : 'application'} API key for this panel`);
  const url = apiUrl(target, api, path);
  const response = await fetch(url, {
    'method': init.method ?? 'GET',
    'headers': { ...authHeaders(key, init.contentType), ...(init.accept ? { 'accept': init.accept } : {}) },
    ...(init.body === undefined ? {} : { 'body': init.body }),
    'signal': AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) {
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
    const detail = errorDetail(payload, response.status);
    logger.warn('panel request failed', {
      guildId,
      api,
      path,
      'status': response.status,
      'detail': redact(detail, key),
    });
    throw new Error(redact(`${detail} (HTTP ${response.status} ${init.method ?? 'GET'} ${path})`, key));
  }
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export type PteroItem = { object?: string; attributes?: Record<string, unknown> };
export type PteroList = { data?: PteroItem[]; meta?: { pagination?: { total?: number } } };

/** `{attributes:{…}}` for one resource, `{data:[{attributes}]}` for a collection. */
export const attributesOf = (payload: unknown): Record<string, unknown> => {
  if (typeof payload !== 'object' || payload === null) return {};
  const item = payload as PteroItem;
  return item.attributes ?? {};
};

export const listAttributes = (payload: unknown): Array<Record<string, unknown>> => {
  if (typeof payload !== 'object' || payload === null) return [];
  return ((payload as PteroList).data ?? []).map(item => item.attributes ?? {});
};

const str = (value: unknown, fallback = '?'): string =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : fallback;

/** One line per server, which is what a model can actually reason about in a Discord message. */
export function describeServerLine(attributes: Record<string, unknown>): string {
  const limits = (attributes.limits ?? {}) as Record<string, unknown>;
  return [
    `identifier=${str(attributes.identifier)}`,
    `id=${str(attributes.internal_id, '-')}`,
    `name=${str(attributes.name)}`,
    `status=${str(attributes.status, 'offline')}`,
    `node=${str(attributes.node, '-')}`,
    `memory=${str(limits.memory, '?')}MB`,
    `disk=${str(limits.disk, '?')}MB`,
    `suspended=${attributes.is_suspended === true}`,
  ].join(' ');
}

/** Whether the guild's allow-list admits this server (identifier, uuid or internal id). */
export function serverAllowed(target: PteroTarget, server: string): boolean {
  if (target.servers.length === 0) return true;
  return target.servers.some(entry => entry.toLowerCase() === server.toLowerCase());
}

/**
 * Absolute paths only, no traversal: the panel resolves `file`/`directory` against the server root, so `..`
 * would let a write climb out of the data directory the user was given.
 */
export function safePath(path: string, what: 'file' | 'directory'): string {
  const value = path.trim();
  if (!value.startsWith('/')) throw new Error(`${what} must be an absolute path starting with /`);
  if (value.split('/').includes('..')) throw new Error(`${what} must not contain ..`);
  return value;
}

export const POWER_SIGNALS = ['start', 'stop', 'restart', 'kill'] as const;
export type PowerSignal = (typeof POWER_SIGNALS)[number];

export const powerRequest = (signal: PowerSignal): { method: string; body: string } => ({
  'method': 'POST',
  'body': JSON.stringify({ signal }),
});

export const commandRequest = (command: string): { method: string; body: string } => ({
  'method': 'POST',
  'body': JSON.stringify({ command }),
});

/** Writing a file is a raw body, not JSON: the panel takes the exact bytes and `text/plain`. */
export const writeRequest = (content: string): { method: string; body: string; contentType: string } => ({
  'method': 'POST',
  'body': content,
  'contentType': 'text/plain',
});
