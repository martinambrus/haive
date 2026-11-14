import { and, asc, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { workspaceAnchor } from '../../../repo/worktree-paths.js';
import { lockOwnedStep } from '../../step-ownership.js';
import {
  captureTestImage,
  compareTestImages,
  type FixTestRecord,
  type TestImage,
} from './_fix-test-edits.js';

export const FIX_TEST_BEFORE = 'fix_tests.before';
export const FIX_TEST_AFTER = 'fix_tests.after';
export const FIX_TEST_RETENTION_DAYS = 30;
export const FIX_TEST_TASK_BYTES = 16 * 1024 * 1024;
export const FIX_TEST_STORE_BYTES = 64 * 1024 * 1024;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
interface CaptureMeta {
  invocationId: string;
  taskId: string;
  taskStepId: string;
  stepId: string;
  round: number;
  pass: number;
  workspace: string | null;
  epoch?: number | null;
}

export interface CaptureOptions {
  capture?: typeof captureTestImage;
  taskBytes?: number;
  storeBytes?: number;
}

/** Bounded retention: delete content only, retain hashes/references and disclose expiry.
 * Runs from the minute sweep even when no more repairs are dispatched. */
export async function expireFixTestImages(db: Database): Promise<void> {
  await db.execute(sql`
    with expired as (
      select id from task_events
      where event_type in (${FIX_TEST_BEFORE}, ${FIX_TEST_AFTER})
        and payload ? 'image'
        and created_at < now() - (${FIX_TEST_RETENTION_DAYS} * interval '1 day')
      order by created_at limit 100
    )
    update task_events e set payload = (e.payload - 'image') || '{"expired":true}'::jsonb
    from expired where e.id = expired.id
  `);
}

async function stored(db: Database | Tx, invocationId: string, eventType: string) {
  return (
    await db
      .select()
      .from(schema.taskEvents)
      .where(
        and(
          eq(schema.taskEvents.eventType, eventType),
          sql`${schema.taskEvents.payload}->>'invocationId' = ${invocationId}`,
        ),
      )
      .limit(1)
  )[0];
}

/** Run -> step -> task is the Retry/Stop order. No repository I/O while these locks are held. */
async function owned(tx: Tx, meta: CaptureMeta, ended: boolean): Promise<boolean> {
  const [run] = await tx
    .select()
    .from(schema.cliInvocations)
    .where(eq(schema.cliInvocations.id, meta.invocationId))
    .for('no key update');
  if (!run || run.supersededAt || (ended ? !run.endedAt : run.endedAt)) return false;
  if (!(await lockOwnedStep(tx, meta.taskStepId))) return false;
  const [task] = await tx
    .select({ status: schema.tasks.status, epoch: schema.tasks.orchestrationEpoch })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, meta.taskId))
    .for('share');
  return (
    !!task &&
    !['failed', 'cancelled', 'completed'].includes(task.status) &&
    (meta.epoch == null || task.epoch === meta.epoch)
  );
}

/** Admission serialises only database storage, never filesystem work. Images are immutable
 * until explicit expiry; an exhausted budget stores 'not captured' instead of partial bytes. */
