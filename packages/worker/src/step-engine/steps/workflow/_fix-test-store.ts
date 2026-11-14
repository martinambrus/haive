import { gzipSync, gunzipSync } from 'node:zlib';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { workspaceAnchor } from '../../../repo/worktree-paths.js';
import { resolveInvocationWorkerTree } from '../../../repo/worktree-git-boundary.js';
import { taskSecretMaskPolicy } from '../../../queues/cli-exec/secret-mask.js';
import {
  secretMaskDeniesPath,
  secretMaskPolicy,
} from '../../../queues/cli-exec/secret-mask-policy.js';
import { lockOwnedStep } from '../../step-ownership.js';
import {
  captureTestImage,
  compareTestImages,
  testFileChanged,
  sha256,
  type FixTestRecord,
  type TestImage,
  type TestFile,
} from './_fix-test-edits.js';

export const FIX_TEST_BEFORE = 'fix_tests.before';
export const FIX_TEST_AFTER = 'fix_tests.after';
export const FIX_TEST_RETENTION_DAYS = 30;
export const FIX_TEST_TASK_BYTES = 16 * 1024 * 1024;
export const FIX_TEST_STORE_BYTES = 64 * 1024 * 1024;
export const FIX_TEST_RECORD_LIMIT = 30;
export const FIX_TEST_PENDING_COUNT = 128;
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
interface Reference {
  invocationId: string;
  stepId: string;
  round: number;
  pass: number;
  epoch?: number | null;
  beforeEventId?: string;
  manifestHash?: string;
  fileCount: number;
  state: TestImage['state'];
  reason?: string;
}
export interface CaptureOptions {
  capture?: typeof captureTestImage;
  taskBytes?: number;
  storeBytes?: number;
  pendingBytes?: number;
  pendingCount?: number;
}

// Before bytes are provisional, bounded process memory, never durable copies of unchanged
// files. A restart/eviction preserves the manifest and loses old content unless a previous
// changed-content blob already has that hash. No current-tree replay substitutes old bytes.
const pending = new Map<string, TestImage>();
let pendingBytes = 0;
const imageBytes = (image: TestImage) =>
  (image.files ?? []).reduce(
    (n, f) => n + (f.base64 ? Buffer.byteLength(f.base64, 'base64') : 0),
    0,
  );
function forget(id: string) {
  const image = pending.get(id);
  if (image) pendingBytes -= imageBytes(image);
  pending.delete(id);
}
function remember(id: string, image: TestImage, options: CaptureOptions) {
  forget(id);
  const n = imageBytes(image);
  const maxBytes = options.pendingBytes ?? FIX_TEST_STORE_BYTES;
  const maxCount = options.pendingCount ?? FIX_TEST_PENDING_COUNT;
  while ((pendingBytes + n > maxBytes || pending.size >= maxCount) && pending.size)
    forget(pending.keys().next().value!);
  if (n <= maxBytes && maxCount > 0) {
    pending.set(id, image);
    pendingBytes += n;
  }
}
const manifest = (image: TestImage): TestImage => ({
  ...image,
  files: image.files?.map(({ base64: _bytes, ...f }) => f),
});

/** Full manifests stay compressed in the blob table, never event/history payloads.
 * The separate column survives content eviction/expiry, preserving measured hashes. */
export function fixTestManifestReference(
  meta: Pick<CaptureMeta, 'invocationId' | 'stepId' | 'pass' | 'round' | 'epoch'>,
  image: TestImage,
): Reference {
  const data = JSON.stringify(manifest(image));
  return {
    invocationId: meta.invocationId,
    stepId: meta.stepId,
    pass: meta.pass,
    round: meta.round,
    epoch: meta.epoch,
    manifestHash: sha256(data),
    fileCount: image.files?.length ?? 0,
    state: image.state,
    reason: image.reason,
  };
}
async function retainManifest(tx: Tx, taskId: string, image: TestImage, hash: string) {
  await tx
    .insert(schema.fixTestBlobs)
    .values({
      taskId,
      contentHash: `manifest:${hash}`,
      sizeBytes: 0,
      manifestGzip: gzipSync(JSON.stringify(manifest(image))),
    })
    .onConflictDoNothing();
}
async function readManifests(
  db: Database,
  taskId: string,
  refs: Reference[],
): Promise<Map<string, TestImage>> {
  const hashes = [
    ...new Set(refs.flatMap((r) => (r.manifestHash ? [`manifest:${r.manifestHash}`] : []))),
  ];
  const rows = hashes.length
    ? await db
        .select({ hash: schema.fixTestBlobs.contentHash, data: schema.fixTestBlobs.manifestGzip })
        .from(schema.fixTestBlobs)
        .where(
          and(
            eq(schema.fixTestBlobs.taskId, taskId),
            inArray(schema.fixTestBlobs.contentHash, hashes),
          ),
        )
    : [];
  return new Map(
    rows
      .filter((r) => r.data)
      .map((r) => [
        r.hash.slice('manifest:'.length),
        JSON.parse(gunzipSync(r.data!).toString()) as TestImage,
      ]),
  );
}

