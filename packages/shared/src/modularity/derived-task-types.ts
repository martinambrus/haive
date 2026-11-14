import { z } from 'zod';
import type { ExecutionPath } from '../schemas/tasks.js';
import type { DerivedBaseCandidate } from '../step-engine/run-list.js';
import {
  MODEL_HEALTH_STEP_ID,
  SYNC_BASE_STEP_ID,
  TRIAGE_STEP_ID,
} from '../step-engine/execution-paths.js';
import { parseStepId, type ComposableStepEntry } from './contracts.js';
import { validateComposition, type CompositionIssue } from './composition.js';
import { checkPromptSteps, type PromptStepIssue } from './task-type-draft.js';
import type { ParsedPromptStepEntry } from './prompt-steps.js';

export const MAX_DERIVED_CHANGES = 64;
const derivedStepIdSchema = z
  .string()
  .max(128)
  .refine((id) => parseStepId(id) !== null, 'invalid step id');
export const derivedChangeSchema = z.union([
  z.object({ replace: derivedStepIdSchema, with: derivedStepIdSchema }).strict(),
  z.object({ insertAfter: derivedStepIdSchema, step: derivedStepIdSchema }).strict(),
  z.object({ remove: derivedStepIdSchema }).strict(),
]);
export type DerivedChange = z.infer<typeof derivedChangeSchema>;

export function createDerivedChangesSchema(maxChanges = MAX_DERIVED_CHANGES) {
  return z.array(derivedChangeSchema).max(maxChanges);
}
export const derivedChangesSchema = createDerivedChangesSchema();

export const DERIVED_WORKFLOW_PREFIX: readonly string[] = [
  MODEL_HEALTH_STEP_ID,
  SYNC_BASE_STEP_ID,
  TRIAGE_STEP_ID,
];
type Path = ExecutionPath | null;
type RefusalReason =
  | 'target-removed-by-change'
  | 'missing-installed-step'
  | 'replacement-contract-unavailable'
  | 'protected-prefix-edit';

export interface DerivedChangeOutcome {
  operationIndex: number;
  change: DerivedChange;
  /** Refused is separate from skipped and applied: an invalid overlay never claims a mutation. */
  outcome: 'applied' | 'path-absent' | 'stale-target' | 'refused';
  reason: 'change-applied' | 'target-not-on-path' | 'target-not-in-base' | RefusalReason;
  /** Root producer of a skipped/refused inserted anchor, preserved through chains. */
  causedByOperation?: number;
}

export interface DerivedOverlayWarning {
  kind: 'stale-target';
  executionPath: Path;
  operationIndex: number;
  stepId: string;
}

export type DerivedOverlayIssue =
  | {
      kind: RefusalReason | 'duplicate-resulting-id';
      executionPath: Path;
      stepId: string;
      operationIndex?: number;
      index?: number;
    }
  | { kind: 'invalid-composition'; executionPath: Path; issue: CompositionIssue }
  | { kind: 'invalid-prompt-step'; executionPath: Path; issue: PromptStepIssue };

export interface DerivedEvaluatedCandidate extends DerivedBaseCandidate {
  outcomes: DerivedChangeOutcome[];
  compositionIssues: CompositionIssue[];
}

export interface DerivedOverlayEvaluation {
  candidates: DerivedEvaluatedCandidate[];
  warnings: DerivedOverlayWarning[];
  issues: DerivedOverlayIssue[];
}

/** Future persisted execution state. This PR adds no strategy, row, writer or reader.
 * The fingerprint covers actual ordered base IDs/catalog declarations, not workflow's
 * existing content_hash (which hashes null step IDs). Selected path lives on the task;
 * PR3 must pin it at first triage and retain it through Retry and recovery. */
export interface DerivedRunPlanV1 {
  version: 1;
  base: {
    slug: 'workflow';
    runListStrategy: 'workflow_paths';
    candidates: DerivedBaseCandidate[];
    catalogFingerprint: string;
  };
  overlay: { revision: string; changes: DerivedChange[] };
  requiresRepository: boolean;
  composableEntries: ComposableStepEntry[];
  candidates: DerivedEvaluatedCandidate[];
  commonPrefix: string[];
  warnings: DerivedOverlayWarning[];
}
export type DerivedRunPlan = DerivedRunPlanV1;

interface EvaluationInput {
  baseCandidates: readonly DerivedBaseCandidate[];
  changes: readonly DerivedChange[];
  catalog: ReadonlyMap<string, ComposableStepEntry>;
  /** Include installed prompt IDs after merging their declarations into catalog. */
  installedStepIds: ReadonlySet<string>;
  requiresRepository?: boolean;
  promptSteps?: {
    typeSlug: string;
    entries: Record<string, ParsedPromptStepEntry>;
    integrationCategoryIds?: ReadonlySet<string>;
  };
}

function targetOf(change: DerivedChange): string {
  return 'replace' in change
    ? change.replace
    : 'insertAfter' in change
      ? change.insertAfter
      : change.remove;
}
function payloadOf(change: DerivedChange): string | undefined {
  return 'replace' in change ? change.with : 'insertAfter' in change ? change.step : undefined;
}

/** Pure v1 workflow overlay evaluation. Callers supply ALL base candidates built by
 * workflowBaseCandidates, including null/pre-triage. Operations address actual IDs:
 * removed targets are tombstones, never aliases. No replacement capability is enabled. */
