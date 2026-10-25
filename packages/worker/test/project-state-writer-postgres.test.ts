import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { claimRepositoryRoot, createDatabase, schema, type Database } from '@haive/database';
import {
  emptyProjectState,
  gitBlobId,
  projectStateHash,
  renderProjectState,
} from '@haive/shared/project-state';
import { markProjectStateDirty } from '@haive/shared/project-state-outbox';
import { upgradeApplyStep } from '../src/step-engine/steps/onboarding-upgrade/02-upgrade-apply.js';
import { upgradeRollbackStep } from '../src/step-engine/steps/onboarding-upgrade/04-upgrade-rollback.js';
import { postOnboardingStep } from '../src/step-engine/steps/onboarding/12-post-onboarding.js';
import { REFERENCE_CONTEXT, expandManifestFor } from '../src/step-engine/template-manifest.js';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { resolveProjectStateConflict } from '../src/project-state/resolve.js';
import { readStateFiles, syncProjectStateFromCheckout } from '../src/project-state/sync.js';
import {
  lockProjectState,
  recoverProjectStateWrite,
  writeProjectStateRecord,
  writeProjectStateColumn,
} from '../src/project-state/write.js';
import { refreshProjectState, sweepDirtyProjectStates } from '../src/project-state/refresh.js';

const seam = vi.hoisted(() => ({
  afterWrite: null as null | (() => Promise<void>),
  beforeRewrite: null as null | (() => Promise<void>),
  afterRemove: null as null | (() => Promise<void>),
}));
vi.mock('@haive/shared/fs-safe', async (original) => {
  const real = await original<typeof import('@haive/shared/fs-safe')>();
  return {
    ...real,
    rewriteFileIfNoFollow: async (...args: Parameters<typeof real.rewriteFileIfNoFollow>) => {
      await seam.beforeRewrite?.();
      const result = await real.rewriteFileIfNoFollow(...args);
      if (result === 'rewritten') await seam.afterWrite?.();
      return result;
    },
    removeFileIfNoFollow: async (...args: Parameters<typeof real.removeFileIfNoFollow>) => {
      const result = await real.removeFileIfNoFollow(...args);
      await seam.afterRemove?.();
      return result;
    },
    writeFileNoFollow: async (...args: Parameters<typeof real.writeFileNoFollow>) => {
      const result = await real.writeFileNoFollow(...args);
      await seam.afterWrite?.();
      return result;
    },
  };
});

