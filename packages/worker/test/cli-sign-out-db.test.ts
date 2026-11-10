import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDatabase, schema, tryCliAuthLock } from '@haive/database';
import { cliAuthScope, advanceVolumeLoginGeneration } from '@haive/shared/cli-auth-state';
import { handleSignOutJob } from '../src/queues/cli-exec-queue.js';
import type { DockerRunner } from '../src/sandbox/docker-runner.js';

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
    await db.delete(schema.users).where(eq(schema.users.id, userId));
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
        const job = { token: 'test', moveToDelayed: async () => {} };
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