export function evaluateDerivedTaskType(input: EvaluationInput): DerivedOverlayEvaluation {
  const { baseCandidates, changes, catalog, installedStepIds } = input;
  const issues: DerivedOverlayIssue[] = [];
  const warnings: DerivedOverlayWarning[] = [];
  const baseIds = new Set(baseCandidates.flatMap((c) => [...c.stepIds]));
  const introduced = new Set<string>();
  const states = baseCandidates.map((base) => ({
    executionPath: base.executionPath,
    stepIds: [...base.stepIds],
    outcomes: [] as DerivedChangeOutcome[],
    removed: new Set<string>(),
    skippedProducers: new Map<string, DerivedChangeOutcome>(),
  }));

  changes.forEach((change, operationIndex) => {
    const target = targetOf(change);
    const payload = payloadOf(change);
    for (const state of states) {
      const { executionPath, stepIds } = state;
      const index = stepIds.indexOf(target);
      let outcome: DerivedChangeOutcome;
      const refuse = (kind: RefusalReason, stepId = target): DerivedChangeOutcome => {
        issues.push({ kind, executionPath, operationIndex, stepId });
        return { operationIndex, change, outcome: 'refused', reason: kind };
      };
      if (index < 0) {
        if (state.removed.has(target)) {
          outcome = refuse('target-removed-by-change');
        } else {
          const producer = state.skippedProducers.get(target);
          outcome = producer
            ? {
                ...producer,
                operationIndex,
                change,
                causedByOperation: producer.causedByOperation ?? producer.operationIndex,
              }
            : {
                operationIndex,
                change,
                outcome:
                  baseIds.has(target) || introduced.has(target) ? 'path-absent' : 'stale-target',
                reason:
                  baseIds.has(target) || introduced.has(target)
                    ? 'target-not-on-path'
                    : 'target-not-in-base',
              };
        }
      } else if (
        ('insertAfter' in change
          ? index < DERIVED_WORKFLOW_PREFIX.length - 1
          : DERIVED_WORKFLOW_PREFIX.includes(target)) ||
        (payload !== undefined && DERIVED_WORKFLOW_PREFIX.includes(payload))
      ) {
        outcome = refuse('protected-prefix-edit');
        // Every active replace is unavailable, even when another rule also refuses it.
        if ('replace' in change) refuse('replacement-contract-unavailable');
      } else if ('replace' in change) {
        outcome = refuse('replacement-contract-unavailable');
        if (!installedStepIds.has(change.with)) refuse('missing-installed-step', change.with);
      } else if (payload !== undefined && !installedStepIds.has(payload)) {
        outcome = refuse('missing-installed-step', payload);
      } else {
        if ('remove' in change) {
          stepIds.splice(index, 1);
          state.removed.add(target);
        } else {
          stepIds.splice(index + 1, 0, change.step);
          state.removed.delete(change.step);
          introduced.add(change.step);
          state.skippedProducers.delete(change.step);
        }
        outcome = { operationIndex, change, outcome: 'applied', reason: 'change-applied' };
      }
      state.outcomes.push(outcome);
      if (outcome.outcome === 'stale-target') {
        warnings.push({ kind: 'stale-target', executionPath, operationIndex, stepId: target });
      }
      if (
        payload !== undefined &&
        outcome.outcome !== 'applied' &&
        !baseIds.has(payload) &&
        !stepIds.includes(payload)
      ) {
        state.skippedProducers.set(payload, outcome);
      }
    }
  });

  const candidates = states.map(({ executionPath, stepIds, outcomes }) => {
    if (!DERIVED_WORKFLOW_PREFIX.every((id, index) => stepIds[index] === id)) {
      issues.push({ kind: 'protected-prefix-edit', executionPath, stepId: TRIAGE_STEP_ID });
    }
    const seen = new Set<string>();
    stepIds.forEach((stepId, index) => {
      if (seen.has(stepId))
        issues.push({ kind: 'duplicate-resulting-id', executionPath, stepId, index });
      seen.add(stepId);
      if (!installedStepIds.has(stepId))
        issues.push({ kind: 'missing-installed-step', executionPath, stepId, index });
    });
    const compositionIssues = validateComposition(stepIds, catalog, {
      requiresRepository: input.requiresRepository,
    });
    for (const issue of compositionIssues)
      issues.push({ kind: 'invalid-composition', executionPath, issue });
    if (input.promptSteps) {
      const { typeSlug, entries, integrationCategoryIds } = input.promptSteps;
      for (const issue of checkPromptSteps(
        {
          slug: typeSlug,
          stepIds,
          requiresRepository: input.requiresRepository ?? true,
        },
        entries,
        { composable: catalog },
        integrationCategoryIds,
      )) {
        if (issue.kind !== 'prompt-step-orphan')
          issues.push({ kind: 'invalid-prompt-step', executionPath, issue });
      }
    }
    return { executionPath, stepIds, outcomes, compositionIssues };
  });
  if (input.promptSteps) {
    const { typeSlug, entries, integrationCategoryIds } = input.promptSteps;
    const union = [...new Set(candidates.flatMap((c) => c.stepIds))];
    // A prompt used on one path is not an orphan merely because another path skips it.
    for (const issue of checkPromptSteps(
      {
        slug: typeSlug,
        stepIds: union,
        requiresRepository: input.requiresRepository ?? true,
      },
      entries,
      { composable: catalog },
      integrationCategoryIds,
    )) {
      if (issue.kind === 'prompt-step-orphan')
        issues.push({ kind: 'invalid-prompt-step', executionPath: null, issue });
    }
  }
  return { candidates, warnings, issues };
}
