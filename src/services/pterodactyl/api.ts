import { config } from '@services/config.ts';
import { resolveSecret } from '@services/secrets/store.ts';
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
 * The guild's panel settings, with the keys this server stored (dashboard → Secrets) or the deployment's
 * `PTERO_*`. `undefined` means "not configured", and every caller treats that as the feature being off.
 */
export function resolvePtero(guildId: string): PteroTarget | undefined {
  const settings = config.pterodactyl(guildId);
  const rawBase = settings.baseUrl.length > 0 ? settings.baseUrl : (PTERO_BASE_URL ?? '');
  const baseUrl = rawBase.replace(/\/+$/, '');
  const clientKey = resolveSecret(guildId, 'pterodactyl.clientKey', PTERO_CLIENT_KEY);
  const adminKey = resolveSecret(guildId, 'pterodactyl.adminKey', PTERO_ADMIN_KEY);
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

/**
 * A name the panel resolves against a `root` directory: never absolute and never climbing, so a delete, a rename
 * or an archive cannot reach outside the directory the model named.
 */
export function safeRelative(value: string, what: string): string {
  const name = value.trim();
  if (name.length === 0) throw new Error(`${what} must not be empty`);
  if (name.startsWith('/')) throw new Error(`${what} must be relative to the directory, not an absolute path`);
  if (name.split('/').includes('..')) throw new Error(`${what} must not contain ..`);
  return name;
}

/** The panel hands out `{object:'signed_url', attributes:{url}}` for downloads and uploads: the node holds the bytes. */
export function signedUrl(payload: unknown, what: string): string {
  const url = attributesOf(payload).url;
  if (typeof url !== 'string' || !/^https?:\/\/\S+$/i.test(url))
    throw new Error(`the panel did not return a usable ${what} URL`);
  return url;
}

/** Loopback, link-local, RFC1918, CGNAT and IPv6 unique-local: hosts that only mean something inside the node. */
const internalHost = (host: string): boolean => {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (v4) {
    const first = Number(v4[1]);
    const second = Number(v4[2]);
    if (first === 0 || first === 10 || first === 127) return true;
    if (first === 169 && second === 254) return true;
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 192 && second === 168) return true;
    return first === 100 && second >= 64 && second <= 127;
  }
  return name === '::1' || /^f[cd]/.test(name) || /^fe[89ab]/.test(name);
};

/**
 * Wings fetches this URL *from the node*, so a pull is not a way to read the cluster's internals: only http(s),
 * and never a host the node can reach but the internet cannot.
 */
export function remoteUrl(value: string, what = 'url'): string {
  const raw = value.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${what} must be an absolute http(s) URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${what} must be an http(s) URL`);
  if (internalHost(url.hostname))
    throw new Error(`${what} points at a private address; a panel pull may only fetch from the public internet`);
  return url.toString();
}

/**
 * The panel validates the mode as numeric and Wings parses those digits as base 8, so it travels as a string:
 * `644` or `0755` in, `755` out. A model that wrote `493` would otherwise look valid and be rejected by the node.
 */
export function chmodMode(value: string): string {
  const text = value.trim().replace(/^0+/, '');
  if (!/^[0-7]{3,4}$/.test(text)) throw new Error('mode must be octal permissions like 644 or 0755');
  return text;
}

/** One JSON body, which is what every panel route except a raw file write takes. */
export const jsonRequest = (method: string, payload: Record<string, unknown>): { method: string; body: string } => ({
  method,
  'body': JSON.stringify(payload),
});

export const POWER_SIGNALS = ['start', 'stop', 'restart', 'kill'] as const;
export type PowerSignal = (typeof POWER_SIGNALS)[number];

export const powerRequest = (signal: PowerSignal): { method: string; body: string } => jsonRequest('POST', { signal });

export const commandRequest = (command: string): { method: string; body: string } =>
  jsonRequest('POST', { 'command': command });

/** Writing a file is a raw body, not JSON: the panel takes the exact bytes and `text/plain`. */
export const writeRequest = (content: string): { method: string; body: string; contentType: string } => ({
  'method': 'POST',
  'body': content,
  'contentType': 'text/plain',
});

/** Uploads are held in memory once, so they are capped here whatever Wings is configured to accept. */
const MAX_UPLOAD_BYTES = 64 * 1_048_576;

/** Wings answers a failed upload with `{error}` where the panel uses `errors[].detail`. */
async function nodeFailure(response: Response, what: string): Promise<string> {
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = undefined;
  }
  if (typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string')
    return `${payload.error} (HTTP ${response.status} ${what})`;
  const body = text.trim().slice(0, 300);
  return body.length > 0 ? `${body} (HTTP ${response.status} ${what})` : `HTTP ${response.status} ${what}`;
}

/**
 * Two-step upload. The panel only signs a node URL (`GET /files/upload`); the bytes go straight to Wings as a
 * multipart form with one `files` field, and the destination directory rides on that URL's query string. The
 * panel's key is never sent to the node — the signed token is the authorisation there.
 */
export async function pteroUpload(
  guildId: string,
  key: string | undefined,
  server: string,
  directory: string,
  filename: string,
  content: Uint8Array,
): Promise<number> {
  if (content.byteLength === 0) throw new Error('there is nothing to upload: that file is empty');
  if (content.byteLength > MAX_UPLOAD_BYTES)
    throw new Error(`that file is ${Math.round(content.byteLength / 1_048_576)}MB; the upload limit here is 64MB`);
  const signed = signedUrl(await pteroRequest(guildId, 'client', key, `/servers/${server}/files/upload`), 'upload');
  const url = new URL(signed);
  url.searchParams.set('directory', directory);
  const form = new FormData();
  // Blob takes any ArrayBufferView at runtime; the lib typing only admits ArrayBuffer-backed ones, and a caller's
  // Uint8Array may sit on a shared buffer.
  form.append('files', new Blob([content as unknown as BlobPart]), filename);
  const response = await fetch(url, { 'method': 'POST', 'body': form, 'signal': AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(redact(await nodeFailure(response, 'upload'), key));
  return content.byteLength;
}
