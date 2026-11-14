import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { schema, isLockNotAvailable, type Database } from '@haive/database';
import {
  DERIVED_WORKFLOW_PREFIX,
  derivedChangesSchema,
  evaluateDerivedTaskType,
  mergePromptStepCatalog,
  parsePromptSteps,
  summarizeDerivedWarnings,
  validateTaskTypeDefaults,
  type DerivedRunPlan,
} from '../modularity/index.js';
import { catalogWorkflowBaseCandidates, derivedBaseEligibility } from '../step-engine/run-list.js';
import { readStepCatalog, type StepCatalogRead } from './index.js';

type Definition = Pick<
  typeof schema.taskTypeDefinitions.$inferSelect,
  | 'slug'
  | 'source'
  | 'runListStrategy'
  | 'requiresRepository'
  | 'baseSlug'
  | 'changes'
  | 'promptSteps'
  | 'preAnswerDefaults'
  | 'stepLoopLimitDefaults'
> & { updatedAt?: Date };
type Base = Pick<Definition, 'slug' | 'source' | 'runListStrategy' | 'requiresRepository'>;
export type DerivedAdmissionIssue = {
  kind: string;
  stepId?: string;
  reason?: string;
  [key: string]: unknown;
};

/** The same evaluation serves authoring, lists and admission. Admission supplies locked reads. */
export function inspectDerivedDefinition(
  definition: Definition,
  base: Base | undefined,
  catalog: StepCatalogRead,
  integrationCategoryIds?: ReadonlySet<string>,
) {
  const issues: DerivedAdmissionIssue[] = [];
  const eligibility = base
    ? derivedBaseEligibility(base)
    : { eligible: false as const, reason: 'base-not-found' };
  if (!eligibility.eligible)
    issues.push({ kind: 'ineligible-derived-base', reason: eligibility.reason });
  if (!catalog.synced) issues.push({ kind: 'catalog-not-synced' });
  const changes = derivedChangesSchema.safeParse(definition.changes);
  if (!changes.success) issues.push({ kind: 'invalid-derived-changes' });
  if (base && definition.requiresRepository !== base.requiresRepository)
    issues.push({ kind: 'derived-repository-mismatch' });
  const own = mergePromptStepCatalog(catalog, definition);
  const baseRows = catalog.orderedRows.filter(
    (r) => r.workflowType === 'workflow' || r.workflowType === 'env_replicate',
  );
  for (const row of baseRows) {
    if (row.stepIndex === null || !Number.isFinite(row.stepIndex))
      issues.push({ kind: 'catalog-step-index-missing', stepId: row.stepId });
  }
  let baseCandidates: ReturnType<typeof catalogWorkflowBaseCandidates> = [];
  if (issues.length === 0) {
    try {
      baseCandidates = catalogWorkflowBaseCandidates(
        baseRows as { stepId: string; workflowType: string; stepIndex: number }[],
      );
    } catch {
      issues.push({ kind: 'catalog-order-invalid' });
    }
  }
  const evaluation =
    baseCandidates.length === 0
      ? { candidates: [], warnings: [], issues: [] }
      : evaluateDerivedTaskType({
          baseCandidates,
          changes: changes.success ? changes.data : [],
          catalog: own.composable,
          installedStepIds: own.stepIds,
          requiresRepository: definition.requiresRepository,
          promptSteps: {
            typeSlug: definition.slug,
            entries: parsePromptSteps(definition.promptSteps),
            integrationCategoryIds,
          },
        });
  issues.push(...evaluation.issues);
  const stepIds = [...new Set(evaluation.candidates.flatMap((c) => c.stepIds))];
  // A refused active payload never entered a candidate. Keep its module diagnosis,
  // without treating skipped anchors (including propagated producer refusals) as dependencies.
  const attemptedPayloads = evaluation.issues.flatMap((issue) => {
    if (
      !('operationIndex' in issue) ||
      issue.operationIndex === undefined ||
      ![
        'missing-installed-step',
        'replacement-contract-unavailable',
        'protected-prefix-edit',
      ].includes(issue.kind)
    )
      return [];
    const change = changes.success ? changes.data[issue.operationIndex] : undefined;
    return change && 'insertAfter' in change
      ? [change.step]
      : change && 'replace' in change
        ? [change.with]
        : [];
  });
  const dependencyStepIds = [...new Set([...stepIds, ...attemptedPayloads])];
  const defaultIssues = validateTaskTypeDefaults(
    {
      stepIds,
      preAnswerDefaults: definition.preAnswerDefaults,
      stepLoopLimitDefaults: definition.stepLoopLimitDefaults,
    },
    own.composable,
  );
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        rows: [...catalog.orderedRows].sort((a, b) => a.stepId.localeCompare(b.stepId)),
        entries: [...own.composable].sort(([a], [b]) => a.localeCompare(b)),
      }),
    )
    .digest('hex');
  const plan: DerivedRunPlan | null =
    issues.length > 0
      ? null
      : {
          version: 1,
          base: {
            slug: 'workflow',
            runListStrategy: 'workflow_paths',
            candidates: baseCandidates,
            catalogFingerprint: fingerprint,
          },
          overlay: {
            revision: definition.updatedAt?.toISOString() ?? 'unsaved',
            changes: changes.success ? changes.data : [],
          },
          requiresRepository: definition.requiresRepository,
          composableEntries: [...own.composable.values()].filter((entry) =>
            stepIds.includes(entry.stepId),
          ),
          candidates: evaluation.candidates,
          commonPrefix: [...DERIVED_WORKFLOW_PREFIX],
          warnings: evaluation.warnings,
          defaultWarnings: defaultIssues,
        };
  return {
    eligibility,
    revision: definition.updatedAt?.toISOString() ?? null,
    catalogFingerprint: fingerprint,
    candidates: evaluation.candidates,
    warnings: summarizeDerivedWarnings(evaluation.warnings),
    issues,
    defaultIssues,
    stepIds,
    dependencyStepIds,
    plan,
  };
}

