import { and, desc, eq, isNull, notInArray } from 'drizzle-orm';
import { schema } from '@haive/database';
import { INSIGHTS_AT_GATE, type FormField } from '@haive/shared';
import type { StepContext } from '../../step-definition.js';
import { ReopenStepFormError } from '../../step-definition.js';
import { lockOwnedStep, StepSupersededError } from '../../step-ownership.js';
export async function insightPageOffset(ctx: StepContext): Promise<number> {
  const rows = await ctx.db
    .select({ payload: schema.taskEvents.payload })
    .from(schema.taskEvents)
    .where(
      and(
        eq(schema.taskEvents.taskId, ctx.taskId),
        eq(schema.taskEvents.taskStepId, ctx.taskStepId),
        eq(schema.taskEvents.eventType, 'insight.page'),
      ),
    )
    .orderBy(desc(schema.taskEvents.createdAt), desc(schema.taskEvents.id));
  const page = rows.find((r) => r.payload?.generation === (ctx.rerunGeneration ?? 0));
  return Number.isSafeInteger(page?.payload?.offset) && Number(page?.payload?.offset) >= 0
    ? Number(page!.payload!.offset)
    : 0;
}
export function insightPageField(total: number, offset = 0, size = INSIGHTS_AT_GATE): FormField[] {
  return total <= size
    ? []
    : [
        {
          type: 'select',
          id: 'insightPage',
          label: 'Insight page',
          description:
            'Choose a page and submit to browse. Changing pages applies and commits nothing; selections on the current page are cleared.',
          default: String(offset),
          options: Array.from({ length: Math.ceil(total / size) }, (_, n) => ({
            value: String(n * size),
            label: `Page ${n + 1}`,
          })),
        },
      ];
}
export function isInsightPageChange(detected: { insightPage?: number }, values: unknown): boolean {
  const value = (values as { insightPage?: unknown } | null)?.insightPage;
  return value !== undefined && value !== String(detected.insightPage ?? 0);
}
export async function changeInsightPage(
  ctx: StepContext,
  detected: { insightPage?: number; insightTotal?: number; insightPageSize?: number },
  values: unknown,
): Promise<void> {
  if (!isInsightPageChange(detected, values)) return;
  const offset = Number((values as { insightPage: unknown }).insightPage);
  const size = detected.insightPageSize ?? INSIGHTS_AT_GATE;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset % size ||
    offset >= (detected.insightTotal ?? 0)
  )
    throw new ReopenStepFormError('Invalid insight page. Review the refreshed form.', {
      notice: true,
    });
  await ctx.db.transaction(async (tx) => {
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
          notInArray(schema.tasks.status, ['failed', 'completed', 'cancelled']),
        ),
      )
      .for('share');
    if (!task) throw new StepSupersededError(ctx.taskStepId);
    ctx.throwIfCancelled();
    await tx.insert(schema.taskEvents).values({
      taskId: ctx.taskId,
      taskStepId: ctx.taskStepId,
      eventType: 'insight.page',
      payload: { generation: source.rerunGeneration, offset },
    });
  });
  throw new ReopenStepFormError('Insight page changed. Review this page before continuing.', {
    notice: true,
  });
}
