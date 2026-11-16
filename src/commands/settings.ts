import { accessGuard, guildEnabled, guildOnly } from '@guards/index.ts';
import { RANK_NAMES, RISK_NAMES, config, guildDefaults } from '@services/config.ts';
import { ceilingFor } from '@services/policy/hard.ts';
import { MATRIX_PATH, applySetting, categoriesFor, entriesFor, scopeNote } from '@services/policy/panel.ts';
import { describeSetting, domainOf, readSetting, settingByPath } from '@services/policy/settings.ts';
import { BRAND_COLOR, EPHEMERAL } from '@utils/constants.ts';
import { log } from '@utils/logger.ts';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { ButtonComponent, Discord, Guard, ModalComponent, SelectMenuComponent, Slash } from 'discordx';

import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';

const logger = log('commands/settings');

type Row = ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>;
export type View = { embeds: EmbedBuilder[]; components: Row[] };

const currentSettings = (guildId: string) => config.guild(guildId) ?? guildDefaults();
const currentValue = (guildId: string, path: string): string => describeSetting(currentSettings(guildId), path);

/** Lists arrive as `string[] | undefined`; the panel only needs to know which boxes are ticked. */
const listAt = (guildId: string, path: string): string[] => {
  const value = readSetting(currentSettings(guildId), path);
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
};

const button = (id: string, label: string, style: ButtonStyle = ButtonStyle.Secondary, disabled = false) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);

const backRow = (category?: string): Row =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    category
      ? button(`cst:set:list:${category}`, '← back')
      : button('cst:set:root', '← categories', ButtonStyle.Secondary),
    button('cst:set:root', 'dismiss', ButtonStyle.Danger),
  );

/** Root: one select of categories. Everything else is two more clicks from here. */
export function rootView(userId: string): View {
  const categories = categoriesFor(userId);
  const select = new StringSelectMenuBuilder()
    .setCustomId('cst:set:cat')
    .setPlaceholder('what do you want to change?')
    .addOptions(
      categories.slice(0, 25).map(category => ({
        'label': category.id,
        'value': category.id,
        'description': `${category.label} · ${category.count} key${category.count === 1 ? '' : 's'}`,
      })),
    );

  return {
    'embeds': [
      new EmbedBuilder()
        .setTitle('settings')
        .setColor(BRAND_COLOR)
        .setDescription(
          [
            'Pick a category, then a key: buttons for on/off, a menu for choices, a form for free text.',
            'The value you see is the one in force right now — the same keys `/config set` writes.',
          ].join('\n'),
        )
        .setFooter({ 'text': scopeNote(userId) }),
    ],
    'components': [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
  };
}

/** One category: its keys, each described by its current value. */
export function categoryView(userId: string, guildId: string, category: string): View {
  const settings = entriesFor(userId, category);
  const options = settings
    .filter(setting => setting.path !== MATRIX_PATH && !setting.path.startsWith(`${MATRIX_PATH}.`))
    .slice(0, 25)
    .map(setting => ({
      'label': setting.path.slice(category.length + 1).slice(0, 100),
      'value': setting.path,
      'description': `${currentValue(guildId, setting.path).slice(0, 80)} — ${setting.description}`.slice(0, 100),
    }));

  if (category === 'policy')
    options.push({
      'label': 'rank ceilings…',
      'value': MATRIX_PATH,
      'description': `${RANK_NAMES.length} ranks × ${RISK_NAMES.length} risk classes`,
    });

  return {
    'embeds': [
      new EmbedBuilder()
        .setTitle(`settings · ${category}`)
        .setColor(BRAND_COLOR)
        .setDescription(
          options.length === 0
            ? 'no keys you may change in this category'
            : `${options.length} key${options.length === 1 ? '' : 's'} — the description is the value in force.`,
        ),
    ],
    'components': [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`cst:set:list:${category}`)
          .setPlaceholder('pick a key')
          .addOptions(options),
      ),
      backRow(),
    ],
  };
}

