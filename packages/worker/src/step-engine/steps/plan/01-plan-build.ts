import { and, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  CONFIG_KEYS,
  configService,
  type FormSchema,
  type FormValues,
  type StepCapability,
} from '@haive/shared';
import { KB_DIR } from '@haive/shared/knowledge-paths';
import {
  findPlanRoot,
  loadPlanEdges,
  loadPlanSkeletons,
  planNodeDepth,
  type PlanNodeSkeleton,
} from '@haive/shared/plan';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { MiningRetryError, MiningWaveError } from '../../step-definition.js';
import { shouldRetryMiningTerminalFailure } from '../../mining-failure.js';
import { augmentPromptWithAttachments } from '../../attachments-context.js';
import { writePlanMirror } from '../../../plan/mirror.js';
import { PLAN_PATCH_CONTRACT, applyAgentPatch, parsePlanPatch } from './_plan-prompt.js';
import { buildPlanExpansionContext } from './_plan-expansion-context.js';
import { assertPlanPatchWithinBreadth } from './_plan-breadth.js';
import { ensureSemanticExpansionResolution } from './_plan-semantic-stop.js';
import type { PlanInputsApply } from './00-plan-inputs.js';

/**
 * Build a repository's plan, one LEVEL per mining wave.
 *
 * The level-by-level shape is not a stylistic choice. One LLM pass cannot emit a
 * four-hundred-node decomposition — the runner already names that failure
 * (`truncationRetries`) — and asking for one produces a truncated JSON blob
 * rather than a shallow plan. So the first wave drafts the root plus its first
 * level, and every later wave fans out one agent per FRONTIER node, each
 * responsible only for its own children.
 *
 * Waves ride `MiningWaveError`, NOT `loop`: the runner's loop re-entry re-enters
 * the LLM phase only (`resolveLlmPhase` asserts `stepDef.llm` exists, which this
 * step does not define), while `MiningWaveError` is the engine's primitive for
 * "the next fan-out's prompts depend on what the last one found". The frontier is
 * recomputed from the DATABASE on every apply pass, so a re-run after a crash
 * resumes where it stopped instead of duplicating a level.
 *
 * Because apply() re-runs after each wave with the CUMULATIVE result set, the
 * fold is over `newAgentMiningResults` — rows no previous pass folded. Folding
 * the full set every pass would re-create temp-ref children: a second application
 * of the same patch cannot know `tmp-api` already exists.
 */

const DEFAULT_DEPTH = 3;
const DEFAULT_BREADTH = 6;
/** Plan decomposition agents read a large source document plus the accumulated
 *  plan and must finish by emitting one valid patch. A short hard kill loses the
 *  whole branch, so both the initial builder and coverage recovery share this
 *  deliberately generous first-attempt budget. */
export const PLAN_AGENT_TIMEOUT_MS = 60 * 60 * 1000;
/** Hard ceiling on agents dispatched in ONE wave. The agent-pool governor bounds
 *  concurrency, but nothing else bounds the WIDTH of a level, and a plan whose
 *  level 2 is 80 nodes wide would otherwise queue 80 invocations at once. Nodes
 *  beyond the cap are not dropped — they stay on the frontier for the next wave. */
const MAX_AGENTS_PER_WAVE = 12;
/** Total expansion agents across the whole build. Bounds a pathological plan
 *  (deep AND wide) that the depth cap alone would not. */
const MAX_TOTAL_EXPAND = 60;
/** Wave cap. Depth budget already bounds waves (≤ 6 levels); this is the
 *  independent backstop for the slice-overflow case above. */
const MAX_WAVES = 8;

/**
 * Where the plan's content comes from.
 *
 * `from_md` is LEGACY and deliberately still here: the request schema no longer
 * offers it, so nothing can create one, but tasks stored with it must keep
 * running and stay retryable. `greenfield` is what replaced it — a brief plus
 * any number of attachments, describing a project that does not exist yet.
 *
 * The distinction is load-bearing rather than cosmetic. `withMinedStatus` greens
 * every node of a `from_repo` build because those nodes describe code that is
 * already written; a greenfield build routed through that branch produces a
 * project rendered as already finished, which is what a brief riding
 * `from_repo` used to do.
 */
type BuildMode = 'from_repo' | 'from_md' | 'greenfield';

