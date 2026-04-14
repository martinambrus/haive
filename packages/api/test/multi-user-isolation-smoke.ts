import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { configService, secretsService, userSecretsService, logger } from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import { initRedis, closeRedis } from '../src/redis.js';
import { createApiApp } from '../src/index.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';

const log = logger.child({ module: 'multi-user-isolation-smoke' });

const REQUIRED_ENV = ['DATABASE_URL', 'REDIS_URL', 'CONFIG_ENCRYPTION_KEY'] as const;
for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    console.error(`[smoke] missing env ${k}`);
    process.exit(2);
  }
}

interface Fixtures {
  userAId?: string;
  userBId?: string;
  userARepoId?: string;
  userATaskId?: string;
  userBTaskId?: string;
}

async function createUser(db: ReturnType<typeof getDb>, email: string): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db.insert(schema.users).values({
    id,
    emailEncrypted: email,
    emailBlindIndex: `${email}-${randomBytes(4).toString('hex')}`,
    passwordHash: 'smoke-not-real',
    role: 'user',
    status: 'active',
    tokenVersion: 0,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function createRepoFor(db: ReturnType<typeof getDb>, userId: string): Promise<string> {
  const [repo] = await db
    .insert(schema.repositories)
    .values({
      userId,
      name: `isolation-${randomBytes(3).toString('hex')}`,
      source: 'local_path',
      localPath: '/tmp/fake',
      storagePath: '/tmp/fake',
      status: 'ready',
    })
    .returning();
  if (!repo) throw new Error('repo insert failed');
  return repo.id;
}

async function createTaskFor(
  db: ReturnType<typeof getDb>,
  userId: string,
  repositoryId: string | null,
): Promise<string> {
  const [task] = await db
    .insert(schema.tasks)
    .values({
      userId,
      repositoryId: repositoryId ?? null,
      type: 'workflow',
      title: 'isolation smoke task',
      status: 'running',
    })
    .returning();
  if (!task) throw new Error('task insert failed');
  return task.id;
}

function assertStatus(label: string, actual: number, expected: number): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected status ${expected}, got ${actual}`);
  }
}

async function main(): Promise<void> {
  const state: Fixtures = {};
  let exitCode = 0;
  try {
    log.info('bootstrapping');
    initRedis(process.env.REDIS_URL!);
    await configService.initialize(process.env.REDIS_URL!);
    const db = initDatabase(process.env.DATABASE_URL!);
    await secretsService.initialize(db);
    const masterKek = await secretsService.getMasterKek();
    await userSecretsService.initialize(db, masterKek);

    const app = createApiApp('http://localhost:3000');

    state.userAId = await createUser(db, 'userA-smoke@test.local');
    state.userBId = await createUser(db, 'userB-smoke@test.local');

    const tokenA = await signAccessToken({ sub: state.userAId, role: 'user', tv: 0 });
    const tokenB = await signAccessToken({ sub: state.userBId, role: 'user', tv: 0 });

    const cookieA = `${ACCESS_COOKIE}=${tokenA}`;
    const cookieB = `${ACCESS_COOKIE}=${tokenB}`;

    state.userARepoId = await createRepoFor(db, state.userAId);
    state.userATaskId = await createTaskFor(db, state.userAId, state.userARepoId);
    state.userBTaskId = await createTaskFor(db, state.userBId, null);

    // 1. user B cannot read user A's task by id
    const readTaskAsB = await app.request(`/tasks/${state.userATaskId}`, {
      headers: { cookie: cookieB },
    });
    assertStatus('userB GET /tasks/<userA-task>', readTaskAsB.status, 404);

    // 2. user A CAN read their own task (positive control)
    const readTaskAsA = await app.request(`/tasks/${state.userATaskId}`, {
      headers: { cookie: cookieA },
    });
    assertStatus('userA GET /tasks/<userA-task>', readTaskAsA.status, 200);

    // 3. user B listing tasks sees only their own
    const listAsB = await app.request('/tasks', { headers: { cookie: cookieB } });
    assertStatus('userB GET /tasks', listAsB.status, 200);
    const listBody = (await listAsB.json()) as { tasks: { id: string; userId: string }[] };
    if (listBody.tasks.some((t) => t.id === state.userATaskId)) {
      throw new Error('userB list leaked userA task');
    }
    if (listBody.tasks.every((t) => t.userId !== state.userBId)) {
      throw new Error('userB list missing userB task');
    }

    // 4. user B cannot submit a step on user A's task
    const submitAsB = await app.request(`/tasks/${state.userATaskId}/steps/01-fake/submit`, {
      method: 'POST',
      headers: { cookie: cookieB, 'content-type': 'application/json' },
      body: JSON.stringify({ values: {} }),
    });
    assertStatus('userB POST /tasks/<A>/steps/.../submit', submitAsB.status, 404);

    // 5. user B cannot issue actions on user A's task
    const actionAsB = await app.request(`/tasks/${state.userATaskId}/action`, {
      method: 'POST',
      headers: { cookie: cookieB, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'cancel' }),
    });
    assertStatus('userB POST /tasks/<A>/action', actionAsB.status, 404);

    // 6. user B cannot read user A's events
    const eventsAsB = await app.request(`/tasks/${state.userATaskId}/events`, {
      headers: { cookie: cookieB },
    });
    assertStatus('userB GET /tasks/<A>/events', eventsAsB.status, 404);

    // 7. user B cannot read user A's repo
    const repoAsB = await app.request(`/repos/${state.userARepoId}`, {
      headers: { cookie: cookieB },
    });
    assertStatus('userB GET /repos/<A>', repoAsB.status, 404);

    // 8. unauthenticated request is rejected
    const anonGet = await app.request(`/tasks/${state.userATaskId}`);
    if (anonGet.status !== 401 && anonGet.status !== 403) {
      throw new Error(`anon GET expected 401/403, got ${anonGet.status}`);
    }

    log.info(
      {
        userAId: state.userAId,
        userBId: state.userBId,
        userATaskId: state.userATaskId,
      },
      'isolation checks passed',
    );

    console.log(
      JSON.stringify({
        smoke: 'ISOLATION_OK',
        checks: 8,
      }),
    );
  } catch (err) {
    exitCode = 1;
    log.error({ err }, 'smoke failed');
    console.error('[smoke] FAILED:', err);
  } finally {
    try {
      const db = getDb();
      if (state.userATaskId) {
        await db.delete(schema.taskEvents).where(eq(schema.taskEvents.taskId, state.userATaskId));
        await db.delete(schema.tasks).where(eq(schema.tasks.id, state.userATaskId));
      }
      if (state.userBTaskId) {
        await db.delete(schema.taskEvents).where(eq(schema.taskEvents.taskId, state.userBTaskId));
        await db.delete(schema.tasks).where(eq(schema.tasks.id, state.userBTaskId));
      }
      if (state.userARepoId) {
        await db.delete(schema.repositories).where(eq(schema.repositories.id, state.userARepoId));
      }
      if (state.userAId) {
        await db.delete(schema.users).where(eq(schema.users.id, state.userAId));
      }
      if (state.userBId) {
        await db.delete(schema.users).where(eq(schema.users.id, state.userBId));
      }
    } catch (cleanupErr) {
      log.warn({ err: cleanupErr }, 'cleanup failed');
    }
    await closeRedis().catch(() => {});
    process.exit(exitCode);
  }
}

void main();