/** The partial index finds live metadata; never inspect/detoast content to expire it. */
export async function expireFixTestImages(db: Database): Promise<void> {
  await db.execute(sql`
    with expired as (
      select task_id, content_hash from fix_test_blobs
      where expired_at is null and content is not null and created_at < now() - (${FIX_TEST_RETENTION_DAYS} * interval '1 day')
      order by created_at limit 100
    )
    update fix_test_blobs b set content = null, expired_at = now()
    from expired e where b.task_id = e.task_id and b.content_hash = e.content_hash
  `);
}

async function stored(db: Database | Tx, taskId: string, invocationId: string, eventType: string) {
  return (
    await db
      .select()
      .from(schema.taskEvents)
      .where(
        and(
          eq(schema.taskEvents.taskId, taskId),
          eq(schema.taskEvents.eventType, eventType),
          sql`${schema.taskEvents.payload}->>'invocationId' = ${invocationId}`,
        ),
      )
      .limit(1)
  )[0];
}

/** Run -> step -> task is the Retry/Stop order. No repository I/O under these locks. */
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

async function capture(
  db: Database,
  meta: CaptureMeta,
  options: CaptureOptions,
): Promise<TestImage> {
  const tree = meta.workspace ? workspaceAnchor(meta.workspace) : null;
  if (!tree) return { state: 'not captured', reason: 'Invocation workspace unavailable.' };
  const policy = await taskSecretMaskPolicy(db, meta.taskId);
  return (options.capture ?? captureTestImage)(tree.anchor, tree.prefix, {
    policy: policy ?? undefined,
  });
}

/** Only changed contents enter the durable store. Caps account raw size metadata and
 * evict oldest live blobs so earlier tasks cannot starve later ones. */
