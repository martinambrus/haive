import { readFile } from 'node:fs/promises';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormSchema, FormValues } from '@haive/shared';
import { loadPlanSkeletons, renderPlanMarkdown } from '@haive/shared/plan';
import type { PlanNodeSkeleton } from '@haive/shared/plan';
import type { AgentMiningResult, StepContext, StepDefinition } from '../../step-definition.js';
import { MiningWaveError, ReopenStepFormError } from '../../step-definition.js';
import { shouldRetryMiningTerminalFailure } from '../../mining-failure.js';
import { augmentPromptWithAttachments } from '../../attachments-context.js';
import { writePlanMirror } from '../../../plan/mirror.js';
import {
  APPLY_FAILURE_PREFIX,
  PARTIAL_APPLY_PREFIX,
  PLAN_AGENT_TIMEOUT_MS,
  askedState,
  breadthCap,
  buildExpandPrompt,
  computeFrontier,
  depthBudget,
  type PlanBuildApply,
  type PlanBuildDetect,
  withMinedStatus,
} from './01-plan-build.js';
import { PLAN_PATCH_CONTRACT, applyAgentPatch, parsePlanPatch } from './_plan-prompt.js';
import {
  findCoverageGaps,
  findStructuralGaps,
  parseDocSections,
  type CoverageCandidate,
  type StructuralGap,
} from './plan-coverage-scan.js';
import { buildPlanExpansionContext } from './_plan-expansion-context.js';

/**
 * What the build did not cover, reported for a person to rule on.
 *
 * Runs after 01-plan-build and REPORTS. It never edits the plan on its own: an
 * agent asked "what is missing?" against a 200 KB document and 800 nodes always
 * finds something, so an autonomous fixer has no fixed point and would grow the
 * plan on every run. The human tick is the fixed point, and the model is spent
 * only on gaps someone confirmed.
 *
 * Detection is deterministic, and its PRIMARY signal is structural rather than
 * textual. That is not a shortcut — it is what the evidence says. A term-coverage
 * scan cannot see this class of defect: when a build left a component with zero
 * children, that component's own title and body still named its subject, so every
 * word of the matching document section was present. MEASURED further: removing
 * a 92-node component from a 791-node plan changed a term scan's verdict not at
 * all, because the remaining nodes still mention those words somewhere. Tree
 * shape and the build's own recorded losses are what actually detect it.
 */

interface CoverageDetect {
  repositoryId: string | null;
  structural: StructuralGap[];
  sections: CoverageCandidate[];
  /** Section bodies, so a confirmed gap can be handed to an agent as a brief. */
  sectionBodies: Record<string, string>;
  planMarkdown: string;
  nodeCount: number;
  docName: string | null;
  /** The builder's original controls are reused by continuation agents so a
   *  retry of step 2 keeps the same requested depth and breadth. */
  buildDetect: PlanBuildDetect | null;
  buildFormValues: FormValues;
  buildStopped: PlanBuildApply['stopped'] | null;
  /** Live, unasked component leaves above the requested depth. Unlike the
   *  builder's output snapshot, this is recomputed after every bounded batch. */
  frontierRemaining: number;
  frontierPreview: string[];
  /** Agent ids carry this number, separating each user-approved batch from the
   *  previous one while retaining all rows as durable asked-history. */
  continuationBatch: number;
}

interface CoverageApply {
  checked: number;
  structural: number;
  sections: number;
  dispatched: number;
  frontierRemaining: number;
  decision: 'clean' | 'accepted' | 'redecomposed' | 'continued';
}

type MiningRow = {
  agentId: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  errorMessage: string | null;
};

type MiningRowWithInvocation = MiningRow & {
  invocationExitCode: number | null;
  invocationEndedAt: Date | null;
  invocationErrorMessage: string | null;
};

/** Each click approves at most this much additional model work. The wave cap
 *  keeps simultaneous terminals modest; the batch cap makes the form a real
 *  safety gate instead of permission to exhaust an arbitrarily large frontier. */
