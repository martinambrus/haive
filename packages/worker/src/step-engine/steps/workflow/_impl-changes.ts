import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { StepContext } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';

const exec = promisify(execFile);

async function dirtyWorktreeFiles(worktreePath: string): Promise<string[]> {
  try {
    const { stdout } = await exec('git', ['status', '--porcelain'], { cwd: worktreePath });
    return stdout
      .toString()
      .split('\n')
      .map((l) => l.slice(3).trim())
      .filter(Boolean)
      .map((name) => (name.includes(' -> ') ? name.split(' -> ')[1]! : name));
  } catch {
    return [];
  }
}

/**
 * Files the implementation touched, for post-implementation steps (3.5
 * simplification, Phase 4 validation): the single-agent 07 output's
 * `filesTouched` when present, else the union of the DAG issues'
 * `filesModified`, plus currently-dirty worktree files (single-agent work is
 * still uncommitted at this point). Deduped, capped for prompt size.
 */
export async function collectImplementationFiles(
  ctx: StepContext,
  worktreePath: string,
): Promise<string[]> {
  const files = new Set<string>();
  const implement = await loadPreviousStepOutput(ctx.db, ctx.taskId, '07-phase-2-implement');
  const touched = (implement?.output as { filesTouched?: string[] } | null)?.filesTouched;
  for (const f of touched ?? []) files.add(f);
  if (files.size === 0) {
    const issues = await ctx.db
      .select({ filesModified: schema.taskDagIssues.filesModified })
      .from(schema.taskDagIssues)
      .where(eq(schema.taskDagIssues.taskId, ctx.taskId));
    for (const row of issues) {
      for (const f of (row.filesModified ?? []) as string[]) files.add(f);
    }
  }
  for (const f of await dirtyWorktreeFiles(worktreePath)) files.add(f);
  return [...files].slice(0, 100);
}
