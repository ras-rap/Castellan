import { log } from '@utils/logger.ts';

import { askOnce, type OneShotServer } from './oneshot.ts';

const logger = log('thinking');

/** One short phrase, not a sentence: it sits on the progress line and in the finished log. */
const MAX_SUMMARY = 110;

/**
 * The prompt for the cheap model. It sees only the reasoning text, and is told to describe what the agent is
 * doing — present tense, one line — because the summary is progress feedback, not a transcript.
 */
export const thinkingPrompt = (text: string): string =>
  [
    'Describe what the assistant is doing as one short phrase, the way a status line reads.',
    'Shape: "thinking about how to <goal>", "checking <what>", "working out <what>" — max 60 characters.',
    'A gerund phrase, lowercase after the first word, no quotes, no trailing period, no preamble.',
    'Reply with the phrase only.',
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
  const first = cleaned[0]?.replace(/[.。]+$/, '');
  if (!first) return undefined;
  return first.length > MAX_SUMMARY ? `${first.slice(0, MAX_SUMMARY - 1)}…` : first;
}

/**
 * No model answered (or none is configured): still produce a single short phrase from the reasoning, so the
 * message reads like a status line instead of a wall. Deterministic on purpose — this path must never depend on
 * a provider being reachable.
 */
export function localSummary(reasoning: string): string {
  const line =
    reasoning
      .split('\n')
      .map(candidate => candidate.trim())
      .find(candidate => candidate.length > 0) ?? '';
  const cleaned = line
    .replace(/^[#>*\-\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const sentence = cleaned.split(/(?<=[.!?])\s/)[0] ?? cleaned;
  return sentence.length > 70 ? `${sentence.slice(0, 69)}…` : sentence;
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