/** One key: the control matches the value domain, so nobody types `off` into a text box. */
export function settingView(userId: string, guildId: string, path: string): View {
  const setting = settingByPath(path);
  if (!setting) return rootView(userId);
  const domain = domainOf(path);
  const value = currentValue(guildId, path);
  const category = path.split('.')[0] ?? '';
  const description = [`**${path}**`, setting.description, `now: \`${value}\``, `scope: ${setting.scope}`].join('\n');
  const result: View = {
    'embeds': [new EmbedBuilder().setTitle(`settings · ${path}`).setColor(BRAND_COLOR).setDescription(description)],
    'components': [backRow(category)],
  };

  if (domain?.kind === 'multi' && domain.choices) {
    const selected = new Set(listAt(guildId, path));
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`cst:set:multi:${path}`)
      .setPlaceholder('nothing selected = everything on')
      .setMinValues(0)
      .setMaxValues(Math.min(domain.choices.length, 25))
      .addOptions(
        domain.choices
          .slice(0, 25)
          .map(choice => ({ 'label': choice, 'value': choice, 'default': selected.has(choice) })),
      );
    result.components.unshift(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
  } else if (domain?.kind === 'choice' && domain.choices) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`cst:set:val:${path}`)
      .setPlaceholder('pick a value')
      .addOptions(
        domain.choices.slice(0, 25).map(choice => ({
          'label': choice,
          'value': choice,
          'default': choice === value,
        })),
      );
    result.components.unshift(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
  } else if (domain?.kind === 'boolean')
    result.components.unshift(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(`cst:set:b:${path}:true`, 'on', value === 'true' ? ButtonStyle.Success : ButtonStyle.Secondary),
        button(`cst:set:b:${path}:false`, 'off', value === 'false' ? ButtonStyle.Success : ButtonStyle.Secondary),
      ),
    );
  else {
    result.components.unshift(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(`cst:set:edit:${path}`, 'edit…', ButtonStyle.Primary),
        button(`cst:set:reset:${path}`, 'reset to default'),
      ),
    );
    result.embeds[0]?.setFooter({ 'text': domain?.placeholder ?? 'free text' });
  }

  if (domain?.kind === 'choice' || domain?.kind === 'boolean' || domain?.kind === 'multi')
    result.components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(button(`cst:set:reset:${path}`, 'reset to default')),
    );

  return result;
}

/** The 20 rank × risk cells, two selects deep instead of one exact dotted path. */
export function matrixRankView(userId: string, guildId: string): View {
  const select = new StringSelectMenuBuilder()
    .setCustomId('cst:set:mrank')
    .setPlaceholder('which rank?')
    .addOptions(
      RANK_NAMES.map(rank => ({
        'label': rank,
        'value': rank,
        'description': RISK_NAMES.map(
          risk => `${risk.slice(0, 4)}:${currentValue(guildId, `${MATRIX_PATH}.${rank}.${risk}`)}`,
        )
          .join(' · ')
          .slice(0, 100),
      })),
    );

  return {
    'embeds': [
      new EmbedBuilder()
        .setTitle('settings · rank ceilings')
        .setColor(BRAND_COLOR)
        .setDescription('What each rank may do without a human. Pick a rank, then a risk class.'),
    ],
    'components': [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), backRow('policy')],
  };
}

export function matrixRiskView(userId: string, guildId: string, rank: string): View {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`cst:set:mrisk:${rank}`)
    .setPlaceholder('which risk class?')
    .addOptions(
      RISK_NAMES.map(risk => ({
        'label': `${rank} · ${risk}`,
        'value': risk,
        'description': `now: ${currentValue(guildId, `${MATRIX_PATH}.${rank}.${risk}`)}`,
      })),
    );

  const builtIn = RANK_NAMES.indexOf(rank as (typeof RANK_NAMES)[number]);
  return {
    'embeds': [
      new EmbedBuilder()
        .setTitle(`settings · ${rank}`)
        .setColor(BRAND_COLOR)
        .setDescription(
          `Built-in table: ${RISK_NAMES.map(risk => `${risk}=${ceilingFor(guildDefaults().policy, (builtIn || 1) as 1 | 2 | 3 | 4, risk).verdict}`).join(' · ')}`,
        ),
    ],
    'components': [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), backRow('policy')],
  };
}

/** Applies a value, then shows the refreshed key so repeated edits stay one click apart. */
async function commit(
  interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
  path: string,
  raw: string | undefined,
): Promise<void> {
  const guildId = interaction.guildId ?? '';
  const applied = await applySetting({ guildId, 'userId': interaction.user.id, path, raw });
  if (!applied.ok) {
    await interaction.reply({ 'content': applied.error, 'flags': EPHEMERAL });
    return;
  }
  const view = settingView(interaction.user.id, guildId, path);
  const note = `${
    raw === undefined ? '♻️ reset' : '✅ set'
  } \`${path}\` → \`${applied.value}\`${applied.reloaded ? ' · agent server stops, reloads on the next prompt' : ''}`;
  view.embeds[0]?.setDescription(`${note}\n\n${view.embeds[0].data.description ?? ''}`);
  logger.info('settings panel applied', {
    'guildId': guildId,
    'by': interaction.user.id,
    path,
    'reset': raw === undefined,
  });

  if (interaction.isModalSubmit()) await interaction.reply({ ...view, 'flags': EPHEMERAL });
  else await interaction.update(view);
}

