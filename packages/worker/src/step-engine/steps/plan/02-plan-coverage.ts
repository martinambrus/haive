import { readFile } from 'node:fs/promises';
import { and, eq } from 'drizzle-orm';
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
  latestExpansionAttempts,
  parseDocSections,
  type CoverageCandidate,
  type StructuralGap,
} from './plan-coverage-scan.js';
import { buildPlanExpansionContext } from './_plan-expansion-context.js';
import { assertPlanPatchWithinBreadth } from './_plan-breadth.js';
import { ensureSemanticExpansionResolution } from './_plan-semantic-stop.js';

/**
 * What the build did not cover, repaired to a semantic fixed point.
 *
 * Runs after 01-plan-build. Ordinary component leaves are assessed automatically:
 * each assessor must either mark the exact existing node taskable or add a real
 * decomposition. Those persisted states are the fixed point, so retries do not
 * grow already-finished branches. People are asked only about recorded terminal
 * losses, heuristic document gaps, or an unusually large automatic-pass budget.
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
  /** Live, unresolved component leaves above the requested depth. Unlike the
   *  builder's output snapshot, this is recomputed after every bounded batch. */
  frontierRemaining: number;
  frontierPreview: string[];
  /** Agent ids carry this number, separating bounded automatic passes while
   *  retaining their rows as durable accounting and failure history. */
  continuationBatch: number;
  /** The preceding automatic pass reached its model-work safety budget. A new
   *  pass needs one explicit user approval; ordinary waves do not. */
  automaticLimitReached: boolean;
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
  createdAt?: Date | null;
};

type MiningRowWithInvocation = MiningRow & {
  invocationExitCode: number | null;
  invocationEndedAt: Date | null;
  invocationErrorMessage: string | null;
};

/** Semantic convergence runs unattended in modest waves. The larger pass cap
 *  is a runaway guard, not a cadence at which the user must keep clicking. */
const CONTINUATION_AGENTS_PER_WAVE = 12;
export const AUTO_CONVERGENCE_AGENTS_PER_PASS = 240;
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
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
      AUTO_CONVERGENCE_AGENTS_PER_PASS - agentsUsed,
    ),
  );
}

function continuationState(rows: Pick<MiningRow, 'agentId'>[]): {
  maxBatch: number;
  wavesByBatch: Map<number, number>;
  agentsByBatch: Map<number, number>;
} {
  const wavesByBatch = new Map<number, number>();
  const agentsByBatch = new Map<number, number>();
  let maxBatch = 0;
  for (const row of rows) {
    const match = CONTINUATION_AGENT_RE.exec(row.agentId);
    if (!match) continue;
    const batch = Number(match[1]);
    const wave = Number(match[3]);
    maxBatch = Math.max(maxBatch, batch);
    wavesByBatch.set(batch, Math.max(wavesByBatch.get(batch) ?? 0, wave));
    agentsByBatch.set(batch, (agentsByBatch.get(batch) ?? 0) + 1);
  }
  return { maxBatch, wavesByBatch, agentsByBatch };
}

/**
 * Expansion failures are recovery work, not semantic-review work. Keeping their
 * focus nodes out of the automatic frontier prevents a failed provider or a
 * rejected patch from being retried forever while deterministic gap detection
 * presents the loss to the user. Clean legacy empty replies are deliberately
 * absent from this set: because they persisted neither children nor `taskable`,
 * they need one pass under the new explicit semantic-stop contract.
 */
export function unresolvedExpansionNodeIds(rows: MiningRow[]): Set<string> {
  const unresolved = new Set<string>();
  for (const [nodeId, row] of latestExpansionAttempts(rows)) {
    if (row.status === 'done' && !row.errorMessage) continue;
    unresolved.add(nodeId);
  }
  return unresolved;
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
      ...(row.createdAt ? { createdAt: row.createdAt } : {}),
    };
  }
  return {
    agentId: row.agentId,
    status: row.status,
    errorMessage: row.errorMessage,
    ...(row.createdAt ? { createdAt: row.createdAt } : {}),
  };
}

