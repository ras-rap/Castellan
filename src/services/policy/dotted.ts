import { guildDefaults } from '@services/config.ts';

/**
 * Dotted-path read/write over a guild settings object. Kept separate from the setting *registry* on purpose:
 * extensions write settings too, and the registry imports extensions, so a dependency in the other direction
 * would be a cycle.
 */

const segments = (path: string): string[] => path.split('.').filter(segment => segment.length > 0);

/** Dotted read that never throws: an unset key reads as `undefined`. */
export function readSetting(settings: unknown, path: string): unknown {
  let cursor: unknown = settings;
  for (const segment of segments(path)) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * Immutable dotted write. Values are cloned first so a caller holding the previous settings object never sees
 * a half-applied change.
 */
export function setSetting<T>(settings: T, path: string, value: unknown): T {
  const clone = structuredClone(settings) as Record<string, unknown>;
  const keys = segments(path);
  const containers: Array<Record<string, unknown>> = [clone];
  for (const key of keys.slice(0, -1)) {
    const parent = containers.at(-1) ?? clone;
    const child = parent[key];
    if (typeof child !== 'object' || child === null) parent[key] = {};
    containers.push(parent[key] as Record<string, unknown>);
  }

  const last = keys.at(-1) ?? '';
  const leafParent = containers.at(-1) ?? clone;
  // Resetting to `undefined` means "unset": the key is removed and so is any ancestor that only existed to
  // hold it, so a reset restores the exact shape the schema default has.
  if (value !== undefined) {
    leafParent[last] = value;
    return clone as T;
  }
  delete leafParent[last];
  for (let depth = keys.length - 1; depth >= 1; depth -= 1) {
    // Stop at any container the schema itself defines: `policy.matrix` stays `{}`, `policy.matrix.member`
    // did not exist by default and is pruned.
    if (readSetting(guildDefaults(), keys.slice(0, depth).join('.')) !== undefined) break;
    const parent = containers[depth - 1];
    if (!parent) break;
    const key = keys[depth - 1] ?? '';
    const child = parent[key];
    if (typeof child !== 'object' || child === null || Object.keys(child).length > 0) break;
    delete parent[key];
  }
  return clone as T;
}
