import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { secretsService } from '@haive/shared';
import { eq, sql } from 'drizzle-orm';
import { createDatabase, schema, tryCliAuthLock } from '@haive/database';
import { cliAuthScope, advanceVolumeLoginGeneration } from '@haive/shared/cli-auth-state';
import { copySecretLikeProviderEnv } from '../src/secrets/move-secret-env.js';
import {
  handleLoginCreateJob,
  handleProbeJob,
  handleSignOutJob,
} from '../src/queues/cli-exec/handlers.js';
import type { DockerRunner } from '../src/sandbox/docker-runner.js';

const login = vi.hoisted(() => ({ create: vi.fn(), run: vi.fn(), probe: vi.fn() }));
vi.mock('../src/sandbox/login-container.js', () => ({
  createSandboxLoginContainer: login.create,
}));
vi.mock('../src/sandbox/docker-runner.js', async (original) => ({
  ...(await original<typeof import('../src/sandbox/docker-runner.js')>()),
  defaultDockerRunner: { run: login.run },
}));
vi.mock('../src/queues/cli-exec/images.js', async (original) => ({
  ...(await original<typeof import('../src/queues/cli-exec/images.js')>()),
  probeCliPath: login.probe,
}));

const url = process.env.CLI_SIGN_OUT_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/cli_secrets_audit_test'))
  throw new Error('Use a dedicated test database');
