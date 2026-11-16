import { writeDigest } from '@services/memory/inject.ts';
import { memory } from '@services/memory/store.ts';
import { log } from '@utils/logger.ts';

import { num, requireStr, show, str, type Extension, type ExtensionCapability } from './protocol.ts';

const logger = log('extensions/memory');

const KINDS = ['fact', 'preference', 'lesson', 'pointer'] as const;

const line = (hit: { id: number; kind: string; key: string; text: string; importance: number }): string =>
  `#${hit.id} ${hit.kind} · ${hit.key} (importance ${hit.importance.toFixed(2)})\n  ${hit.text}`;

/**
 * The bot's own memory, as tools. Until now the store was written by reflection and `/remember` and read by
 * injection — the agent could only see the flattened `MEMORY.md` digest and could not deliberately store or ask
 * for anything. These four tools make it a first-class thing it owns: save a durable fact, search it, look at
 * what is there, forget a wrong one.
 */
const tools: ExtensionCapability[] = [
  {
    'name': 'memory_search',
    'summary': 'Search this server’s memory',
    'description':
      'Full-text search over what this bot remembers about this server and its people (facts, preferences, lessons, pointers). Use it before answering anything that sounds like a standing preference or a past decision.',
    'risk': 'read',
    'params': [
      { 'name': 'query', 'kind': 'string', 'description': 'words to look for; empty lists the most important' },
      { 'name': 'limit', 'kind': 'number', 'description': '1-25, default 8' },
    ],
    'run': async (ctx, args) => {
      const query = str(args, 'query') ?? '';
      const limit = Math.min(Math.max(num(args, 'limit') ?? 8, 1), 25);
      const hits = memory.search(ctx.guild.id, query, limit);
      if (hits.length === 0) return `nothing in memory matches "${query}"`;
      return hits.map(line).join('\n\n');
    },
  },
  {
    'name': 'memory_save',
    'summary': 'Remember something durable',
    'description':
      'Store one durable fact about this server, a person, or how work is done here. Same key replaces the old text. Do not store secrets, credentials or anything that changes next week.',
    'risk': 'reversible',
    'params': [
      { 'name': 'text', 'kind': 'string', 'description': 'the fact, one sentence', 'required': true },
      {
        'name': 'kind',
        'kind': 'string',
        'description': 'fact | preference | lesson | pointer (default fact)',
        'choices': [...KINDS],
      },
      { 'name': 'key', 'kind': 'string', 'description': 'stable key such as "deploy target"; defaults to the text' },
      { 'name': 'importance', 'kind': 'number', 'description': '0-1, default 0.5' },
    ],
    'run': async (ctx, args) => {
      const kind = KINDS.find(candidate => candidate === str(args, 'kind')) ?? 'fact';
      const text = requireStr(args, 'text');
      const importance = Math.min(Math.max(num(args, 'importance') ?? 0.5, 0), 1);
      const createdAt = Date.now();
      const id = memory.add({
        'guildId': ctx.guild.id,
        kind,
        'key': str(args, 'key') ?? text,
        text,
        importance,
        'source': `agent:${ctx.actorId}`,
      });
      // MEMORY.md is the digest the agent reads as project instructions: keep it in step with the store.
      writeDigest(ctx.guild.id);
      const shown = memory.search(ctx.guild.id, text, 1)[0];
      logger.info('memory saved by the agent', { 'guildId': ctx.guild.id, id, kind, createdAt });
      return `remembered #${id} (${kind}): ${show(shown?.text ?? text)}`;
    },
  },
  {
    'name': 'memory_forget',
    'summary': 'Forget one stored memory',
    'description':
      'Delete one memory by its id (from memory_search). Deletion is permanent — use it for facts that are wrong or stale, not for ones you merely disagree with.',
    'risk': 'destructive',
    'params': [{ 'name': 'id', 'kind': 'number', 'description': 'memory id from memory_search', 'required': true }],
    'run': async (ctx, args) => {
      const id = num(args, 'id');
      if (id === undefined) throw new Error('id is required (memory_search prints them as #id)');
      const gone = memory.forget(ctx.guild.id, id);
      if (!gone) throw new Error(`no memory #${id} in this server`);
      writeDigest(ctx.guild.id);
      return `forgot #${id}`;
    },
  },
  {
    'name': 'memory_stats',
    'summary': 'How much this bot remembers here',
    'description': 'Counts per kind, plus how many entries were superseded by a newer version.',
    'risk': 'read',
    'params': [],
    'run': async ctx => {
      const stats = memory.stats(ctx.guild.id);
      const kinds = Object.entries(stats.byKind)
        .map(([kind, count]) => `${kind} ${count}`)
        .join(', ');
      return `${stats.total} memories${kinds ? ` (${kinds})` : ''}; ${stats.superseded} superseded`;
    },
  },
];

export const memoryExtension: Extension = {
  'id': 'memory',
  'name': 'Memory',
  'description':
    'Search, store and forget durable facts about this server — backed by the same store reflection writes.',
  'capabilities': tools,
};
