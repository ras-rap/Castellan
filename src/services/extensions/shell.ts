import { runShell } from '@services/workspace/shell.ts';

import { requireStr, type Extension, type ExtensionCapability } from './protocol.ts';

/**
 * The sandbox itself, and the *only* shell the model gets.
 *
 * It used to be called `bash`, hoping to shadow opencode's builtin of the same name. Shadowing is not a
 * removal: the server kept offering its own `bash`, which runs on the host, so "sandboxed by default" was one
 * tool call away from not being sandboxed at all. The name is now distinct (`shell`), and the generated
 * `opencode.json` switches the builtin off by name (`tools: { bash: false }` plus a `deny` permission), so a
 * guild's shell mode is the only thing that decides where a command lands.
 */
const tools: ExtensionCapability[] = [
  {
    'name': 'shell',
    'summary': 'Run a shell command',
    'description':
      'Run a shell command. Routed through this server’s shell mode: a per-guild docker container by default, the host only where the owner opted in. There is no other shell tool.',
    'risk': 'destructive',
    'params': [{ 'name': 'command', 'kind': 'string', 'description': 'shell command to execute', 'required': true }],
    'run': async (ctx, args) => runShell(ctx.guild.id, requireStr(args, 'command')),
  },
];

export const shellExtension: Extension = {
  'id': 'shell',
  'name': 'Sandboxed shell',
  'description':
    'Run commands in the guild shell: a per-guild docker container by default, the host when the owner opted in.',
  'capabilities': tools,
};
