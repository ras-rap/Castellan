import { models, type ModelRef } from '@services/agent/models.ts';
import { services } from '@services/discord/services.ts';
import { log } from '@utils/logger.ts';

import type { Verdict } from './hard.ts';

const logger = log('review');

// Measured on the default free-tier model: ~22 s for one JSON answer, so anything under 30 s would always time
// out and turn every unattended call into a card. A timeout is still fail-closed: the call is asked, not run.
const TIMEOUT_MS = 45_000;
const POLL_MS = 200;
const CACHE_TTL_MS = 30_000;
const CACHE_LIMIT = 128;

export type ReviewRole = 'primary' | 'fast';

export type Review = { verdict: Verdict; confidence: number; reason: string };

export type ReviewInput = {
  guildId: string;
  /** Rank name of whoever asked, so the reviewer sees the same context the hard layer did. */
  rank: string;
  tool: string;
  risk: string;
  args: Record<string, unknown>;
  /** One line about where a shell call would run; the same `rm` is not equally bad in a container. */
  sandbox: string;
  /** Which role answers: the main agent itself (`primary`) or the cheap one (`fast`). */
  model: ReviewRole;
};

export type ReviewFn = (input: ReviewInput) => Promise<Review | undefined>;

/**
 * Parses the reviewer's answer. Anything that is not a well-formed verdict is `undefined` — the caller treats
 * that as "the reviewer had no opinion it can defend", which under `enforce` becomes a human card.
 */
export function parseReview(text: string): Review | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const verdict = record.verdict;
  if (verdict !== 'allow' && verdict !== 'ask' && verdict !== 'deny') return undefined;
  const confidence =
    typeof record.confidence === 'number' && Number.isFinite(record.confidence) ? record.confidence : 0.5;
  const reason = typeof record.reason === 'string' ? record.reason.trim().slice(0, 200) : '';
  return { verdict, 'confidence': Math.min(Math.max(confidence, 0), 1), 'reason': reason || 'no reason given' };
}

/** The reviewer is asked for one JSON object and nothing else: prose here would be unparseable. */
export const reviewPrompt = (input: ReviewInput): string =>
  [
    'You are the safety reviewer for a Discord operations agent. You do not perform the action; you judge one',
    'proposed tool call before it runs. Be concrete and unimpressed by confident wording.',
    '',
    `Requester rank: ${input.rank}`,
    `Tool: ${input.tool} (risk class: ${input.risk})`,
    `Sandbox: ${input.sandbox}`,
    `Arguments: ${JSON.stringify(input.args).slice(0, 1500)}`,
    '',
    'deny — irreversible damage, a broad or ambiguous target, moderation of the server owner or the bot itself,',
    '       a permission grant of Administrator, or an action that a careful admin would refuse.',
    'ask  — defensible but consequential: a human should see the exact target before it runs.',
    'allow — routine for this tool, specific target, nothing that cannot be undone in one step.',
    '',
    'Reply with one JSON object and nothing else:',
    '{"verdict":"allow|ask|deny","confidence":0.0-1.0,"reason":"one sentence"}',
  ].join('\n');

type ReviewServer = {
  opencode: {
    createSession: (title: string) => Promise<string>;
    deleteSession: (sessionID: string) => Promise<void>;
    prompt: (sessionID: string, text: string, model: ModelRef) => Promise<void>;
    lastText: (sessionID: string) => Promise<string>;
    abort: (sessionID: string) => Promise<unknown>;
  };
};

export type ReviewDeps = {
  /** Where the guild's own agent lives; defaults to the running supervisor. */
  server?: (guildId: string) => ReviewServer | undefined;
};

const supervisorServer = (guildId: string): ReviewServer | undefined => {
  try {
    return services.get().supervisor.get(guildId) as unknown as ReviewServer | undefined;
  } catch {
    // No wiring (unit tests, CLI): the layer is simply absent rather than failing every call.
    return undefined;
  }
};

const cache = new Map<string, { review: Review; at: number }>();

const cached = (key: string): Review | undefined => {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.review;
};

const remember = (key: string, review: Review): void => {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(key, { review, 'at': Date.now() });
};

/**
 * One question, one throwaway session. Reusing a session would carry every earlier verdict as context: the
 * reviewer would slowly drift towards its own past answers and each review would get slower.
 */
const ask = async (server: ReviewServer, input: ReviewInput, prompt: string): Promise<string | undefined> => {
  const session = await server.opencode.createSession('policy review');
  try {
    await server.opencode.prompt(session, prompt, models[input.model](input.guildId));
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      const text = await server.opencode.lastText(session).catch(() => '');
      if (text.length > 0) return text;
      await Bun.sleep(POLL_MS);
    }
    // Timed out: stop the turn so it cannot keep burning tokens after the decision was already made.
    await server.opencode.abort(session).catch(() => undefined);
    logger.warn('agent review timed out', { 'guildId': input.guildId, 'tool': input.tool });
    return undefined;
  } catch (error) {
    logger.warn('agent review failed', { 'guildId': input.guildId, 'error': String(error).slice(0, 160) });
    return undefined;
  } finally {
    await server.opencode.deleteSession(session);
  }
};

/**
 * Layer 3: the guild's own agent reviews the call it is about to make. It is a self-check, not an independent
 * one — the same model family proposed the call, so it catches slip-ups (wrong target, action the asker never
 * asked for) and not adversarial reasoning; Jev is the independent layer. `undefined` means the reviewer
 * failed, and callers must treat that as fail-closed.
 */
export async function reviewWithAgent(input: ReviewInput, deps: ReviewDeps = {}): Promise<Review | undefined> {
  const key = `${input.guildId}|${input.tool}|${JSON.stringify(input.args)}`;
  const hit = cached(key);
  if (hit) return hit;

  const server = (deps.server ?? supervisorServer)(input.guildId);
  if (!server) {
    logger.debug('no server for agent review', { 'guildId': input.guildId });
    return undefined;
  }

  const text = await ask(server, input, reviewPrompt(input));
  if (!text) return undefined;
  const review = parseReview(text);
  if (!review) {
    logger.warn('agent review unparseable', { 'guildId': input.guildId, 'text': text.slice(0, 160) });
    return undefined;
  }
  logger.info('agent review', {
    'guildId': input.guildId,
    'tool': input.tool,
    'verdict': review.verdict,
    'confidence': review.confidence,
    'reason': review.reason.slice(0, 120),
  });
  remember(key, review);
  return review;
}
