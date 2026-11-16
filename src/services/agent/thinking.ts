import { log } from '@utils/logger.ts';

import { askOnce, type OneShotServer } from './oneshot.ts';

const logger = log('thinking');

/** One line, not a paragraph: this replaces a 700-character tail in a Discord message. */
const MAX_SUMMARY = 180;

/**
 * The prompt for the cheap model. It sees only the reasoning text, and is told to describe what the agent is
 * doing — present tense, one line — because the summary is progress feedback, not a transcript.
 */
export const thinkingPrompt = (text: string): string =>
  [
    'Summarise the reasoning below in ONE short line (max 140 characters), present tense, for a live progress log.',
    'Say what is being worked out or attempted, not how. No preamble, no quotes, no trailing punctuation.',
    'Reply with the line only.',
    '',
    'Reasoning:',
    text.slice(-4000),
  ].join('\n');

/** Model replies arrive chatty; keep the useful part: one line, no wrappers, capped. */
export function parseSummary(text: string): string | undefined {
  const cleaned = text
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/```$/, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    // a model that ignores "no preamble" often opens with a label
    .map(line => line.replace(/^(summary|thinking|line)\s*[:\-—]\s*/i, ''))
    .map(line => line.replace(/^["'“”](.*)["'“”]$/, '$1').trim())
    .filter(line => line.length > 0);
  const first = cleaned[0];
  if (!first) return undefined;
  return first.length > MAX_SUMMARY ? `${first.slice(0, MAX_SUMMARY - 1)}…` : first;
}

export type ThinkingInput = {
  server: OneShotServer;
  guildId: string;
  text: string;
  /** `fast` by default: the summary is cheap progress feedback, not a second opinion. */
  role?: 'fast' | 'primary';
  timeoutMs?: number;
};

/**
 * Summarise a chain of thought with the guild's **fast** model. The live Discord message shows this instead of
 * the raw reasoning, which is what kept re-editing the message on every streaming part.
 */
export async function summariseThinking(input: ThinkingInput): Promise<string | undefined> {
  const text = input.text.trim();
  if (text.length === 0) return undefined;
  const reply = await askOnce({
    'server': input.server,
    'guildId': input.guildId,
    'role': input.role ?? 'fast',
    'label': 'thinking summary',
    'prompt': thinkingPrompt(text),
    'timeoutMs': input.timeoutMs ?? 8000,
  });
  const summary = reply === undefined ? undefined : parseSummary(reply);
  if (!summary) logger.debug('thinking summary unavailable', { 'guildId': input.guildId });
  return summary;
}
