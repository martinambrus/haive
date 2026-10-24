import { and, eq, isNull, ne } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger, resolveContextWindow } from '@haive/shared';

const log = logger.child({ module: 'step-context-usage' });

/**
 * Surface B: freeze the step's context-window usage at completion (display-only audit
 * trail pinned to the finished step's title row).
 *
 * Records the PEAK prompt-side tokens of any ONE model request over the step's live CLI
 * invocations (token_usage.peakPromptTokens) against the model's context window: the
 * OpenRouter catalog's figure, else the window the peak invocation's CLI reported
 * (token_usage.contextWindow), else the static table. The provider/model come from the
 * peak invocation's own cliProviderId. When that invocation reported no per-request
 * figure the context columns stay null; the allowance stamps are still written.
 *
 * Best-effort: skips deterministic steps (no CLI usage -> nothing is written) and is called
 * inside a .catch() at the finalize so it never fails a step.
 *
 * Returns the provider id whose allowance this step consumed (the peak invocation's),
 * or null for a deterministic step — the caller uses it to refresh the usage meters.
 */
export async function writeStepContextUsage(db: Database, stepId: string): Promise<string | null> {
  const invs = await db
    .select({
      tokenUsage: schema.cliInvocations.tokenUsage,
      cliProviderId: schema.cliInvocations.cliProviderId,
    })
    .from(schema.cliInvocations)
    .where(
      and(
        eq(schema.cliInvocations.taskStepId, stepId),
        isNull(schema.cliInvocations.supersededAt),
        ne(schema.cliInvocations.mode, 'agent_mining'),
      ),
    );

  // The stored totals are a SELECTION WEIGHT only (they name whose allowance the step used)
  // and are never shown.
  let weight = 0;
  let peak = 0;
  let peakProviderId: string | null = null;
  let peakWindow: number | null = null;
  for (const r of invs) {
    const tu = r.tokenUsage;
    if (!tu) continue;
    const reported =
      typeof tu.peakPromptTokens === 'number' && tu.peakPromptTokens > 0 ? tu.peakPromptTokens : 0;
    const prompt =
      reported > 0
        ? reported
        : (tu.inputTokens ?? 0) + (tu.cacheReadTokens ?? 0) + (tu.cacheCreationTokens ?? 0);
    if (prompt > weight) {
      weight = prompt;
      peak = reported;
      peakProviderId = r.cliProviderId;
      peakWindow =
        typeof tu.contextWindow === 'number' &&
        Number.isFinite(tu.contextWindow) &&
        tu.contextWindow > 0
          ? tu.contextWindow
          : null;
    }
  }
  if (weight <= 0) return null; // deterministic step / no usable token data -> leave columns null

  let providerName: string | null = null;
  let model: string | null = null;
  let usageFiveHourPct: number | null = null;
  let usageSevenDayPct: number | null = null;
  let usageDailyPct: number | null = null;
  if (peakProviderId) {
    const p = await db.query.cliProviders.findFirst({
      where: eq(schema.cliProviders.id, peakProviderId),
      columns: { name: true, model: true },
    });
    providerName = p?.name ?? null;
    model = p?.model ?? null;
    // Historical allowance stamp: freeze the provider's subscription-window USED%
    // (5h / weekly / daily) as of this step's finish, from the latest poll snapshot.
    // Null unless usage tracking is connected and the last poll succeeded.
    const snap = await db.query.usageWindowSnapshots.findFirst({
      where: eq(schema.usageWindowSnapshots.providerId, peakProviderId),
      columns: { fiveHourPct: true, sevenDayPct: true, dailyPct: true, status: true },
    });
    if (snap && snap.status === 'ok') {
      usageFiveHourPct = snap.fiveHourPct ?? null;
      usageSevenDayPct = snap.sevenDayPct ?? null;
      usageDailyPct = snap.dailyPct ?? null;
    }
  }

  let windowSize: number | null = null;
  let leftPct: number | null = null;
  let contextTokens: number | null = null;
  if (peak > 0) {
    // The catalog is the provider's own figure for the exact routed model, so it outranks the
    // window the CLI recorded (the claude binary reports 200000 for ids it does not know).
    // Only the openrouter rows pay for the extra read; a miss falls through to the recorded window.
    let knownContextLength: number | null = null;
    if (providerName === 'openrouter' && model) {
      const cache = await db.query.openrouterModelCache.findFirst({
        where: eq(schema.openrouterModelCache.name, 'openrouter'),
        columns: { models: true },
      });
      knownContextLength = cache?.models.find((m) => m.id === model)?.contextLength ?? null;
    }
    windowSize = resolveContextWindow(
      providerName,
      model,
      knownContextLength !== null && knownContextLength > 0 ? knownContextLength : peakWindow,
    );
    contextTokens = peak;
    leftPct = Math.max(0, Math.min(100, 100 - Math.round((peak / windowSize) * 100)));
  }

  await db
    .update(schema.taskSteps)
    .set({
      contextTokens,
      contextWindowSize: windowSize,
      contextLeftPercent: leftPct,
      usageFiveHourPct,
      usageSevenDayPct,
      usageDailyPct,
      updatedAt: new Date(),
    })
    .where(eq(schema.taskSteps.id, stepId));

  log.debug(
    { stepId, peak, windowSize, leftPct, usageFiveHourPct, usageSevenDayPct, usageDailyPct },
    'recorded step context + allowance usage',
  );
  return peakProviderId;
}
