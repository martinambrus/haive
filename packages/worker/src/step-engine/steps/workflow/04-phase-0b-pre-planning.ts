import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormSchema, InfoSection } from '@haive/shared';
import { INVESTIGATIONS_DIR, KB_DIR, LEARNINGS_DIR } from '@haive/shared/knowledge-paths';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { RetryableParseError } from '../../step-definition.js';
import { loadPreviousStepOutput, pathExists } from '../onboarding/_helpers.js';
import { loadTaskMeta } from './_task-meta.js';
import { parseJsonLoose } from '../_fenced-json.js';
import { INSIGHTS_INSTRUCTION } from './08e-insights-triage.js';
import { loadOutstandingSpecFeedback } from './_spec-feedback.js';
import { loadBusinessRequirements } from './_business-requirements.js';
import { isBugBranch } from './01-worktree-setup.js';
import { agentDefinitionGuidance, retrievalGuidanceLines } from '../_retrieval-guidance.js';
import { resolveReviewDimensions } from '@haive/shared/review';
import {
  dimensionScopeLines,
  resolveTaskReviewDimensions,
} from '../../review-dimension-context.js';
import { loadSeededPlanNodes, renderSeededNodesForSpec } from './_plan-task-nodes.js';
import { findPlanRoot, renderPlanMarkdown } from '@haive/shared/plan';
import { resolveAffectedComponents, type AffectedComponents } from './_affected-components.js';

interface KbReference {
  id: string;
  title: string;
  exists: boolean;
}

/** The operational/lifecycle sentence the spec writer is held to.
 *
 *  Three of the canonical dimensions in this step's own vocabulary. When all three
 *  are in scope the original hand-wrapped lines are returned VERBATIM, so a
 *  repository that has not narrowed anything gets the prompt it always got; the
 *  rebuilt form is only reached once one of them is out of scope. Demanding a
 *  section for a dimension nobody will score is how the spec ends up carrying
 *  requirements the reviewers were told to ignore.
 */
function operationalDimensionLines(
  reviewDimensionIds: readonly string[] | null | undefined,
): string[] {
  // Via the resolver, so a detect_output persisted before this field existed
  // replays as every dimension rather than as none.
  const enabled = resolveReviewDimensions(reviewDimensionIds).enabled;
  const has = (id: string): boolean => enabled.some((d) => d.id === id);
  const observability = has('observability');
  const operational = has('operational-readiness');
  const backwardCompat = has('backward-compatibility');
  if (observability && operational && backwardCompat) {
    return [
      'Where the change touches them, the spec must also address the operational and lifecycle',
      'dimensions a reviewer will check: observability (logging/metrics for the new behavior),',
      'rollback (how to undo it), data/schema migration impact (safe and reversible), and backward',
      'compatibility for existing callers and stored data. Omit a dimension only when it genuinely',
      'does not apply to this change.',
    ];
  }
  const clauses = [
    observability ? 'observability (logging/metrics for the new behavior)' : '',
    operational
      ? 'rollback (how to undo it), data/schema migration impact (safe and reversible)'
      : '',
    backwardCompat ? 'backward compatibility for existing callers and stored data' : '',
  ].filter(Boolean);
  if (clauses.length === 0) return [];
  return [
    'Where the change touches them, the spec must also address the operational and lifecycle',
    `dimensions a reviewer will check: ${clauses.join('; ')}. Omit one only when it genuinely does`,
    'not apply to this change.',
  ];
}

