import { config } from '@services/config.ts';
import { GIT_BASE_URL, GIT_OWNER, GIT_TOKEN } from '@utils/env.ts';
import { log } from '@utils/logger.ts';

const logger = log('git/forge');

export type ForgeProvider = 'gitea' | 'forgejo' | 'gitlab';

/** Everything needed to talk to a hosted git server. The token only ever comes from `.env`. */
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
 * The guild's git settings resolved against the deployment's credentials. `undefined` means "not configured",
 * and every caller treats that as "the feature is off" rather than as an error.
 */
export function resolveForge(guildId: string): ForgeTarget | undefined {
  const git = config.git(guildId);
  const baseUrl = (git.baseUrl.length > 0 ? git.baseUrl : (GIT_BASE_URL ?? '')).replace(/\/+$/, '');
  const token = GIT_TOKEN ?? '';
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

/** Creates one repository. Returns `undefined` when the server refuses or the guild has it switched off. */
export async function createRepo(guildId: string, name: string): Promise<ForgeRepo | undefined> {
  const target = resolveForge(guildId);
  if (!target) {
    logger.warn('repo create requested without a configured git server', { guildId });
    return undefined;
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
      logger.warn('repo create failed', {
        guildId,
        'status': response.status,
        'body': redact(text, target.token).slice(0, 200),
      });
      return undefined;
    }
    const repo = repoFromResponse(JSON.parse(text));
    if (!repo) {
      logger.warn('repo create returned no clone url', { guildId, 'body': redact(text, target.token).slice(0, 200) });
      return undefined;
    }
    logger.info('repo created', { guildId, 'provider': target.provider, 'repo': repo.name });
    return repo;
  } catch (error) {
    logger.warn('repo create threw', { guildId, 'error': redact(String(error), target.token).slice(0, 200) });
    return undefined;
  }
}
