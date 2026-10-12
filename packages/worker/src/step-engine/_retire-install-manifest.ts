import { removeFileIfNoFollow } from '@haive/shared/fs-safe';
import type { StepContext } from './step-definition.js';

export const INSTALL_MANIFEST_PATH = '.haive/install.json';

const INSTALL_MANIFEST_READ_CAP = 8 * 1024 * 1024;

function isHaiveInstallManifest(data: Buffer): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString('utf8'));
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  const doc = parsed as Record<string, unknown>;
  return (
    doc.schemaVersion === 1 &&
    typeof doc.templateSetHash === 'string' &&
    Array.isArray(doc.templates)
  );
}

/** Delete `.haive/install.json` while it still has the shape Haive wrote it in: nothing reads it, and
 *  the project state record carries what it held. Any other file at that name is the person's. Never
 *  throws; a file it could not judge is reported as kept. */
export async function retireInstallManifest(
  ctx: Pick<StepContext, 'repoPath' | 'logger'>,
  warnings: string[],
): Promise<'removed' | 'absent' | 'kept'> {
  let outcome: 'removed' | 'absent' | 'kept';
  let reason = 'it is not a Haive install manifest';
  try {
    outcome = await removeFileIfNoFollow(
      ctx.repoPath,
      INSTALL_MANIFEST_PATH,
      isHaiveInstallManifest,
      { maxBytes: INSTALL_MANIFEST_READ_CAP },
    );
  } catch (err) {
    outcome = 'kept';
    reason = err instanceof Error ? err.message : String(err);
  }
  if (outcome === 'kept') {
    warnings.push(`${INSTALL_MANIFEST_PATH} was left in place: ${reason}`);
    ctx.logger.warn({ path: INSTALL_MANIFEST_PATH, reason }, 'install manifest kept');
  }
  return outcome;
}
