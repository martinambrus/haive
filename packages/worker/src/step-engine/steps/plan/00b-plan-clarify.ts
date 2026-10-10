import { and, asc, eq, isNull } from 'drizzle-orm';
import { schema } from '@haive/database';
import { CONFIG_KEYS, configService } from '@haive/shared';
import { PlanPatchError, findPlanRoot, renderPlanMarkdown } from '@haive/shared/plan';
import type {
  AgentMiningDispatch,
  AgentMiningResult,
  StepContext,
  StepDefinition,
} from '../../step-definition.js';
import { MiningRetryError, MiningWaveError, ReopenStepFormError } from '../../step-definition.js';
import { shouldRetryMiningTerminalFailure } from '../../mining-failure.js';
import { writePlanMirror } from '../../../plan/mirror.js';
import {
  PLAN_AGENT_TIMEOUT_MS,
  buildRootPrompt,
  partialApplyNote,
  planAgentCapabilities,
  planBuildStep,
  withLiveInputs,
  withMinedStatus,
  type PlanBuildDetect,
} from './01-plan-build.js';
import { applyAgentPatch, applyAgentPatchOnce, parsePlanPatch } from './_plan-prompt.js';
import {
  OUTLINE_AGENT_ID,
  askAgentId,
  askRoundOf,
  buildAskPrompt,
  buildClarifyForm,
  buildIntegratePrompt,
  hasContent,
  integrateAgentId,
  integrateRoundOf,
  nextMove,
  outlineExtraLines,
  outsideOutline,
  parseQuestions,
  parseVerdicts,
  readRoundAnswers,
  type ClarifyAnswer,
  type ClarifyMove,
  type ClarifyOutcome,
  type ClarifyQuestion,
  type ClarifyRound,
} from './_plan-clarify.js';

/**
 * Clarifying questions before a plan is broken down.
 *
 * The planner drafts an outline from what the inputs actually say, with every assumption and
 * conflict left open as a `decision` node; a questioner asks the owner about it; the planner
 * folds the answers in and says which are still unclear, and those are asked again. The owner
 * ends it, and 01-plan-build expands the outline they shaped.
 *
 * Mining-only, cycling the way 02-plan-coverage does: each agent is a wave thrown from apply()
 * and each round's form is a `ReopenStepFormError`. A self-targeting reviseLoop (plan chat's
 * shape) would reset the step every turn, which deletes every round's agent rows and drops
 * their spend from the statistics. The rounds live in `plan_clarify_rounds`, which neither a
 * reopen nor a Retry clears, and every decision below is made from that table and the plan
 * root, so any pass resumes where the conversation stands.
 *
 * Planner and questioner are separate seats (`STEP_MINING_SEATS`), so each can run on its own
 * CLI. Every final agent failure fails the step: Retry resumes at the same move, and Skip
 * hands an unfinished outline to 01, which drafts a root itself when there is none.
 */

interface PlanClarifyDetect {
  build: PlanBuildDetect;
  hasRoot: boolean;
  rounds: ClarifyRound[];
}

interface PlanClarifyApply {
  rounds: number;
  outcome: 'built' | 'skipped';
}

async function loadRounds(ctx: StepContext): Promise<ClarifyRound[]> {
  const rows = await ctx.db
    .select()
    .from(schema.planClarifyRounds)
    .where(eq(schema.planClarifyRounds.taskId, ctx.taskId))
    .orderBy(asc(schema.planClarifyRounds.round));
  return rows.map((r) => ({
    round: r.round,
    questions: r.questions as ClarifyQuestion[],
    nothingOpen: r.nothingOpen,
    answers: (r.answers as ClarifyAnswer[] | null) ?? null,
    steer: r.steer,
    action: r.action === 'build' || r.action === 'continue' ? r.action : null,
    answered: r.answeredAt !== null,
    outcome: (r.outcome as ClarifyOutcome | null) ?? null,
    integrated: r.integratedAt !== null,
  }));
}

async function planView(ctx: StepContext, repositoryId: string): Promise<string> {
  return renderPlanMarkdown(ctx.db, repositoryId, { withVersions: true });
}

async function dispatchFor(
  ctx: StepContext,
  d: PlanClarifyDetect,
  move: ClarifyMove,
  rounds: ClarifyRound[],
): Promise<AgentMiningDispatch | null> {
  const repositoryId = d.build.repositoryId!;
  const live = await withLiveInputs(ctx, d.build);
  const common = {
    capabilities: planAgentCapabilities(live),
    preferVision: live.hasPdfInputs === true,
  };
  switch (move.kind) {
    case 'outline':
      return {
        ...common,
        agentId: OUTLINE_AGENT_ID,
        agentTitle: 'Plan outline',
        roleKey: 'planner',
        prompt: buildRootPrompt(live, {}, outlineExtraLines(live)),
      };
    case 'ask':
      return {
        ...common,
        agentId: askAgentId(move.round),
        agentTitle: `Questions, round ${move.round}`,
        roleKey: 'questioner',
        prompt: buildAskPrompt(live, await planView(ctx, repositoryId), rounds),
      };
    case 'integrate':
      return {
        ...common,
        agentId: integrateAgentId(move.round),
        agentTitle: `Answers, round ${move.round}`,
        roleKey: 'planner',
        prompt: buildIntegratePrompt(
          live,
          await planView(ctx, repositoryId),
          rounds,
          rounds.find((r) => r.round === move.round)!,
        ),
      };
    default:
      return null;
  }
}

