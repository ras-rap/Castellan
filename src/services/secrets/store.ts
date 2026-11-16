import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { paths } from '@services/config.ts';
import { db } from '@services/database/sqlite.ts';
import { log } from '@utils/logger.ts';

const logger = log('secrets');

/**
 * Credentials a server can hold for itself, instead of inheriting the deployment's `.env`. The name is what the
 * dashboard and the store use; `env` is the deployment-wide fallback, kept so an existing install keeps working.
 */
export type SecretName = 'pterodactyl.clientKey' | 'pterodactyl.adminKey' | 'git.token';

export type SecretSpec = {
  name: SecretName;
  label: string;
  /** Which tools stop working without it. */
  usedBy: string;
  /** What a value looks like, so a typo is caught before it reaches a panel. */
  pattern: RegExp;
  patternHint: string;
  /** The `.env` variable this falls back to. */
  env: string;
};

export const SECRET_SPECS: SecretSpec[] = [
  {
    'name': 'pterodactyl.clientKey',
    'label': 'Pterodactyl client key',
    'usedBy': 'the ptero_* tools (server listing, power, console, files)',
    'pattern': /^ptlc_[A-Za-z0-9._-]{8,}$/,
    'patternHint': 'must start with ptlc_',
    'env': 'PTERO_CLIENT_KEY',
  },
  {
    'name': 'pterodactyl.adminKey',
    'label': 'Pterodactyl application key',
    'usedBy': 'the ptero_admin_* tools (users, servers, suspension)',
    'pattern': /^ptla_[A-Za-z0-9._-]{8,}$/,
    'patternHint': 'must start with ptla_',
    'env': 'PTERO_ADMIN_KEY',
  },
  {
    'name': 'git.token',
    'label': 'Git token',
    'usedBy': 'git_push and git_repo_create on this server’s forge',
    'pattern': /^[A-Za-z0-9._-]{16,}$/,
    'patternHint': 'must be at least 16 characters',
    'env': 'GIT_TOKEN',
  },
];

export const secretSpec = (name: string): SecretSpec | undefined => SECRET_SPECS.find(spec => spec.name === name);

type SealedRow = {
  guild_id: string;
  name: string;
  sealed: string;
  hint: string;
  updated_at: number;
  updated_by: string;
};

/** What the dashboard may know: whether a value exists, where it comes from, and its last four characters. */
export type SecretFacts = {
  name: SecretName;
  label: string;
  usedBy: string;
  env: string;
  source: 'guild' | 'env' | 'none';
  hint: string;
  updatedAt: number | null;
  updatedBy: string | null;
};

const KEY_FILE = (): string => resolve(paths.data, 'secrets.key');

/**
 * One key for every server's credentials, on the bot's own disk and never in the repository. `SECRETS_KEY`
 * (base64 or hex, 32 bytes) overrides it for deployments that keep secrets in an orchestrator; the file mode is
 * 0600 and the database only ever holds ciphertext, so a copy of `agent.db` alone reveals nothing.
 */
let cachedKey: Buffer | undefined;

function keyOf(): Buffer {
  if (cachedKey) return cachedKey;
  const supplied = Bun.env.SECRETS_KEY;
  if (supplied !== undefined && supplied.trim().length > 0) {
    const raw = /^[0-9a-f]{64}$/i.test(supplied.trim())
      ? Buffer.from(supplied.trim(), 'hex')
      : Buffer.from(supplied.trim(), 'base64');
    if (raw.length !== 32) throw new Error('SECRETS_KEY must decode to 32 bytes (base64 or hex)');
    cachedKey = raw;
    return raw;
  }
  const file = KEY_FILE();
  if (existsSync(file)) {
    const raw = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
    if (raw.length !== 32)
      throw new Error(
        `${file} does not hold a 32-byte key; delete it to rotate (all stored secrets become unreadable)`,
      );
    cachedKey = raw;
    return raw;
  }
  mkdirSync(resolve(file, '..'), { 'recursive': true });
  const fresh = randomBytes(32);
  writeFileSync(file, fresh.toString('base64'), { 'encoding': 'utf8', 'mode': 0o600 });
  logger.warn('generated a secrets key; back up .data/secrets.key or every per-server credential is lost', { file });
  cachedKey = fresh;
  return fresh;
}

