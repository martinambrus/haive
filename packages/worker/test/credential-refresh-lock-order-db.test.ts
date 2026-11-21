import { randomBytes } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, isLockNotAvailable, schema, type Database } from '@haive/database';
import type { DockerRunner } from '../src/sandbox/docker-runner.js';
import { refreshExpiringCliCredentials } from '../src/usage-window/credential-refresh.js';
import { readVolumeFile } from '../src/usage-window/token-source.js';

vi.mock('../src/usage-window/token-source.js', () => ({
  readVolumeFile: vi.fn(),
  writeVolumeFile: vi.fn(),
}));
vi.mock('../src/sandbox/auth-volume-reaper.js', () => ({
  listTaskAuthVolumes: vi.fn(async () => []),
}));

const url = process.env.CREDENTIAL_REFRESH_LOCK_ORDER_TEST_URL;
const dbName = url ? new URL(url).pathname.slice(1) : '';
if (url && !/^credential_refresh_lock_order_test[a-z0-9_]*$/.test(dbName))
  throw new Error(
    'Use a dedicated credential_refresh_lock_order_test database for the credential refresh lock-order test',
  );

// A rejected grok refresh token marks every row that shares the volume as needing a re-login. The image
// job locks provider rows in id order without the auth lock, so a status write that locks the rows in
// the order a statement scans them holds a higher id while it waits for a lower one the image job holds,
// the deadlock lockLoginSet exists to prevent.
//
// The rows are inserted highest id first and the database scans in heap order (index and bitmap scans
// off, for this throwaway database only), so an unordered UPDATE reaches the highest id first. The peer
// holds the lowest id, as the image job does, and the code under test must be waiting for it while
// holding none of the higher ids.
const BASE = '00000000-0000-4000-8000-0000000000';
const IDS = [`${BASE}d1`, `${BASE}d2`, `${BASE}d3`] as const;
const BLIND_INDEX = 'credential-refresh-lock-order-test-user';
const BLOCKED_WITHIN_MS = 5000;
const TEST_TIMEOUT = 30_000;

