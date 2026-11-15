import { z } from 'zod';
import {
  STEP_ROLES,
  type LegacyStepRoleId as StepRoleId,
  type StepOutputContractRef,
  stepRoleOutputContract,
  stepOutputContractsEqual,
} from '../step-engine/output-contracts.js';
import { EXECUTION_PATHS, executionPathSchema, type ExecutionPath } from '../schemas/tasks.js';
import type { DerivedBaseCandidate } from '../step-engine/run-list.js';
import {
  MODEL_HEALTH_STEP_ID,
  SYNC_BASE_STEP_ID,
  TRIAGE_STEP_ID,
} from '../step-engine/execution-paths.js';
import { composableStepEntrySchema, type ComposableStepEntry } from './contracts.js';
import { validateComposition, type CompositionIssue } from './composition.js';
import { checkPromptSteps, type PromptStepIssue } from './task-type-draft.js';
import type { ParsedPromptStepEntry } from './prompt-steps.js';

export {
  MAX_DERIVED_CHANGES,
  derivedChangeSchema,
  createDerivedChangesSchema,
  derivedChangesSchema,
  type DerivedChange,
} from './derived-changes.js';
import {
  derivedChangeSchema,
  derivedChangesSchema,
  derivedStepIdSchema,
  type DerivedChange,
} from './derived-changes.js';

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
  | 'replacement-target-forbidden'
  | 'replacement-not-composable'
  | 'replacement-not-declared'
  | 'replacement-contract-mismatch'
  | 'replacement-policy-incompatible'
  | 'replacement-role-ambiguous'
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
  kind: 'stale-target' | 'path-absent-replacement';
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
      target?: string;
      payload?: string;
      expectedContract?: StepOutputContractRef | null;
      actualContract?: StepOutputContractRef | null;
    }
  | { kind: 'invalid-composition'; executionPath: Path; issue: CompositionIssue }
  | { kind: 'invalid-prompt-step'; executionPath: Path; issue: PromptStepIssue };

export interface DerivedEvaluatedCandidate extends DerivedBaseCandidate {
  outcomes: DerivedChangeOutcome[];
  compositionIssues: CompositionIssue[];
  roleBindings?: DerivedRoleBindings;
  effectiveEntries?: ComposableStepEntry[];
}

export interface DerivedOverlayEvaluation {
  candidates: DerivedEvaluatedCandidate[];
  warnings: DerivedOverlayWarning[];
  issues: DerivedOverlayIssue[];
}

/** Persisted execution state.
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
  integrationAdmissions?: { categoryId: string; moduleId: string }[];
  defaultWarnings?: { kind: string; stepId: string; field?: string }[];
}
export interface PinnedRoleProducer {
  stepId: string;
  outputContract: StepOutputContractRef;
}
export type DerivedRoleBindings = Partial<Record<StepRoleId, PinnedRoleProducer>>;
export interface DerivedRunPlanV2 extends Omit<DerivedRunPlanV1, 'version' | 'candidates'> {
  version: 2;
  candidates: (DerivedEvaluatedCandidate & { roleBindings: DerivedRoleBindings })[];
}
export type DerivedRunPlan = DerivedRunPlanV1 | DerivedRunPlanV2;

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

/** Host policy is additive except for loop/closing policy, which the role owns.
 * Provided tokens must be declared by the actual producer, never manufactured here. */
export function effectiveReplacementEntry(
  entry: ComposableStepEntry,
  role: ComposableStepEntry,
): ComposableStepEntry {
  return {
    ...entry,
    requires: [
      ...entry.requires,
      ...role.requires.filter((r) => !entry.requires.some((e) => e.needs === r.needs)),
    ],
    precedes: [...new Set([...(entry.precedes ?? []), ...(role.precedes ?? [])])],
    entails: [...new Set([...(entry.entails ?? []), ...(role.entails ?? [])])],
    entailsWhen: [...(entry.entailsWhen ?? []), ...(role.entailsWhen ?? [])],
    removes: [...new Set([...(entry.removes ?? []), ...(role.removes ?? [])])],
    loopTargetStepId: role.loopTargetStepId,
    closes: role.closes,
  };
}