/** A reply apply could not use: re-roll it while the budget lasts, then fail the step. */
function unusable(result: AgentMiningResult, finalAttempt: boolean, reason: string): never {
  if (!finalAttempt) throw new MiningRetryError([result.agentId], reason);
  throw new Error(`${result.agentTitle ?? result.agentId}: ${reason}`);
}

/** Folds a planner reply, turning a refused patch into a re-roll. A version conflict is not one:
 *  a person edited the plan meanwhile, and a Retry sends the planner the plan as it is now. */
async function foldPatch(
  result: AgentMiningResult,
  finalAttempt: boolean,
  fold: () => Promise<unknown>,
): Promise<void> {
  try {
    await fold();
  } catch (err) {
    if (!(err instanceof PlanPatchError)) throw err;
    if (err.kind === 'conflict') {
      throw new Error(
        'The plan was edited while the planner was working on it. Retry this step to fold the answers into the plan as it is now.',
      );
    }
    unusable(result, finalAttempt, `the plan patch was refused: ${err.message}`);
  }
}

async function foldOutline(
  ctx: StepContext,
  d: PlanClarifyDetect,
  result: AgentMiningResult,
  finalAttempt: boolean,
): Promise<void> {
  const patch = parsePlanPatch(result.output ?? result.rawOutput);
  if (!patch || patch.ops.length === 0) unusable(result, finalAttempt, 'no outline in the reply');
  const { kept, dropped } = outsideOutline(patch.ops, null);
  await foldPatch(result, finalAttempt, () =>
    applyAgentPatchOnce(
      ctx,
      result.agentId,
      (tx) =>
        applyAgentPatch(
          tx,
          { ...patch, ops: withMinedStatus(kept, d.build.mode) },
          { repositoryId: d.build.repositoryId!, sourceTaskId: ctx.taskId },
        ),
      (applied) => partialApplyNote([...dropped, ...applied.dropped]),
    ),
  );
  if (!(await findPlanRoot(ctx.db, d.build.repositoryId!))) {
    unusable(result, finalAttempt, 'the outline created no root node');
  }
}

async function foldQuestions(
  ctx: StepContext,
  result: AgentMiningResult,
  round: number,
  finalAttempt: boolean,
): Promise<void> {
  const parsed = parseQuestions(result.output ?? result.rawOutput);
  if (!parsed) unusable(result, finalAttempt, 'no questions in the reply');
  await applyAgentPatchOnce(
    ctx,
    result.agentId,
    async (tx) => {
      await tx.insert(schema.planClarifyRounds).values({
        taskId: ctx.taskId,
        round,
        questions: parsed.questions,
        nothingOpen: parsed.nothingOpen,
      });
    },
    () => null,
  );
}

async function foldAnswers(
  ctx: StepContext,
  d: PlanClarifyDetect,
  result: AgentMiningResult,
  round: ClarifyRound,
  finalAttempt: boolean,
): Promise<void> {
  const raw = result.output ?? result.rawOutput;
  const patch = parsePlanPatch(raw);
  if (!patch) unusable(result, finalAttempt, 'no plan patch in the reply');
  const root = await findPlanRoot(ctx.db, d.build.repositoryId!);
  const { kept, dropped } = outsideOutline(patch.ops, root?.id ?? null);
  await foldPatch(result, finalAttempt, () =>
    applyAgentPatchOnce(
      ctx,
      result.agentId,
      async (tx) => {
        const applied = await applyAgentPatch(
          tx,
          { ...patch, ops: kept },
          { repositoryId: d.build.repositoryId!, sourceTaskId: ctx.taskId },
        );
        const outcome: ClarifyOutcome = {
          summary: patch.summary ?? '',
          verdicts: parseVerdicts(raw, round.answers ?? []),
          dropped: [...dropped, ...applied.dropped],
        };
        await tx
          .update(schema.planClarifyRounds)
          .set({ outcome, integratedAt: new Date() })
          .where(
            and(
              eq(schema.planClarifyRounds.taskId, ctx.taskId),
              eq(schema.planClarifyRounds.round, round.round),
              isNull(schema.planClarifyRounds.integratedAt),
            ),
          );
        return applied;
      },
      (applied) => partialApplyNote([...dropped, ...applied.dropped]),
    ),
  );
}

/** Records a submitted round once: a redelivered submit finds `answered_at` already set. A round
 *  with nothing in it has nothing for the planner, so it is integrated in the same write. */