describe.skipIf(!url)(
  'grok credential refresh status write beside an id-ordered lock holder',
  () => {
    let db: Database;
    let peer: Database;
    let userId: string;

    beforeAll(async () => {
      const admin = createDatabase(url as string);
      try {
        await admin.execute(sql.raw(`ALTER DATABASE ${dbName} SET enable_indexscan = off`));
        await admin.execute(sql.raw(`ALTER DATABASE ${dbName} SET enable_bitmapscan = off`));
      } finally {
        await admin.$client.end({ timeout: 5 });
      }
      db = createDatabase(url as string);
      peer = createDatabase(url as string);
      await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
      const [user] = await db
        .insert(schema.users)
        .values({
          emailEncrypted: 'credential-refresh-lock-order-test@test.local',
          emailBlindIndex: BLIND_INDEX,
          passwordHash: 'not-real',
          role: 'user',
        })
        .returning({ id: schema.users.id });
      userId = user!.id;
      for (const id of [...IDS].reverse())
        await db.insert(schema.cliProviders).values({
          id,
          userId,
          name: 'grok',
          authMode: 'subscription',
          isolateAuth: false,
          label: id,
          authStatus: 'ok',
          authMessage: 'authenticated',
        });
    });

    beforeEach(async () => {
      await db
        .update(schema.cliProviders)
        .set({ authStatus: 'ok', authMessage: 'authenticated', isolateAuth: false })
        .where(inArray(schema.cliProviders.id, [...IDS]));
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    afterAll(async () => {
      await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
      await db.$client.end({ timeout: 5 });
      await peer.$client.end({ timeout: 5 });
    });

    /** Whether some backend waits for a lock the backend `pid` holds. */
    const blockedBy = async (pid: number) => {
      const [row] = await db.execute<{ blocked: boolean }>(sql`
      select exists (
        select 1 from pg_stat_activity
        where wait_event_type = 'Lock' and ${pid}::int = any (pg_blocking_pids(pid))
      ) as blocked`);
      return row?.blocked === true;
    };

    // A wait on database state, the exception the testing guide allows; the deadline is kept small.
    const waitUntil = async (condition: () => Promise<boolean>) => {
      const deadline = Date.now() + BLOCKED_WITHIN_MS;
      while (!(await condition())) {
        if (Date.now() > deadline)
          throw new Error(`no backend was blocked by the peer within ${BLOCKED_WITHIN_MS} ms`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };

    /** The rows of `ids` that someone holds right now. FOR UPDATE, since only it conflicts with a KEY SHARE. */
    const rowsHeld = async (ids: string[]) => {
      const held: string[] = [];
      for (const id of ids)
        await db
          .transaction((tx) =>
            tx.execute(sql`select id from cli_providers where id = ${id} for update nowait`),
          )
          .catch((error: unknown) => {
            if (!isLockNotAvailable(error)) throw error;
            held.push(id);
          });
      return held;
    };

    it(
      'holds none of the higher rows while it waits for the lowest, then marks every row',
      async () => {
        vi.mocked(readVolumeFile).mockResolvedValue(
          JSON.stringify({
            'issuer::client': {
              key: randomBytes(16).toString('hex'),
              refresh_token: randomBytes(16).toString('hex'),
              oidc_client_id: 'client',
              expires_at: '2020-01-01T00:00:00Z',
            },
          }),
        );
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => ({
            ok: false,
            status: 400,
            text: async () => '{"error":"invalid_grant"}',
          })),
        );
        let holds!: () => void;
        const holding = new Promise<void>((resolve) => (holds = resolve));
        let release!: () => void;
        const released = new Promise<void>((resolve) => (release = resolve));
        let pid = 0;
        const peerRun = peer.transaction(async (tx) => {
          const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
          pid = row!.pid;
          await tx.execute(sql`select id from cli_providers where id = ${IDS[0]} for update`);
          holds();
          await released;
        });
        await Promise.race([holding, peerRun]);
        let refresh: Promise<void> | undefined;
        let held: string[] = [];
        try {
          refresh = refreshExpiringCliCredentials(db, {} as DockerRunner);
          await waitUntil(() => blockedBy(pid));
          held = await rowsHeld([IDS[1], IDS[2]]);
        } finally {
          release();
          await peerRun;
          await refresh;
        }
        expect(held).toEqual([]);
        const rows = await db
          .select({
            authStatus: schema.cliProviders.authStatus,
            authMessage: schema.cliProviders.authMessage,
          })
          .from(schema.cliProviders)
          .where(inArray(schema.cliProviders.id, [...IDS]));
        expect(rows).toHaveLength(3);
        for (const row of rows) {
          expect(row.authStatus).toBe('unknown');
          expect(row.authMessage).toContain('sign-in expired');
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'writes the status to the rows it locked, not the rows it read before the lock',
      async () => {
        vi.mocked(readVolumeFile).mockResolvedValue(
          JSON.stringify({
            'issuer::client': {
              key: randomBytes(16).toString('hex'),
              refresh_token: randomBytes(16).toString('hex'),
              oidc_client_id: 'client',
              expires_at: '2020-01-01T00:00:00Z',
            },
          }),
        );
        // The stub runs after the tick read the rows and took the advisory lock, before the transaction:
        // one row leaves the set in that gap.
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => {
            await db
              .update(schema.cliProviders)
              .set({ isolateAuth: true })
              .where(eq(schema.cliProviders.id, IDS[1]));
            return { ok: false, status: 400, text: async () => '{"error":"invalid_grant"}' };
          }),
        );
        await refreshExpiringCliCredentials(db, {} as DockerRunner);
        const rows = await db
          .select({
            id: schema.cliProviders.id,
            authStatus: schema.cliProviders.authStatus,
            authMessage: schema.cliProviders.authMessage,
          })
          .from(schema.cliProviders)
          .where(inArray(schema.cliProviders.id, [...IDS]));
        const byId = new Map(rows.map((row) => [row.id, row]));
        for (const id of [IDS[0], IDS[2]]) {
          expect(byId.get(id)?.authStatus).toBe('unknown');
          expect(byId.get(id)?.authMessage).toContain('sign-in expired');
        }
        expect(byId.get(IDS[1])?.authStatus).toBe('ok');
        expect(byId.get(IDS[1])?.authMessage).toBe('authenticated');
      },
      TEST_TIMEOUT,
    );
  },
);
