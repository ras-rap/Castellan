import { accessGuard, guildEnabled, guildOnly, managerOnly } from '@guards/index.ts';
import { effectiveModel } from '@services/agent/models.ts';
import { TOOL_SETS } from '@services/bridge/capabilities.ts';
import { RANK_NAMES, config, isOwner, type GuildPolicy } from '@services/config.ts';
import { ceilingFor, tierOf } from '@services/policy/hard.ts';
import { jevMode } from '@services/policy/jev.ts';
import { applySetting } from '@services/policy/panel.ts';
import { SETTINGS, writableBy } from '@services/policy/settings.ts';
import { BRAND_COLOR, EPHEMERAL } from '@utils/constants.ts';
import { ApplicationCommandOptionType, EmbedBuilder } from 'discord.js';
import { Discord, Guard, Slash, SlashGroup, SlashOption } from 'discordx';

import type { AutocompleteInteraction, ChatInputCommandInteraction, GuildMember } from 'discord.js';

const policySummary = (policy: GuildPolicy): string => {
  const mode =
    policy.mode === 'vibe'
      ? `vibe — runs unattended, Jev ${policy.vibe.screen} vetoes catastrophic calls (max risk: ${policy.vibe.maxRisk}${policy.vibe.askOnUncertain ? ', asks when unsure' : ''})`
      : policy.mode === 'locked'
        ? 'locked — nothing above read runs, whatever the rank'
        : 'ask — anything the ceiling does not allow outright becomes an approval card';
  return [
    `mode: **${policy.mode}** — ${mode.slice(mode.indexOf('—') + 1).trim()}`,
    `review: **${policy.review.mode}** — the agent re-reads each non-read call it is about to make` +
      ` (min confidence ${policy.review.minConfidence})`,
    `tools denied: ${policy.tools.deny.length > 0 ? policy.tools.deny.join(', ') : 'none'}`,
    `tools allowed: ${policy.tools.allow.length > 0 ? policy.tools.allow.join(', ') : 'none'}`,
  ].join('\n');
};

const matrixTable = (policy: GuildPolicy): string => {
  const rows = RANK_NAMES.slice(1).map(rank => {
    const tier = RANK_NAMES.indexOf(rank) as 1 | 2 | 3 | 4;
    const cells = (['read', 'reversible', 'destructive', 'admin'] as const).map(risk => {
      const value = ceilingFor(policy, tier, risk);
      return `${risk.slice(0, 4)}:${value.verdict}${value.source === 'matrix' ? '*' : ''}`;
    });
    return `${rank.padEnd(8)} ${cells.join(' · ')}`;
  });
  rows.push('* = this guild overrides the built-in table');
  return rows.join('\n');
};

async function suggestKeys(interaction: AutocompleteInteraction): Promise<void> {
  const typed = String(interaction.options.getFocused() ?? '').toLowerCase();
  const userId = interaction.user.id;
  const choices = SETTINGS.filter(setting => writableBy(setting, userId))
    .map(setting => setting.path)
    .filter(path => path.toLowerCase().includes(typed))
    .slice(0, 25)
    .map(path => ({ 'name': path.slice(0, 100), 'value': path }));
  await interaction.respond(choices);
}

