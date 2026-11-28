import { randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  isLockNotAvailable,
  schema,
  tryCliAuthLock,
  type Database,
} from '@haive/database';
import { cliAuthTaskVolumeName, resolveCliAuthUserVolumeName } from '@haive/shared';
import { cliAuthScope } from '@haive/shared/cli-auth-state';
import { advanceStep } from '../src/step-engine/step-runner.js';
import { ensureTaskAuthVolumes } from '../src/sandbox/task-auth-volume.js';
import type { DockerRunner } from '../src/sandbox/docker-runner.js';
import {
  AUTH_ADMISSION_RETRY_DELAY_MS,
  CliAuthRetryableError,
} from '../src/sandbox/cli-auth-errors.js';
import { refreshExpiringCliCredentials } from '../src/usage-window/credential-refresh.js';
import { readVolumeFile, writeVolumeFile } from '../src/usage-window/token-source.js';
import { GROK_REFRESH_FENCE_FILE } from '../src/usage-window/grok-refresh-fence.js';

const dockerVolumes = vi.hoisted(() => ({ names: [] as string[], calls: 0 }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const { EventEmitter } = await import('node:events');
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (args[0] !== 'docker' || args[1]?.[0] !== 'volume' || args[1]?.[1] !== 'ls')
        return actual.spawn(...args);
      dockerVolumes.calls++;
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(dockerVolumes.names.join('\n')));
        child.emit('close', 0);
      });
      return child;
    },
  };
});

const authAttempts = vi.hoisted(() => ({
  onBusy: (_scope: string) => {},
  phase: '',
  onRelease: (_phase: string, _ms: number) => {},
}));
vi.mock('@haive/database', async (original) => {
  const actual = await original<typeof import('@haive/database')>();
  return {
    ...actual,
    tryCliAuthLock: async (db: Database, scope: string) => {
      const lock = await actual.tryCliAuthLock(db, scope);
      if (!lock) authAttempts.onBusy(scope);
      if (!lock) return null;
      const phase = authAttempts.phase;
      const start = performance.now();
      return Object.assign(
        async () => {
          await lock();
          authAttempts.onRelease(phase, performance.now() - start);
        },
        { assertHeld: lock.assertHeld },
      );
    },
  };
});
vi.mock('../src/sandbox/sandbox-core-image.js', () => ({ ensureSandboxCoreImage: async () => {} }));

