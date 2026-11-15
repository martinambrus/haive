import { lstatNoFollow, isResourceLimitError } from '@haive/shared/fs-safe';
import { workspaceAnchor } from '../../../repo/worktree-paths.js';
import { taskSecretMaskPolicy } from '../../../queues/cli-exec/secret-mask.js';
import { compileSecretMaskPolicy } from '../../../queues/cli-exec/secret-mask-policy.js';
import { safeInsightLocation } from './_insight-auto.js';
import { collapseToLine } from '../_untrusted-repo.js';
import { code } from './_plan-ops.js';
import type { LoadedInsight } from '@haive/shared/step';
import type { StepContext, AgentMiningDispatch, AgentMiningResult } from '../../step-definition.js';
import { MiningWaveError, ReopenStepFormError } from '../../step-definition.js';
import type { InsightItemOutcome } from './_insight-batch.js';
import { insightBatchId, loadInsightBatchRecords } from './_insight-batch.js';
import { loadDependencyPolicy, type DependencyPolicy } from './_dependency-policy.js';
import {
  INSIGHT_AUTO_ROUNDS,
  autoCandidates,
  buildClassifierPrompt,
  claimAutoRound,
  classifierId,
  loadAutoHistory,
  normalizeClassification,
  readClassification,
  saveAutoClassification,
  type AutoClaim,
  type AutoClassification,
  type AutoDecision,
  type InsightAutoLimits,
} from './_insight-auto.js';

export interface AutoDetect {
  version: 1;
  mode: 'classify' | 'manual' | 'settled';
  candidates: LoadedInsight[];
  roundsStarted: number;
  decisions: AutoDecision[];
  stopReason:
    | 'no_new_consequential'
    | 'incomplete'
    | 'cap'
    | 'interrupted'
    | 'pending_writer'
    | 'classifying';
  claim?: AutoClaim;
  dependencyPolicy?: DependencyPolicy;
  unsafeIds?: string[];
}
const unclassified = (insights: LoadedInsight[], cap: boolean): AutoDecision[] =>
  insights.map((i) => ({
    id: i.id,
    identity: i.identity,
    class: 'unclassified',
    kind: null,
    eligible: false,
    outcome: cap ? 'cap_reached' : 'needs_decision',
    reason: cap
      ? 'Discovered after the last automatic round.'
      : 'Classification incomplete; select manually.',
  }));
