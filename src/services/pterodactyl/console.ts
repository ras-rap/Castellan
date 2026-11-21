import { keyFor, pteroRequest, resolvePtero } from './api.ts';

const CONSOLE_OUTPUT_EVENT = 'console output';
const STATUS_EVENT = 'status';
/** Wings reports an unusable token before anything else works; both are fatal for a tail. */
const FATAL_EVENTS = ['jwt error', 'daemon error'];

/** One Wings frame: `{event, args}`, where a `console output` frame carries what was written to the console. */
export type ConsoleFrame = { event: string; args: string[] };

/** `undefined` for anything that is not a JSON frame, which Wings also sends (raw docker output, keepalives). */
export function parseFrame(raw: unknown): ConsoleFrame | undefined {
  if (typeof raw !== 'string') return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof payload !== 'object' || payload === null) return undefined;
  if (!('event' in payload) || typeof payload.event !== 'string' || payload.event.length === 0) return undefined;
  const args =
    'args' in payload && Array.isArray(payload.args)
      ? payload.args.filter((arg): arg is string => typeof arg === 'string')
      : [];
  return { 'event': payload.event, 'args': args };
}

/** Wings sends whole log lines, sometimes already newline-terminated; blank ones are the padding between them. */
export const consoleLines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map(line => line.replace(/\s+$/, ''))
    .filter(line => line.length > 0);

export type ConsoleTail = { lines: string[]; state: string };

/**
 * Bun's client takes connection headers; the DOM typing of `WebSocket` has no such overload, so the constructor is
 * cast once here. It matters: Wings refuses any socket whose `Origin` is not the panel's own URL.
 */
type SocketConstructor = new (url: string, options: Bun.WebSocketOptions) => WebSocket;

const openSocket = (url: string, headers: Record<string, string>): WebSocket =>
  new (WebSocket as unknown as SocketConstructor)(url, { headers });

/**
 * Read a server's console as it happens. The panel API has no history for it — console output only exists on the
 * node's socket — so this authenticates, listens for a window, and reports what was written in it.
 */
export async function readConsole(
  guildId: string,
  server: string,
  options: { seconds: number; lines: number },
): Promise<ConsoleTail> {
  const target = resolvePtero(guildId);
  if (!target) throw new Error('no pterodactyl panel configured here (pterodactyl.enabled + a key in .env)');
  const payload = await pteroRequest<{ data?: { token?: unknown; socket?: unknown } }>(
    guildId,
    'client',
    keyFor(target, 'client'),
    `/servers/${server}/websocket`,
  );
  const token = payload?.data?.token;
  const socket = payload?.data?.socket;
  if (typeof token !== 'string' || typeof socket !== 'string')
    throw new Error('the panel did not return a console socket for this server');

  const chunks: string[] = [];
  let state = 'unknown';

  await new Promise<void>((resolve, reject) => {
    const connection = openSocket(socket, { 'origin': target.baseUrl });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        connection.close();
      } catch {
        // already closed by the node, which is the normal end of a tail
      }
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(finish, Math.max(1, options.seconds) * 1000);

    connection.onopen = () => connection.send(JSON.stringify({ 'event': 'auth', 'args': [token] }));
    connection.onerror = () =>
      finish(new Error('the node refused the console socket (is Wings reachable, and websocket.connect granted?)'));
    connection.onclose = () => finish();
    connection.onmessage = message => {
      const frame = parseFrame(message.data);
      if (!frame) return;
      if (frame.event === CONSOLE_OUTPUT_EVENT) {
        chunks.push(...frame.args);
        if (consoleLines(chunks.join('')).length >= options.lines) finish();
        return;
      }
      if (frame.event === STATUS_EVENT) {
        state = frame.args[0] ?? state;
        return;
      }
      if (FATAL_EVENTS.includes(frame.event))
        finish(new Error(`${frame.event}: ${frame.args.join(' ') || 'the node gave no detail'}`));
    };
  });

  return { 'lines': consoleLines(chunks.join('')).slice(-options.lines), 'state': state };
}
