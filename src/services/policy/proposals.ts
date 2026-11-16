import { config, type UserAccess } from '@services/config.ts';

/**
 * A permission change the agent has worked out but not applied. Kept in memory rather than on disk: a proposal
 * is a conversation step ("here is what I am about to do — yes?") and is worthless after the turn it was made in.
 *
 * The point of the store is that `access_apply` can only write something the agent already *showed*: the model
 * has to call the planner, put the diff in front of the person, and then apply that exact plan.
 */
export type AccessProposal = {
  guildId: string;
  userId: string;
  /** The profile as it will be written. */
  profile: UserAccess;
  /** Human-readable diff lines, in the order they are shown. */
  lines: string[];
  at: number;
};

const TTL_MS = 10 * 60_000;
const proposals = new Map<string, AccessProposal>();

const keyFor = (guildId: string, userId: string): string => `${guildId}:${userId}`;

export function rememberProposal(proposal: AccessProposal): void {
  const now = Date.now();
  for (const [key, entry] of proposals) if (now - entry.at > TTL_MS) proposals.delete(key);
  proposals.set(keyFor(proposal.guildId, proposal.userId), proposal);
}

/** Takes the plan (a plan applies once). `undefined` means "nothing was proposed, or it expired". */
export function takeProposal(guildId: string, userId: string): AccessProposal | undefined {
  const key = keyFor(guildId, userId);
  const proposal = proposals.get(key);
  proposals.delete(key);
  if (!proposal || Date.now() - proposal.at > TTL_MS) return undefined;
  return proposal;
}

export const clearProposals = (): void => proposals.clear();

const show = (profile: UserAccess | undefined): string => {
  if (!profile) return 'nothing (guild defaults)';
  const parts: string[] = [];
  if (profile.rank) parts.push(`rank ${profile.rank}`);
  if (profile.risk) parts.push(`max risk ${profile.risk}`);
  if (profile.tools.allow.length > 0) parts.push(`tools only ${profile.tools.allow.join(', ')}`);
  if (profile.tools.deny.length > 0) parts.push(`tools denied ${profile.tools.deny.join(', ')}`);
  if (profile.commands.allow.length > 0) parts.push(`commands only ${profile.commands.allow.join(', ')}`);
  if (profile.commands.deny.length > 0) parts.push(`commands denied ${profile.commands.deny.join(', ')}`);
  return parts.length === 0 ? 'nothing (guild defaults)' : parts.join(' · ');
};

/**
 * The diff a person actually needs to read: what they have now, what they will have, and what changed. Kept to
 * three lines so it fits a Discord message next to the yes/no question.
 */
export function describeProposal(guildId: string, userId: string, proposed: UserAccess): string[] {
  const current = config.access(guildId).users[userId];
  const before = show(current);
  const after = show(proposed);
  const lines = [`now: ${before}`, `proposed: ${after}`];

  const changed: string[] = [];
  if ((current?.rank ?? '') !== (proposed.rank ?? ''))
    changed.push(`rank ${current?.rank ?? '-'} → ${proposed.rank ?? '-'}`);
  if ((current?.risk ?? '') !== (proposed.risk ?? ''))
    changed.push(`risk ${current?.risk ?? '-'} → ${proposed.risk ?? '-'}`);
  for (const field of ['allow', 'deny'] as const) {
    const beforeList = current?.tools[field] ?? [];
    const afterList = proposed.tools[field];
    const added = afterList.filter(entry => !beforeList.includes(entry));
    const removed = beforeList.filter(entry => !afterList.includes(entry));
    if (added.length > 0) changed.push(`tools.${field} +${added.join(', ')}`);
    if (removed.length > 0) changed.push(`tools.${field} -${removed.join(', ')}`);
  }
  for (const field of ['allow', 'deny'] as const) {
    const beforeList = current?.commands[field] ?? [];
    const afterList = proposed.commands[field];
    const added = afterList.filter(entry => !beforeList.includes(entry));
    const removed = beforeList.filter(entry => !afterList.includes(entry));
    if (added.length > 0) changed.push(`commands.${field} +${added.join(', ')}`);
    if (removed.length > 0) changed.push(`commands.${field} -${removed.join(', ')}`);
  }

  lines.push(
    changed.length === 0 ? 'no change: that is already what this account may do' : `changes: ${changed.join('; ')}`,
  );
  return lines;
}
