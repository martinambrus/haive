import { and, eq, isNull, ne } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger, resolveContextWindow } from '@haive/shared';

const log = logger.child({ module: 'step-context-usage' });

/**
 * Surface B: freeze the step's context-window usage at completion (display-only audit
 * trail pinned to the finished step's title row).
 *
 * Records the PEAK single-invocation prompt-side tokens (input + cacheRead +
 * cacheCreation) over the step's live CLI invocations — NOT the summed tokenUsage the
 * UI shows, which overcounts context across iterations/sub-agents — against the model's
 * context window. The provider/model come from the peak invocation's own cliProviderId.
 *
 * Best-effort: skips deterministic steps (no CLI invocations -> peak 0 -> columns stay
 * null) and is called inside a .catch() at the finalize so it never fails a step.
 */
export async function writeStepContextUsage(db: Database, stepId: string): Promise<void> {
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

  let peak = 0;
  let peakProviderId: string | null = null;
  for (const r of invs) {
    const tu = r.tokenUsage;
    if (!tu) continue;
    const prompt =
      (tu.inputTokens ?? 0) + (tu.cacheReadTokens ?? 0) + (tu.cacheCreationTokens ?? 0);
    if (prompt > peak) {
      peak = prompt;
      peakProviderId = r.cliProviderId;
    }
  }
  if (peak <= 0) return; // deterministic step / no usable token data -> leave columns null

  let providerName: string | null = null;
  let model: string | null = null;
  if (peakProviderId) {
    const p = await db.query.cliProviders.findFirst({
      where: eq(schema.cliProviders.id, peakProviderId),
      columns: { name: true, model: true },
    });
    providerName = p?.name ?? null;
    model = p?.model ?? null;
  }

  const windowSize = resolveContextWindow(providerName, model);
  const leftPct = Math.max(0, Math.min(100, 100 - Math.round((peak / windowSize) * 100)));

  await db
    .update(schema.taskSteps)
    .set({
      contextTokens: peak,
      contextWindowSize: windowSize,
      contextLeftPercent: leftPct,
      updatedAt: new Date(),
    })
    .where(eq(schema.taskSteps.id, stepId));

  log.debug({ stepId, peak, windowSize, leftPct }, 'recorded step context usage');
}