@Discord()
@SlashGroup({ 'name': 'config', 'description': 'Permissions, sandbox and policy for this server' })
export class ConfigCommand {
  @Slash({ 'name': 'show', 'description': 'The permissions and policy in force here' })
  @SlashGroup('config')
  @Guard(accessGuard, guildOnly, guildEnabled)
  async show(interaction: ChatInputCommandInteraction) {
    const guildId = interaction.guildId ?? '';
    const policy = config.policy(guildId);
    const features = config.features(guildId);
    const access = config.access(guildId);
    const git = config.git(guildId);
    const shell = config.guild(guildId)?.shell;
    const editable = SETTINGS.filter(setting => writableBy(setting, interaction.user.id));
    // discordx hands over the cached member payload; tierOf reads only id, roles and guild.ownerId.
    const member = (interaction.member ?? null) as GuildMember | null;

    const embed = new EmbedBuilder()
      .setTitle('config')
      .setColor(BRAND_COLOR)
      .addFields(
        { 'name': 'policy', 'value': policySummary(policy), 'inline': false },
        { 'name': 'rank ceilings', 'value': `\`\`\`\n${matrixTable(policy)}\n\`\`\``, 'inline': false },
        {
          'name': 'sandbox',
          'value':
            `shell mode **${shell?.mode ?? 'docker'}** · image \`${shell?.image ?? '-'}\` · fallback ${shell?.fallback ?? 'error'}` +
            (shell?.mode === 'host' ? '\n⚠️ host mode runs shell calls as the bot user, no container' : ''),
          'inline': false,
        },
        {
          'name': 'features',
          'value':
            `tools off: **${features.tools.disabled.join(', ') || 'none'}** · clarify **${features.clarify}**\n` +
            `switchable sets: ${TOOL_SETS.join(', ')}`,
          'inline': false,
        },
        {
          'name': 'access',
          'value':
            `blocked: **${access.blocked.length}** · profiles: **${Object.keys(access.users).length}**\n` +
            '`/access show` for who, `/access set|block|unblock|clear` (bot owner)',
          'inline': false,
        },
        {
          'name': 'git',
          'value': git.enabled
            ? `${git.provider} at \`${git.baseUrl || '(GIT_BASE_URL)'}\` · auto-push **${git.push ? 'on' : 'off'}** · ` +
              `create repos **${git.createRepos ? 'on' : 'off'}** (${git.visibility})`
            : 'local repository only — every turn is committed, nothing is pushed',
          'inline': false,
        },
        {
          'name': 'model',
          'value': `primary \`${effectiveModel('primary', guildId).id}\` · fast \`${effectiveModel('fast', guildId).id}\``,
          'inline': false,
        },
        {
          'name': 'who can change what',
          'value':
            `you are rank **${RANK_NAMES[tierOf(guildId, member)]}** and can set ` +
            `${editable.length} of ${SETTINGS.length} keys` +
            (isOwner(interaction.user.id)
              ? ' (bot owner: all scopes)'
              : ' — sandbox, role lists and the permission matrix are bot-owner only'),
          'inline': false,
        },
        { 'name': 'jev', 'value': `deployment mode \`${jevMode}\``, 'inline': false },
      )
      .setFooter({ 'text': '/settings to change these by clicking · /config set key value for scripts' });

    await interaction.reply({ 'embeds': [embed], 'flags': EPHEMERAL });
  }

  @Slash({ 'name': 'set', 'description': 'Change one setting here (scope-checked)' })
  @SlashGroup('config')
  @Guard(accessGuard, guildOnly, guildEnabled, managerOnly)
  async set(
    @SlashOption({
      'name': 'key',
      'description': 'which setting, e.g. policy.mode',
      'required': true,
      'type': ApplicationCommandOptionType.String,
      'autocomplete': (interaction: AutocompleteInteraction) => suggestKeys(interaction),
    })
    key: string,
    @SlashOption({
      'name': 'value',
      'description': 'new value, e.g. vibe — lists are comma separated',
      'required': true,
      'type': ApplicationCommandOptionType.String,
    })
    value: string,
    interaction: ChatInputCommandInteraction,
  ) {
    const guildId = interaction.guildId ?? '';
    const applied = await applySetting({ guildId, 'userId': interaction.user.id, 'path': key.trim(), 'raw': value });
    if (!applied.ok) {
      await interaction.reply({ 'content': applied.error, 'flags': EPHEMERAL });
      return;
    }

    const policy = config.policy(guildId);
    await interaction.reply({
      'content':
        `✅ \`${key.trim()}\` → \`${applied.value}\`` +
        (policy.mode === 'vibe' ? '\n⚠️ vibe mode is on: tool calls run without an approval card.' : '') +
        (applied.reloaded ? '\n↻ agent server stopped — the new tool list and persona load on the next prompt.' : ''),
      'flags': EPHEMERAL,
    });
  }

  @Slash({ 'name': 'reset', 'description': 'Restore one setting to its default' })
  @SlashGroup('config')
  @Guard(accessGuard, guildOnly, guildEnabled, managerOnly)
  async reset(
    @SlashOption({
      'name': 'key',
      'description': 'which setting to reset',
      'required': true,
      'type': ApplicationCommandOptionType.String,
      'autocomplete': (interaction: AutocompleteInteraction) => suggestKeys(interaction),
    })
    key: string,
    interaction: ChatInputCommandInteraction,
  ) {
    const guildId = interaction.guildId ?? '';
    const applied = await applySetting({
      guildId,
      'userId': interaction.user.id,
      'path': key.trim(),
      'raw': undefined,
    });
    await interaction.reply({
      'content': applied.ok
        ? `♻️ \`${key.trim()}\` back to default — now \`${applied.value}\`${applied.reloaded ? '\n↻ agent server stopped — it reloads on the next prompt.' : ''}`
        : applied.error,
      'flags': EPHEMERAL,
    });
  }
}
