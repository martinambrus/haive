/**
 * The two halves of the reset that are SQL, against a real database.
 *
 * The api's `onboarding-reset-provenance-smoke` covers which records the reset may READ. This one covers
 * what stops another writer destroying the tree underneath it, and what stops a finished run
 * re-asserting "onboarded" across it. Both are WHERE clauses, so the api and worker unit suites —
 * which run against no database — cannot reach either: drop a term and nothing there fails.
 *
 *   - `claimRepositoryRoot` must admit exactly ONE of two simultaneous claimants, refuse a
 *     claim on someone else's repository, and take over a claim old enough to be abandoned. A
 *     claim that admitted both would leave two resets walking one tree while every call still
 *     returned successfully.
 *   - `stampRepositoryOnboarded` must not stamp from a run that completed BEFORE the repository
 *     was reset, must not stamp from a cancelled run, and must still stamp the ordinary case.
 *
 * Safe against a populated install: it creates ONE throwaway user with its own repositories,
 * asserts only about those rows, and deletes the user in a `finally` — the cascade takes the
 * repositories and tasks with it. Nothing else is read or written.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  ROOT_CLAIM_STALE_MS,
  claimRepositoryRoot,
  readLiveRootClaim,
  releaseRepositoryRoot,
  renewRootClaim,
  schema,
} from '@haive/database';
import { logger } from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import { stampRepositoryOnboarded } from '../src/repo/onboarded.js';

const log = logger.child({ module: 'onboarding-reset-claim-smoke' });

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

const RESET_AT = new Date('2026-06-01T00:00:00Z');
const BEFORE_RESET = new Date('2026-05-01T00:00:00Z');
const AFTER_RESET = new Date('2026-07-01T00:00:00Z');

async function main(): Promise<void> {
  initDatabase(process.env.DATABASE_URL!);
  const db = getDb();

  const userId = randomUUID();
  const otherUserId = randomUUID();
  const now = new Date();

  try {
    for (const [id, tag] of [
      [userId, 'owner'],
      [otherUserId, 'other'],
    ] as const) {
      await db.insert(schema.users).values({
        id,
        emailEncrypted: `reset-claim-smoke-${tag}`,
        emailBlindIndex: `reset-claim-smoke-${tag}-${randomBytes(6).toString('hex')}`,
        passwordHash: 'smoke-not-real',
        role: 'user',
        status: 'active',
        tokenVersion: 0,
        createdAt: now,
        updatedAt: now,
      });
    }

    const newRepo = async (over: Partial<typeof schema.repositories.$inferInsert> = {}) => {
      const id = randomUUID();
      await db.insert(schema.repositories).values({
        id,
        userId,
        name: `reset-claim-smoke-${id.slice(0, 8)}`,
        source: 'blank',
        createdAt: now,
        updatedAt: now,
        ...over,
      });
      return id;
    };
    const repoRow = async (id: string) => {
      const row = await db.query.repositories.findFirst({
        where: eq(schema.repositories.id, id),
        columns: { onboardedAt: true, rootClaimedAt: true },
      });
      if (!row) throw new Error(`repository ${id} vanished`);
      return row;
    };

    // ---- claimRepositoryRoot ------------------------------------------------------------
    const repoA = await newRepo();
    const both = await Promise.all([
      claimRepositoryRoot(db, repoA, 'reset', userId),
      claimRepositoryRoot(db, repoA, 'reset', userId),
    ]);
    check(
      'exactly one of two simultaneous claims wins',
      both.filter((x) => x !== null).length === 1,
      both,
    );
    check(
      'the winning claim is visible to a writer',
      (await readLiveRootClaim(db, repoA)) !== null,
    );

    // On an UNCLAIMED repository, or the staleness term refuses it regardless and this passes
    // whether or not the ownership predicate is there at all. (It did, until a mutant showed it.)
    const unclaimed = await newRepo();
    check(
      'a claim on another user’s repository is refused',
      (await claimRepositoryRoot(db, unclaimed, 'reset', otherUserId)) === null,
    );
    check(
      'and that repository is still free for its owner',
      (await claimRepositoryRoot(db, unclaimed, 'reset', userId)) !== null,
    );
    await releaseRepositoryRoot(db, unclaimed);

    await releaseRepositoryRoot(db, repoA);
    check(
      'releasing clears it for the next writer',
      !((await readLiveRootClaim(db, repoA)) !== null),
    );
    check(
      'and the repository can be claimed again',
      (await claimRepositoryRoot(db, repoA, 'reset', userId)) !== null,
    );
    await releaseRepositoryRoot(db, repoA);

    // An API killed mid-walk leaves the row set. Bounded, or a crash would disable the feature.
    const stale = await newRepo({
      rootClaimedAt: new Date(Date.now() - ROOT_CLAIM_STALE_MS - 60_000),
    });
    check('an abandoned claim is not honoured', (await readLiveRootClaim(db, stale)) === null);
    check(
      'and is taken over rather than waited on',
      (await claimRepositoryRoot(db, stale, 'reset', userId)) !== null,
    );
    await releaseRepositoryRoot(db, stale);

    const fresh = await newRepo({ rootClaimedAt: new Date() });
    check(
      'a fresh claim by someone else still blocks',
      (await claimRepositoryRoot(db, fresh, 'reset', userId)) === null,
    );

    // A reset that outran the staleness window has already had its claim taken over. Its release
    // must not strip the protection from the walk that took over — silently, and exactly on the
    // slowest trees, which is where the window is reached in the first place.
    const handover = await newRepo({
      rootClaimedAt: new Date(Date.now() - ROOT_CLAIM_STALE_MS - 60_000),
    });
    const abandonedStamp = new Date(Date.now() - ROOT_CLAIM_STALE_MS - 60_000);
    const takenOver = await claimRepositoryRoot(db, handover, 'rebuild');
    check('the abandoned claim was taken over', takenOver !== null);
    await releaseRepositoryRoot(db, handover, abandonedStamp);
    check(
      'the abandoned holder’s release does not clear the new claim',
      (await readLiveRootClaim(db, handover)) !== null,
    );
    await releaseRepositoryRoot(db, handover, takenOver?.claimedAt);
    check(
      'and the real holder’s release does clear it',
      !((await readLiveRootClaim(db, handover)) !== null),
    );

    // A LEASE, not a deadline on the work: `gitClone` has no timeout and `copyTree` is unbounded
    // by repository size, so a fixed expiry cannot tell a dead holder from a slow one — and
    // expiring a live one re-admits the concurrent `rm -rf` the claim exists to exclude.
    const leased = await newRepo();
    const held = await claimRepositoryRoot(db, leased, 'rebuild');
    check('a lease starts out held', held !== null);
    // Age it past the window, as a long clone would.
    await db
      .update(schema.repositories)
      .set({ rootClaimedAt: new Date(Date.now() - ROOT_CLAIM_STALE_MS - 60_000) })
      .where(eq(schema.repositories.id, leased));
    check('an un-renewed lease goes stale', (await readLiveRootClaim(db, leased)) === null);

    const aged = (await db.query.repositories.findFirst({
      where: eq(schema.repositories.id, leased),
      columns: { rootClaimedAt: true },
    }))!.rootClaimedAt!;
    const renewed = await renewRootClaim(db, leased, aged);
    check('the holder can renew it', renewed !== null);
    check('and it is live again', (await readLiveRootClaim(db, leased)) !== null);
    check(
      'so a second destructive writer is refused',
      (await claimRepositoryRoot(db, leased, 'reset', userId)) === null,
    );

    // A holder whose lease WAS taken over learns it lost, instead of clawing it back.
    await db
      .update(schema.repositories)
      .set({ rootClaimedAt: new Date(Date.now() - ROOT_CLAIM_STALE_MS - 60_000) })
      .where(eq(schema.repositories.id, leased));
    const successor = await claimRepositoryRoot(db, leased, 'reset', userId);
    check('a genuinely abandoned lease is taken over', successor !== null);
    check(
      'and the previous holder cannot renew over the successor',
      (await renewRootClaim(db, leased, renewed!)) === null,
    );
    await releaseRepositoryRoot(db, leased, successor?.claimedAt);

    // ---- the owner token, against real SQL --------------------------------------------------
    // These are WHERE clauses, so the unit suite cannot reach them: its fakes ignore the
    // predicate entirely and would pass whatever it said. The collision they exist for is not
    // exotic — a takeover happens precisely WHILE the expired holder is renewing, so the
    // successor's claim and that renewal land in the same moment and can share a millisecond.
    // Without the owner term the old holder would then renew, or clear, a claim that is not its.
    const collide = await claimRepositoryRoot(db, leased, 'rebuild', userId);
    check('a fresh claim carries an owner token', collide !== null && collide.owner.length > 0);
    check(
      'a renewal from ANOTHER owner does not match, even with the right stamp',
      (await renewRootClaim(db, leased, collide!.claimedAt, new Date(), 'somebody-else')) === null,
    );
    check(
      'a release from ANOTHER owner clears nothing, even with the right stamp',
      (await releaseRepositoryRoot(db, leased, collide!.claimedAt, 'somebody-else')) === false,
    );
    check('and the claim is still held afterwards', (await readLiveRootClaim(db, leased)) !== null);
    // The real owner still works, so the term narrows nothing it should not.
    const renewedByOwner = await renewRootClaim(
      db,
      leased,
      collide!.claimedAt,
      new Date(),
      collide!.owner,
    );
    check('the true owner can still renew', renewedByOwner !== null);
    check(
      'and the true owner can still release',
      (await releaseRepositoryRoot(db, leased, renewedByOwner!, collide!.owner)) === true,
    );

    // ---- stampRepositoryOnboarded -----------------------------------------------------------
    const seedTask = async (
      repositoryId: string,
      over: Partial<typeof schema.tasks.$inferInsert> = {},
    ) => {
      const id = randomUUID();
      await db.insert(schema.tasks).values({
        id,
        userId,
        repositoryId,
        type: 'onboarding',
        title: 'smoke onboarding',
        status: 'completed',
        completedAt: AFTER_RESET,
        createdAt: now,
        updatedAt: now,
        ...over,
      });
      return id;
    };

    const plain = await newRepo();
    await stampRepositoryOnboarded(db, await seedTask(plain));
    check(
      'an ordinary completed run stamps the repository',
      (await repoRow(plain)).onboardedAt !== null,
    );

    const reset = await newRepo({ onboardingResetAt: RESET_AT });
    await stampRepositoryOnboarded(db, await seedTask(reset, { completedAt: BEFORE_RESET }));
    check(
      'a run that finished before the reset does NOT stamp',
      (await repoRow(reset)).onboardedAt === null,
    );

    const resetThenRan = await newRepo({ onboardingResetAt: RESET_AT });
    await stampRepositoryOnboarded(db, await seedTask(resetThenRan, { completedAt: AFTER_RESET }));
    check(
      'a run that finished after the reset stamps again',
      (await repoRow(resetThenRan)).onboardedAt !== null,
    );

    const cancelled = await newRepo();
    await stampRepositoryOnboarded(db, await seedTask(cancelled, { status: 'cancelled' }));
    check('a cancelled run never stamps', (await repoRow(cancelled)).onboardedAt === null);

    const upgrade = await newRepo();
    await stampRepositoryOnboarded(db, await seedTask(upgrade, { type: 'onboarding_upgrade' }));
    check('an upgrade run never stamps', (await repoRow(upgrade)).onboardedAt === null);

    if (failures > 0) {
      log.error({ failures, checks }, 'smoke FAILED');
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify({ smoke: 'ONBOARDING_RESET_CLAIM_OK', checks }));
    }
  } catch (err) {
    log.error({ err }, 'smoke failed');
    process.exitCode = 1;
  } finally {
    try {
      const db2 = getDb();
      for (const id of [userId, otherUserId]) {
        await db2.delete(schema.users).where(eq(schema.users.id, id));
      }
    } catch (cleanupErr) {
      log.warn({ err: cleanupErr }, 'cleanup failed');
    }
    process.exit(process.exitCode ?? 0);
  }
}

void main();
