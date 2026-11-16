import { db } from '@services/database/sqlite.ts';
import { clearSecret, guildSecret, listSecrets, resolveSecret, setSecret } from '@services/secrets/store.ts';
import { afterEach, describe, expect, test } from 'bun:test';

const GUILD = 'secret-test-guild';
const CLIENT_KEY = 'ptlc_abcdefgh12345678xyz';

const wipe = () => db.query('DELETE FROM guild_secrets WHERE guild_id = ?').run(GUILD);

afterEach(wipe);

describe('per-server credentials', () => {
  test('a stored value round-trips and is sealed in the table', () => {
    const stored = setSecret({
      'guildId': GUILD,
      'name': 'pterodactyl.clientKey',
      'value': CLIENT_KEY,
      'by': 'web:a@b',
    });
    expect(stored).toEqual({ 'ok': true, 'hint': '••••8xyz' });
    expect(guildSecret(GUILD, 'pterodactyl.clientKey')).toBe(CLIENT_KEY);

    const row = db
      .query<{ sealed: string }, [string]>('SELECT sealed FROM guild_secrets WHERE guild_id = ?')
      .get(GUILD);
    // the database alone must not be enough: no plaintext anywhere in the stored column
    expect(row?.sealed).not.toContain(CLIENT_KEY);
    expect(row?.sealed).not.toContain('abcdefgh');
    expect(row?.sealed.split('.')).toHaveLength(3);
  });

  test('the guild wins over the deployment, and clearing falls back to it', () => {
    expect(resolveSecret(GUILD, 'pterodactyl.clientKey', 'ptlc_envenv')).toBe('ptlc_envenv');
    setSecret({ 'guildId': GUILD, 'name': 'pterodactyl.clientKey', 'value': CLIENT_KEY, 'by': 'web:a@b' });
    expect(resolveSecret(GUILD, 'pterodactyl.clientKey', 'ptlc_envenv')).toBe(CLIENT_KEY);
    expect(clearSecret(GUILD, 'pterodactyl.clientKey')).toBe(true);
    expect(resolveSecret(GUILD, 'pterodactyl.clientKey', 'ptlc_envenv')).toBe('ptlc_envenv');
    // no guild value and no deployment value is "not configured", not an empty string
    expect(resolveSecret(GUILD, 'git.token', undefined)).toBeUndefined();
    expect(resolveSecret(GUILD, 'git.token', '')).toBeUndefined();
  });

  test('the dashboard view never carries a value', () => {
    setSecret({ 'guildId': GUILD, 'name': 'git.token', 'value': 'glpat-token-1234567890', 'by': 'web:a@b' });
    const rows = listSecrets(GUILD, { 'PTERO_ADMIN_KEY': 'ptla_from_env' });
    const json = JSON.stringify(rows);
    expect(json).not.toContain('glpat-token-1234567890');
    expect(json).not.toContain('ptla_from_env');
    const git = rows.find(row => row.name === 'git.token');
    expect(git?.source).toBe('guild');
    expect(git?.hint).toBe('••••7890');
    expect(rows.find(row => row.name === 'pterodactyl.adminKey')?.source).toBe('env');
    expect(rows.find(row => row.name === 'pterodactyl.clientKey')?.source).toBe('none');
  });

  test('a value the provider would reject never reaches the store', () => {
    expect(setSecret({ 'guildId': GUILD, 'name': 'pterodactyl.clientKey', 'value': 'not-a-key', 'by': 't' })).toEqual({
      'ok': false,
      'error': 'Pterodactyl client key must start with ptlc_',
    });
    expect(setSecret({ 'guildId': GUILD, 'name': 'nope', 'value': 'x', 'by': 't' })).toEqual({
      'ok': false,
      'error': 'unknown secret nope',
    });
    expect(guildSecret(GUILD, 'pterodactyl.clientKey')).toBeUndefined();
  });
});
