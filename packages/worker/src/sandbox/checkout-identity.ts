import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { lstatNoFollow } from '@haive/shared/fs-safe';
import { RunnerProbeError } from './runner-probe.js';

const exec = promisify(execFile);

export const CHECKOUT_IDENTITY_LABEL = 'haive.checkout.identity';

/** Root identity, independent of a subpath label and preserved in Docker across worker death.
 * No floating-point inode conversion; missing/unreadable roots refuse admission. */
export async function checkoutIdentity(subpath: string): Promise<string> {
  const [user, repo] = subpath.split('/');
  if (!user || !repo || !/^[a-zA-Z0-9_-]+$/.test(user) || !/^[a-zA-Z0-9_-]+$/.test(repo))
    throw new Error('Invalid checkout subpath');
  const anchor = path.join(process.env.REPO_STORAGE_ROOT ?? '/var/lib/haive/repos', user, repo);
  const entry = await lstatNoFollow(anchor, '', { strict: true, bigint: true });
  if (!entry || entry.kind !== 'directory') throw new Error('Checkout identity unavailable');
  return `${entry.stats.dev}:${entry.stats.ino}`;
}

function inode(identity: string): string | undefined {
  return /^(\d+):(\d+)$/.exec(identity)?.[2];
}

/** Legacy containers are kept. Only a different stamped inode proves replacement;
 * device numbers can change on remount. Scratch has no repository replacement lifecycle. */
export async function checkoutMountMatches(
  subpath: string,
  mounted: string | null | undefined,
  current?: string,
): Promise<boolean> {
  if (subpath.split('/')[1] === '_scratch' || !mounted || mounted === '<no value>') return true;
  const identity = current ?? (await checkoutIdentity(subpath));
  return inode(mounted) === inode(identity);
}

/** An unreadable Docker label proves no replacement. App/Editor keep their runner;
 * DDEV uses its existing typed, retryable unknown-probe policy. */
export async function runnerCheckoutMatches(
  container: string,
  subpath: string,
  options: { identity?: string; onUnknown?: 'keep' | 'retry' } = {},
): Promise<boolean> {
  let mounted: string;
  try {
    const { stdout } = await exec(
      'docker',
      ['inspect', '-f', `{{index .Config.Labels "${CHECKOUT_IDENTITY_LABEL}"}}`, container],
      { timeout: 15_000 },
    );
    mounted = stdout.trim();
  } catch (cause) {
    if (options.onUnknown === 'retry') throw new RunnerProbeError(container, cause);
    return true;
  }
  return checkoutMountMatches(subpath, mounted, options.identity);
}
