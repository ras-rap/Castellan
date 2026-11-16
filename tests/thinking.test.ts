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
    expect(prompt).toContain('ONE short line');
    expect(prompt).toContain('WORKING-ON-AUTH');
    // the context stays honest: the tail is sent, the beginning of a long pass is not
    expect(prompt).not.toContain('HEAD-MARKER');
    expect(prompt.length).toBeLessThan(4300);
  });

  test('a chatty reply is reduced to one clean line', () => {
    expect(parseSummary('Summary: tracing the missing channel id')).toBe('tracing the missing channel id');
    expect(parseSummary('```\nchecking role permissions\n```')).toBe('checking role permissions');
    expect(parseSummary('"reading the config"')).toBe('reading the config');
    expect(parseSummary('\n\n  comparing two candidates  \nsecond line')).toBe('comparing two candidates');
    expect(parseSummary('   ')).toBeUndefined();
    expect(parseSummary('x'.repeat(400))?.length).toBeLessThanOrEqual(180);
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

  test('without a summariser the preview stays put instead of streaming reasoning', async () => {
    jest.useFakeTimers();
    const { channel, edits } = fakeChannel();
    const renderer = new StreamRenderer(channel, '🧠 thinking…');
    await renderer.start();
    renderer.setReasoning('p1', 'raw thinking that must not be shown');
    await drain();
    jest.advanceTimersByTime(1300);
    await drain();
    expect(edits).toHaveLength(0);
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
});
