import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { CONFIG_KEYS, configService, type FormSchema, type FormValues } from '@haive/shared';
import { KB_DIR } from '@haive/shared/knowledge-paths';
import {
  findPlanRoot,
  loadPlanSkeletons,
  planNodeDepth,
  renderPlanMarkdown,
  type PlanNodeSkeleton,
} from '@haive/shared/plan';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { gitRun } from '../../../repo/git-push.js';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { MiningRetryError } from '../../step-definition.js';
import { augmentPromptWithAttachments } from '../../attachments-context.js';
import { writePlanMirror } from '../../../plan/mirror.js';
import { PLAN_PATCH_CONTRACT, applyAgentPatch, parsePlanPatch } from './_plan-prompt.js';

/**
 * Build a repository's plan, one LEVEL at a time.
 *
 * The level-by-level shape is not a stylistic choice. One LLM pass cannot emit a
 * four-hundred-node decomposition — the runner already has a name for that
 * failure (`truncationRetries`) — and asking for one produces a truncated JSON
 * blob rather than a shallow plan. So pass 0 produces the root plus its first
 * level, and every later pass fans out one mining agent per FRONTIER node, each
 * responsible only for its own children.
 *
 * The frontier is recomputed from the DATABASE on every pass rather than carried
 * between them: `selectAgents` is handed no iteration state, the nodes are the
 * source of truth anyway, and a re-run after a crash then resumes exactly where
 * it stopped instead of duplicating a level.
 */

const DEFAULT_DEPTH = 3;
const DEFAULT_BREADTH = 6;
/** Hard ceiling on agents dispatched in ONE pass. The agent-pool governor bounds
 *  concurrency, but nothing else bounds the WIDTH of a level, and a plan whose
 *  level 2 is 80 nodes wide would otherwise queue 80 invocations at once. */
const MAX_AGENTS_PER_PASS = 12;

type BuildMode = 'from_repo' | 'from_md';

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
}

export interface PlanBuildApply {
  pass: number;
  created: number;
  updated: number;
  linked: number;
  /** Nodes still eligible for expansion AFTER this pass. Drives shouldContinue. */
  frontierRemaining: number;
  mirrorFiles: string[];
  agentsDispatched: number;
  failures: string[];
}

function depthBudget(values: FormValues): number {
  const n = Number(values.depthBudget);
  return Number.isFinite(n) && n >= 1 && n <= 6 ? Math.floor(n) : DEFAULT_DEPTH;
}

function breadthCap(values: FormValues): number {
  const n = Number(values.breadthCap);
  return Number.isFinite(n) && n >= 2 && n <= 12 ? Math.floor(n) : DEFAULT_BREADTH;
}

/**
 * Nodes that should still be broken down.
 *
 * A node is on the frontier when it has no children, sits above the depth
 * budget, and is a `component`. The kind filter matters: a `research` or
 * `external` node is a blocker to resolve, not a system to decompose, and
 * expanding one produces invented sub-tasks for work that is waiting on a
 * person. `taskable` is excluded too — the user (or an earlier pass) has already
 * said that node is a unit of work.
 */
