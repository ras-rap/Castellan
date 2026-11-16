import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { config, paths } from '@services/config.ts';
import { authedRemote, redact, repoFromResponse, repoRequest, resolveForge } from '@services/git/forge.ts';
import { commitNow, commitWorkspace, describeWorkspace, pushWorkspace } from '@services/git/workspace.ts';
import { renderAgentsFile, renderDiscordToolFile } from '@services/workspace/codegen.ts';
import { afterEach, describe, expect, test } from 'bun:test';

import type { ForgeTarget } from '@services/git/forge.ts';

/** `GUILDS_FILE` is read per call, so each test can own the guild registry without touching config/. */
const tempDirs: string[] = [];
const savedGuildsFile = process.env.GUILDS_FILE;

const useGuilds = (guilds: Record<string, unknown>): void => {
  const dir = mkdtempSync(resolve(tmpdir(), 'castellan-git-'));
  tempDirs.push(dir);
  const file = resolve(dir, 'guilds.json');
  writeFileSync(file, JSON.stringify(guilds));
  process.env.GUILDS_FILE = file;
};

afterEach(() => {
  if (savedGuildsFile === undefined) delete process.env.GUILDS_FILE;
  else process.env.GUILDS_FILE = savedGuildsFile;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { 'recursive': true, 'force': true });
});

const target = (over: Partial<ForgeTarget> = {}): ForgeTarget => ({
  'provider': 'forgejo',
  'baseUrl': 'https://git.test',
  'owner': '',
  'token': 'tok/with+chars',
  'visibility': 'private',
  ...over,
});

const git = (cwd: string, argv: string[]): string => {
  const binary = Bun.which('git');
  if (!binary) throw new Error('git is required for these tests');
  const proc = Bun.spawnSync([binary, ...argv], { cwd, 'stdout': 'pipe', 'stderr': 'pipe' });
  if (proc.exitCode !== 0) throw new Error(`${argv.join(' ')} failed: ${proc.stderr.toString()}`);
  return proc.stdout.toString();
};

describe('forge requests', () => {
  test('gitea/forgejo create under the user, or under the configured group', () => {
    const personal = repoRequest(target(), 'bot-notes');
    expect(personal.url).toBe('https://git.test/api/v1/user/repos');
    expect(personal.headers.authorization).toBe('token tok/with+chars');
    expect(JSON.parse(personal.body)).toEqual({ 'name': 'bot-notes', 'private': true, 'auto_init': false });

    const group = repoRequest(target({ 'owner': 'infra' }), 'bot-notes');
    expect(group.url).toBe('https://git.test/api/v1/orgs/infra/repos');
    expect(repoRequest(target({ 'owner': 'user' }), 'x').url).toBe('https://git.test/api/v1/user/repos');
  });

  test('gitlab uses its own path, header and visibility field', () => {
    const request = repoRequest(target({ 'provider': 'gitlab', 'visibility': 'public' }), 'bot-notes');
    expect(request.url).toBe('https://git.test/api/v4/projects');
    expect(request.headers['PRIVATE-TOKEN']).toBe('tok/with+chars');
    expect(JSON.parse(request.body)).toEqual({ 'name': 'bot-notes', 'path': 'bot-notes', 'visibility': 'public' });
  });

  test('both response shapes are understood, junk is not', () => {
    expect(
      repoFromResponse({ 'name': 'a', 'clone_url': 'https://git.test/x/a.git', 'html_url': 'https://git.test/x/a' }),
    ).toEqual({ 'name': 'a', 'cloneUrl': 'https://git.test/x/a.git', 'htmlUrl': 'https://git.test/x/a' });
    expect(repoFromResponse({ 'name': 'b', 'http_url_to_repo': 'https://git.test/b.git' })?.cloneUrl).toBe(
      'https://git.test/b.git',
    );
    expect(repoFromResponse({ 'message': 'no' })).toBeUndefined();
    expect(repoFromResponse('nope')).toBeUndefined();
  });

  test('the push URL carries the credential in the provider-specific shape', () => {
    expect(authedRemote(target(), 'https://git.test/infra/x.git')).toBe(
      'https://tok%2Fwith+chars@git.test/infra/x.git',
    );
    expect(authedRemote(target({ 'provider': 'gitlab' }), 'https://git.test/infra/x.git')).toBe(
      'https://oauth2:tok%2Fwith+chars@git.test/infra/x.git',
    );
    // a local path is not an http remote: left alone
    expect(authedRemote(target(), 'file:///tmp/x.git')).toBe('file:///tmp/x.git');
    expect(redact('failed for tok/with+chars', 'tok/with+chars')).toBe('failed for ***');
  });

  test('a guild only gets a target when enabled and the deployment has a token and host', () => {
    useGuilds({ 'off': { 'enabled': true }, 'on': { 'enabled': true, 'git': { 'enabled': true } } });
    expect(resolveForge('off')).toBeUndefined();
    const resolved = resolveForge('on');
    expect(resolved?.baseUrl).toBe('https://git.test');
    expect(resolved?.token).toBe('test-token');
    // the guild's own baseUrl and provider win over the deployment defaults
    useGuilds({
      'own': { 'enabled': true, 'git': { 'enabled': true, 'baseUrl': 'https://gitea.local', 'provider': 'gitea' } },
    });
    expect(resolveForge('own')).toMatchObject({ 'baseUrl': 'https://gitea.local', 'provider': 'gitea' });
  });
});

