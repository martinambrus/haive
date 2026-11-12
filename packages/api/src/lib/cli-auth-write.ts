import { eq } from 'drizzle-orm';
import { schema, tryCliAuthLock, type CliAuthLock, type Database } from '@haive/database';
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
  write: (assertHeld: () => Promise<void>) => Promise<T>,
): Promise<T> {
  if (!names.some(isSignOutSecret)) return write(async () => {});
  return withCliAuthLocks(db, [provider], async (assertHeld) => {
    // A settings change may have committed between the caller's read and the lock: the lock
    // held is then not the row's scope, so refuse rather than write under the wrong one.
    const current = await db.query.cliProviders.findFirst({
      where: eq(schema.cliProviders.id, provider.id),
      columns: { id: true, userId: true, name: true, authMode: true, isolateAuth: true },
    });
    if (!current || cliAuthScope(current) !== cliAuthScope(provider)) {
      throw new HttpError(
        409,
        'CLI authentication settings changed. Reload and try again.',
        'cli_auth_busy',
      );
    }
    return write(assertHeld);
  });
}

/** Lock both sides of a settings change before opening its transaction. */
export async function withCliAuthLocks<T>(
  db: Database,
  providers: CliAuthProvider[],
  write: (assertHeld: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const releases: CliAuthLock[] = [];
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
    return await write(async () => {
      for (const release of releases) {
        try {
          await release.assertHeld();
        } catch {
          throw new HttpError(
            409,
            'CLI authentication changed. Retry the operation.',
            'cli_auth_busy',
          );
        }
      }
    });
  } finally {
    await Promise.all(releases.map((release) => release()));
  }
}
