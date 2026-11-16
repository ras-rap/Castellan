/**
 * The per-account profile vocabulary: the keys `/access`, the dashboard and the agent all write, and where each
 * one lives in the guild document. Deliberately free of imports — extensions declare these as tool choices while
 * the registry is still loading, so anything imported here would come back around as a cycle.
 */
export type ProfileKey = 'rank' | 'risk' | 'tools-allow' | 'tools-deny' | 'commands-allow' | 'commands-deny';

export const PROFILE_KEYS: ProfileKey[] = [
  'rank',
  'risk',
  'tools-allow',
  'tools-deny',
  'commands-allow',
  'commands-deny',
];

/** Where a key lives in the guild document, so `/access set` and `/config` share one shape. */
export const profilePath = (userId: string, key: ProfileKey): string => {
  const base = `access.users.${userId}`;
  switch (key) {
    case 'rank':
      return `${base}.rank`;
    case 'risk':
      return `${base}.risk`;
    case 'tools-allow':
      return `${base}.tools.allow`;
    case 'tools-deny':
      return `${base}.tools.deny`;
    case 'commands-allow':
      return `${base}.commands.allow`;
    case 'commands-deny':
      return `${base}.commands.deny`;
  }
};
