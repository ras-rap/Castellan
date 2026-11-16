import { sessions } from '@services/database/sqlite.ts';
import { services } from '@services/discord/services.ts';
import { log } from '@utils/logger.ts';
import { z } from 'zod';

const logger = log('web/transcript');

/** One line of a conversation as the dashboard shows it. */
export type TranscriptEntry = {
  role: 'user' | 'assistant' | 'tool';
  /** Text for a message; for a tool call, the name plus a short argument preview. */
  text: string;
  /** Tool calls only: `pending` / `running` / `completed` / `error`. */
  status?: string;
  at?: number;
};

/**
 * The agent server's message shape, as far as the dashboard reads it. It is external input, so it is parsed
 * rather than cast: anything that does not match is skipped instead of reaching the UI as a broken line.
 */
const PartSchema = z.object({
  'type': z.string(),
  'text': z.string().optional(),
  'tool': z.string().optional(),
  'state': z
    .object({
      'status': z.string().optional(),
      'input': z.record(z.string(), z.unknown()).optional(),
      'output': z.string().optional(),
      'time': z.object({ 'start': z.number().optional(), 'end': z.number().optional() }).optional(),
    })
    .optional(),
});

const MessageSchema = z.object({
  'info': z.object({ 'role': z.string().optional() }).optional(),
  'parts': z.array(z.unknown()).optional(),
});

const ARG_PREVIEW = 160;

const toolLine = (part: z.infer<typeof PartSchema>): TranscriptEntry => {
  const state = part.state;
  const args = JSON.stringify(state?.input ?? {});
  const name = part.tool ?? 'tool';
  const failed = state?.status === 'error' && state.output ? ` → ${state.output.slice(0, 200)}` : '';
  const preview = args === '{}' ? '' : ` ${args.slice(0, ARG_PREVIEW)}`;
  return {
    'role': 'tool',
    'text': `${name}${preview}${failed}`,
    ...(state?.status ? { 'status': state.status } : {}),
    ...(typeof state?.time?.end === 'number' ? { 'at': state.time.end } : {}),
  };
};

/**
 * Flattens opencode's message/part stream into readable lines: user and assistant text, plus one line per tool
 * call. Reasoning is deliberately excluded — it is the model's scratch work; the dashboard shows what a turn did.
 */
export function toTranscript(messages: readonly unknown[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const raw of messages) {
    const message = MessageSchema.safeParse(raw);
    if (!message.success) continue;
    const role = message.data.info?.role === 'user' ? 'user' : 'assistant';
    for (const candidate of message.data.parts ?? []) {
      const part = PartSchema.safeParse(candidate);
      if (!part.success) continue;
      if (part.data.type === 'text') {
        const text = (part.data.text ?? '').trim();
        if (text.length > 0) entries.push({ role, text });
        continue;
      }
      if (part.data.type === 'tool') entries.push(toolLine(part.data));
    }
  }
  return entries;
}

export type SessionSummary = {
  sessionId: string;
  channelId: string;
  channelName?: string;
  actorId?: string;
  updatedAt: number;
};

/** The guild's conversations, newest first, with channel names resolved from the live client when it is up. */
export function listSessions(guildId: string): SessionSummary[] {
  let channels: Map<string, string> | undefined;
  try {
    const guild = services.get().client.guilds.cache.get(guildId);
    channels = new Map([...(guild?.channels.cache ?? [])].map(([id, channel]) => [id, channel.name]));
  } catch {
    channels = undefined;
  }
  return sessions.byGuild(guildId).map(row => {
    const name = channels?.get(row.channel_id);
    return {
      'sessionId': row.session_id,
      'channelId': row.channel_id,
      ...(name ? { 'channelName': name } : {}),
      ...(row.actor_id ? { 'actorId': row.actor_id } : {}),
      'updatedAt': row.updated_at,
    };
  });
}

export type Transcript = {
  entries: TranscriptEntry[];
  /** Set when the transcript cannot be read right now, with the sentence a human can act on. */
  unavailable?: string;
};

/**
 * Reads one conversation from the guild's own server. The session row is the authorisation boundary (it must
 * belong to this guild); the messages live in the agent server, which is unloaded while idle — hence the
 * `unavailable` branch rather than an error.
 */
export async function readTranscript(guildId: string, sessionId: string): Promise<Transcript> {
  const row = sessions.byOpenCodeId(sessionId);
  if (!row || row.guild_id !== guildId) return { 'entries': [], 'unavailable': 'that session is not in this server' };

  let server;
  try {
    server = services.get().supervisor.get(guildId);
  } catch {
    server = undefined;
  }
  if (!server)
    return {
      'entries': [],
      'unavailable': "this server's agent is not running right now; it starts again on the next prompt",
    };

  try {
    const response = await server.opencode.client.session.messages({ 'path': { 'id': sessionId } });
    return { 'entries': toTranscript(response.data ?? []) };
  } catch (error) {
    logger.warn('transcript read failed', { guildId, sessionId, 'error': String(error).slice(0, 160) });
    return { 'entries': [], 'unavailable': 'the agent server refused to read that session' };
  }
}