interface PrePlanningDetect {
  taskTitle: string;
  taskDescription: string;
  discoverySummary: string;
  businessRequirements: string;
  relevantKbIds: string[];
  kbReferences: KbReference[];
  /** True when this task is a bug fix (isBugBranch on title/description/category).
   *  Steers the RAG retrieval guidance: bug fixes lean on run-books + learnings. */
  isBugFix: boolean;
  /** Latest gate-1 (06) spec rejection feedback not yet re-approved; pre-filled into the
   *  scope field and auto-submitted so a re-draft addresses it. Empty on the first run /
   *  after approval. */
  priorRejectionFeedback: string;
  /** The repository's plan canvas as a compact component index (ids + titles, no
   *  bodies), when it has one. Empty string when it does not — a repo with no plan
   *  is the normal case and must change nothing about this step. */
  planIndex: string;
  /** The nodes this task was CREATED to serve, rendered in full — bodies,
   *  ancestry and their `depends_on` links among each other.
   *
   *  Separate from `planIndex` because that is capped at three levels for
   *  prompt size, and a seeded node is routinely deeper than that: it would be
   *  absent from the vocabulary and the spec could not name it even though the
   *  whole chain from the plan through this spec to the DAG planner depends on
   *  it doing so. Empty when the task names no node, which is most tasks. */
  seededNodes: string;
  planRepositoryId: string | null;
  /** Review dimensions this repository scores changes against (ids from
   *  REVIEW_DIMENSIONS). Resolved at REPO scope, not task: 06-run-config runs at
   *  index 6.05 and this step is index 4, so the per-task override does not exist
   *  yet — reading it here would apply a narrowing the user makes later to a spec
   *  that was already written. */
  reviewDimensionIds: string[];
}

/** The deepest the index is ever rendered, and the character budget that shrinks it
 *  when a plan is too big for that depth to be affordable.
 *
 *  A GUARD RAIL, not a tuning change: 120k sits above every index MEASURED on a run
 *  that went well, so it trims nothing that has been observed working and only bounds
 *  the tail. Rendered index vs whole spec prompt, measured: a 174-node plan 93,035 of
 *  124,215 chars (75%), a 193-node plan 115,620 of 133,331 (87%), a 544-node plan
 *  158,274 of 219,412 (72%). So the index is the dominant term in EVERY planned run
 *  and lowering this is the biggest single lever on spec-phase cost — but whether a
 *  shallower index costs spec quality has not been measured, so it is not assumed
 *  here. Drop it to ~40k to halve the spec prompt, and compare the specs. */
const PLAN_INDEX_MAX_DEPTH = 3;
const PLAN_INDEX_MAX_CHARS = 120_000;

/** Held back from the budget for the omission notice, which is itself part of what
 *  reaches the prompt. Without the reserve a full-width trim returns MORE than the cap
 *  it announces. The notice is a fixed template plus two small numbers, so a constant
 *  is enough — `planIndexOmissionNotice` is asserted to stay inside it. */
const PLAN_INDEX_NOTICE_RESERVE = 400;

/** The plan canvas as a compact index for the spec prompt: titles, ids, kinds and
 *  statuses, with no bodies. The whole plan would swamp the prompt and most of it is
 *  irrelevant to any one task; what the spec writer needs is the VOCABULARY — which
 *  components exist and what they are called — so its "Affected components" section
 *  names real ones.
 *
 *  Depth is stepped DOWN rather than the text cut, because a character slice would
 *  end mid-node and leave a truncated `node:<uuid>` the writer could quote back as if
 *  it were whole. Shallower keeps every rendered node intact, and breadth is what
 *  vocabulary needs. The reduction is STATED in the prompt — the same rule the impact
 *  diagram's own cap follows: reported, never silent. */
/** Cut a rendered index down to whole NODES under `budget`.
 *
 *  Depth alone cannot enforce the bound: depth 1 is the floor, and a plan that is
 *  merely WIDE — MEASURED on a 1,001-node flat plan, a 273,104-char depth-one index
 *  reaching the prompt intact — is over budget at every depth. So the floor drops
 *  whole nodes as well.
 *
 *  Cuts only on a markdown heading, which is where `renderPlanMarkdown` starts each
 *  node, and keeps a PREFIX rather than a sample: a character slice can end mid-token
 *  and leave a truncated `node:<uuid>` the writer would quote back as if it were
 *  whole, which is the same reason the depth ladder exists. */
export function trimPlanIndexToWholeNodes(
  rendered: string,
  budget: number,
): { text: string; omitted: number } {
  if (rendered.length <= budget) return { text: rendered, omitted: 0 };
  // Group into whole node BLOCKS first (heading + its lines) and accept a block only
  // when all of it fits. Testing the budget at the heading alone lets the block's own
  // body push the result back over it.
  const isHeading = (line: string): boolean => /^#{1,6}\s/.test(line);
  const blocks: string[][] = [];
  for (const line of rendered.split('\n')) {
    if (blocks.length === 0 || isHeading(line)) blocks.push([line]);
    else blocks[blocks.length - 1]!.push(line);
  }
  const kept: string[] = [];
  let length = 0;
  let omitted = 0;
  let cutting = false;
  for (const block of blocks) {
    const text = block.join('\n');
    const cost = kept.length === 0 ? text.length : text.length + 1;
    if (cutting || length + cost > budget) {
      cutting = true;
      if (isHeading(block[0]!)) omitted += 1;
      continue;
    }
    kept.push(text);
    length += cost;
  }
  return { text: kept.join('\n'), omitted };
}