export async function detectAutoInsights(
  ctx: StepContext,
  insights: LoadedInsight[],
  workspace: string,
  limits: InsightAutoLimits = {},
): Promise<AutoDetect> {
  const history = await loadAutoHistory(ctx.db, ctx.taskId);
  const journal = await loadInsightBatchRecords(ctx.db, ctx.taskId);
  ctx.throwIfCancelled();
  const batchId = insightBatchId(ctx.taskStepId, ctx.rerunGeneration ?? 0);
  const ownClaim = history.claims.find((c) => c.batchId === batchId);
  const ownResult = history.results.find((c) => c.batchId === batchId);
  const decisions = history.results.flatMap((r) => r.items);
  const unconfirmed = new Set(
    journal
      .filter((r) => r.stage === 'outcome')
      .flatMap((r) =>
        r.items
          .filter((i) => i.outcome === 'unconfirmed' || i.outcome === 'not_applied')
          .map((i) => r.selected.find((s) => s.id === i.id)?.identity),
      )
      .filter((i): i is string => !!i),
  );
  const priorUnknown =
    unconfirmed.size > 0 ||
    journal.some(
      (r) =>
        r.stage === 'intent' &&
        r.batchId !== batchId &&
        !journal.some((o) => o.batchId === r.batchId && o.stage === 'outcome'),
    );
  const seen = new Set([
    ...history.claims.flatMap((c) => c.insights.map((i) => i.identity)),
    ...decisions.map((i) => i.identity),
    ...journal.flatMap((r) => r.selected.map((i) => i.identity)),
  ]);
  // A spent classifier opportunity is not a writer selection. Retry must reoffer
  // identities left between claim, result and the durable writer intent.
  const selectedIdentities = new Set(journal.flatMap((r) => r.selected.map((i) => i.identity)));
  const pendingWriter = new Set(
    [
      ...history.claims
        .filter(
          (c) => c.batchId !== batchId && !history.results.some((r) => r.batchId === c.batchId),
        )
        .flatMap((c) => c.insights.map((i) => i.identity)),
      ...decisions.filter((i) => i.class === 'consequential' && i.eligible).map((i) => i.identity),
    ].filter((identity) => !selectedIdentities.has(identity)),
  );
  const candidates = ownClaim && !ownResult ? ownClaim.insights : autoCandidates(insights, seen);
  const cap = history.claims.length >= (limits.rounds ?? INSIGHT_AUTO_ROUNDS) && !ownClaim;
  let mode: AutoDetect['mode'] =
    candidates.length && !cap && !priorUnknown ? 'classify' : 'settled';
  let stopReason: AutoDetect['stopReason'] =
    mode === 'classify'
      ? 'classifying'
      : cap
        ? 'cap'
        : priorUnknown
          ? 'interrupted'
          : 'no_new_consequential';
  if (insights.some((i) => pendingWriter.has(i.identity))) {
    mode = 'manual';
    stopReason = 'pending_writer';
  }
  // Unclassified and ineligible consequential items remain human decisions. Minor/nit items are listed only.
  const manualIdentities = new Set(
    decisions
      .filter((i) => i.class === 'unclassified' || (i.class === 'consequential' && !i.eligible))
      .map((i) => i.identity)
      .concat([...unconfirmed], [...pendingWriter]),
  );
  if (
    mode !== 'classify' &&
    ((cap && candidates.length) ||
      priorUnknown ||
      insights.some((i) => manualIdentities.has(i.identity)))
  )
    mode = 'manual';
  if (ownResult && !ownResult.complete) {
    mode = 'manual';
    stopReason = ownResult.items.some((i) => i.outcome === 'cap_reached') ? 'cap' : 'incomplete';
  }
  const pending =
    mode === 'manual'
      ? insights.filter(
          (i) =>
            manualIdentities.has(i.identity) ||
            candidates.some((c) => c.identity === i.identity) ||
            (priorUnknown &&
              !decisions.some(
                (d) => d.identity === i.identity && (d.class === 'minor' || d.class === 'nit'),
              )),
        )
      : candidates;
  const state: AutoDetect = {
    version: 1,
    mode,
    candidates: pending,
    roundsStarted: history.claims.length,
    decisions,
    stopReason,
    ...(ownClaim ? { claim: ownClaim } : {}),
  };
  if (mode === 'classify') {
    // A baseline read failure establishes no edit authority; keep the classification read-only.
    try {
      state.dependencyPolicy = await loadDependencyPolicy(ctx, workspace);
      const secrets = await taskSecretMaskPolicy(ctx.db, ctx.taskId);
      if (!secrets) state.dependencyPolicy = undefined;
      else {
        const denies = compileSecretMaskPolicy(secrets, { nocase: true });
        const { anchor, prefix } = workspaceAnchor(workspace);
        state.unsafeIds = [];
        for (const i of candidates) {
          ctx.throwIfCancelled();
          const file = safeInsightLocation(i.location);
          const info = file && !denies(file) ? await lstatNoFollow(anchor, prefix + file) : null;
          if (info?.kind !== 'file') state.unsafeIds.push(i.id);
        }
      }
    } catch (err) {
      if (isResourceLimitError(err)) throw err;
      ctx.throwIfCancelled();
      state.dependencyPolicy = undefined;
    }
    try {
      buildClassifierPrompt(candidates, limits.inputChars);
    } catch {
      state.mode = 'manual';
      state.stopReason = 'incomplete';
      const result = await saveAutoClassification(ctx, {
        version: 1,
        batchId,
        sourceStepRowId: ctx.taskStepId,
        generation: ctx.rerunGeneration ?? 0,
        complete: false,
        items: unclassified(candidates, false),
        invocationIds: [],
      });
      state.decisions.push(...result.items);
    }
  } else if (cap && candidates.length) {
    const result = await saveAutoClassification(ctx, {
      version: 1,
      batchId,
      sourceStepRowId: ctx.taskStepId,
      generation: ctx.rerunGeneration ?? 0,
      complete: false,
      items: unclassified(candidates, true),
      invocationIds: [],
    });
    state.decisions.push(...result.items);
  }
  return state;
}
export function triageDispatch(claim: AutoClaim, attempt: 1 | 2): AgentMiningDispatch {
  return {
    agentId: classifierId(claim.batchId, attempt),
    agentTitle: 'Classify optional improvements',
    roleKey: 'triage',
    capabilities: [],
    prompt: buildClassifierPrompt(claim.insights, undefined, claim.batchId),
  };
}
export async function startAutoClassification(
  ctx: StepContext,
  state: AutoDetect,
  limits: InsightAutoLimits = {},
): Promise<AgentMiningDispatch[]> {
  if (state.mode !== 'classify') return [];
  const claim = await claimAutoRound(ctx, state.candidates, limits);
  ctx.throwIfCancelled();
  return claim ? [triageDispatch(claim, 1)] : [];
}
export async function finishAutoClassification(
  ctx: StepContext,
  state: AutoDetect,
  results: AgentMiningResult[],
  exhausted: boolean,
  limits: InsightAutoLimits = {},
): Promise<{ claim: AutoClaim; result: AutoClassification } | null> {
  const history = await loadAutoHistory(ctx.db, ctx.taskId);
  const batchId = insightBatchId(ctx.taskStepId, ctx.rerunGeneration ?? 0);
  const claim = history.claims.find((c) => c.batchId === batchId);
  if (!claim) {
    await saveAutoClassification(ctx, {
      version: 1,
      batchId,
      sourceStepRowId: ctx.taskStepId,
      generation: ctx.rerunGeneration ?? 0,
      complete: false,
      items: unclassified(state.candidates, false),
      invocationIds: [],
    });
    throw new ReopenStepFormError(
      'Automatic insight admission was held. Review the improvements manually.',
      { notice: true },
    );
  }
  let result = history.results.find((r) => r.batchId === batchId);
  if (result) return { claim, result };
  const second = results.find((r) => r.agentId === classifierId(batchId, 2));
  const first = results.find((r) => r.agentId === classifierId(batchId, 1));
  const latest = second ?? first;
  const items =
    latest?.status === 'done'
      ? readClassification(
          latest.rawOutput ?? latest.output,
          claim.insights.map((i) => i.id),
          batchId,
          limits.outputChars,
        )
      : null;
  if (!items && !second && first && !exhausted && first.status === 'done')
    throw new MiningWaveError([triageDispatch(claim, 2)]);
  const decisions = items
    ? normalizeClassification(claim.insights, items, state.dependencyPolicy).map((i) =>
        state.unsafeIds?.includes(i.id)
          ? {
              ...i,
              eligible: false,
              outcome: i.class === 'consequential' ? ('needs_decision' as const) : i.outcome,
            }
          : i,
      )
    : unclassified(claim.insights, false);
  result = await saveAutoClassification(ctx, {
    version: 1,
    batchId,
    sourceStepRowId: ctx.taskStepId,
    generation: ctx.rerunGeneration ?? 0,
    complete: !!items,
    items: decisions,
    invocationIds: results
      .filter((r) => r.agentId.startsWith(`triage-${batchId}-`) && r.invocationId)
      .map((r) => r.invocationId!),
  });
  return { claim, result };
}
export function automaticSelection(claim: AutoClaim, result: AutoClassification): LoadedInsight[] {
  if (!result.complete) return [];
  return claim.insights.filter((i) =>
    result.items.some((c) => c.id === i.id && c.class === 'consequential' && c.eligible),
  );
}

/** Bounded classification copy is separate from a claim that any repair was verified. */
export function autoInsightReport(
  insights: readonly { id: string; identity?: string; title: string; location: string }[],
  decisions: readonly AutoDecision[],
  reports: readonly InsightItemOutcome[] = [],
): string {
  return insights
    .map((i) => {
      const d = decisions.find((d) => d.id === i.id || d.identity === i.identity);
      const report = reports.find((r) => r.id === i.id || r.id === d?.id);
      const outcome = report ? `${report.outcome} (agent report)` : (d?.outcome ?? 'unconfirmed');
      return `- ${code(collapseToLine(i.title))}${i.location ? ` (${code(collapseToLine(i.location))})` : ''}: **${d?.class ?? 'unclassified'}**${d?.kind ? ` / ${d.kind}` : ''} — ${outcome}`;
    })
    .join('\n');
}

export function assertAutoVersion(state: AutoDetect | undefined): void {
  if (state && (state.version !== 1 || !['classify', 'manual', 'settled'].includes(state.mode)))
    throw new Error('Unsupported automatic insight protocol version or stage.');
}
