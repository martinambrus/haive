/**
 * The boot repair for a run superseded while it ran and then abandoned by a restart, against a
 * database. One throwaway user and task, deleted after.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { logger } from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import { endAbandonedSupersededRuns } from '../src/data-migrations.js';

const log = logger.child({ module: 'superseded-runs-smoke' });

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

async function main(): Promise<void> {
  initDatabase(process.env.DATABASE_URL!);
  const db = getDb();
  const userId = randomUUID();
  const now = new Date();

  try {
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'superseded-runs-smoke',
      emailBlindIndex: `superseded-runs-smoke-${randomBytes(6).toString('hex')}`,
      passwordHash: 'smoke-not-real',
      role: 'user',
      status: 'active',
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        type: 'workflow',
        title: 'superseded-runs-smoke',
        status: 'completed',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: schema.tasks.id });

    const at = (minute: number) => new Date(Date.UTC(2026, 8, 5, 23, minute));
    const run = (over: Partial<typeof schema.cliInvocations.$inferInsert>) => ({
      taskId: task!.id,
      mode: 'cli' as const,
      prompt: 'superseded-runs-smoke',
      ...over,
    });
    const [abandoned, running, queued, finished] = await db
      .insert(schema.cliInvocations)
      .values([
        run({ startedAt: at(16), supersededAt: at(19) }),
        run({ startedAt: at(16) }),
        run({ supersededAt: at(19) }),
        run({ startedAt: at(16), supersededAt: at(19), endedAt: at(17) }),
      ])
      .returning({ id: schema.cliInvocations.id });
    const ours = new Set([abandoned!.id, running!.id, queued!.id, finished!.id]);
    const endOf = async (id: string) =>
      (
        await db
          .select({ endedAt: schema.cliInvocations.endedAt })
          .from(schema.cliInvocations)
          .where(eq(schema.cliInvocations.id, id))
      )[0]?.endedAt ?? null;

    const first = (await endAbandonedSupersededRuns(db)).filter((id) => ours.has(id));
    check(
      'a superseded run a restart abandoned gets its end, and only it',
      first.length === 1 && first[0] === abandoned!.id,
      first,
    );
    check(
      'at the later of its start and its supersede',
      (await endOf(abandoned!.id))?.getTime() === at(19).getTime(),
    );
    check('a run still going is left alone', (await endOf(running!.id)) === null);
    check('a run never started is left alone', (await endOf(queued!.id)) === null);
    check(
      'a run that ended keeps its end',
      (await endOf(finished!.id))?.getTime() === at(17).getTime(),
    );
    const second = (await endAbandonedSupersededRuns(db)).filter((id) => ours.has(id));
    check('a second run changes nothing', second.length === 0, second);

    if (failures > 0) {
      log.error({ failures, checks }, 'smoke FAILED');
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify({ smoke: 'SUPERSEDED_RUNS_OK', checks }));
    }
  } catch (err) {
    log.error({ err }, 'smoke failed');
    process.exitCode = 1;
  } finally {
    try {
      await getDb().delete(schema.users).where(eq(schema.users.id, userId));
    } catch (cleanupErr) {
      log.warn({ err: cleanupErr }, 'cleanup failed');
    }
    process.exit(process.exitCode ?? 0);
  }
}

void main();