const CONTINUATION_AGENTS_PER_WAVE = 12;
const CONTINUATION_AGENTS_PER_BATCH = 60;
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID_SOURCE}$`, 'i');
const CONTINUATION_AGENT_RE = new RegExp(`^plan-continue-b(\\d+)-(${UUID_SOURCE})-p(\\d+)$`, 'i');

export function continuationAgentId(batch: number, nodeId: string, wave: number): string {
  return `plan-continue-b${batch}-${nodeId}-p${wave}`;
}

export function continuationDispatchCount(frontierCount: number, agentsUsed: number): number {
  return Math.max(
    0,
    Math.min(
      CONTINUATION_AGENTS_PER_WAVE,
      frontierCount,
      CONTINUATION_AGENTS_PER_BATCH - agentsUsed,
    ),
  );
}

function continuationState(rows: Pick<MiningRow, 'agentId' | 'errorMessage'>[]): {
  asked: Set<string>;
  maxBatch: number;
  wavesByBatch: Map<number, number>;
  agentsByBatch: Map<number, number>;
} {
  const asked = new Set<string>();
  const wavesByBatch = new Map<number, number>();
  const agentsByBatch = new Map<number, number>();
  let maxBatch = 0;
  for (const row of rows) {
    const match = CONTINUATION_AGENT_RE.exec(row.agentId);
    if (!match) continue;
    const batch = Number(match[1]);
    const nodeId = match[2]!;
    const wave = Number(match[3]);
    maxBatch = Math.max(maxBatch, batch);
    wavesByBatch.set(batch, Math.max(wavesByBatch.get(batch) ?? 0, wave));
    agentsByBatch.set(batch, (agentsByBatch.get(batch) ?? 0) + 1);
    // A rejected patch did not answer the question and may be re-asked in a
    // later wave. CLI failures and clean empty replies are terminal answers;
    // coverage reports the former as a structural loss instead of spinning.
    if (!row.errorMessage?.startsWith(APPLY_FAILURE_PREFIX)) asked.add(nodeId);
  }
  return { asked, maxBatch, wavesByBatch, agentsByBatch };
}

/** One line per gap in the gate's list, and the value the multi-select stores. */
const structuralKey = (g: StructuralGap): string => `node:${g.nodeId}`;
const sectionKey = (c: CoverageCandidate): string => `doc:${c.line}`;
/** One derivation, used by both the dispatcher and the already-handled filter —
 *  two spellings of this would silently stop matching. */
const sectionAgentId = (key: string): string => `cover-${key.replace(/\W+/g, '-')}`;

/**
 * A CLI completion and its mining-row fold are two writes. Usually the handler
 * performs them back-to-back, but a final fan-out barrier can observe the first
 * before the second (or inherit it after a worker interruption). Coverage must
 * not call that childless node healthy during the gap: an ended, failed backing
 * invocation is already conclusive evidence that its decomposition was lost.
 */
export function effectiveCoverageMiningRow(row: MiningRowWithInvocation): MiningRow {
  const invocationFailed =
    row.invocationEndedAt !== null &&
    (row.invocationExitCode === null ||
      row.invocationExitCode !== 0 ||
      (row.invocationErrorMessage?.trim().length ?? 0) > 0);
  if ((row.status === 'pending' || row.status === 'running') && invocationFailed) {
    return {
      agentId: row.agentId,
      status: 'failed',
      errorMessage:
        row.errorMessage ??
        row.invocationErrorMessage ??
        `agent invocation exited without a result (exit ${row.invocationExitCode ?? 'unknown'})`,
    };
  }
  return { agentId: row.agentId, status: row.status, errorMessage: row.errorMessage };
}

async function loadMiningRows(ctx: StepContext, stepId: string): Promise<MiningRow[]> {
  const rows = await ctx.db
    .select({
      agentId: schema.taskStepAgentMinings.agentId,
      status: schema.taskStepAgentMinings.status,
      errorMessage: schema.taskStepAgentMinings.errorMessage,
      invocationExitCode: schema.cliInvocations.exitCode,
      invocationEndedAt: schema.cliInvocations.endedAt,
      invocationErrorMessage: schema.cliInvocations.errorMessage,
    })
    .from(schema.taskStepAgentMinings)
    .innerJoin(schema.taskSteps, eq(schema.taskSteps.id, schema.taskStepAgentMinings.taskStepId))
    .leftJoin(
      schema.cliInvocations,
      eq(schema.cliInvocations.id, schema.taskStepAgentMinings.cliInvocationId),
    )
    .where(and(eq(schema.taskSteps.taskId, ctx.taskId), eq(schema.taskSteps.stepId, stepId)));
  return rows.map(effectiveCoverageMiningRow);
}

function liveFrontier(
  nodes: PlanNodeSkeleton[],
  ctx: StepContext,
  buildFormValues: FormValues,
  buildRows: MiningRow[],
  coverageRows: MiningRow[],
): PlanNodeSkeleton[] {
  const buildAsked = askedState(buildRows).asked;
  const root = nodes.find((node) => node.parentId === null);
  // The root outline is the builder's first question even though it has a
  // different agent-id shape from expansion waves.
  if (root) buildAsked.add(root.id);
  const continued = continuationState(coverageRows).asked;
  return computeFrontier(nodes, depthBudget(buildFormValues), ctx.taskId).filter(
    (node) => !buildAsked.has(node.id) && !continued.has(node.id),
  );
}

function hasCoverageWork(detected: CoverageDetect): boolean {
  return (
    detected.frontierRemaining > 0 || detected.structural.length > 0 || detected.sections.length > 0
  );
}

async function detectCoverage(ctx: StepContext): Promise<CoverageDetect> {
  const [task] = await ctx.db
    .select({ repositoryId: schema.tasks.repositoryId })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, ctx.taskId))
    .limit(1);
  const repositoryId = task?.repositoryId ?? null;
  const empty: CoverageDetect = {
    repositoryId,
    structural: [],
    sections: [],
    sectionBodies: {},
    planMarkdown: '',
    nodeCount: 0,
    docName: null,
    buildDetect: null,
    buildFormValues: {},
    buildStopped: null,
    frontierRemaining: 0,
    frontierPreview: [],
    continuationBatch: 1,
  };
  if (!repositoryId) return empty;

  const [buildStep] = await ctx.db
    .select({
      detectOutput: schema.taskSteps.detectOutput,
      formValues: schema.taskSteps.formValues,
      output: schema.taskSteps.output,
    })
    .from(schema.taskSteps)
    .where(
      and(eq(schema.taskSteps.taskId, ctx.taskId), eq(schema.taskSteps.stepId, '01-plan-build')),
    )
    .limit(1);
  const buildDetect = (buildStep?.detectOutput ?? null) as PlanBuildDetect | null;
  const buildFormValues = (buildStep?.formValues ?? {}) as FormValues;
  const buildOutput = (buildStep?.output ?? null) as PlanBuildApply | null;

  const skeletons = await loadPlanSkeletons(ctx.db, repositoryId);
  if (skeletons.length === 0) {
    return {
      ...empty,
      buildDetect,
      buildFormValues,
      buildStopped: buildOutput?.stopped ?? null,
    };
  }

  // The build's OWN record of what it lost, plus this gate's continuation
  // rows. Both outlive step-output retries and make failed branches durable.
  const [buildRows, coverageRows] = await Promise.all([
    loadMiningRows(ctx, '01-plan-build'),
    loadMiningRows(ctx, '02-plan-coverage'),
  ]);

  // What a previous pass of THIS step already re-decomposed. Only a patch that
  // actually landed counts; an agent whose own patch failed remains outstanding.
  const handled = new Set(
    coverageRows
      .filter((row) => row.status === 'done' && !row.errorMessage)
      .map((row) => row.agentId),
  );

  const structural = findStructuralGaps(
    skeletons.map((node) => ({
      id: node.id,
      title: node.title,
      kind: String(node.kind),
      parentId: node.parentId,
    })),
    [...buildRows, ...coverageRows],
    { failure: APPLY_FAILURE_PREFIX, partial: PARTIAL_APPLY_PREFIX },
  ).filter((gap) => !handled.has(`cover-node-${gap.nodeId}`));

  const frontier = liveFrontier(skeletons, ctx, buildFormValues, buildRows, coverageRows);

  // The source document, when this build had one. A from_repo build has no
  // single authority to check against, so the section half simply does not run.
  let sections: CoverageCandidate[] = [];
  const sectionBodies: Record<string, string> = {};
  let docName: string | null = null;
  const [attachment] = await ctx.db
    .select({
      filename: schema.taskAttachments.filename,
      storedPath: schema.taskAttachments.storedPath,
    })
    .from(schema.taskAttachments)
    .where(eq(schema.taskAttachments.taskId, ctx.taskId))
    .limit(1);
  if (attachment) {
    try {
      const doc = await readFile(attachment.storedPath, 'utf8');
      const parsed = parseDocSections(doc);
      const texts = skeletons.map((node) => node.title);
      const bodies = await ctx.db
        .select({ id: schema.planNodes.id, body: schema.planNodes.body })
        .from(schema.planNodes)
        .where(eq(schema.planNodes.repositoryId, repositoryId));
      const byId = new Map(bodies.map((body) => [body.id, body.body ?? '']));
      sections = findCoverageGaps(
        parsed,
        skeletons.map((node, index) => `${texts[index] ?? ''} ${byId.get(node.id) ?? ''}`),
      ).filter((candidate) => !handled.has(sectionAgentId(sectionKey(candidate))));
      for (const candidate of sections) {
        sectionBodies[sectionKey(candidate)] =
          parsed.find((part) => part.line === candidate.line)?.body ?? '';
      }
      docName = attachment.filename;
    } catch (err) {
      // A document we cannot read is not a coverage failure. Report the
      // structural/frontier halves rather than failing over a missing file.
      ctx.logger.warn({ err }, 'coverage: could not read the source document');
    }
  }

  return {
    repositoryId,
    structural,
    sections,
    sectionBodies,
    planMarkdown: await renderPlanMarkdown(ctx.db, repositoryId, { titlesOnly: true }),
    nodeCount: skeletons.length,
    docName,
    buildDetect,
    buildFormValues,
    buildStopped: buildOutput?.stopped ?? null,
    frontierRemaining: frontier.length,
    frontierPreview: frontier.slice(0, 20).map((node) => node.title),
    continuationBatch: continuationState(coverageRows).maxBatch + 1,
  };
}

function coverageSelfNodeId(agentId: string): string | null {
  const recovery = new RegExp(`^cover-node-(${UUID_SOURCE})$`, 'i').exec(agentId)?.[1];
  return recovery ?? CONTINUATION_AGENT_RE.exec(agentId)?.[2] ?? null;
}

export interface PatchBreadthViolation {
  parentRef: string;
  existingChildren: number;
  newChildren: number;
  totalChildren: number;
}

/**
 * Count NEW nodes by their direct parent before a plan patch reaches the
 * database. Existing-node updates carry UUID refs and do not consume another
 * child slot; temporary refs are creations. `self` is normalised to the real
 * focus id so its already-persisted children can be included in the limit.
 */
function newPatchChildrenByParent(ops: unknown[], selfNodeId: string | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    const candidate = op as Record<string, unknown>;
    if (
      candidate.op !== 'upsert' ||
      typeof candidate.nodeRef !== 'string' ||
      candidate.nodeRef === 'self' ||
      UUID_RE.test(candidate.nodeRef) ||
      typeof candidate.parentRef !== 'string'
    ) {
      continue;
    }
    const parentRef =
      candidate.parentRef === 'self' && selfNodeId ? selfNodeId : candidate.parentRef;
    counts.set(parentRef, (counts.get(parentRef) ?? 0) + 1);
  }
  return counts;
}

/** Pure boundary used by both the database-backed guard and its regression tests. */
export function findPatchBreadthViolations(
  ops: unknown[],
  maxChildren: number,
  options: {
    selfNodeId?: string | null;
    existingChildren?: ReadonlyMap<string, number>;
  } = {},
): PatchBreadthViolation[] {
  const counts = newPatchChildrenByParent(ops, options.selfNodeId ?? null);
  const violations: PatchBreadthViolation[] = [];
  for (const [parentRef, newChildren] of counts) {
    const existingChildren = options.existingChildren?.get(parentRef) ?? 0;
    const totalChildren = existingChildren + newChildren;
    if (totalChildren > maxChildren) {
      violations.push({ parentRef, existingChildren, newChildren, totalChildren });
    }
  }
  return violations;
}

/**
 * Recovery agents can emit a whole subtree in one reply, unlike the ordinary
 * one-level continuation. Enforce the user's breadth choice transactionally:
 * an over-wide reply is rejected before ANY op lands and remains a visible gap
 * that can be re-run, instead of silently creating a 25-child parent.
 */
async function assertPatchWithinBreadth(
  ctx: StepContext,
  repositoryId: string,
  ops: unknown[],
  selfNodeId: string | null,
  maxChildren: number,
): Promise<void> {
  const patchCounts = newPatchChildrenByParent(ops, selfNodeId);
  const persistedParentIds = [...patchCounts.keys()].filter((ref) => UUID_RE.test(ref));
  const existingChildren = new Map<string, number>();
  if (persistedParentIds.length > 0) {
    const rows = await ctx.db
      .select({
        parentId: schema.planNodes.parentId,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.planNodes)
      .where(
        and(
          eq(schema.planNodes.repositoryId, repositoryId),
          inArray(schema.planNodes.parentId, persistedParentIds),
        ),
      )
      .groupBy(schema.planNodes.parentId);
    for (const row of rows) {
      if (row.parentId) existingChildren.set(row.parentId, row.count);
    }
  }

  const violations = findPatchBreadthViolations(ops, maxChildren, {
    selfNodeId,
    existingChildren,
  });
  if (violations.length === 0) return;
  const details = violations
    .slice(0, 5)
    .map(
      (violation) =>
        `${violation.parentRef}: ${violation.existingChildren} existing + ${violation.newChildren} new = ${violation.totalChildren}`,
    )
    .join('; ');
  throw new Error(`breadth cap ${maxChildren} exceeded (${details})`);
}

async function stampMiningError(ctx: StepContext, agentId: string, errorMessage: string) {
  await ctx.db
    .update(schema.taskStepAgentMinings)
    .set({ errorMessage: errorMessage.slice(0, 2000) })
    .where(
      and(
        eq(schema.taskStepAgentMinings.taskStepId, ctx.taskStepId),
        eq(schema.taskStepAgentMinings.agentId, agentId),
      ),
    )
    .catch(() => undefined);
}

async function foldCoverageResults(
  ctx: StepContext,
  detected: CoverageDetect,
  results: AgentMiningResult[],
): Promise<{ hadFailure: boolean }> {
  let hadFailure = false;
  for (const result of results) {
    if (result.status !== 'done') {
      hadFailure = true;
      continue;
    }
    const patch = parsePlanPatch(result.output ?? result.rawOutput);
    if (!patch) {
      hadFailure = true;
      await stampMiningError(ctx, result.agentId, `${APPLY_FAILURE_PREFIX} no patch in reply`);
      continue;
    }
    // An empty patch is a legitimate atomic-node verdict. It remains in asked
    // history so the continuation does not hammer the same node forever.
    if (patch.ops.length === 0) continue;
    const self = coverageSelfNodeId(result.agentId);
    try {
      await assertPatchWithinBreadth(
        ctx,
        detected.repositoryId!,
        patch.ops,
        self,
        breadthCap(detected.buildFormValues),
      );
      const applied = await applyAgentPatch(
        ctx.db,
        {
          ...patch,
          ops: withMinedStatus(patch.ops, detected.buildDetect?.mode ?? 'from_md'),
        },
        {
          repositoryId: detected.repositoryId!,
          sourceTaskId: ctx.taskId,
          retryable: false,
          ...(self ? { selfNodeId: self } : {}),
        },
      );
      if (applied.dropped.length > 0) {
        hadFailure = true;
        await stampMiningError(
          ctx,
          result.agentId,
          `${PARTIAL_APPLY_PREFIX} ${applied.dropped.join('; ')}`,
        );
      }
    } catch (err) {
      hadFailure = true;
      const message = err instanceof Error ? err.message : String(err);
      ctx.logger.warn({ err, agentId: result.agentId }, 'coverage decomposition patch failed');
      await stampMiningError(ctx, result.agentId, `${APPLY_FAILURE_PREFIX} ${message}`);
    }
  }
  return { hadFailure };
}

async function refreshPlanMirror(ctx: StepContext, repositoryId: string): Promise<void> {
  try {
    await writePlanMirror(ctx.db, repositoryId, ctx.repoPath);
  } catch (err) {
    ctx.logger.warn({ err }, 'plan mirror write failed after coverage decomposition');
  }
}

export const planCoverageStep: StepDefinition<CoverageDetect, CoverageApply> = {
  metadata: {
    id: '02-plan-coverage',
    workflowType: 'plan_build',
    index: 1,
    title: 'Coverage check',
    description:
      'Reports what the build left undecomposed or lost, and offers to re-run the decomposition for the parts you pick.',
    // The check itself is deterministic; a CLI is spent only on the gaps a
    // person ticks, which is dispatched as mining from apply().
    requiresCli: false,
  },

  detect: detectCoverage,

  /** Null when there is nothing to show, so a clean build finishes unattended
   *  exactly as it did before this step existed. */
  form(_ctx, detected): FormSchema | null {
    if (!hasCoverageWork(detected)) return null;
    const gapTotal = detected.structural.length + detected.sections.length;

    const options = [
      ...detected.structural.map((g) => ({
        value: structuralKey(g),
        label: `${g.title} — ${g.reason}`,
      })),
      ...detected.sections.map((c) => ({
        value: sectionKey(c),
        label: `§${c.title} — no node covers ${c.missingTerms.slice(0, 4).join(', ')}`,
      })),
    ];

    const decisionOptions = [
      ...(gapTotal > 0
        ? [
            {
              value: 'redecompose',
              label: 'Re-run the decomposition for the items I pick',
            },
          ]
        : []),
      ...(detected.frontierRemaining > 0
        ? [
            {
              value: 'continue',
              label: `Continue up to ${CONTINUATION_AGENTS_PER_BATCH} more nodes`,
            },
          ]
        : []),
      { value: 'accept', label: 'Accept the plan as it is' },
    ];
    const defaultDecision =
      detected.structural.length > 0
        ? 'redecompose'
        : detected.frontierRemaining > 0
          ? 'continue'
          : 'redecompose';
    const frontierBody = detected.frontierPreview.map((title) => `- ${title}`).join('\n');

    return {
      title: 'Coverage check',
      description: [
        `The plan has ${detected.nodeCount} nodes.`,
        detected.frontierRemaining > 0
          ? `${detected.frontierRemaining} component node(s) are still eligible for decomposition at the depth you requested${
              detected.buildStopped && detected.buildStopped !== 'complete'
                ? `; the builder stopped at its ${detected.buildStopped.replace('_', ' ')} safety limit`
                : ''
            }.`
          : '',
        detected.structural.length > 0
          ? `${detected.structural.length} node(s) whose decomposition was lost or thinned.`
          : '',
        detected.sections.length > 0 && detected.docName
          ? `${detected.sections.length} section(s) of ${detected.docName} that no node appears to cover.`
          : '',
        '',
        detected.frontierRemaining > 0
          ? `Continuing runs a bounded batch of at most ${CONTINUATION_AGENTS_PER_BATCH} agents, then checks the live frontier and asks again if work remains.`
          : '',
        gapTotal > 0 ? 'Re-running asks one agent per selected item to add what is missing.' : '',
        'Accepting leaves the plan as it is — nothing here is deleted either way.',
      ]
        .filter(Boolean)
        .join('\n'),
      infoSections: [
        {
          title: 'What was found',
          preview: `${detected.frontierRemaining} still expandable, ${detected.structural.length} lost, ${detected.sections.length} uncovered`,
          body: [
            detected.frontierRemaining > 0
              ? `Still expandable (first ${detected.frontierPreview.length}):\n${frontierBody}`
              : '',
            options.length > 0
              ? `Other gaps:\n${options.map((o) => `- ${o.label}`).join('\n')}`
              : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
          defaultOpen: true,
        },
      ],
      fields: [
        {
          type: 'radio',
          id: 'decision',
          label: 'What do you want to do?',
          options: decisionOptions,
          default: defaultDecision,
          required: true,
        },
        ...(gapTotal > 0
          ? [
              {
                type: 'multi-select' as const,
                id: 'items',
                label: 'Which ones?',
                options,
                // Pre-ticked: a lost decomposition is a known loss, not a suggestion.
                // An uncovered section is a heuristic, so it starts unticked.
                defaults: detected.structural.map(structuralKey),
                visibleWhen: { field: 'decision', equals: 'redecompose' },
              },
              {
                type: 'textarea' as const,
                id: 'note',
                label: 'Anything to tell the agents (optional)',
                rows: 3,
                visibleWhen: { field: 'decision', equals: 'redecompose' },
              },
            ]
          : []),
      ],
      submitLabel: 'Record decision',
    };
  },

  agentMining: {
    requiredCapabilities: ['tool_use'],
    toolProfile: 'rag_only',
    timeoutMs: PLAN_AGENT_TIMEOUT_MS,
    // A recovery terminal is the last automated chance to replace missing plan
    // work. Retry transient infrastructure failures before returning control to
    // the gate; a final failure remains outstanding on a step retry because the
    // handled filter counts only clean, completed agents.
    retry: { maxAttempts: 2, retryOnInvocationFailure: shouldRetryMiningTerminalFailure },
    // Every agent of this step is dispatched from apply() once the user has
    // picked. Nothing fans out before the gate — the whole point is that the
    // model is spent only on confirmed gaps.
    async selectAgents() {
      return [];
    },
  },

  async apply(ctx, args): Promise<CoverageApply> {
    const d = args.detected;
    const result: CoverageApply = {
      checked: d.nodeCount,
      structural: d.structural.length,
      sections: d.sections.length,
      dispatched: 0,
      frontierRemaining: d.frontierRemaining,
      decision: 'clean',
    };
    if (!d.repositoryId || !hasCoverageWork(d)) return result;

    const values = (args.formValues ?? {}) as FormValues;
    const fold = args.newAgentMiningResults ?? args.agentMiningResults ?? [];
    if (fold.length > 0) {
      await foldCoverageResults(ctx, d, fold);
      await refreshPlanMirror(ctx, d.repositoryId);
    }

    if (values.decision === 'accept') {
      result.decision = 'accepted';
      return result;
    }

    if (values.decision === 'redecompose') {
      result.decision = 'redecomposed';
      result.dispatched = fold.length;

      // We have just folded the selected recovery agents. Re-detect before
      // finalizing: a subset may remain, recovered children may expose a live
      // frontier, or a recovery terminal may itself have failed.
      if (fold.length > 0) {
        const refreshed = await detectCoverage(ctx);
        result.frontierRemaining = refreshed.frontierRemaining;
        if (hasCoverageWork(refreshed)) {
          throw new ReopenStepFormError('coverage repairs finished; more plan work remains');
        }
        return result;
      }

      const picked = Array.isArray(values.items) ? (values.items as string[]) : [];
      if (picked.length === 0) {
        result.decision = 'accepted';
        return result;
      }

      const note =
        typeof values.note === 'string' && values.note.trim() ? values.note.trim() : null;
      const maxChildren = breadthCap(d.buildFormValues);
      const dispatches = picked.map((key) => {
        const structural = d.structural.find((gap) => structuralKey(gap) === key);
        const section = d.sections.find((candidate) => sectionKey(candidate) === key);
        const subject = structural
          ? `the plan node "${structural.title}" (${structural.reason})`
          : `the source document section "${section?.title ?? key}"`;
        return {
          // The node id rides in the agent id so apply() can hand the patch a
          // `self` ref and the agent never transcribes a uuid.
          agentId: structural
            ? `cover-node-${structural.nodeId}`
            : `cover-${key.replace(/\W+/g, '-')}`,
          agentTitle: `Cover: ${(structural?.title ?? section?.title ?? key).slice(0, 60)}`,
          roleKey: 'expand',
          prompt: [
            `You are completing a project plan that is missing work under ${subject}.`,
            '',
            structural
              ? [
                  'Its decomposition was attempted and lost, so it currently has no children.',
                  'Rebuild the missing subtree: add the children that the failed terminal should',
                  'have produced, plus any necessary descendants, until its leaves are taskable',
                  'at the same granularity as the rest of the plan.',
                ].join(' ')
              : 'No node in the plan covers this section. Add what it describes, under whichever existing node fits best.',
            '',
            section
              ? `The section reads:\n\n${(d.sectionBodies[key] ?? '').slice(0, 20_000)}\n`
              : '',
            note ? `The user adds: ${note}\n` : '',
            `Hard breadth limit: no parent touched by this patch may have more than ${maxChildren} direct children in total. If a subject needs more parts, group them under meaningful intermediate nodes, with at most ${maxChildren} children under each group.`,
            '',
            'The plan as it stands (titles only):',
            '',
            d.planMarkdown.slice(0, 60_000),
            '',
            'Add ONLY what is missing. Do not restate nodes that already exist, and do not',
            'duplicate a sibling under a different name — the reader is looking at this plan',
            'and will see both.',
            '',
            PLAN_PATCH_CONTRACT,
          ]
            .filter(Boolean)
            .join('\n'),
        };
      });

      throw new MiningWaveError(
        dispatches,
        `coverage re-decomposition: ${dispatches.length} agent(s)`,
      );
    }

    if (values.decision !== 'continue') {
      result.decision = 'accepted';
      return result;
    }

    result.decision = 'continued';
    const [nodes, buildRows, coverageRows] = await Promise.all([
      loadPlanSkeletons(ctx.db, d.repositoryId),
      loadMiningRows(ctx, '01-plan-build'),
      loadMiningRows(ctx, '02-plan-coverage'),
    ]);
    const frontier = liveFrontier(nodes, ctx, d.buildFormValues, buildRows, coverageRows);
    const continuation = continuationState(coverageRows);
    const agentsUsed = continuation.agentsByBatch.get(d.continuationBatch) ?? 0;
    const nextWave = (continuation.wavesByBatch.get(d.continuationBatch) ?? 0) + 1;
    result.dispatched = agentsUsed;
    result.frontierRemaining = frontier.length;

    // A provider-less wave wrote terminal failed rows but dispatched nothing.
    // Return to the gate so those failures are visible; asking the same wave in
    // this apply loop would spin on the same unique agent ids.
    if (args.miningWaveExhausted) {
      throw new ReopenStepFormError('continuation could not dispatch; review the remaining plan');
    }

    if (frontier.length === 0) {
      // The live frontier is complete, but a continuation terminal may have
      // failed or a document/structural gap may still exist. Refresh once at the
      // boundary so the task only finalizes when the whole gate is clean.
      const refreshed = await detectCoverage(ctx);
      if (hasCoverageWork(refreshed)) {
        throw new ReopenStepFormError('decomposition frontier finished; coverage gaps remain');
      }
      return result;
    }

    if (agentsUsed >= CONTINUATION_AGENTS_PER_BATCH) {
      throw new ReopenStepFormError('bounded continuation batch finished; frontier remains');
    }

    const count = continuationDispatchCount(frontier.length, agentsUsed);
    const slice = frontier.slice(0, count);
    if (slice.length === 0) {
      throw new ReopenStepFormError('continuation safety limit reached; frontier remains');
    }
    const buildDetect =
      d.buildDetect ??
      ({
        mode: 'from_md',
        repositoryId: d.repositoryId,
        existingNodeCount: d.nodeCount,
        hasRoot: true,
        kbFiles: [],
        brief: '',
        repoName: 'this project',
      } satisfies PlanBuildDetect);
    // Every agent derives a bounded view from the same live node snapshot. The
    // compaction happens before provider selection and therefore protects every
    // supported CLI, not only the provider that first exposed the transport cap.
    const dispatches = await Promise.all(
      slice.map(async (node) => ({
        agentId: continuationAgentId(d.continuationBatch, node.id, nextWave),
        agentTitle: `Continue: ${node.title}`,
        roleKey: 'expand',
        prompt: await augmentPromptWithAttachments(
          ctx.db,
          ctx.taskId,
          buildExpandPrompt(
            buildDetect,
            d.buildFormValues,
            node,
            buildPlanExpansionContext(nodes, node),
          ),
        ),
      })),
    );
    throw new MiningWaveError(
      dispatches,
      `bounded plan continuation: ${dispatches.length} node(s) (${agentsUsed + dispatches.length}/${CONTINUATION_AGENTS_PER_BATCH})`,
    );
  },
};
