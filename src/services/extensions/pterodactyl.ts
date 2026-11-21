import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';

import { config, paths } from '@services/config.ts';
import {
  POWER_SIGNALS,
  attributesOf,
  chmodMode,
  commandRequest,
  describeServerLine,
  jsonRequest,
  keyFor,
  listAttributes,
  powerRequest,
  pteroRequest,
  pteroUpload,
  remoteUrl,
  resolvePtero,
  safePath,
  safeRelative,
  serverAllowed,
  signedUrl,
  writeRequest,
  type PteroTarget,
} from '@services/pterodactyl/api.ts';
import { readConsole } from '@services/pterodactyl/console.ts';

import {
  bytes,
  minutes,
  nested,
  num,
  pick,
  requireStr,
  show,
  str,
  strArray,
  type Availability,
  type Extension,
  type ExtensionCapability,
} from './protocol.ts';

const requirePtero = (guildId: string): PteroTarget => {
  const target = resolvePtero(guildId);
  if (!target?.clientKey)
    throw new Error('no pterodactyl panel here (pterodactyl.enabled + PTERO_CLIENT_KEY + PTERO_BASE_URL)');
  return target;
};

const requirePteroFiles = (guildId: string): PteroTarget => {
  const target = requirePtero(guildId);
  if (!target.files) throw new Error('the panel file tools are switched off here (pterodactyl.files)');
  return target;
};

const requirePteroAdmin = (guildId: string): PteroTarget => {
  const target = resolvePtero(guildId);
  if (!target?.admin || !target.adminKey)
    throw new Error('the panel admin tools are not enabled here (pterodactyl.admin + PTERO_ADMIN_KEY)');
  return target;
};

/** The guild's `pterodactyl.servers` allow-list, enforced before any request leaves the bot. */
const requirePteroServer = (target: PteroTarget, server: string): string => {
  if (!serverAllowed(target, server)) throw new Error(`${server} is not in this server's pterodactyl allow-list`);
  return server;
};

/** The application-API half and the file trio are switched per guild, not per deployment. */
const adminTools = (guildId: string): Availability =>
  config.pterodactyl(guildId).admin
    ? { 'ok': true, 'reason': '' }
    : { 'ok': false, 'reason': 'the panel admin tools are switched off here (pterodactyl.admin)' };

const fileTools = (guildId: string): Availability =>
  config.pterodactyl(guildId).files
    ? { 'ok': true, 'reason': '' }
    : { 'ok': false, 'reason': 'the panel file tools are switched off here (pterodactyl.files)' };

const FILE_TOOLS = [
  'ptero_files',
  'ptero_file_read',
  'ptero_file_write',
  'ptero_file_upload',
  'ptero_file_download',
  'ptero_file_pull',
  'ptero_file_delete',
  'ptero_file_rename',
  'ptero_file_mkdir',
  'ptero_file_compress',
  'ptero_file_decompress',
  'ptero_file_chmod',
  'ptero_file_copy',
];

/** The directory a panel file route works inside; the panel resolves every name against it. */
const directoryOf = (args: Record<string, unknown>): string => safePath(str(args, 'directory') ?? '/', 'directory');

/** One or more names inside that directory, which is the shape delete, compress and chmod take. */
const namesOf = (args: Record<string, unknown>): string[] => {
  const names = strArray(args, 'files').map(name => safeRelative(name, 'file'));
  if (names.length === 0) throw new Error('files must name at least one entry in the directory');
  return names;
};

/**
 * A file the agent already has, and only inside this guild's workspace: an upload must not be a way to ship the
 * deployment's `.env` or its database out of the bot.
 */
const workspaceFile = (guildId: string, source: string): string => {
  const root = resolve(paths.workspaces, guildId);
  const path = resolve(root, source.replace(/^\/+/, ''));
  if (!path.startsWith(`${root}${sep}`)) throw new Error(`source must stay inside this workspace: ${source}`);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`no such file in this workspace: ${source}`);
  return path;
};

/** Cron fields are what the panel stores; anything else it would refuse with a validation dump. */
const cronField = (args: Record<string, unknown>, key: string, fallback: string): string => {
  const value = (str(args, key) ?? fallback).trim();
  if (!/^[\d*,\-/]+$/.test(value)) throw new Error(`${key} must look like *, 5, 1-5, */10 or 1,15,30`);
  return value;
};

/** A schedule carries its tasks under `relationships.tasks`, either as a list or wrapped in `data` per serializer. */
const taskCount = (row: Record<string, unknown>): number => {
  const tasks = nested(row, 'relationships').tasks;
  if (Array.isArray(tasks)) return tasks.length;
  if (typeof tasks !== 'object' || tasks === null || !('data' in tasks)) return 0;
  return Array.isArray(tasks.data) ? tasks.data.length : 0;
};