/** What the prompt is told about a reduced index.
 *
 *  The warning against inventing ids is the point of it: the writer must name
 *  components from this index, so it has to know the index is PARTIAL rather than
 *  read a missing component as one that does not exist. */
export function planIndexOmissionNotice(depth: number, omitted: number): string {
  const notes: string[] = [];
  if (depth < PLAN_INDEX_MAX_DEPTH) {
    notes.push(
      `bounded to ${depth} level(s) of the plan because the full ${PLAN_INDEX_MAX_DEPTH} do not fit`,
    );
  }
  if (omitted > 0) notes.push(`${omitted} further component(s) omitted for size`);
  return (
    `\n_This index is ${notes.join(', and ')}. Components that are not listed still EXIST — ` +
    `do not treat this as the whole plan, and do not invent an id for one you cannot see._\n`
  );
}

async function renderBoundedPlanIndex(ctx: StepContext, repositoryId: string): Promise<string> {
  let rendered = '';
  let depth = PLAN_INDEX_MAX_DEPTH;
  for (; depth >= 1; depth--) {
    rendered = await renderPlanMarkdown(ctx.db, repositoryId, {
      titlesOnly: true,
      maxDepth: depth,
    });
    if (rendered.length <= PLAN_INDEX_MAX_CHARS) break;
  }
  depth = Math.max(depth, 1);
  // A full-depth render that already fits carries no notice and is returned as it is.
  // Everything else gets one, and the notice is part of what reaches the prompt — so
  // the trim has to hold room for it, or the finished index exceeds the very bound the
  // notice announces (MEASURED: content trimmed to 119,999 returned 120,256).
  if (depth === PLAN_INDEX_MAX_DEPTH && rendered.length <= PLAN_INDEX_MAX_CHARS) return rendered;
  const { text, omitted } = trimPlanIndexToWholeNodes(
    rendered,
    PLAN_INDEX_MAX_CHARS - PLAN_INDEX_NOTICE_RESERVE,
  );
  return `${text}${planIndexOmissionNotice(depth, omitted)}`;
}

/** Silent when the repo has no plan. */
async function loadPlanIndex(
  ctx: StepContext,
): Promise<{ planIndex: string; seededNodes: string; planRepositoryId: string | null }> {
  const none = { planIndex: '', seededNodes: '', planRepositoryId: null };
  try {
    const [task] = await ctx.db
      .select({ repositoryId: schema.tasks.repositoryId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, ctx.taskId))
      .limit(1);
    const repositoryId = task?.repositoryId ?? null;
    if (!repositoryId) return none;
    if (!(await findPlanRoot(ctx.db, repositoryId))) {
      return { planIndex: '', seededNodes: '', planRepositoryId: repositoryId };
    }
    const planIndex = await renderBoundedPlanIndex(ctx, repositoryId);
    return {
      planIndex,
      seededNodes: await renderSeededNodesFor(ctx, repositoryId),
      planRepositoryId: repositoryId,
    };
  } catch (err) {
    // The plan is context, never a dependency: a lookup failure must not stop the
    // spec being written.
    ctx.logger.warn({ err }, 'plan index unavailable for the spec prompt');
    return none;
  }
}

/** The seeded set for the spec prompt, or '' when the task names no node.
 *  Thin because both halves are shared with 06b — see `_plan-task-nodes.ts`. */
async function renderSeededNodesFor(ctx: StepContext, repositoryId: string): Promise<string> {
  const seeded = await loadSeededPlanNodes(ctx, repositoryId);
  return seeded ? renderSeededNodesForSpec(seeded) : '';
}

function kbHeading(text: string): string | null {
  const m = /^#\s+(.+)$/m.exec(text);
  return m?.[1]?.trim() ?? null;
}