export const DERIVED_CATALOG_LOCK_TIMEOUT_MS = 1_000;
export class DerivedCatalogBusyError extends Error {
  readonly code = 'derived_admission_refused';
  readonly issues = [{ kind: 'catalog-busy' }];
  constructor() {
    super('The step catalog is being synced; try again');
    this.name = 'DerivedCatalogBusyError';
  }
}

export async function readDerivedDefinition(
  handle: Pick<Database, 'select' | 'execute'>,
  definition: Definition,
  integrationCategoryIds?: ReadonlySet<string>,
  opts: { lockTimeoutMs?: number } = {},
) {
  const [base] = await handle
    .select()
    .from(schema.taskTypeDefinitions)
    .where(eq(schema.taskTypeDefinitions.slug, definition.baseSlug ?? ''))
    .for('share');
  const [setting] = await handle.execute<{ timeout: string }>(
    sql`SELECT current_setting('lock_timeout') AS timeout`,
  );
  const timeoutMs = Math.max(1, Math.trunc(opts.lockTimeoutMs ?? DERIVED_CATALOG_LOCK_TIMEOUT_MS));
  await handle.execute(sql`SELECT set_config('lock_timeout', ${String(timeoutMs) + 'ms'}, true)`);
  try {
    await handle.execute(sql`LOCK TABLE ${schema.stepCatalog} IN SHARE MODE`);
  } catch (error) {
    if (isLockNotAvailable(error)) throw new DerivedCatalogBusyError();
    throw error;
  }
  await handle.execute(sql`SELECT set_config('lock_timeout', ${setting!.timeout}, true)`);
  const catalog = await readStepCatalog(handle, { ordered: true, lock: true });
  return {
    ...inspectDerivedDefinition(definition, base, catalog, integrationCategoryIds),
    catalog,
    base,
  };
}
