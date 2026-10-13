import { schema } from '@haive/database';
import type { CliRoleDescriptor } from '@haive/shared';
import {
  composableStepEntrySchema,
  validateComposition,
  type CompositionIssue,
  type ComposableStepEntry,
} from '@haive/shared/modularity';
import type { getDb } from '../db.js';

export interface StepFlags {
  stepId: string;
  title: string;
  workflowType: string;
  allowSkip: boolean;
  /** The step itself dispatches a CLI; a merge fixer, which runs one only on a conflict, does not. */
  dispatchesStepCli: boolean;
  providerSensitive: boolean;
  cliRoles: readonly CliRoleDescriptor[] | null;
  stepIndex: number | null;
  composable: ComposableStepEntry | null;
}

/** Keyed by step id. A step the catalog does not hold has no entry, and every reader treats that as no flags. */
export type StepFlagMap = ReadonlyMap<string, StepFlags>;

const CACHE_TTL_MS = 30_000;

let cached: { at: number; flags: StepFlagMap } | null = null;

export function resetStepFlagsCache(): void {
  cached = null;
}

export async function loadStepFlags(
  db: Pick<ReturnType<typeof getDb>, 'select'>,
  now: number = Date.now(),
): Promise<StepFlagMap> {
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.flags;
  const rows = await db.select().from(schema.stepCatalog);
  const flags = new Map<string, StepFlags>();
  for (const row of rows) {
    const entry = row.composable ? composableStepEntrySchema.safeParse(row.entry) : null;
    flags.set(row.stepId, {
      stepId: row.stepId,
      title: row.title,
      workflowType: row.workflowType,
      allowSkip: row.allowSkip,
      dispatchesStepCli: row.dispatchesStepCli,
      providerSensitive: row.providerSensitive,
      cliRoles: Array.isArray(row.cliRoles) ? (row.cliRoles as CliRoleDescriptor[]) : null,
      stepIndex: row.stepIndex,
      composable: entry?.success ? entry.data : null,
    });
  }
  if (flags.size > 0) cached = { at: now, flags };
  return flags;
}

function issueKey(issue: CompositionIssue): string {
  const { index: _index, ...rest } = issue as CompositionIssue & { index?: number };
  return JSON.stringify(rest);
}

/** Whether a run list stays as valid with `stepId` removed as it is with it: no issue appears that
 *  the full list does not already have. An empty list is not an issue here. A step the catalog
 *  cannot compose is never judged removable. */
export function compositionSurvivesWithout(
  flags: StepFlagMap,
  stepIds: readonly string[],
  stepId: string,
): boolean {
  if (!flags.get(stepId)?.composable) return false;
  const catalog = new Map<string, ComposableStepEntry>();
  for (const f of flags.values()) if (f.composable) catalog.set(f.stepId, f.composable);
  const issues = (ids: readonly string[]) =>
    validateComposition(ids, catalog).filter((i) => i.kind !== 'empty');
  const before = new Set(issues(stepIds).map(issueKey));
  return issues(stepIds.filter((id) => id !== stepId)).every((i) => before.has(issueKey(i)));
}
