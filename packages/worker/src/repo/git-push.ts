import { isAllowedGitRemoteUrl } from '@haive/shared/schemas';
import type { Database } from '@haive/database';
import { getDecryptedCredentials } from './credentials.js';
import { GIT_MAX_BUFFER, type GitRunResult, gitRun } from './git-exec.js';

// Re-exported because the step modules and the merge core import them from here.
export { GIT_MAX_BUFFER, gitRun };
export type { GitRunResult };

/** Replace every occurrence of the secret in command output before it is logged
 *  or surfaced to the user. Defensive: git masks credential-helper passwords in
 *  most errors, but a misconfigured remote can echo them. */
export function scrubSecret(text: string, secret: string | null): string {
  if (!secret) return text;
  return text.split(secret).join('***');
}

/** True when the repo at cwd has an `origin` remote; throws when git could not say (see getOriginUrl). */
export async function detectOrigin(cwd: string): Promise<boolean> {
  return (await getOriginUrl(cwd)) !== null;
}

/** An origin address refused by the same rule as a typed remote URL. */
export class OriginUrlError extends Error {
  constructor(url: string) {
    const safe = url.replace(/(\/\/)[^/]*@/g, '$1').replace(/^[^/@]+@(?=[^/]*:)/, '');
    super(`origin URL is not allowed (expected https, http, ssh or an scp-style address): ${safe}`);
    this.name = 'OriginUrlError';
  }
}

/** Read every effective fetch and push URL (including git's insteadOf rewrites). Exit 2 alone
 *  means no origin; a failed read is unknown, and an unsafe address fails the caller. */
export async function getOriginUrl(cwd: string): Promise<string | null> {
  let first: string | undefined;
  for (const push of [false, true]) {
    const res = await gitRun(cwd, [
      'remote',
      'get-url',
      ...(push ? ['--push'] : []),
      '--all',
      'origin',
    ]);
    if (!push && res.code === 2) return null;
    if (res.code !== 0) {
      const output = (res.stderr || res.stdout).trim().slice(0, 500);
      throw new Error(`git remote get-url origin failed in ${cwd}: ${output}`);
    }
    const urls = res.stdout.trim().split('\n');
    for (const url of urls) {
      if (!isAllowedGitRemoteUrl(url)) throw new OriginUrlError(url);
    }
    first ??= urls[0];
  }
  return first!;
}

/** Origin transports always re-read the checkout immediately before git talks to the remote. */
export async function originGitRun(...args: Parameters<typeof gitRun>): Promise<GitRunResult> {
  await getOriginUrl(args[0]);
  return gitRun(...args);
}

/** Add `origin` pointing at url, or set-url when it already exists. Idempotent.
 *  Does NOT persist to the repositories row — that stays in the caller. */
export async function ensureOrigin(
  cwd: string,
  url: string,
): Promise<{ added: boolean; updated: boolean }> {
  const add = await gitRun(cwd, ['remote', 'add', 'origin', url]);
  if (add.code === 0) return { added: true, updated: false };
  if (add.code === 3) {
    const updated = await gitRun(cwd, ['remote', 'set-url', 'origin', url]);
    if (updated.code !== 0) {
      throw new Error(`git remote set-url origin failed: ${updated.stderr || updated.stdout}`);
    }
    return { added: false, updated: true };
  }
  throw new Error(`git remote add origin failed: ${add.stderr || add.stdout}`);
}

/** Build the one-shot inline credential-helper argv + env from a decrypted
 *  credential. The token rides in env (not argv, not .git/config), so it never
 *  persists and isn't visible via `ps`. The leading empty `credential.helper=`
 *  clears any inherited global helper. */
export async function buildCredentialHelper(
  db: Database,
  credentialId: string,
  userId: string,
): Promise<{ argv: string[]; env: Record<string, string>; secret: string }> {
  const creds = await getDecryptedCredentials(db, credentialId, userId);
  const env: Record<string, string> = {
    GIT_HAIVE_USER: creds.username,
    GIT_HAIVE_PASS: creds.secret,
  };
  const argv = [
    '-c',
    'credential.helper=',
    '-c',
    `credential.helper=!f() { test "$1" = get && printf 'username=%s\\npassword=%s\\n' "$GIT_HAIVE_USER" "$GIT_HAIVE_PASS"; }; f`,
  ];
  return { argv, env, secret: creds.secret };
}

/** Push `branch` to origin, optionally with a stored credential and upstream.
 *  Throws with a scrubbed message on non-zero exit. An empty/undefined
 *  credentialId means no helper (SSH / public / manual). With `sha` it pushes that commit to the
 *  branch, whatever the local ref has moved to since. A failed upstream setup after a successful
 *  push is reported as `upstreamError`, not thrown. */
export async function pushBranch(args: {
  cwd: string;
  branch: string;
  sha?: string;
  setUpstream: boolean;
  credentialId?: string;
  db: Database;
  userId: string;
}): Promise<{ pushed: true; remote: 'origin'; branch: string; upstreamError?: string }> {
  const { cwd, branch, sha, setUpstream, credentialId, db, userId } = args;
  const pushArgs: string[] = [];
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  let secret: string | null = null;

  if (credentialId) {
    const helper = await buildCredentialHelper(db, credentialId, userId);
    secret = helper.secret;
    Object.assign(env, helper.env);
    pushArgs.push(...helper.argv);
  }

  pushArgs.push('push');
  if (setUpstream && !sha) pushArgs.push('-u');
  pushArgs.push('origin', sha ? `${sha}:refs/heads/${branch}` : branch);

  const res = await originGitRun(cwd, pushArgs, env);
  if (res.code !== 0) {
    throw new Error(`git push failed: ${scrubSecret(res.stderr || res.stdout, secret)}`);
  }
  // `-u` sets nothing for a commit that is not a branch name.
  if (setUpstream && sha) {
    const tracking = await gitRun(cwd, ['branch', `--set-upstream-to=origin/${branch}`, branch]);
    if (tracking.code !== 0) {
      return {
        pushed: true,
        remote: 'origin',
        branch,
        upstreamError: scrubSecret(tracking.stderr || tracking.stdout, secret).trim(),
      };
    }
  }
  return { pushed: true, remote: 'origin', branch };
}
