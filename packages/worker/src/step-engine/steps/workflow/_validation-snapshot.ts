import { createHash } from 'node:crypto';
import { lstatNoFollow, readFileNoFollow, readLinkNoFollow } from '@haive/shared/fs-safe';
import { TaskCancelledError } from '@haive/shared/step';
import {
  FINGERPRINT_READ_BYTES,
  readChangedFiles,
} from '../../../orchestrator/house-rules-dispatch.js';
import { nestedRepositoryHead } from '../../../repo/nested-repository.js';
import { workspaceAnchor } from '../../../repo/worktree-paths.js';
import type { StepContext } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';

/** Per-path content/type/executable-bit stamps of the final Git deliverables. Unlike HEAD alone,
 * this covers dirty single-agent work, committed DAG work, untracked tests and deletions.
 * Paths absent from one snapshot count too, including a change reverted to its original bytes.
 * Ignored runtime artifacts are not deliverables. No file bytes are persisted. */
export type ValidationSnapshot = Record<string, string>;

/** Fixed-size equality evidence. Each per-path stamp already binds content, kind and mode. */
export function validationSnapshotDigest(snapshot: ValidationSnapshot | null): {
  sha256: string | null;
  incomplete: boolean;
} {
  if (snapshot === null) return { sha256: null, incomplete: true };
  const pairs = Object.keys(snapshot)
    .sort()
    .map((path) => [path, snapshot[path]]);
  return {
    sha256: createHash('sha256').update(JSON.stringify(pairs)).digest('hex'),
    incomplete: false,
  };
}

type SnapshotContext = Pick<StepContext, 'db' | 'taskId'> &
  Partial<Pick<StepContext, 'throwIfCancelled'>>;

export async function readValidationSnapshot(
  ctx: SnapshotContext,
  options: { requireComplete?: boolean; maxFileBytes?: number } = {},
): Promise<ValidationSnapshot | null> {
  // Retry the complete bounded read once: a transient Git/FS failure proves no equality.
  for (let attempt = 0; attempt < 2; attempt++) {
    ctx.throwIfCancelled?.();
    const snapshot = await readValidationSnapshotOnce(ctx, options);
    if (snapshot !== null) return snapshot;
  }
  return null;
}

async function readValidationSnapshotOnce(
  ctx: SnapshotContext,
  options: { requireComplete?: boolean; maxFileBytes?: number },
): Promise<ValidationSnapshot | null> {
  try {
    const setup = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
    const made = setup?.output as { worktreePath?: string; baseBranch?: string } | null;
    if (!made?.worktreePath) return null;
    const files = await readChangedFiles(
      made.worktreePath,
      made.baseBranch ?? null,
      undefined,
      options.requireComplete ? { ignoreSubmodules: 'none' } : undefined,
    );
    if (files === null) return null;
    const { anchor, prefix } = workspaceAnchor(made.worktreePath);
    const snapshot: ValidationSnapshot = Object.create(null);
    for (const file of files) {
      ctx.throwIfCancelled?.();
      const rel = `${prefix}${file.replace(/\/$/, '')}`;
      const entry = await lstatNoFollow(anchor, rel, { strict: true });
      const hash = createHash('sha256');
      hash.update(JSON.stringify([entry?.kind ?? 'absent', (entry?.stats.mode ?? 0) & 0o111]));
      if (entry?.kind === 'file') {
        const read = await readFileNoFollow(anchor, rel, {
          maxBytes: options.maxFileBytes ?? FINGERPRINT_READ_BYTES,
          strict: true,
        });
        if (read === null || (options.requireComplete && read.truncated)) return null;
        // Same bound as changeFingerprint: size plus prefix permits large deliverables.
        hash.update(JSON.stringify(read.size));
        hash.update(read.data);
      } else if (entry?.kind === 'symlink') {
        const target = await readLinkNoFollow(anchor, rel, { strict: true });
        if (target === null) return null;
        hash.update(target);
      } else if (entry?.kind === 'directory') {
        // A nested checkout's HEAD does not prove its files are unchanged.
        if (options.requireComplete) return null;
        const nested = await nestedRepositoryHead(made.worktreePath, file.replace(/\/$/, ''));
        if (nested === null) return null;
        hash.update(JSON.stringify(nested));
      } else if (entry !== null) {
        return null;
      }
      snapshot[file] = hash.digest('hex');
    }
    return snapshot;
  } catch (err) {
    if (err instanceof TaskCancelledError) throw err;
    // A failed read cannot establish equality; the routing boundary refuses it.
    return null;
  }
}

export function affectedValidationFiles(
  before: ValidationSnapshot | null | undefined,
  after: ValidationSnapshot,
): string[] {
  return [...new Set([...Object.keys(before ?? {}), ...Object.keys(after)])]
    .filter((file) => before?.[file] !== after[file])
    .sort();
}