async function retain(tx: Tx, taskId: string, files: TestFile[], options: CaptureOptions) {
  const candidates = new Map(
    files
      .filter((f) => f.hash && f.base64 !== undefined && f.status === 'available')
      .map((f) => [f.hash!, f]),
  );
  if (!candidates.size) return;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('haive.fix-test-image-budget'))`);
  const usage = await tx
    .select({
      taskId: schema.fixTestBlobs.taskId,
      hash: schema.fixTestBlobs.contentHash,
      size: schema.fixTestBlobs.sizeBytes,
    })
    .from(schema.fixTestBlobs)
    .where(sql`${schema.fixTestBlobs.expiredAt} is null and ${schema.fixTestBlobs.sizeBytes} > 0`)
    .orderBy(asc(schema.fixTestBlobs.createdAt));
  let total = usage.reduce((n, b) => n + b.size, 0);
  let task = usage.filter((b) => b.taskId === taskId).reduce((n, b) => n + b.size, 0);
  const evicted = new Set<object>();
  for (const [hash, file] of candidates) {
    const content = Buffer.from(file.base64!, 'base64');
    if (
      content.length > (options.taskBytes ?? FIX_TEST_TASK_BYTES) ||
      content.length > (options.storeBytes ?? FIX_TEST_STORE_BYTES)
    )
      continue;
    const existing = await tx
      .select({ expiredAt: schema.fixTestBlobs.expiredAt })
      .from(schema.fixTestBlobs)
      .where(and(eq(schema.fixTestBlobs.taskId, taskId), eq(schema.fixTestBlobs.contentHash, hash)))
      .limit(1);
    if (existing.length && existing[0]!.expiredAt === null) continue;
    for (const b of usage) {
      if (evicted.has(b)) continue;
      if (
        total + content.length <= (options.storeBytes ?? FIX_TEST_STORE_BYTES) &&
        task + content.length <= (options.taskBytes ?? FIX_TEST_TASK_BYTES)
      )
        break;
      if (task + content.length > (options.taskBytes ?? FIX_TEST_TASK_BYTES) && b.taskId !== taskId)
        continue;
      await tx
        .update(schema.fixTestBlobs)
        .set({ content: null, expiredAt: new Date() })
        .where(
          and(
            eq(schema.fixTestBlobs.taskId, b.taskId),
            eq(schema.fixTestBlobs.contentHash, b.hash),
          ),
        );
      total -= b.size;
      if (b.taskId === taskId) task -= b.size;
      evicted.add(b);
    }
    if (
      total + content.length > (options.storeBytes ?? FIX_TEST_STORE_BYTES) ||
      task + content.length > (options.taskBytes ?? FIX_TEST_TASK_BYTES)
    )
      continue;
    await tx
      .insert(schema.fixTestBlobs)
      .values({ taskId, contentHash: hash, sizeBytes: content.length, content })
      .onConflictDoUpdate({
        target: [schema.fixTestBlobs.taskId, schema.fixTestBlobs.contentHash],
        set: { content, sizeBytes: content.length, expiredAt: null, createdAt: new Date() },
      });
    total += content.length;
    task += content.length;
  }
}

export async function beginFixTestCapture(
  db: Database,
  meta: CaptureMeta,
  options: CaptureOptions = {},
): Promise<void> {
  if (await stored(db, meta.taskId, meta.invocationId, FIX_TEST_BEFORE)) return;
  const image = await capture(db, meta, options);
  await db.transaction(async (tx) => {
    const owns = await owned(tx, meta, false);
    if (await stored(tx, meta.taskId, meta.invocationId, FIX_TEST_BEFORE)) return;
    const measured = owns
      ? image
      : { state: 'not captured' as const, reason: 'Begin did not own the invocation.' };
    const ref = fixTestManifestReference(meta, measured);
    await retainManifest(tx, meta.taskId, measured, ref.manifestHash!);
    await tx.insert(schema.taskEvents).values({
      taskId: meta.taskId,
      taskStepId: meta.taskStepId,
      eventType: FIX_TEST_BEFORE,
      payload: { ...ref },
    });
    if (owns) remember(meta.invocationId, image, options);
  });
}

export async function finishFixTestCapture(
  db: Database,
  invocationId: string,
  options: CaptureOptions = {},
): Promise<void> {
  // Primary-key lookup first; non-repair completions never scan other tasks' events.
  const run = await db.query.cliInvocations.findFirst({
    where: eq(schema.cliInvocations.id, invocationId),
  });
  if (!run) return;
  const before = await stored(db, run.taskId, invocationId, FIX_TEST_BEFORE);
  if (!before || (await stored(db, run.taskId, invocationId, FIX_TEST_AFTER))) return;
  const ref = before.payload as unknown as Reference;
  const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, run.taskId) });
  const agentRun =
    run.mode === 'dag_parallel'
      ? await db.query.dagAgentRuns.findFirst({
          where: eq(schema.dagAgentRuns.cliInvocationId, invocationId),
        })
      : undefined;
  const issue = agentRun
    ? await db.query.taskDagIssues.findFirst({
        where: eq(schema.taskDagIssues.id, agentRun.dagIssueId),
      })
    : undefined;
  const meta: CaptureMeta = {
    ...ref,
    taskId: run.taskId,
    taskStepId: before.taskStepId!,
    workspace:
      issue?.worktreePath ??
      task?.worktreePath ??
      (await resolveInvocationWorkerTree(db, run.taskId)),
  };
  const beforeManifest = (await readManifests(db, run.taskId, [ref])).get(
    ref.manifestHash ?? '',
  ) ?? { state: 'not captured' as const, reason: 'Missing manifest.' };
  const after = await capture(db, meta, options);
  // Deleted/refused after paths cannot carry a withheld status. Recheck their before
  // contents against the effective policy as well, before any bytes enter the store.
  const finishPolicy = (await taskSecretMaskPolicy(db, meta.taskId)) ?? secretMaskPolicy({});
  await db.transaction(async (tx) => {
    if (!(await owned(tx, meta, true))) return;
    if (await stored(tx, run.taskId, invocationId, FIX_TEST_AFTER)) return;
    const interrupted = run.exitCode == null || [-1, 137, 124].includes(run.exitCode);
    const left = pending.get(invocationId) ?? beforeManifest;
    const next = new Map(after.files?.map((f) => [f.path, f]));
    const old = new Map(left.files?.map((f) => [f.path, f]));
    const changed = [...new Set([...old.keys(), ...next.keys()])].filter((p) =>
      testFileChanged(old.get(p), next.get(p)),
    );
    const withheld = new Set(
      after.files?.filter((f) => f.status === 'content withheld').map((f) => f.path),
    );
    if (!interrupted && beforeManifest.state === 'captured' && after.state === 'captured')
      await retain(
        tx,
        run.taskId,
        changed
          .filter((p) => !withheld.has(p) && !secretMaskDeniesPath(finishPolicy, p))
          .flatMap((p) => [old.get(p), next.get(p)].filter((f): f is TestFile => !!f)),
        options,
      );
    const measured = interrupted
      ? { state: 'not captured' as const, reason: 'Invocation interrupted.' }
      : after;
    const reference = fixTestManifestReference(ref, measured);
    await retainManifest(tx, run.taskId, measured, reference.manifestHash!);
    await tx.insert(schema.taskEvents).values({
      taskId: run.taskId,
      taskStepId: meta.taskStepId,
      eventType: FIX_TEST_AFTER,
      payload: { ...reference, beforeEventId: before.id },
    });
  });
  forget(invocationId);
}

/** Bound records BEFORE gate detect persists them; events and history carry no content. */
export async function loadFixTestRecords(
  db: Database,
  taskId: string,
  limit = FIX_TEST_RECORD_LIMIT,
  options: { patches?: boolean } = {},
): Promise<FixTestRecord[]> {
  const starts = await db
    .select()
    .from(schema.taskEvents)
    .where(
      and(eq(schema.taskEvents.taskId, taskId), eq(schema.taskEvents.eventType, FIX_TEST_BEFORE)),
    )
    .orderBy(desc(schema.taskEvents.createdAt), desc(schema.taskEvents.id))
    .limit(Math.min(FIX_TEST_RECORD_LIMIT, Math.max(1, limit)));
  if (!starts.length) return [];
  const ids = starts.map((e) => String(e.payload?.invocationId));
  const ends = await db
    .select()
    .from(schema.taskEvents)
    .where(
      and(
        eq(schema.taskEvents.taskId, taskId),
        eq(schema.taskEvents.eventType, FIX_TEST_AFTER),
        inArray(sql`${schema.taskEvents.payload}->>'invocationId'`, ids),
      ),
    );
  const settled = new Map(ends.map((e) => [e.payload?.invocationId, e]));
  const manifests = await readManifests(
    db,
    taskId,
    [...starts, ...ends].map((e) => e.payload as unknown as Reference),
  );
  const imageFor = (ref?: Reference) => manifests.get(ref?.manifestHash ?? '');
  const policy = await taskSecretMaskPolicy(db, taskId);
  const hashes = new Set<string>();
  for (const start of starts) {
    const a = imageFor(start.payload as unknown as Reference);
    const b = imageFor(
      settled.get(start.payload?.invocationId)?.payload as unknown as Reference | undefined,
    );
    const next = new Map(b?.files?.map((f) => [f.path, f]));
    const old = new Map(a?.files?.map((f) => [f.path, f]));
    for (const p of new Set([...old.keys(), ...next.keys()])) {
      const x = old.get(p),
        y = next.get(p);
      if (!testFileChanged(x, y)) continue;
      if (secretMaskDeniesPath(policy ?? secretMaskPolicy({}), p)) continue;
      if (x?.hash) hashes.add(x.hash);
      if (y?.hash) hashes.add(y.hash);
    }
  }
  const blobs =
    options.patches !== false && hashes.size
      ? await db
          .select()
          .from(schema.fixTestBlobs)
          .where(
            and(
              eq(schema.fixTestBlobs.taskId, taskId),
              inArray(schema.fixTestBlobs.contentHash, [...hashes]),
            ),
          )
      : [];
  const bytes = new Map(
    blobs
      .filter((b) => b.content && !b.expiredAt)
      .map((b) => [b.contentHash, b.content!.toString('base64')]),
  );
  const hydrate = (image?: TestImage): TestImage =>
    image
      ? {
          ...image,
          files: image.files?.map((f) =>
            secretMaskDeniesPath(policy ?? secretMaskPolicy({}), f.path)
              ? { ...f, hash: 'withheld:present', status: 'content withheld', base64: undefined }
              : {
                  ...f,
                  base64: f.status === 'available' && f.hash ? bytes.get(f.hash) : undefined,
                },
          ),
        }
      : { state: 'not captured', reason: 'Missing manifest.' };
  return starts.reverse().map((e) => {
    const p = e.payload as unknown as Reference;
    const end = settled.get(p.invocationId);
    return {
      invocationId: p.invocationId,
      stepId: p.stepId,
      round: p.round,
      pass: p.pass,
      beforeEventId: e.id,
      ...compareTestImages(
        hydrate(imageFor(p)),
        hydrate(imageFor(end?.payload as unknown as Reference | undefined)),
        options.patches === false ? { bytes: 0, lines: 0 } : undefined,
      ),
    };
  });
}