const seal = (plaintext: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyOf(), iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${body.toString('base64')}`;
};

const unseal = (sealed: string): string => {
  const [ivPart, tagPart, bodyPart] = sealed.split('.');
  if (!ivPart || !tagPart || !bodyPart) throw new Error('stored secret is malformed');
  const decipher = createDecipheriv('aes-256-gcm', keyOf(), Buffer.from(ivPart, 'base64'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(bodyPart, 'base64')), decipher.final()]).toString('utf8');
};

/** The last four characters, so a human can tell two keys apart without the value ever leaving the bot. */
const hintOf = (value: string): string => (value.length <= 4 ? '••••' : `••••${value.slice(-4)}`);

const rows = {
  'get': (guildId: string, name: string) =>
    db
      .query<SealedRow, [string, string]>('SELECT * FROM guild_secrets WHERE guild_id = ? AND name = ?')
      .get(guildId, name),
  'all': (guildId: string) =>
    db.query<SealedRow, [string]>('SELECT * FROM guild_secrets WHERE guild_id = ?').all(guildId),
  'set': (row: SealedRow) =>
    db
      .query(
        `INSERT INTO guild_secrets (guild_id, name, sealed, hint, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(guild_id, name) DO UPDATE SET
           sealed = excluded.sealed, hint = excluded.hint,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(row.guild_id, row.name, row.sealed, row.hint, row.updated_at, row.updated_by),
  'delete': (guildId: string, name: string) =>
    db.query('DELETE FROM guild_secrets WHERE guild_id = ? AND name = ?').run(guildId, name).changes > 0,
};

export type SetOutcome = { ok: true; hint: string } | { ok: false; error: string };

/**
 * Store one credential for one server. The value is validated against the shape its provider uses before it is
 * sealed, because a key with a typo only ever fails later, in a tool call the user cannot connect back to this.
 */
export function setSecret(input: { 'guildId': string; 'name': string; 'value': string; 'by': string }): SetOutcome {
  const spec = secretSpec(input.name);
  if (!spec) return { 'ok': false, 'error': `unknown secret ${input.name}` };
  const value = input.value.trim();
  if (value.length === 0) return { 'ok': false, 'error': 'value is empty' };
  if (!spec.pattern.test(value)) return { 'ok': false, 'error': `${spec.label} ${spec.patternHint}` };
  const hint = hintOf(value);
  rows.set({
    'guild_id': input.guildId,
    'name': spec.name,
    'sealed': seal(value),
    'hint': hint,
    'updated_at': Date.now(),
    'updated_by': input.by,
  });
  logger.info('guild secret stored', { 'guildId': input.guildId, 'name': spec.name, 'by': input.by });
  return { 'ok': true, hint };
}

export const clearSecret = (guildId: string, name: string): boolean => {
  const removed = rows.delete(guildId, name);
  if (removed) logger.info('guild secret cleared', { guildId, name });
  return removed;
};

/** The guild's own value, or `undefined` when it has none (never falls back — callers decide that). */
export function guildSecret(guildId: string, name: SecretName): string | undefined {
  const row = rows.get(guildId, name);
  if (!row) return undefined;
  try {
    return unseal(row.sealed);
  } catch (error) {
    logger.error('stored secret cannot be read (wrong key?)', { guildId, name, 'detail': String(error).slice(0, 160) });
    return undefined;
  }
}

/**
 * Precedence for every caller: what this server set, else what the deployment set. Passing the env value in (rather
 * than reading it here) keeps this module testable and keeps `utils/env.ts` the one place env is parsed.
 */
export const resolveSecret = (guildId: string, name: SecretName, envValue?: string): string | undefined => {
  const own = guildSecret(guildId, name);
  if (own !== undefined && own.length > 0) return own;
  return envValue !== undefined && envValue.length > 0 ? envValue : undefined;
};

/** Write-only view for the dashboard: no values, no ciphertext, no key. */
export function listSecrets(guildId: string, env: Partial<Record<string, string>>): SecretFacts[] {
  const stored = new Map(rows.all(guildId).map(row => [row.name, row]));
  return SECRET_SPECS.map(spec => {
    const row = stored.get(spec.name);
    const fromEnv = (env[spec.env] ?? '').length > 0;
    return {
      'name': spec.name,
      'label': spec.label,
      'usedBy': spec.usedBy,
      'env': spec.env,
      'source': row ? 'guild' : fromEnv ? 'env' : 'none',
      'hint': row?.hint ?? '',
      'updatedAt': row?.updated_at ?? null,
      'updatedBy': row?.updated_by ?? null,
    };
  });
}

/** How many credentials this server holds itself, for status reporting. */
export const secretCount = (guildId: string): number => rows.all(guildId).length;