async function resolveKbReferences(repoPath: string, ids: string[]): Promise<KbReference[]> {
  const dir = path.join(repoPath, KB_DIR);
  const out: KbReference[] = [];
  for (const id of ids) {
    const full = path.join(dir, `${id}.md`);
    if (!(await pathExists(full))) {
      out.push({ id, title: id, exists: false });
      continue;
    }
    try {
      const text = await readFile(full, 'utf8');
      out.push({ id, title: kbHeading(text) ?? id, exists: true });
    } catch {
      out.push({ id, title: id, exists: false });
    }
  }
  return out;
}

interface PrePlanningApply {
  summary: string;
  spec: string;
  source: 'llm' | 'stub';
  /** Plan nodes the spec named, plus everything the edge graph says they reach.
   *  Absent when the repo has no plan. Rendered at gate 1 so the approver sees
   *  the blast radius alongside the spec, and carried into the implementer's
   *  prompt by `_plan-impact.ts` — one resolver serves both, see
   *  `_affected-components.ts`. */
  affectedComponents?: AffectedComponents;
}

interface DiscoveryOutput {
  summary?: string;
  relevantKbIds?: string[];
}

export function parsePrePlanningOutput(raw: unknown): {
  summary: string;
  spec: string;
} | null {
  if (!raw) return null;
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else if (typeof raw === 'object') {
    const asObj = raw as Record<string, unknown>;
    if (typeof asObj.summary === 'string' && typeof asObj.spec === 'string') {
      return { summary: asObj.summary, spec: asObj.spec };
    }
    return null;
  } else {
    return null;
  }
  const parsed = parseJsonLoose(text);
  if (parsed == null) return null;
  if (
    typeof parsed === 'object' &&
    typeof (parsed as Record<string, unknown>).summary === 'string' &&
    typeof (parsed as Record<string, unknown>).spec === 'string'
  ) {
    const obj = parsed as Record<string, unknown>;
    return { summary: obj.summary as string, spec: obj.spec as string };
  }
  return null;
}

export function stubPrePlanning(detect: PrePlanningDetect): { summary: string; spec: string } {
  const title = detect.taskTitle || '(untitled task)';
  const description = detect.taskDescription || '(no description provided)';
  const summary = [
    `Pre-planning draft for: ${title}`,
    '',
    description,
    '',
    detect.discoverySummary ? 'Discovery context incorporated.' : 'Discovery context unavailable.',
  ].join('\n');
  const specLines = [
    `# Spec: ${title}`,
    '',
    '## Goal',
    description,
    '',
    '## Discovery context',
    detect.discoverySummary || '(none)',
    '',
    '## Relevant knowledge base',
    detect.relevantKbIds.length > 0
      ? detect.relevantKbIds.map((id) => `- ${id}`).join('\n')
      : '- (none)',
    '',
    '## Approach',
    '- (to be filled in during implementation phase)',
    '',
    '## Risks',
    '- (none identified)',
    '',
    '## Acceptance criteria',
    '- (to be filled in before gate 1)',
    // The presentation-convention sections below keep the stub aligned with
    // the prompt contract so bypass smokes and dev flows exercise the same
    // renderer shapes (table, mermaid, quiz) a real LLM spec produces. All
    // lines are static — interpolating the description into task-list items
    // would break the quiz shape on multi-line input.
    '',
    '## Files to change',
    '',
    '| File | Change |',
    '| --- | --- |',
    '| (to be determined) | (stub spec) |',
    '',
    '```mermaid',
    'graph LR',
    '  A[Task] --> B[Draft spec]',
    '  B --> C[Quality review]',
    '  C --> D[Gate 1 approval]',
    '```',
    '',
    '## Comprehension Quiz',
    '',
    '### Q1: What is the goal of this task?',
    '- [x] Deliver the change described in the Goal section above',
    '- [ ] Refactor unrelated subsystems',
    '- [ ] No goal has been defined yet',
    '> Explanation: See the Goal section at the top of this spec.',
    '',
    '### Q2: What happens to this draft spec next?',
    '- [ ] It goes straight to implementation',
    '- [x] It passes the spec-quality review loop, then Gate 1 approval',
    '- [ ] It is discarded',
    '> Explanation: Phase 0b.5 reviews the spec before the Gate 1 approval step.',
    '',
    '### Q3: Which input grounds the claims in this spec?',
    '- [ ] The git commit history',
    '- [ ] CI logs',
    '- [x] The discovery summary from phase 0a',
    '> Explanation: See the Discovery context section.',
  ];
  return { summary, spec: specLines.join('\n') };
}

