import { config } from '@services/config.ts';
import {
  POWER_SIGNALS,
  attributesOf,
  commandRequest,
  describeServerLine,
  keyFor,
  listAttributes,
  powerRequest,
  pteroRequest,
  resolvePtero,
  safePath,
  serverAllowed,
  writeRequest,
  type PteroTarget,
} from '@services/pterodactyl/api.ts';

import {
  bytes,
  minutes,
  nested,
  num,
  pick,
  requireStr,
  show,
  str,
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

const FILE_TOOLS = ['ptero_files', 'ptero_file_read', 'ptero_file_write'];

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
