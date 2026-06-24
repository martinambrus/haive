import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Database } from '@haive/database';
import { getDecryptedCredentials } from './credentials.js';

const exec = promisify(execFile);

export interface GitRunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run a git command, capturing stdout/stderr/exit code instead of throwing. The
 *  identical helper was inlined in several steps (11a-gate-4-push, 12-worktree-cleanup);
 *  centralised here. `env` merges over process.env when provided. */
export async function gitRun(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<GitRunResult> {
  try {
    const opts = env ? { cwd, env: { ...process.env, ...env } } : { cwd };
    const { stdout, stderr } = await exec('git', args, opts);
    return { stdout: stdout.toString(), stderr: stderr.toString(), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: (e.stdout ?? '').toString(),
      stderr: (e.stderr ?? '').toString(),
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

/** Replace every occurrence of the secret in command output before it is logged
 *  or surfaced to the user. Defensive: git masks credential-helper passwords in
 *  most errors, but a misconfigured remote can echo them. */
export function scrubSecret(text: string, secret: string | null): string {
  if (!secret) return text;
  return text.split(secret).join('***');
}

/** True when the repo at cwd has an `origin` remote. */
export async function detectOrigin(cwd: string): Promise<boolean> {
  const res = await gitRun(cwd, ['remote']);
  return (
    res.code === 0 &&
    res.stdout
      .split('\n')
      .map((l) => l.trim())
      .includes('origin')
  );
}

/** The origin remote URL, or null when there is no origin / the command fails. */
export async function getOriginUrl(cwd: string): Promise<string | null> {
  const res = await gitRun(cwd, ['remote', 'get-url', 'origin']);
  return res.code === 0 ? res.stdout.trim() : null;
}

/** Add `origin` pointing at url, or set-url when it already exists. Idempotent.
 *  Does NOT persist to the repositories row — that stays in the caller. */
export async function ensureOrigin(
  cwd: string,
  url: string,
): Promise<{ added: boolean; updated: boolean }> {
  const add = await gitRun(cwd, ['remote', 'add', 'origin', url]);
  if (add.code === 0) return { added: true, updated: false };
  if (/remote origin already exists/i.test(add.stderr)) {
    await gitRun(cwd, ['remote', 'set-url', 'origin', url]);
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
 *  credentialId means no helper (SSH / public / manual). */
export async function pushBranch(args: {
  cwd: string;
  branch: string;
  setUpstream: boolean;
  credentialId?: string;
  db: Database;
  userId: string;
}): Promise<{ pushed: true; remote: 'origin'; branch: string }> {
  const { cwd, branch, setUpstream, credentialId, db, userId } = args;
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
  if (setUpstream) pushArgs.push('-u');
  pushArgs.push('origin', branch);

  const res = await gitRun(cwd, pushArgs, env);
  if (res.code !== 0) {
    throw new Error(`git push failed: ${scrubSecret(res.stderr || res.stdout, secret)}`);
  }
  return { pushed: true, remote: 'origin', branch };
}
