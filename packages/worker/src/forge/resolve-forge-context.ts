import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import type { ForgeProviderName } from '@haive/shared';
import { getDecryptedCredentials } from '../repo/credentials.js';
import {
  ForgeError,
  credentialForgeProvider,
  resolveForgeProvider,
  type ForgeContext,
} from '@haive/shared/forge';

/** Host portion of a git remote (https, ssh:// or scp-style), provider-independent —
 *  used to infer the forge for a well-known public host before the provider is known. */
export function hostFromRemote(remoteUrl: string): string {
  const trimmed = remoteUrl.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).host;
    } catch {
      return '';
    }
  }
  return trimmed.match(/^(?:[^@]+@)?([^:/]+):/)?.[1] ?? '';
}

/** Parse a git remote URL (https, ssh:// or scp-style git@host:owner/repo) into
 *  { host, owner, repo }. owner is everything between the host and the final path
 *  segment, so a GitLab subgroup path (group/subgroup/project) resolves to
 *  owner=group/subgroup, repo=project. Bitbucket Server clone URLs put the repo under
 *  /scm/{projectKey}/{slug}.git — the /scm prefix is stripped so owner=projectKey. */
export function parseRemote(
  remoteUrl: string,
  provider: ForgeProviderName,
): { host: string; owner: string; repo: string } {
  const trimmed = remoteUrl.trim();
  let host: string;
  let rawPath: string;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let u: URL;
    try {
      u = new URL(trimmed);
    } catch {
      throw new ForgeError(`Cannot parse remote URL: ${remoteUrl}`);
    }
    host = u.host;
    rawPath = u.pathname;
  } else {
    // scp-like: [user@]host:owner/repo(.git)
    const m = trimmed.match(/^(?:[^@]+@)?([^:/]+):(.+)$/);
    if (!m || !m[1] || !m[2]) throw new ForgeError(`Cannot parse remote URL: ${remoteUrl}`);
    host = m[1];
    rawPath = `/${m[2]}`;
  }

  let segments = rawPath
    .replace(/^\/+/, '')
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean);

  if (provider === 'bitbucket_server' && segments[0] === 'scm') {
    segments = segments.slice(1);
  }

  const repo = segments[segments.length - 1];
  const ownerSegments = segments.slice(0, -1);
  if (!repo || ownerSegments.length === 0) {
    throw new ForgeError(`Remote URL has no owner/repo path: ${remoteUrl}`);
  }
  const owner = ownerSegments.join('/');
  return { host, owner, repo };
}

/** Build a ForgeContext for a repo's PR/MR call: resolve the credential's forge
 *  provider + optional API-base override, parse the remote URL, and decrypt the
 *  token. Throws a ForgeError (surfaced to the user) when the credential has no
 *  provider set — a hostname alone can't reveal the forge software. */
export async function resolveForgeContext(args: {
  db: Database;
  userId: string;
  credentialId: string;
  remoteUrl: string;
}): Promise<ForgeContext> {
  const { db, userId, credentialId, remoteUrl } = args;

  const row = await db.query.repoCredentials.findFirst({
    where: and(
      eq(schema.repoCredentials.id, credentialId),
      eq(schema.repoCredentials.userId, userId),
    ),
    columns: { provider: true, apiBaseUrl: true },
  });
  if (!row) throw new ForgeError('Credential not found for pull-request creation.');

  // Explicit credential provider wins; for a well-known public host fall back to inferring
  // from the remote host so the "auto-detect" default works without a manual pick.
  const provider = credentialForgeProvider(row.provider, hostFromRemote(remoteUrl));
  if (!provider) {
    throw new ForgeError(
      'This credential has no forge provider set, and the host is not a known public forge. Choose a provider (GitHub, Gitea/Forgejo, GitLab, Bitbucket) on the credential to open pull requests.',
    );
  }

  const creds = await getDecryptedCredentials(db, credentialId, userId);
  const { host, owner, repo } = parseRemote(remoteUrl, provider);
  const impl = resolveForgeProvider(provider);
  const apiBase = (row.apiBaseUrl?.trim() || impl.defaultApiBase(host)).replace(/\/+$/, '');
  if (!apiBase) {
    throw new ForgeError(
      `Could not determine a REST API base URL for ${provider} on ${host}. Set an API base override on the credential.`,
    );
  }

  return { provider, apiBase, host, owner, repo, token: creds.secret, username: creds.username };
}
