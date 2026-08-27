/**
 * Integration smoke for the surfaces a plan chat is supposed to stay OUT of,
 * and the one it is supposed to appear on, against a real Postgres.
 *
 * Neither half can be unit tested: both are SQL predicates inside route
 * handlers, and what they get wrong is a row count. A chat leaking into the
 * task list is how it raises a toast and a browser notification (the notifier
 * polls that same endpoint), and an unread count that never clears — or never
 * appears — is a badge lying to the user about whether anyone answered.
 *
 * Tasks are inserted directly rather than created through the API: this smoke
 * must never enqueue a job.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@haive/database';
import { configService, secretsService, userSecretsService, logger } from '@haive/shared';
import { applyPlanPatch } from '@haive/shared/plan';
import { initDatabase, getDb } from '../src/db.js';
import { initRedis, closeRedis } from '../src/redis.js';
import { createApiApp } from '../src/index.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';

const log = logger.child({ module: 'plan-chat-surfaces-smoke' });

const REQUIRED_ENV = ['DATABASE_URL', 'REDIS_URL', 'CONFIG_ENCRYPTION_KEY'] as const;
for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    console.error(`[smoke] missing env ${k}`);
    process.exit(2);
  }
}

const failures: string[] = [];
let checks = 0;

function check(label: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) {
    log.info({ label }, 'ok');
    return;
  }
  failures.push(label);
  log.error({ label, detail }, 'FAILED');
}

interface Fixtures {
  userId?: string;
  repositoryId?: string;
  taskIds: string[];
}

async function main(): Promise<void> {
  const state: Fixtures = { taskIds: [] };
  let exitCode = 0;
  try {
    initRedis(process.env.REDIS_URL!);
    await configService.initialize(process.env.REDIS_URL!);
    const db = initDatabase(process.env.DATABASE_URL!);
    await secretsService.initialize(db);
    await userSecretsService.initialize(db, await secretsService.getMasterKek());

    const app = createApiApp('http://localhost:3000');

    const userId = randomUUID();
    const email = `plan-chat-smoke-${randomBytes(4).toString('hex')}@test.local`;
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: email,
      emailBlindIndex: email,
      passwordHash: 'smoke-not-real',
      role: 'user',
      status: 'active',
      tokenVersion: 0,
    });
    state.userId = userId;
    const cookie = `${ACCESS_COOKIE}=${await signAccessToken({ sub: userId, role: 'user', tv: 0 })}`;

    const [repo] = await db
      .insert(schema.repositories)
      .values({
        userId,
        name: `plan-chat-smoke-${randomBytes(3).toString('hex')}`,
        source: 'local_path',
        localPath: '/tmp/fake',
        storagePath: '/tmp/fake',
        status: 'ready',
      })
      .returning();
    const repositoryId = repo!.id;
    state.repositoryId = repositoryId;

    const built = await applyPlanPatch(
      db,
      {
        ops: [
          { op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Product' },
          { op: 'upsert', nodeRef: 'mail', parentRef: 'root', title: 'Mailer' },
          { op: 'upsert', nodeRef: 'auth', parentRef: 'root', title: 'Auth' },
        ],
      },
      { repositoryId, origin: 'llm' },
    );
    const rootId = built.refs['root']!;
    const mailId = built.refs['mail']!;
    const authId = built.refs['auth']!;

    const mkTask = async (type: 'workflow' | 'plan_chat', title: string): Promise<string> => {
      const [t] = await db
        .insert(schema.tasks)
        .values({ userId, repositoryId, type, title, status: 'running' })
        .returning();
      state.taskIds.push(t!.id);
      return t!.id;
    };
    const workflowTaskId = await mkTask('workflow', 'plan-chat-smoke ordinary task');
    const chatTaskId = await mkTask('plan_chat', 'plan-chat-smoke chat');

    /* --- 1. the task list, which is also the notification feed ------------- */

    const listed = async (qs: string): Promise<string[]> => {
      const res = await app.request(`/tasks?${qs}`, { headers: { cookie } });
      if (res.status !== 200) throw new Error(`GET /tasks?${qs} -> ${res.status}`);
      const body = (await res.json()) as { tasks: { id: string }[] };
      return body.tasks.map((t) => t.id);
    };

    const plain = await listed('sort=updated&pageSize=50');
    check('an ordinary task is listed', plain.includes(workflowTaskId), plain);
    check('a plan chat is not', !plain.includes(chatTaskId), plain);

    const withChats = await listed('sort=updated&pageSize=50&includeChats=1');
    check('includeChats=1 brings the chat back', withChats.includes(chatTaskId), withChats);
    check('and still lists ordinary work', withChats.includes(workflowTaskId), withChats);

    /* --- 2. the repository badge, which must agree with the list ----------- */

    const reposRes = await app.request('/repos', { headers: { cookie } });
    const reposBody = (await reposRes.json()) as {
      repositories: { id: string; openTaskCount: number; activeTaskCount: number }[];
    };
    const mine = reposBody.repositories.find((r) => r.id === repositoryId);
    // Two tasks exist and both are running; the badge must count only the one
    // the list will show, or it advertises work nobody can open.
    check('the open badge excludes the chat', mine?.openTaskCount === 1, mine);
    check('the active badge excludes it too', mine?.activeTaskCount === 1, mine);

    /* --- 3. unread counts -------------------------------------------------- */

    const unread = async (): Promise<Record<string, number>> => {
      const res = await app.request(`/repositories/${repositoryId}/plan/unread`, {
        headers: { cookie },
      });
      if (res.status !== 200) throw new Error(`GET plan/unread -> ${res.status}`);
      return ((await res.json()) as { counts: Record<string, number> }).counts;
    };

    check('nothing is unread before anyone has spoken', Object.keys(await unread()).length === 0);

    const say = async (nodeId: string, role: 'user' | 'assistant', body: string) => {
      await db.insert(schema.planNodeMessages).values({ nodeId, taskId: chatTaskId, role, body });
      // Distinct timestamps: the read stamp is compared with `>`, and rows
      // written inside the same millisecond would make the comparison a
      // coin toss rather than a test.
      await new Promise((r) => setTimeout(r, 5));
    };

    await say(mailId, 'user', 'split this into two');
    check('the user’s own turn is not unread', Object.keys(await unread()).length === 0);

    await say(mailId, 'assistant', 'done, two children');
    await say(mailId, 'assistant', 'anything else?');
    const twoReplies = await unread();
    check(
      'every reply counts when the node was never opened',
      twoReplies[mailId] === 2,
      twoReplies,
    );
    check('a node nobody chatted about has no count', twoReplies[authId] === undefined, twoReplies);
    check('the count does not roll up to the parent', twoReplies[rootId] === undefined, twoReplies);

    /* --- 4. marking read, and what a later reply does ---------------------- */

    const markRead = await app.request(`/repositories/${repositoryId}/plan/nodes/${mailId}/read`, {
      method: 'PUT',
      headers: { cookie },
    });
    check('marking read succeeds', markRead.status === 200, markRead.status);
    check('reading clears the badge', Object.keys(await unread()).length === 0);

    await new Promise((r) => setTimeout(r, 5));
    await say(mailId, 'assistant', 'one more thing');
    const afterRead = await unread();
    check('a reply after the read stamp is unread again', afterRead[mailId] === 1, afterRead);

    const markAgain = await app.request(`/repositories/${repositoryId}/plan/nodes/${mailId}/read`, {
      method: 'PUT',
      headers: { cookie },
    });
    check(
      'a second read updates rather than duplicating',
      markAgain.status === 200,
      markAgain.status,
    );
    check('and clears the badge again', Object.keys(await unread()).length === 0);

    const readRows = await db
      .select()
      .from(schema.userPlanNodeReads)
      .where(
        and(
          eq(schema.userPlanNodeReads.userId, userId),
          eq(schema.userPlanNodeReads.nodeId, mailId),
        ),
      );
    check('one read row per user per node', readRows.length === 1, readRows.length);

    if (failures.length > 0) {
      exitCode = 1;
      console.error(`[smoke] FAILED ${failures.length}/${checks}:`, failures);
    } else {
      console.log(JSON.stringify({ smoke: 'PLAN_CHAT_SURFACES_OK', checks }));
    }
  } catch (err) {
    exitCode = 1;
    log.error({ err }, 'smoke failed');
    console.error('[smoke] FAILED:', err);
  } finally {
    try {
      const db = getDb();
      if (state.taskIds.length > 0) {
        await db.delete(schema.taskEvents).where(inArray(schema.taskEvents.taskId, state.taskIds));
        await db.delete(schema.tasks).where(inArray(schema.tasks.id, state.taskIds));
      }
      // plan nodes, messages and read rows all cascade from the repository.
      if (state.repositoryId) {
        await db.delete(schema.repositories).where(eq(schema.repositories.id, state.repositoryId));
      }
      if (state.userId) {
        await db.delete(schema.users).where(eq(schema.users.id, state.userId));
      }
    } catch (cleanupErr) {
      log.warn({ err: cleanupErr }, 'cleanup failed');
    }
    await closeRedis().catch(() => {});
    process.exit(exitCode);
  }
}

void main();
