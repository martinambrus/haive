import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { logger } from '@haive/shared/logger';
import { KB_DIR } from '@haive/shared/knowledge-paths';
import {
  lstatNoFollow,
  readFileNoFollow,
  removeNoFollow,
  renameNoFollow,
  syncDirectoryNoFollow,
  writeFileNoFollow,
} from '@haive/shared/fs-safe';
import { sanitizeKbRelPath } from './_kb-write.js';

const recoverySchema = z.object({
  version: z.literal(1),
  files: z.array(z.object({ path: z.string(), body: z.string(), entryId: z.string().optional() })),
});
export const KB_REROUTE_JOURNAL_MAX_BYTES = 16 * 1024 * 1024;
const recoveryDir = '.haive/kb-reroute-recovery';

/** Original bytes survive Retry outside the KB/RAG tree. The retained journal is agent-readable.
 * An unreadable journal keeps drafts; an unwritable one also forbids local deletions this run.
 * An entry whose promotion is consumed (activated or archived) is not restored and is pruned;
 * `finish` drops entries whose file exists again and removes an emptied journal. */
export async function restoreKbReroutes(
  repoPath: string,
  taskId: string,
  log: Pick<typeof logger, 'warn'> = logger,
  maxJournalBytes = KB_REROUTE_JOURNAL_MAX_BYTES,
  isConsumed?: (ids: string[]) => Promise<ReadonlySet<string>>,
) {
  const journal = `${recoveryDir}/${createHash('sha256').update(taskId).digest('hex')}.json`;
  let state: z.infer<typeof recoverySchema> = { version: 1, files: [] };
  let canPurgeDrafts = true;
  let canDeleteLocal = true;
  // Only an absent journal or one read and validated whole may be rewritten.
  let journalUsable = false;
  const warn = (err: unknown) => {
    // Neither parser excerpts nor containment errors' paths may carry journal data into logs.
    log.warn(
      { errorClass: err instanceof Error ? err.constructor.name : 'Unknown' },
      'kb: recovery incomplete; keeping promoted drafts and any unjournaled local sources',
    );
  };
  const consumed: string[] = [];
  const asideRel = `${journal}.unusable`;
  let asideCreated = false;
  let saved: Awaited<ReturnType<typeof readFileNoFollow>> | undefined;
  try {
    saved = await readFileNoFollow(repoPath, journal, {
      strict: true,
      maxBytes: maxJournalBytes,
    });
  } catch (err) {
    canPurgeDrafts = false;
    warn(err);
  }
  if (saved !== undefined) {
    try {
      if (saved?.truncated) throw new RangeError('KB recovery journal exceeds its bound');
      const parsed =
        saved === null ? state : recoverySchema.parse(JSON.parse(saved.data.toString('utf8')));
      // Validate everything before restoring anything. Absence returns null, never ENOENT.
      for (const file of parsed.files) {
        const safe = sanitizeKbRelPath(file.path);
        if (!safe.ok || safe.normalized !== file.path)
          throw new Error('Invalid KB re-route recovery path');
      }
      state = parsed;
      journalUsable = true;
    } catch (err) {
      canPurgeDrafts = false;
      warn(err);
      // A content failure is deterministic: set the bytes aside, never overwrite or delete them.
      try {
        await renameNoFollow(repoPath, journal, asideRel, { noReplace: true });
        asideCreated = true;
        journalUsable = true;
      } catch (asideErr) {
        warn(asideErr);
      }
    }
  }
  if (journalUsable) {
    // A set-aside journal may hold the only original bodies, so drafts stay while it exists.
    try {
      if ((await lstatNoFollow(repoPath, asideRel, { strict: true })) !== null) {
        canPurgeDrafts = false;
        if (!asideCreated)
          log.warn(
            { errorClass: 'JournalSetAside' },
            'kb: recovery incomplete; keeping promoted drafts and any unjournaled local sources',
          );
      }
    } catch (err) {
      canPurgeDrafts = false;
      warn(err);
    }
  }
  if (journalUsable && isConsumed) {
    // Journal text is untrusted: only a uuid-shaped id may reach the query, or one planted string
    // would fail the whole lookup. Any other entry restores as before.
    const ids = state.files.flatMap((file) =>
      file.entryId && z.uuid().safeParse(file.entryId).success ? [file.entryId] : [],
    );
    if (ids.length > 0) {
      const gone = await isConsumed(ids);
      state.files = state.files.filter((file) => {
        if (!file.entryId || !gone.has(file.entryId)) return true;
        consumed.push(file.path);
        return false;
      });
    }
  }
  try {
    for (const file of journalUsable ? state.files : []) {
      const rel = `${KB_DIR}/${file.path}`;
      const parent = path.posix.dirname(rel);
      const temp = `${parent}/.${path.posix.basename(rel)}.haive-tmp-${process.pid}-${randomUUID()}`;
      try {
        // Only the complete, fsynced sibling may acquire the final name. Death during write
        // leaves no truncated final file for the next Retry to mistake for a person's edit.
        await writeFileNoFollow(repoPath, temp, file.body, {
          mode: 'create-exclusive',
          createParents: true,
          durable: true,
        });
        await renameNoFollow(repoPath, temp, rel, { noReplace: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        if ((await lstatNoFollow(repoPath, rel, { strict: true }))?.kind !== 'file') throw err;
      } finally {
        await removeNoFollow(repoPath, temp).catch(() => {});
      }
      // Include a previously published restore whose directory sync was interrupted.
      await syncDirectoryNoFollow(repoPath, parent);
    }
  } catch (err) {
    canPurgeDrafts = false;
    warn(err);
  }
  const save = async () => {
    const body = JSON.stringify(state);
    if (Buffer.byteLength(body) > maxJournalBytes)
      throw new RangeError('KB recovery journal exceeds its bound');
    // A generated leaf link may be replaced as a link, never followed. A non-directory
    // parent slot or non-file journal refuses safely and disables local deletion.
    await writeFileNoFollow(repoPath, `${recoveryDir}/.gitignore`, '*\n', {
      createParents: true,
      durable: true,
      replaceLeafLink: true,
    });
    await syncDirectoryNoFollow(repoPath, '.haive');
    await writeFileNoFollow(repoPath, journal, body, {
      createParents: true,
      durable: true,
      replaceLeafLink: true,
    });
    await syncDirectoryNoFollow(repoPath, recoveryDir);
  };
  // Rewrite for this run even with no re-route selected. Retain validated entries after a
  // restore failure: they may still be the only complete original bodies. A journal that
  // could not be read or validated is never overwritten, since a transient failure would
  // otherwise publish empty state and let the next Retry purge drafts it can no longer
  // restore; this run then moves nothing.
  if (!journalUsable) canDeleteLocal = false;
  else {
    try {
      await save();
    } catch (err) {
      canPurgeDrafts = false;
      canDeleteLocal = false;
      warn(err);
    }
  }
  return {
    canPurgeDrafts,
    get canDeleteLocal() {
      return canDeleteLocal;
    },
    async rememberReroute(sourcePath: string, body: string): Promise<boolean> {
      if (!canDeleteLocal) return false;
      const safe = sanitizeKbRelPath(sourcePath);
      if (!safe.ok || safe.normalized !== sourcePath)
        throw new Error('Invalid KB re-route source path');
      const prior = state.files.find((file) => file.path === sourcePath);
      if (prior) {
        prior.body = body;
        delete prior.entryId;
      } else state.files.push({ path: sourcePath, body });
      try {
        await save();
        return true;
      } catch (err) {
        canDeleteLocal = false;
        warn(err);
        return false;
      }
    },
    consumed,
    async confirmReroute(sourcePath: string, entryId: string): Promise<void> {
      const entry = state.files.find((file) => file.path === sourcePath);
      if (!entry) return;
      entry.entryId = entryId;
      try {
        await save();
      } catch (err) {
        warn(err);
      }
    },
    async finish(): Promise<void> {
      if (!journalUsable || !canDeleteLocal) return;
      try {
        const keep: typeof state.files = [];
        for (const file of state.files) {
          // The body is redundant only while the very same article is on disk. A lenient read folds
          // a refusal (a link or directory at the path) into null, which keeps the entry.
          const here = await readFileNoFollow(repoPath, `${KB_DIR}/${file.path}`, {
            maxBytes: Buffer.byteLength(file.body) + 1,
          });
          if (here === null || here.truncated || here.data.toString('utf8') !== file.body)
            keep.push(file);
        }
        if (keep.length === state.files.length && keep.length > 0) return;
        if (keep.length > 0) {
          state.files = keep;
          await save();
        } else await removeNoFollow(repoPath, journal);
      } catch (err) {
        warn(err);
      }
    },
  };
}
