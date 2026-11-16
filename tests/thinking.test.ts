import { parseSummary, thinkingPrompt } from '@services/agent/thinking.ts';
import { StreamRenderer } from '@services/discord/render.ts';
import { jest, afterEach, describe, expect, test } from 'bun:test';

import type { Message, TextChannel } from 'discord.js';

/** Enough of a channel to drive the renderer: it sends one preview and edits it in place. */
const fakeChannel = () => {
  const edits: string[] = [];
  const message = {
    'content': '',
    'edit': async (payload: { content: string }) => {
      edits.push(payload.content);
      message.content = payload.content;
      return message as unknown as Message;
    },
    'delete': async () => undefined,
  };
  const sent: string[] = [];
  const channel = {
    'send': async (payload: { content: string }) => {
      sent.push(payload.content);
      message.content = payload.content;
      return message as unknown as Message;
    },
  } as unknown as TextChannel;
  return { channel, edits, sent };
};

/** The renderer edits on a timer and applies summaries through promise chains; drain both deterministically. */
const drain = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

afterEach(() => {
  jest.useRealTimers();
});

describe('the thinking line', () => {
  test('the prompt asks for one line and carries only the tail of the reasoning', () => {
    const prompt = thinkingPrompt(`HEAD-MARKER${'x'.repeat(5000)}WORKING-ON-AUTH`);
    expect(prompt).toContain('one short phrase');
    expect(prompt).toContain('thinking about how to');
    expect(prompt).toContain('WORKING-ON-AUTH');
    // the context stays honest: the tail is sent, the beginning of a long pass is not
    expect(prompt).not.toContain('HEAD-MARKER');
    expect(prompt.length).toBeLessThan(4400);
  });

  test('a chatty reply is reduced to one clean line', () => {
    expect(parseSummary('Summary: thinking about the missing channel')).toBe('thinking about the missing channel');
    // a trailing period is not part of the phrase
    expect(parseSummary('checking role permissions.')).toBe('checking role permissions');
    expect(parseSummary('```\nchecking role permissions\n```')).toBe('checking role permissions');
    expect(parseSummary('"reading the config"')).toBe('reading the config');
    expect(parseSummary('\n\n  comparing two candidates  \nsecond line')).toBe('comparing two candidates');
    expect(parseSummary('   ')).toBeUndefined();
    expect(parseSummary('x'.repeat(400))?.length).toBeLessThanOrEqual(110);
  });

  test('raw reasoning never reaches the live message', async () => {
    jest.useFakeTimers();
    const { channel, edits, sent } = fakeChannel();
    let calls = 0;
    const renderer = new StreamRenderer(channel, '🧠 thinking…', async () => {
      calls += 1;
      return `line ${calls}`;
    });
    await renderer.start();
    expect(sent).toEqual(['🧠 thinking…']);

    renderer.setReasoning('p1', 'SECRET-RAW-REASONING'.repeat(40));
    await drain();
    jest.advanceTimersByTime(1300);
    await drain();

    expect(edits.length).toBeGreaterThan(0);
    expect(edits.every(edit => !edit.includes('SECRET-RAW-REASONING'))).toBe(true);
    expect(edits.at(-1)).toContain('🧠 line 1');

    // a barely-grown part buys no second model call: the window and the growth floor both hold
    const before = calls;
    renderer.setReasoning('p1', `${'SECRET-RAW-REASONING'.repeat(40)}and a bit more`);
    await drain();
    jest.advanceTimersByTime(1300);
    await drain();
    expect(calls).toBe(before);
  });

  test('without a summariser the line shows one deterministic phrase, never the reasoning', async () => {
    jest.useFakeTimers();
    const { channel, edits } = fakeChannel();
    const renderer = new StreamRenderer(channel, '🧠 thinking…');
    await renderer.start();
    renderer.setReasoning('p1', 'checking the deploy script before touching anything.\nmore raw thinking');
    await drain();
    jest.advanceTimersByTime(1300);
    await drain();
    expect(edits.at(-1) ?? '').toBe('🧠 checking the deploy script before touching anything.');
    // and it is one edit, not a re-edit per reasoning part
    const calls = edits.length;
    renderer.setReasoning('p1', 'checking the deploy script before touching anything.\nmore raw thinking\nand more');
    jest.advanceTimersByTime(1300);
    await drain();
    expect(edits.length).toBeLessThanOrEqual(calls + 1);
    expect(edits.at(-1) ?? '').toBe('🧠 checking the deploy script before touching anything.');
  });

  test('the finished log quotes the summary, not the chain of thought', async () => {
    const { channel, edits, sent } = fakeChannel();
    const renderer = new StreamRenderer(channel, '🧠 thinking…', async () => 'thinking about the deploy script');
    await renderer.start();
    renderer.setReasoning('p1', 'RAW-THOUGHT-ONE '.repeat(30));
    await drain();
    await renderer.finish('the answer', { 'reasoning': 'RAW-THOUGHT-FINAL '.repeat(30) });
    const log = edits.at(-1) ?? '';
    // the answer is its own message; the log is the progress message, and it quotes the summary
    expect(sent.join('\n')).toContain('the answer');
    expect(log).toContain('> 🧠 thinking about the deploy script');
    // the wall of thinking is not in Discord at all
    expect(log).not.toContain('RAW-THOUGHT');
  });

  test('answer text still streams; only the thinking is summarised', async () => {
    jest.useFakeTimers();
    const { channel, edits } = fakeChannel();
    const renderer = new StreamRenderer(channel, '🧠 thinking…', async () => 'reading config');
    await renderer.start();
    renderer.push('here is the answer');
    await drain();
    jest.advanceTimersByTime(1300);
    await drain();
    expect(edits.at(-1)).toContain('here is the answer');
  });

  test('the local phrase is deterministic and bounded, so no model is needed to stay short', async () => {
    const { localSummary } = await import('@services/agent/thinking.ts');
    expect(localSummary('## Plan\n1. read the file\n2. change it')).toBe('Plan');
    expect(localSummary('checking the deploy script. then the env file')).toBe('checking the deploy script.');
    expect(localSummary('   ')).toBe('');
    const long = localSummary('word '.repeat(200));
    expect(long.length).toBeLessThanOrEqual(70);
    expect(long.endsWith('…')).toBe(true);
  });
});
