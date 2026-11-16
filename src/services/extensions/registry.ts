import { config } from '@services/config.ts';

import { accessExtension } from './access.ts';
import { discordExtension } from './discord.ts';
import { gitExtension } from './git.ts';
import { memoryExtension } from './memory.ts';
import { pterodactylExtension } from './pterodactyl.ts';
import { shellExtension } from './shell.ts';

import type { Availability, Extension, ExtensionCapability } from './protocol.ts';

/**
 * Every extension the bot ships, in the order they are offered. **Adding one is two steps**: drop a file next to
 * these that exports an `Extension` (see `docs/EXTENSIONS.md`), and add it here. The bridge validates against it,
 * the codegen writes the model's tool list from it, `/settings` and the dashboard toggle it, and the policy gate
 * classifies it — nothing else has to be touched.
 */
export const EXTENSIONS: Extension[] = [
  discordExtension,
  accessExtension,
  shellExtension,
  gitExtension,
  pterodactylExtension,
  memoryExtension,
];

export type RegisteredCapability = ExtensionCapability & {
  extension: string;
  /** Extension id plus whatever finer sets the tool declared (`channels`, `pterodactyl-admin`, …). */
  sets: string[];
};

/** Flat tool list: what the bridge, codegen, gate and `/help` all read. */
export const capabilities: RegisteredCapability[] = EXTENSIONS.flatMap(extension =>
  extension.capabilities.map(capability => ({
    ...capability,
    'extension': extension.id,
    'sets': [extension.id, ...(capability.sets ?? [])],
  })),
);

export const capabilityNames: string[] = capabilities.map(capability => capability.name);

const SETS: Record<string, string[]> = Object.fromEntries(
  capabilities.map(capability => [capability.name, capability.sets]),
);

/** Everything a guild may name in a tool list: extension ids, the finer sets, and tool names. */
export const TOOL_SETS: string[] = [
  ...new Set([...EXTENSIONS.map(extension => extension.id), ...capabilities.flatMap(capability => capability.sets)]),
];

export const setsOf = (name: string): string[] => SETS[name] ?? [];

export const toolSetNames = (): string[] => [...capabilityNames, ...TOOL_SETS];

/**
 * True when the tool is in the list — by name, or through any set it belongs to. The caller decides which way to
 * read it: a deny list (`features.extensions.disabled`, `features.tools.disabled`, `policy.tools.deny`,
 * `access.users.<id>.tools.deny`) refuses the match, a whitelist (`tools.allow`) refuses everything that does not.
 */
export const toolListed = (name: string, list: readonly string[]): boolean =>
  list.includes(name) || setsOf(name).some(set => list.includes(set));

export const extensionOf = (name: string): string | undefined =>
  capabilities.find(capability => capability.name === name)?.extension;

export type ExtensionStatus = {
  id: string;
  name: string;
  description: string;
  /** Not switched off for this guild. */
  enabled: boolean;
  /** Configured for this guild at all (a panel needs keys, a forge needs a token…). */
  available: boolean;
  reason: string;
  tools: number;
};

/**
 * What the dashboard, `/settings` and the gate need: per guild, which extensions exist, whether they are switched
 * on, and if not, the sentence a human can act on.
 */
export function extensionStatus(guildId: string): ExtensionStatus[] {
  const disabled = config.features(guildId).extensions.disabled;
  return EXTENSIONS.map(extension => {
    const availability = extension.available?.(guildId) ?? { 'ok': true, 'reason': '' };
    return {
      'id': extension.id,
      'name': extension.name,
      'description': extension.description,
      'enabled': !disabled.includes(extension.id),
      'available': availability.ok,
      'reason': availability.reason,
      'tools': extension.capabilities.length,
    };
  });
}

/** The one gate question: may this tool exist for this guild right now? */
export function capabilityAvailability(guildId: string, name: string): Availability {
  const extension = EXTENSIONS.find(candidate => candidate.id === extensionOf(name));
  if (!extension) return { 'ok': false, 'reason': `unknown tool ${name}` };
  const disabled = config.features(guildId).extensions.disabled;
  if (disabled.includes(extension.id))
    return { 'ok': false, 'reason': `the ${extension.id} extension is switched off here` };
  const whole = extension.available?.(guildId);
  if (whole && !whole.ok) return whole;
  const tool = extension.capabilities.find(capability => capability.name === name);
  const narrow = tool?.available?.(guildId);
  return narrow ?? { 'ok': true, 'reason': '' };
}
