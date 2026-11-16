import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { RANK_NAMES, RISK_NAMES, config, guildDefaults } from '@services/config.ts';
import { MATRIX_PATH, applySetting, categoriesFor, entriesFor } from '@services/policy/panel.ts';
import {
  SETTINGS,
  describeSetting,
  domainOf,
  parseSetting,
  settingByPath,
  writableBy,
} from '@services/policy/settings.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { ButtonBuilder, StringSelectMenuBuilder } from 'discord.js';

import { categoryView, matrixRankView, rootView, settingView, type View } from '@/commands/settings.ts';

const tempDirs: string[] = [];
const savedGuildsFile = process.env.GUILDS_FILE;

const useGuilds = (guilds: Record<string, unknown>): void => {
  const dir = mkdtempSync(resolve(tmpdir(), 'castellan-panel-'));
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

const components = (view: View) => view.components.flatMap(row => row.components);
const selectOf = (view: View) =>
  components(view).find((part): part is StringSelectMenuBuilder => part instanceof StringSelectMenuBuilder);
const optionValues = (view: View): string[] => (selectOf(view)?.options ?? []).map(option => option.data.value ?? '');
const buttonIds = (view: View): string[] =>
  components(view)
    .filter((part): part is ButtonBuilder => part instanceof ButtonBuilder)
    .map(part => ('custom_id' in part.data ? (part.data.custom_id ?? '') : ''));

describe('settings panel model', () => {
  test('every key has a value domain, and every listed choice is one the parser accepts', () => {
    for (const setting of SETTINGS) {
      const domain = domainOf(setting.path);
      expect(domain, `${setting.path} has no value domain`).toBeDefined();
      if (domain?.kind !== 'choice') continue;
      expect(domain.choices?.length ?? 0).toBeGreaterThan(0);
      // the menu must never offer a value `/config set` would reject
      for (const choice of domain.choices ?? []) expect(() => parseSetting(setting.path, choice)).not.toThrow();
    }
    expect(domainOf('policy.matrix.trusted.destructive')?.choices).toEqual(['allow', 'ask', 'deny']);
  });

  test('categories follow the registry and hide what the person may not write', () => {
    // OWNER_ID is unset in tests, so only admin-scoped keys are visible to a normal admin
    const adminCategories = categoriesFor('someone');
    const ids = adminCategories.map(category => category.id);
    expect(ids).toContain('policy');
    expect(ids).toContain('features');
    expect(ids).not.toContain('shell');
    expect(ids).not.toContain('git');
    expect(adminCategories.find(category => category.id === 'policy')?.count).toBeGreaterThan(0);

    // every key in a visible category is one this person may write
    for (const category of adminCategories)
      for (const setting of entriesFor('someone', category.id)) expect(writableBy(setting, 'someone')).toBe(true);
  });

  test('a write goes through the same validator as /config set', async () => {
    useGuilds({ 'g': { 'enabled': true } });
    const applied = await applySetting({ 'guildId': 'g', 'userId': 'someone', 'path': 'policy.mode', 'raw': 'vibe' });
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(applied.value).toBe('vibe');
    expect(config.policy('g').mode).toBe('vibe');

    const rejected = await applySetting({ 'guildId': 'g', 'userId': 'someone', 'path': 'policy.mode', 'raw': 'yolo' });
    expect(rejected).toEqual({ 'ok': false, 'error': expect.stringContaining('must be one of ask, vibe, locked') });
    expect(config.policy('g').mode).toBe('vibe');

    // owner-scoped keys stay out of an admin's reach, and reset restores the schema default
    const locked = await applySetting({ 'guildId': 'g', 'userId': 'someone', 'path': 'shell.mode', 'raw': 'host' });
    expect(locked.ok).toBe(false);
    const reset = await applySetting({ 'guildId': 'g', 'userId': 'someone', 'path': 'policy.mode', 'raw': undefined });
    expect(reset.ok).toBe(true);
    expect(config.policy('g').mode).toBe('ask');
  });
});

describe('panel views', () => {
  const GUILD = 'g';

  test('the root offers one select of categories', () => {
    useGuilds({ [GUILD]: { 'enabled': true } });
    const view = rootView('someone');
    expect(view.components).toHaveLength(1);
    const values = optionValues(view);
    expect(values).toContain('policy');
    expect(new Set(values).size).toBe(values.length);
    // Discord rejects a select with more than 25 options
    expect(values.length).toBeLessThanOrEqual(25);
    expect(view.embeds[0]?.data.description).toContain('Pick a category');
  });

  test('a category lists its keys with the value in force, and policy adds the matrix door', () => {
    useGuilds({ [GUILD]: { 'enabled': true } });
    const view = categoryView('someone', GUILD, 'policy');
    const values = optionValues(view);
    expect(values).toContain('policy.mode');
    expect(values).toContain(MATRIX_PATH);
    expect(values.length).toBeLessThanOrEqual(25);
    const mode = selectOf(view)?.options.find(option => option.data.value === 'policy.mode');
    expect(mode?.data.description).toContain('ask');
  });

  test('a choice key renders a select with its values, a boolean two buttons, text a form button', () => {
    useGuilds({ [GUILD]: { 'enabled': true } });
    const choice = settingView('someone', GUILD, 'policy.mode');
    const options = selectOf(choice)?.options ?? [];
    expect(options.map(option => option.data.value)).toEqual(['ask', 'vibe', 'locked']);
    expect(options.find(option => option.data.default)?.data.value).toBe('ask');

    const boolean = settingView('someone', GUILD, 'features.clarify');
    // clarify is a choice too, so take a real boolean
    const flag = settingView('someone', GUILD, 'policy.vibe.askOnUncertain');
    expect(selectOf(flag)).toBeUndefined();
    const buttons = buttonIds(flag);
    expect(buttons.some(id => id.endsWith('askOnUncertain:true'))).toBe(true);
    expect(buttons.some(id => id.endsWith('askOnUncertain:false'))).toBe(true);
    expect(boolean.embeds[0]?.data.description).toContain('features.clarify');

    const text = settingView('someone', GUILD, 'shell.image');
    const textIds = buttonIds(text);
    expect(textIds).toContain('cst:set:edit:shell.image');
  });

  test('the matrix takes a rank, then a risk, and lands on the right cell', () => {
    useGuilds({ [GUILD]: { 'enabled': true } });
    const ranks = optionValues(matrixRankView('someone', GUILD));
    expect(ranks).toEqual([...RANK_NAMES]);
    // the second step is the setting view for one exact path
    const cell = settingView('someone', GUILD, `${MATRIX_PATH}.trusted.destructive`);
    expect(cell.embeds[0]?.data.description).toContain('policy.matrix.trusted.destructive');
    expect(selectOf(cell)?.options.map(option => option.data.value)).toEqual(['allow', 'ask', 'deny']);
    expect(RISK_NAMES).toEqual(['read', 'reversible', 'destructive', 'admin']);
  });

  test('what the panel shows is what the registry says is in force', () => {
    useGuilds({ [GUILD]: { 'enabled': true, 'policy': { 'mode': 'locked' } } });
    const shown = settingView('someone', GUILD, 'policy.mode').embeds[0]?.data.description ?? '';
    expect(shown).toContain(describeSetting(guildDefaults(), 'policy.mode'));
    expect(shown).toContain('locked');
    expect(settingByPath('policy.mode')?.scope).toBe('admin');
  });
});
