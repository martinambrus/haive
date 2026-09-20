/**
 * The half of the onboarding reset that unit tests cannot reach: CONCURRENCY.
 *
 * `onboarding-reset-provenance-smoke` covers which RECORDS the reset may read. This one covers
 * what stops a run writing into the tree while the reset walks it: an advisory lock, which is SQL,
 * and the api suite runs against no database.
 *
 * `lockRepositoryRoot` must produce the SAME lock from the api's call and from the worker's, and
 * must exclude a second taker for as long as its transaction lives. A key that stopped matching is
 * the one bug here that looks exactly like working code: every call still returns successfully and
 * the mutual exclusion is simply gone.
 *
 * Safe against a populated install: it creates ONE throwaway user with its own repository, asserts
 * only about those rows, and deletes the user in a `finally` — the cascade takes the repository
 * and tasks with it. Nothing else in the database is read or written.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { schema, lockRepositoryRoot, tryLockRepositoryRoot } from '@haive/database';
import { logger } from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';

const log = logger.child({ module: 'reset-revive-race-smoke' });

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

/** Set once the lock-holding transaction below is open, so the `finally` can end it however the
 *  run exits. */
let releaseHolder: (() => void) | undefined;

async function main(): Promise<void> {
  initDatabase(process.env.DATABASE_URL!);
  const db = getDb();

  const userId = randomUUID();
  const repoId = randomUUID();
  const now = new Date();

  try {
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'reset-revive-race-smoke',
      emailBlindIndex: `reset-revive-race-smoke-${randomBytes(6).toString('hex')}`,
      passwordHash: 'smoke-not-real',
      role: 'user',
      status: 'active',
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.repositories).values({
      id: repoId,
      userId,
      name: `reset-revive-race-smoke-${repoId.slice(0, 8)}`,
      source: 'blank',
      createdAt: now,
      updatedAt: now,
    });

    // ---- lockRepositoryRoot ---------------------------------------------------------------
    // One transaction holds the lock; a second, on its own connection, must be unable to take it
    // until the first commits. Both sides go through the exported helper, so a key that stopped
    // matching would show up here as the lock simply not excluding anything.
    let release!: () => void;
    const holdUntil = new Promise<void>((resolve) => {
      release = resolve;
    });
    releaseHolder = release;
    let acquired!: () => void;
    const isHeld = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const holder = db.transaction(async (tx) => {
      await lockRepositoryRoot(tx, repoId);
      acquired();
      await holdUntil;
    });
    await isHeld;

    await db.transaction(async (tx) => {
      check('a held root lock refuses a second taker', !(await tryLockRepositoryRoot(tx, repoId)));
      // The same repository spelled with uppercase hex is the same ROW to Postgres, so it must be
      // the same lock. Without the key normalisation it hashes differently and this one passes.
      check(
        'an uppercase spelling of the id takes the same lock',
        !(await tryLockRepositoryRoot(tx, repoId.toUpperCase())),
      );
      // A different repository is a different lock, or the gate would serialise the whole install.
      check('another repository is unaffected', await tryLockRepositoryRoot(tx, randomUUID()));
    });

    // The blocking form must genuinely WAIT rather than return: bounded by lock_timeout so a bug
    // is a failure here instead of a hung smoke. The catch sits OUTSIDE the transaction because a
    // failed statement aborts it and the wrapper re-raises whatever the callback swallowed.
    let waited = 'acquired';
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '1000ms'`);
        await lockRepositoryRoot(tx, repoId);
      });
    } catch (err) {
      // Drizzle re-wraps the driver error as `Failed query: …` and carries the original on
      // `cause`, so the SQLSTATE is one level down.
      const code =
        (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
      waited = code === '55P03' ? 'waited' : `threw ${String(err)}`;
    }
    check('the blocking form waits for the holder', waited === 'waited', waited);

    release();
    await holder;
    const afterRelease = await db.transaction((tx) => tryLockRepositoryRoot(tx, repoId));
    check('the lock is released when its transaction ends', afterRelease);

    if (failures > 0) {
      log.error({ failures, checks }, 'smoke FAILED');
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify({ smoke: 'RESET_REVIVE_RACE_OK', checks }));
    }
  } catch (err) {
    log.error({ err }, 'smoke failed');
    process.exitCode = 1;
  } finally {
    // Let any still-open holder transaction end, or its connection sits in the pool holding the
    // lock while the cleanup below runs.
    releaseHolder?.();
    try {
      // Only the user this run created; the cascade takes its repository and tasks.
      await getDb().delete(schema.users).where(eq(schema.users.id, userId));
    } catch (cleanupErr) {
      log.warn({ err: cleanupErr }, 'cleanup failed');
    }
    // postgres.js holds the pool open; nothing else here needs the process alive.
    process.exit(process.exitCode ?? 0);
  }
}

void main();