export interface PlanBuildDetect {
  mode: BuildMode;
  repositoryId: string | null;
  existingNodeCount: number;
  hasRoot: boolean;
  /** Knowledge-base files the agent can read for `from_repo`. Names only — the
   *  agent reads the ones it wants. */
  kbFiles: string[];
  brief: string;
  repoName: string;
  /** Sandbox path of the index `00-plan-inputs` wrote, or null when the task has
   *  no attachments. Named in the prompt because several attachment kinds are
   *  only readable through a sidecar the index points at. */
  inputIndexPath?: string | null;
  /** Inputs a model must SEE to understand: images, plus any document that
   *  needed extraction and yielded no text (a wireframe PDF is exactly that —
   *  large because of its pictures, with a handful of labels or nothing at all).
   *
   *  A HARD vision requirement on every dispatch. A model that cannot see one is
   *  told by the no-vision boundary to skip it, and with no text form left it
   *  would plan around the wireframe and report success. */
  visualOnlyInputs?: string[];
  /** PDFs that DID yield text. A SOFT preference only — the sidecar is a real
   *  fallback, so a blind model can still read one and must not be refused. */
  hasPdfInputs?: boolean;
}

export interface PlanBuildApply {
  waves: number;
  nodeCount: number;
  edgeCount: number;
  /** Nodes still eligible for expansion when the build stopped. Non-zero with a
   *  `stopped` reason means the plan is shallower than the depth budget asked
   *  for — the form tells the user this can happen. */
  frontierRemaining: number;
  stopped: 'complete' | 'wave_budget' | 'node_budget' | 'dispatch_failed';
  mirrorFiles: string[];
  failures: string[];
}

export function depthBudget(values: FormValues): number {
  const n = Number(values.depthBudget);
  return Number.isFinite(n) && n >= 1 && n <= 6 ? Math.floor(n) : DEFAULT_DEPTH;
}

export function breadthCap(values: FormValues): number {
  const n = Number(values.breadthCap);
  return Number.isFinite(n) && n >= 2 && n <= 12 ? Math.floor(n) : DEFAULT_BREADTH;
}

/** Number of agents the next build wave may dispatch without crossing either
 *  safety cap. Keeping this calculation in one place prevents the last wave
 *  from overshooting MAX_TOTAL_EXPAND (for example 58 already asked + a full
 *  12-agent wave used to land at 70). */
export function planWaveDispatchCount(frontierCount: number, expandDispatched: number): number {
  return Math.max(
    0,
    Math.min(MAX_AGENTS_PER_WAVE, frontierCount, MAX_TOTAL_EXPAND - expandDispatched),
  );
}

/**
 * Nodes that should still be broken down.
 *
 * A node is on the frontier when it has no children, sits above the depth
 * budget, and is a `component`. The kind filter matters: a `research` or
 * `external` node is a blocker to resolve, not a system to decompose, and
 * expanding one produces invented sub-tasks for work that is waiting on a
 * person. `taskable` is excluded too — the user (or an earlier wave) has already
 * said that node is a unit of work.
 */
export function computeFrontier(
  nodes: PlanNodeSkeleton[],
  maxDepth: number,
  /** The build doing the asking. Its OWN nodes are exempt from the `done`
   *  filter below — a from_repo build creates them done because the code
   *  already exists, and without this exemption the wave machine would find an
   *  empty frontier after level 1 and stop. */
  sourceTaskId?: string,
): PlanNodeSkeleton[] {
  const withChildren = new Set(nodes.map((n) => n.parentId).filter(Boolean) as string[]);
  const minedByThisBuild = (n: PlanNodeSkeleton): boolean =>
    sourceTaskId !== undefined && n.sourceTaskId === sourceTaskId;
  return nodes.filter(
    (n) =>
      !withChildren.has(n.id) &&
      !n.taskable &&
      n.kind === 'component' &&
      // `not_applicable` is never exempt: it is a decision that this does not
      // apply, and the only way a node this build created carries it is that the
      // agent said so — expanding it would ask another agent to decompose
      // something already declared out of scope.
      n.status !== 'not_applicable' &&
      // `done` stops a MERGE re-expanding work already finished, which is the
      // case this filter exists for. A node this run just wrote is not that: it
      // is done because it describes existing code, not because someone
      // finished it.
      (minedByThisBuild(n) || n.status !== 'done') &&
      planNodeDepth(n.path) < maxDepth,
  );
}

