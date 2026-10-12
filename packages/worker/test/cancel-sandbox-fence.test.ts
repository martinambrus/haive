import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDatabase, schema, type Database } from '@haive/database';
import { createUnlessSuperseded, supersedeTaskRuns } from '../src/sandbox/cli-sandbox-fence.js';

const url = process.env.CANCEL_FENCE_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/cancel_fence_test'))
  throw new Error('Use a dedicated cancel_fence_test database for the cancel fence tests');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!url)('the cancel and a CLI run share one sandbox fence', () => {
  let db: Database;
  let userId: string;
  let repoId: string;

  beforeAll(async () => {
    db = createDatabase(url!);
    userId = randomUUID();
    repoId = randomUUID();
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'test',
      emailBlindIndex: userId,
      passwordHash: 'test',
    });
    await db.insert(schema.repositories).values({
      id: repoId,
      userId,
      name: 'cancel-fence-test',
      source: 'blank',
      storagePath: `/tmp/cancel-fence-test/${userId}/${repoId}`,
    });
  });
  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.$client.end({ timeout: 5 });
  });

  async function run(): Promise<{ taskId: string; invocationId: string }> {
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId: repoId,
        title: 'cancel fence',
        type: 'workflow',
        status: 'running',
      })
      .returning({ id: schema.tasks.id });
    const [inv] = await db
      .insert(schema.cliInvocations)
      .values({ taskId: task!.id, mode: 'cli', prompt: 'p' })
      .returning({ id: schema.cliInvocations.id });
    return { taskId: task!.id, invocationId: inv!.id };
  }
  async function supersededAt(invocationId: string): Promise<Date | null> {
    const [row] = await db
      .select({ at: schema.cliInvocations.supersededAt })
      .from(schema.cliInvocations)
      .where(eq(schema.cliInvocations.id, invocationId));
    return row!.at;
  }

  it('holds the cancel supersede back while a run that passed its check is creating', async () => {
    const ids = await run();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let creating!: () => void;
    const inCreate = new Promise<void>((resolve) => (creating = resolve));
    const create = vi.fn(async () => {
      creating();
      await gate;
      return 'container';
    });

    const creation = createUnlessSuperseded(db, ids, create);
    await inCreate;
    let cancelled = false;
    const cancel = supersedeTaskRuns(db, ids.taskId).then(() => {
      cancelled = true;
    });
    await sleep(600);
    expect(cancelled).toBe(false);
    expect(await supersededAt(ids.invocationId)).toBeNull();

    release();
    await expect(creation).resolves.toBe('container');
    await cancel;
    expect(create).toHaveBeenCalledTimes(1);
    expect(await supersededAt(ids.invocationId)).not.toBeNull();
  });

  it('creates nothing when the cancel superseded the run first', async () => {
    const ids = await run();
    await supersedeTaskRuns(db, ids.taskId);
    const create = vi.fn(async () => 'container');
    await expect(createUnlessSuperseded(db, ids, create)).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('creates nothing for a run that already ended', async () => {
    const ids = await run();
    await db
      .update(schema.cliInvocations)
      .set({ endedAt: new Date() })
      .where(eq(schema.cliInvocations.id, ids.invocationId));
    const create = vi.fn(async () => 'container');
    await expect(createUnlessSuperseded(db, ids, create)).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('does not make another task wait', async () => {
    const a = await run();
    const b = await run();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let creating!: () => void;
    const inCreate = new Promise<void>((resolve) => (creating = resolve));
    const creation = createUnlessSuperseded(db, a, async () => {
      creating();
      await gate;
      return 'container';
    });
    await inCreate;
    await supersedeTaskRuns(db, b.taskId);
    expect(await supersededAt(b.invocationId)).not.toBeNull();
    release();
    await creation;
  });
});
