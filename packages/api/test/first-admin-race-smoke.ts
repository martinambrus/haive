/**
 * The one thing unit tests cannot cover about first-admin bootstrap: CONCURRENCY.
 *
 * `decideRegistration` is pure and exhaustively tested, but it answers from a `userCount` the
 * ROUTE supplies. Two simultaneous registrations against an empty install both read zero and both
 * become administrators — a silent privilege bug that is invisible in every sequential test, and
 * the reason `POST /auth/register` counts and inserts inside one transaction holding
 * `pg_advisory_xact_lock(hashtext('haive_bootstrap'), hashtext('first_admin'))`.
 *
 * This fires N registrations at once and asserts the invariant the lock exists for: the database
 * ends with exactly ONE user and that user is an admin.
 *
 * REFUSES to run against a database that already has users. Emptying one to test would be a
 * destructive act on somebody's install, and a smoke that quietly skipped would be worse than
 * absent — it would report a pass for a check that never ran. On CI it runs against the freshly
 * migrated database, before any other smoke inserts a user, which is why it is first in smoke:ci.
 */
import { count, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { configService, secretsService, userSecretsService, logger } from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import { initRedis, closeRedis } from '../src/redis.js';
import { createApiApp } from '../src/index.js';

const log = logger.child({ module: 'first-admin-race-smoke' });

const REQUIRED_ENV = ['DATABASE_URL', 'REDIS_URL', 'CONFIG_ENCRYPTION_KEY'] as const;
for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    console.error(`[smoke] missing env ${k}`);
    process.exit(2);
  }
}

/** Enough to lose the race reliably without spending a second on bcrypt per contender. */
const CONTENDERS = 5;

interface Outcome {
  status: number;
  role?: string;
  id?: string;
}

async function main(): Promise<void> {
  let exitCode = 0;
  const createdIds: string[] = [];
  try {
    initRedis(process.env.REDIS_URL!);
    await configService.initialize(process.env.REDIS_URL!);
    const db = initDatabase(process.env.DATABASE_URL!);
    await secretsService.initialize(db);
    await userSecretsService.initialize(db, await secretsService.getMasterKek());

    const [before] = await db.select({ n: count() }).from(schema.users);
    if (Number(before?.n ?? 0) !== 0) {
      console.error(
        `[smoke] REFUSING: this database already has ${before?.n} user(s). The first-admin race ` +
          'is only meaningful on an empty install, and emptying one to test it is not this ' +
          "smoke's call to make.",
      );
      process.exit(2);
    }

    // SETUP_TOKEN would gate every one of these, so the race would never be reached and the smoke
    // would pass without testing anything.
    if ((process.env.SETUP_TOKEN ?? '').trim().length > 0) {
      console.error('[smoke] REFUSING: SETUP_TOKEN is set, which gates the very branch under test');
      process.exit(2);
    }

    const app = createApiApp('http://localhost:3000');

    const outcomes = await Promise.all(
      Array.from({ length: CONTENDERS }, async (_, i): Promise<Outcome> => {
        const res = await app.request('/auth/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: `race-${i}-${process.pid}@smoke.local`,
            password: 'first-admin-race-smoke-password',
          }),
        });
        if (res.status !== 201) return { status: res.status };
        const body = (await res.json()) as { user: { id: string; role: string } };
        return { status: res.status, role: body.user.role, id: body.user.id };
      }),
    );
    for (const o of outcomes) if (o.id) createdIds.push(o.id);

    const created = outcomes.filter((o) => o.status === 201);
    const admins = created.filter((o) => o.role === 'admin');

    const failures: string[] = [];
    const check = (label: string, ok: boolean, detail?: unknown): void => {
      if (ok) console.log(`[smoke] ok   ${label}`);
      else {
        console.error(`[smoke] FAIL ${label} — ${JSON.stringify(detail)}`);
        failures.push(label);
      }
    };

    check('exactly one registration succeeded', created.length === 1, outcomes);
    check('the survivor is an administrator', admins.length === 1, outcomes);
    // The mode defaults to `closed`, so every loser is refused rather than admitted as a user —
    // and 403 rather than 409, because they lost on the COUNT, not on a duplicate address.
    check(
      'every loser was refused, none silently admitted',
      outcomes.filter((o) => o.status === 403).length === CONTENDERS - 1,
      outcomes.map((o) => o.status),
    );

    const rows = await db
      .select({ id: schema.users.id, role: schema.users.role })
      .from(schema.users);
    check('the database holds exactly one user', rows.length === 1, rows);
    check('and that user is the administrator', rows[0]?.role === 'admin', rows);

    if (failures.length > 0) {
      exitCode = 1;
      console.error(`[smoke] ${failures.length} FAILED: ${failures.join(', ')}`);
    } else {
      console.log(
        JSON.stringify({ smoke: 'FIRST_ADMIN_RACE_OK', checks: 5, contenders: CONTENDERS }),
      );
    }
  } catch (err) {
    exitCode = 1;
    log.error({ err }, 'smoke failed');
    console.error('[smoke] FAILED:', err);
  } finally {
    try {
      const db = getDb();
      // Only what this run created. It refused to start against a non-empty table, so there is
      // nothing else here — but deleting by id rather than truncating keeps that true if the
      // refusal is ever relaxed.
      for (const id of createdIds) {
        await db.delete(schema.users).where(eq(schema.users.id, id));
      }
    } catch (cleanupErr) {
      log.warn({ err: cleanupErr }, 'cleanup failed');
    }
    await closeRedis().catch(() => {});
    process.exit(exitCode);
  }
}

void main();
