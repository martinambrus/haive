import { createHash } from 'node:crypto';
import { z } from 'zod';
import { KB_DIR } from '@haive/shared/knowledge-paths';
import {
  lstatNoFollow,
  readTextNoFollow,
  syncDirectoryNoFollow,
  writeFileNoFollow,
} from '@haive/shared/fs-safe';
import { sanitizeKbRelPath } from './_kb-write.js';

const recoverySchema = z.object({
  version: z.literal(1),
  files: z.array(z.object({ path: z.string(), body: z.string() })),
});

/** Original bytes, before global scrubbing, survive an uncommitted onboarding and any Retry.
 * Keep this task's journal even after success: a lost done write or explicit Retry still needs it.
 * It is outside the KB/RAG tree and is never passed to an agent as a staged body. */
export async function restoreKbReroutes(repoPath: string, taskId: string) {
  const journal = `.haive/kb-reroute-recovery/${createHash('sha256').update(taskId).digest('hex')}.json`;
  let saved: string | null;
  try {
    saved = await readTextNoFollow(repoPath, journal, { strict: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    saved = null;
  }
  const state: z.infer<typeof recoverySchema> =
    saved === null ? { version: 1 as const, files: [] } : recoverySchema.parse(JSON.parse(saved));
  // Validate the entire journal before restoring anything or authorizing draft deletion.
  for (const file of state.files) {
    const safe = sanitizeKbRelPath(file.path);
    if (!safe.ok || safe.normalized !== file.path)
      throw new Error('Invalid KB re-route recovery path');
  }
  for (const file of state.files) {
    const rel = `${KB_DIR}/${file.path}`;
    try {
      await writeFileNoFollow(repoPath, rel, file.body, {
        mode: 'create-exclusive',
        createParents: true,
        durable: true,
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Preserve a person's newer local copy, but never purge drafts on an assumed absence.
      if ((await lstatNoFollow(repoPath, rel, { strict: true }))?.kind !== 'file') throw err;
    }
  }
  return async (sourcePath: string, body: string): Promise<void> => {
    const safe = sanitizeKbRelPath(sourcePath);
    if (!safe.ok || safe.normalized !== sourcePath)
      throw new Error('Invalid KB re-route source path');
    const prior = state.files.find((file) => file.path === sourcePath);
    if (prior) prior.body = body;
    else state.files.push({ path: sourcePath, body });
    // An onboarding that initializes Git stages the whole tree. Ignore the recovery copy,
    // including this ignore file itself, before publishing any original article body here.
    await writeFileNoFollow(repoPath, '.haive/kb-reroute-recovery/.gitignore', '*\n', {
      createParents: true,
      durable: true,
    });
    await writeFileNoFollow(repoPath, journal, JSON.stringify(state), {
      createParents: true,
      durable: true,
    });
    await syncDirectoryNoFollow(repoPath, '.haive/kb-reroute-recovery');
  };
}
