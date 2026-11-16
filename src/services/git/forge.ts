import { config } from '@services/config.ts';
import { resolveSecret } from '@services/secrets/store.ts';
import { GIT_BASE_URL, GIT_OWNER, GIT_TOKEN } from '@utils/env.ts';
import { log } from '@utils/logger.ts';

const logger = log('git/forge');

export type ForgeProvider = 'gitea' | 'forgejo' | 'gitlab';

/** Everything needed to talk to a hosted git server. The token is this server's own, or the deployment's. */
export type ForgeTarget = {
  provider: ForgeProvider;
  /** Scheme and host, no trailing slash: `https://git.example.com`. */
  baseUrl: string;
  /** User or group that owns repos this bot creates. */
  owner: string;
  token: string;
  visibility: 'private' | 'public';
};

export type ForgeRepo = { name: string; cloneUrl: string; htmlUrl: string };

/**
 * The guild's git settings, with the token this server stored (dashboard → Secrets) or the deployment's
 * `GIT_TOKEN`. `undefined` means "not configured", and every caller treats that as "the feature is off".
 */
export function resolveForge(guildId: string): ForgeTarget | undefined {
  const git = config.git(guildId);
  const baseUrl = (git.baseUrl.length > 0 ? git.baseUrl : (GIT_BASE_URL ?? '')).replace(/\/+$/, '');
  const token = resolveSecret(guildId, 'git.token', GIT_TOKEN) ?? '';
  if (!git.enabled || baseUrl.length === 0 || token.length === 0) return undefined;
  return {
    'provider': git.provider,
    baseUrl,
    'owner': git.owner.length > 0 ? git.owner : (GIT_OWNER ?? ''),
    token,
    'visibility': git.visibility,
  };
}

/** Secrets never reach a log line or a user-facing error. */
export const redact = (text: string, token: string): string =>
  token.length > 0 ? text.replaceAll(token, '***').replaceAll(encodeURIComponent(token), '***') : text;

/**
 * The `POST` that creates a repository, as data so it can be tested without a server: Gitea and Forgejo share
 * `/api/v1` and a `token` header, GitLab uses `/api/v4` and `PRIVATE-TOKEN` with a `visibility` field. GitLab
 * creates under the token's own namespace (group targets need a namespace id, which is out of scope here); with
 * Gitea/Forgejo an `owner` creates under that group instead of the personal namespace.
 */
export function repoRequest(
  target: ForgeTarget,
  name: string,
): { url: string; headers: Record<string, string>; body: string } {
  if (target.provider === 'gitlab')
    return {
      'url': `${target.baseUrl}/api/v4/projects`,
      'headers': { 'content-type': 'application/json', 'PRIVATE-TOKEN': target.token },
      'body': JSON.stringify({ 'name': name, 'path': name, 'visibility': target.visibility }),
    };

  const namespaced = target.owner.length > 0 && target.owner !== 'user';
  return {
    'url': `${target.baseUrl}/api/v1/${namespaced ? `orgs/${target.owner}` : 'user'}/repos`,
    'headers': { 'content-type': 'application/json', 'authorization': `token ${target.token}` },
    'body': JSON.stringify({ 'name': name, 'private': target.visibility === 'private', 'auto_init': false }),
  };
}

/** Reads the create response: the two API families name the clone URL differently. */
export function repoFromResponse(payload: unknown): ForgeRepo | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const cloneUrl = record.clone_url ?? record.http_url_to_repo ?? record.cloneUrl;
  const htmlUrl = record.html_url ?? record.web_url ?? cloneUrl;
  if (typeof cloneUrl !== 'string' || cloneUrl.length === 0) return undefined;
  return {
    'name': typeof record.name === 'string' ? record.name : '',
    'cloneUrl': cloneUrl,
    'htmlUrl': typeof htmlUrl === 'string' ? htmlUrl : cloneUrl,
  };
}

/**
 * Turns a clone URL into one that can push without an interactive prompt. Gitea and Forgejo take the token as
 * the username; GitLab wants `oauth2:<token>`. This string is a credential: it is never logged or returned to
 * the model.
 */
export function authedRemote(target: ForgeTarget, cloneUrl: string): string {
  const url = new URL(cloneUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return cloneUrl;
  url.username = target.provider === 'gitlab' ? 'oauth2' : target.token;
  url.password = target.provider === 'gitlab' ? target.token : '';
  return url.toString();
}

/**
 * What the server said when a create failed. Gitea/Forgejo answer `{ message }` (and sometimes `{ errors }`),
 * GitLab answers `{ message }` or `{ error }`; the text is the only way to tell "bad scope" from "no such org"
 * from "it already exists", so it travels back to the caller instead of into a discarded log line.
 */
export function refusalDetail(text: string, status: number): string {
  let detail = text.trim();
  try {
    const parsed = JSON.parse(text) as { message?: unknown; error?: unknown; errors?: unknown };
    const parts = [parsed.message, parsed.error]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .map(part => part.trim());
    if (Array.isArray(parsed.errors))
      for (const entry of parsed.errors) {
        const message =
          typeof entry === 'string'
            ? entry
            : typeof (entry as { message?: unknown })?.message === 'string'
              ? String((entry as { message: string }).message)
              : '';
        if (message.length > 0) parts.push(message);
      }

    if (parts.length > 0) detail = parts.join('; ');
  } catch {
    // not JSON: keep the body as-is, it is all we have
  }
  if (status === 409) return 'a repository with that name already exists — attach it instead of creating it';
  if (status === 404 && detail.length > 0)
    return `${detail} — git.owner must be an organisation the token may create in; leave it empty to create under the token's own user`;
  if (status === 401) return `the token was rejected (${detail.slice(0, 180)})`;
  if (status === 403)
    return `the token is not allowed to create repositories here (${detail.slice(0, 180)}) — it needs write:repository, and its user needs create rights in git.owner`;
  return detail.slice(0, 220) || `HTTP ${status}`;
}

export type CreateOutcome = { ok: true; repo: ForgeRepo } | { ok: false; status: number | 'network'; detail: string };

/** Creates one repository, and says why when the server refuses: the reason is what the asker needs. */
export async function createRepo(guildId: string, name: string): Promise<CreateOutcome> {
  const target = resolveForge(guildId);
  if (!target) {
    logger.warn('repo create requested without a configured git server', { guildId });
    return { 'ok': false, 'status': 'network', 'detail': 'no git server is configured for this server' };
  }
  const request = repoRequest(target, name);
  try {
    const response = await fetch(request.url, {
      'method': 'POST',
      'headers': request.headers,
      'body': request.body,
      'signal': AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    if (!response.ok) {
      const detail = refusalDetail(redact(text, target.token), response.status);
      logger.warn('repo create failed', { guildId, 'status': response.status, detail });
      return { 'ok': false, 'status': response.status, detail };
    }
    const repo = repoFromResponse(JSON.parse(text));
    if (!repo) {
      logger.warn('repo create returned no clone url', { guildId, 'body': redact(text, target.token).slice(0, 200) });
      return { 'ok': false, 'status': response.status, 'detail': 'the server answered without a clone URL' };
    }
    logger.info('repo created', { guildId, 'provider': target.provider, 'repo': repo.name });
    return { 'ok': true, repo };
  } catch (error) {
    const detail = redact(String(error), target.token).slice(0, 200);
    logger.warn('repo create threw', { guildId, 'error': detail });
    return { 'ok': false, 'status': 'network', detail };
  }
}
