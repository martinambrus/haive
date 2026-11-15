import { INSIGHTS_AT_GATE } from '@haive/shared';
import type { InsightSummary, LoadedInsight } from '@haive/shared/step';
import type { InsightBatchRecord } from './_insight-batch.js';
import { loadInsightBatchRecords } from './_insight-batch.js';
import {
  INSIGHT_AUTO_ROUNDS,
  loadAutoHistory,
  insightAutoEnabled,
  type AutoDecision,
} from './_insight-auto.js';
import type { StepContext } from '../../step-definition.js';
import { asPlainText } from './_similar-sites.js';
import { collapseToLine } from '../_untrusted-repo.js';
const clip = (s: string) => collapseToLine(s).slice(0, 200);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Pure, stable projection. Journal stages are folded once per batch; absence of checks proves nothing. */
export function buildInsightSummary(
  insights: readonly LoadedInsight[],
  decisions: readonly AutoDecision[],
  journal: readonly InsightBatchRecord[],
  automatic: boolean,
  options: { offset?: number; limit?: number; attemptLimit?: number; roundsStarted?: number } = {},
): InsightSummary {
  const {
    offset = 0,
    limit = INSIGHTS_AT_GATE,
    attemptLimit = INSIGHTS_AT_GATE,
    roundsStarted = 0,
  } = options;
  for (const value of [offset, limit, attemptLimit])
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError('Invalid insight summary page.');
  const groups = new Map<string, LoadedInsight[]>();
  for (const i of insights) groups.set(i.identity, [...(groups.get(i.identity) ?? []), i]);
  const identities = [...groups.keys()].sort(compare);
  const items = identities.slice(offset, offset + limit).map((identity) => {
    const occurrences = groups.get(identity)!.sort((a, b) => compare(a.id, b.id));
    const i = occurrences[0]!;
    const decision = decisions.filter((d) => d.identity === identity).at(-1);
    const batches = new Map<string, InsightBatchRecord>();
    const rank = { intent: 0, reservation: 1, invocation: 2, outcome: 3 };
    for (const r of journal)
      if (
        r.selected.some((s) => s.identity === identity) &&
        (!batches.has(r.batchId) || rank[r.stage] > rank[batches.get(r.batchId)!.stage])
      )
        batches.set(r.batchId, r);
    // Callers supply journal chronology. Map insertion order keeps the first stage's order.
    const attempts = [...batches.values()].flatMap((r) =>
      r.selected
        .filter((s) => s.identity === identity)
        .sort((a, b) => compare(a.id, b.id))
        .map((s) => {
          const reported = r.items.find((item) => item.id === s.id);
          return {
            insightId: s.id,
            batchId: r.batchId,
            mode: r.mode,
            invocationId: r.invocationId,
            reportedOutcome:
              r.stage === 'outcome' ? (reported?.outcome ?? 'unconfirmed') : 'unconfirmed',
          };
        }),
    );
    const last = attempts.at(-1);
    const lastOutcomes = new Set(
      attempts.filter((a) => a.batchId === last?.batchId).map((a) => a.reportedOutcome),
    );
    const outcome = last
      ? lastOutcomes.size > 1
        ? 'mixed'
        : last.reportedOutcome
      : occurrences.some((i) => i.picked)
        ? 'unconfirmed'
        : (decision?.outcome ??
          (automatic && roundsStarted >= INSIGHT_AUTO_ROUNDS ? 'cap_reached' : 'not_selected'));
    return {
      id: i.id,
      identity: clip(identity),
      title: clip(i.title),
      location: clip(i.location),
      description: clip(i.description),
      occurrences: occurrences.length,
      sourceRefs: [
        ...new Map(
          occurrences.flatMap((i) => i.sourceRefs ?? []).map((ref) => [JSON.stringify(ref), ref]),
        ).entries(),
      ]
        .sort(([a], [b]) => compare(a, b))
        .slice(0, INSIGHTS_AT_GATE)
        .map(([, ref]) => ref),
      sourceRefsOmitted: Math.max(
        0,
        new Set(occurrences.flatMap((i) => i.sourceRefs ?? []).map((ref) => JSON.stringify(ref)))
          .size - INSIGHTS_AT_GATE,
      ),
      class: decision?.class ?? 'unclassified',
      kind: decision?.kind ?? null,
      reason: clip(decision?.reason ?? ''),
      outcome,
      attempts: attemptLimit === 0 ? [] : attempts.slice(-attemptLimit),
      attemptsOmitted: Math.max(0, attempts.length - attemptLimit),
    };
  });
  return {
    version: 1,
    automatic,
    roundsStarted,
    stopReason: !automatic
      ? 'disabled'
      : roundsStarted >= INSIGHT_AUTO_ROUNDS
        ? 'cap'
        : decisions.some((d) => d.class === 'unclassified')
          ? 'incomplete'
          : 'no_new_consequential',
    totals: {
      identities: identities.length,
      occurrences: insights.length,
      picked: insights.filter((i) => i.picked).length,
    },
    offset,
    omitted: identities.length - items.length,
    items,
  };
}
export async function loadInsightSummary(ctx: StepContext, insights: LoadedInsight[], offset = 0) {
  const history = await loadAutoHistory(ctx.db, ctx.taskId);
  const journal = await loadInsightBatchRecords(ctx.db, ctx.taskId);
  const automatic = await insightAutoEnabled(ctx.db, ctx.taskId);
  ctx.throwIfCancelled();
  return buildInsightSummary(
    insights,
    history.results.flatMap((r) => r.items),
    journal,
    automatic,
    { offset, roundsStarted: history.claims.length },
  );
}
export function insightSummaryMarkdown(summary: InsightSummary): string {
  return [
    `${summary.totals.identities} insights (${summary.totals.occurrences} occurrences); ${summary.roundsStarted} automatic rounds started.`,
    'Classes and application outcomes are agent reports. Check absence never proves a repair.',
    ...summary.items.map(
      (i) =>
        `- **${asPlainText(i.title)}** (${asPlainText(i.location)}) — ${i.class}; ${i.outcome}. ${asPlainText(i.reason)}\n  ${i.attempts.length ? i.attempts.map((a) => `${a.mode}: ${a.reportedOutcome} (item ${asPlainText(a.insightId)}, batch ${asPlainText(a.batchId)})`).join('; ') : 'No recorded attempt.'}${i.attemptsOmitted ? ` ${i.attemptsOmitted} earlier attempts in task events.` : ''}`,
    ),
    ...(summary.omitted
      ? [
          `${summary.omitted} more not shown on this page; use the insight page selector. Full attempt records are in task events.`,
        ]
      : []),
  ].join('\n\n');
}