async function budgeted(
  tx: Tx,
  taskId: string,
  image: TestImage,
  options: CaptureOptions,
): Promise<TestImage> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('haive.fix-test-image-budget'))`);
  const rows = await tx.execute<{ total: string; task: string }>(sql`
    select coalesce(sum(pg_column_size(payload->'image')), 0)::text as total,
      coalesce(sum(pg_column_size(payload->'image')) filter (where task_id = ${taskId}), 0)::text as task
    from task_events where event_type in (${FIX_TEST_BEFORE}, ${FIX_TEST_AFTER}) and payload ? 'image'
  `);
  const n = Buffer.byteLength(JSON.stringify(image));
  if (
    Number(rows[0]?.total ?? 0) + n > (options.storeBytes ?? FIX_TEST_STORE_BYTES) ||
    Number(rows[0]?.task ?? 0) + n > (options.taskBytes ?? FIX_TEST_TASK_BYTES)
  )
    return { state: 'not captured', reason: 'Evidence storage budget exhausted.' };
  return image;
}

export async function beginFixTestCapture(
  db: Database,
  meta: CaptureMeta,
  options: CaptureOptions = {},
): Promise<void> {
  if (await stored(db, meta.invocationId, FIX_TEST_BEFORE)) return;
  const tree = meta.workspace ? workspaceAnchor(meta.workspace) : null;
  const image: TestImage = tree
    ? await (options.capture ?? captureTestImage)(tree.anchor, tree.prefix)
    : { state: 'not captured', reason: 'Invocation workspace unavailable.' };
  await db.transaction(async (tx) => {
    if (!(await owned(tx, meta, false))) return;
    if (await stored(tx, meta.invocationId, FIX_TEST_BEFORE)) return;
    const kept = await budgeted(tx, meta.taskId, image, options);
    await tx.insert(schema.taskEvents).values({
      taskId: meta.taskId,
      taskStepId: meta.taskStepId,
      eventType: FIX_TEST_BEFORE,
      payload: { ...meta, image: kept, imageHash: kept.hash },
    });
  });
}

/** Called before consuming a settled invocation or dispatching another pass. A crash before the
 * commit repeats the same key; a crash after it reads the existing immutable record. */
export async function finishFixTestCapture(
  db: Database,
  invocationId: string,
  options: CaptureOptions = {},
): Promise<void> {
  const before = await stored(db, invocationId, FIX_TEST_BEFORE);
  if (!before || (await stored(db, invocationId, FIX_TEST_AFTER))) return;
  const meta = before.payload as unknown as CaptureMeta & { image?: TestImage; expired?: boolean };
  const tree = meta.workspace ? workspaceAnchor(meta.workspace) : null;
  const after: TestImage = tree
    ? await (options.capture ?? captureTestImage)(tree.anchor, tree.prefix)
    : { state: 'not captured', reason: 'Invocation workspace unavailable.' };
  await db.transaction(async (tx) => {
    if (!(await owned(tx, meta, true))) return;
    if (await stored(tx, invocationId, FIX_TEST_AFTER)) return;
    const image = await budgeted(tx, meta.taskId, after, options);
    const [run] = await tx
      .select({ exitCode: schema.cliInvocations.exitCode })
      .from(schema.cliInvocations)
      .where(eq(schema.cliInvocations.id, invocationId));
    const interrupted = run?.exitCode == null || [-1, 137, 124].includes(run.exitCode);
    const comparison = compareTestImages(
      !interrupted && !meta.expired && meta.image
        ? meta.image
        : {
            state: 'not captured',
            reason: 'Before image missing, expired or invocation interrupted.',
          },
      image,
    );
    const record: FixTestRecord = {
      invocationId,
      stepId: meta.stepId,
      pass: meta.pass,
      round: meta.round,
      beforeEventId: before.id,
      ...comparison,
    };
    await tx.insert(schema.taskEvents).values({
      taskId: meta.taskId,
      taskStepId: meta.taskStepId,
      eventType: FIX_TEST_AFTER,
      payload: { ...record, image, imageHash: image.hash },
    });
  });
}

/** Strip whole images in SQL: gates and prompts never receive the stored before/after bytes. */
export async function loadFixTestRecords(db: Database, taskId: string): Promise<FixTestRecord[]> {
  const events = await db
    .select({
      id: schema.taskEvents.id,
      type: schema.taskEvents.eventType,
      payload: sql<Record<string, unknown>>`${schema.taskEvents.payload} - 'image'`,
    })
    .from(schema.taskEvents)
    .where(
      and(
        eq(schema.taskEvents.taskId, taskId),
        sql`${schema.taskEvents.eventType} in (${FIX_TEST_BEFORE}, ${FIX_TEST_AFTER})`,
      ),
    )
    .orderBy(asc(schema.taskEvents.createdAt), asc(schema.taskEvents.id));
  const settled = new Map(
    events.filter((e) => e.type === FIX_TEST_AFTER).map((e) => [e.payload.invocationId, e]),
  );
  return events
    .filter((e) => e.type === FIX_TEST_BEFORE)
    .map((e) => {
      const end = settled.get(e.payload.invocationId);
      const p = e.payload;
      return end
        ? ({
            ...end.payload,
            ...(end.payload.expired || p.expired
              ? { state: 'not captured', reason: 'Whole-image retention expired.' }
              : {}),
          } as unknown as FixTestRecord)
        : {
            invocationId: String(p.invocationId),
            stepId: String(p.stepId),
            round: Number(p.round),
            pass: Number(p.pass),
            beforeEventId: e.id,
            state: 'not captured',
            reason: 'Pass did not settle under ownership.',
            changes: [],
          };
    });
}
