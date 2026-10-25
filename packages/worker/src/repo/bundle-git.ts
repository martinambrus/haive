import { schema, type Database } from '@haive/database';
import { eq } from 'drizzle-orm';
import { redactGitUrl } from '@haive/shared/schemas';
import { boundQueryError, safeErrorMessage } from '@haive/shared/logger';
import { assertCloneUrl } from './clone.js';
import { buildCredentialHelper, ensureOrigin, scrubSecret } from './git-push.js';

export type BundleGitBinding = Pick<
  typeof schema.customBundles.$inferSelect,
  'id' | 'userId' | 'gitUrl' | 'gitCredentialsId' | 'storageRoot'
>;

/** Every resync replaces the old credentialed origin before transport, including the daily
 *  tick and upgrade detection. Auth is loaded afresh, so rotated tokens work on the next sync. */
export async function bundleGitAuth(
  db: Database,
  bundle: BundleGitBinding,
): Promise<{ argv: string[]; env: Record<string, string>; secret: string | null }> {
  if (!bundle.gitUrl) throw new Error('git-source bundle missing gitUrl');
  assertCloneUrl(bundle.gitUrl, 'bundle');
  const clean = redactGitUrl(bundle.gitUrl, true);
  const auth = bundle.gitCredentialsId
    ? await buildCredentialHelper(db, bundle.gitCredentialsId, bundle.userId, clean)
    : undefined;
  try {
    await ensureOrigin(bundle.storageRoot, clean);
    if (clean !== bundle.gitUrl) {
      await db
        .update(schema.customBundles)
        .set({ gitUrl: clean, updatedAt: new Date() })
        .where(eq(schema.customBundles.id, bundle.id));
    }
    return {
      argv: auth?.argv ?? [],
      env: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', ...(auth?.env ?? {}) },
      secret: auth?.secret ?? null,
    };
  } catch (err) {
    // The legacy-URL write can fail after Git succeeds. Keep bound structure for
    // the caller's safe persistence/logging, without scrubbing the fixed DB text.
    if (boundQueryError(err)) throw err;
    // Ordinary failures keep the existing scrub and no raw cause: a cause could
    // put the credential back into diagnostics after its message was cleaned.
    throw new Error(scrubSecret(safeErrorMessage(err), auth?.secret ?? null));
  }
}