/** Full source details are separate from the clipped form DTO. Chunk before escaping
 * so each report entry has a fixed character bound without dropping any source text. */
export function insightOccurrenceReportEntries(
  insights: readonly LoadedInsight[],
  chunkChars = 2_000,
): string[] {
  if (!Number.isSafeInteger(chunkChars) || chunkChars < 1)
    throw new RangeError('Invalid insight report entry bound.');
  return [...insights]
    .sort((a, b) => compare(a.identity, b.identity) || compare(a.id, b.id))
    .flatMap((item) => {
      const source = [
        `Occurrence: ${item.id}`,
        `Identity: ${item.identity}`,
        `Title: ${item.title}`,
        `Location: ${item.location}`,
        `Description: ${item.description}`,
        `Source step: ${item.sourceStep}`,
        ...[...new Set((item.sourceRefs ?? []).map((ref) => JSON.stringify(ref)))]
          .sort(compare)
          .map((ref) => `Source reference: ${ref}`),
      ].join('\n\n');
      const parts = Math.ceil(source.length / chunkChars);
      return Array.from(
        { length: parts },
        (_, n) =>
          `**Occurrence detail (part ${n + 1}/${parts})**\n\n${asPlainText(source.slice(n * chunkChars, (n + 1) * chunkChars))}`,
      );
    });
}

