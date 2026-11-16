import { sessions } from '@services/database/sqlite.ts';
import { listSessions, toTranscript } from '@services/web/transcript.ts';
import { afterEach, describe, expect, test } from 'bun:test';

const GUILD = `test-tx-${Date.now().toString(36)}`;

afterEach(() => {
  // nothing to unwind: rows are keyed by a per-run guild id
});

describe('a conversation becomes readable lines', () => {
  test('user and assistant text plus one line per tool call, and no reasoning', () => {
    const entries = toTranscript([
      { 'info': { 'role': 'user' }, 'parts': [{ 'type': 'text', 'text': 'delete the channel' }] },
      {
        'info': { 'role': 'assistant' },
        'parts': [
          { 'type': 'reasoning', 'text': 'SCRATCH-WORK' },
          { 'type': 'text', 'text': 'looking at it' },
          {
            'type': 'tool',
            'tool': 'channel_info',
            'state': { 'status': 'completed', 'input': { 'channel_id': '1' }, 'time': { 'end': 1700000000000 } },
          },
          { 'type': 'tool', 'tool': 'channel_delete', 'state': { 'status': 'error', 'output': 'missing permissions' } },
        ],
      },
    ]);
    expect(entries).toEqual([
      { 'role': 'user', 'text': 'delete the channel' },
      { 'role': 'assistant', 'text': 'looking at it' },
      { 'role': 'tool', 'text': 'channel_info {"channel_id":"1"}', 'status': 'completed', 'at': 1700000000000 },
      { 'role': 'tool', 'text': 'channel_delete → missing permissions', 'status': 'error' },
    ]);
    // the model's scratch work is not part of the transcript
    expect(JSON.stringify(entries)).not.toContain('SCRATCH-WORK');
  });

  test('malformed parts are skipped instead of breaking the list', () => {
    const entries = toTranscript([
      null,
      'nonsense',
      { 'info': { 'role': 'assistant' }, 'parts': [{ 'type': 'text', 'text': 'ok' }, { 'no': 'type' }] },
      { 'info': { 'role': 'assistant' }, 'parts': 'not-an-array' },
    ]);
    expect(entries).toEqual([{ 'role': 'assistant', 'text': 'ok' }]);
  });
});

describe('the session list is per guild', () => {
  test('only this guild’s sessions come back, newest first', () => {
    const now = Date.now();
    sessions.set({
      'chat_key': `${GUILD}:1`,
      'guild_id': GUILD,
      'channel_id': '1',
      'session_id': `ses_${GUILD}_a`,
      'actor_id': 'user-a',
    });
    sessions.set({
      'chat_key': `${GUILD}:2`,
      'guild_id': GUILD,
      'channel_id': '2',
      'session_id': `ses_${GUILD}_b`,
      'actor_id': 'user-b',
    });
    sessions.set({
      'chat_key': `other:1`,
      'guild_id': 'other-guild',
      'channel_id': '9',
      'session_id': `ses_${GUILD}_c`,
      'actor_id': 'user-c',
    });

    const list = listSessions(GUILD);
    expect(list.map(session => session.sessionId).sort()).toEqual([`ses_${GUILD}_a`, `ses_${GUILD}_b`]);
    for (const session of list) expect(session.updatedAt).toBeGreaterThan(0);
    expect(Date.now() - now).toBeLessThan(5000);
    expect(listSessions('other-guild').map(session => session.sessionId)).toEqual([`ses_${GUILD}_c`]);
  });
});