/**
 * The status a mined node should arrive with.
 *
 * A plan built FROM a repository describes code that already exists, so `todo`
 * is false on arrival — MEASURED, a real build produced 644 nodes and every one
 * of them said there was work to do. `done` is applied only where the agent did
 * not speak: an explicit status wins, which is how a component the prompt asked
 * it to include but that is NOT built yet stays `todo` and, through
 * `rollUpStatus`, renders its whole ancestor chain in_progress.
 *
 * Only for `from_repo`. A document or a brief describes a project that does not
 * exist, where `todo` is already the truth.
 *
 * Ops are `unknown` here — zod validates them inside applyPlanPatch — so this
 * touches only what it can recognise and passes everything else through
 * untouched rather than reshaping input it does not understand.
 */
export function withMinedStatus(ops: unknown[], mode: BuildMode): unknown[] {
  if (mode !== 'from_repo') return ops;
  return ops.map((op) => {
    if (!op || typeof op !== 'object') return op;
    const o = op as Record<string, unknown>;
    if (o.op !== 'upsert' || o.status !== undefined) return op;
    return { ...o, status: 'done' };
  });
}

/** Node ids an expansion agent has already been asked about, parsed from the
 *  mining rows' agent ids (`plan-expand-<uuid>-p<N>`). Deriving it from the rows
 *  rather than carrying a list between apply passes means a wave is never re-asked
 *  even though each pass is an independent call — including the "this cannot be
 *  broken down" replies, which must not re-fire every wave. */
const EXPAND_AGENT_RE = /^plan-expand-([0-9a-f-]{36})-p(\d+)$/;

/** Marks a mining row whose reply parsed but whose PATCH was rejected, as
 *  opposed to a CLI failure. Written by the fold, read by `askedState`. */
export const APPLY_FAILURE_PREFIX = 'plan patch not applied:';

/** Marks a row whose patch DID apply with some ops discarded. Deliberately not
 *  the failure prefix: the node got its children, so `askedState` must leave it
 *  asked. */
export const PARTIAL_APPLY_PREFIX = 'plan patch partially applied:';

export function askedState(results: { agentId: string; errorMessage?: string | null }[]): {
  asked: Set<string>;
  waves: number;
  expandAsked: number;
  expandDispatched: number;
} {
  const asked = new Set<string>();
  let waves = 0;
  let expandDispatched = 0;
  for (const r of results) {
    const m = EXPAND_AGENT_RE.exec(r.agentId);
    if (!m) continue;
    expandDispatched += 1;
    // An expansion whose patch never applied did not answer the question, so the
    // node has not really been asked and returns to the frontier for a later
    // wave. MEASURED: an agent self-corrected in prose, the retracted draft was
    // applied, its bad uuid rolled the transaction back, and the node counted as
    // asked forever with nothing under it.
    //
    // Only an APPLY failure re-opens a node. A clean reply with zero ops — "this
    // cannot be broken down further" — carries no error and stays asked, which
    // is the case the wave counter below must not re-fire on. MAX_WAVES bounds
    // the retries either way, so a node that keeps failing is left alone rather
    // than spinning.
    if (r.errorMessage && r.errorMessage.startsWith(APPLY_FAILURE_PREFIX)) continue;
    asked.add(m[1]!);
    waves = Math.max(waves, Number(m[2]));
  }
  return { asked, waves, expandAsked: asked.size, expandDispatched };
}

/** What `00-plan-inputs` found, or null when it did not run for this task (the
 *  onboarding wrapper registers no such step). Never throws: a build must not
 *  fail because the index lookup did. */
async function loadPlanInputsOutput(ctx: StepContext): Promise<PlanInputsApply | null> {
  try {
    const [row] = await ctx.db
      .select({ output: schema.taskSteps.output })
      .from(schema.taskSteps)
      .where(
        and(eq(schema.taskSteps.taskId, ctx.taskId), eq(schema.taskSteps.stepId, '00-plan-inputs')),
      )
      .limit(1);
    return (row?.output as PlanInputsApply | null) ?? null;
  } catch (err) {
    ctx.logger.warn({ err }, 'could not read prepared plan inputs');
    return null;
  }
}

/** The capabilities every agent of THIS build needs.
 *
 *  `vision` is per-dispatch rather than on the mining spec because it is a
 *  property of the task's inputs, not of the step: the same builder runs with and
 *  without a wireframe attached, and declaring it statically would lock every
 *  blind model out of the builds that have no image at all. */
export function planAgentCapabilities(d: PlanBuildDetect): StepCapability[] {
  return (d.visualOnlyInputs?.length ?? 0) > 0 ? ['tool_use', 'vision'] : ['tool_use'];
}

