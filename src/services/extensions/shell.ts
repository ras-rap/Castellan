import { runShell } from '@services/workspace/shell.ts';

import { requireStr, type Extension, type ExtensionCapability } from './protocol.ts';

/**
 * The sandbox itself. `bash` is the shadowed builtin: the generated tool file replaces opencode's own `bash`, so
 * every command goes through this extension — and therefore through that guild's shell mode — instead of landing
 * on the host.
 */
const tools: ExtensionCapability[] = [
  {
    'name': 'bash',
    'summary': 'Run a shell command',
    'description':
      'Run a shell command in the workspace. Shadowed builtin: routed through the sandbox (docker by default).',
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
