import type { Client, Guild } from 'discord.js';

/**
 * The contract every extension speaks. An extension is one file that exports an {@link Extension}: a list of
 * tools plus when they exist. The registry assembles them, the bridge validates against them, the codegen writes
 * the model's tool list from them and the policy gate classifies them — so adding a tool is one file and one
 * line in the registry, and nothing else in the bot has to know the extension exists.
 */

export type Risk = 'read' | 'reversible' | 'destructive' | 'admin';

export type ParamKind = 'string' | 'number' | 'boolean' | 'string[]';

export type ParamSpec = {
  name: string;
  kind: ParamKind;
  description: string;
  required?: boolean;
  choices?: string[];
};

export type CapabilityContext = {
  client: Client;
  guild: Guild;
  actorId: string;
  channelId?: string;
  /**
   * Run a command inside this guild's shell — docker by default, host only where that guild opted in. Extensions
   * that need to execute anything must go through this instead of spawning processes themselves, so the guild's
   * sandbox decision (and its blast radius) stays the harness's, not the extension's.
   */
  shell: (command: string) => Promise<string>;
};

export type Capability = {
  name: string;
  summary: string;
  description: string;
  risk: Risk;
  params: ParamSpec[];
  run: (ctx: CapabilityContext, args: Record<string, unknown>) => Promise<string>;
};

/** One tool, plus what the extension system needs to know about it. */
export type ExtensionCapability = Capability & {
  /** Extra sets this tool belongs to; the extension id is always one of them. */
  sets?: string[];
  /** Narrows a tool inside an available extension (a panel admin tool needs the admin switch, for example). */
  available?: (guildId: string) => { ok: boolean; reason: string };
};

export type Availability = { ok: boolean; reason: string };

export type Extension = {
  /** Also the tool set name: `features.tools.disabled: ["pterodactyl"]` switches the whole extension off. */
  id: string;
  name: string;
  description: string;
  capabilities: ExtensionCapability[];
  /** Whole-extension availability; absent means "always available". */
  available?: (guildId: string) => Availability;
};

export const str = (args: Record<string, unknown>, key: string): string | undefined => {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

export const num = (args: Record<string, unknown>, key: string): number | undefined => {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

export const strArray = (args: Record<string, unknown>, key: string): string[] => {
  const value = args[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
};

export const requireStr = (args: Record<string, unknown>, key: string): string => {
  const value = str(args, key);
  if (!value) throw new Error(`missing required argument: ${key}`);
  return value;
};

/** Renders one external field: anything that is not a printable scalar is `?` rather than `[object Object]`. */
export const show = (value: unknown, fallback = '?'): string =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : fallback;

/** Nested payloads (`attributes.user`, `attributes.resources`) are objects or nothing. */
export const nested = (record: Record<string, unknown>, key: string): Record<string, unknown> => {
  const value = record[key];
  if (typeof value !== 'object' || value === null) return {};
  return Object.fromEntries(Object.entries(value));
};

export const bytes = (value: unknown): string =>
  typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value / 1_048_576)}MB` : '?';

export const minutes = (value: unknown): string =>
  typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value / 60_000)}m` : '?';

export const pick = <T extends string>(allowed: readonly T[], raw: string, what: string): T => {
  const value = raw.trim().toLowerCase();
  const match = allowed.find(entry => entry === value);
  if (!match) throw new Error(`${what} must be one of ${allowed.join(', ')}`);
  return match;
};