// Deliberately no DATABASE_URL fallback. This suite is opt-in, only on its exclusive fixture.
const url = process.env.T266_DATABASE_URL;
if (url && !/^\/(?:codex|test)_t266_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error('T266 requires its assigned database');
if (url && ['', '5432', '6379'].includes(new URL(url).port))
  throw new Error('T266 requires its assigned PostgreSQL port');
const connection = url ? createDatabase(url) : null;
const db = connection;
const dirs: string[] = [];
const users: string[] = [];
afterEach(async () => {
  seam.afterWrite = null;
  seam.beforeRewrite = null;
  seam.afterRemove = null;
  for (const id of users.splice(0)) await db!.delete(schema.users).where(eq(schema.users.id, id));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
afterAll(async () => {
  await connection?.$client.end({ timeout: 5 });
});
const context = (name = 'local') => ({
  projectInfo: { name },
  framework: null,
  acceptedAgentIds: [],
  customAgentSpecs: [],
  lspLanguages: [],
});
async function fixture(column: unknown = context()) {
  const userId = randomUUID();
  users.push(userId);
  const root = await mkdtemp(join(tmpdir(), 't266-writer-'));
  dirs.push(root);
  await db!.insert(schema.users).values({
    id: userId,
    emailEncrypted: 't266',
    emailBlindIndex: userId,
    passwordHash: 'fixture',
  });
  const [repo] = await db!
    .insert(schema.repositories)
    .values({ userId, name: 't266', source: 'blank', storagePath: root, renderContext: column })
    .returning();
  const write = (name = 'local', database = db!) =>
    writeProjectStateRecord(database, {
      repositoryId: repo!.id,
      repoPath: root,
      context: context(name) as never,
      rtkChoiceRecorded: false,
    });
  const outbox = async () =>
    (
      await db!
        .select()
        .from(schema.projectStateOutbox)
        .where(eq(schema.projectStateOutbox.repositoryId, repo!.id))
    )[0];
  const render = async () =>
    JSON.parse(
      await readFile(join(root, '.haive-data/state/project/render.json'), 'utf8'),
    ) as ReturnType<typeof context>;
  return { root, repo: repo!, write, outbox, render, userId };
}
async function diskRecord(root: string, name: string) {
  for (const [rel, text] of renderProjectState({ ...emptyProjectState(), render: context(name) })) {
    const path = join(root, '.haive-data/state', rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, text);
  }
}

describe.skipIf(!url)('T266 real PostgreSQL record writer', () => {
  it.each(['prepared', 'partial'] as const)(
    'defers conflict answers while a %s record journal owns another render key',
    async (phase) => {
      const s = await fixture();
      await s.write();
      const mine = {
        ...context(),
        acceptedAgentIds: ['docs-writer'],
        rtkChoiceRecorded: false,
      };
      await db!
        .update(schema.repositories)
        .set({ renderContext: mine })
        .where(eq(schema.repositories.id, s.repo.id));
      const renderPath = join(s.root, '.haive-data/state/project/render.json');
      await writeFile(
        renderPath,
        JSON.stringify(
          {
            ...context(),
            acceptedAgentIds: ['security-auditor'],
          },
          null,
          4,
        ) + '\n',
      );
      expect(
        (
          await syncProjectStateFromCheckout(db!, {
            repositoryId: s.repo.id,
            repoPath: s.root,
          })
        ).outcome,
      ).toBe('conflict');
      const [conflict] = await db!
        .select()
        .from(schema.projectStateConflicts)
        .where(eq(schema.projectStateConflicts.repositoryId, s.repo.id));
      expect(conflict!.unit).toBe('project/render.json#acceptedAgentIds');
      const answer = (userId = s.userId) =>
        resolveProjectStateConflict(db!, {
          repositoryId: s.repo.id,
          userId,
          conflictId: conflict!.id,
          answer: 'keep_mine',
        });
      const snapshot = async () => ({
        bytes: await readFile(renderPath, 'utf8'),
        repo: await db!
          .select()
          .from(schema.repositories)
          .where(eq(schema.repositories.id, s.repo.id)),
        sync: await db!
          .select()
          .from(schema.projectStateSync)
          .where(eq(schema.projectStateSync.repositoryId, s.repo.id)),
        conflicts: await db!
          .select()
          .from(schema.projectStateConflicts)
          .where(eq(schema.projectStateConflicts.repositoryId, s.repo.id)),
        outbox: await s.outbox(),
      });
      const refuse = async () => {
        const before = await snapshot();
        expect(before.outbox!.writeIntent).toBeTruthy();
        expect(await answer(randomUUID())).toEqual({ kind: 'not_found' });
        expect.soft(await answer()).toEqual({ kind: 'busy' });
        expect.soft(await snapshot()).toEqual(before);
      };
      const attempted = { ...mine, projectInfo: { name: 'journal target' } };
      let checked = false;
      const wrapped = new Proxy(db!, {
        get(target, prop) {
          if (prop !== 'transaction') return Reflect.get(target, prop);
          return async (fn: Parameters<Database['transaction']>[0]) => {
            const result = await target.transaction(fn);
            // A semantic preparation receipt proves the journal committed and its locks released.
            if (!checked && result && typeof result === 'object' && 'intentId' in result) {
              checked = true;
              if (phase === 'prepared') await refuse();
            }
            return result;
          };
        },
      }) as Database;
      if (phase === 'partial')
        seam.afterWrite = async () => {
          throw new Error('partial journal');
        };
      const write = () =>
        writeProjectStateColumn(wrapped, {
          repositoryId: s.repo.id,
          repoPath: s.root,
          column: attempted as never,
          expectedColumns: [mine],
          keepColumnOnFailure: true,
        });
      if (phase === 'partial') {
        await expect(write()).rejects.toThrow('partial journal');
        seam.afterWrite = null;
        await refuse();
        expect((await s.render()).projectInfo.name).toBe('journal target');
        await recoverProjectStateWrite(db!, s.repo.id, s.root);
        expect((await s.render()).projectInfo.name).toBe('local');
        expect((await s.outbox())!.writeIntent).toBeNull();
      } else {
        await write();
        expect((await s.render()).projectInfo.name).toBe('journal target');
        expect((await s.outbox())!.writeIntent).toBeNull();
      }
      expect(checked).toBe(true);
      expect(await answer()).toMatchObject({ kind: 'resolved' });
      expect((await s.render()).acceptedAgentIds).toEqual(['docs-writer']);
    },
  );

  it('imports an unseen checkout instead of overwriting its project settings', async () => {
    const s = await fixture();
    await s.write();
    await diskRecord(s.root, 'teammate');
    await s.write().catch(() => undefined);
    expect((await s.render()).projectInfo.name).toBe('teammate');
    const [repo] = await db!
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, s.repo.id));
    expect((repo!.renderContext as ReturnType<typeof context>).projectInfo.name).toBe('teammate');
  });

  it('commits recovery intent before the first file and recovers an incomplete first record through the sweep', async () => {
    const s = await fixture(null);
    let observed: Awaited<ReturnType<typeof s.outbox>>;
    seam.afterWrite = async () => {
      observed = await s.outbox();
      throw new Error('crash after first file');
    };
    await expect(s.write()).rejects.toThrow('crash after first file');
    expect(observed!.revision).toBeGreaterThan(observed!.writtenRevision);
    expect(observed!.writeIntent).toBeTruthy();
    seam.afterWrite = null;
    await sweepDirtyProjectStates(db!);
    // A rolled-back first write is undone, never rolled forward into a fabricated context.
    const [repo] = await db!
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, s.repo.id));
    expect(repo!.renderContext).toBeNull();
    expect((await s.outbox())!.writeIntent).toBeNull();
    await expect(readFile(join(s.root, '.haive-data/state/format.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses a holder admitted after refresh sync but before its write', async () => {
    const s = await fixture();
    await s.write();
    const before = await s.render();
    // Real transaction boundary: the first transaction after sync commits admits a new task.
    let admitted = false;
    const wrapped = new Proxy(db!, {
      get(target, prop) {
        if (prop !== 'transaction') return Reflect.get(target, prop);
        return async (fn: Parameters<Database['transaction']>[0]) => {
          const result = await target.transaction(fn);
          // Sync returns its domain outcome only after its real PostgreSQL transaction committed.
          if (!admitted && result && typeof result === 'object' && 'outcome' in result) {
            admitted = true;
            await db!.insert(schema.tasks).values({
              userId: s.userId,
              repositoryId: s.repo.id,
              type: 'onboarding',
              title: 'holder',
              status: 'running',
            });
          }
          return result;
        };
      },
    }) as Database;
    expect(await refreshProjectState(wrapped, s.repo.id)).toBe(false);
    expect(admitted).toBe(true);
    expect(await s.render()).toEqual(before);
  });
  it('leaves semantic state and disk unchanged for an already holding onboarding, upgrade, or reset', async () => {
    for (const kind of ['onboarding', 'onboarding_upgrade', 'reset'] as const) {
      const s = await fixture();
      await s.write();
      const before = {
        repo: (
          await db!.select().from(schema.repositories).where(eq(schema.repositories.id, s.repo.id))
        )[0],
        sync: (
          await db!
            .select()
            .from(schema.projectStateSync)
            .where(eq(schema.projectStateSync.repositoryId, s.repo.id))
        )[0],
        outbox: await s.outbox(),
        disk: await s.render(),
      };
      if (kind === 'reset')
        await db!
          .update(schema.repositories)
          .set({ rootClaimKind: 'reset', rootClaimedAt: new Date() })
          .where(eq(schema.repositories.id, s.repo.id));
      else
        await db!.insert(schema.tasks).values({
          userId: s.userId,
          repositoryId: s.repo.id,
          type: kind,
          title: 'holder',
          status: 'running',
        });
      expect(await refreshProjectState(db!, s.repo.id)).toBe(false);
      expect(await s.render()).toEqual(before.disk);
      expect(await s.outbox()).toEqual(before.outbox);
      expect(
        (
          await db!
            .select()
            .from(schema.projectStateSync)
            .where(eq(schema.projectStateSync.repositoryId, s.repo.id))
        )[0],
      ).toEqual(before.sync);
      expect(
        (
          await db!.select().from(schema.repositories).where(eq(schema.repositories.id, s.repo.id))
        )[0]!.renderContext,
      ).toEqual(before.repo!.renderContext);
    }
  });

  it.each([false, true])(
    'reports a dirty held checkout without changing its intent or semantic state (journal=%s)',
    async (journal) => {
      const s = await fixture();
      await s.write();
      if (journal) {
        seam.afterWrite = async () => {
          throw new Error('interrupted foreground');
        };
        await expect(s.write('attempted')).rejects.toThrow('interrupted foreground');
        seam.afterWrite = null;
      } else await markProjectStateDirty(db!, s.repo.id);
      await db!.insert(schema.tasks).values({
        userId: s.userId,
        repositoryId: s.repo.id,
        type: 'onboarding',
        status: 'running',
        title: 'holder',
      });
      const disk = await s.render();
      const [repo] = await db!
        .select()
        .from(schema.repositories)
        .where(eq(schema.repositories.id, s.repo.id));
      const sync = await db!
        .select()
        .from(schema.projectStateSync)
        .where(eq(schema.projectStateSync.repositoryId, s.repo.id));
      const before = (await s.outbox())!;
      expect(await sweepDirtyProjectStates(db!)).toBe(0);
      const after = (await s.outbox())!;
      expect.soft(after.lastError).toContain('holds the checkout');
      expect({ ...after, lastError: before.lastError, updatedAt: before.updatedAt }).toEqual(
        before,
      );
      expect(await s.render()).toEqual(disk);
      expect(
        await db!
          .select()
          .from(schema.projectStateSync)
          .where(eq(schema.projectStateSync.repositoryId, s.repo.id)),
      ).toEqual(sync);
      expect(
        (
          await db!.select().from(schema.repositories).where(eq(schema.repositories.id, s.repo.id))
        )[0],
      ).toEqual(repo);
    },
  );

  const admissionSnapshot = async (s: Awaited<ReturnType<typeof fixture>>) => ({
    files: await readStateFiles(s.root),
    repo: await db!.select().from(schema.repositories).where(eq(schema.repositories.id, s.repo.id)),
    sync: await db!
      .select()
      .from(schema.projectStateSync)
      .where(eq(schema.projectStateSync.repositoryId, s.repo.id)),
    outbox: await s.outbox(),
  });
  const priorDiagnostic = 'distinct prior record diagnostic';
  const initializeAdmissionFixture = async () => {
    const s = await fixture();
    execFileSync('git', ['init', '-q'], { cwd: s.root });
    await s.write();
    await db!
      .update(schema.repositories)
      .set({ scopeExcludeGlobs: ['new/**'] })
      .where(eq(schema.repositories.id, s.repo.id));
    await markProjectStateDirty(db!, s.repo.id);
    await db!
      .update(schema.projectStateOutbox)
      .set({ lastError: priorDiagnostic })
      .where(eq(schema.projectStateOutbox.repositoryId, s.repo.id));
    return s;
  };
  it.each(['onboarding', 'reset'] as const)(
    'preserves the prior diagnostic when git opens with a %s holder after the outer recovery check',
    async (holder) => {
      const s = await initializeAdmissionFixture();
      let before: Awaited<ReturnType<typeof admissionSnapshot>> | undefined;
      let injected = false;
      const wrapped = new Proxy(db!, {
        get(target, prop) {
          if (prop !== 'transaction') return Reflect.get(target, prop);
          return async (fn: Parameters<Database['transaction']>[0]) => {
            // Refresh has passed its outer git check before entering this recovery transaction.
            if (!injected) {
              injected = true;
              if (holder === 'reset')
                expect(await claimRepositoryRoot(db!, s.repo.id, 'reset')).toBeTruthy();
              else
                await db!.insert(schema.tasks).values({
                  userId: s.userId,
                  repositoryId: s.repo.id,
                  type: 'onboarding',
                  status: 'running',
                  title: 'new holder',
                });
              await writeFile(join(s.root, '.git/MERGE_HEAD'), 'a'.repeat(40) + '\n');
              before = await admissionSnapshot(s);
            }
            return target.transaction(fn);
          };
        },
      }) as Database;
      expect(await refreshProjectState(wrapped, s.repo.id)).toBe(false);
      expect(injected).toBe(true);
      expect.soft((await s.outbox())!.lastError).toBe(priorDiagnostic);
      expect.soft(await admissionSnapshot(s)).toEqual(before);
    },
  );
  it.each([
    ['preparation', false],
    ['preparation', true],
    ['mutation', false],
    ['mutation', true],
  ] as const)(
    'classifies a live reset before writer %s with gitOpen=%s without changing the attempted state',
    async (phase, gitOpen) => {
      const s = await initializeAdmissionFixture();
      let before: Awaited<ReturnType<typeof admissionSnapshot>> | undefined;
      let injected = false;
      const wrapped = new Proxy(db!, {
        get(target, prop) {
          if (prop !== 'transaction') return Reflect.get(target, prop);
          return async (fn: Parameters<Database['transaction']>[0]) => {
            const result = await target.transaction(fn);
            const atBoundary =
              result &&
              typeof result === 'object' &&
              (phase === 'preparation' ? 'outcome' in result : 'intentId' in result);
            if (!injected && atBoundary) {
              injected = true;
              expect(await claimRepositoryRoot(db!, s.repo.id, 'reset')).toBeTruthy();
              if (gitOpen) await writeFile(join(s.root, '.git/MERGE_HEAD'), 'b'.repeat(40) + '\n');
              // Sync may legitimately clear an older error; this is the diagnostic at this gate.
              await db!
                .update(schema.projectStateOutbox)
                .set({ lastError: priorDiagnostic })
                .where(eq(schema.projectStateOutbox.repositoryId, s.repo.id));
              before = await admissionSnapshot(s);
            }
            return result;
          };
        },
      }) as Database;
      expect(await refreshProjectState(wrapped, s.repo.id)).toBe(false);
      expect(injected).toBe(true);
      expect(Boolean(before!.outbox!.writeIntent)).toBe(phase === 'mutation');
      const after = await admissionSnapshot(s);
      if (gitOpen) {
        expect.soft(after.outbox!.lastError).toBe(priorDiagnostic);
        expect.soft(after).toEqual(before);
      } else {
        expect.soft(after.outbox!.lastError).toContain('holds the checkout');
        expect
          .soft({
            ...after,
            outbox: {
              ...after.outbox!,
              lastError: before!.outbox!.lastError,
              updatedAt: before!.outbox!.updatedAt,
            },
          })
          .toEqual(before);
      }
    },
  );

  it('a completed holder is a negative control: refresh still writes', async () => {
    const s = await fixture();
    await s.write();
    await db!.insert(schema.tasks).values({
      userId: s.userId,
      repositoryId: s.repo.id,
      type: 'onboarding',
      title: 'ended',
      status: 'completed',
    });
    expect(await refreshProjectState(db!, s.repo.id)).toBe(true);
  });

  it('undoes files after a real database rollback, then retries from committed state', async () => {
    const s = await fixture();
    await s.write();
    const old = await s.render();
    const database = new Proxy(db!, {
      get(target, prop) {
        if (prop !== 'transaction') return Reflect.get(target, prop);
        return (fn: Parameters<Database['transaction']>[0]) =>
          target.transaction(async (tx) => {
            let semanticWrite = false;
            const wrapped = new Proxy(tx, {
              get(handle, key) {
                if (key !== 'update') return Reflect.get(handle, key);
                return (table: typeof schema.repositories) => {
                  if (table === schema.repositories) semanticWrite = true;
                  return handle.update(table);
                };
              },
            });
            const result = await fn(wrapped);
            if (semanticWrite) throw new Error('database rolled back at commit boundary');
            return result;
          });
      },
    }) as Database;
    const failed = await s.write('attempted', database).catch((err: unknown) => err);
    expect(failed).toMatchObject({
      columnStale: true,
      message: expect.stringContaining('database rolled back'),
    });
    expect((await s.render()).projectInfo.name).toBe('attempted');
    const dirty = await s.outbox();
    expect(dirty!.revision).toBeGreaterThan(dirty!.writtenRevision);
    expect(await sweepDirtyProjectStates(db!)).toBe(1); // Cleanup also failed, so the committed column remains the retry source.
    expect(await s.render()).toEqual(old);
    expect((await s.outbox())!.writeIntent).toBeNull();
    await s.write('retried from the step');
    const clean = await s.outbox();
    expect(clean!.writtenRevision).toBe(clean!.revision);
    expect(clean!.writeIntent).toBeNull();
  });

  it('holds an interrupted journal when a person edits one of its files', async () => {
    const s = await fixture();
    await s.write();
    seam.afterWrite = async () => {
      throw new Error('partial write');
    };
    await expect(s.write('attempted')).rejects.toThrow('partial write');
    seam.afterWrite = null;
    await diskRecord(s.root, 'hand edit');
    expect(await refreshProjectState(db!, s.repo.id)).toBe(false);
    expect((await s.render()).projectInfo.name).toBe('hand edit');
    expect((await s.outbox())!.writeIntent).toBeTruthy();
  });

  it('does not recover an interrupted record into a newly held checkout', async () => {
    const s = await fixture();
    await s.write();
    seam.afterWrite = async () => {
      throw new Error('partial write');
    };
    await expect(s.write('attempted')).rejects.toThrow('partial write');
    seam.afterWrite = null;
    const disk = await s.render();
    const intent = (await s.outbox())!.writeIntent;
    const [task] = await db!
      .insert(schema.tasks)
      .values({
        userId: s.userId,
        repositoryId: s.repo.id,
        type: 'onboarding_upgrade',
        title: 'new owner',
        status: 'running',
      })
      .returning();
    expect(await refreshProjectState(db!, s.repo.id)).toBe(false);
    expect(await s.render()).toEqual(disk);
    expect((await s.outbox())!.writeIntent).toEqual(intent);
    await db!
      .update(schema.tasks)
      .set({ status: 'completed' })
      .where(eq(schema.tasks.id, task!.id));
    expect(await refreshProjectState(db!, s.repo.id)).toBe(false); // Recovery must not manufacture a column cleared by the failed writer.
    expect((await s.render()).projectInfo.name).toBe('local');
    expect((await s.outbox())!.writeIntent).toBeNull();
  });

  it('consumes the undo journal with the successful database commit, so later refresh cannot undo it', async () => {
    const s = await fixture();
    await s.write();
    await s.write('committed');
    expect((await s.outbox())!.writeIntent).toBeNull();
    expect(await refreshProjectState(db!, s.repo.id)).toBe(true);
    expect((await s.render()).projectInfo.name).toBe('committed');
  });

  it('uses the live RTK switch at 12’s actual applicable-set write while retaining 07’s artifact snapshot', async () => {
    const s = await fixture(null);
    const [task] = await db!
      .insert(schema.tasks)
      .values({
        userId: s.userId,
        repositoryId: s.repo.id,
        type: 'onboarding',
        title: 'onboarding',
        status: 'running',
      })
      .returning();
    const generated = {
      ...REFERENCE_CONTEXT,
      rtkEnabled: true,
      cliProviders: [],
      enabledCliProviders: [
        { name: 'claude-code', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' },
      ],
    };
    await db!.insert(schema.taskSteps).values({
      taskId: task!.id,
      stepId: '07-generate-files',
      stepIndex: 7,
      title: 'generated',
      status: 'done',
      detectOutput: generated,
      output: { wroteFiles: [], skippedFiles: [] },
    });
    await db!
      .update(schema.repositories)
      .set({ rtkEnabled: false, rtkChoiceMadeAt: new Date() })
      .where(eq(schema.repositories.id, s.repo.id));
    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const ctx = {
      db: db!,
      repoPath: s.root,
      workspacePath: s.root,
      taskId: task!.id,
      userId: s.userId,
      logger,
      throwIfCancelled() {},
    } as unknown as StepContext;
    const output = await postOnboardingStep.apply(ctx, {
      detected: { hasGit: false } as never,
      formValues: { commit: false },
      iteration: 0,
      previousIterations: [],
    });
    const [repo] = await db!
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, s.repo.id));
    expect(output.artifactRowsWritten, output.warnings.join('\n')).toBeGreaterThan(0);
    const rtkIds = new Set(
      expandManifestFor({ ...generated, rtkEnabled: true } as never)
        .filter((r) => r.templateKind === 'rtk-config')
        .map((r) => r.templateId),
    );
    expect(rtkIds.size).toBeGreaterThan(0);
    expect(repo!.applicableTemplateIds!.some((id) => rtkIds.has(id))).toBe(false);
    expect(repo!.rtkEnabled).toBe(false);
    const rows = await db!
      .select()
      .from(schema.onboardingArtifacts)
      .where(eq(schema.onboardingArtifacts.repositoryId, s.repo.id));
    expect(
      rows.some(
        (row) =>
          row.templateKind === 'rtk-config' &&
          (row.formValuesSnapshot as { rtkEnabled: boolean }).rtkEnabled,
      ),
    ).toBe(true);
  });
  it('keeps only a dirty intent when a task is admitted between intent commit and final writes', async () => {
    const s = await fixture();
    await s.write();
    const before = await s.render();
    const syncBefore = (
      await db!
        .select()
        .from(schema.projectStateSync)
        .where(eq(schema.projectStateSync.repositoryId, s.repo.id))
    )[0];
    let admitted = false;
    const wrapped = new Proxy(db!, {
      get(target, prop) {
        if (prop !== 'transaction') return Reflect.get(target, prop);
        return async (fn: Parameters<Database['transaction']>[0]) => {
          const result = await target.transaction(fn);
          if (!admitted && result && typeof result === 'object' && 'intentId' in result) {
            admitted = true;
            await db!.insert(schema.tasks).values({
              userId: s.userId,
              repositoryId: s.repo.id,
              type: 'onboarding_upgrade',
              title: 'holder after intent',
              status: 'running',
            });
          }
          return result;
        };
      },
    }) as Database;
    expect(await refreshProjectState(wrapped, s.repo.id)).toBe(false);
    expect(admitted).toBe(true);
    expect(await s.render()).toEqual(before);
    expect(
      (
        await db!
          .select()
          .from(schema.projectStateSync)
          .where(eq(schema.projectStateSync.repositoryId, s.repo.id))
      )[0],
    ).toEqual(syncBefore);
    const dirty = await s.outbox();
    expect(dirty!.writeIntent).toBeTruthy();
    expect(dirty!.revision).toBeGreaterThan(dirty!.writtenRevision);
  });

  it('restores an interrupted removal with its original mode and owner, then retries the committed database change', async () => {
    const s = await fixture();
    await db!
      .update(schema.repositories)
      .set({ rtkVersion: '1.0.0' })
      .where(eq(schema.repositories.id, s.repo.id));
    await s.write();
    const path = join(s.root, '.haive-data/state/settings/rtk-version.json');
    await chmod(path, 0o600);
    const metadata = await stat(path);
    await db!
      .update(schema.repositories)
      .set({ rtkVersion: null })
      .where(eq(schema.repositories.id, s.repo.id));
    seam.afterRemove = async () => {
      throw new Error('crash after removal');
    };
    await expect(s.write()).rejects.toThrow('crash after removal');
    seam.afterRemove = null;
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await recoverProjectStateWrite(db!, s.repo.id, s.root);
    expect(JSON.parse(await readFile(path, 'utf8'))).toBe('1.0.0');
    const restored = await stat(path);
    expect([restored.mode & 0o777, restored.uid, restored.gid]).toEqual([
      metadata.mode & 0o777,
      metadata.uid,
      metadata.gid,
    ]);
    await s.write(); // The foreground step retries only after the undo has settled.
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await s.outbox())!.writeIntent).toBeNull();
  });

  it('a direct sync holds partial writer bytes instead of importing an uncommitted context', async () => {
    const s = await fixture();
    await s.write();
    seam.afterWrite = async () => {
      throw new Error('partial writer');
    };
    await expect(s.write('uncommitted')).rejects.toThrow('partial writer');
    seam.afterWrite = null;
    const before = (
      await db!
        .select()
        .from(schema.projectStateSync)
        .where(eq(schema.projectStateSync.repositoryId, s.repo.id))
    )[0];
    expect(
      (await syncProjectStateFromCheckout(db!, { repositoryId: s.repo.id, repoPath: s.root }))
        .outcome,
    ).toBe('held');
    expect(
      (
        await db!
          .select()
          .from(schema.projectStateSync)
          .where(eq(schema.projectStateSync.repositoryId, s.repo.id))
      )[0],
    ).toEqual(before);
  });

  it('acknowledges raw checkout bytes separately from the normalized output and conflict-preserving base', async () => {
    const s = await fixture();
    await s.write();
    const path = join(s.root, '.haive-data/state/project/render.json');
    const raw = JSON.stringify(context('team'), null, 4) + '\r\n';
    await writeFile(path, raw);
    await db!
      .update(schema.repositories)
      .set({ renderContext: { ...context('mine'), rtkChoiceRecorded: false } })
      .where(eq(schema.repositories.id, s.repo.id));
    const result = await syncProjectStateFromCheckout(db!, {
      repositoryId: s.repo.id,
      repoPath: s.root,
    });
    expect(result.outcome).toBe('conflict');
    const files = renderProjectState({ ...emptyProjectState(), render: context('team') });
    files.set('project/render.json', raw);
    const expectedHash = projectStateHash(
      new Map([...files].map(([rel, text]) => [rel, gitBlobId(text)])),
    );
    const [row] = await db!
      .select()
      .from(schema.projectStateSync)
      .where(eq(schema.projectStateSync.repositoryId, s.repo.id));
    expect(row!.syncedHash).toBe(expectedHash);
    expect(
      (row!.baseSnapshot as { render: ReturnType<typeof context> }).render.projectInfo.name,
    ).toBe('local');
    await s.write('mine');
    expect((await s.render()).projectInfo.name).toBe('team');
    const [again] = await db!
      .select()
      .from(schema.projectStateSync)
      .where(eq(schema.projectStateSync.repositoryId, s.repo.id));
    expect(again!.syncedHash).not.toBe(expectedHash); // Writer normalized the bytes but retained the incoming conflict overlay.
    expect(
      (again!.baseSnapshot as { render: ReturnType<typeof context> }).render.projectInfo.name,
    ).toBe('local');
  });

  it('preserves an unowned malformed RTK setting, its warning, and the dirty retry signal', async () => {
    const s = await fixture();
    await s.write();
    const path = join(s.root, '.haive-data/state/settings/rtk-enabled.json');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, '"manual repair required"\n');
    expect(await refreshProjectState(db!, s.repo.id)).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('"manual repair required"\n');
    const dirty = await s.outbox();
    expect(dirty!.revision).toBeGreaterThan(dirty!.writtenRevision);
    expect(dirty!.lastError).toContain('no recorded RTK choice');
    expect(
      (
        await db!.select().from(schema.repositories).where(eq(schema.repositories.id, s.repo.id))
      )[0]!.rtkChoiceMadeAt,
    ).toBeNull();
  });

  it('recovers after the writer process is killed before COMMIT, without adopting its rolled-back context', async () => {
    const s = await fixture();
    await s.write();
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('./support/project-state-crash-child.ts', import.meta.url)),
      ],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, T266_CRASH_REPOSITORY_ID: s.repo.id, T266_CRASH_REPO_PATH: s.root },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let error = '';
    child.stderr.on('data', (chunk) => {
      error = (error + chunk.toString()).slice(-2000);
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once('close', (code, signal) => resolve({ code, signal })),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`crash child did not reach COMMIT: ${error}`)),
          15000,
        );
        child.stdout.on('data', (chunk) => {
          if (chunk.toString().includes('T266_BEFORE_COMMIT')) {
            clearTimeout(timeout);
            resolve();
          }
        });
        child.once('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
        void closed.then((result) => {
          clearTimeout(timeout);
          reject(new Error(`crash child exited early: ${JSON.stringify(result)} ${error}`));
        });
      });
      expect((await s.render()).projectInfo.name).toBe('killed attempt');
      expect(
        (
          await db!.select().from(schema.repositories).where(eq(schema.repositories.id, s.repo.id))
        )[0]!.renderContext,
      ).toMatchObject(context());
      expect((await s.outbox())!.writeIntent).toBeTruthy();
      child.kill('SIGKILL');
      expect((await closed).signal).toBe('SIGKILL');
      expect(await refreshProjectState(db!, s.repo.id)).toBe(true);
      expect((await s.render()).projectInfo.name).toBe('local');
      expect((await s.outbox())!.writeIntent).toBeNull();
    } finally {
      child.kill('SIGKILL');
      await closed;
    }
  }, 30000);

  it('retains the attempted local side of pending conflicts when a foreground SQL transaction fails after writing', async () => {
    const s = await fixture();
    await s.write();
    await db!
      .update(schema.repositories)
      .set({ renderContext: { ...context('mine'), rtkChoiceRecorded: false } })
      .where(eq(schema.repositories.id, s.repo.id));
    await diskRecord(s.root, 'theirs');
    expect(
      (await syncProjectStateFromCheckout(db!, { repositoryId: s.repo.id, repoPath: s.root }))
        .outcome,
    ).toBe('conflict');
    const failing = new Proxy(db!, {
      get(target, prop) {
        if (prop !== 'transaction') return Reflect.get(target, prop);
        return (fn: Parameters<Database['transaction']>[0]) =>
          target.transaction(async (tx) => {
            let semanticWrite = false;
            const wrapped = new Proxy(tx, {
              get(handle, key) {
                if (key !== 'update') return Reflect.get(handle, key);
                return (table: typeof schema.repositories) => {
                  if (table === schema.repositories) semanticWrite = true;
                  return handle.update(table);
                };
              },
            });
            const result = await fn(wrapped);
            if (semanticWrite) throw new Error('rollback pending writer');
            return result;
          });
      },
    }) as Database;
    // Let the cleanup transaction clear the stale column and persist the pending local side.
    let refused = false;
    const once = new Proxy(failing, {
      get(target, prop) {
        if (prop !== 'transaction') return Reflect.get(target, prop);
        return async (fn: Parameters<Database['transaction']>[0]) => {
          if (refused) return db!.transaction(fn);
          try {
            return await target.transaction(fn);
          } catch (err) {
            refused = true;
            throw err;
          }
        };
      },
    }) as Database;
    await expect(s.write('my attempted choice', once)).rejects.toThrow('rollback pending writer');
    const [pending] = await db!
      .select()
      .from(schema.projectStateConflicts)
      .where(eq(schema.projectStateConflicts.repositoryId, s.repo.id));
    expect(pending!.local).toMatchObject({ v: { name: 'my attempted choice' } });
    expect(pending!.resolvedAt).toBeNull();
    expect(await refreshProjectState(db!, s.repo.id)).toBe(true);
    expect((await s.render()).projectInfo.name).toBe('theirs');
    expect(
      (
        await db!.select().from(schema.repositories).where(eq(schema.repositories.id, s.repo.id))
      )[0]!.renderContext,
    ).toMatchObject(context('my attempted choice'));
  });

  it('04 refuses its applicable-set write once a competing column commits after apply read it', async () => {
    const s = await fixture();
    await s.write();
    const [task] = await db!
      .insert(schema.tasks)
      .values({
        userId: s.userId,
        repositoryId: s.repo.id,
        type: 'onboarding_upgrade',
        title: 'rollback',
        status: 'running',
      })
      .returning();
    await db!.insert(schema.onboardingArtifacts).values({
      userId: s.userId,
      repositoryId: s.repo.id,
      taskId: task!.id,
      diskPath: '.claude/workflow-config.json',
      templateId: 'workflow-config',
      templateKind: 'workflow-config',
      templateSchemaVersion: 1,
      templateContentHash: 'a'.repeat(64),
      writtenHash: 'a'.repeat(64),
      source: 'onboarding',
      sourceStepId: '07-generate-files',
      formValuesSnapshot: REFERENCE_CONTEXT as unknown as Record<string, unknown>,
    });
    let moved = false;
    const wrapped = new Proxy(db!, {
      get(target, prop) {
        if (prop !== 'transaction') return Reflect.get(target, prop);
        return async (fn: Parameters<Database['transaction']>[0]) => {
          if (!moved) {
            moved = true;
            await db!.transaction(async (tx) => {
              await lockProjectState(tx, s.repo.id);
              await tx
                .update(schema.repositories)
                .set({ renderContext: { ...context('newer checkout'), rtkChoiceRecorded: false } })
                .where(eq(schema.repositories.id, s.repo.id));
            });
          }
          return target.transaction(fn);
        };
      },
    }) as Database;
    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const ctx = {
      db: wrapped,
      repoPath: s.root,
      taskId: task!.id,
      userId: s.userId,
      logger,
    } as unknown as StepContext;
    const before = { disk: await s.render(), box: await s.outbox() };
    await expect(
      upgradeRollbackStep.apply(ctx, {
        detected: {
          repositoryId: s.repo.id,
          rolledBackFromTaskId: task!.id,
          targets: [],
          newArtifactsToUndo: [],
          warnings: [],
        },
      } as never),
    ).rejects.toThrow('settings changed');
    expect(moved).toBe(true);
    const [repo] = await db!
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, s.repo.id));
    expect(repo!.renderContext).toMatchObject(context('newer checkout'));
    expect(repo!.applicableTemplateIds).toBeNull();
    expect(await s.render()).toEqual(before.disk);
    expect(await s.outbox()).toEqual(before.box);
  });

  it('04 refuses its final record after its own checkout holder is cancelled', async () => {
    const s = await fixture();
    await s.write();
    const [task] = await db!
      .insert(schema.tasks)
      .values({
        userId: s.userId,
        repositoryId: s.repo.id,
        type: 'onboarding_upgrade',
        title: 'rollback',
        status: 'running',
      })
      .returning();
    await db!.insert(schema.onboardingArtifacts).values({
      userId: s.userId,
      repositoryId: s.repo.id,
      taskId: task!.id,
      diskPath: '.claude/workflow-config.json',
      templateId: 'workflow-config',
      templateKind: 'workflow-config',
      templateSchemaVersion: 1,
      templateContentHash: 'a'.repeat(64),
      writtenHash: 'a'.repeat(64),
      source: 'onboarding',
      sourceStepId: '07-generate-files',
      formValuesSnapshot: REFERENCE_CONTEXT as unknown as Record<string, unknown>,
    });
    let cancelled = false;
    const wrapped = new Proxy(db!, {
      get(target, prop) {
        if (prop !== 'transaction') return Reflect.get(target, prop);
        return async (fn: Parameters<Database['transaction']>[0]) => {
          const result = await target.transaction(fn);
          if (!cancelled) {
            cancelled = true;
            await db!
              .update(schema.tasks)
              .set({ status: 'cancelled' })
              .where(eq(schema.tasks.id, task!.id));
          }
          return result;
        };
      },
    }) as Database;
    const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const ctx = {
      db: wrapped,
      repoPath: s.root,
      taskId: task!.id,
      userId: s.userId,
      logger,
    } as unknown as StepContext;
    const before = { disk: await s.render(), box: await s.outbox() };
    const output = await upgradeRollbackStep.apply(ctx, {
      detected: {
        repositoryId: s.repo.id,
        rolledBackFromTaskId: task!.id,
        targets: [],
        newArtifactsToUndo: [],
        warnings: [],
      },
    } as never);
    expect(cancelled).toBe(true);
    expect(output.recordWrite).toBe('failed');
    expect(await s.render()).toEqual(before.disk);
    expect(await s.outbox()).toEqual(before.box);
  });
  it('a reset claim waits for the final file transaction’s repository row lock', async () => {
    const s = await fixture();
    await s.write();
    let claim: ReturnType<typeof claimRepositoryRoot> | null = null;
    let settled = false;
    seam.afterWrite = async () => {
      if (claim) return;
      claim = claimRepositoryRoot(db!, s.repo.id, 'reset').finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(settled).toBe(false);
    };
    try {
      await s.write('serialized before reset');
      expect(claim).toBeTruthy();
      expect(await claim).toBeTruthy();
      expect((await s.render()).projectInfo.name).toBe('serialized before reset');
    } finally {
      seam.afterWrite = null;
      await claim;
    }
  });

  it('keeps a new checkout file installed after the final read instead of overwriting it', async () => {
    const s = await fixture();
    let changed = false;
    seam.afterWrite = async () => {
      if (!changed) {
        changed = true;
        await diskRecord(s.root, 'concurrent editor');
      }
    };
    await expect(s.write()).rejects.toThrow('settings changed');
    seam.afterWrite = null;
    expect(changed).toBe(true);
    expect((await s.render()).projectInfo.name).toBe('concurrent editor');
    expect(
      await db!
        .select()
        .from(schema.projectStateSync)
        .where(eq(schema.projectStateSync.repositoryId, s.repo.id)),
    ).toEqual([]);
    expect((await s.outbox())!.writeIntent).toBeTruthy();
    expect(await refreshProjectState(db!, s.repo.id)).toBe(false);
    expect((await s.render()).projectInfo.name).toBe('concurrent editor');
    expect((await s.outbox())!.lastError).toContain('changed after the attempted write');
  });
  it('refuses a reset completed after refresh read its column, before any new intent or file', async () => {
    const s = await fixture();
    await s.write();
    let reset = false;
    const wrapped = new Proxy(db!, {
      get(target, prop) {
        if (prop !== 'select') return Reflect.get(target, prop);
        return (fields?: Record<string, unknown>) => {
          const query = target.select(fields as never);
          if (
            !fields ||
            Object.keys(fields).length !== 2 ||
            !('renderContext' in fields) ||
            !('onboardingResetAt' in fields)
          )
            return query;
          return {
            from(table: typeof schema.repositories) {
              return {
                where(condition: ReturnType<typeof eq>) {
                  return {
                    limit(count: number) {
                      return query
                        .from(table)
                        .where(condition)
                        .limit(count)
                        .then(async (rows) => {
                          if (!reset) {
                            reset = true;
                            await db!.transaction(async (tx) => {
                              await tx
                                .update(schema.repositories)
                                .set({ renderContext: null, onboardingResetAt: new Date() })
                                .where(eq(schema.repositories.id, s.repo.id));
                              await tx
                                .delete(schema.projectStateSync)
                                .where(eq(schema.projectStateSync.repositoryId, s.repo.id));
                              await tx
                                .delete(schema.projectStateOutbox)
                                .where(eq(schema.projectStateOutbox.repositoryId, s.repo.id));
                            });
                            await rm(join(s.root, '.haive-data/state'), { recursive: true });
                          }
                          return rows;
                        });
                    },
                  };
                },
              };
            },
          };
        };
      },
    }) as Database;
    expect(await refreshProjectState(wrapped, s.repo.id)).toBe(false);
    expect(reset).toBe(true);
    expect(
      (
        await db!.select().from(schema.repositories).where(eq(schema.repositories.id, s.repo.id))
      )[0]!.renderContext,
    ).toBeNull();
    expect(await s.outbox()).toBeUndefined();
    expect(
      await db!
        .select()
        .from(schema.projectStateSync)
        .where(eq(schema.projectStateSync.repositoryId, s.repo.id)),
    ).toEqual([]);
    await expect(s.render()).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('keeps an attempted pending local side after render landed and a later file CAS loses to an editor', async () => {
    const s = await fixture();
    await db!
      .update(schema.repositories)
      .set({ rtkVersion: '1.0.0' })
      .where(eq(schema.repositories.id, s.repo.id));
    await s.write();
    await db!
      .update(schema.repositories)
      .set({ renderContext: { ...context('mine'), rtkChoiceRecorded: false } })
      .where(eq(schema.repositories.id, s.repo.id));
    const renderPath = join(s.root, '.haive-data/state/project/render.json');
    await writeFile(renderPath, JSON.stringify(context('theirs'), null, 4) + '\n');
    expect(
      (await syncProjectStateFromCheckout(db!, { repositoryId: s.repo.id, repoPath: s.root }))
        .outcome,
    ).toBe('conflict');
    await db!
      .update(schema.repositories)
      .set({ rtkVersion: '2.0.0' })
      .where(eq(schema.repositories.id, s.repo.id));
    const settingPath = join(s.root, '.haive-data/state/settings/rtk-version.json');
    let editorWrote = false;
    seam.afterWrite = async () => {
      if (editorWrote) return;
      editorWrote = true;
      // The first actual change normalizes the incoming render. The next path's preimage is now stale.
      expect(await readFile(renderPath, 'utf8')).not.toBe(
        JSON.stringify(context('theirs'), null, 4) + '\n',
      );
      await writeFile(settingPath, '"editor version"\n');
    };
    const error = await s.write('my attempted choice').catch((err: unknown) => err);
    seam.afterWrite = null;
    expect(error).toBeInstanceOf(Error);
    expect(editorWrote).toBe(true);
    expect(error).toMatchObject({
      name: 'ProjectStateWriteError',
      columnStale: false,
      written: expect.arrayContaining(['.haive-data/state/project/render.json']),
    });
    expect((error as { written: string[] }).written).not.toContain(
      '.haive-data/state/settings/rtk-version.json',
    );
    expect(await readFile(settingPath, 'utf8')).toBe('"editor version"\n');
    expect((await s.outbox())!.writeIntent).toBeTruthy();
    const [pending] = await db!
      .select()
      .from(schema.projectStateConflicts)
      .where(eq(schema.projectStateConflicts.repositoryId, s.repo.id));
    expect(pending!.local).toMatchObject({ v: { name: 'my attempted choice' } });
    expect(pending!.resolvedAt).toBeNull();
    expect(
      (
        await db!.select().from(schema.repositories).where(eq(schema.repositories.id, s.repo.id))
      )[0]!.renderContext,
    ).toBeNull();
  });

  it('leaves committed pending semantics alone when the first actual file CAS loses', async () => {
    const s = await fixture();
    await s.write();
    await db!
      .update(schema.repositories)
      .set({ renderContext: { ...context('mine'), rtkChoiceRecorded: false } })
      .where(eq(schema.repositories.id, s.repo.id));
    const renderPath = join(s.root, '.haive-data/state/project/render.json');
    await writeFile(renderPath, JSON.stringify(context('theirs'), null, 4) + '\n');
    expect(
      (await syncProjectStateFromCheckout(db!, { repositoryId: s.repo.id, repoPath: s.root }))
        .outcome,
    ).toBe('conflict');
    let editorWrote = false;
    seam.beforeRewrite = async () => {
      if (editorWrote) return;
      editorWrote = true;
      await writeFile(renderPath, JSON.stringify(context('editor before first mutation')) + '\n');
    };
    await expect(s.write('unwritten attempted choice')).rejects.toThrow('settings changed');
    seam.beforeRewrite = null;
    expect(editorWrote).toBe(true);
    expect((await s.render()).projectInfo.name).toBe('editor before first mutation');
    const [pending] = await db!
      .select()
      .from(schema.projectStateConflicts)
      .where(eq(schema.projectStateConflicts.repositoryId, s.repo.id));
    expect(pending!.local).toMatchObject({ v: { name: 'mine' } });
    expect(
      (
        await db!.select().from(schema.repositories).where(eq(schema.repositories.id, s.repo.id))
      )[0]!.renderContext,
    ).toMatchObject(context('mine'));
  });

  it.each(['02', '12'] as const)(
    '%s reports a post-mutation CAS as a failed record without staging the editor-owned path',
    async (step) => {
      const s = await fixture();
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: s.root, encoding: 'utf8' });
      if (step === '12') {
        git('init', '-q', '-b', 'main');
        git('config', 'user.name', 'T266');
        git('config', 'user.email', 't266@haive.local');
        await writeFile(join(s.root, 'README.md'), 'fixture\n');
        git('add', 'README.md');
        git('commit', '-qm', 'seed');
      }
      await db!
        .update(schema.repositories)
        .set({ rtkVersion: '1.0.0' })
        .where(eq(schema.repositories.id, s.repo.id));
      await s.write();
      if (step === '12') {
        git('add', '.haive-data/state');
        git('commit', '-qm', 'record before attempt');
      }
      await db!
        .update(schema.repositories)
        .set({ renderContext: { ...context('mine'), rtkChoiceRecorded: false } })
        .where(eq(schema.repositories.id, s.repo.id));
      const renderPath = join(s.root, '.haive-data/state/project/render.json');
      await writeFile(renderPath, JSON.stringify(context('theirs'), null, 4) + '\n');
      expect(
        (await syncProjectStateFromCheckout(db!, { repositoryId: s.repo.id, repoPath: s.root }))
          .outcome,
      ).toBe('conflict');
      await db!
        .update(schema.repositories)
        .set({ rtkVersion: '2.0.0' })
        .where(eq(schema.repositories.id, s.repo.id));
      const [task] = await db!
        .insert(schema.tasks)
        .values({
          userId: s.userId,
          repositoryId: s.repo.id,
          type: step === '12' ? 'onboarding' : 'onboarding_upgrade',
          title: 'attempt',
          status: 'running',
        })
        .returning();
      const attempted = {
        ...REFERENCE_CONTEXT,
        projectInfo: { ...REFERENCE_CONTEXT.projectInfo, name: 'my attempted choice' },
        cliProviders: [],
      };
      if (step === '12')
        await db!.insert(schema.taskSteps).values({
          taskId: task!.id,
          stepId: '07-generate-files',
          stepIndex: 7,
          title: 'generated',
          status: 'done',
          detectOutput: attempted,
          output: { wroteFiles: [], skippedFiles: [] },
        });
      const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
      const ctx = {
        db: db!,
        repoPath: s.root,
        workspacePath: s.root,
        taskId: task!.id,
        userId: s.userId,
        logger,
        throwIfCancelled() {},
      } as unknown as StepContext;
      let edited = false;
      const editorPath = '.haive-data/state/settings/rtk-version.json';
      seam.afterWrite = async () => {
        if (!edited) {
          edited = true;
          await writeFile(join(s.root, editorPath), '"editor version"\n');
        }
      };
      if (step === '02') {
        const output = await upgradeApplyStep.apply(ctx, {
          detected: {
            repositoryId: s.repo.id,
            ranBackfill: false,
            entries: [],
            counts: {},
            installedTemplateSetHash: null,
            currentTemplateSetHash: 'set',
            renderCtxSnapshot: { ...REFERENCE_CONTEXT, projectInfo: attempted.projectInfo },
            rtkFollowsLive: false,
            backfilledRows: 0,
          },
          formValues: {},
          iteration: 0,
          previousIterations: [],
        } as never);
        expect(output.recordWrite).toBe('failed');
        expect(output.writtenPaths).toContain('.haive-data/state/project/render.json');
        expect(output.writtenPaths).not.toContain(editorPath);
      } else {
        const output = await postOnboardingStep.apply(ctx, {
          detected: { hasGit: true },
          formValues: { commit: true, commitMessage: 'record reached files' },
          iteration: 0,
          previousIterations: [],
        } as never);
        expect(output.recordWrite).toBe('failed');
        expect(output.stagedPaths).toContain('.haive-data/state/project/render.json');
        expect(output.stagedPaths).not.toContain(editorPath);
        expect(git('show', `HEAD:${editorPath}`)).toBe('"1.0.0"\n');
      }
      seam.afterWrite = null;
      expect(edited).toBe(true);
      expect(await readFile(join(s.root, editorPath), 'utf8')).toBe('"editor version"\n');
      const [pending] = await db!
        .select()
        .from(schema.projectStateConflicts)
        .where(eq(schema.projectStateConflicts.repositoryId, s.repo.id));
      expect(pending!.local).toMatchObject({ v: { name: 'my attempted choice' } });
      expect((await s.outbox())!.writeIntent).toBeTruthy();
    },
  );

  it('background CAS failure keeps its column and a dirty journal until safe recovery can retry', async () => {
    const s = await fixture();
    await db!
      .update(schema.repositories)
      .set({ rtkVersion: '1.0.0' })
      .where(eq(schema.repositories.id, s.repo.id));
    await s.write();
    const mine = { ...context('mine'), rtkChoiceRecorded: false };
    await db!
      .update(schema.repositories)
      .set({ renderContext: mine })
      .where(eq(schema.repositories.id, s.repo.id));
    await writeFile(
      join(s.root, '.haive-data/state/project/render.json'),
      JSON.stringify(context('theirs'), null, 4) + '\n',
    );
    expect(
      (await syncProjectStateFromCheckout(db!, { repositoryId: s.repo.id, repoPath: s.root }))
        .outcome,
    ).toBe('conflict');
    await db!
      .update(schema.repositories)
      .set({ rtkVersion: '2.0.0' })
      .where(eq(schema.repositories.id, s.repo.id));
    const path = join(s.root, '.haive-data/state/settings/rtk-version.json');
    let edited = false;
    seam.afterWrite = async () => {
      if (!edited) {
        edited = true;
        await writeFile(path, '"editor version"\n');
      }
    };
    await expect(
      writeProjectStateColumn(db!, {
        repositoryId: s.repo.id,
        repoPath: s.root,
        column: mine as never,
        expectedColumns: [mine],
        keepColumnOnFailure: true,
        refuseWhileHeld: true,
      }),
    ).rejects.toMatchObject({ name: 'ProjectStateWriteError', columnStale: false });
    seam.afterWrite = null;
    expect(
      (
        await db!.select().from(schema.repositories).where(eq(schema.repositories.id, s.repo.id))
      )[0]!.renderContext,
    ).toEqual(mine);
    const dirty = await s.outbox();
    expect(dirty!.revision).toBeGreaterThan(dirty!.writtenRevision);
    expect(dirty!.writeIntent).toBeTruthy();
    expect(await sweepDirtyProjectStates(db!)).toBe(0);
    expect(await readFile(path, 'utf8')).toBe('"editor version"\n');
    await writeFile(path, '"1.0.0"\n'); // Explicit manual repair to a recognized preimage releases the held undo.
    expect(await sweepDirtyProjectStates(db!)).toBe(1);
    expect(await readFile(path, 'utf8')).toBe('"2.0.0"\n');
    const clean = await s.outbox();
    expect(clean!.writeIntent).toBeNull();
    expect(clean!.writtenRevision).toBe(clean!.revision);
  });
});