/**
 * Record the components this task affects as `touched` links.
 *
 * The affected set was already resolved for gate 1's diagram and then lived only
 * in this step's `task_steps.output`, which `_step-reset` nulls on a Retry — so
 * nothing downstream could ever use it. As a link it survives, and it is what
 * lets the plan say "three tasks changed code under this since anyone reviewed
 * it" instead of drifting silently.
 *
 * `touched`, never `implements`: this is blast radius, not completion.
 * `completePlanNodesForTask` greens only `implements`, so these rows can never
 * turn "this task affects twelve components" into "twelve components are done".
 *
 * `onConflictDoNothing` on the existing (node, task) unique index, so a task
 * created FROM a node keeps its `implements` row — a downgrade here would
 * silently stop that node ever going green.
 *
 * Best-effort: this is provenance, and it must never fail the spec step that
 * produced it.
 */
async function recordTouchedPlanNodes(
  ctx: StepContext,
  affected: PrePlanningApply['affectedComponents'],
): Promise<void> {
  // `named` are the ids the spec itself cited; `reached` are what the edge walk
  // added, which are affected for the same reason the walk exists.
  const unique = [
    ...new Set([...(affected?.named ?? []), ...(affected?.reached ?? [])].map((n) => n.id)),
  ];
  if (unique.length === 0) return;
  try {
    await ctx.db
      .insert(schema.planNodeTasks)
      .values(unique.map((nodeId) => ({ nodeId, taskId: ctx.taskId, role: 'touched' as const })))
      .onConflictDoNothing();
    ctx.logger.info({ nodes: unique.length }, 'recorded touched plan nodes for this task');
  } catch (err) {
    ctx.logger.warn({ err }, 'touched plan-node link write failed (non-fatal)');
  }
}