vi.mock('../src/usage-window/token-source.js', () => ({
  readVolumeFile: vi.fn(),
  writeVolumeFile: vi.fn(),
  NonRegularVolumeFileError: class extends Error {},
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
      vi.mocked(writeVolumeFile).mockReset().mockResolvedValue(true);
      vi.mocked(readVolumeFile).mockReset();
      authAttempts.onBusy = () => {};
      authAttempts.onRelease = () => {};
      authAttempts.phase = '';
      dockerVolumes.names = [];
      dockerVolumes.calls = 0;
      await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
      await db.delete(schema.auditEvents).where(eq(schema.auditEvents.actorUserId, userId));
      await db
        .update(schema.cliProviders)
        .set({ authStatus: 'ok', authMessage: 'authenticated', isolateAuth: false })
        .where(inArray(schema.cliProviders.id, [...IDS]));
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    afterAll(async () => {
      await db.delete(schema.auditEvents).where(eq(schema.auditEvents.actorUserId, userId));
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
      'adoption waits for the rotating scope, then recopies; a different scope stays free',
      async () => {
        const ctx = {
          userId,
          providerId: IDS[0],
          providerName: 'grok' as const,
          authMode: 'subscription' as const,
          isolateAuth: false,
        };
        const scope = cliAuthScope({ ...ctx, id: ctx.providerId, name: ctx.providerName });
        const userVol = resolveCliAuthUserVolumeName(ctx, 0);
        const taskId = randomUUID();
        const taskVol = cliAuthTaskVolumeName(taskId, 'grok', 0);
        const volumes = new Set([userVol, taskVol]);
        let userBytes = JSON.stringify({
          'issuer::client': {
            key: randomBytes(16).toString('hex'),
            refresh_token: randomBytes(16).toString('hex'),
            oidc_client_id: 'client',
            expires_at: '2020-01-01T00:00:00Z',
          },
        });
        const initial = userBytes;
        let taskBytes = initial;
        let fence: string | null = null;
        vi.mocked(readVolumeFile).mockImplementation(async (vol, path) =>
          path === GROK_REFRESH_FENCE_FILE ? fence : vol === userVol ? userBytes : taskBytes,
        );
        vi.mocked(writeVolumeFile).mockImplementation(async (_vol, path, bytes) => {
          if (path === GROK_REFRESH_FENCE_FILE) fence = bytes;
          else userBytes = bytes;
          return true;
        });
        const runner = {
          volumeExists: async (vol: string) => volumes.has(vol),
          volumeLabel: async () =>
            JSON.stringify({
              version: 1,
              userVolume: userVol,
              authMode: 'subscription',
              isolateAuth: false,
            }),
          volumeRemove: async (vol: string) => {
            volumes.delete(vol);
            return { ok: true, stderr: '' };
          },
          volumeCreate: async (vol: string) => {
            volumes.add(vol);
            return { ok: true, stderr: '' };
          },
          run: async (opts: { mounts?: { target: string }[] }) => {
            let exitCode = 0;
            if (opts.mounts?.some((mount) => mount.target === '/x'))
              exitCode = taskBytes === userBytes ? 0 : 2;
            if (opts.mounts?.some((mount) => mount.target === '/dst')) taskBytes = userBytes;
            return { exitCode, stdout: '', stderr: '', durationMs: 0, timedOut: false };
          },
        } as unknown as DockerRunner;
        let rotating!: () => void;
        const entered = new Promise<void>((resolve) => {
          rotating = resolve;
        });
        let finish!: () => void;
        const finished = new Promise<void>((resolve) => {
          finish = resolve;
        });
        let busy!: () => void;
        const waiting = new Promise<void>((resolve) => {
          busy = resolve;
        });
        authAttempts.onBusy = (requested) => {
          if (requested === scope) busy();
        };
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => {
            rotating();
            await finished;
            return {
              ok: true,
              json: async () => ({
                access_token: randomBytes(16).toString('hex'),
                refresh_token: randomBytes(16).toString('hex'),
              }),
            };
          }),
        );
        const measured: { phase: string; holdMs: number }[] = [];
        authAttempts.onRelease = (phase, ms) =>
          measured.push({ phase, holdMs: Math.round(ms * 100) / 100 });
        authAttempts.phase = 'refresh';
        const refresh = refreshExpiringCliCredentials(db, runner);
        await entered;
        let adopted = false;
        authAttempts.phase = 'admission';
        const adoption = ensureTaskAuthVolumes(ctx, taskId, runner, db).then(() => {
          adopted = true;
        });
        try {
          await Promise.race([
            waiting,
            adoption.then(() => {
              throw new Error('adopted during rotation');
            }),
          ]);
          expect(adopted).toBe(false);
          const other = await tryCliAuthLock(
            peer,
            cliAuthScope({ ...ctx, id: IDS[1], name: 'grok', isolateAuth: true }),
          );
          expect(other).not.toBeNull();
          await other?.();
        } finally {
          finish();
          await refresh;
          await adoption;
        }
        process.stdout.write(`AUTH_LOCK_POSTGRES_MEASUREMENTS ${JSON.stringify(measured)}\n`);
        expect(taskBytes === userBytes).toBe(true);
        expect(taskBytes === initial).toBe(false);
      },
      TEST_TIMEOUT,
    );

    it('uses the production listing after the real scope lock and yields to its live labeled copy', async () => {
      const provider = (await db.query.cliProviders.findFirst({
        where: eq(schema.cliProviders.id, IDS[0]),
      }))!;
      const [task] = await db
        .insert(schema.tasks)
        .values({ userId, type: 'workflow', title: 'throwaway refresh hold', status: 'running' })
        .returning();
      const userVol = resolveCliAuthUserVolumeName(
        { ...provider, providerId: provider.id, providerName: 'grok' },
        0,
      );
      dockerVolumes.names = [cliAuthTaskVolumeName(task!.id, 'grok', 0)];
      const runner = {
        volumeLabel: async () =>
          JSON.stringify({
            version: 1,
            userVolume: userVol,
            authMode: 'subscription',
            isolateAuth: false,
          }),
      } as unknown as DockerRunner;
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const locked = await tryCliAuthLock(peer, cliAuthScope(provider));
      expect(locked).not.toBeNull();
      try {
        await refreshExpiringCliCredentials(db, runner);
        expect(dockerVolumes.calls).toBe(0);
      } finally {
        await locked?.();
      }
      await refreshExpiringCliCredentials(db, runner);
      expect(dockerVolumes.calls).toBe(1);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(readVolumeFile).not.toHaveBeenCalled();
    });

    it('retirement waits for an already-admitted run and excludes the current admission on real SQL', async () => {
      const ctx = {
        userId,
        providerId: IDS[0],
        providerName: 'grok' as const,
        authMode: 'subscription' as const,
        isolateAuth: false,
      };
      const [task] = await db
        .insert(schema.tasks)
        .values({
          userId,
          type: 'workflow',
          title: 'throwaway retirement guard',
          status: 'running',
        })
        .returning();
      const taskId = task!.id;
      const [writer, admission] = await db
        .insert(schema.cliInvocations)
        .values(
          [1, 2].map(() => ({
            taskId,
            cliProviderId: IDS[0],
            mode: 'cli' as const,
            prompt: 'fixture only',
            startedAt: new Date(),
          })),
        )
        .returning();
      await db.insert(schema.auditEvents).values({
        actorUserId: userId,
        targetId: IDS[0],
        targetType: 'cli_provider',
        action: 'cli_provider.login',
        metadata: { source: 'volume' },
      });
      const userVol = resolveCliAuthUserVolumeName(ctx, 0);
      const taskVol = cliAuthTaskVolumeName(taskId, 'grok', 0);
      const volumes = new Set([userVol, taskVol]);
      const labels = new Map([
        [
          taskVol,
          JSON.stringify({
            version: 1,
            userVolume: userVol,
            authMode: 'subscription',
            isolateAuth: false,
            volumeLoginId: 'none',
          }),
        ],
      ]);
      const raw = JSON.stringify({
        'issuer::client': {
          key: randomBytes(16).toString('hex'),
          refresh_token: randomBytes(16).toString('hex'),
          oidc_client_id: 'client',
        },
      });
      vi.mocked(readVolumeFile).mockImplementation(async (_volume, path) =>
        path === GROK_REFRESH_FENCE_FILE ? null : raw,
      );
      const runner = {
        volumeList: async (prefix: string) =>
          [...volumes].filter((name) => name.startsWith(prefix)),
        volumeExists: async (name: string) => volumes.has(name),
        volumeLabel: async (name: string) => labels.get(name) ?? null,
        volumeHasContainers: async () => false,
        volumeCreate: async (name: string, values: Record<string, string>) => {
          volumes.add(name);
          labels.set(name, values['haive.auth-retired'] ?? values['haive.auth-source']!);
          return { ok: true, stderr: '' };
        },
        volumeRemove: async (name: string) => {
          volumes.delete(name);
          return { ok: true, stderr: '' };
        },
        run: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false }),
      } as unknown as DockerRunner;
      await expect(
        ensureTaskAuthVolumes(ctx, taskId, runner, db, admission!.id),
      ).rejects.toMatchObject({ code: 'cli_auth_busy' });
      expect([...labels.keys()].some((name) => name.includes('_retired_'))).toBe(false);
      await db
        .update(schema.cliInvocations)
        .set({ endedAt: new Date() })
        .where(eq(schema.cliInvocations.id, writer!.id));
      await ensureTaskAuthVolumes(ctx, taskId, runner, db, admission!.id);
      expect([...labels.keys()].filter((name) => name.includes('_retired_'))).toHaveLength(1);
    });

    it('bounds the step admission ledger on real SQL, including superseded errors, and resets on Retry', async () => {
      const [task] = await db
        .insert(schema.tasks)
        .values({
          userId,
          type: 'workflow',
          title: 'throwaway bounded admission',
          status: 'running',
        })
        .returning();
      const start = new Date(Date.now() - 2 * AUTH_ADMISSION_RETRY_DELAY_MS);
      const [step] = await db
        .insert(schema.taskSteps)
        .values({
          taskId: task!.id,
          stepId: 'auth-bound-fixture',
          stepIndex: 0,
          title: 'fixture',
          status: 'waiting_cli',
          startedAt: start,
        })
        .returning();
      const addRun = async (
        code: 'cli_auth_probe_unknown' | 'cli_auth_busy' | null,
        createdAt: Date,
      ) =>
        db.insert(schema.cliInvocations).values({
          taskId: task!.id,
          taskStepId: step!.id,
          mode: 'cli',
          prompt: 'fixture',
          createdAt,
          startedAt: createdAt,
          endedAt: new Date(),
          exitCode: code ? -1 : 0,
          errorMessage: code ? new CliAuthRetryableError(code).message : null,
          supersededAt: code === 'cli_auth_probe_unknown' ? new Date() : null,
        });
      // Waves, not rows, are counted: the two unknown rows after the start are one
      // delay apart, so they are two waves.
      await addRun('cli_auth_probe_unknown', new Date(start.getTime() - 1000));
      for (const [code, offset] of [
        ['cli_auth_probe_unknown', 1000],
        ['cli_auth_busy', 1000],
        [null, 1000],
        ['cli_auth_probe_unknown', 1000 + AUTH_ADMISSION_RETRY_DELAY_MS + 1000],
      ] as const)
        await addRun(code, new Date(start.getTime() + offset));
      const apply = vi.fn(async () => ({}));
      const enqueueCliInvocation = vi.fn();
      const params = {
        db,
        taskId: task!.id,
        userId,
        repoPath: '/tmp',
        workspacePath: '/tmp',
        cliProviderId: null,
        authProbeUnknownLimit: 2,
        moduleDeactivation: null,
        stepDef: {
          metadata: {
            id: 'auth-bound-fixture',
            workflowType: 'workflow' as const,
            index: 0,
            title: 'fixture',
            description: 'fixture',
            requiresCli: true,
          },
          apply,
        },
        deps: { enqueueCliInvocation },
      };
      const capped = await advanceStep(params);
      expect(capped.status).toBe('failed');
      expect(capped.row.errorMessage).toContain('cli_auth_probe_exhausted:');
      expect(apply).not.toHaveBeenCalled();
      expect(enqueueCliInvocation).not.toHaveBeenCalled();
      // Retry clears output/start, reopens the row and writes step.retry in the same transaction.
      // Old ended errors stay in the ledger; the event is what leaves them out of the window.
      const retriedAt = new Date();
      await db
        .update(schema.taskSteps)
        .set({
          status: 'waiting_cli',
          startedAt: retriedAt,
          endedAt: null,
          output: null,
          errorMessage: null,
        })
        .where(eq(schema.taskSteps.id, step!.id));
      await db.insert(schema.taskEvents).values({
        taskId: task!.id,
        taskStepId: step!.id,
        eventType: 'step.retry',
        createdAt: retriedAt,
      });
      await addRun('cli_auth_probe_unknown', new Date(retriedAt.getTime() + 1));
      const paced = await advanceStep(params);
      expect(paced.status).toBe('deferred');
      if (paced.status === 'deferred') expect(paced.delayMs).toBeGreaterThan(0);
      expect(apply).not.toHaveBeenCalled();
      expect(enqueueCliInvocation).not.toHaveBeenCalled();
    });

    describe('step admission ledger boundaries on real SQL', () => {
      type Code = 'cli_auth_probe_unknown' | 'cli_auth_busy';
      const WAVE_GAP = AUTH_ADMISSION_RETRY_DELAY_MS + 1000;
      // Every fixture row was created in the past; its end is now, as a just-failed admission is.
      const T0 = Date.now() - 30 * WAVE_GAP;
      const at = (ms: number) => new Date(T0 + ms);
      const mkStep = async (limit: number | undefined) => {
        const [task] = await db
          .insert(schema.tasks)
          .values({ userId, type: 'workflow', title: 'throwaway ledger', status: 'running' })
          .returning();
        const mk = async (stepId: string) => {
          const [row] = await db
            .insert(schema.taskSteps)
            .values({
              taskId: task!.id,
              stepId,
              stepIndex: 0,
              title: 'fixture',
              status: 'waiting_cli',
              startedAt: at(0),
            })
            .returning();
          return row!;
        };
        const step = await mk('auth-ledger-fixture');
        const other = await mk('auth-ledger-other');
        const addRun = async (code: Code | null, createdAt: Date) =>
          db.insert(schema.cliInvocations).values({
            taskId: task!.id,
            taskStepId: step.id,
            mode: 'cli',
            prompt: 'fixture',
            createdAt,
            startedAt: createdAt,
            endedAt: new Date(),
            exitCode: code ? -1 : 0,
            errorMessage: code ? new CliAuthRetryableError(code).message : null,
          });
        const addEvent = async (eventType: string, stepId: string, createdAt: Date) =>
          db
            .insert(schema.taskEvents)
            .values({ taskId: task!.id, taskStepId: stepId, eventType, createdAt });
        const apply = vi.fn(async () => ({}));
        const enqueueCliInvocation = vi.fn();
        const params = {
          db,
          taskId: task!.id,
          userId,
          repoPath: '/tmp',
          workspacePath: '/tmp',
          cliProviderId: null,
          ...(limit === undefined ? {} : { authProbeUnknownLimit: limit }),
          moduleDeactivation: null,
          stepDef: {
            metadata: {
              id: 'auth-ledger-fixture',
              workflowType: 'workflow' as const,
              index: 0,
              title: 'fixture',
              description: 'fixture',
              requiresCli: true,
            },
            apply,
          },
          deps: { enqueueCliInvocation },
        };
        const reopen = () =>
          db
            .update(schema.taskSteps)
            .set({ status: 'waiting_cli', endedAt: null, errorMessage: null })
            .where(eq(schema.taskSteps.id, step.id));
        return { step, other, addRun, addEvent, params, reopen, apply, enqueueCliInvocation };
      };
      const expectExhausted = async (f: Awaited<ReturnType<typeof mkStep>>) => {
        const res = await advanceStep(f.params);
        expect(res.status).toBe('failed');
        expect(res.row.errorMessage).toContain('cli_auth_probe_exhausted:');
        expect(f.apply).not.toHaveBeenCalled();
        expect(f.enqueueCliInvocation).not.toHaveBeenCalled();
      };
      const expectPaced = async (f: Awaited<ReturnType<typeof mkStep>>) => {
        const res = await advanceStep(f.params);
        expect(res.status).toBe('deferred');
        expect(f.apply).not.toHaveBeenCalled();
      };

      // Each is written by a user's recovery press in the transaction that reopens the step.
      it.each([
        'step.resume',
        'step.retry_ai',
        'step.retry',
        'task.retried',
        'step.cli_provider_preference_changed',
      ])('a %s event reopens the allowance, which is then bounded again', async (eventType) => {
        const f = await mkStep(2);
        await f.addRun('cli_auth_probe_unknown', at(1000));
        await f.addRun('cli_auth_probe_unknown', at(1000 + WAVE_GAP));
        await expectExhausted(f);
        const eventAt = at(1000 + 2 * WAVE_GAP);
        await f.addEvent(eventType, f.step.id, eventAt);
        // A successful run after the event: nothing in the set is left to pace on,
        // so the pass is not failed and not exhausted (it is dispatched, not deferred).
        await f.addRun(null, new Date(eventAt.getTime() + 1000));
        await f.reopen();
        const res = await advanceStep(f.params);
        expect(res.status).not.toBe('failed');
        expect(res.row.errorMessage ?? '').not.toContain('cli_auth_probe_exhausted:');
        f.apply.mockClear();
        // Two NEW waves after the event spend the fresh allowance.
        await f.addRun('cli_auth_probe_unknown', new Date(eventAt.getTime() + 2000));
        await f.addRun('cli_auth_probe_unknown', new Date(eventAt.getTime() + 2000 + WAVE_GAP));
        await f.reopen();
        await expectExhausted(f);
      });

      it.each([
        ['a step.resume of another step', 'step.resume', 'other'],
        ['a step.retry of another step', 'step.retry', 'other'],
        ['a step.skip of this step', 'step.skip', 'step'],
        // Recovery keeps counting: only a user's recovery press reopens the allowance.
        ['a task.auto_resumed of this step', 'task.auto_resumed', 'step'],
        ['a task.revived of this step', 'task.revived', 'step'],
      ] as const)('%s does not reset the count', async (_label, eventType, which) => {
        const f = await mkStep(2);
        await f.addRun('cli_auth_probe_unknown', at(1000));
        await f.addRun('cli_auth_probe_unknown', at(1000 + WAVE_GAP));
        await f.addEvent(eventType, f[which].id, at(1000 + 2 * WAVE_GAP));
        await expectExhausted(f);
      });

      it('a park that stamps started_at again does not reopen the allowance', async () => {
        const f = await mkStep(2);
        await f.addRun('cli_auth_probe_unknown', at(1000));
        await f.addRun('cli_auth_probe_unknown', at(1000 + WAVE_GAP));
        await expectExhausted(f);
        // A park or a requeue clears started_at and the next claim stamps it, after the waves.
        await db
          .update(schema.taskSteps)
          .set({ startedAt: at(1000 + 2 * WAVE_GAP) })
          .where(eq(schema.taskSteps.id, f.step.id));
        await f.reopen();
        await expectExhausted(f);
      });

      it('counts distinct waves: one wide wave counts once, twenty waves exhaust the default cap', async () => {
        const wide = await mkStep(undefined);
        for (let i = 0; i < 13; i++) await wide.addRun('cli_auth_probe_unknown', at(1000));
        for (let i = 0; i < 13; i++)
          await wide.addRun('cli_auth_probe_unknown', at(1000 + WAVE_GAP));
        await expectPaced(wide);

        const nineteen = await mkStep(undefined);
        for (let i = 0; i < 19; i++)
          await nineteen.addRun('cli_auth_probe_unknown', at(1000 + i * WAVE_GAP));
        await expectPaced(nineteen);

        const twenty = await mkStep(undefined);
        for (let i = 0; i < 20; i++)
          await twenty.addRun('cli_auth_probe_unknown', at(1000 + i * WAVE_GAP));
        await expectExhausted(twenty);
      });
    });

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