const tools: ExtensionCapability[] = [
  {
    'name': 'ptero_servers',
    'summary': 'List panel servers',
    'description':
      'Servers this panel account can see: identifier, name, status, node, memory/disk limits and whether they are suspended.',
    'risk': 'read',
    'params': [],
    'run': async ctx => {
      const target = requirePtero(ctx.guild.id);
      const payload = await pteroRequest(ctx.guild.id, 'client', keyFor(target, 'client'), '/');
      const rows = listAttributes(payload);
      if (rows.length === 0) return 'no servers are visible to this panel account';
      return rows.map(describeServerLine).join('\n');
    },
  },
  {
    'name': 'ptero_server',
    'summary': 'Panel server details',
    'description':
      'One server: state, resource usage (memory, cpu, disk, network, uptime), limits, node and sftp details.',
    'risk': 'read',
    'params': [{ 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true }],
    'run': async (ctx, args) => {
      const target = requirePtero(ctx.guild.id);
      const key = keyFor(target, 'client');
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const details = attributesOf(await pteroRequest(ctx.guild.id, 'client', key, `/servers/${server}`));
      const stats = attributesOf(await pteroRequest(ctx.guild.id, 'client', key, `/servers/${server}/resources`));
      const usage = nested(stats, 'resources');
      return [
        describeServerLine(details),
        `state=${show(stats.current_state, 'unknown')} suspended=${stats.is_suspended === true}`,
        `usage: memory=${bytes(usage.memory_bytes)} cpu=${show(usage.cpu_absolute)}% disk=${bytes(usage.disk_bytes)}`,
        `network: rx=${bytes(usage.network_rx_bytes)} tx=${bytes(usage.network_tx_bytes)} uptime=${minutes(usage.uptime)}`,
        `invocation: ${show(details.invocation, '-')}`,
      ].join('\n');
    },
  },
  {
    'name': 'ptero_power',
    'summary': 'Start, stop or restart a server',
    'description':
      'Send a power signal to a panel server: start, stop, restart or kill (kill is an immediate SIGKILL).',
    'risk': 'destructive',
    'params': [
      { 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true },
      {
        'name': 'signal',
        'kind': 'string',
        'description': 'start | stop | restart | kill',
        'required': true,
        'choices': ['start', 'stop', 'restart', 'kill'],
      },
    ],
    'run': async (ctx, args) => {
      const target = requirePtero(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const signal = pick(POWER_SIGNALS, requireStr(args, 'signal'), 'signal');
      await pteroRequest(
        ctx.guild.id,
        'client',
        keyFor(target, 'client'),
        `/servers/${server}/power`,
        powerRequest(signal),
      );
      return `sent ${signal} to ${server}`;
    },
  },
  {
    'name': 'ptero_command',
    'summary': 'Send a console command',
    'description': 'Run one command on a server console, exactly as if typed there. Only works while the server runs.',
    'risk': 'destructive',
    'params': [
      { 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true },
      { 'name': 'command', 'kind': 'string', 'description': 'console command, e.g. "say hello"', 'required': true },
    ],
    'run': async (ctx, args) => {
      const target = requirePtero(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const command = requireStr(args, 'command').slice(0, 2000);
      await pteroRequest(
        ctx.guild.id,
        'client',
        keyFor(target, 'client'),
        `/servers/${server}/command`,
        commandRequest(command),
      );
      return `sent to ${server} console: ${command}`;
    },
  },
  {
    'name': 'ptero_files',
    'summary': 'List server files',
    'description': 'List one directory of a server: name, size, type and modified time.',
    'risk': 'read',
    'params': [
      { 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true },
      { 'name': 'directory', 'kind': 'string', 'description': 'absolute path, default /' },
    ],
    'run': async (ctx, args) => {
      const target = requirePteroFiles(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const directory = safePath(str(args, 'directory') ?? '/', 'directory');
      const payload = await pteroRequest(
        ctx.guild.id,
        'client',
        keyFor(target, 'client'),
        `/servers/${server}/files/list?directory=${encodeURIComponent(directory)}`,
      );
      const rows = listAttributes(payload);
      if (rows.length === 0) return `${directory}: empty`;
      return rows
        .map(
          file =>
            `${file.is_file === true ? 'file' : 'dir '}  ${show(file.size)}B  ${show(file.name)}${file.is_symlink === true ? '  (symlink)' : ''}`,
        )
        .join('\n');
    },
  },
  {
    'name': 'ptero_file_read',
    'summary': 'Read a server file',
    'description': 'Read one file from a server, truncated to keep it skimmable.',
    'risk': 'read',
    'params': [
      { 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true },
      { 'name': 'file', 'kind': 'string', 'description': 'absolute path to the file', 'required': true },
    ],
    'run': async (ctx, args) => {
      const target = requirePteroFiles(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const file = safePath(requireStr(args, 'file'), 'file');
      const content = await pteroRequest<string>(
        ctx.guild.id,
        'client',
        keyFor(target, 'client'),
        `/servers/${server}/files/contents?file=${encodeURIComponent(file)}`,
        { 'accept': 'text/plain' },
      );
      const text = typeof content === 'string' ? content : JSON.stringify(content);
      return `${file} (${text.length} bytes)\n${text.slice(0, 8000)}${text.length > 8000 ? '\n… truncated' : ''}`;
    },
  },
  {
    'name': 'ptero_file_write',
    'summary': 'Write a server file',
    'description':
      'Overwrite one file on a server with the given contents. The previous contents are lost; there is no undo.',
    'risk': 'destructive',
    'params': [
      { 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true },
      { 'name': 'file', 'kind': 'string', 'description': 'absolute path to the file', 'required': true },
      { 'name': 'content', 'kind': 'string', 'description': 'the complete new contents', 'required': true },
    ],
    'run': async (ctx, args) => {
      const target = requirePteroFiles(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const file = safePath(requireStr(args, 'file'), 'file');
      const content = requireStr(args, 'content');
      const request = writeRequest(content);
      await pteroRequest(
        ctx.guild.id,
        'client',
        keyFor(target, 'client'),
        `/servers/${server}/files/write?file=${encodeURIComponent(file)}`,
        request,
      );
      return `wrote ${content.length} bytes to ${file} on ${server}`;
    },
  },
  {
    'name': 'ptero_file_upload',
    'summary': 'Upload a workspace file to a server',
    'description':
      'Send one file from this bot’s workspace (`repo/…` and anything else the agent can read) to a panel server, binary-safe. The panel signs a one-time node URL and the bytes go straight there, so the bot only holds the file. Use `ptero_file_write` for text you are composing.',
    'risk': 'destructive',
    'params': [
      { 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true },
      {
        'name': 'source',
        'kind': 'string',
        'description': 'path in this workspace, e.g. repo/world.zip',
        'required': true,
      },
      { 'name': 'directory', 'kind': 'string', 'description': 'destination directory, absolute, default /' },
      { 'name': 'name', 'kind': 'string', 'description': 'file name on the server; default is the source name' },
    ],
    'run': async (ctx, args) => {
      const target = requirePteroFiles(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const source = workspaceFile(ctx.guild.id, requireStr(args, 'source'));
      const directory = directoryOf(args);
      const name = safeRelative(str(args, 'name') ?? basename(source), 'name');
      const written = await pteroUpload(
        ctx.guild.id,
        keyFor(target, 'client'),
        server,
        directory,
        name,
        readFileSync(source),
      );
      return `uploaded ${written} bytes to ${directory === '/' ? '/' : `${directory}/`}${name} on ${server}`;
    },
  },
  {
    'name': 'ptero_file_download',
    'summary': 'Get a download link for a server file',
    'description':
      'Ask the panel for a link to one file on a server, so a human can download it. The bytes never pass through the bot, and the link expires after 15 minutes.',
    'risk': 'read',
    'params': [
      { 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true },
      { 'name': 'file', 'kind': 'string', 'description': 'absolute path to the file', 'required': true },
    ],
    'run': async (ctx, args) => {
      const target = requirePteroFiles(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const file = safePath(requireStr(args, 'file'), 'file');
      const url = signedUrl(
        await pteroRequest(
          ctx.guild.id,
          'client',
          keyFor(target, 'client'),
          `/servers/${server}/files/download?file=${encodeURIComponent(file)}`,
        ),
        'download',
      );
      return `${file} on ${server}: ${url}\n(the link expires in 15 minutes)`;
    },
  },
  {
    'name': 'ptero_file_pull',
    'summary': 'Download from a URL onto a server',
    'description':
      'Have the node fetch a file from the public internet straight into a server directory, which is how jars, plugins and mod packs get there without the bot’s bandwidth. Private, loopback and link-local addresses are refused. Wings must allow remote downloads.',
    'risk': 'destructive',
    'params': [
      { 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true },
      { 'name': 'url', 'kind': 'string', 'description': 'http(s) URL the node should fetch', 'required': true },
      { 'name': 'directory', 'kind': 'string', 'description': 'destination directory, absolute, default /' },
      { 'name': 'filename', 'kind': 'string', 'description': 'save as this name instead of the URL’s' },
    ],
    'run': async (ctx, args) => {
      const target = requirePteroFiles(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const directory = directoryOf(args);
      const url = remoteUrl(requireStr(args, 'url'));
      const filename = str(args, 'filename');
      await pteroRequest(
        ctx.guild.id,
        'client',
        keyFor(target, 'client'),
        `/servers/${server}/files/pull`,
        jsonRequest('POST', {
          url,
          directory,
          ...(filename === undefined ? {} : { 'filename': safeRelative(filename, 'filename') }),
        }),
      );
      return `pulling ${url} into ${directory} on ${server}\n(the node downloads in the background; list the directory again in a moment)`;
    },
  },
  {
    'name': 'ptero_file_delete',
    'summary': 'Delete files or folders',
    'description':
      'Remove entries from one directory of a server. There is no trash and no undo; the directory itself stays.',
    'risk': 'destructive',
    'params': [
      { 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true },
      { 'name': 'directory', 'kind': 'string', 'description': 'directory holding the entries, default /' },
      { 'name': 'files', 'kind': 'string[]', 'description': 'names inside that directory', 'required': true },
    ],
    'run': async (ctx, args) => {
      const target = requirePteroFiles(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const directory = directoryOf(args);
      const files = namesOf(args);
      await pteroRequest(
        ctx.guild.id,
        'client',
        keyFor(target, 'client'),
        `/servers/${server}/files/delete`,
        jsonRequest('POST', { 'root': directory, 'files': files }),
      );
      return `deleted ${files.join(', ')} from ${directory} on ${server}`;
    },
  },
  {
    'name': 'ptero_file_rename',
    'summary': 'Rename or move a file',
    'description': 'Rename one entry inside a server directory. A move is a rename into a subpath of that directory.',
    'risk': 'reversible',
    'params': [
      { 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true },
      { 'name': 'directory', 'kind': 'string', 'description': 'directory holding the entry, default /' },
      { 'name': 'from', 'kind': 'string', 'description': 'current name', 'required': true },
      { 'name': 'to', 'kind': 'string', 'description': 'new name', 'required': true },
    ],
    'run': async (ctx, args) => {
      const target = requirePteroFiles(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const directory = directoryOf(args);
      const from = safeRelative(requireStr(args, 'from'), 'from');
      const to = safeRelative(requireStr(args, 'to'), 'to');
      await pteroRequest(
        ctx.guild.id,
        'client',
        keyFor(target, 'client'),
        `/servers/${server}/files/rename`,
        jsonRequest('PUT', { 'root': directory, 'files': [{ from, to }] }),
      );
      return `renamed ${from} to ${to} in ${directory} on ${server}`;
    },
  },
  {
    'name': 'ptero_file_mkdir',
    'summary': 'Create a folder',
    'description': 'Create one directory inside a server directory.',
    'risk': 'reversible',
    'params': [
      { 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true },
      { 'name': 'directory', 'kind': 'string', 'description': 'parent directory, default /' },
      { 'name': 'name', 'kind': 'string', 'description': 'new folder name', 'required': true },
    ],
    'run': async (ctx, args) => {
      const target = requirePteroFiles(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const directory = directoryOf(args);
      const name = safeRelative(requireStr(args, 'name'), 'name');
      await pteroRequest(
        ctx.guild.id,
        'client',
        keyFor(target, 'client'),
        `/servers/${server}/files/create-folder`,
        jsonRequest('POST', { 'root': directory, 'name': name }),
      );
      return `created ${directory === '/' ? '' : `${directory}/`}${name} on ${server}`;
    },
  },
  {
    'name': 'ptero_file_compress',
    'summary': 'Compress files into an archive',
    'description':
      'Create a .tar.gz holding one or more entries from one server directory. The node names the archive `archive-<timestamp>.tar.gz` in that same directory.',
    'risk': 'reversible',
    'params': [
      { 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true },
      { 'name': 'directory', 'kind': 'string', 'description': 'directory holding the entries, default /' },
      { 'name': 'files', 'kind': 'string[]', 'description': 'names inside that directory', 'required': true },
    ],
    'run': async (ctx, args) => {
      const target = requirePteroFiles(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const directory = directoryOf(args);
      const files = namesOf(args);
      const created = attributesOf(
        await pteroRequest(
          ctx.guild.id,
          'client',
          keyFor(target, 'client'),
          `/servers/${server}/files/compress`,
          jsonRequest('POST', { 'root': directory, 'files': files }),
        ),
      );
      return `created ${show(created.name)} (${show(created.size)}B) from ${files.join(', ')} in ${directory} on ${server}`;
    },
  },
  {
    'name': 'ptero_file_decompress',
    'summary': 'Extract an archive',
    'description': 'Extract one archive inside a server directory, in place. Whatever is in it lands there.',
    'risk': 'destructive',
    'params': [
      { 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true },
      { 'name': 'directory', 'kind': 'string', 'description': 'directory holding the archive, default /' },
      { 'name': 'file', 'kind': 'string', 'description': 'archive name inside that directory', 'required': true },
    ],
    'run': async (ctx, args) => {
      const target = requirePteroFiles(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const directory = directoryOf(args);
      const file = safeRelative(requireStr(args, 'file'), 'file');
      await pteroRequest(
        ctx.guild.id,
        'client',
        keyFor(target, 'client'),
        `/servers/${server}/files/decompress`,
        jsonRequest('POST', { 'root': directory, 'file': file }),
      );
      return `extracted ${file} in ${directory} on ${server}`;
    },
  },
  {
    'name': 'ptero_file_chmod',
    'summary': 'Change file permissions',
    'description':
      'Set the mode on entries inside one server directory, as octal like 644 or 0755. A wrong mode on a server jar or start script stops the server from starting.',
    'risk': 'destructive',
    'params': [
      { 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true },
      { 'name': 'directory', 'kind': 'string', 'description': 'directory holding the entries, default /' },
      { 'name': 'files', 'kind': 'string[]', 'description': 'names inside that directory', 'required': true },
      { 'name': 'mode', 'kind': 'string', 'description': 'octal permissions, e.g. 644 or 0755', 'required': true },
    ],
    'run': async (ctx, args) => {
      const target = requirePteroFiles(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const directory = directoryOf(args);
      const files = namesOf(args);
      const mode = chmodMode(requireStr(args, 'mode'));
      await pteroRequest(
        ctx.guild.id,
        'client',
        keyFor(target, 'client'),
        `/servers/${server}/files/chmod`,
        jsonRequest('POST', {
          'root': directory,
          'files': files.map(file => ({ file, mode })),
        }),
      );
      return `set ${files.join(', ')} to ${mode} in ${directory} on ${server}`;
    },
  },
  {
    'name': 'ptero_file_copy',
    'summary': 'Copy a file',
    'description': 'Duplicate one file on a server; the node writes it next to the original with a `copy` suffix.',
    'risk': 'reversible',
    'params': [
      { 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true },
      { 'name': 'file', 'kind': 'string', 'description': 'absolute path to the file', 'required': true },
    ],
    'run': async (ctx, args) => {
      const target = requirePteroFiles(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const file = safePath(requireStr(args, 'file'), 'file');
      await pteroRequest(
        ctx.guild.id,
        'client',
        keyFor(target, 'client'),
        `/servers/${server}/files/copy`,
        jsonRequest('POST', { 'location': file }),
      );
      return `copied ${file} on ${server}`;
    },
  },
  {
    'name': 'ptero_console',
    'summary': 'Read the console',
    'description':
      'Attach to a server’s console and report what it writes for a few seconds — startup errors, crashes, player chat. The panel keeps no history here, so this is a live window, not a log file.',
    'risk': 'read',
    'params': [
      { 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true },
      { 'name': 'seconds', 'kind': 'number', 'description': 'how long to listen, 1–20 (default 5)' },
      { 'name': 'lines', 'kind': 'number', 'description': 'stop after this many lines, 10–500 (default 100)' },
    ],
    'run': async (ctx, args) => {
      const target = requirePtero(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const seconds = Math.min(Math.max(num(args, 'seconds') ?? 5, 1), 20);
      const lines = Math.min(Math.max(num(args, 'lines') ?? 100, 10), 500);
      const tail = await readConsole(ctx.guild.id, server, { seconds, lines });
      const body = tail.lines.length === 0 ? '(nothing was written in that window)' : tail.lines.join('\n');
      return `${server} is ${tail.state}; console for ${seconds}s:\n${body}`;
    },
  },
  {
    'name': 'ptero_activity',
    'summary': 'Recent server activity',
    'description':
      'The panel’s audit trail for one server: who started, stopped or edited what, newest first. This is where "why did it restart" is answered.',
    'risk': 'read',
    'params': [
      { 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true },
      { 'name': 'event', 'kind': 'string', 'description': 'only events containing this text, e.g. file' },
      { 'name': 'count', 'kind': 'number', 'description': 'how many entries, 1–100 (default 20)' },
    ],
    'run': async (ctx, args) => {
      const target = requirePtero(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const count = Math.min(Math.max(num(args, 'count') ?? 20, 1), 100);
      const query = new URLSearchParams({ 'per_page': String(count), 'include': 'actor', 'sort': '-timestamp' });
      const event = str(args, 'event');
      if (event !== undefined) query.set('filter[event]', event);
      const rows = listAttributes(
        await pteroRequest(
          ctx.guild.id,
          'client',
          keyFor(target, 'client'),
          `/servers/${server}/activity?${query.toString()}`,
        ),
      );
      if (rows.length === 0) return `no activity recorded for ${server}${event ? ` matching "${event}"` : ''}`;
      return rows
        .map(row => {
          const actor = nested(nested(nested(row, 'relationships'), 'actor'), 'attributes');
          return `${show(row.timestamp, '-')}  ${show(row.event)}  ${show(actor.username ?? actor.email, 'system')}`;
        })
        .join('\n');
    },
  },
  {
    'name': 'ptero_backups',
    'summary': 'List backups',
    'description': 'Every backup of a server with its uuid, size, creation time and whether it completed.',
    'risk': 'read',
    'params': [{ 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true }],
    'run': async (ctx, args) => {
      const target = requirePtero(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const rows = listAttributes(
        await pteroRequest(ctx.guild.id, 'client', keyFor(target, 'client'), `/servers/${server}/backups`),
      );
      if (rows.length === 0) return `no backups of ${server}`;
      return rows
        .map(
          backup =>
            `${show(backup.uuid)}  ${show(backup.name)}  ${bytes(backup.bytes)}  created=${show(backup.created_at, '-')}  ` +
            `completed=${backup.completed_at === null ? 'no' : show(backup.completed_at)}  locked=${backup.is_locked === true}`,
        )
        .join('\n');
    },
  },
  {
    'name': 'ptero_backup_create',
    'summary': 'Back up a server',
    'description':
      'Start a backup of the whole server. The node works in the background, so the backup shows as unfinished until it completes; check `ptero_backups`.',
    'risk': 'reversible',
    'params': [
      { 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true },
      { 'name': 'name', 'kind': 'string', 'description': 'label for the backup' },
    ],
    'run': async (ctx, args) => {
      const target = requirePtero(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const name = str(args, 'name');
      const created = attributesOf(
        await pteroRequest(
          ctx.guild.id,
          'client',
          keyFor(target, 'client'),
          `/servers/${server}/backups`,
          jsonRequest('POST', { 'is_locked': false, ...(name === undefined ? {} : { name }) }),
        ),
      );
      return `started backup ${show(created.uuid)} (${show(created.name)}) of ${server}; it is not finished until ptero_backups says so`;
    },
  },
  {
    'name': 'ptero_backup_restore',
    'summary': 'Restore a backup',
    'description':
      'Unpack a backup over the server. By default it overwrites the files it holds and leaves newer ones alone; `truncate` deletes everything first, which is the true “back to that moment”. Stop the server first either way.',
    'risk': 'destructive',
    'params': [
      { 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true },
      { 'name': 'backup', 'kind': 'string', 'description': 'backup uuid from ptero_backups', 'required': true },
      {
        'name': 'truncate',
        'kind': 'boolean',
        'description': 'delete every file first, then restore (default false)',
      },
    ],
    'run': async (ctx, args) => {
      const target = requirePtero(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const backup = requireStr(args, 'backup');
      const truncate = args.truncate === true;
      await pteroRequest(
        ctx.guild.id,
        'client',
        keyFor(target, 'client'),
        `/servers/${server}/backups/${encodeURIComponent(backup)}/restore`,
        jsonRequest('POST', { truncate }),
      );
      return (
        `restoring ${backup} onto ${server}${truncate ? ' after deleting every file' : ', overwriting what it holds'}; ` +
        'the node works in the background and the server should stay stopped until it finishes'
      );
    },
  },
  {
    'name': 'ptero_backup_delete',
    'summary': 'Delete a backup',
    'description': 'Remove one backup from a server and from the backup store. There is no undo.',
    'risk': 'destructive',
    'params': [
      { 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true },
      { 'name': 'backup', 'kind': 'string', 'description': 'backup uuid from ptero_backups', 'required': true },
    ],
    'run': async (ctx, args) => {
      const target = requirePtero(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const backup = requireStr(args, 'backup');
      await pteroRequest(
        ctx.guild.id,
        'client',
        keyFor(target, 'client'),
        `/servers/${server}/backups/${encodeURIComponent(backup)}`,
        { 'method': 'DELETE' },
      );
      return `deleted backup ${backup} of ${server}`;
    },
  },
  {
    'name': 'ptero_backup_download',
    'summary': 'Get a backup download link',
    'description': 'A link to download one backup archive, signed by the panel and valid for a few minutes.',
    'risk': 'read',
    'params': [
      { 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true },
      { 'name': 'backup', 'kind': 'string', 'description': 'backup uuid from ptero_backups', 'required': true },
    ],
    'run': async (ctx, args) => {
      const target = requirePtero(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const backup = requireStr(args, 'backup');
      const url = signedUrl(
        await pteroRequest(
          ctx.guild.id,
          'client',
          keyFor(target, 'client'),
          `/servers/${server}/backups/${encodeURIComponent(backup)}/download`,
        ),
        'backup download',
      );
      return `backup ${backup} of ${server}: ${url}\n(the link expires in a few minutes)`;
    },
  },
  {
    'name': 'ptero_schedules',
    'summary': 'List schedules',
    'description':
      'The server’s cron schedules with their id, name, cron fields, whether they are active and when they next run.',
    'risk': 'read',
    'params': [{ 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true }],
    'run': async (ctx, args) => {
      const target = requirePtero(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const rows = listAttributes(
        await pteroRequest(ctx.guild.id, 'client', keyFor(target, 'client'), `/servers/${server}/schedules`),
      );
      if (rows.length === 0) return `no schedules on ${server}`;
      return rows
        .map(row => {
          const cron = nested(row, 'cron');
          const when = [cron.minute, cron.hour, cron.day_of_month, cron.month, cron.day_of_week]
            .map(field => show(field))
            .join(' ');
          return (
            `id=${show(row.id)}  ${show(row.name)}  cron="${when}"  active=${row.is_active === true}  ` +
            `next=${show(row.next_run_at, '-')}  tasks=${taskCount(row)}`
          );
        })
        .join('\n');
    },
  },
  {
    'name': 'ptero_schedule_create',
    'summary': 'Create a schedule',
    'description':
      'Create an empty cron schedule on a server; add what it should do with `ptero_schedule_task`. Fields are standard cron: wildcards, numbers, ranges, lists and steps.',
    'risk': 'reversible',
    'params': [
      { 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true },
      { 'name': 'name', 'kind': 'string', 'description': 'what this schedule is for', 'required': true },
      { 'name': 'minute', 'kind': 'string', 'description': 'cron minute, default 0' },
      { 'name': 'hour', 'kind': 'string', 'description': 'cron hour, default *' },
      { 'name': 'day_of_month', 'kind': 'string', 'description': 'cron day of month, default *' },
      { 'name': 'day_of_week', 'kind': 'string', 'description': 'cron day of week, default *' },
      { 'name': 'active', 'kind': 'boolean', 'description': 'run it on this cron (default true)' },
    ],
    'run': async (ctx, args) => {
      const target = requirePtero(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const created = attributesOf(
        await pteroRequest(
          ctx.guild.id,
          'client',
          keyFor(target, 'client'),
          `/servers/${server}/schedules`,
          jsonRequest('POST', {
            'name': requireStr(args, 'name').slice(0, 191),
            'is_active': args.active !== false,
            'minute': cronField(args, 'minute', '0'),
            'hour': cronField(args, 'hour', '*'),
            'day_of_month': cronField(args, 'day_of_month', '*'),
            'day_of_week': cronField(args, 'day_of_week', '*'),
          }),
        ),
      );
      return `created schedule id=${show(created.id)} "${show(created.name)}" on ${server}; it does nothing until ptero_schedule_task adds a task`;
    },
  },
  {
    'name': 'ptero_schedule_task',
    'summary': 'Add a task to a schedule',
    'description':
      'Attach one action to a schedule: `power` (payload is start, stop, restart or kill), `command` (payload is the console command) or `backup`. Tasks run in sequence, offset from the scheduled time.',
    'risk': 'destructive',
    'params': [
      { 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true },
      { 'name': 'schedule', 'kind': 'string', 'description': 'schedule id from ptero_schedules', 'required': true },
      {
        'name': 'action',
        'kind': 'string',
        'description': 'power | command | backup',
        'required': true,
        'choices': ['power', 'command', 'backup'],
      },
      { 'name': 'payload', 'kind': 'string', 'description': 'signal or command; ignored for backup' },
      { 'name': 'offset', 'kind': 'number', 'description': 'seconds after the schedule fires, 0–900' },
    ],
    'run': async (ctx, args) => {
      const target = requirePtero(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const schedule = requireStr(args, 'schedule');
      const action = pick(['power', 'command', 'backup'] as const, requireStr(args, 'action'), 'action');
      const payload = str(args, 'payload') ?? '';
      if (action !== 'backup' && payload.length === 0)
        throw new Error(
          `a ${action} task needs a payload: ${action === 'power' ? 'a signal like restart' : 'the command'}`,
        );
      if (action === 'power') pick(POWER_SIGNALS, payload, 'payload');
      const created = attributesOf(
        await pteroRequest(
          ctx.guild.id,
          'client',
          keyFor(target, 'client'),
          `/servers/${server}/schedules/${encodeURIComponent(schedule)}/tasks`,
          jsonRequest('POST', {
            'action': action,
            'payload': payload,
            'time_offset': Math.min(Math.max(num(args, 'offset') ?? 0, 0), 900),
          }),
        ),
      );
      return `added task ${show(created.id)} (${action}${payload.length > 0 ? ` ${payload}` : ''}) to schedule ${schedule} on ${server}`;
    },
  },
  {
    'name': 'ptero_schedule_run',
    'summary': 'Run a schedule now',
    'description': 'Trigger a schedule immediately, as if its cron time had arrived. Its tasks run in order.',
    'risk': 'destructive',
    'params': [
      { 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true },
      { 'name': 'schedule', 'kind': 'string', 'description': 'schedule id from ptero_schedules', 'required': true },
    ],
    'run': async (ctx, args) => {
      const target = requirePtero(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const schedule = requireStr(args, 'schedule');
      await pteroRequest(
        ctx.guild.id,
        'client',
        keyFor(target, 'client'),
        `/servers/${server}/schedules/${encodeURIComponent(schedule)}/execute`,
        jsonRequest('POST', {}),
      );
      return `ran schedule ${schedule} on ${server}`;
    },
  },
  {
    'name': 'ptero_schedule_delete',
    'summary': 'Delete a schedule',
    'description': 'Remove a schedule and its tasks from a server.',
    'risk': 'destructive',
    'params': [
      { 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true },
      { 'name': 'schedule', 'kind': 'string', 'description': 'schedule id from ptero_schedules', 'required': true },
    ],
    'run': async (ctx, args) => {
      const target = requirePtero(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const schedule = requireStr(args, 'schedule');
      await pteroRequest(
        ctx.guild.id,
        'client',
        keyFor(target, 'client'),
        `/servers/${server}/schedules/${encodeURIComponent(schedule)}`,
        { 'method': 'DELETE' },
      );
      return `deleted schedule ${schedule} on ${server}`;
    },
  },
  {
    'name': 'ptero_startup',
    'summary': 'Read startup variables',
    'description':
      'The egg’s environment variables for a server — jar name, Java flags, world settings — with the startup command they produce.',
    'risk': 'read',
    'params': [{ 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true }],
    'run': async (ctx, args) => {
      const target = requirePtero(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const payload = await pteroRequest<{ data?: unknown; meta?: Record<string, unknown> }>(
        ctx.guild.id,
        'client',
        keyFor(target, 'client'),
        `/servers/${server}/startup`,
      );
      const rows = listAttributes(payload);
      const meta = payload?.meta ?? {};
      return [
        `startup: ${show(meta.startup_command, '-')}`,
        ...rows.map(
          row =>
            `${show(row.env_variable)}=${show(row.server_value ?? row.default_value, '')}` +
            `${row.is_editable === true ? '' : '  (read-only)'}  ${show(row.name, '')}`,
        ),
      ].join('\n');
    },
  },
  {
    'name': 'ptero_startup_set',
    'summary': 'Change a startup variable',
    'description':
      'Set one egg environment variable on a server, e.g. the jar file or memory flags. The panel validates it against the egg; a restart applies it.',
    'risk': 'reversible',
    'params': [
      { 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true },
      { 'name': 'key', 'kind': 'string', 'description': 'variable name, e.g. SERVER_JARFILE', 'required': true },
      { 'name': 'value', 'kind': 'string', 'description': 'new value', 'required': true },
    ],
    'run': async (ctx, args) => {
      const target = requirePtero(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const key = requireStr(args, 'key');
      const value = requireStr(args, 'value');
      await pteroRequest(
        ctx.guild.id,
        'client',
        keyFor(target, 'client'),
        `/servers/${server}/startup/variable`,
        jsonRequest('PUT', { 'key': key, 'value': value }),
      );
      return `set ${key}=${value} on ${server}; restart the server for it to take effect`;
    },
  },
  {
    'name': 'ptero_allocations',
    'summary': 'List network allocations',
    'description': 'Every ip:port assigned to a server, with notes and which one is the primary address.',
    'risk': 'read',
    'params': [{ 'name': 'server', 'kind': 'string', 'description': 'server identifier or uuid', 'required': true }],
    'run': async (ctx, args) => {
      const target = requirePtero(ctx.guild.id);
      const server = requirePteroServer(target, requireStr(args, 'server'));
      const rows = listAttributes(
        await pteroRequest(ctx.guild.id, 'client', keyFor(target, 'client'), `/servers/${server}/network/allocations`),
      );
      if (rows.length === 0) return `no allocations on ${server}`;
      return rows
        .map(
          row =>
            `${show(row.ip_alias ?? row.ip)}:${show(row.port)}  primary=${row.is_default === true}` +
            `${row.notes === null || row.notes === undefined ? '' : `  notes=${show(row.notes)}`}`,
        )
        .join('\n');
    },
  },
  {
    'name': 'ptero_admin_servers',
    'summary': 'List every server on the panel',
    'description': 'Application API: all servers with their owner, node, allocation and suspension state.',
    'risk': 'read',
    'params': [{ 'name': 'filter', 'kind': 'string', 'description': 'optional name filter' }],
    'run': async (ctx, args) => {
      const target = requirePteroAdmin(ctx.guild.id);
      const filter = str(args, 'filter');
      const query = filter ? `?filter[name]=${encodeURIComponent(filter)}` : '';
      const payload = await pteroRequest(ctx.guild.id, 'admin', keyFor(target, 'admin'), `/servers${query}`);
      const rows = listAttributes(payload);
      if (rows.length === 0) return 'no servers on the panel';
      return rows
        .map(
          row =>
            `id=${show(row.id)} uuid=${show(row.uuid)} ${describeServerLine(row)} owner=${show(nested(row, 'user').username, '-')}`,
        )
        .join('\n');
    },
  },
  {
    'name': 'ptero_admin_server',
    'summary': 'One server, as an administrator',
    'description': 'Application API: full configuration of one server, including owner, node and allocations.',
    'risk': 'read',
    'params': [{ 'name': 'id', 'kind': 'string', 'description': 'panel server id', 'required': true }],
    'run': async (ctx, args) => {
      const target = requirePteroAdmin(ctx.guild.id);
      const id = requireStr(args, 'id');
      const server = attributesOf(
        await pteroRequest(ctx.guild.id, 'admin', keyFor(target, 'admin'), `/servers/${id}?include=user,allocations`),
      );
      const owner = nested(server, 'user');
      const allocations = nested(server, 'relationships').allocations;
      return [
        describeServerLine(server),
        `owner: ${show(owner.username)} <${show(owner.email)}>`,
        `docker image: ${show(server.docker_image, '-')}`,
        `startup: ${show(server.startup, '-')}`,
        `allocations: ${JSON.stringify(allocations).slice(0, 400)}`,
      ].join('\n');
    },
  },
  {
    'name': 'ptero_admin_users',
    'summary': 'List panel users',
    'description': 'Application API: panel accounts with their id, username, email and whether they are root admins.',
    'risk': 'read',
    'params': [{ 'name': 'query', 'kind': 'string', 'description': 'optional email or username filter' }],
    'run': async (ctx, args) => {
      const target = requirePteroAdmin(ctx.guild.id);
      const query = str(args, 'query');
      const payload = await pteroRequest(
        ctx.guild.id,
        'admin',
        keyFor(target, 'admin'),
        `/users${query ? `?filter[email]=${encodeURIComponent(query)}` : ''}`,
      );
      const rows = listAttributes(payload);
      if (rows.length === 0) return 'no panel users';
      return rows
        .map(
          row => `id=${show(row.id)} ${show(row.username)} <${show(row.email)}> root_admin=${row.root_admin === true}`,
        )
        .join('\n');
    },
  },
  {
    'name': 'ptero_admin_nodes',
    'summary': 'List panel nodes',
    'description': 'Application API: Wings nodes, their memory/disk capacity and how many servers each holds.',
    'risk': 'read',
    'params': [],
    'run': async ctx => {
      const target = requirePteroAdmin(ctx.guild.id);
      const payload = await pteroRequest(ctx.guild.id, 'admin', keyFor(target, 'admin'), '/nodes');
      const rows = listAttributes(payload);
      if (rows.length === 0) return 'no nodes';
      return rows
        .map(
          node =>
            `id=${show(node.id)} ${show(node.name)} public=${show(node.public, '-')} mainteance=${node.maintenance_mode === true} memory=${show(node.memory)}MB disk=${show(node.disk)}MB`,
        )
        .join('\n');
    },
  },
  {
    'name': 'ptero_admin_nests',
    'summary': 'List nests and eggs',
    'description':
      'Application API: nest ids and their eggs, which are what a new server needs (egg id + docker image).',
    'risk': 'read',
    'params': [{ 'name': 'nest', 'kind': 'string', 'description': 'nest id; omit to list nests' }],
    'run': async (ctx, args) => {
      const target = requirePteroAdmin(ctx.guild.id);
      const key = keyFor(target, 'admin');
      const nest = str(args, 'nest');
      if (!nest) {
        const nests = listAttributes(await pteroRequest(ctx.guild.id, 'admin', key, '/nests'));
        return nests.map(row => `nest id=${show(row.id)} ${show(row.name)}`).join('\n') || 'no nests';
      }
      const eggs = listAttributes(await pteroRequest(ctx.guild.id, 'admin', key, `/nests/${nest}/eggs`));
      return (
        eggs
          .map(
            egg =>
              `egg id=${show(egg.id)} ${show(egg.name)} docker=${JSON.stringify(egg.docker_images ?? {}).slice(0, 160)}`,
          )
          .join('\n') || 'no eggs'
      );
    },
  },
  {
    'name': 'ptero_admin_user_create',
    'summary': 'Create a panel user',
    'description':
      "Application API: create a panel account. The password is the caller's choice and is passed through as given.",
    'risk': 'admin',
    'params': [
      { 'name': 'email', 'kind': 'string', 'description': 'email address', 'required': true },
      { 'name': 'username', 'kind': 'string', 'description': 'username', 'required': true },
      { 'name': 'first_name', 'kind': 'string', 'description': 'first name', 'required': true },
      { 'name': 'last_name', 'kind': 'string', 'description': 'last name', 'required': true },
      { 'name': 'password', 'kind': 'string', 'description': 'initial password', 'required': true },
      { 'name': 'root_admin', 'kind': 'boolean', 'description': 'grant full panel administration' },
    ],
    'run': async (ctx, args) => {
      const target = requirePteroAdmin(ctx.guild.id);
      const body = JSON.stringify({
        'email': requireStr(args, 'email'),
        'username': requireStr(args, 'username'),
        'first_name': requireStr(args, 'first_name'),
        'last_name': requireStr(args, 'last_name'),
        'password': requireStr(args, 'password'),
        'root_admin': args.root_admin === true,
      });
      const created = attributesOf(
        await pteroRequest(ctx.guild.id, 'admin', keyFor(target, 'admin'), '/users', { 'method': 'POST', body }),
      );
      return `created panel user ${show(created.username)} (id ${show(created.id)}) root_admin=${created.root_admin === true}`;
    },
  },
  {
    'name': 'ptero_admin_suspend',
    'summary': 'Suspend or unsuspend a server',
    'description': 'Application API: suspend (stops it and blocks the owner) or unsuspend one server.',
    'risk': 'destructive',
    'params': [
      { 'name': 'id', 'kind': 'string', 'description': 'panel server id', 'required': true },
      {
        'name': 'action',
        'kind': 'string',
        'description': 'suspend | unsuspend',
        'required': true,
        'choices': ['suspend', 'unsuspend'],
      },
    ],
    'run': async (ctx, args) => {
      const target = requirePteroAdmin(ctx.guild.id);
      const id = requireStr(args, 'id');
      const action = pick(['suspend', 'unsuspend'] as const, requireStr(args, 'action'), 'action');
      await pteroRequest(ctx.guild.id, 'admin', keyFor(target, 'admin'), `/servers/${id}/${action}`, {
        'method': 'POST',
      });
      return `${action}ed panel server ${id}`;
    },
  },
  {
    'name': 'ptero_admin_server_create',
    'summary': 'Create a panel server',
    'description':
      'Application API: create a server from an egg. Needs the user id, nest id, egg id, docker image, startup line and one allocation id.',
    'risk': 'admin',
    'params': [
      { 'name': 'name', 'kind': 'string', 'description': 'server name', 'required': true },
      { 'name': 'user_id', 'kind': 'string', 'description': 'panel user id that owns it', 'required': true },
      { 'name': 'nest_id', 'kind': 'string', 'description': 'nest id', 'required': true },
      { 'name': 'egg_id', 'kind': 'string', 'description': 'egg id', 'required': true },
      { 'name': 'docker_image', 'kind': 'string', 'description': 'docker image for the egg', 'required': true },
      { 'name': 'startup', 'kind': 'string', 'description': 'startup command', 'required': true },
      { 'name': 'allocation_id', 'kind': 'string', 'description': 'allocation (port) id to use', 'required': true },
      { 'name': 'memory_mb', 'kind': 'number', 'description': 'memory limit in MB (default 1024)' },
      { 'name': 'disk_mb', 'kind': 'number', 'description': 'disk limit in MB (default 5120)' },
      { 'name': 'cpu_percent', 'kind': 'number', 'description': 'cpu limit in percent (default 100)' },
      {
        'name': 'environment',
        'kind': 'string',
        'description': 'JSON object of egg variables, e.g. {"SERVER_JARFILE":"server.jar"}',
      },
    ],
    'run': async (ctx, args) => {
      const target = requirePteroAdmin(ctx.guild.id);
      const environment = str(args, 'environment');
      const body = JSON.stringify({
        'name': requireStr(args, 'name'),
        'user': Number(requireStr(args, 'user_id')),
        'egg': Number(requireStr(args, 'egg_id')),
        'docker_image': requireStr(args, 'docker_image'),
        'startup': requireStr(args, 'startup'),
        'environment': environment ? (JSON.parse(environment) as unknown) : {},
        'limits': {
          'memory': num(args, 'memory_mb') ?? 1024,
          'swap': 0,
          'disk': num(args, 'disk_mb') ?? 5120,
          'io': 500,
          'cpu': num(args, 'cpu_percent') ?? 100,
        },
        'feature_limits': { 'databases': 0, 'backups': 0, 'allocations': 0 },
        'allocation': { 'default': Number(requireStr(args, 'allocation_id')) },
        'start_on_completion': false,
      });
      const created = attributesOf(
        await pteroRequest(ctx.guild.id, 'admin', keyFor(target, 'admin'), '/servers', { 'method': 'POST', body }),
      );
      return `created panel server ${show(created.name)} id=${show(created.id)} uuid=${show(created.uuid)}`;
    },
  },
];

/**
 * Pterodactyl: the client API (that account's servers) and, when the guild asks for it, the application API (the
 * whole panel). Availability is resolved per guild from `.env` keys plus the `pterodactyl.*` switches, so "the
 * panel is not configured here" is a missing tool rather than a tool that always fails.
 */
export const pterodactylExtension: Extension = {
  'id': 'pterodactyl',
  'name': 'Pterodactyl panel',
  'description': 'Server status, power, console and files over the panel API, plus whole-panel admin when enabled.',
  'available': guildId =>
    resolvePtero(guildId)
      ? { 'ok': true, 'reason': '' }
      : { 'ok': false, 'reason': 'no panel configured (pterodactyl.enabled + PTERO_CLIENT_KEY + PTERO_BASE_URL)' },
  'capabilities': tools.map(tool => ({
    ...tool,
    // the application-API half is also its own set, so "whole panel" can be switched off without losing status
    'sets': tool.name.startsWith('ptero_admin_') ? ['pterodactyl-admin'] : [],
    ...(tool.name.startsWith('ptero_admin_')
      ? { 'available': adminTools }
      : FILE_TOOLS.includes(tool.name)
        ? { 'available': fileTools }
        : {}),
  })),
};
