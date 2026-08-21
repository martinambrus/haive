import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { StepContext } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';

/** Where the approved spec is materialized, relative to the worktree root. Under
 *  `.haive/` because 01-worktree-setup git-excludes that dir, so the artifact never
 *  reaches a commit. A cli-exec invocation mounts the worktree ALONE at the sandbox
 *  workdir, so inside the sandbox this is `<sandboxWorkdir>/<SPEC_ARTIFACT_RELPATH>`. */
export const SPEC_ARTIFACT_RELPATH = '.haive/spec.md';

/** The spec the run is implementing, in the order later steps must honor: the
 *  post-checkpoint body (05a user/agent fixes), then 05's amended body, then the 04
 *  draft. Returns '' when no spec step ran (lightweight paths skip 03/04/05).
 *
 *  Lifted from the copy that was duplicated verbatim across 07, 06b, 08c, 08e and the
 *  other spec consumers — they now all read through here. */
export async function resolveApprovedSpec(ctx: StepContext): Promise<string> {
  const [plan, quality, resolved] = await Promise.all([
    loadPreviousStepOutput(ctx.db, ctx.taskId, '04-phase-0b-pre-planning'),
    loadPreviousStepOutput(ctx.db, ctx.taskId, '05-phase-0b5-spec-quality'),
    loadPreviousStepOutput(ctx.db, ctx.taskId, '05a-resolve-spec-warnings'),
  ]);
  return (
    ((resolved?.output as { spec?: string } | null)?.spec ??
      (quality?.output as { spec?: string } | null)?.spec ??
      (plan?.output as { spec?: string } | null)?.spec) ||
    ''
  );
}

/** The task worktree on the WORKER filesystem, from 01-worktree-setup's output. Null
 *  when that step has not run or produced no worktree (onboarding, read-only local
 *  repos). Deliberately not ctx.repoPath: a cli-exec invocation mounts the worktree
 *  alone, so an artifact written at the repo root is invisible to the agent. */
export async function resolveTaskWorktreePath(ctx: StepContext): Promise<string | null> {
  const worktree = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
  const p = (worktree?.output as { worktreePath?: string } | null)?.worktreePath;
  return typeof p === 'string' && p.length > 0 ? p : null;
}

/** Write the spec to `<worktreePath>/.haive/spec.md`. Idempotent (plain overwrite, so a
 *  gate-1 re-approval after a re-draft refreshes it). Returns the relative path. */
export async function writeSpecArtifact(worktreePath: string, spec: string): Promise<string> {
  const abs = join(worktreePath, SPEC_ARTIFACT_RELPATH);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, spec, 'utf8');
  return SPEC_ARTIFACT_RELPATH;
}