async function listKbFiles(ctx: StepContext): Promise<string[]> {
  try {
    const dir = path.join(ctx.repoPath, KB_DIR);
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

function sourceGuidance(d: PlanBuildDetect): string {
  if (d.mode === 'from_md') {
    return [
      'The user attached a document describing what they want built (see the attached-files',
      'notice above). Read it and decompose WHAT IT SAYS. Do not invent scope it does not',
      'ask for, and do not silently drop scope it does ask for — if something in it does not',
      'fit the tree, add it as its own node rather than leaving it out.',
    ].join('\n');
  }
  if (d.mode === 'greenfield') {
    const index = d.inputIndexPath
      ? [
          `Read ${d.inputIndexPath} FIRST. It lists every attached file, what kind it is, and`,
          'where its readable text is — several kinds are only readable through an extracted',
          'sidecar that index names.',
          '',
        ]
      : [];
    return [
      'This project does not exist yet. The brief above and the attached files ARE the',
      'specification — they are what the user intends, not hints to improve on. Decompose what',
      'they say. Do not invent scope they do not ask for, and do not silently drop scope they',
      'do ask for: something that does not fit the tree gets its own node rather than being',
      'left out.',
      '',
      ...index,
      'Where two inputs CONTRADICT each other, or the brief leaves something genuinely open,',
      'record that as a `decision` node (a choice still to be made) or a `research` node (needs',
      'investigating first) and say in its body what the alternatives are. Do not pick one and',
      'present it as settled — a plan that hides an open question is worse than one that names',
      'it, because nobody goes looking for a decision the tree claims was already made.',
      '',
      'STATUS: nothing here is built. Leave status alone — every node is outstanding work.',
    ].join('\n');
  }
  const kb =
    d.kbFiles.length > 0
      ? `Read the knowledge base at ${KB_DIR}/ first (${d.kbFiles.length} file(s): ${d.kbFiles.slice(0, 20).join(', ')}).`
      : `This repository has no knowledge base yet.`;
  return [
    kb,
    'Use `rag_search` to look up how the code is actually organised before naming a component.',
    'The plan records what the project is MEANT to be, so a component belongs in it even when',
    'the code for it does not exist yet — but every component that DOES exist should be named',
    'the way the codebase names it, not the way you would have named it.',
    '',
    'STATUS: you are mapping a codebase that already exists, so a component that IS built needs',
    'no status — it is recorded as done for you. Set `"status": "todo"` explicitly ONLY on a',
    'component you name that is NOT built yet. That is the one thing separating the work still',
    'outstanding from the work already finished, and marking everything todo says the whole',
    'project is unbuilt.',
  ].join('\n');
}

function buildRootPrompt(d: PlanBuildDetect, values: FormValues): string {
  return [
    `You are drafting the top of a project plan for "${d.repoName}".`,
    '',
    'A plan is a durable tree of what the project IS MEANT TO BE — not a description of the',
    'code as it stands. It drills down from the whole product to leaves small enough that one',
    'developer task could implement each.',
    '',
    d.brief ? `What the user said about it:\n${d.brief}\n` : '',
    sourceGuidance(d),
    '',
    `Produce EXACTLY two levels now: one root node for the product as a whole, and at most`,
    `${breadthCap(values)} children under it for its major parts. Do NOT go deeper — later`,
    'waves expand each child. Give the root a body that says what the product is for.',
    '',
    'Include non-code work as its own node where it exists: a `decision` still to be made, a',
    'topic that needs `research`, an `external` blocker such as a domain, a licence or a',
    'hosting account. These are first-class parts of a plan and are usually the ones that get',
    'forgotten.',
    '',
    PLAN_PATCH_CONTRACT,
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildExpandPrompt(
  d: PlanBuildDetect,
  values: FormValues,
  node: PlanNodeSkeleton,
  planMarkdown: string,
): string {
  const remainingDepth = depthBudget(values) - planNodeDepth(node.path);
  return [
    `You are expanding ONE part of the plan for "${d.repoName}".`,
    '',
    'Here is a compact view of the plan as it stands, so you can see where your part sits',
    'and avoid duplicating a sibling. The target neighborhood keeps exact node refs; the',
    'whole-plan title index deliberately omits verbose bodies and dependency-edge detail.',
    '',
    planMarkdown,
    '',
    `## Your node`,
    `${node.title} (\`node:${node.id}\`, version ${node.version})`,
    '',
    `Break THIS node down into at most ${breadthCap(values)} children. Every new node must have`,
    `\`"parentRef": "${node.id}"\` or the ref of one of your own new nodes.`,
    '',
    remainingDepth <= 1
      ? 'This is the LAST level. Mark each child `"taskable": true` — they must be small enough that one developer task implements each.'
      : `You may go ${remainingDepth} level(s) deeper, but prefer ONE level now: later waves expand what you leave. Mark a child \`"taskable": true\` only when it is already small enough for a single developer task.`,
    '',
    'First make a semantic stopping decision. If this node is already specific enough for one',
    'developer task, do NOT invent children: mark THIS existing node taskable with',
    `\`{ "op": "upsert", "nodeRef": "${node.id}", "expectedVersion": ${node.version}, "taskable": true }\`.`,
    'Otherwise decompose it. An empty `ops` array is not a stopping decision because it leaves',
    'the plan unable to distinguish an implementation-ready leaf from an unfinished branch.',
    '',
    'Add `link` ops where this part depends on, affects, or implements something already in the',
    'plan. Those links are what later answers "if I change this, what else must change".',
    '',
    d.mode === 'from_repo'
      ? [
          'Where a node you name is ALREADY implemented, add `codeLinks` for the files you actually',
          'opened. Skip it for anything not built yet — a guessed path makes the impact view lie.',
          'Attach each link to the CHILD that file implements, not to the node you are expanding:',
          'links banked on the parent leave every child answering "nothing" when the impact view',
          "asks what implements it. If you put a filename in a child's title, that child needs the",
          'same file in its `codeLinks` — a title is prose, only a link is a link.',
        ].join(' ')
      : '',
    '',
    PLAN_PATCH_CONTRACT,
  ]
    .filter(Boolean)
    .join('\n');
}

export interface PlanBuilderOptions {
  id: string;
  workflowType: string;
  index: number;
  title: string;
  description: string;
  /** Ask the user for depth/breadth. The standalone task does; the ONBOARDING
   *  wrapper does not — onboarding is already a long sequence of forms, and one
   *  more asking for two numbers with sensible defaults is friction rather than
   *  control. The plan is editable afterwards either way. */
  askForBudget: boolean;
  /** Extra gate on top of the global kill-switch. The onboarding wrapper uses it
   *  to skip a repo that already has a plan. */
  extraShouldRun?: (ctx: StepContext) => Promise<boolean>;
}

/**
 * One builder, two triggers.
 *
 * `plan_build` is a standalone task type AND an onboarding step, because
 * `onboarding_upgrade` reconciles template artifacts only — it does not re-run
 * onboarding steps, so an already-onboarded repository would never reach a step
 * added to that pipeline. A repo onboarded before this existed gets its plan
 * from the button; a fresh one gets it during onboarding. Both run THIS code.
 */
export function createPlanBuildStep(
  opts: PlanBuilderOptions,
): StepDefinition<PlanBuildDetect, PlanBuildApply> {
  return {
    metadata: {
      id: opts.id,
      workflowType: opts.workflowType,
      index: opts.index,
      title: opts.title,
      description: opts.description,
      requiresCli: true,
    },

    async shouldRun(ctx): Promise<boolean> {
      if ((await configService.getBoolean(CONFIG_KEYS.PLAN_CANVAS_ENABLED, true)) === false) {
        return false;
      }
      return opts.extraShouldRun ? opts.extraShouldRun(ctx) : true;
    },

    async detect(ctx): Promise<PlanBuildDetect> {
      const [task] = await ctx.db
        .select({
          repositoryId: schema.tasks.repositoryId,
          description: schema.tasks.description,
          metadata: schema.tasks.metadata,
        })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, ctx.taskId))
        .limit(1);

      const repositoryId = task?.repositoryId ?? null;
      const meta = (task?.metadata ?? {}) as { planBuildMode?: string };
      // A default rather than a throw: an unrecognised value lands on the
      // pre-greenfield behaviour, which is what a revert of this feature would
      // also produce.
      const mode: BuildMode =
        meta.planBuildMode === 'from_md'
          ? 'from_md'
          : meta.planBuildMode === 'greenfield'
            ? 'greenfield'
            : 'from_repo';

      let repoName = 'this project';
      let existingNodeCount = 0;
      let hasRoot = false;
      if (repositoryId) {
        const [repo] = await ctx.db
          .select({ name: schema.repositories.name })
          .from(schema.repositories)
          .where(eq(schema.repositories.id, repositoryId))
          .limit(1);
        repoName = repo?.name ?? repoName;
        const nodes = await loadPlanSkeletons(ctx.db, repositoryId);
        existingNodeCount = nodes.length;
        hasRoot = nodes.some((n) => n.parentId === null);
      }

      // Read from 00-plan-inputs rather than re-derived here. That step already
      // classified every attachment and knows which sidecars it wrote; deriving
      // it twice is how the prompt ends up naming a file the step did not write.
      // Absent for the onboarding wrapper, which has no attachments at all.
      const inputs = await loadPlanInputsOutput(ctx);

      return {
        mode,
        repositoryId,
        existingNodeCount,
        hasRoot,
        kbFiles: mode === 'from_repo' ? await listKbFiles(ctx) : [],
        brief: (task?.description ?? '').trim(),
        repoName,
        inputIndexPath: inputs?.indexPath ?? null,
        // Images are always visual-only; a document joins them when nothing
        // readable came out of it.
        visualOnlyInputs: [
          ...(inputs?.inputs ?? []).filter((i) => i.kind === 'image').map((i) => i.filename),
          ...(inputs?.visualOnly ?? []),
        ],
        hasPdfInputs: inputs?.hasPdfInputs === true,
      };
    },

    form(_ctx, detected): FormSchema | null {
      if (!opts.askForBudget) return null;
      return {
        title: 'Plan depth',
        description:
          detected.existingNodeCount > 0
            ? `This repository already has ${detected.existingNodeCount} plan node(s). New work is MERGED into the existing plan — nothing is deleted.`
            : 'How far should the plan be broken down?',
        fields: [
          {
            type: 'number',
            id: 'depthBudget',
            label: 'Levels below the root',
            description:
              'How deep to decompose. 3 suits most projects: product, major parts, taskable pieces.',
            default: DEFAULT_DEPTH,
            min: 1,
            max: 6,
          },
          {
            type: 'number',
            id: 'breadthCap',
            label: 'Most children per node',
            description:
              'A cap, not a target. An agent that has nothing more to say leaves the node alone.',
            default: DEFAULT_BREADTH,
            min: 2,
            max: 12,
          },
        ],
      };
    },

    agentMining: {
      requiredCapabilities: ['tool_use'],
      // MCP narrowed to rag_search: an agent drafting a plan reads the repo and the
      // knowledge base (its own file tools still work) but has nothing to do with a
      // browser or a container.
      toolProfile: 'rag_only',
      timeoutMs: PLAN_AGENT_TIMEOUT_MS,
      // A single expansion can time out while its siblings finish. The all-wave
      // retry in apply() cannot recover that case, so opt into the runner's
      // per-agent transient-failure retry as well. A second failure is left for
      // 02-plan-coverage to report as a known structural loss.
      retry: { maxAttempts: 2, retryOnInvocationFailure: shouldRetryMiningTerminalFailure },

      async selectAgents({ ctx, detected, formValues }) {
        // Smokes run the whole registered list under HAIVE_TEST_BYPASS_LLM; a
        // mining dispatch there enqueues a real CLI nobody will serve and the
        // step wedges waiting_cli. Same guard every mining onboarding step
        // (09_5 et al.) carries: no agents under bypass, apply() then settles
        // immediately with an empty fold.
        if (process.env.HAIVE_TEST_BYPASS_LLM === '1') return [];
        if (!detected || !(detected as PlanBuildDetect).repositoryId) return [];
        const d = detected as PlanBuildDetect;
        const repositoryId = d.repositoryId!;

        // First wave ONLY: one agent, because there is exactly one root to draft
        // and the first level has to be decided as a whole rather than by a
        // committee that cannot see each other's answers. Every later wave is
        // dispatched from apply() via MiningWaveError — the engine re-runs
        // selectAgents only while no mining row exists.
        const root = await findPlanRoot(ctx.db, repositoryId);
        if (root) return [];
        return [
          {
            agentId: 'plan-root',
            agentTitle: 'Plan outline',
            roleKey: 'outline',
            capabilities: planAgentCapabilities(d),
            preferVision: d.hasPdfInputs === true,
            prompt: await augmentPromptWithAttachments(
              ctx.db,
              ctx.taskId,
              buildRootPrompt(d, formValues),
            ),
          },
        ];
      },
    },

    async apply(ctx, args): Promise<PlanBuildApply> {
      const d = args.detected;
      const empty: PlanBuildApply = {
        waves: 0,
        nodeCount: 0,
        edgeCount: 0,
        frontierRemaining: 0,
        stopped: 'dispatch_failed',
        mirrorFiles: [],
        failures: [],
      };
      if (!d.repositoryId) return empty;
      const repositoryId = d.repositoryId;

      const cumulative = args.agentMiningResults ?? [];
      // ONLY the rows no previous pass folded. apply() re-runs after every wave
      // with the cumulative set; re-folding a wave would re-create its temp-ref
      // children under new ids.
      const fold = args.newAgentMiningResults ?? cumulative;
      const failures: string[] = [];

      // HEAD as the agents saw it, stamped on the code links they emit so a stale
      // one can be dated. Best-effort: a repo with no commits yet (a brand-new
      // blank one) records undated links rather than failing.
      const derivedAtCommit = await exec('git', ['rev-parse', 'HEAD'], { cwd: ctx.repoPath })
        .then((r) => r.stdout.trim())
        .catch(() => null);

      for (const result of fold) {
        if (result.status !== 'done') {
          failures.push(
            `${result.agentTitle ?? result.agentId}: ${result.errorMessage ?? 'failed'}`,
          );
          continue;
        }
        const patch = parsePlanPatch(result.output ?? result.rawOutput);
        if (!patch) {
          failures.push(`${result.agentTitle ?? result.agentId}: no patch in reply`);
          continue;
        }
        try {
          // The node this agent was expanding, recovered from its own id, so its
          // children can be parented with `self` instead of a transcribed uuid —
          // the single commonest thing an agent gets wrong.
          const expanding = EXPAND_AGENT_RE.exec(result.agentId)?.[1];
          if (patch.ops.length === 0 && !expanding) {
            throw new Error('plan outline returned no operations');
          }
          const ops = await ensureSemanticExpansionResolution(
            ctx.db,
            repositoryId,
            expanding ?? null,
            patch.ops,
          );
          await assertPlanPatchWithinBreadth(
            ctx.db,
            repositoryId,
            ops,
            expanding ?? null,
            breadthCap(args.formValues),
          );
          const applied = await applyAgentPatch(
            ctx.db,
            { ...patch, ops: withMinedStatus(ops, d.mode) },
            {
              repositoryId,
              sourceTaskId: ctx.taskId,
              derivedAtCommit,
              retryable: args.isFinalMiningAttempt !== true,
              ...(expanding ? { selfNodeId: expanding } : {}),
            },
          );
          if (applied.dropped.length > 0) {
            // A DIFFERENT prefix from the failure case, and the difference is
            // load-bearing: `askedState` re-asks a node only on "not applied",
            // and this node did get its children. Recorded so a thinner patch is
            // still visible rather than silently smaller.
            failures.push(
              `${result.agentTitle ?? result.agentId}: ${applied.dropped.length} op(s) dropped`,
            );
            await ctx.db
              .update(schema.taskStepAgentMinings)
              .set({
                errorMessage: `${PARTIAL_APPLY_PREFIX} ${applied.dropped.join('; ')}`.slice(
                  0,
                  2000,
                ),
              })
              .where(
                and(
                  eq(schema.taskStepAgentMinings.taskStepId, ctx.taskStepId),
                  eq(schema.taskStepAgentMinings.agentId, result.agentId),
                ),
              )
              .catch(() => undefined);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failures.push(`${result.agentTitle ?? result.agentId}: ${message}`);
          // Durable, on the agent's OWN row. `failures` is local to this apply
          // pass and the next wave rebuilds it, so a wave that lost nodes
          // reported clean once a later pass succeeded — MEASURED, a build that
          // dropped 12 nodes finished with `output.failures` empty. The row
          // outlives the pass, and section C reads it to re-ask the node.
          await ctx.db
            .update(schema.taskStepAgentMinings)
            .set({ errorMessage: `plan patch not applied: ${message}`.slice(0, 2000) })
            .where(
              and(
                eq(schema.taskStepAgentMinings.taskStepId, ctx.taskStepId),
                eq(schema.taskStepAgentMinings.agentId, result.agentId),
              ),
            )
            .catch((e: unknown) => {
              // Best-effort: losing the annotation must not also lose the wave.
              ctx.logger.warn(
                { err: e, agentId: result.agentId },
                'could not record apply failure',
              );
            });
        }
      }

      // Every agent of THIS wave failing leaves the wave with nothing written,
      // which is worth a re-roll; a partial failure is not, because the survivors'
      // nodes are already in the plan and re-running would duplicate them.
      if (fold.length > 0 && failures.length === fold.length && !args.isFinalMiningAttempt) {
        throw new MiningRetryError(
          fold.map((r) => r.agentId),
          `every plan agent in the wave failed: ${failures.join('; ')}`,
        );
      }

      const [nodes, edges] = await Promise.all([
        loadPlanSkeletons(ctx.db, repositoryId),
        loadPlanEdges(ctx.db, repositoryId),
      ]);
      const { asked, waves, expandDispatched } = askedState(cumulative);
      const root = nodes.find((n) => n.parentId === null) ?? null;
      // There is nothing for the coverage step to inspect or repair when the
      // outline terminal exhausted its retries before creating even the root.
      // Do not turn that into a successful zero-node plan: leave the step
      // failed so Resume can re-run the terminal.
      if (!root && cumulative.length > 0) {
        throw new Error('Plan outline did not produce a root node. Re-run the failed terminal.');
      }
      if (root) asked.add(root.id);

      const frontierAll = computeFrontier(nodes, depthBudget(args.formValues), ctx.taskId).filter(
        (n) => !asked.has(n.id),
      );
      // Failure aggregation for the output: every failed row across ALL waves,
      // recomputed from the cumulative set each pass.
      const allFailures = cumulative
        .filter((r) => r.status !== 'done')
        .map((r) => `${r.agentTitle ?? r.agentId}: ${r.errorMessage ?? 'failed'}`);

      const waveBudgetLeft = waves < MAX_WAVES;
      const nodeBudgetLeft = expandDispatched < MAX_TOTAL_EXPAND;
      // miningWaveExhausted = the runner could dispatch none of the last wave's
      // agents. Asking again would spin, so the build settles with what it has.
      const exhausted = args.miningWaveExhausted === true;

      if (frontierAll.length > 0 && waveBudgetLeft && nodeBudgetLeft && !exhausted && root) {
        const nextWave = waves + 1;
        const slice = frontierAll.slice(
          0,
          planWaveDispatchCount(frontierAll.length, expandDispatched),
        );
        // Every agent derives a bounded view from the SAME node snapshot. Exact
        // refs for its local neighborhood are always retained; the global title
        // index is compacted before provider selection, so this contract is the
        // same for every supported CLI.
        const dispatches = await Promise.all(
          slice.map(async (node) => ({
            agentId: `plan-expand-${node.id}-p${nextWave}`,
            agentTitle: `Expand: ${node.title}`,
            roleKey: 'expand',
            capabilities: planAgentCapabilities(d),
            preferVision: d.hasPdfInputs === true,
            prompt: await augmentPromptWithAttachments(
              ctx.db,
              ctx.taskId,
              buildExpandPrompt(d, args.formValues, node, buildPlanExpansionContext(nodes, node)),
            ),
          })),
        );
        throw new MiningWaveError(
          dispatches,
          `next plan level: ${dispatches.length} node(s) to expand`,
        );
      }

      const stopped: PlanBuildApply['stopped'] =
        frontierAll.length === 0
          ? 'complete'
          : exhausted
            ? 'dispatch_failed'
            : !waveBudgetLeft || !nodeBudgetLeft
              ? frontierAll.length > 0 && expandDispatched >= MAX_TOTAL_EXPAND
                ? 'node_budget'
                : 'wave_budget'
              : 'complete';

      let mirrorFiles: string[] = [];
      try {
        mirrorFiles = await writePlanMirror(ctx.db, repositoryId, ctx.repoPath);
      } catch (err) {
        // The mirror is a projection; failing to write it must not lose the plan
        // that was just built.
        ctx.logger.warn({ err }, 'plan mirror write failed (non-fatal)');
      }

      return {
        waves,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        frontierRemaining: frontierAll.length,
        stopped,
        mirrorFiles,
        failures: allFailures,
      };
    },
  };
}

/** The standalone `plan_build` task type, spawned from the plan canvas. */
export const planBuildStep = createPlanBuildStep({
  id: '01-plan-build',
  workflowType: 'plan_build',
  index: 0,
  title: 'Build the plan',
  description:
    'Decomposes a repository (from its knowledge base) or an uploaded document into a durable plan tree, one level per mining wave.',
  askForBudget: true,
});
