import { tryCliAuthLock, type Database } from '@haive/database';
import { cliAuthScope, type CliAuthProvider } from '@haive/shared/cli-auth-state';
import { CLAUDE_USAGE_OAUTH_SECRET } from '@haive/shared/claude-oauth';
import { HttpError } from '../context.js';

export function isSignOutSecret(name: string): boolean {
  return name === 'CLAUDE_CODE_OAUTH_TOKEN' || name === CLAUDE_USAGE_OAUTH_SECRET;
}

/** Acquire before opening a transaction or consuming a one-use authorization. */
export async function withCliAuthWrite<T>(
  db: Database,
  provider: CliAuthProvider,
  names: string[],
  write: () => Promise<T>,
): Promise<T> {
  if (!names.some(isSignOutSecret)) return write();
  return withCliAuthLocks(db, [provider], write);
}

/** Lock both sides of a settings change before opening its transaction. */
export async function withCliAuthLocks<T>(
  db: Database,
  providers: CliAuthProvider[],
  write: () => Promise<T>,
): Promise<T> {
  const releases: (() => Promise<void>)[] = [];
  try {
    for (const scope of [...new Set(providers.map(cliAuthScope))].sort()) {
      const release = await tryCliAuthLock(db, scope);
      if (!release) {
        throw new HttpError(
          409,
          'CLI authentication is busy. Finish the current sign-in or credential update and try again.',
          'cli_auth_busy',
        );
      }
      releases.push(release);
    }
    return await write();
  } finally {
    await Promise.all(releases.map((release) => release()));
  }
}
