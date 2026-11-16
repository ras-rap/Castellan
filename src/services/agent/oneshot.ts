import { models, type ModelRef, type ModelRole } from './models.ts';

/**
 * One question to one model on the guild's own opencode server, in a throwaway session. Used for the small
 * side-calls the harness makes during a turn (policy review, thinking summaries): create, ask, read, delete.
 *
 * Never throws: a timeout or a dead server is `undefined`, and the caller decides what that means.
 */
export type OneShotServer = {
  opencode: {
    createSession: (title: string) => Promise<string>;
    deleteSession: (sessionID: string) => Promise<void>;
    prompt: (sessionID: string, text: string, model: ModelRef) => Promise<void>;
    lastText: (sessionID: string) => Promise<string>;
    abort: (sessionID: string) => Promise<unknown>;
  };
};

export type OneShotInput = {
  server: OneShotServer;
  guildId: string;
  role: ModelRole;
  prompt: string;
  /** Session title, and the label used in the logs. */
  label: string;
  timeoutMs?: number;
  pollMs?: number;
};

/** Server calls that can hang (abort, session delete) are capped: a side-call must never leak a pending promise. */
const withTimeout = async (work: Promise<unknown>, ms = 2500): Promise<void> => {
  await Promise.race([work.catch(() => undefined), Bun.sleep(ms)]);
};

export async function askOnce(input: OneShotInput): Promise<string | undefined> {
  const timeoutMs = input.timeoutMs ?? 8000;
  const pollMs = input.pollMs ?? 200;
  let session: string | undefined;
  try {
    session = await input.server.opencode.createSession(input.label);
    await input.server.opencode.prompt(session, input.prompt, models[input.role](input.guildId));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const text = await input.server.opencode.lastText(session).catch(() => '');
      if (text.length > 0) return text;
      await Bun.sleep(pollMs);
    }
    await withTimeout(input.server.opencode.abort(session));
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (session !== undefined) await withTimeout(input.server.opencode.deleteSession(session));
  }
}
