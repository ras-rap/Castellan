import { log } from '@utils/logger.ts';

const logger = log('web/auth');

/** The claims this dashboard reads out of a Clerk session token. Everything else is kept but unused. */
export type ClerkClaims = {
  sub: string;
  email?: string;
  iss?: string;
  exp?: number;
  nbf?: number;
  [claim: string]: unknown;
};

export type Jwk = {
  kid?: string;
  kty: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
  alg?: string;
  use?: string;
};
export type Jwks = { keys: Jwk[] };

const SKEW_SECONDS = 30;

export const base64UrlToBytes = (segment: string): Uint8Array<ArrayBuffer> => {
  const padded = segment.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='));
  // A fresh ArrayBuffer (not the shared one `new Uint8Array(length)` may back) is what WebCrypto wants.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

/** JWT segments are JSON in base64url; anything unparseable is `undefined`, never an exception upward. */
export function decodeSegment(segment: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A Clerk publishable key is `pk_test_`/`pk_live_` plus the base64 of the Frontend API host, with a trailing
 * `$`. The issuer and the JWKS live under that host, so one key is enough to configure everything.
 */
export function issuerFromPublishableKey(publishableKey: string): string | undefined {
  const prefix = publishableKey.startsWith('pk_test_')
    ? 'pk_test_'
    : publishableKey.startsWith('pk_live_')
      ? 'pk_live_'
      : '';
  if (prefix.length === 0) return undefined;
  try {
    const host = atob(publishableKey.slice(prefix.length).replace(/\$$/, '')).replace(/\$$/, '');
    return host.length === 0 || !host.includes('.') ? undefined : `https://${host}`;
  } catch {
    return undefined;
  }
}

export const jwksUrl = (issuer: string): string => `${issuer.replace(/\/+$/, '')}/.well-known/jwks.json`;

let cached: { url: string; jwks: Jwks; at: number } | undefined;
const JWKS_TTL_MS = 10 * 60_000;

/** JWKS is fetched once and refreshed on the hour, or immediately when a token names an unknown key. */
export async function fetchJwks(url: string, force = false): Promise<Jwks | undefined> {
  if (!force && cached?.url === url && Date.now() - cached.at < JWKS_TTL_MS) return cached.jwks;
  try {
    const response = await fetch(url, { 'signal': AbortSignal.timeout(5000) });
    if (!response.ok) {
      logger.warn('clerk jwks fetch failed', { url, 'status': response.status });
      return undefined;
    }
    const body = (await response.json()) as Jwks;
    if (!Array.isArray(body.keys) || body.keys.length === 0) return undefined;
    cached = { url, 'jwks': body, 'at': Date.now() };
    return body;
  } catch (error) {
    logger.warn('clerk jwks fetch threw', { url, 'error': String(error).slice(0, 160) });
    return undefined;
  }
}

/** Test seam: drops the cached keys so a suite can swap issuers. */
export const clearJwksCache = (): void => {
  cached = undefined;
};

/**
 * Verifies a Clerk session token: RS256 signature against the published key, then issuer and time window. Any
 * failure is `undefined` — there is no "trust it and move on" branch, because this is the only thing standing
 * between an anonymous request and the bot's settings.
 */
export async function verifyJwt(
  token: string,
  jwks: Jwks,
  options: { issuer: string; now?: number },
): Promise<ClerkClaims | undefined> {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];
  const header = decodeSegment(rawHeader);
  const payload = decodeSegment(rawPayload);
  if (!header || !payload) return undefined;
  if (header.alg !== 'RS256') return undefined;

  // Only RSA keys can verify RS256; a JWKS may publish several key types, and a mismatch is "no session", not a
  // thrown request (an unhandled throw here closed the socket and surfaced as a 502 through nginx).
  const key = jwks.keys.find(candidate => candidate.kid === header.kid) ?? jwks.keys[0];
  if (key?.kty !== 'RSA' || !key.n || !key.e) return undefined;

  let valid = false;
  try {
    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      { 'kty': 'RSA', 'n': key.n, 'e': key.e, 'alg': 'RS256', 'ext': true },
      { 'name': 'RSASSA-PKCS1-v1_5', 'hash': 'SHA-256' },
      false,
      ['verify'],
    );
    valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      base64UrlToBytes(rawSignature),
      new TextEncoder().encode(`${rawHeader}.${rawPayload}`),
    );
  } catch (error) {
    logger.warn('clerk token verification failed', { 'error': String(error).slice(0, 160) });
    return undefined;
  }
  if (!valid) return undefined;

  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp + SKEW_SECONDS < now) return undefined;
  if (typeof payload.nbf === 'number' && payload.nbf - SKEW_SECONDS > now) return undefined;
  const issuer = typeof payload.iss === 'string' ? payload.iss.replace(/\/+$/, '') : '';
  if (issuer !== options.issuer.replace(/\/+$/, '')) return undefined;
  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  if (sub.length === 0) return undefined;

  const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : undefined;
  return { ...payload, sub, ...(email ? { email } : {}) } as ClerkClaims;
}

/** Authorization header → verified claims, using the configured issuer's published keys. */
export async function authenticate(
  authorization: string | null,
  options: { issuer: string; now?: number },
): Promise<ClerkClaims | undefined> {
  const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
  if (token.length === 0) return undefined;
  const jwks = await fetchJwks(jwksUrl(options.issuer));
  if (!jwks) return undefined;
  const claims = await verifyJwt(token, jwks, options);
  if (!claims) {
    // A key rotation is the one legitimate reason a valid token fails: retry once with fresh keys.
    const refreshed = await fetchJwks(jwksUrl(options.issuer), true);
    return refreshed ? verifyJwt(token, refreshed, options) : undefined;
  }
  return claims;
}
