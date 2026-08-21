import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { CONFIG_KEYS, configService, SPEC_VIEW_MODES, type SpecViewMode } from '@haive/shared';
import type { StepContext } from '../../step-definition.js';
import { condenseDocument } from '../_doc-view.js';
import { loadPreviousStepOutput, pathExists } from '../onboarding/_helpers.js';

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

/** The task worktree on the WORKER filesystem. Null when the task has no worktree
 *  (onboarding, read-only local repos).
 *
 *  Read from `tasks.worktree_path`, which 01-worktree-setup stamps alongside
 *  `worktree_branch` — the same durable source `resolveInvocationRepoMount` trusts, and
 *  for the same reason: it survives a Retry that nulls the 01 step output.
 *
 *  Deliberately not ctx.repoPath: a cli-exec invocation mounts the worktree ALONE at the
 *  sandbox workdir, so an artifact written at the repo root is invisible to the agent. */
export async function resolveTaskWorktreePath(ctx: StepContext): Promise<string | null> {
  const task = await ctx.db.query.tasks.findFirst({
    where: eq(schema.tasks.id, ctx.taskId),
    columns: { worktreePath: true },
  });
  return task?.worktreePath && task.worktreePath.length > 0 ? task.worktreePath : null;
}

/** Write the spec to `<worktreePath>/.haive/spec.md`. Idempotent (plain overwrite, so a
 *  gate-1 re-approval after a re-draft refreshes it). Returns the relative path. */
export async function writeSpecArtifact(worktreePath: string, spec: string): Promise<string> {
  const abs = join(worktreePath, SPEC_ARTIFACT_RELPATH);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, spec, 'utf8');
  return SPEC_ARTIFACT_RELPATH;
}

export interface SpecView {
  /** Prompt-ready text: the whole spec, or its section index plus a pointer to the
   *  on-disk artifact. Empty string when the run has no spec at all. */
  text: string;
  /** The spec as resolved from 05a -> 05 -> 04, always complete. For callers that must
   *  reason over the whole document rather than embed it (keyword scans, size reporting). */
  spec: string;
  /** True when `text` is the condensed index rather than the whole spec. */
  condensed: boolean;
}

/** The spec as one step should present it to its agent.
 *
 *  Steps that REASON OVER the whole document (spec audit, quality review, resolve
 *  warnings, run config, sprint planning) pass `full: true` and always get the complete
 *  text. Everything downstream of gate 1 gets the section index plus a pointer to
 *  `.haive/spec.md`, which the agent reads on demand — the same document was otherwise
 *  re-sent in full to a dozen fresh CLI processes per run.
 *
 *  Degrades to the full spec whenever the index would be a lie: mode 'full', an
 *  unreadable config, a spec short enough that condensing drops nothing, or a missing
 *  on-disk artifact. There is no state in which an agent gets a pointer to nothing. */
export async function resolveSpecView(
  ctx: StepContext,
  opts: { full?: boolean } = {},
): Promise<SpecView> {
  const spec = await resolveApprovedSpec(ctx);
  const whole: SpecView = { text: spec, spec, condensed: false };
  if (opts.full || spec.trim().length === 0) return whole;

  let mode: SpecViewMode = 'toc';
  try {
    const raw = await configService.get(CONFIG_KEYS.SPEC_VIEW_MODE);
    // Validate against the exported list rather than a hand-written literal so a new
    // mode is not silently swallowed here.
    if ((SPEC_VIEW_MODES as readonly string[]).includes(raw ?? '')) mode = raw as SpecViewMode;
  } catch (err) {
    // Best-effort: a config blip must not change what the agent is told. Full spec is
    // the lossless answer, so fall back to it.
    ctx.logger.warn({ err }, 'spec view mode unreadable; sending the full spec');
    return whole;
  }
  if (mode === 'full') return whole;

  const condensed = condenseDocument(spec);
  if (!condensed.dropped) return whole;

  // The pointer must name a file that actually exists, so check the artifact gate 1
  // wrote before promising the agent it can read the omitted sections.
  const worktreePath = await resolveTaskWorktreePath(ctx);
  if (!worktreePath || !(await pathExists(join(worktreePath, SPEC_ARTIFACT_RELPATH)))) {
    return whole;
  }

  const pointer = `${ctx.sandboxWorkdir}/${SPEC_ARTIFACT_RELPATH}`;
  return {
    text:
      `${condensed.text}\n\n[Spec condensed to its section index. The FULL spec is on disk — ` +
      `Read \`${pointer}\` for any section you need in full.]`,
    spec,
    condensed: true,
  };
}