/** Pure workflow overlay evaluation. Callers supply ALL base candidates built by
 * workflowBaseCandidates, including null/pre-triage. Operations address actual IDs:
 * removed targets are tombstones, never aliases. */
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
    roleBindings: {} as DerivedRoleBindings,
    effective: new Map(catalog),
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
        const replacement = 'replace' in change;
        issues.push({
          kind,
          executionPath,
          operationIndex,
          stepId,
          ...(replacement
            ? {
                target,
                payload,
                expectedContract: Object.values(STEP_ROLES).includes(target as StepRoleId)
                  ? stepRoleOutputContract(target as StepRoleId)
                  : null,
                actualContract: catalog.get(payload!)?.outputContract ?? null,
              }
            : {}),
        });
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
        if ('replace' in change) refuse('replacement-target-forbidden');
      } else if ('replace' in change) {
        const role = target as StepRoleId;
        const expected = Object.values(STEP_ROLES).includes(role)
          ? stepRoleOutputContract(role)
          : null;
        const host = catalog.get(target);
        const entry = catalog.get(change.with);
        if (!expected) outcome = refuse('replacement-target-forbidden');
        else if (!installedStepIds.has(change.with))
          outcome = refuse('missing-installed-step', change.with);
        else if (!host?.outputContract || !stepOutputContractsEqual(expected, host.outputContract))
          outcome = refuse('replacement-contract-unavailable');
        else if (!entry) outcome = refuse('replacement-not-composable');
        else if (!entry.replaces?.includes(role)) outcome = refuse('replacement-not-declared');
        else if (!stepOutputContractsEqual(expected, entry.outputContract))
          outcome = refuse('replacement-contract-mismatch');
        else if (
          host.provides.some(
            (token) => !entry.provides.includes(token) || entry.removes?.includes(token),
          ) ||
          (entry.closes ?? false) !== (host.closes ?? false) ||
          (entry.loopTargetStepId !== undefined && entry.loopTargetStepId !== host.loopTargetStepId)
        )
          outcome = refuse('replacement-policy-incompatible');
        else if (
          stepIds.includes(change.with) ||
          Object.values(STEP_ROLES).includes(change.with as StepRoleId) ||
          Object.values(state.roleBindings).some((b) => b?.stepId === change.with)
        )
          outcome = refuse('replacement-role-ambiguous');
        else {
          stepIds.splice(index, 1, change.with);
          state.removed.add(target);
          introduced.add(change.with);
          state.skippedProducers.delete(change.with);
          state.roleBindings[role] = { stepId: change.with, outputContract: expected };
          state.effective.set(change.with, effectiveReplacementEntry(entry, host));
          outcome = { operationIndex, change, outcome: 'applied', reason: 'change-applied' };
        }
      } else if (payload !== undefined && !installedStepIds.has(payload)) {
        outcome = refuse('missing-installed-step', payload);
      } else {
        if ('remove' in change) {
          stepIds.splice(index, 1);
          state.removed.add(target);
          for (const role of Object.values(STEP_ROLES)) {
            if (state.roleBindings[role]?.stepId === target) {
              delete state.roleBindings[role];
              state.effective.set(target, catalog.get(target)!);
            }
          }
        } else {
          stepIds.splice(index + 1, 0, change.step);
          state.removed.delete(change.step);
          introduced.add(change.step);
          state.skippedProducers.delete(change.step);
        }
        outcome = { operationIndex, change, outcome: 'applied', reason: 'change-applied' };
      }
      state.outcomes.push(outcome);
      if (
        outcome.outcome === 'stale-target' ||
        ('replace' in change && outcome.outcome === 'path-absent')
      ) {
        warnings.push({
          kind: outcome.outcome === 'stale-target' ? 'stale-target' : 'path-absent-replacement',
          executionPath,
          operationIndex,
          stepId: target,
        });
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

  const hasReplacement = states.some((state) =>
    state.outcomes.some((o) => 'replace' in o.change && o.outcome === 'applied'),
  );
  const candidates = states.map(({ executionPath, stepIds, outcomes, roleBindings, effective }) => {
    for (const role of Object.values(STEP_ROLES)) {
      if (roleBindings[role] && stepIds.includes(role)) {
        const operationIndex = outcomes.findLast(
          (o) => 'insertAfter' in o.change && o.change.step === role && o.outcome === 'applied',
        )!.operationIndex;
        issues.push({
          kind: 'replacement-role-ambiguous',
          executionPath,
          stepId: role,
          operationIndex,
          target: role,
          payload: roleBindings[role]!.stepId,
          expectedContract: stepRoleOutputContract(role),
          actualContract: roleBindings[role]!.outputContract,
        });
      }
    }
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
    const compositionIssues = validateComposition(stepIds, effective, {
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
        { composable: effective },
        integrationCategoryIds,
      )) {
        if (issue.kind !== 'prompt-step-orphan')
          issues.push({ kind: 'invalid-prompt-step', executionPath, issue });
      }
    }
    return {
      executionPath,
      stepIds,
      outcomes,
      compositionIssues,
      ...(hasReplacement
        ? {
            roleBindings,
            effectiveEntries: Object.values(roleBindings).map((binding) =>
              effective.get(binding!.stepId)!,
            ),
          }
        : {}),
    };
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

export class DerivedRunPlanError extends Error {
  readonly code = 'invalid-derived-run-plan';
  constructor() {
    super('The derived task run plan is missing or malformed');
    this.name = 'DerivedRunPlanError';
  }
}
const candidateSchema = z
  .object({
    executionPath: executionPathSchema.nullable(),
    stepIds: z.array(derivedStepIdSchema).min(3),
  })
  .strict();
const outcomeSchema = z
  .object({
    operationIndex: z.number().int().nonnegative(),
    change: derivedChangeSchema,
    outcome: z.enum(['applied', 'path-absent', 'stale-target', 'refused']),
    reason: z.enum([
      'change-applied',
      'target-not-on-path',
      'target-not-in-base',
      'target-removed-by-change',
      'missing-installed-step',
      'replacement-contract-unavailable',
      'replacement-target-forbidden',
      'replacement-not-composable',
      'replacement-not-declared',
      'replacement-contract-mismatch',
      'replacement-policy-incompatible',
      'replacement-role-ambiguous',
      'protected-prefix-edit',
    ]),
    causedByOperation: z.number().int().nonnegative().optional(),
  })
  .strict();
const warningSchema = z
  .object({
    kind: z.enum(['stale-target', 'path-absent-replacement']),
    executionPath: executionPathSchema.nullable(),
    operationIndex: z.number().int().nonnegative(),
    stepId: derivedStepIdSchema,
  })
  .strict();
const planSchema = z
  .object({
    version: z.literal(1),
    base: z
      .object({
        slug: z.literal('workflow'),
        runListStrategy: z.literal('workflow_paths'),
        candidates: z.array(candidateSchema).length(4),
        catalogFingerprint: z.string().min(1),
      })
      .strict(),
    overlay: z.object({ revision: z.string().min(1), changes: derivedChangesSchema }).strict(),
    requiresRepository: z.boolean(),
    composableEntries: z.array(composableStepEntrySchema),
    candidates: z
      .array(
        candidateSchema.extend({
          outcomes: z.array(outcomeSchema),
          compositionIssues: z.array(z.never()),
        }),
      )
      .length(4),
    commonPrefix: z.array(derivedStepIdSchema),
    warnings: z.array(warningSchema),
    integrationAdmissions: z
      .array(z.object({ categoryId: z.string(), moduleId: z.string() }).strict())
      .optional(),
    defaultWarnings: z
      .array(
        z.object({ kind: z.string(), stepId: z.string(), field: z.string().optional() }).strict(),
      )
      .optional(),
  })
  .strict();

const producerSchema = z
  .object({
    stepId: derivedStepIdSchema,
    outputContract: z.object({ id: z.string(), version: z.number().int() }).strict(),
  })
  .strict();
const v2PlanSchema = planSchema.extend({
  version: z.literal(2),
  candidates: z
    .array(
      candidateSchema.extend({
        outcomes: z.array(outcomeSchema),
        compositionIssues: z.array(z.never()),
        effectiveEntries: z.array(composableStepEntrySchema),
        roleBindings: z
          .object({
            [STEP_ROLES.codeReview]: producerSchema.optional(),
            [STEP_ROLES.codeAudit]: producerSchema.optional(),
          })
          .strict(),
      }),
    )
    .length(4),
});

/** Read frozen candidate declarations, accepting both full legacy arrays and sparse overrides. */
export function derivedCandidateEntries(
  plan: Pick<DerivedRunPlan, 'composableEntries'>,
  candidate: Pick<DerivedEvaluatedCandidate, 'stepIds' | 'effectiveEntries'>,
): ComposableStepEntry[] {
  const entries = new Map(plan.composableEntries.map((e) => [e.stepId, e]));
  for (const entry of candidate.effectiveEntries ?? []) entries.set(entry.stepId, entry);
  return candidate.stepIds.flatMap((id) => (entries.has(id) ? [entries.get(id)!] : []));
}

/** Replay only the PINNED operations/outcomes. No current catalog or composition rules.
 * This verifies physical positions, one-hop bindings and removals without enabling admission. */
function validV2Bindings(plan: DerivedRunPlanV2): boolean {
  const entries = new Map(plan.composableEntries.map((e) => [e.stepId, e]));
  if (entries.size !== plan.composableEntries.length) return false;
  const roles = Object.values(STEP_ROLES);
  let replaced = false;
  for (const candidate of plan.candidates) {
    const ids = [
      ...plan.base.candidates.find((c) => c.executionPath === candidate.executionPath)!.stepIds,
    ];
    const bindings: DerivedRoleBindings = {};
    const removed = new Set<string>();
    for (const outcome of candidate.outcomes) {
      const change = outcome.change;
      const target = targetOf(change);
      const index = ids.indexOf(target);
      if (outcome.outcome !== 'applied') {
        if (
          index >= 0 ||
          removed.has(target) ||
          outcome.reason !==
            (outcome.outcome === 'path-absent' ? 'target-not-on-path' : 'target-not-in-base')
        )
          return false;
        continue;
      }
      if (
        index < 0 ||
        outcome.reason !== 'change-applied' ||
        ('insertAfter' in change
          ? index < DERIVED_WORKFLOW_PREFIX.length - 1
          : DERIVED_WORKFLOW_PREFIX.includes(target))
      )
        return false;
      if ('replace' in change) {
        if (
          !roles.includes(change.replace as StepRoleId) ||
          roles.includes(change.with as StepRoleId)
        )
          return false;
        const role = change.replace as StepRoleId;
        const entry = entries.get(change.with);
        if (
          bindings[role] ||
          !entry?.replaces?.includes(role) ||
          !stepOutputContractsEqual(stepRoleOutputContract(role), entry.outputContract)
        )
          return false;
        ids.splice(index, 1, change.with);
        removed.add(target);
        bindings[role] = { stepId: change.with, outputContract: entry.outputContract! };
        replaced = true;
      } else if ('remove' in change) {
        ids.splice(index, 1);
        removed.add(target);
        for (const role of roles) if (bindings[role]?.stepId === target) delete bindings[role];
      } else {
        if (DERIVED_WORKFLOW_PREFIX.includes(change.step)) return false;
        ids.splice(index + 1, 0, change.step);
        removed.delete(change.step);
      }
      if (new Set(ids).size !== ids.length) return false;
      if (roles.some((role) => bindings[role] && ids.includes(role))) return false;
    }
    if (JSON.stringify(ids) !== JSON.stringify(candidate.stepIds)) return false;
    if (candidate.effectiveEntries) {
      const overrides = candidate.effectiveEntries;
      if (
        new Set(overrides.map((e) => e.stepId)).size !== overrides.length ||
        overrides.some((e) => !candidate.stepIds.includes(e.stepId))
      )
        return false;
      const effective = new Map(derivedCandidateEntries(plan, candidate).map((e) => [e.stepId, e]));
      if (effective.size !== candidate.stepIds.length) return false;
      for (const role of roles) {
        const binding = bindings[role];
        if (!binding) continue;
        const entry = effective.get(binding.stepId);
        const host = entries.get(role);
        if (
          !entry ||
          !host ||
          !entry.replaces?.includes(role) ||
          !stepOutputContractsEqual(entry.outputContract, binding.outputContract) ||
          host.provides.some((t) => !entry.provides.includes(t) || entry.removes?.includes(t)) ||
          host.requires.some((r) => !entry.requires.some((e) => e.needs === r.needs)) ||
          (entry.closes ?? false) !== (host.closes ?? false) ||
          entry.loopTargetStepId !== host.loopTargetStepId
        )
          return false;
      }
    }
    const producers = new Set<string>();
    for (const role of roles) {
      const expected = bindings[role];
      const actual = candidate.roleBindings[role];
      if (!expected !== !actual) return false;
      if (expected && actual) {
        if (
          actual.stepId !== expected.stepId ||
          !stepOutputContractsEqual(expected.outputContract, actual.outputContract) ||
          producers.has(actual.stepId)
        )
          return false;
        producers.add(actual.stepId);
      }
    }
  }
  return replaced;
}

/** Read pinned shape/invariants only. Composition rules run at admission and first triage. */
export function parseDerivedRunPlan(raw: unknown): DerivedRunPlan {
  const parsed = z.union([planSchema, v2PlanSchema]).safeParse(raw);
  if (!parsed.success) throw new DerivedRunPlanError();
  const plan = parsed.data;
  const paths = [null, ...EXECUTION_PATHS];
  if (
    JSON.stringify(plan.commonPrefix) !== JSON.stringify(DERIVED_WORKFLOW_PREFIX) ||
    [plan.base.candidates, plan.candidates].some(
      (candidates) =>
        paths.some((path) => candidates.filter((c) => c.executionPath === path).length !== 1) ||
        candidates.some(
          (c) =>
            !DERIVED_WORKFLOW_PREFIX.every((id, i) => c.stepIds[i] === id) ||
            new Set(c.stepIds).size !== c.stepIds.length,
        ),
    ) ||
    plan.candidates.some(
      (c) =>
        c.outcomes.length !== plan.overlay.changes.length ||
        c.outcomes.some(
          (outcome, i) =>
            outcome.operationIndex !== i ||
            outcome.outcome === 'refused' ||
            JSON.stringify(outcome.change) !== JSON.stringify(plan.overlay.changes[i]),
        ),
    )
  ) {
    throw new DerivedRunPlanError();
  }
  if (plan.version === 2 && !validV2Bindings(plan as DerivedRunPlanV2))
    throw new DerivedRunPlanError();
  return plan as DerivedRunPlan;
}

export function derivedCandidateIds(
  raw: unknown,
  path: ExecutionPath | null,
  union = false,
): string[] {
  const plan = parseDerivedRunPlan(raw);
  if (path === null && union)
    return [...new Set(plan.candidates.flatMap((candidate) => candidate.stepIds))];
  const candidate = plan.candidates.find((c) => c.executionPath === path);
  if (!candidate) throw new DerivedRunPlanError();
  return [...candidate.stepIds];
}

/** Traits and dependencies inspect every possible path until triage commits its choice. */
export function pinnedTaskStepIds(task: {
  runListSnapshot?: readonly string[] | null;
  derivedRunPlan?: unknown;
  executionPath?: ExecutionPath | string | null;
}): readonly string[] | null {
  if (task.derivedRunPlan != null) {
    const parsed =
      task.executionPath == null ? null : executionPathSchema.safeParse(task.executionPath);
    if (parsed !== null && !parsed.success) throw new DerivedRunPlanError();
    const path = parsed?.success ? parsed.data : null;
    return derivedCandidateIds(task.derivedRunPlan, path, true);
  }
  return task.runListSnapshot ?? null;
}

export function summarizeDerivedWarnings(warnings: readonly DerivedOverlayWarning[]) {
  const summary = new Map<
    number,
    {
      kind: 'stale-target' | 'path-absent-replacement';
      operationIndex: number;
      stepId: string;
      candidates: (ExecutionPath | null)[];
    }
  >();
  for (const warning of warnings) {
    const item = summary.get(warning.operationIndex) ?? {
      kind: warning.kind,
      operationIndex: warning.operationIndex,
      stepId: warning.stepId,
      candidates: [],
    };
    if (!item.candidates.includes(warning.executionPath))
      item.candidates.push(warning.executionPath);
    summary.set(warning.operationIndex, item);
  }
  return [...summary.values()];
}

export function derivedTaskWarnings(raw: unknown) {
  const plan = parseDerivedRunPlan(raw);
  return [...summarizeDerivedWarnings(plan.warnings), ...(plan.defaultWarnings ?? [])];
}
