import { schema } from '@haive/database';
import {
  CLI_DISPATCH_STEPS,
  PROVIDER_SENSITIVE_STEP_IDS,
  SKIPPABLE_STEP_IDS,
  STEP_CLI_ROLES,
  type CliRoleDescriptor,
} from '@haive/shared';
import {
  composableStepEntrySchema,
  derivePromptStepComposable,
  parsePromptStepEntry,
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

/** Keyed by step id. A step the catalog does not hold has no entry, and every reader treats that as no flags.
 *  A catalog the worker has not fully synced yet is answered from the static lists and not cached. */
export type StepFlagMap = ReadonlyMap<string, StepFlags>;

const CACHE_TTL_MS = 30_000;

let cached: { at: number; flags: StepFlagMap } | null = null;

export function resetStepFlagsCache(): void {
  cached = null;
}

/** What the api read before the catalog existed. Stands in until the worker has synced it. */
function staticStepFlags(): StepFlagMap {
  const out = new Map<string, StepFlags>();
  const get = (stepId: string): StepFlags => {
    let flags = out.get(stepId);
    if (!flags) {
      flags = {
        stepId,
        title: stepId,
        workflowType: 'workflow',
        allowSkip: false,
        dispatchesStepCli: false,
        providerSensitive: false,
        cliRoles: null,
        stepIndex: null,
        composable: null,
      };
      out.set(stepId, flags);
    }
    return flags;
  };
  CLI_DISPATCH_STEPS.forEach((s, i) => {
    Object.assign(get(s.id), {
      title: s.title,
      workflowType: s.workflowType,
      dispatchesStepCli: true,
      stepIndex: i,
    });
  });
  for (const id of SKIPPABLE_STEP_IDS) get(id).allowSkip = true;
  for (const id of PROVIDER_SENSITIVE_STEP_IDS) get(id).providerSensitive = true;
  for (const [id, roles] of Object.entries(STEP_CLI_ROLES)) get(id).cliRoles = roles;
  return out;
}

export async function loadStepFlags(
  db: Pick<ReturnType<typeof getDb>, 'select'>,
  now: number = Date.now(),
): Promise<StepFlagMap> {
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.flags;
  const rows = await db.select().from(schema.stepCatalog);
  if (rows.length === 0 || rows.some((row) => row.stepIndex === null)) return staticStepFlags();
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
  cached = { at: now, flags };
  return flags;
}

/** The task's flags: the catalog's, plus one entry per prompt step the task pinned at creation.
 *  A prompt step always dispatches a CLI, cannot be skipped and has no roles. Returns a copy when
 *  it adds anything, so the cached catalog map is never written to. */
export function withTaskCustomSteps(
  flags: StepFlagMap,
  task: {
    type: string;
    repositoryId: string | null;
    runListSnapshot: readonly string[] | null;
    customSteps: Record<string, unknown> | null;
  },
): StepFlagMap {
  const entries = Object.entries(task.customSteps ?? {});
  if (entries.length === 0) return flags;
  const merged = new Map(flags);
  for (const [stepId, raw] of entries) {
    const index = task.runListSnapshot?.indexOf(stepId) ?? -1;
    const entry = parsePromptStepEntry(raw);
    if (index < 0 || entry === null) continue;
    merged.set(stepId, {
      stepId,
      title: entry.title,
      workflowType: 'custom',
      allowSkip: false,
      dispatchesStepCli: true,
      providerSensitive: false,
      cliRoles: null,
      stepIndex: index,
      composable: derivePromptStepComposable(entry, task.type, task.repositoryId !== null),
    });
  }
  return merged;
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
