import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { config, paths } from '@services/config.ts';
import { log } from '@utils/logger.ts';

import { authedRemote, redact, resolveForge } from './forge.ts';

const logger = log('git');

const GIT_IDENTITY = ['-c', 'user.email=agent@open-discord-agent', '-c', 'user.name=open-discord-agent'];

/** `Bun.spawnSync` does not always resolve bare names from PATH on Windows, so the binary is located first. */
const gitBinary = (): string | undefined => Bun.which('git') ?? undefined;

export type GitResult = { ok: boolean; detail: string };

const runGit = (cwd: string, argv: string[]): { code: number; stdout: string; stderr: string } => {
  const git = gitBinary();
  if (!git) return { 'code': -1, 'stdout': '', 'stderr': 'git not found on PATH' };
  const proc = Bun.spawnSync([git, ...argv], { cwd, 'stdout': 'pipe', 'stderr': 'pipe', 'env': Bun.env });
  return { 'code': proc.exitCode ?? -1, 'stdout': proc.stdout.toString(), 'stderr': proc.stderr.toString() };
};

const workspaceOf = (guildId: string): string => resolve(paths.workspaces, guildId);

const ensureRepo = (cwd: string): GitResult => {
  mkdirSync(cwd, { 'recursive': true });
  if (existsSync(resolve(cwd, '.git'))) return { 'ok': true, 'detail': 'already a repo' };
  const init = runGit(cwd, ['init', '-q', '-b', 'main']);
  // `-b` needs git 2.28+; fall back to the default branch name when the binary is older.
  const plain = init.code === 0 ? init : runGit(cwd, ['init', '-q']);
  return plain.code === 0
    ? { 'ok': true, 'detail': 'initialised' }
    : { 'ok': false, 'detail': plain.stderr.trim().slice(0, 200) || 'git init failed' };
};

export type CommitResult = { committed: boolean; pushed?: GitResult };

/**
 * Commits everything in the workspace. Every turn and every artifact write goes through here, which is what
 * makes click-free edits safe: the previous state is always one `git revert` (or `/undo`) away.
 *
 * When the guild configured a git server with `git.push`, the new commit is pushed immediately — "the agent
 * edited a file" and "the edit is on the remote" are never two different states.
 */
export function commitWorkspace(guildId: string, message: string): CommitResult {
  const cwd = workspaceOf(guildId);
  const repo = ensureRepo(cwd);
  if (!repo.ok) {
    logger.warn('git init failed; workspace changes will not be versioned', { guildId, 'detail': repo.detail });
    return { 'committed': false };
  }

  runGit(cwd, ['add', '-A']);
  const commit = runGit(cwd, [...GIT_IDENTITY, 'commit', '-q', '-m', message]);
  if (commit.code !== 0) {
    if (!commit.stderr.includes('nothing to commit'))
      logger.warn('workspace commit failed', { guildId, 'stderr': commit.stderr.slice(0, 200) });
    return { 'committed': false };
  }
  logger.debug('workspace committed', { guildId, message });

  if (!config.git(guildId).push) return { 'committed': true };
  const pushed = pushWorkspace(guildId);
  if (!pushed.ok) logger.warn('workspace push failed', { guildId, 'detail': pushed.detail.slice(0, 200) });
  return { 'committed': true, pushed };
}

/**
 * Pushes the current branch to the configured server. The credential is passed on the command line instead of
 * being written into `.git/config`, so a token never lands inside the workspace that the agent can read.
 */
export function pushWorkspace(guildId: string): GitResult {
  const target = resolveForge(guildId);
  if (!target) return { 'ok': false, 'detail': 'no git server configured (git.enabled + GIT_TOKEN/GIT_BASE_URL)' };
  const cwd = workspaceOf(guildId);
  const branch = runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim() || 'main';
  const origin = runGit(cwd, ['remote', 'get-url', 'origin']).stdout.trim();
  if (origin.length === 0)
    return { 'ok': false, 'detail': 'workspace has no origin remote (create or attach a repo first)' };

  const push = runGit(cwd, ['push', '--quiet', authedRemote(target, origin), `HEAD:refs/heads/${branch}`]);
  if (push.code !== 0)
    return { 'ok': false, 'detail': redact(push.stderr.trim(), target.token).slice(0, 300) || 'push failed' };
  logger.info('workspace pushed', { guildId, branch });
  return { 'ok': true, 'detail': `pushed ${branch} to ${target.baseUrl}` };
}

/** The model-facing view: enough to know whether anything is pending, without dumping a whole diff. */
export function describeWorkspace(guildId: string): string {
  const cwd = workspaceOf(guildId);
  const repo = ensureRepo(cwd);
  if (!repo.ok) return `git: not a repository (${repo.detail})`;

  const branch = runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const status = runGit(cwd, ['status', '--porcelain']).stdout.trim();
  const pending = status.length === 0 ? [] : status.split('\n').slice(0, 20);
  const log = runGit(cwd, ['log', '--oneline', '-5']).stdout.trim();
  const origin = runGit(cwd, ['remote', 'get-url', 'origin']).stdout.trim();
  const target = resolveForge(guildId);
  const behind = origin.length > 0 ? runGit(cwd, ['rev-list', '--count', `origin/${branch}..HEAD`]).stdout.trim() : '';

  return [
    `branch: ${branch || 'unknown'}`,
    `remote: ${origin || 'none'}`,
    `server: ${target ? `${target.provider} ${target.baseUrl}` : 'not configured'}`,
    `auto-push: ${config.git(guildId).push && target ? 'on' : 'off'}`,
    pending.length === 0 ? 'working tree: clean' : `uncommitted (${pending.length}):\n${pending.join('\n')}`,
    behind.length > 0 && Number.isFinite(Number(behind)) ? `unpushed commits: ${behind}` : '',
    log.length === 0 ? 'history: empty' : `recent commits:\n${log}`,
  ]
    .filter(line => line.length > 0)
    .join('\n');
}

/** Points the workspace at a repository the bot just created, so the next push lands there. */
export function attachOrigin(guildId: string, cloneUrl: string): GitResult {
  const cwd = workspaceOf(guildId);
  const repo = ensureRepo(cwd);
  if (!repo.ok) return repo;
  const existing = runGit(cwd, ['remote', 'get-url', 'origin']).stdout.trim();
  if (existing.length > 0) return { 'ok': false, 'detail': `workspace already has origin ${existing}` };
  const add = runGit(cwd, ['remote', 'add', 'origin', cloneUrl]);
  return add.code === 0
    ? { 'ok': true, 'detail': `origin set to ${cloneUrl}` }
    : { 'ok': false, 'detail': add.stderr.trim().slice(0, 200) };
}

export type CommitInput = { guildId: string; message: string };

/**
 * Model-facing commit: same path as the automatic one, so a commit the agent asks for is indistinguishable from
 * a turn commit. An explicit `git_commit` also pushes when a server is configured, even with auto-push off —
 * "commit" without "on the remote" is not what the caller asked for.
 */
export function commitNow(input: CommitInput): string {
  const result = commitWorkspace(input.guildId, input.message);
  if (!result.committed) return 'nothing to commit (the workspace already matches the last commit)';
  const pushed = result.pushed ?? (resolveForge(input.guildId) ? pushWorkspace(input.guildId) : undefined);
  if (!pushed) return `committed locally: ${input.message} (no git server configured)`;
  return pushed.ok
    ? `committed and pushed: ${input.message}`
    : `committed locally; push did NOT happen: ${pushed.detail}`;
}
