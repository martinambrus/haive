import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROOT_CLAIM_STALE_MS } from '@haive/database';
import { liveWorkCount } from '../src/run.js';

const url = process.env.UPDATER_LIVE_COUNT_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/updater_live_count_test'))
  throw new Error('Use a dedicated updater_live_count_test database for the live work count tests');

const OWNER = '00000000-0000-4000-8000-0000000000f1';
const BLIND_INDEX = 'updater-live-count-test-owner';
const TYPE = 'updater-live-count-test';
const LIVE = ['queued', 'running', 'paused', 'waiting_user', 'waiting_pr'];
const FINISHED = ['completed', 'failed', 'cancelled'];

describe.skipIf(!url)('liveWorkCount on Postgres', () => {
  let sql: Sql;

  const task = (status: string, over: { deadAt?: Date; deadReason?: string } = {}) =>
    sql`INSERT INTO tasks (user_id, type, title, status, dead_at, dead_reason)
        VALUES (${OWNER}, ${TYPE}, 'Task', ${status}, ${over.deadAt ?? null}, ${over.deadReason ?? null})`;

  const repository = async (status: string) => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO repositories (user_id, name, source, status)
      VALUES (${OWNER}, 'live-count-repo', 'local_path', ${status}) RETURNING id`;
    return row!.id;
  };

  const bundle = async (repositoryId: string, status: string) => {
    await sql`INSERT INTO custom_bundles (user_id, repository_id, name, source_type, storage_root, status)
              VALUES (${OWNER}, ${repositoryId}, 'live-count-bundle', 'git', '/bundles/live-count', ${status})`;
  };

  const provider = (build: string, provision: string) =>
    sql`INSERT INTO cli_providers (user_id, name, label, sandbox_image_build_status, model_provision_status)
        VALUES (${OWNER}, 'claude-code', 'live-count-provider', ${build}, ${provision})`;

  beforeAll(async () => {
    sql = postgres(url as string, { max: 1 });
    await sql`DELETE FROM users WHERE email_blind_index = ${BLIND_INDEX}`;
    await sql`INSERT INTO users (id, email_encrypted, email_blind_index, password_hash)
              VALUES (${OWNER}, 'not-real', ${BLIND_INDEX}, 'not-real')`;
  });

  beforeEach(async () => {
    await sql`DELETE FROM tasks WHERE type = ${TYPE}`;
    await sql`DELETE FROM repositories WHERE user_id = ${OWNER}`;
    await sql`DELETE FROM cli_providers WHERE user_id = ${OWNER}`;
  });

  afterAll(async () => {
    await sql`DELETE FROM users WHERE email_blind_index = ${BLIND_INDEX}`;
    await sql.end({ timeout: 5 });
  });

  it('T594 R1: counts a ready repository until its queued refresh settles', async () => {
    const id = await repository('ready');
    await sql`UPDATE repositories SET refresh_pending = true WHERE id = ${id}`;
    expect(await liveWorkCount(sql)).toBe(1);
    await sql`UPDATE repositories SET refresh_pending = false WHERE id = ${id}`;
    expect(await liveWorkCount(sql)).toBe(0);
  });

  it('T594 R1: drains a source schema predating the refresh marker', async () => {
    await sql.begin(async (tx) => {
      await tx`CREATE TEMP TABLE repositories (LIKE public.repositories INCLUDING DEFAULTS) ON COMMIT DROP`;
      await tx`ALTER TABLE pg_temp.repositories DROP COLUMN refresh_pending`;
      await tx`INSERT INTO repositories (user_id, name, source, status) VALUES (${OWNER}, 'legacy', 'local_path', 'cloning')`;
      expect(await liveWorkCount(tx)).toBe(1);
    });
  });

  describe('a live root claim', () => {
    const KINDS = ['reset', 'rebuild', 'refresh', 'edit', 'mutation', 'verify', null] as const;
    const claim = (id: string, ageMs: number, kind: string | null = 'mutation', tx: Sql = sql) => {
      const stamp = new Date(Date.now() - ageMs).toISOString();
      return tx`UPDATE repositories
                SET root_claimed_at = ${stamp}::timestamp, root_claim_kind = ${kind}, root_claim_owner = 'test-owner'
                WHERE id = ${id}`;
    };
    const STALE = ROOT_CLAIM_STALE_MS + 60_000;
    const FRESH = ROOT_CLAIM_STALE_MS - 60_000;

    it.each(KINDS)('counts a ready repository claimed for %s', async (kind) => {
      const id = await repository('ready');
      await claim(id, 1000, kind);
      expect(await liveWorkCount(sql)).toBe(1);
    });

    it('does not count a stale claim', async () => {
      const id = await repository('ready');
      await claim(id, STALE);
      expect(await liveWorkCount(sql)).toBe(0);
    });

    it('counts a claim inside the window', async () => {
      const id = await repository('ready');
      await claim(id, FRESH);
      expect(await liveWorkCount(sql)).toBe(1);
    });

    it('counts a repository once however many reasons hold it', async () => {
      const id = await repository('cloning');
      await sql`UPDATE repositories SET refresh_pending = true WHERE id = ${id}`;
      await claim(id, 1000);
      expect(await liveWorkCount(sql)).toBe(1);
    });

    it('does not count a released claim', async () => {
      const id = await repository('ready');
      await claim(id, 1000);
      await sql`UPDATE repositories SET root_claimed_at = NULL, root_claim_kind = NULL, root_claim_owner = NULL WHERE id = ${id}`;
      expect(await liveWorkCount(sql)).toBe(0);
    });

    it.each([
      ['a stale claim', STALE, 0],
      ['a claim inside the window', FRESH, 1],
    ])('reads %s the same under another session time zone', async (_name, age, expected) => {
      const id = await repository('ready');
      await claim(id, age);
      await sql.begin(async (tx) => {
        await tx`SET LOCAL TIME ZONE 'Pacific/Auckland'`;
        expect(await liveWorkCount(tx)).toBe(expected);
      });
    });

    it.each([
      [
        'claim columns',
        'root_claimed_at, DROP COLUMN root_claim_kind, DROP COLUMN root_claim_owner',
      ],
      [
        'claim columns and the refresh marker',
        'root_claimed_at, DROP COLUMN root_claim_kind, DROP COLUMN root_claim_owner, DROP COLUMN refresh_pending',
      ],
    ])('drains a source schema without the %s', async (_name, drop) => {
      await sql.begin(async (tx) => {
        await tx`CREATE TEMP TABLE repositories (LIKE public.repositories INCLUDING DEFAULTS) ON COMMIT DROP`;
        await tx.unsafe(`ALTER TABLE pg_temp.repositories DROP COLUMN ${drop}`);
        await tx`INSERT INTO repositories (user_id, name, source, status) VALUES (${OWNER}, 'legacy', 'local_path', 'cloning')`;
        expect(await liveWorkCount(tx)).toBe(1);
      });
    });
  });

  it('counts a task in every live status', async () => {
    for (const status of LIVE) await task(status);

    expect(await liveWorkCount(sql)).toBe(LIVE.length);
  });

  it('counts legacy live tasks before migration 0197, including the fenced recount', async () => {
    await sql.begin(async (tx) => {
      // A session-local copy of the migrated table without 0197's two additions is the
      // counter's pre-0197 schema. Shadowing also proves detection follows the query's table.
      await tx`CREATE TEMP TABLE tasks (LIKE public.tasks INCLUDING DEFAULTS) ON COMMIT DROP`;
      await tx`ALTER TABLE pg_temp.tasks DROP COLUMN dead_at, DROP COLUMN dead_reason`;
      for (const status of [...LIVE, 'created', ...FINISHED]) {
        await tx`INSERT INTO tasks (user_id, type, title, status)
                 VALUES (${OWNER}, ${TYPE}, 'Legacy task', ${status})`;
      }
      // max: 1: use the held transaction for every fixture write too.
      const [repo] = await tx<{ id: string }[]>`
        INSERT INTO repositories (user_id, name, source, status)
        VALUES (${OWNER}, 'legacy-repo', 'local_path', 'cloning') RETURNING id`;
      await tx`INSERT INTO custom_bundles (user_id, repository_id, name, source_type, storage_root, status)
               VALUES (${OWNER}, ${repo!.id}, 'legacy-bundle', 'git', '/bundles/legacy', 'syncing')`;
      await tx`INSERT INTO cli_providers (user_id, name, label, sandbox_image_build_status, model_provision_status)
               VALUES (${OWNER}, 'claude-code', 'legacy-provider', 'building', 'provisioning')`;

      expect(await liveWorkCount(tx, 'draining')).toBe(LIVE.length + 3);
      expect(await liveWorkCount(tx, 'maintenance')).toBe(2 + 3);
    });
  });

  it('counts a queued task and not a created one, a draft that never ran, beside it', async () => {
    await task('queued');
    await task('created');

    expect(await liveWorkCount(sql)).toBe(1);
  });

  it('counts a running task and not a dead running one beside it', async () => {
    await task('running');
    await task('running', { deadAt: new Date() });

    expect(await liveWorkCount(sql)).toBe(1);
  });

  it('leaves a dead task out whatever live status it died in', async () => {
    for (const status of LIVE) await task(status, { deadAt: new Date() });

    expect(await liveWorkCount(sql)).toBe(0);
  });

  it('keys on dead_at, so a dead_reason that outlived it still counts the task', async () => {
    await task('running', { deadReason: 'a step was missing once' });

    expect(await liveWorkCount(sql)).toBe(1);
  });

  it('does not count a finished task', async () => {
    for (const status of FINISHED) await task(status);

    expect(await liveWorkCount(sql)).toBe(0);
  });

  describe('the background jobs a route queues', () => {
    it('counts a repository that is cloning and not one that is ready or in error', async () => {
      await repository('cloning');
      await repository('ready');
      await repository('error');

      expect(await liveWorkCount(sql)).toBe(1);
    });

    it('counts a bundle that is syncing and not one that is active or failed', async () => {
      const id = await repository('ready');
      await bundle(id, 'syncing');
      await bundle(id, 'active');
      await bundle(id, 'failed');

      expect(await liveWorkCount(sql)).toBe(1);
    });

    it('counts a provider whose sandbox image is building and not one that is idle, ready or failed', async () => {
      await provider('building', 'idle');
      await provider('idle', 'idle');
      await provider('ready', 'idle');
      await provider('failed', 'idle');

      expect(await liveWorkCount(sql)).toBe(1);
    });

    it('counts a provider whose model is provisioning and not one that is idle, ready or failed', async () => {
      await provider('idle', 'provisioning');
      await provider('idle', 'idle');
      await provider('idle', 'ready');
      await provider('idle', 'failed');

      expect(await liveWorkCount(sql)).toBe(1);
    });

    it('counts a provider once when its image is building and its model is provisioning', async () => {
      await provider('building', 'provisioning');

      expect(await liveWorkCount(sql)).toBe(1);
    });

    it('adds every kind to the tasks, and counts nothing once they are all finished', async () => {
      await task('running');
      const id = await repository('cloning');
      await bundle(id, 'syncing');
      await provider('building', 'idle');
      await provider('idle', 'provisioning');

      expect(await liveWorkCount(sql)).toBe(5);

      await sql`UPDATE tasks SET status = 'completed' WHERE type = ${TYPE}`;
      await sql`UPDATE repositories SET status = 'ready' WHERE user_id = ${OWNER}`;
      await sql`UPDATE custom_bundles SET status = 'active' WHERE user_id = ${OWNER}`;
      await sql`UPDATE cli_providers SET sandbox_image_build_status = 'ready',
                                         model_provision_status = 'ready'
                 WHERE user_id = ${OWNER}`;

      expect(await liveWorkCount(sql)).toBe(0);
    });
  });

  describe('under the maintenance state', () => {
    const seedLive = async () => {
      for (const status of LIVE) await task(status);
    };

    it.each([undefined, 'normal', 'draining'] as const)(
      'counts every live status when the state is %s',
      async (state) => {
        await seedLive();

        expect(await liveWorkCount(sql, state)).toBe(LIVE.length);
      },
    );

    it('counts only the queued and running tasks under maintenance', async () => {
      await seedLive();

      expect(await liveWorkCount(sql, 'maintenance')).toBe(2);
    });

    it('still counts the background jobs under maintenance', async () => {
      await task('running');
      await task('waiting_user');
      const id = await repository('cloning');
      await bundle(id, 'syncing');
      await provider('building', 'idle');
      await provider('idle', 'provisioning');

      expect(await liveWorkCount(sql, 'maintenance')).toBe(5);
      expect(await liveWorkCount(sql, 'normal')).toBe(6);
    });

    it('still leaves a dead task and a created one out under maintenance', async () => {
      await task('running', { deadAt: new Date() });
      await task('waiting_user', { deadAt: new Date() });
      await task('created');

      expect(await liveWorkCount(sql, 'maintenance')).toBe(0);
    });
  });
});