describe.skipIf(!url)('sign-out generation and critical section on PostgreSQL', () => {
  let db: ReturnType<typeof createDatabase>;
  let userId: string;
  beforeAll(() => {
    db = createDatabase(url!);
  });
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue('ab'.repeat(32));
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'synthetic',
        emailBlindIndex: randomUUID(),
        passwordHash: 'synthetic',
      })
      .returning();
    userId = user!.id;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });
  it('stops sign-out before destructive writes after the lock backend is terminated', async () => {
    const [provider] = await db
      .insert(schema.cliProviders)
      .values({
        userId,
        name: 'claude-code',
        label: 'lock loss',
        authStatus: 'ok',
      })
      .returning();
    let removed = false;
    const runner = {
      volumeExists: async () => {
        const scope = cliAuthScope(provider!);
        const [holder] = await db.$client`
          select pid from pg_locks where locktype = 'advisory'
          and classid = ((hashtextextended(${`cli-auth:${scope}`}, 0) >> 32) & 4294967295)::oid
          and objid = (hashtextextended(${`cli-auth:${scope}`}, 0) & 4294967295)::oid`;
        await db.$client`select pg_terminate_backend(${holder!.pid})`;
        return true;
      },
      volumeRemove: async () => {
        removed = true;
        return { ok: true, stderr: '' };
      },
    } as unknown as DockerRunner;
    await expect(
      handleSignOutJob(db, { providerId: provider!.id, userId }, runner),
    ).rejects.toThrow();
    expect(removed).toBe(false);
    expect(
      (await db.query.cliProviders.findFirst({ where: eq(schema.cliProviders.id, provider!.id) }))!
        .authStatus,
    ).toBe('ok');
  });

  // Docker and CLI execution are controlled; provider rows, UPDATE predicates and
  // advisory-lock connections are real. This is the lock held by the API session.
  it('creates a login while its API session owns the real auth scope', async () => {
    const [provider] = await db
      .insert(schema.cliProviders)
      .values({
        userId,
        name: 'codex',
        label: 'login',
        authMode: 'subscription',
      })
      .returning();
    const release = await tryCliAuthLock(db, cliAuthScope(provider!));
    expect(release).not.toBeNull();
    login.run.mockImplementation(async () => {
      expect(await tryCliAuthLock(db, cliAuthScope(provider!))).toBeNull();
      return { exitCode: 0 };
    });
    login.create.mockResolvedValue({
      containerRowId: 'created-row',
      dockerContainerId: 'created-container',
    });
    try {
      expect(await handleLoginCreateJob(db, { providerId: provider!.id, userId })).toMatchObject({
        ok: true,
        dockerContainerId: 'created-container',
      });
      expect(login.run).toHaveBeenCalled();
      expect(login.create).toHaveBeenCalled();
    } finally {
      await release?.();
    }
  });

  it('publishes the post-login probe while its API session owns the real auth scope', async () => {
    const [provider] = await db
      .insert(schema.cliProviders)
      .values({
        userId,
        name: 'codex',
        label: 'post-login',
        authMode: 'subscription',
      })
      .returning();
    const release = await tryCliAuthLock(db, cliAuthScope(provider!));
    expect(release).not.toBeNull();
    login.probe.mockResolvedValue({ ok: true, authStatus: 'ok', authMessage: 'authenticated' });
    try {
      await advanceVolumeLoginGeneration(db, provider!);
      expect(
        await handleProbeJob(db, { providerId: provider!.id, userId, targetMode: 'cli' }),
      ).toMatchObject({ ok: true, cli: { authStatus: 'ok' } });
      expect(
        (await db.query.cliProviders.findFirst({
          where: eq(schema.cliProviders.id, provider!.id),
        }))!.authStatus,
      ).toBe('ok');
    } finally {
      await release?.();
    }
  });

  it.each([
    [null, false],
    [new Date('2026-01-01T00:00:00Z'), false],
    [null, true],
    [new Date('2026-01-01T00:00:00Z'), true],
  ] as const)(
    'does not publish a probe read before sign-out (previous check: %s, sibling: %s)',
    async (authLastCheckedAt, sibling) => {
      const [provider] = await db
        .insert(schema.cliProviders)
        .values({
          userId,
          name: 'gemini',
          label: 'probe-signout',
          authMode: 'subscription',
          authStatus: 'ok',
          authLastCheckedAt,
        })
        .returning();
      const probedProvider = sibling
        ? (
            await db
              .insert(schema.cliProviders)
              .values({
                userId,
                name: provider!.name,
                label: 'shared-probe',
                authMode: provider!.authMode,
                authStatus: 'ok',
                authLastCheckedAt,
              })
              .returning()
          )[0]!
        : provider!;
      expect(cliAuthScope(probedProvider)).toBe(cliAuthScope(provider!));
      let afterSignOut: typeof provider;
      login.probe.mockImplementationOnce(async () => {
        // Sign-out succeeding here proves the probe holds no advisory lock during exec.
        expect(
          await handleSignOutJob(db, { providerId: provider!.id, userId }, {
            volumeExists: async () => false,
          } as unknown as DockerRunner),
        ).toMatchObject({ ok: true });
        afterSignOut = await db.query.cliProviders.findFirst({
          where: eq(schema.cliProviders.id, probedProvider.id),
        });
        return { ok: true, authStatus: 'ok', authMessage: 'stale success' };
      });
      await expect(
        handleProbeJob(db, { providerId: probedProvider.id, userId, targetMode: 'cli' }),
      ).resolves.toMatchObject({ ok: true });
      expect(login.probe).toHaveBeenCalledOnce();
      expect(afterSignOut!.authStatus).toBe('unknown');
      expect(afterSignOut!.authMessage).toBeNull();
      expect(afterSignOut!.authGeneration).toBe(probedProvider.authGeneration);
      expect(
        await db.query.cliProviders.findFirst({
          where: eq(schema.cliProviders.id, probedProvider.id),
        }),
      ).toEqual(afterSignOut!);
    },
  );

  it('does not publish health after a newer login generation lands during the probe', async () => {
    const [provider] = await db
      .insert(schema.cliProviders)
      .values({
        userId,
        name: 'gemini',
        label: 'probe-new-login',
        authMode: 'subscription',
      })
      .returning();
    login.probe.mockImplementationOnce(async () => {
      await advanceVolumeLoginGeneration(db, provider!);
      return { ok: true, authStatus: 'ok', authMessage: 'old credential' };
    });
    await handleProbeJob(db, { providerId: provider!.id, userId, targetMode: 'cli' });
    expect(
      (await db.query.cliProviders.findFirst({
        where: eq(schema.cliProviders.id, provider!.id),
      }))!.authStatus,
    ).toBe('unknown');
  });

  it('advances the sign-out check stamp even when the previous stamp is ahead of the clock', async () => {
    // Date-only faking leaves postgres connection timers real.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    try {
      const [provider] = await db
        .insert(schema.cliProviders)
        .values({
          userId,
          name: 'gemini',
          label: 'same-check-time',
          authMode: 'subscription',
          authStatus: 'unknown',
          authLastCheckedAt: new Date('2100-01-01T00:00:00Z'),
        })
        .returning();
      login.probe.mockImplementationOnce(async () => {
        expect(
          await handleSignOutJob(db, { providerId: provider!.id, userId }, {
            volumeExists: async () => false,
          } as unknown as DockerRunner),
        ).toMatchObject({ ok: true });
        return { ok: true, authStatus: 'ok', authMessage: 'stale success' };
      });
      await expect(
        handleProbeJob(db, { providerId: provider!.id, userId, targetMode: 'cli' }),
      ).resolves.toMatchObject({ ok: true });
      expect(login.probe).toHaveBeenCalledOnce();
      const current = (await db.query.cliProviders.findFirst({
        where: eq(schema.cliProviders.id, provider!.id),
      }))!;
      // PostgreSQL advances one microsecond, below Date's precision; the CAS must
      // retain the original database timestamp rather than round it through Date.
      expect(current.authLastCheckedAt).toEqual(provider!.authLastCheckedAt);
      expect(current.authStatus).toBe('unknown');
      expect(current.authMessage).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes health when the probe only updates image-build metadata', async () => {
    const [provider] = await db
      .insert(schema.cliProviders)
      .values({
        userId,
        name: 'gemini',
        label: 'probe-build',
        authMode: 'subscription',
      })
      .returning();
    login.probe.mockImplementationOnce(async () => {
      // A cache-miss probe builds inline and marks its provider's image ready.
      await db
        .update(schema.cliProviders)
        .set({ sandboxImageBuildStatus: 'ready' })
        .where(eq(schema.cliProviders.id, provider!.id));
      return { ok: true, authStatus: 'ok' };
    });
    await handleProbeJob(db, { providerId: provider!.id, userId, targetMode: 'cli' });
    expect(login.probe).toHaveBeenCalledOnce();
    expect(
      (await db.query.cliProviders.findFirst({
        where: eq(schema.cliProviders.id, provider!.id),
      }))!.authStatus,
    ).toBe('ok');
  });

  it('publishes unchanged health whose previous check has submillisecond precision', async () => {
    const [provider] = await db
      .insert(schema.cliProviders)
      .values({
        userId,
        name: 'gemini',
        label: 'precise-check',
        authMode: 'subscription',
        authLastCheckedAt: sql`'2026-01-01 00:00:00.000123'::timestamp`,
      })
      .returning();
    login.probe.mockResolvedValueOnce({ ok: true, authStatus: 'ok' });
    await handleProbeJob(db, { providerId: provider!.id, userId, targetMode: 'cli' });
    expect(login.probe).toHaveBeenCalledOnce();
    expect(
      (await db.query.cliProviders.findFirst({
        where: eq(schema.cliProviders.id, provider!.id),
      }))!.authStatus,
    ).toBe('ok');
  });

  it('legacy secret migration fences a late sign-out and advances only the credential it creates', async () => {
    const [provider] = await db
      .insert(schema.cliProviders)
      .values({
        userId,
        name: 'claude-code',
        label: 'legacy',
        envVars: { CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-legacy' },
      })
      .returning();
    const payload = { providerId: provider!.id, userId, authGeneration: provider!.authGeneration };
    const release = await tryCliAuthLock(db, cliAuthScope(provider!));
    expect(release).not.toBeNull();
    try {
      await copySecretLikeProviderEnv(db);
      expect(
        await db.query.cliProviderSecrets.findMany({
          where: eq(schema.cliProviderSecrets.providerId, provider!.id),
        }),
      ).toHaveLength(0);
    } finally {
      await release?.();
    }
    await copySecretLikeProviderEnv(db);
    const current = (await db.query.cliProviders.findFirst({
      where: eq(schema.cliProviders.id, provider!.id),
    }))!;
    expect(current.authGeneration).not.toBe(provider!.authGeneration);
    const runner = { volumeExists: async () => false } as unknown as DockerRunner;
    expect(await handleSignOutJob(db, payload, runner)).toMatchObject({ superseded: true });
    expect(
      await db.query.cliProviderSecrets.findMany({
        where: eq(schema.cliProviderSecrets.providerId, provider!.id),
      }),
    ).toHaveLength(1);
    await copySecretLikeProviderEnv(db);
    expect(
      (await db.query.cliProviders.findFirst({ where: eq(schema.cliProviders.id, provider!.id) }))!
        .authGeneration,
    ).toBe(current.authGeneration);
  });
  it.each(['gemini', 'claude-code'] as const)(
    '%s newer login preserves volume, secrets and health; current generation still signs out',
    async (name) => {
      const [provider] = await db
        .insert(schema.cliProviders)
        .values({ userId, name, label: 'test', authStatus: 'ok', authMessage: 'authenticated' })
        .returning();
      const payload = {
        providerId: provider!.id,
        userId,
        authGeneration: provider!.authGeneration,
      };
      const volume = cliAuthScope(provider!);
      const volumes = new Set([volume]);
      const runner = {
        volumeExists: async (n: string) => volumes.has(n),
        volumeRemove: async (n: string) => {
          volumes.delete(n);
          return { ok: true, stderr: '' };
        },
      } as DockerRunner;
      await db.insert(schema.cliProviderSecrets).values(
        ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_USAGE_OAUTH', 'ANTHROPIC_AUTH_TOKEN'].map(
          (secretName) => ({
            providerId: provider!.id,
            secretName,
            encryptedValue: 'synthetic',
            encryptedDek: 'synthetic',
          }),
        ),
      );
      const beforeSecrets = await db
        .select()
        .from(schema.cliProviderSecrets)
        .where(eq(schema.cliProviderSecrets.providerId, provider!.id));
      // Simulates the durable completion stamp while the interactive login owns its scope.
      const release = await tryCliAuthLock(db, volume);
      expect(release).not.toBeNull();
      try {
        const job = {
          data: {},
          updateData: async () => {},
          token: 'test',
          moveToDelayed: async () => {},
        };
        await expect(handleSignOutJob(db, payload, runner, job as any)).rejects.toMatchObject({
          name: 'DelayedError',
        });
        expect(volumes.has(volume)).toBe(true);
        await advanceVolumeLoginGeneration(db, provider!);
      } finally {
        await release?.();
      }
      const beforeProvider = await db.query.cliProviders.findFirst({
        where: eq(schema.cliProviders.id, provider!.id),
      });
      expect(await handleSignOutJob(db, payload, runner)).toMatchObject({
        ok: true,
        superseded: true,
      });
      expect(volumes.has(volume)).toBe(true);
      expect(
        await db
          .select()
          .from(schema.cliProviderSecrets)
          .where(eq(schema.cliProviderSecrets.providerId, provider!.id)),
      ).toEqual(beforeSecrets);
      expect(
        await db.query.cliProviders.findFirst({ where: eq(schema.cliProviders.id, provider!.id) }),
      ).toEqual(beforeProvider);
      expect(
        (
          await handleSignOutJob(
            db,
            { ...payload, authGeneration: beforeProvider!.authGeneration },
            runner,
          )
        ).ok,
      ).toBe(true);
      expect(volumes.size).toBe(0);
      if (name === 'claude-code')
        expect(
          (
            await db
              .select()
              .from(schema.cliProviderSecrets)
              .where(eq(schema.cliProviderSecrets.providerId, provider!.id))
          ).map((s) => s.secretName),
        ).toEqual(['ANTHROPIC_AUTH_TOKEN']);
      expect(
        (await db.query.cliProviders.findFirst({
          where: eq(schema.cliProviders.id, provider!.id),
        }))!.authStatus,
      ).toBe('unknown');
    },
  );
});