async function recordAnswers(
  ctx: StepContext,
  round: number,
  submitted: NonNullable<ReturnType<typeof readRoundAnswers>>,
): Promise<void> {
  const now = new Date();
  await ctx.db
    .update(schema.planClarifyRounds)
    .set({
      answers: submitted.answers,
      steer: submitted.steer,
      action: submitted.action,
      answeredAt: now,
      ...(hasContent(submitted) ? {} : { integratedAt: now }),
    })
    .where(
      and(
        eq(schema.planClarifyRounds.taskId, ctx.taskId),
        eq(schema.planClarifyRounds.round, round),
        isNull(schema.planClarifyRounds.answeredAt),
      ),
    );
}

export const planClarifyStep: StepDefinition<PlanClarifyDetect, PlanClarifyApply> = {
  metadata: {
    id: '00b-plan-clarify',
    workflowType: 'plan_build',
    // Between 00-plan-inputs (-1) and 01-plan-build (0): it needs the prepared inputs, and 01
    // must find the outline it shaped.
    index: -0.5,
    title: 'Clarifying questions',
    description:
      'Drafts an outline from what the inputs state, asks you about what they leave open, and folds your answers in until you choose to build the plan.',
    requiresCli: true,
    allowSkip: true,
  },

  async shouldRun(ctx): Promise<boolean> {
    if ((await configService.getBoolean(CONFIG_KEYS.PLAN_CANVAS_ENABLED, true)) === false) {
      return false;
    }
    const [task] = await ctx.db
      .select({ metadata: schema.tasks.metadata })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, ctx.taskId))
      .limit(1);
    return (task?.metadata as { planClarify?: unknown } | null)?.planClarify === true;
  },

  async detect(ctx): Promise<PlanClarifyDetect> {
    const build = await planBuildStep.detect!(ctx);
    return { build, hasRoot: build.hasRoot, rounds: await loadRounds(ctx) };
  },

  form(_ctx, detected) {
    return buildClarifyForm(detected.rounds);
  },

  agentMining: {
    requiredCapabilities: ['tool_use'],
    toolProfile: 'rag_only',
    timeoutMs: PLAN_AGENT_TIMEOUT_MS,
    retry: { maxAttempts: 2, retryOnInvocationFailure: shouldRetryMiningTerminalFailure },
    async selectAgents({ ctx, detected }) {
      if (process.env.HAIVE_TEST_BYPASS_LLM === '1') return [];
      const d = detected as PlanClarifyDetect | null;
      if (!d?.build.repositoryId) return [];
      const dispatch = await dispatchFor(ctx, d, nextMove(d.hasRoot, d.rounds), d.rounds);
      return dispatch ? [dispatch] : [];
    },
  },

  async apply(ctx, args): Promise<PlanClarifyApply> {
    const d = args.detected;
    if (process.env.HAIVE_TEST_BYPASS_LLM === '1' || !d.build.repositoryId) {
      return { rounds: 0, outcome: 'skipped' };
    }
    const repositoryId = d.build.repositoryId;
    const finalAttempt = args.isFinalMiningAttempt !== false;

    for (const result of args.newAgentMiningResults ?? args.agentMiningResults ?? []) {
      if (result.status !== 'done') {
        unusable(result, finalAttempt, result.errorMessage ?? 'the agent failed');
      }
      const askRound = askRoundOf(result.agentId);
      const integrateRound = integrateRoundOf(result.agentId);
      if (result.agentId === OUTLINE_AGENT_ID) {
        await foldOutline(ctx, d, result, finalAttempt);
      } else if (askRound !== null) {
        await foldQuestions(ctx, result, askRound, finalAttempt);
      } else if (integrateRound !== null) {
        const round = (await loadRounds(ctx)).find((r) => r.round === integrateRound);
        if (round) await foldAnswers(ctx, d, result, round, finalAttempt);
      }
    }

    let rounds = await loadRounds(ctx);
    const open = rounds.at(-1);
    if (open && !open.answered) {
      const submitted = readRoundAnswers(open, args.formValues ?? {});
      if (!submitted) throw new ReopenStepFormError(`round ${open.round} awaits answers`);
      await recordAnswers(ctx, open.round, submitted);
      rounds = await loadRounds(ctx);
    }

    const hasRoot = (await findPlanRoot(ctx.db, repositoryId)) !== null;
    const move = nextMove(hasRoot, rounds);
    if (move.kind === 'form') throw new ReopenStepFormError(`round ${move.round} awaits answers`);
    if (move.kind === 'done') {
      try {
        await writePlanMirror(ctx.db, repositoryId, ctx.repoPath);
      } catch (err) {
        ctx.logger.warn({ err }, 'plan mirror write failed after clarifying questions');
      }
      return { rounds: rounds.length, outcome: 'built' };
    }
    if (args.miningWaveExhausted === true) {
      throw new Error(`Could not start the next agent (${move.kind}); retry this step.`);
    }
    const dispatch = await dispatchFor(ctx, { ...d, hasRoot, rounds }, move, rounds);
    throw new MiningWaveError([dispatch!], `clarify: ${move.kind}`);
  },
};