/** Immutable complete report, paged on read; only its id enters form/step polling copies. */
export async function persistInsightReport(ctx: StepContext): Promise<string> {
  const { loadUnactedInsights } = await import('./_insight-loader.js');
  const { schema } = await import('@haive/database');
  const { and, eq, isNull, notInArray } = await import('drizzle-orm');
  const { lockOwnedStep, StepSupersededError } = await import('../../step-ownership.js');
  const inventory = await loadUnactedInsights(ctx.db, ctx.taskId, { includePicked: true });
  const history = await loadAutoHistory(ctx.db, ctx.taskId);
  const journal = await loadInsightBatchRecords(ctx.db, ctx.taskId);
  const automatic = await insightAutoEnabled(ctx.db, ctx.taskId);
  const summary = buildInsightSummary(
    inventory.insights,
    history.results.flatMap((r) => r.items),
    journal,
    automatic,
    {
      limit: inventory.insights.length,
      attemptLimit: journal.reduce((n, record) => n + record.selected.length, 0),
      roundsStarted: history.claims.length,
    },
  );
  const entries = summary.items.flatMap((item) => [
    `### ${asPlainText(item.title)} (${asPlainText(item.location)})\n\n${item.class}; ${item.outcome}. ${asPlainText(item.reason)}\n\n${asPlainText(item.description)}\n\n${item.occurrences} occurrence(s). ${item.attempts.length ? `${item.attempts.length} recorded attempt(s) follow.` : 'No recorded attempt.'}`,
    ...item.attempts.map(
      (attempt) =>
        `**${asPlainText(item.title)}** — ${attempt.mode}: ${attempt.reportedOutcome} for ${asPlainText(attempt.insightId)}. Batch ${asPlainText(attempt.batchId)}${attempt.invocationId ? `; invocation ${asPlainText(attempt.invocationId)}` : ''}. Application is an agent report; consult verification and review rows for check evidence.`,
    ),
  ]);
  ctx.throwIfCancelled();
  return ctx.db.transaction(async (tx) => {
    if (!(await lockOwnedStep(tx, ctx.taskStepId))) throw new StepSupersededError(ctx.taskStepId);
    const source = await tx.query.taskSteps.findFirst({
      where: eq(schema.taskSteps.id, ctx.taskStepId),
    });
    if (
      !source ||
      source.taskId !== ctx.taskId ||
      source.rerunGeneration !== (ctx.rerunGeneration ?? 0)
    )
      throw new StepSupersededError(ctx.taskStepId);
    const [task] = await tx
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.id, ctx.taskId),
          eq(schema.tasks.userId, ctx.userId),
          ...(ctx.epoch == null ? [] : [eq(schema.tasks.orchestrationEpoch, ctx.epoch)]),
          isNull(schema.tasks.deadAt),
          notInArray(schema.tasks.status, ['failed', 'cancelled', 'completed']),
        ),
      )
      .for('share');
    if (!task) throw new StepSupersededError(ctx.taskStepId);
    const existing = await tx.query.taskEvents.findMany({
      where: and(
        eq(schema.taskEvents.taskId, ctx.taskId),
        eq(schema.taskEvents.taskStepId, ctx.taskStepId),
        eq(schema.taskEvents.eventType, 'task.markdown_report'),
      ),
    });
    const saved = existing.find(
      (e) => e.payload?.version === 1 && e.payload?.generation === source.rerunGeneration,
    );
    if (saved) return saved.id;
    ctx.throwIfCancelled();
    const [report] = await tx
      .insert(schema.taskEvents)
      .values({
        taskId: ctx.taskId,
        taskStepId: ctx.taskStepId,
        eventType: 'task.markdown_report',
        payload: {
          version: 1,
          generation: source.rerunGeneration,
          title: 'Insight summary',
          items: [
            `${summary.totals.identities} insights (${summary.totals.occurrences} occurrences); ${summary.roundsStarted} automatic rounds started. Classes and application outcomes are agent reports; check absence never proves repair.`,
            ...entries,
            ...insightOccurrenceReportEntries(inventory.insights),
          ],
        },
      })
      .returning({ id: schema.taskEvents.id });
    return report!.id;
  });
}
