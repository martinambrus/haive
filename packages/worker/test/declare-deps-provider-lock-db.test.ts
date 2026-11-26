import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { declareDepsStep } from '../src/step-engine/steps/env-replicate/01-declare-deps.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

const h = vi.hoisted(() => ({ beforeLock: undefined as (() => void) | undefined }));
vi.mock('@haive/shared/composed-lsp-provider-lock', async (original) => {
  const real = await original<typeof import('@haive/shared/composed-lsp-provider-lock')>();
  return {
    ...real,
    lockTaskForComposedLsp: async (...args: Parameters<typeof real.lockTaskForComposedLsp>) => {
      h.beforeLock?.();
      return real.lockTaskForComposedLsp(...args);
    },
  };
});

const url = process.env.DECLARE_DEPS_PROVIDER_LOCK_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/declare_deps_provider_lock_test'))
  throw new Error('Use a dedicated declare_deps_provider_lock_test database');

const runList = [
  '04-verify-environment',
  '01-worktree-setup',
  '01b-install-plugins',
  '01b1-verify-composed-lsp',
  '05-implement',
];
const deferred = () => Promise.withResolvers<void>();

describe.skipIf(!url)('step 01 provider decisions on Postgres', () => {
  let db: Database;
  let other: Database;
  let userId: string;
  let repositoryId: string;
  let claude: string;
  let codex: string;
  beforeAll(async () => {
    db = createDatabase(url!);
    other = createDatabase(url!);
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'deps-lock@test.local',
        emailBlindIndex: randomBytes(16).toString('hex'),
        passwordHash: 'unused',
        status: 'active',
        role: 'user',
      })
      .returning();
    userId = user!.id;
    const [repo] = await db
      .insert(schema.repositories)
      .values({
        userId,
        name: 'deps-lock',
        source: 'local_path',
        localPath: '/tmp',
        storagePath: '/tmp',
        status: 'ready',
        lspServers: ['intelephense-extended'],
      })
      .returning();
    repositoryId = repo!.id;
    for (const name of ['claude-code', 'codex'] as const) {
      const [provider] = await db
        .insert(schema.cliProviders)
        .values({
          userId,
          name,
          label: name,
          enabled: true,
          createdAt: new Date(name === 'claude-code' ? 1 : 2),
        })
        .returning();
      if (name === 'claude-code') claude = provider!.id;
      else codex = provider!.id;
    }
  });
  beforeEach(async () => {
    h.beforeLock = undefined;
    await db
      .update(schema.cliProviders)
      .set({ name: 'claude-code' })
      .where(eq(schema.cliProviders.id, claude));
  });
  afterAll(async () => {
    h.beforeLock = undefined;
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await Promise.all([db.$client.end({ timeout: 5 }), other.$client.end({ timeout: 5 })]);
  });

  async function fixture() {
    const [template] = await db
      .insert(schema.envTemplates)
      .values({
        userId,
        repositoryId,
        name: 'legacy',
        baseImage: 'ubuntu:24.04',
        declaredDeps: { lspServers: ['intelephense-extended'] },
      })
      .returning();
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId,
        type: 'workflow',
        title: 'deps-lock',
        status: 'running',
        cliProviderId: claude,
        envTemplateId: template!.id,
        runListSnapshot: runList,
        ignoreSavedStepClis: true,
      })
      .returning();
    const ctx = {
      db,
      userId,
      taskId: task!.id,
      cliProviderId: claude,
      logger: { info: vi.fn() },
      emitProgress: vi.fn(),
    } as unknown as StepContext;
    const apply = () =>
      declareDepsStep.apply(ctx, {
        detected: { runtimes: [], cliSupportsLsp: false },
        formValues: {
          runtimes: [],
          containerTool: 'none',
          databaseKind: 'none',
          preinstallDeps: true,
          browserTesting: false,
          extraPackages: '',
          replaceLegacyLspInstall: true,
        },
        iteration: 0,
        previousIterations: [],
      } as unknown as Parameters<typeof declareDepsStep.apply>[1]);
    return { task: task!, template: template!, ctx, apply };
  }

  it('uses the current task CLI when the step context still names a non-LSP CLI', async () => {
    const f = await fixture();
    f.ctx.cliProviderId = codex;
    const result = await f.apply();
    const saved = await db.query.envTemplates.findFirst({
      where: eq(schema.envTemplates.id, result.envTemplateId),
    });
    expect(saved?.declaredDeps).toMatchObject({
      lspInstallContractVersion: 2,
      lspServers: ['intelephense-extended'],
    });
    const events = await db
      .select()
      .from(schema.taskEvents)
      .where(
        and(
          eq(schema.taskEvents.taskId, f.task.id),
          eq(schema.taskEvents.eventType, 'env_template.replaced'),
        ),
      );
    expect(events).toHaveLength(1);
  });

  it('refreshes capability after waiting for the task lock and rolls the candidate back', async () => {
    const f = await fixture();
    const before = await db
      .select({ id: schema.envTemplates.id })
      .from(schema.envTemplates)
      .where(eq(schema.envTemplates.userId, userId));
    const writerReady = deferred();
    const releaseWriter = deferred();
    const readerAtLock = deferred();
    h.beforeLock = () => readerAtLock.resolve();
    const writer = other.transaction(async (tx) => {
      await tx
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, f.task.id))
        .for('no key update');
      await tx
        .update(schema.tasks)
        .set({ cliProviderId: null })
        .where(eq(schema.tasks.id, f.task.id));
      await tx
        .update(schema.cliProviders)
        .set({ name: 'codex' })
        .where(eq(schema.cliProviders.id, claude));
      writerReady.resolve();
      await releaseWriter.promise;
    });
    await writerReady.promise;
    const outcome = f.apply().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      await Promise.race([
        readerAtLock.promise,
        outcome.then(() => {
          throw new Error('apply ended before taking the task lock');
        }),
      ]);
    } finally {
      releaseWriter.resolve();
    }
    await writer;
    expect(await outcome).toMatchObject({ error: { reason: 'cli_unsupported' } });
    const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, f.task.id) });
    expect(task?.envTemplateId).toBe(f.template.id);
    const candidates = await db
      .select()
      .from(schema.envTemplates)
      .where(eq(schema.envTemplates.userId, userId));
    expect(candidates.map((t) => t.id).sort()).toEqual(before.map((t) => t.id).sort());
    const events = await db
      .select()
      .from(schema.taskEvents)
      .where(eq(schema.taskEvents.taskId, f.task.id));
    expect(events).toEqual([]);
  });
});