export const phase0bPrePlanningStep: StepDefinition<PrePlanningDetect, PrePlanningApply> = {
  metadata: {
    id: '04-phase-0b-pre-planning',
    workflowType: 'workflow',
    index: 4,
    title: 'Phase 0b: Pre-planning',
    description:
      'Produces a draft specification for the task using the discovery summary as context.',
    requiresCli: false,
    // Under auto-continue, draft on the defaults (empty scope on a first run, or the
    // pre-filled rejection feedback on a revise) instead of parking; manual gates.
    autoSubmitDefaults: true,
  },

  async detect(ctx: StepContext): Promise<PrePlanningDetect> {
    const meta = await loadTaskMeta(ctx.db, ctx.taskId);
    const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '03-phase-0a-discovery');
    const output = (prev?.output as DiscoveryOutput | null) ?? {};
    const ids = Array.isArray(output.relevantKbIds) ? output.relevantKbIds : [];
    const kbReferences = await resolveKbReferences(ctx.repoPath, ids);
    // Approved business requirements ground the technical spec when present — the
    // humanized 03b2 version if it ran, else 03b's raw draft.
    const businessRequirements = (await loadBusinessRequirements(ctx)).requirements;
    return {
      taskTitle: meta.title,
      taskDescription: meta.description,
      discoverySummary: output.summary ?? '',
      businessRequirements,
      relevantKbIds: ids,
      kbReferences,
      isBugFix: isBugBranch(meta.title, meta.description, meta.category),
      priorRejectionFeedback: await loadOutstandingSpecFeedback(ctx),
      reviewDimensionIds: (
        await resolveTaskReviewDimensions(ctx.db, ctx.taskId, 'repo')
      ).enabled.map((d) => d.id),
      ...(await loadPlanIndex(ctx)),
    };
  },

  form(_ctx, detected): FormSchema {
    const infoSections: InfoSection[] = [];
    if (detected.discoverySummary) {
      infoSections.push({
        title: 'Discovery summary',
        preview: `${detected.discoverySummary.length} chars`,
        body: detected.discoverySummary,
      });
    }
    if (detected.kbReferences.length > 0) {
      const lines = detected.kbReferences.map((kb) =>
        kb.exists ? `- ${kb.id}: ${kb.title}` : `- ${kb.id}: (file not found in repo)`,
      );
      infoSections.push({
        title: 'Relevant knowledge base files',
        preview: `${detected.kbReferences.length} file(s)`,
        body: lines.join('\n'),
      });
    }
    const revising = detected.priorRejectionFeedback.length > 0;
    return {
      title: 'Phase 0b: Pre-planning',
      description: [
        `Task: ${detected.taskTitle || '(untitled)'}`,
        '',
        detected.taskDescription || '(no description)',
        '',
        revising
          ? 'You rejected the previous spec at Gate 1. Your review feedback is pre-filled below — edit it if needed, then submit to re-draft the spec addressing it.'
          : detected.discoverySummary
            ? 'Discovery summary and KB files available below — expand to inspect.'
            : 'Discovery summary not available.',
      ].join('\n'),
      infoSections: infoSections.length > 0 ? infoSections : undefined,
      fields: [
        {
          type: 'textarea',
          id: 'scope',
          label: revising ? 'Revision feedback for the spec' : 'Scope / constraints (optional)',
          rows: 4,
          default: detected.priorRejectionFeedback || undefined,
          placeholder: 'Explicit boundaries, out-of-scope items, hard constraints.',
        },
      ],
      submitLabel: revising ? 'Re-draft with this feedback' : 'Draft spec',
      // On a revise (Gate 1 rejected the previous spec), auto-submit the pre-filled
      // feedback so the spec is re-drafted immediately — the user already authored it at
      // the Gate 1 review. First run leaves this unset so the user provides scope first.
      autoSubmit: revising ? true : undefined,
    };
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    timeoutMs: 60 * 60 * 1000,
    buildPrompt: (args) => {
      const detected = args.detected as PrePlanningDetect;
      const values = args.formValues as { scope?: string };
      const revising = detected.priorRejectionFeedback.length > 0;
      const scopeVal = (values.scope ?? '').trim();
      return [
        agentDefinitionGuidance(
          'technical-spec-writer',
          [
            'If a `.claude/agents/technical-spec-writer.md` agent definition exists in the repo, follow',
            'it; otherwise follow the protocol below.',
          ].join('\n'),
        ),
        // Last word on scope, against the repo's own technical-spec-writer.md — which
        // the clause above tells this agent to follow and which names all 14. Empty
        // when nothing is excluded, so a default run is what it always was.
        ...dimensionScopeLines(detected.reviewDimensionIds),
        'You are the pre-planning phase of an engineering workflow.',
        'Produce a concise draft specification for the task below.',
        'Emit ONE JSON object inside a ```json fenced code block with the shape:',
        '{ "summary": "<short rationale>", "spec": "<markdown spec body>" }',
        detected.planIndex
          ? [
              'This project has a PLAN — a durable tree of what it is meant to be. Here is its',
              'component index (ids and titles only):',
              '',
              detected.planIndex,
              '',
              'The spec body MUST therefore also include a section `## Affected components` listing',
              'the plan nodes this change touches, one per line, each as `node:<uuid>` followed by a',
              'short reason. Copy the ids VERBATIM from the index above — do not invent one, and do',
              'not name a component that is not in it. If the change touches nothing in the plan,',
              'write "none" under that heading and say why.',
              '',
            ].join('\n')
          : '',
        // After the index, so the required set is the most recent word on it — and
        // separate from it, because these nodes are a REQUIREMENT rather than
        // vocabulary and are shown in full at whatever depth they sit at.
        detected.seededNodes
          ? [
              '## The nodes this task was created to deliver',
              '',
              detected.seededNodes,
              'These are not a suggestion: someone chose them when they created this task, so every',
              'one MUST appear in your `## Affected components` section whatever else you add to it.',
              'Where a node above says it cannot start until another lands, the spec must order the',
              'work that way — that ordering is what the implementation planner reads to decide what',
              'can be built in parallel, and it cannot see the plan itself.',
              '',
            ].join('\n')
          : '',
        'The spec body must include sections: Goal, Approach, Risks, Acceptance criteria.',
        ...operationalDimensionLines(detected.reviewDimensionIds),
        'Ground every claim in the discovery summary — do not invent details.',
        '',
        'How to research — follow this order:',
        ...retrievalGuidanceLines(),
        'Two knowledge kinds are worth naming, both reachable through that same search:',
        `- LEARNINGS (paths under \`${LEARNINGS_DIR}/\`): durable lessons from PRIOR runs. Search them to`,
        '  avoid repeating past mistakes on similar work and fold the relevant ones into the Risks section.',
        detected.isBugFix
          ? `- RUN-BOOKS (\`${INVESTIGATIONS_DIR}/\`): past bug investigations (symptom → root cause → fix). This task is a BUG FIX — search them FIRST for this class of bug; quote the prior symptom/root cause and ground the Approach in what resolved it before.`
          : `- RUN-BOOKS (\`${INVESTIGATIONS_DIR}/\`): past bug investigations. Lower priority for this NEW-FEATURE task, but still worth checking when extending a historically-buggy area.`,
        '',
        'Presentation conventions for the spec body (the Haive web renderer detects and upgrades these):',
        '1. REQUIRED final section `## Comprehension Quiz` with 3-5 questions that test understanding',
        '   of THIS change (goal, affected components, risks) — never generic trivia. Each question',
        '   uses EXACTLY this GFM shape (machine-detected):',
        '   ### Q1: <question text>',
        '   - [ ] <wrong answer>',
        '   - [x] <correct answer>',
        '   - [ ] <wrong answer>',
        '   > Explanation: <one or two sentences citing the spec section that answers it>',
        '   Exactly one [x] per question; VARY the position of the correct option across questions.',
        '2. ENCOURAGED: one or two ```mermaid fenced diagrams where component interaction explains the',
        '   change better than prose (e.g. `graph LR` of the 2-3 affected components and the data flow,',
        '   or a sequence diagram for a new flow). Keep each diagram under 15 nodes.',
        '   In a diagram label, WRAP any text containing `(`, `)` or `;` in double quotes',
        '   (`-->|"mail()"|`, `A["php-fpm (5.6)"]`) — unquoted they are read as syntax and the',
        '   diagram fails to render.',
        '3. Use a GFM table for the files-to-change overview. File-level code excerpts go in normal',
        '   fenced code blocks (the renderer auto-collapses blocks longer than ~12 lines).',
        '4. For before/after comparisons (UI, API, config), emit two ADJACENT fenced blocks whose',
        '   info-strings are exactly `before` and `after` — the renderer shows them side-by-side.',
        '',
        `Task title: ${detected.taskTitle || '(untitled)'}`,
        `Task description: ${detected.taskDescription || '(none)'}`,
        revising
          ? `=== Reviewer feedback to address in this revised spec ===\n${scopeVal || detected.priorRejectionFeedback}`
          : `Scope guidance: ${scopeVal || '(none)'}`,
        '',
        '=== Discovery summary ===',
        detected.discoverySummary || '(none)',
        ...(detected.businessRequirements
          ? ['', '=== Approved business requirements ===', detected.businessRequirements]
          : []),
        '',
        `Relevant KB ids: ${detected.relevantKbIds.join(', ') || '(none)'}`,
        '',
        INSIGHTS_INSTRUCTION,
      ].join('\n');
    },
    retry: { maxAttempts: 3, retryOn: (e) => e instanceof RetryableParseError },
  },

  async apply(ctx, args): Promise<PrePlanningApply> {
    const parsed = parsePrePlanningOutput(args.llmOutput ?? null);
    if (parsed) {
      ctx.logger.info({ source: 'llm' }, 'pre-planning spec parsed');
      const affected = await resolveAffectedComponents(
        ctx,
        args.detected.planRepositoryId,
        parsed.spec,
      );
      await recordTouchedPlanNodes(ctx, affected);
      return {
        summary: parsed.summary,
        spec: parsed.spec,
        source: 'llm',
        ...(affected ? { affectedComponents: affected } : {}),
      };
    }
    if (!args.isFinalLlmAttempt) {
      throw new RetryableParseError('pre-planning spec output unparseable — retrying');
    }
    const stub = stubPrePlanning(args.detected);
    ctx.logger.info({ source: 'stub' }, 'pre-planning spec stubbed');
    return { summary: stub.summary, spec: stub.spec, source: 'stub' };
  },
};
