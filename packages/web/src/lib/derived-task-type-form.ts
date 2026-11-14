import {
  derivedChangesSchema,
  evaluateDerivedTaskType,
  parsePromptSteps,
  promptStepId,
  validateTaskTypeDefaults,
  type DerivedChange,
  type DerivedOverlayEvaluation,
  type TaskTypeUpdate,
} from '@haive/shared/modularity';
import type { FormValues } from '@/components/form-renderer';
import type { TaskTypeCatalog, DerivedTaskTypeCreate } from './api-client';
import { catalogEntries } from './composition-messages';
import {
  samePromptSteps,
  withPromptStepEntries,
  type StoredPromptSteps,
  type PromptSteps,
} from './prompt-step-editing';
import { buildCreateBody, buildUpdateBody } from './task-type-form';

export function evaluateDerivedEditor(input: {
  catalog: TaskTypeCatalog;
  baseSlug: string;
  changes: DerivedChange[];
  typeSlug: string;
  requiresRepository: boolean;
  promptSteps: PromptSteps;
  loopLimits: Record<string, number>;
  preAnswerDefaults: Record<string, Record<string, unknown>>;
  integrationCategoryIds?: ReadonlySet<string>;
}) {
  const base = input.catalog.bases?.find((b) => b.slug === input.baseSlug);
  const parsed = derivedChangesSchema.safeParse(input.changes);
  const catalog = withPromptStepEntries(
    catalogEntries(input.catalog),
    input.typeSlug,
    input.requiresRepository,
    input.promptSteps,
  );
  const installedStepIds = new Set([
    ...input.catalog.registeredStepIds,
    ...Object.values(input.promptSteps).map((p) => promptStepId(input.typeSlug, p.slug)),
  ]);
  const evaluation: DerivedOverlayEvaluation = evaluateDerivedTaskType({
    baseCandidates: base?.orderedBaseLists ?? [],
    changes: parsed.success ? parsed.data : [],
    catalog,
    installedStepIds,
    requiresRepository: input.requiresRepository,
    promptSteps: {
      typeSlug: input.typeSlug,
      entries: parsePromptSteps(input.promptSteps),
      integrationCategoryIds: input.integrationCategoryIds,
    },
  });
  const issues: (
    { kind: string; [key: string]: unknown } | DerivedOverlayEvaluation['issues'][number]
  )[] = [...evaluation.issues];
  if (!parsed.success)
    issues.unshift({
      kind: 'invalid-derived-changes',
      message: parsed.error.issues
        .map((i) => `Change ${Number(i.path[0]) + 1}: ${i.message}`)
        .join('; '),
    });
  if (!base?.eligibility.eligible)
    issues.push({
      kind: 'ineligible-derived-base',
      reason: base?.eligibility.eligible === false ? base.eligibility.reason : 'base-not-found',
    });
  if (!input.catalog.synced) issues.push({ kind: 'catalog-not-synced' });
  if (!base?.orderedBaseLists?.length) issues.push({ kind: 'base-lists-unavailable' });
  const stepIds = [...new Set(evaluation.candidates.flatMap((c) => c.stepIds))];
  const defaultIssues: { kind: string; stepId: string; field?: string }[] =
    validateTaskTypeDefaults(
      {
        stepIds,
        preAnswerDefaults: input.preAnswerDefaults,
        stepLoopLimitDefaults: input.loopLimits,
      },
      catalog,
    );
  for (const [stepId, limit] of Object.entries(input.loopLimits)) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      defaultIssues.push({ kind: 'invalid-loop-limit', stepId });
  }
  return { ...evaluation, issues, defaultIssues, stepIds };
}

interface OverlayFields {
  changes: DerivedChange[];
  loopLimits: Record<string, number>;
  promptSteps: PromptSteps;
}

export function buildDerivedCreateBody(
  values: FormValues,
  overlay: OverlayFields & {
    baseSlug: string;
    preAnswerDefaults?: Record<string, Record<string, unknown>>;
  },
): DerivedTaskTypeCreate {
  const {
    stepIds: _stepIds,
    promptSteps: _promptSteps,
    ...flat
  } = buildCreateBody(values, { stepIds: [], loopLimits: overlay.loopLimits });
  return {
    ...flat,
    runListStrategy: 'derived',
    baseSlug: overlay.baseSlug,
    changes: overlay.changes,
    promptSteps: overlay.promptSteps,
    preAnswerDefaults: overlay.preAnswerDefaults ?? {},
  };
}

export function buildDerivedUpdateBody(
  values: FormValues,
  editableFields: readonly string[],
  overlay: OverlayFields,
  saved: {
    displayName?: unknown;
    changes?: DerivedChange[] | null;
    stepLoopLimitDefaults: Record<string, number>;
    promptSteps?: StoredPromptSteps;
    [key: string]: unknown;
  },
): TaskTypeUpdate {
  const body = buildUpdateBody(values, editableFields, null, {
    ...saved,
    description: saved.description ?? '',
  });
  for (const [field, current, previous] of [
    ['changes', overlay.changes, saved.changes ?? []],
    ['stepLoopLimitDefaults', overlay.loopLimits, saved.stepLoopLimitDefaults],
  ] as const) {
    if (editableFields.includes(field) && JSON.stringify(current) !== JSON.stringify(previous))
      Object.assign(body, { [field]: current });
  }
  if (
    editableFields.includes('promptSteps') &&
    !samePromptSteps(overlay.promptSteps, saved.promptSteps ?? {})
  )
    body.promptSteps = overlay.promptSteps;
  return body;
}

export function renameDerivedPromptIds(
  changes: DerivedChange[],
  from: string,
  to: string,
): DerivedChange[] {
  const rename = (id: string) =>
    id.startsWith(`custom.${from}.`) ? `custom.${to}.${id.slice(`custom.${from}.`.length)}` : id;
  return changes.map((change) =>
    'remove' in change
      ? { remove: rename(change.remove) }
      : 'replace' in change
        ? { replace: rename(change.replace), with: rename(change.with) }
        : { insertAfter: rename(change.insertAfter), step: rename(change.step) },
  );
}