describe('workspace commits and pushes', () => {
  const GUILD = `test-git-${Date.now().toString(36)}`;
  const workspace = resolve(paths.workspaces, GUILD);
  const remote = resolve(tmpdir(), `castellan-remote-${Date.now().toString(36)}.git`);

  const cleanup = () => {
    if (existsSync(workspace)) rmSync(workspace, { 'recursive': true, 'force': true });
    if (existsSync(remote)) rmSync(remote, { 'recursive': true, 'force': true });
  };

  test('a turn commit lands, a second empty commit is a no-op, and push reaches the remote', () => {
    useGuilds({ [GUILD]: { 'enabled': true, 'git': { 'enabled': true } } });
    try {
      // an empty repository has nothing to commit: the first turn's edit is what makes a commit exist
      expect(commitWorkspace(GUILD, 'agent: turn test').committed).toBe(false);
      writeFileSync(resolve(workspace, 'repo.txt'), 'hello\n');
      expect(commitWorkspace(GUILD, 'agent: turn test').committed).toBe(true);
      expect(commitWorkspace(GUILD, 'agent: turn test again').committed).toBe(false);

      const status = describeWorkspace(GUILD);
      expect(status).toContain('working tree: clean');
      expect(status).toContain('server: forgejo https://git.test');

      // a local bare repository stands in for the server: the push itself is real git
      mkdtempSync(resolve(tmpdir(), 'castellan-remote-'));
      git(tmpdir(), ['init', '--bare', '-q', remote]);
      git(workspace, ['remote', 'add', 'origin', `file://${remote.replaceAll('\\', '/')}`]);

      const pushed = pushWorkspace(GUILD);
      expect(pushed.ok).toBe(true);
      // the workspace branch is `main`, so that is the ref the remote holds
      expect(git(remote, ['rev-list', '--count', 'main']).trim()).toBe('1');

      // `git_commit` reports what actually happened, including the push
      writeFileSync(resolve(workspace, 'note.txt'), 'hello\n');
      expect(commitNow({ 'guildId': GUILD, 'message': 'agent: note' })).toContain('committed and pushed');
      expect(git(remote, ['log', '-1', '--format=%s', 'main']).trim()).toBe('agent: note');
    } finally {
      cleanup();
    }
  });

  test('push refuses without a configured server or a remote', () => {
    useGuilds({ [GUILD]: { 'enabled': true } });
    try {
      commitWorkspace(GUILD, 'agent: init');
      expect(pushWorkspace(GUILD)).toEqual({
        'ok': false,
        'detail': 'no git server configured (git.enabled + GIT_TOKEN/GIT_BASE_URL)',
      });

      useGuilds({ [GUILD]: { 'enabled': true, 'git': { 'enabled': true } } });
      expect(pushWorkspace(GUILD)).toEqual({
        'ok': false,
        'detail': 'workspace has no origin remote (create or attach a repo first)',
      });
    } finally {
      cleanup();
    }
  });
});

describe('git in the generated workspace', () => {
  test('push and repo creation are only offered when the server is configured for that guild', () => {
    useGuilds({
      'none': { 'enabled': true },
      'server': { 'enabled': true, 'git': { 'enabled': true } },
      'creator': { 'enabled': true, 'git': { 'enabled': true, 'createRepos': true } },
    });

    const off = renderDiscordToolFile('none');
    expect(off).not.toContain('export const git_push');
    expect(off).not.toContain('export const git_repo_create');
    // local commits are always useful, even with no server
    expect(off).toContain('export const git_commit');
    expect(off).toContain('export const git_status');

    const server = renderDiscordToolFile('server');
    expect(server).toContain('export const git_push');
    expect(server).not.toContain('export const git_repo_create');

    expect(renderDiscordToolFile('creator')).toContain('export const git_repo_create');
  });

  test('the persona says commits are automatic, and differs with a server configured', () => {
    useGuilds({
      'none': { 'enabled': true },
      'server': { 'enabled': true, 'git': { 'enabled': true, 'push': true } },
    });

    const local = renderAgentsFile('Test', 'none');
    expect(local).toContain('every turn is committed for you');
    expect(local).toContain('No git server is configured here');

    const remote = renderAgentsFile('Test', 'server');
    expect(remote).toContain('forgejo at https://git.test');
    expect(remote).toContain('pushed straight away');
    expect(remote).toContain('Never rewrite history, never force-push');
  });

  test('the git tool set can be switched off like any other set', () => {
    useGuilds({ 'hidden': { 'enabled': true, 'features': { 'tools': { 'disabled': ['git'] } } } });
    const file = renderDiscordToolFile('hidden');
    expect(file).not.toContain('export const git_commit');
    expect(file).not.toContain('export const git_status');
    expect(config.git('hidden').enabled).toBe(false);
  });
});