function computeFrontier(nodes: PlanNodeSkeleton[], maxDepth: number): PlanNodeSkeleton[] {
  const withChildren = new Set(nodes.map((n) => n.parentId).filter(Boolean) as string[]);
  return nodes.filter(
    (n) =>
      !withChildren.has(n.id) &&
      !n.taskable &&
      n.kind === 'component' &&
      n.status !== 'done' &&
      n.status !== 'not_applicable' &&
      planNodeDepth(n.path) < maxDepth,
  );
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
    'passes expand each child. Give the root a body that says what the product is for.',
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

function buildExpandPrompt(
  d: PlanBuildDetect,
  values: FormValues,
  node: PlanNodeSkeleton,
  planMarkdown: string,
): string {
  const remainingDepth = depthBudget(values) - planNodeDepth(node.path);
  return [
    `You are expanding ONE part of the plan for "${d.repoName}".`,
    '',
    'Here is the whole plan as it stands, so you can see where your part sits and avoid',
    'duplicating a sibling. Each node shows its id, kind and status.',
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
      : `You may go ${remainingDepth} level(s) deeper, but prefer ONE level now: later passes expand what you leave. Mark a child \`"taskable": true\` only when it is already small enough for a single developer task.`,
    '',
    'If this node genuinely cannot be broken down further, reply with an empty `ops` array and',
    'say so in `summary` — do NOT invent children to fill the space.',
    '',
    'Add `link` ops where this part depends on, affects, or implements something already in the',
    'plan. Those links are what later answers "if I change this, what else must change".',
    '',
    d.mode === 'from_repo'
      ? 'Where a node you name is ALREADY implemented, add `codeLinks` for the files you actually opened. Skip it for anything not built yet — a guessed path makes the impact view lie.'
      : '',
    '',
    PLAN_PATCH_CONTRACT,
  ].join('\n');
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
      const mode: BuildMode = meta.planBuildMode === 'from_md' ? 'from_md' : 'from_repo';

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

      return {
        mode,
        repositoryId,
        existingNodeCount,
        hasRoot,
        kbFiles: mode === 'from_repo' ? await listKbFiles(ctx) : [],
        brief: (task?.description ?? '').trim(),
        repoName,
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
      timeoutMs: 20 * 60 * 1000,
      retry: { maxAttempts: 2 },

      async selectAgents({ ctx, detected, formValues }) {
        if (!detected || !(detected as PlanBuildDetect).repositoryId) return [];
        const d = detected as PlanBuildDetect;
        const repositoryId = d.repositoryId!;

        const root = await findPlanRoot(ctx.db, repositoryId);
        if (!root) {
          // Pass 0. One agent, because there is exactly one root to draft and the
          // first level has to be decided as a whole rather than by a committee
          // that cannot see each other's answers.
          return [
            {
              agentId: 'plan-root',
              agentTitle: 'Plan outline',
              roleKey: 'outline',
              prompt: await augmentPromptWithAttachments(
                ctx.db,
                ctx.taskId,
                buildRootPrompt(d, formValues),
              ),
            },
          ];
        }

        const nodes = await loadPlanSkeletons(ctx.db, repositoryId);
        const frontier = computeFrontier(nodes, depthBudget(formValues)).slice(
          0,
          MAX_AGENTS_PER_PASS,
        );
        if (frontier.length === 0) return [];

        // Rendered ONCE for the whole wave: every agent gets the same view of the
        // plan, which is what stops two siblings inventing the same child.
        const planMarkdown = await renderPlanMarkdown(ctx.db, repositoryId, { titlesOnly: true });

        return Promise.all(
          frontier.map(async (node) => ({
            agentId: `plan-expand-${node.id}`,
            agentTitle: `Expand: ${node.title}`,
            roleKey: 'expand',
            prompt: await augmentPromptWithAttachments(
              ctx.db,
              ctx.taskId,
              buildExpandPrompt(d, formValues, node, planMarkdown),
            ),
          })),
        );
      },
    },

    loop: {
      maxIterations: 8,
      shouldContinue: ({ applyOutput }) => applyOutput.frontierRemaining > 0,
    },

    async apply(ctx, args): Promise<PlanBuildApply> {
      const d = args.detected;
      const empty: PlanBuildApply = {
        pass: args.iteration,
        created: 0,
        updated: 0,
        linked: 0,
        frontierRemaining: 0,
        mirrorFiles: [],
        agentsDispatched: 0,
        failures: [],
      };
      if (!d.repositoryId) return empty;
      const repositoryId = d.repositoryId;

      // HEAD as the agents saw it. Best-effort: a repo with no commits yet (a
      // brand-new blank one) simply records undated links rather than failing.
      const head = await gitRun(ctx.repoPath, ['rev-parse', 'HEAD']).catch(() => null);
      const derivedAtCommit = head?.code === 0 ? head.stdout.trim() : null;

      const results = args.agentMiningResults ?? [];
      let created = 0;
      let updated = 0;
      let linked = 0;
      const failures: string[] = [];

      for (const result of results) {
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
        // An empty ops array is a legitimate answer — "this cannot be broken down
        // further" — and must not be retried as a parse failure, or a genuinely
        // atomic node burns the whole retry budget every pass.
        if (patch.ops.length === 0) continue;
        try {
          const res = await applyAgentPatch(ctx.db, patch, {
            repositoryId,
            sourceTaskId: ctx.taskId,
            derivedAtCommit,
            // Retryable only while budget remains; on the final attempt a bad patch
            // is recorded as a failure so the other agents' work still lands.
            retryable: args.isFinalMiningAttempt !== true,
          });
          created += res.created.length;
          updated += res.updated.length;
          linked += res.linked;
        } catch (err) {
          failures.push(
            `${result.agentTitle ?? result.agentId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Every agent failing on the FIRST pass leaves no plan at all, which is worth
      // a re-roll; a partial failure is not, because the surviving agents' nodes are
      // already written and re-running would duplicate them.
      if (results.length > 0 && failures.length === results.length && !args.isFinalMiningAttempt) {
        throw new MiningRetryError(
          results.map((r) => r.agentId),
          `every plan agent failed: ${failures.join('; ')}`,
        );
      }

      const nodes = await loadPlanSkeletons(ctx.db, repositoryId);
      const frontier = computeFrontier(nodes, depthBudget(args.formValues));

      let mirrorFiles: string[] = [];
      try {
        mirrorFiles = await writePlanMirror(ctx.db, repositoryId, ctx.repoPath);
      } catch (err) {
        // The mirror is a projection; failing to write it must not lose the plan
        // that was just built.
        ctx.logger.warn({ err }, 'plan mirror write failed (non-fatal)');
      }

      return {
        pass: args.iteration,
        created,
        updated,
        linked,
        frontierRemaining: frontier.length,
        mirrorFiles,
        agentsDispatched: results.length,
        failures,
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
    'Decomposes a repository (from its knowledge base) or an uploaded document into a durable plan tree, one level per pass.',
  askForBudget: true,
});