@Discord()
export class SettingsCommand {
  @Slash({ 'name': 'settings', 'description': 'Point-and-click settings for this server' })
  @Guard(accessGuard, guildOnly, guildEnabled)
  async open(interaction: ChatInputCommandInteraction) {
    await interaction.reply({ ...rootView(interaction.user.id), 'flags': EPHEMERAL });
  }

  @SelectMenuComponent({ 'id': /^cst:set:cat$/ })
  async onCategory(interaction: StringSelectMenuInteraction) {
    const category = interaction.values[0] ?? '';
    const panel = categoryView(interaction.user.id, interaction.guildId ?? '', category);
    await interaction.update(panel);
  }

  @SelectMenuComponent({ 'id': /^cst:set:list:/ })
  async onKey(interaction: StringSelectMenuInteraction) {
    const guildId = interaction.guildId ?? '';
    const [, , , category] = interaction.customId.split(':');
    const path = interaction.values[0] ?? '';
    const panel =
      path === MATRIX_PATH
        ? matrixRankView(interaction.user.id, guildId)
        : settingView(interaction.user.id, guildId, path);
    // A category with nothing I may change: stay put rather than show an empty menu.
    await interaction.update(
      panel.components.length > 0 ? panel : categoryView(interaction.user.id, guildId, category ?? ''),
    );
  }

  @SelectMenuComponent({ 'id': /^cst:set:mrank$/ })
  async onMatrixRank(interaction: StringSelectMenuInteraction) {
    const rank = interaction.values[0] ?? '';
    await interaction.update(matrixRiskView(interaction.user.id, interaction.guildId ?? '', rank));
  }

  @SelectMenuComponent({ 'id': /^cst:set:mrisk:/ })
  async onMatrixRisk(interaction: StringSelectMenuInteraction) {
    const rank = interaction.customId.split(':')[3] ?? '';
    const risk = interaction.values[0] ?? '';
    await interaction.update(
      settingView(interaction.user.id, interaction.guildId ?? '', `${MATRIX_PATH}.${rank}.${risk}`),
    );
  }

  @SelectMenuComponent({ 'id': /^cst:set:multi:/ })
  async onMulti(interaction: StringSelectMenuInteraction) {
    const path = interaction.customId.slice('cst:set:multi:'.length);
    await commit(interaction, path, [...interaction.values].join(','));
  }

  @SelectMenuComponent({ 'id': /^cst:set:val:/ })
  async onValue(interaction: StringSelectMenuInteraction) {
    const path = interaction.customId.slice('cst:set:val:'.length);
    await commit(interaction, path, interaction.values[0] ?? '');
  }

  @ButtonComponent({ 'id': /^cst:set:/ })
  async onButton(interaction: ButtonInteraction) {
    const [, , action, ...rest] = interaction.customId.split(':');
    const guildId = interaction.guildId ?? '';

    if (action === 'root') {
      await interaction.update(rootView(interaction.user.id));
      return;
    }
    if (action === 'list') {
      const category = rest.join(':');
      await interaction.update(
        entriesFor(interaction.user.id, category).length === 0
          ? rootView(interaction.user.id)
          : categoryView(interaction.user.id, guildId, category),
      );
      return;
    }
    if (action === 'edit') {
      const path = rest.join(':');
      const domain = domainOf(path);
      const input = new TextInputBuilder()
        .setCustomId('value')
        .setLabel(path.slice(0, 45))
        .setPlaceholder((domain?.placeholder ?? 'new value').slice(0, 100))
        .setStyle(domain?.kind === 'list' ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(600);
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(`cst:set:modal:${path}`)
          .setTitle(settingByPath(path)?.description.slice(0, 45) ?? 'edit setting')
          .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input) as never),
      );
      return;
    }
    if (action === 'reset') {
      await commit(interaction, rest.join(':'), undefined);
      return;
    }
    if (action === 'b') {
      const [path, value] = [rest.slice(0, -1).join(':'), rest.at(-1) ?? 'true'];
      await commit(interaction, path, value);
      return;
    }

    logger.warn('unknown settings button', { 'customId': interaction.customId });
    await interaction.reply({ 'content': 'unknown control', 'flags': EPHEMERAL });
  }

  @ModalComponent({ 'id': /^cst:set:modal:/ })
  async onModal(interaction: ModalSubmitInteraction) {
    const path = interaction.customId.slice('cst:set:modal:'.length);
    await commit(interaction, path, interaction.fields.getTextInputValue('value'));
  }
}
