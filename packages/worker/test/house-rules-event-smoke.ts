/**
 * The `house_rules.unavailable` event against a database: concurrent dispatches of one task write it
 * once, a dispatch that finds another holding the task's lock waits for it, and another task is its
 * own. One throwaway user and two tasks, deleted after.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@haive/database';
import { logger } from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import {
  HOUSE_RULES_UNAVAILABLE_EVENT,
  recordHouseRulesUnavailable,
} from '../src/orchestrator/house-rules-dispatch.js';

const log = logger.child({ module: 'house-rules-event-smoke' });

if (!process.env.DATABASE_URL) {
  console.error('[smoke] missing env DATABASE_URL');
  process.exit(2);
}

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  checks += 1;
  if (ok) {
    log.info({ check: name }, 'ok');
    return;
  }
  failures += 1;
  log.error({ check: name, detail }, 'FAILED');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  initDatabase(process.env.DATABASE_URL!);
  const db = getDb();
  const userId = randomUUID();
  const now = new Date();

  try {
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'house-rules-event-smoke',
      emailBlindIndex: `house-rules-event-smoke-${randomBytes(6).toString('hex')}`,
      passwordHash: 'smoke-not-real',
      role: 'user',
      status: 'active',
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    const newTask = async (title: string): Promise<string> => {
      const [task] = await db
        .insert(schema.tasks)
        .values({
          userId,
          type: 'workflow',
          title,
          status: 'running',
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: schema.tasks.id });
      return task!.id;
    };
    const eventsOf = (taskId: string) =>
      db
        .select({ payload: schema.taskEvents.payload })
        .from(schema.taskEvents)
        .where(
          and(
            eq(schema.taskEvents.taskId, taskId),
            eq(schema.taskEvents.eventType, HOUSE_RULES_UNAVAILABLE_EVENT),
          ),
        );

    const first = await newTask('house-rules-event-smoke first');
    await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        recordHouseRulesUnavailable(db, first, i % 2 === 0 ? 'timeout' : 'refused'),
      ),
    );
    const written = await eventsOf(first);
    check(
      'sixteen concurrent dispatches write the event once',
      written.length === 1,
      written.length,
    );
    check(
      'it carries the error class and nothing else',
      JSON.stringify(Object.keys(written[0]?.payload ?? {})) === '["errorClass"]',
      written[0]?.payload,
    );

    await recordHouseRulesUnavailable(db, first, 'auth');
    check('a later dispatch of the same task adds nothing', (await eventsOf(first)).length === 1);

    const second = await newTask('house-rules-event-smoke second');
    await recordHouseRulesUnavailable(db, second, 'other');
    check('another task gets its own event', (await eventsOf(second)).length === 1);
    check('and the first task is unchanged', (await eventsOf(first)).length === 1);

    const third = await newTask('house-rules-event-smoke third');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const holder = db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${HOUSE_RULES_UNAVAILABLE_EVENT}:${third}`}, 0))`,
      );
      locked();
      await gate;
      await tx.insert(schema.taskEvents).values({
        taskId: third,
        eventType: HOUSE_RULES_UNAVAILABLE_EVENT,
        payload: { errorClass: 'other' },
      });
    });
    await lockTaken;
    let settled = 0;
    const waiting = Array.from({ length: 3 }, () =>
      recordHouseRulesUnavailable(db, third, 'timeout').finally(() => {
        settled += 1;
      }),
    );
    await sleep(500);
    check('dispatches wait behind a holder of the task lock', settled === 0, settled);
    check('and write nothing meanwhile', (await eventsOf(third)).length === 0);
    release();
    await holder;
    await Promise.all(waiting);
    const afterHolder = await eventsOf(third);
    check(
      'once it commits they find its row and add none',
      afterHolder.length === 1,
      afterHolder.length,
    );
    check(
      'the row is the one the holder wrote',
      (afterHolder[0]?.payload as { errorClass?: string } | null)?.errorClass === 'other',
      afterHolder[0]?.payload,
    );
  } finally {
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  }
}

main()
  .then(() => {
    log.info({ checks, failures }, failures === 0 ? 'house rules event smoke passed' : 'FAILED');
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    log.error({ err }, 'house rules event smoke crashed');
    process.exit(1);
  });