async function loadMiningRows(ctx: StepContext, stepId: string): Promise<MiningRow[]> {
  const rows = await ctx.db
    .select({
      agentId: schema.taskStepAgentMinings.agentId,
      status: schema.taskStepAgentMinings.status,
      errorMessage: schema.taskStepAgentMinings.errorMessage,
      createdAt: schema.taskStepAgentMinings.createdAt,
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
  const blocked = unresolvedExpansionNodeIds([...buildRows, ...coverageRows]);
  return computeFrontier(nodes, depthBudget(buildFormValues), ctx.taskId).filter(
    (node) => !blocked.has(node.id),
  );
}

function hasCoverageWork(detected: CoverageDetect): boolean {
  return (
    detected.frontierRemaining > 0 || detected.structural.length > 0 || detected.sections.length > 0
  );
}

function coverageNeedsUserInput(detected: CoverageDetect): boolean {
  return (
    detected.structural.length > 0 || detected.sections.length > 0 || detected.automaticLimitReached
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
    automaticLimitReached: false,
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

  // Document-section agents have no focus node whose current tree state can
  // prove completion, so their clean rows are the durable handled marker.
  const handledSections = new Set(
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
  );

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
      ).filter((candidate) => !handledSections.has(sectionAgentId(sectionKey(candidate))));
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

  const continuation = continuationState(coverageRows);
  const latestAutomaticAgents = continuation.agentsByBatch.get(continuation.maxBatch) ?? 0;

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
    continuationBatch: continuation.maxBatch + 1,
    automaticLimitReached:
      frontier.length > 0 &&
      continuation.maxBatch > 0 &&
      latestAutomaticAgents >= AUTO_CONVERGENCE_AGENTS_PER_PASS,
  };
}

function coverageSelfNodeId(agentId: string): string | null {
  const recovery = new RegExp(`^cover-node-(${UUID_SOURCE})$`, 'i').exec(agentId)?.[1];
  return recovery ?? CONTINUATION_AGENT_RE.exec(agentId)?.[2] ?? null;
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
    const self = coverageSelfNodeId(result.agentId);
    try {
      const ops = await ensureSemanticExpansionResolution(
        ctx.db,
        detected.repositoryId!,
        self,
        patch.ops,
      );
      // A document-coverage agent may legitimately conclude that the section
      // was already represented. It has no single focus node to mark.
      if (ops.length === 0) continue;
      await assertPlanPatchWithinBreadth(
        ctx.db,
        detected.repositoryId!,
        ops,
        self,
        breadthCap(detected.buildFormValues),
      );
      const applied = await applyAgentPatch(
        ctx.db,
        {
          ...patch,
          ops: withMinedStatus(ops, detected.buildDetect?.mode ?? 'from_md'),
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

async function buildAutomaticConvergenceWave(
  ctx: StepContext,
  detected: CoverageDetect,
  nodes: PlanNodeSkeleton[],
  frontier: PlanNodeSkeleton[],
  agentsUsed: number,
  wave: number,
) {
  const count = continuationDispatchCount(frontier.length, agentsUsed);
  const slice = frontier.slice(0, count);
  const buildDetect =
    detected.buildDetect ??
    ({
      mode: 'from_md',
      repositoryId: detected.repositoryId,
      existingNodeCount: detected.nodeCount,
      hasRoot: true,
      kbFiles: [],
      brief: '',
      repoName: 'this project',
    } satisfies PlanBuildDetect);
  return Promise.all(
    slice.map(async (node) => ({
      agentId: continuationAgentId(detected.continuationBatch, node.id, wave),
      agentTitle: `Assess: ${node.title}`,
      roleKey: 'expand',
      prompt: await augmentPromptWithAttachments(
        ctx.db,
        ctx.taskId,
        buildExpandPrompt(
          buildDetect,
          detected.buildFormValues,
          node,
          buildPlanExpansionContext(nodes, node),
        ),
      ),
    })),
  );
}

export const planCoverageStep: StepDefinition<CoverageDetect, CoverageApply> = {
  metadata: {
    id: '02-plan-coverage',
    workflowType: 'plan_build',
    index: 1,
    title: 'Coverage check',
    description:
      'Repairs lost branches, semantically reviews unfinished leaves, and selectively decomposes only what is not implementation-ready.',
    requiresCli: true,
  },

  detect: detectCoverage,

  /**
   * Ordinary frontier work is semantic model work, not a user decision, so it
   * runs without a form. Stop only for known failures/heuristic document gaps,
   * or when one unusually large automatic pass reaches its safety budget.
   */
  form(_ctx, detected): FormSchema | null {
    if (!hasCoverageWork(detected)) return null;
    const gapTotal = detected.structural.length + detected.sections.length;
    if (!coverageNeedsUserInput(detected)) return null;

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
              value: 'converge',
              label: `Continue automatic semantic review (up to ${AUTO_CONVERGENCE_AGENTS_PER_PASS} nodes)`,
            },
          ]
        : []),
      { value: 'accept', label: 'Accept the plan as it is' },
    ];
    const defaultDecision =
      detected.structural.length > 0
        ? 'redecompose'
        : detected.frontierRemaining > 0
          ? 'converge'
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
          ? detected.automaticLimitReached
            ? `The preceding automatic semantic-review pass reached its ${AUTO_CONVERGENCE_AGENTS_PER_PASS}-node safety budget. Continuing starts another bounded pass; it will not ask again after each wave.`
            : 'The remaining leaves are reviewed automatically: each is either marked taskable or selectively decomposed. The user is not asked between ordinary waves.'
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
    async selectAgents({ ctx, detected, formValues }) {
      if (process.env.HAIVE_TEST_BYPASS_LLM === '1') return [];
      const d = detected as CoverageDetect | null;
      if (!d?.repositoryId) return [];
      const decision = typeof formValues.decision === 'string' ? formValues.decision : 'converge';
      // Ambiguous document gaps and explicit recovery selections are still
      // dispatched from apply(), after the user has chosen the exact items.
      if (decision === 'accept' || decision === 'redecompose') return [];

      const [nodes, buildRows, coverageRows] = await Promise.all([
        loadPlanSkeletons(ctx.db, d.repositoryId),
        loadMiningRows(ctx, '01-plan-build'),
        loadMiningRows(ctx, '02-plan-coverage'),
      ]);
      const frontier = liveFrontier(nodes, ctx, d.buildFormValues, buildRows, coverageRows);
      const state = continuationState(coverageRows);
      const agentsUsed = state.agentsByBatch.get(d.continuationBatch) ?? 0;
      const wave = (state.wavesByBatch.get(d.continuationBatch) ?? 0) + 1;
      return buildAutomaticConvergenceWave(ctx, d, nodes, frontier, agentsUsed, wave);
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
    const decision = typeof values.decision === 'string' ? values.decision : 'converge';
    const fold = args.newAgentMiningResults ?? args.agentMiningResults ?? [];
    if (fold.length > 0) {
      await foldCoverageResults(ctx, d, fold);
      await refreshPlanMirror(ctx, d.repositoryId);
    }

    if (decision === 'accept') {
      result.decision = 'accepted';
      return result;
    }

    if (decision === 'redecompose') {
      result.decision = 'redecomposed';
      result.dispatched = fold.length;

      // We have just folded the selected recovery agents. Re-detect before
      // finalizing: a subset may remain, recovered children may expose a live
      // frontier, or a recovery terminal may itself have failed.
      if (fold.length > 0) {
        const refreshed = await detectCoverage(ctx);
        result.frontierRemaining = refreshed.frontierRemaining;
        if (coverageNeedsUserInput(refreshed)) {
          throw new ReopenStepFormError('coverage repairs finished; more plan work remains');
        }
        if (refreshed.frontierRemaining > 0) {
          // Stay in the convergence pass that began with this step run. A fresh
          // detect normally proposes maxBatch+1 for a future automatic pass;
          // adopting that after every wave would reset the safety budget and
          // make the automatic loop effectively unbounded.
          const automaticDetected: CoverageDetect = {
            ...refreshed,
            continuationBatch: d.continuationBatch,
          };
          const [nodes, buildRows, coverageRows] = await Promise.all([
            loadPlanSkeletons(ctx.db, refreshed.repositoryId!),
            loadMiningRows(ctx, '01-plan-build'),
            loadMiningRows(ctx, '02-plan-coverage'),
          ]);
          const frontier = liveFrontier(
            nodes,
            ctx,
            refreshed.buildFormValues,
            buildRows,
            coverageRows,
          );
          const state = continuationState(coverageRows);
          const agentsUsed = state.agentsByBatch.get(automaticDetected.continuationBatch) ?? 0;
          const wave = (state.wavesByBatch.get(automaticDetected.continuationBatch) ?? 0) + 1;
          if (agentsUsed >= AUTO_CONVERGENCE_AGENTS_PER_PASS) {
            throw new ReopenStepFormError(
              'automatic semantic-review safety budget reached; frontier remains',
            );
          }
          const dispatches = await buildAutomaticConvergenceWave(
            ctx,
            automaticDetected,
            nodes,
            frontier,
            agentsUsed,
            wave,
          );
          if (dispatches.length > 0) {
            throw new MiningWaveError(
              dispatches,
              `coverage repaired; automatic semantic convergence: ${dispatches.length} node(s)`,
            );
          }
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

    if (decision !== 'continue' && decision !== 'converge') {
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

    // A provider-less wave dispatched nothing. There may be no mining row from
    // which refreshed detection can build a form, so fail explicitly rather
    // than spinning or pretending semantic convergence completed.
    if (args.miningWaveExhausted) {
      throw new Error('Automatic plan convergence could not dispatch a CLI agent.');
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

    if (agentsUsed >= AUTO_CONVERGENCE_AGENTS_PER_PASS) {
      throw new ReopenStepFormError(
        'automatic semantic-review safety budget reached; frontier remains',
      );
    }

    // Every assessor derives a bounded view from the same live node snapshot.
    // It first decides whether the leaf is already taskable and only then
    // decomposes it; compaction and breadth enforcement are provider-neutral.
    const dispatches = await buildAutomaticConvergenceWave(
      ctx,
      d,
      nodes,
      frontier,
      agentsUsed,
      nextWave,
    );
    if (dispatches.length === 0) {
      throw new Error('Automatic plan convergence found a frontier but could not build a wave.');
    }
    throw new MiningWaveError(
      dispatches,
      `automatic semantic convergence: ${dispatches.length} node(s) (${agentsUsed + dispatches.length}/${AUTO_CONVERGENCE_AGENTS_PER_PASS})`,
    );
  },
};
