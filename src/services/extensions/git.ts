import { config } from '@services/config.ts';
import { createRepo } from '@services/git/forge.ts';
import { attachOrigin, commitNow, describeWorkspace, pushWorkspace } from '@services/git/workspace.ts';

import { requireStr, type Extension, type ExtensionCapability } from './protocol.ts';

/** Local commits work with no server; pushing needs a forge, and creating repositories needs the switch too. */
const forgeReady = (guildId: string) =>
  config.git(guildId).enabled
    ? { 'ok': true, 'reason': '' }
    : { 'ok': false, 'reason': 'no git server configured here (git.enabled + GIT_TOKEN/GIT_BASE_URL)' };

const repoCreateReady = (guildId: string) =>
  config.git(guildId).createRepos
    ? forgeReady(guildId)
    : { 'ok': false, 'reason': 'creating repositories is off here (git.createRepos)' };

const tools: ExtensionCapability[] = [
  {
    'name': 'git_status',
    'summary': 'Workspace git state',
    'description':
      "This server's workspace repository: branch, remote, uncommitted files, unpushed commits and the last few commits.",
    'risk': 'read',
    'params': [],
    'run': async ctx => describeWorkspace(ctx.guild.id),
  },
  {
    'name': 'git_commit',
    'summary': 'Commit workspace changes',
    'description':
      'Commit everything in the workspace with your own message. Each turn is committed automatically; use this for an explicit checkpoint, and it is pushed when auto-push is on.',
    'risk': 'reversible',
    'params': [{ 'name': 'message', 'kind': 'string', 'description': 'commit message', 'required': true }],
    'run': async (ctx, args) =>
      commitNow({ 'guildId': ctx.guild.id, 'message': requireStr(args, 'message').slice(0, 200) }),
  },
  {
    'name': 'git_push',
    'summary': 'Push the workspace',
    'description':
      'Push the current branch to the git server configured for this server. Refuses when no server is configured.',
    'risk': 'reversible',
    'params': [],
    'run': async ctx => {
      const pushed = pushWorkspace(ctx.guild.id);
      if (!pushed.ok) throw new Error(pushed.detail);
      return pushed.detail;
    },
  },
  {
    'name': 'git_repo_create',
    'summary': 'Create a repository on the git server',
    'description':
      'Create a new repository for this server on the configured git server, optionally pointing the workspace at it as origin.',
    'risk': 'reversible',
    'params': [
      { 'name': 'name', 'kind': 'string', 'description': 'repository name (letters, digits, . _ -)', 'required': true },
      {
        'name': 'attach',
        'kind': 'boolean',
        'description': 'set it as the workspace origin, only when the workspace has none',
      },
    ],
    'run': async (ctx, args) => {
      if (!config.git(ctx.guild.id).createRepos)
        throw new Error('creating repositories is off here (git.createRepos is false)');
      const name = requireStr(args, 'name');
      if (!/^[\w.-]{1,64}$/.test(name)) throw new Error(`"${name}" is not a usable repository name`);
      const repo = await createRepo(ctx.guild.id, name);
      if (!repo) throw new Error('the git server refused the create request (see the bot log)');
      const attached = args.attach === true ? attachOrigin(ctx.guild.id, repo.cloneUrl) : undefined;
      return [
        `created ${repo.name}: ${repo.htmlUrl}`,
        attached ? `origin: ${attached.ok ? repo.cloneUrl : `not attached — ${attached.detail}`}` : 'origin unchanged',
      ].join('\n');
    },
  },
];

export const gitExtension: Extension = {
  'id': 'git',
  'name': 'Workspace git',
  'description': 'Inspect, commit and push the guild workspace repository, and create repositories on the git server.',
  'capabilities': tools.map(tool =>
    tool.name === 'git_push'
      ? { ...tool, 'available': forgeReady }
      : tool.name === 'git_repo_create'
        ? { ...tool, 'available': repoCreateReady }
        : tool,
  ),
};
