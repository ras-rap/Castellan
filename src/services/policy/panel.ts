import { guildDefaults, isOwner, config, type GuildSettings } from '@services/config.ts';
import { services } from '@services/discord/services.ts';
import { log } from '@utils/logger.ts';

import {
  defaultFor,
  describeSetting,
  parseSetting,
  settingByPath,
  setSetting,
  settingsByCategory,
  writableBy,
  type Setting,
} from './settings.ts';

const logger = log('policy/panel');

/** `policy.matrix` is not a setting: it is the entry point for the 20 rank × risk cells. */
export const MATRIX_PATH = 'policy.matrix';

export type ApplyResult =
  { ok: true; next: GuildSettings; value: string; reloaded: boolean } | { ok: false; error: string };

/**
 * The single write path for both `/config set` and the `/settings` panel: scope check, parse, write, and the
 * server reload that feature switches need. Keeping it here is what stops the two surfaces from drifting.
 */
export async function applySetting(input: {
  guildId: string;
  userId: string;
  path: string;
  raw: string | undefined;
}): Promise<ApplyResult> {
  const setting = settingByPath(input.path);
  if (!setting) return { 'ok': false, 'error': `unknown setting \`${input.path}\`` };
  if (!writableBy(setting, input.userId))
    return { 'ok': false, 'error': `🔒 \`${setting.path}\` is bot-owner only (${setting.description}).` };

  let parsed: unknown;
  try {
    parsed = input.raw === undefined ? defaultFor(setting.path) : parseSetting(setting.path, input.raw);
  } catch (error) {
    return { 'ok': false, 'error': `⚠️ ${error instanceof Error ? error.message : String(error)}` };
  }

  const current = config.guild(input.guildId) ?? guildDefaults();
  const next = setSetting(current, setting.path, parsed);
  config.patchGuild(input.guildId, { ...next });
  logger.info(input.raw === undefined ? 'config reset' : 'config changed', {
    'guildId': input.guildId,
    'by': input.userId,
    'key': setting.path,
    'value': parsed,
  });

  let reloaded = false;
  if (setting.path.startsWith('features.'))
    try {
      await services.get().supervisor.stop(input.guildId);
      reloaded = true;
    } catch (error) {
      logger.warn('server stop after feature change failed', {
        'guildId': input.guildId,
        'error': String(error).slice(0, 160),
      });
    }

  return { 'ok': true, next, 'value': describeSetting(next, setting.path), reloaded };
}

export type Category = { id: string; label: string; count: number };

const LABELS: Record<string, string> = {
  'access': 'who may use the bot',
  'enabled': 'this server',
  'features': 'tools and behaviour',
  'git': 'git server',
  'model': 'models',
  'policy': 'policy and approvals',
  'roles': 'ranks and roles',
  'shell': 'sandbox',
};

/** Categories a given person may open, with how many keys each holds. */
export function categoriesFor(userId: string): Category[] {
  return [...settingsByCategory(userId).entries()].map(([id, settings]) => ({
    id,
    'label': LABELS[id] ?? id,
    'count': settings.length,
  }));
}

/** The keys inside a category. The matrix cells are reached through {@link MATRIX_PATH} instead. */
export const entriesFor = (userId: string, category: string): Setting[] =>
  settingsByCategory(userId).get(category) ?? [];

export const isOwnerUser = (userId: string): boolean => isOwner(userId);

/** One line under the panel: what the person may touch, which is what stops "why is this greyed out". */
export const scopeNote = (userId: string): string =>
  isOwner(userId)
    ? 'you are the bot owner: every key here is yours to change'
    : 'guild admin: the keys that grant capability, change the sandbox or the rank table are bot-owner only';
