import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { claimRepositoryRoot, createDatabase, schema, type Database } from '@haive/database';
import {
  claimFileName,
  PROJECT_STATE_LIMITS,
  recordReadable,
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
import { handleRefresh } from '../src/repo/refresh.js';
import {
  putBackProjections,
  restoreFaults,
  setAsideHaiveProjections,
} from '../src/project-state/set-aside.js';

const seam = vi.hoisted(() => ({
  afterWrite: null as null | (() => Promise<void>),
  beforeRewrite: null as null | (() => Promise<void>),
  afterRemove: null as null | (() => Promise<void>),
  beforeRemove: null as null | (() => Promise<void>),
  beforeDirRemove: null as null | (() => Promise<void>),
  afterDirRemove: null as null | (() => Promise<void>),
  afterSetAside: null as null | (() => Promise<void>),
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
    removeEmptyDirectoryIfNoFollow: async (
      ...args: Parameters<typeof real.removeEmptyDirectoryIfNoFollow>
    ) => {
      await seam.beforeDirRemove?.();
      const result = await real.removeEmptyDirectoryIfNoFollow(...args);
      if (result === 'removed') await seam.afterDirRemove?.();
      return result;
    },
    removeFileIfNoFollow: async (...args: Parameters<typeof real.removeFileIfNoFollow>) => {
      await seam.beforeRemove?.();
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

vi.mock('../src/project-state/set-aside.js', async (original) => {
  const real = await original<typeof import('../src/project-state/set-aside.js')>();
  return {
    ...real,
    setAsideHaiveProjections: async (...args: Parameters<typeof real.setAsideHaiveProjections>) => {
      const result = await real.setAsideHaiveProjections(...args);
      await seam.afterSetAside?.();
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
  seam.beforeRemove = null;
  seam.beforeDirRemove = null;
  seam.afterDirRemove = null;
  seam.afterSetAside = null;
  delete restoreFaults.afterBase;
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

  const moveFixture = async () => {
    const s = await fixture();
    const source = join(s.root, 'source');
    const storage = join(s.root, 'storage');
    const dest = join(storage, s.userId, s.repo.id);
    await mkdir(source);
    const git = (dir: string, ...args: string[]) =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    git(source, 'init', '-q', '-b', 'main');
    git(source, 'config', 'user.name', 'T266');
    git(source, 'config', 'user.email', 't266@haive.local');
    await writeProjectStateRecord(db!, {
      repositoryId: s.repo.id,
      repoPath: source,
      context: context() as never,
      rtkChoiceRecorded: false,
    });
    git(source, 'add', '.haive-data/state');
    git(source, 'commit', '-qm', 'initial record');
    await mkdir(join(dest, '..'), { recursive: true });
    git(source, 'clone', '-q', source, dest);
    git(dest, 'config', 'user.name', 'T266');
    git(dest, 'config', 'user.email', 't266@haive.local');
    await db!
      .update(schema.repositories)
      .set({ storagePath: dest })
      .where(eq(schema.repositories.id, s.repo.id));
    await diskRecord(source, 'incoming');
    git(source, 'add', '.haive-data/state');
    git(source, 'commit', '-qm', 'incoming changes journal path');
    const payload = {
      repositoryId: s.repo.id,
      userId: s.userId,
      source: 'local_path' as const,
      localPath: source,
    };
    const refresh = () => handleRefresh(payload, db!, storage);
    const snapshot = async () => ({
      head: git(dest, 'rev-parse', 'HEAD'),
      files: await readStateFiles(dest),
      outbox: await s.outbox(),
      sync: await db!
        .select()
        .from(schema.projectStateSync)
        .where(eq(schema.projectStateSync.repositoryId, s.repo.id)),
      columns: await db!
        .select({
          renderContext: schema.repositories.renderContext,
          applicableTemplateIds: schema.repositories.applicableTemplateIds,
          scopeExcludeGlobs: schema.repositories.scopeExcludeGlobs,
          rtkEnabled: schema.repositories.rtkEnabled,
          rtkChoiceMadeAt: schema.repositories.rtkChoiceMadeAt,
          onboardingEnvironment: schema.repositories.onboardingEnvironment,
          onboardingTooling: schema.repositories.onboardingTooling,
        })
        .from(schema.repositories)
        .where(eq(schema.repositories.id, s.repo.id)),
    });
    const leaveIntent = async (afterPrepared?: () => Promise<void>) => {
      let prepared = false;
      const wrapped = new Proxy(db!, {
        get(target, prop) {
          if (prop !== 'transaction') return Reflect.get(target, prop);
          return async (fn: Parameters<Database['transaction']>[0]) => {
            const result = await target.transaction(fn);
            if (!prepared && result && typeof result === 'object' && 'intentId' in result) {
              prepared = true;
              await afterPrepared?.();
              throw new Error('paused before filesystem');
            }
            return result;
          };
        },
      }) as Database;
      await expect(
        writeProjectStateColumn(wrapped, {
          repositoryId: s.repo.id,
          repoPath: dest,
          column: { ...context('planned'), rtkChoiceRecorded: false } as never,
          keepColumnOnFailure: true,
        }),
      ).rejects.toThrow('paused before filesystem');
      expect(prepared).toBe(true);
    };
    return { s, source, storage, dest, git, payload, refresh, snapshot, leaveIntent };
  };
  it.each(['active', 'persisted', 'late'] as const)(
    'defers a clean public refresh with a %s journal and retries after explicit recovery',
    async (timing) => {
      const m = await moveFixture();
      let before: Awaited<ReturnType<typeof m.snapshot>> | undefined;
      if (timing === 'active')
        await m.leaveIntent(async () => {
          before = await m.snapshot();
          await m.refresh();
        });
      else {
        if (timing === 'persisted') {
          await m.leaveIntent();
          before = await m.snapshot();
        } else
          seam.afterSetAside = async () => {
            seam.afterSetAside = null;
            expect(m.git(m.dest, 'status', '--porcelain')).toBe('');
            await m.leaveIntent();
            before = await m.snapshot();
          };
        await m.refresh();
      }
      expect(before!.outbox!.writeIntent).toBeTruthy();
      expect.soft(await m.snapshot()).toEqual(before);
      const [repo] = await db!
        .select()
        .from(schema.repositories)
        .where(eq(schema.repositories.id, m.s.repo.id));
      expect.soft(repo!.statusMessage).toContain('recovery');
      let recovered = false;
      try {
        await recoverProjectStateWrite(db!, m.s.repo.id, m.dest);
        recovered = true;
      } catch {
        /* red receipt also establishes the stranded journal */
      }
      expect.soft(recovered).toBe(true);
      if (!recovered) return;
      expect((await m.s.outbox())!.writeIntent).toBeNull();
      expect(await readStateFiles(m.dest)).toEqual(before!.files);
      await m.refresh();
      expect(m.git(m.dest, 'rev-parse', 'HEAD')).toBe(m.git(m.source, 'rev-parse', 'HEAD'));
      expect(
        JSON.parse(await readFile(join(m.dest, '.haive-data/state/project/render.json'), 'utf8'))
          .projectInfo.name,
      ).toBe('incoming');
    },
  );
  it('ordinary clean public refresh still lands without a journal', async () => {
    const m = await moveFixture();
    await m.refresh();
    expect(m.git(m.dest, 'rev-parse', 'HEAD')).toBe(m.git(m.source, 'rev-parse', 'HEAD'));
    expect((await m.s.outbox())!.writeIntent).toBeNull();
  });
  it('public refresh never repairs manual divergence in an interrupted journal', async () => {
    const m = await moveFixture();
    await m.leaveIntent();
    await diskRecord(m.dest, 'manual edit');
    const before = await m.snapshot();
    await m.refresh();
    expect(await m.snapshot()).toEqual(before);
    await expect(recoverProjectStateWrite(db!, m.s.repo.id, m.dest)).rejects.toThrow(
      'changed after the attempted write',
    );
    expect(await m.snapshot()).toEqual(before);
  });
  it('set-aside refuses a journal admitted between judgment and filesystem restore', async () => {
    const m = await moveFixture();
    await writeProjectStateColumn(db!, {
      repositoryId: m.s.repo.id,
      repoPath: m.dest,
      column: { ...context('pending'), rtkChoiceRecorded: false } as never,
    });
    let before: Awaited<ReturnType<typeof m.snapshot>> | undefined;
    restoreFaults.afterBase = async () => {
      delete restoreFaults.afterBase;
      await m.leaveIntent();
      before = await m.snapshot();
    };
    const outcome = await setAsideHaiveProjections(db!, m.s.repo.id, m.dest);
    expect(before!.outbox!.writeIntent).toBeTruthy();
    expect
      .soft(outcome)
      .toMatchObject({ outcome: 'refused', reason: expect.stringContaining('recovery') });
    expect.soft(await m.snapshot()).toEqual(before);
  });
  it('put-back cannot rewrite a state file owned by a newer journal', async () => {
    const m = await moveFixture();
    await writeProjectStateColumn(db!, {
      repositoryId: m.s.repo.id,
      repoPath: m.dest,
      column: { ...context('pending'), rtkChoiceRecorded: false } as never,
    });
    const aside = await setAsideHaiveProjections(db!, m.s.repo.id, m.dest);
    expect(aside.outcome).toBe('set-aside');
    if (aside.outcome !== 'set-aside') throw new Error('expected actual kept state');
    await m.leaveIntent();
    const before = await m.snapshot();
    await expect(putBackProjections(db!, m.s.repo.id, m.dest, aside.kept)).rejects.toThrow(
      'recovery',
    );
    expect(await m.snapshot()).toEqual(before);
    await recoverProjectStateWrite(db!, m.s.repo.id, m.dest);
    await putBackProjections(db!, m.s.repo.id, m.dest, aside.kept);
    expect(
      JSON.parse(await readFile(join(m.dest, '.haive-data/state/project/render.json'), 'utf8'))
        .projectInfo.name,
    ).toBe('pending');
  });

  it(
    'undo removes a new empty directory so a supported 4096-entry record is readable again',
    { timeout: 180_000 },
    async () => {
      const s = await fixture();
      const [task] = await db!
        .insert(schema.tasks)
        .values({
          userId: s.userId,
          repositoryId: s.repo.id,
          type: 'onboarding',
          title: 'directory footprint',
          status: 'completed',
        })
        .returning();
      const count = PROJECT_STATE_LIMITS.maxEntries - 4;
      for (let start = 0; start < count; start += 500)
        await db!.insert(schema.onboardingArtifacts).values(
          Array.from({ length: Math.min(500, count - start) }, (_, offset) => ({
            userId: s.userId,
            repositoryId: s.repo.id,
            taskId: task!.id,
            diskPath: `.claude/agents/agent-${String(start + offset).padStart(4, '0')}.md`,
            templateId: `agent.agent-${start + offset}`,
            templateKind: 'agent',
            templateSchemaVersion: 1,
            templateContentHash: 'a'.repeat(64),
            writtenHash: 'b'.repeat(64),
            sourceStepId: '12-post-onboarding',
            source: 'onboarding' as const,
            haiveVersion: '1.2.3',
          })),
        );
      await s.write();
      const state = join(s.root, '.haive-data/state');
      const before = (await readStateFiles(s.root))!;
      expect((await readdir(state, { recursive: true })).length).toBe(4096);
      const sync = await db!
        .select()
        .from(schema.projectStateSync)
        .where(eq(schema.projectStateSync.repositoryId, s.repo.id));
      for (const index of ['0000', '0001'])
        await db!
          .update(schema.onboardingArtifacts)
          .set({ supersededAt: new Date() })
          .where(
            and(
              eq(schema.onboardingArtifacts.repositoryId, s.repo.id),
              eq(schema.onboardingArtifacts.diskPath, `.claude/agents/agent-${index}.md`),
            ),
          );
      await db!.insert(schema.customBundles).values({
        userId: s.userId,
        repositoryId: s.repo.id,
        sourceType: 'zip',
        name: 'new directory',
        storageRoot: join(s.root, 'bundle-storage'),
      });
      seam.afterWrite = async () => {
        throw new Error('bundle landed before obsolete claims removed');
      };
      await expect(
        writeProjectStateColumn(db!, {
          repositoryId: s.repo.id,
          repoPath: s.root,
          column: { ...context(), rtkChoiceRecorded: false } as never,
          keepColumnOnFailure: true,
        }),
      ).rejects.toThrow('bundle landed before obsolete claims removed');
      seam.afterWrite = null;
      const intent = (await s.outbox())!.writeIntent as {
        changes: { rel: string; after: string | null }[];
      };
      expect(intent.changes).toHaveLength(3);
      const planned = new Map(before);
      for (const change of intent.changes) {
        if (change.after === null) planned.delete(change.rel);
        else planned.set(change.rel, change.after);
      }
      expect(recordReadable(before)).toEqual({ readable: true });
      expect(recordReadable(planned)).toEqual({ readable: true });
      expect((await readdir(state, { recursive: true })).length).toBe(4098);
      const killRecovery = async (phase: 'before' | 'after') => {
        const child = spawn(
          process.execPath,
          [
            '--import',
            'tsx',
            fileURLToPath(
              new URL('./support/project-state-directory-crash-child.ts', import.meta.url),
            ),
          ],
          {
            cwd: fileURLToPath(new URL('..', import.meta.url)),
            env: {
              ...process.env,
              T266_CRASH_REPOSITORY_ID: s.repo.id,
              T266_CRASH_REPO_PATH: s.root,
              T266_DIRECTORY_CRASH_PHASE: phase,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let error = '';
        child.stderr.on('data', (chunk) => {
          error = (error + chunk.toString()).slice(-2000);
        });
        const closed = new Promise<NodeJS.Signals | null>((resolve) =>
          child.once('close', (_code, signal) => resolve(signal)),
        );
        try {
          const boundary = await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error(`directory crash boundary missing: ${error}`)),
              15000,
            );
            let output = '';
            child.stdout.on('data', (chunk) => {
              output += chunk.toString();
              const match = /T266_DIRECTORY_(PARKED|BEFORE_RMDIR|AFTER_RMDIR)/.exec(output);
              if (match) {
                clearTimeout(timer);
                resolve(match[1]!);
              }
            });
            child.once('error', (err) => {
              clearTimeout(timer);
              reject(err);
            });
            void closed.then((signal) => {
              clearTimeout(timer);
              reject(new Error(`directory child exited early (${signal}): ${error}`));
            });
          });
          process.stdout.write(`T266_ACTUAL_DIRECTORY_CRASH ${phase}: ${boundary}\n`);
          expect((await s.outbox())!.writeIntent).toBeTruthy();
          child.kill('SIGKILL');
          expect(await closed).toBe('SIGKILL');
        } finally {
          child.kill('SIGKILL');
          await closed;
        }
      };
      await killRecovery('before');
      await recoverProjectStateWrite(db!, s.repo.id, s.root);
      expect.soft((await readdir(state, { recursive: true })).length).toBe(4096);
      await expect(readStateFiles(s.root)).resolves.toEqual(before);
      expect((await s.outbox())!.writeIntent).toBeNull();
      expect(
        await db!
          .select()
          .from(schema.projectStateSync)
          .where(eq(schema.projectStateSync.repositoryId, s.repo.id)),
      ).toEqual(sync);
      // The same before record is reused for a real kill immediately after the directory syscall.
      seam.afterWrite = async () => {
        throw new Error('second bundle partial');
      };
      await expect(
        writeProjectStateColumn(db!, {
          repositoryId: s.repo.id,
          repoPath: s.root,
          column: { ...context(), rtkChoiceRecorded: false } as never,
          keepColumnOnFailure: true,
        }),
      ).rejects.toThrow('second bundle partial');
      seam.afterWrite = null;
      await killRecovery('after');
      await recoverProjectStateWrite(db!, s.repo.id, s.root);
      expect((await s.outbox())!.writeIntent).toBeNull();
      expect(await readStateFiles(s.root)).toEqual(before);
      await s.write();
      expect((await readdir(state, { recursive: true })).length).toBe(4096);
      expect(recordReadable((await readStateFiles(s.root))!)).toEqual({ readable: true });
    },
  );
  it.each(['remove', 'rewrite'] as const)(
    'recovery %s rejects an oversized post-recognition editor file before allocating it',
    async (kind) => {
      const s = await fixture(kind === 'remove' ? null : context());
      if (kind === 'rewrite') await s.write();
      seam.afterWrite = async () => {
        throw new Error('partial for bounded CAS');
      };
      await expect(
        writeProjectStateColumn(db!, {
          repositoryId: s.repo.id,
          repoPath: s.root,
          column: { ...context('planned'), rtkChoiceRecorded: false } as never,
          keepColumnOnFailure: true,
        }),
      ).rejects.toThrow('partial for bounded CAS');
      seam.afterWrite = null;
      const path = join(
        s.root,
        '.haive-data/state',
        kind === 'remove' ? 'format.json' : 'project/render.json',
      );
      const editor = Buffer.alloc(PROJECT_STATE_LIMITS.maxFileBytes + 1, 120);
      const before = await s.outbox();
      let allocations = 0;
      let spy: { mockRestore(): void } | undefined;
      const inject = async () => {
        seam.beforeRemove = null;
        seam.beforeRewrite = null;
        await writeFile(path, editor);
        const original = Buffer.allocUnsafe;
        spy = vi.spyOn(Buffer, 'allocUnsafe').mockImplementation((size: number) => {
          if (size > PROJECT_STATE_LIMITS.maxFileBytes) allocations++;
          return original(size);
        });
      };
      if (kind === 'remove') seam.beforeRemove = inject;
      else seam.beforeRewrite = inject;
      try {
        await expect(recoverProjectStateWrite(db!, s.repo.id, s.root)).rejects.toMatchObject({
          name: 'ProjectStateRecoveryHeldError',
        });
      } finally {
        spy?.mockRestore();
      }
      expect.soft(allocations).toBe(0);
      expect(await readFile(path)).toEqual(editor);
      expect(await s.outbox()).toEqual(before);
    },
  );

  it.each([
    'preexisting',
    'foreign',
    'link',
    'foreign-race',
    'replace-race',
    'undo-crash',
    'legacy',
  ] as const)(
    'directory recovery preserves %s state and consumes only a completed undo',
    async (kind) => {
      const s = await fixture();
      await s.write();
      const directory = join(s.root, '.haive-data/state/bundles');
      let prior: Awaited<ReturnType<typeof stat>> | undefined;
      if (kind === 'preexisting') {
        await mkdir(directory);
        await chmod(directory, 0o750);
        prior = await stat(directory);
      }
      await db!.insert(schema.customBundles).values({
        userId: s.userId,
        repositoryId: s.repo.id,
        sourceType: 'zip',
        name: 'directory controls',
        storageRoot: join(s.root, 'bundle-storage'),
      });
      seam.afterWrite = async () => {
        throw new Error('bundle partial');
      };
      await expect(
        writeProjectStateColumn(db!, {
          repositoryId: s.repo.id,
          repoPath: s.root,
          column: { ...context(), rtkChoiceRecorded: false } as never,
          keepColumnOnFailure: true,
        }),
      ).rejects.toThrow('bundle partial');
      seam.afterWrite = null;
      if (kind === 'legacy') {
        const intent = { ...((await s.outbox())!.writeIntent as Record<string, unknown>) };
        delete intent.absentDirs;
        await db!
          .update(schema.projectStateOutbox)
          .set({ writeIntent: intent })
          .where(eq(schema.projectStateOutbox.repositoryId, s.repo.id));
      }
      const box = await s.outbox();
      const descriptor = (await readdir(directory))[0]!;
      const descriptorBytes = await readFile(join(directory, descriptor));
      if (kind === 'foreign') await writeFile(join(directory, 'foreign'), 'person');
      if (kind === 'link') {
        await rename(directory, join(s.root, 'kept-bundles'));
        await symlink(join(s.root, 'kept-bundles'), directory);
      }
      let replacement: Awaited<ReturnType<typeof stat>> | undefined;
      if (kind === 'foreign-race')
        seam.beforeDirRemove = async () => {
          seam.beforeDirRemove = null;
          await writeFile(join(directory, 'foreign'), 'late person');
        };
      if (kind === 'replace-race')
        seam.beforeDirRemove = async () => {
          seam.beforeDirRemove = null;
          await rename(directory, join(s.root, 'kept-empty'));
          await mkdir(directory);
          replacement = await stat(directory);
        };
      if (kind === 'undo-crash')
        seam.afterDirRemove = async () => {
          seam.afterDirRemove = null;
          throw new Error('undo stopped after rmdir');
        };
      if (['foreign', 'link', 'foreign-race', 'replace-race', 'undo-crash'].includes(kind)) {
        await expect(recoverProjectStateWrite(db!, s.repo.id, s.root)).rejects.toThrow();
        expect(await s.outbox()).toEqual(box);
        if (kind === 'foreign' || kind === 'link')
          expect(await readFile(join(directory, descriptor))).toEqual(descriptorBytes);
        if (kind === 'foreign' || kind === 'foreign-race')
          expect(await readFile(join(directory, 'foreign'), 'utf8')).toBe(
            kind === 'foreign' ? 'person' : 'late person',
          );
        if (kind === 'replace-race') expect((await stat(directory)).ino).toBe(replacement!.ino);
        if (kind !== 'undo-crash') return;
        await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
      }
      await recoverProjectStateWrite(db!, s.repo.id, s.root);
      expect((await s.outbox())!.writeIntent).toBeNull();
      if (kind === 'preexisting') {
        const after = await stat(directory);
        expect([after.ino, after.mode & 0o777, after.uid, after.gid]).toEqual([
          prior!.ino,
          Number(prior!.mode) & 0o777,
          prior!.uid,
          prior!.gid,
        ]);
      } else if (kind === 'legacy') expect(await readdir(directory)).toEqual([]);
      else await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(recordReadable((await readStateFiles(s.root))!)).toEqual({ readable: true });
    },
  );
  it('recovery rewrite still accepts a recognized file exactly at the 1 MiB CAS bound', async () => {
    const s = await fixture();
    await s.write();
    const before = await s.render();
    const planned = { ...context('large'), projectInfo: { name: 'large', padding: '' } };
    const baseSize = Buffer.byteLength(
      renderProjectState({ ...emptyProjectState(), render: planned }).get('project/render.json')!,
    );
    planned.projectInfo.padding = 'x'.repeat(PROJECT_STATE_LIMITS.maxFileBytes - baseSize);
    seam.afterWrite = async () => {
      throw new Error('exact-bound partial');
    };
    await expect(
      writeProjectStateColumn(db!, {
        repositoryId: s.repo.id,
        repoPath: s.root,
        column: { ...planned, rtkChoiceRecorded: false } as never,
        keepColumnOnFailure: true,
      }),
    ).rejects.toThrow('exact-bound partial');
    seam.afterWrite = null;
    expect((await stat(join(s.root, '.haive-data/state/project/render.json'))).size).toBe(
      PROJECT_STATE_LIMITS.maxFileBytes,
    );
    await recoverProjectStateWrite(db!, s.repo.id, s.root);
    expect(await s.render()).toEqual(before);
    expect((await s.outbox())!.writeIntent).toBeNull();
  });

  it.each(['entries', 'bytes'] as const)(
    'recovers a real claim rename whose transient union exceeds the %s limit',
    { timeout: 180_000 },
    async (limit) => {
      const s = await fixture();
      const [task] = await db!
        .insert(schema.tasks)
        .values({
          userId: s.userId,
          repositoryId: s.repo.id,
          type: 'onboarding',
          title: 'record bounds',
          status: 'completed',
        })
        .returning();
      const count = limit === 'entries' ? PROJECT_STATE_LIMITS.maxEntries - 4 : 1;
      for (let start = 0; start < count; start += 500)
        await db!.insert(schema.onboardingArtifacts).values(
          Array.from({ length: Math.min(500, count - start) }, (_, offset) => ({
            userId: s.userId,
            repositoryId: s.repo.id,
            taskId: task!.id,
            diskPath: `.claude/agents/agent-${String(start + offset).padStart(4, '0')}.md`,
            templateId: `agent.agent-${start + offset}`,
            templateKind: 'agent',
            templateSchemaVersion: 1,
            templateContentHash: 'a'.repeat(64),
            writtenHash: 'b'.repeat(64),
            sourceStepId: '12-post-onboarding',
            source: 'onboarding' as const,
            haiveVersion: '1.2.3',
          })),
        );
      await s.write();
      const stateRoot = join(s.root, '.haive-data/state');
      if (limit === 'bytes') {
        const files = (await readStateFiles(s.root))!;
        let remaining =
          PROJECT_STATE_LIMITS.maxTotalBytes -
          [...files.values()].reduce((n, text) => n + Buffer.byteLength(text), 0);
        for (let index = 0; remaining > 0; index++) {
          const size = Math.min(PROJECT_STATE_LIMITS.maxFileBytes, remaining);
          await writeFile(join(stateRoot, `opaque-${index}.txt`), 'x'.repeat(size));
          remaining -= size;
        }
        await s.write(); // The real writer imports/stamps these permitted unknown units without owning them.
      }
      const before = (await readStateFiles(s.root))!;
      expect(recordReadable(before)).toEqual({ readable: true });
      if (limit === 'entries')
        expect((await readdir(stateRoot, { recursive: true })).length).toBe(4096);
      else
        expect([...before.values()].reduce((n, text) => n + Buffer.byteLength(text), 0)).toBe(
          PROJECT_STATE_LIMITS.maxTotalBytes,
        );
      const oldPath = '.claude/agents/agent-0000.md';
      const nextPath = '.claude/agents/zgent-0000.md'; // Same length, so complete before/after byte totals agree.
      const oldRel = claimFileName(oldPath);
      const nextRel = claimFileName(nextPath);
      await chmod(join(stateRoot, oldRel), 0o640);
      const oldMetadata = await stat(join(stateRoot, oldRel));
      const sync = await db!
        .select()
        .from(schema.projectStateSync)
        .where(eq(schema.projectStateSync.repositoryId, s.repo.id));
      await db!
        .update(schema.onboardingArtifacts)
        .set({ diskPath: nextPath })
        .where(
          and(
            eq(schema.onboardingArtifacts.repositoryId, s.repo.id),
            eq(schema.onboardingArtifacts.diskPath, oldPath),
          ),
        );
      let additions = 0;
      seam.afterWrite = async () => {
        additions++;
        throw new Error('new claim landed before old removal');
      };
      await expect(
        writeProjectStateColumn(db!, {
          repositoryId: s.repo.id,
          repoPath: s.root,
          column: { ...context(), rtkChoiceRecorded: false } as never,
          keepColumnOnFailure: true,
        }),
      ).rejects.toThrow('new claim landed before old removal');
      seam.afterWrite = null;
      expect(additions).toBe(1);
      const intent = (await s.outbox())!.writeIntent as {
        changes: { rel: string; before: string | null; after: string | null }[];
      };
      expect(intent.changes).toHaveLength(2);
      expect(await readFile(join(stateRoot, oldRel), 'utf8')).toBe(before.get(oldRel));
      const newBytes = await readFile(join(stateRoot, nextRel), 'utf8');
      const planned = new Map(before);
      for (const change of intent.changes) {
        if (change.after === null) planned.delete(change.rel);
        else planned.set(change.rel, change.after);
      }
      expect(recordReadable(planned)).toEqual({ readable: true });
      if (limit === 'entries')
        expect((await readdir(stateRoot, { recursive: true })).length).toBe(4097);
      else
        expect(
          [...before.values()].reduce((n, text) => n + Buffer.byteLength(text), 0) +
            Buffer.byteLength(newBytes),
        ).toBeGreaterThan(PROJECT_STATE_LIMITS.maxTotalBytes);
      await expect(readStateFiles(s.root)).rejects.toThrow(
        limit === 'entries' ? 'more than 4096 entries' : 'more than 16 MiB',
      );
      const recoveryError = await recoverProjectStateWrite(db!, s.repo.id, s.root).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(
        recoveryError,
        `recovery ${limit}: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
      ).toBeUndefined();
      expect((await s.outbox())!.writeIntent).toBeNull();
      expect(await readStateFiles(s.root)).toEqual(before);
      expect(
        await db!
          .select()
          .from(schema.projectStateSync)
          .where(eq(schema.projectStateSync.repositoryId, s.repo.id)),
      ).toEqual(sync);
      const restored = await stat(join(stateRoot, oldRel));
      expect([restored.mode & 0o777, restored.uid, restored.gid]).toEqual([
        oldMetadata.mode & 0o777,
        oldMetadata.uid,
        oldMetadata.gid,
      ]);
      await s.write();
      await expect(readFile(join(stateRoot, oldRel))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(stateRoot, nextRel), 'utf8')).toBe(newBytes);
      expect(recordReadable((await readStateFiles(s.root))!)).toEqual({ readable: true });
    },
  );

  it.each(['manual', 'ancestor-link'] as const)(
    'recognizes every journal path before undo, preserves %s divergence, and repeats an interrupted undo',
    async (divergence) => {
      const s = await fixture(null);
      let writes = 0;
      seam.afterWrite = async () => {
        if (++writes === 2) throw new Error('two first-record files landed');
      };
      await expect(s.write()).rejects.toThrow('two first-record files landed');
      seam.afterWrite = null;
      const state = join(s.root, '.haive-data/state');
      const format = await readFile(join(state, 'format.json'));
      const render = await readFile(join(state, 'project/render.json'));
      const box = await s.outbox();
      if (divergence === 'manual') await writeFile(join(state, 'format.json'), 'manual data');
      else {
        await rename(join(state, 'project'), join(s.root, 'kept-project'));
        await symlink(join(s.root, 'kept-project'), join(state, 'project'));
      }
      await expect(recoverProjectStateWrite(db!, s.repo.id, s.root)).rejects.toThrow();
      expect(
        await readFile(
          divergence === 'manual'
            ? join(state, 'project/render.json')
            : join(s.root, 'kept-project/render.json'),
        ),
      ).toEqual(render);
      expect(await readFile(join(state, 'format.json'))).toEqual(
        divergence === 'manual' ? Buffer.from('manual data') : format,
      );
      expect(await s.outbox()).toEqual(box);
      if (divergence === 'manual') await writeFile(join(state, 'format.json'), format);
      else {
        await rm(join(state, 'project'));
        await rename(join(s.root, 'kept-project'), join(state, 'project'));
      }
      seam.afterRemove = async () => {
        throw new Error('undo interrupted after removal');
      };
      await expect(recoverProjectStateWrite(db!, s.repo.id, s.root)).rejects.toThrow(
        'undo interrupted after removal',
      );
      seam.afterRemove = null;
      expect(await s.outbox()).toEqual(box);
      await recoverProjectStateWrite(db!, s.repo.id, s.root);
      expect((await s.outbox())!.writeIntent).toBeNull();
      expect((await readStateFiles(s.root))?.size ?? 0).toBe(0);
      expect(
        await db!
          .select()
          .from(schema.projectStateSync)
          .where(eq(schema.projectStateSync.repositoryId, s.repo.id)),
      ).toEqual([]);
      expect(
        (
          await db!.select().from(schema.repositories).where(eq(schema.repositories.id, s.repo.id))
        )[0]!.renderContext,
      ).toBeNull();
    },
  );

  it('recovery CAS preserves raw editor bytes installed after recognition', async () => {
    const s = await fixture();
    await s.write();
    seam.afterWrite = async () => {
      throw new Error('partial unicode render');
    };
    await expect(
      writeProjectStateColumn(db!, {
        repositoryId: s.repo.id,
        repoPath: s.root,
        column: { ...context('�'), rtkChoiceRecorded: false } as never,
        keepColumnOnFailure: true,
      }),
    ).rejects.toThrow('partial unicode render');
    seam.afterWrite = null;
    const path = join(s.root, '.haive-data/state/project/render.json');
    const planned = await readFile(path);
    const offset = planned.indexOf(Buffer.from('�'));
    expect(offset).toBeGreaterThan(0);
    const editor = Buffer.concat([
      planned.subarray(0, offset),
      Buffer.from([0xff]),
      planned.subarray(offset + 3),
    ]);
    expect(editor.toString('utf8')).toBe(planned.toString('utf8'));
    const before = await s.outbox();
    seam.beforeRewrite = async () => {
      seam.beforeRewrite = null;
      await writeFile(path, editor);
    };
    const failure = await recoverProjectStateWrite(db!, s.repo.id, s.root).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect.soft(failure).toMatchObject({ name: 'ProjectStateRecoveryHeldError' });
    expect.soft(await readFile(path)).toEqual(editor);
    expect.soft(await s.outbox()).toEqual(before);
  });

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

  const killFileOperation = async (
    s: Awaited<ReturnType<typeof fixture>>,
    action: 'write' | 'recover',
    boundary: 'park' | 'publish' | 'prepare' | 'restore',
    leaf: string,
    name = 'file crash target',
  ) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('./support/project-state-file-crash-child.ts', import.meta.url)),
      ],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: {
          ...process.env,
          T266_CRASH_REPOSITORY_ID: s.repo.id,
          T266_CRASH_REPO_PATH: s.root,
          T266_FILE_ACTION: action,
          T266_FILE_BOUNDARY: boundary,
          T266_FILE_LEAF: leaf,
          T266_FILE_NAME: name,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let error = '';
    child.stderr.on('data', (chunk) => {
      error = (error + chunk.toString()).slice(-2000);
    });
    const closed = new Promise<NodeJS.Signals | null>((resolve) =>
      child.once('close', (_code, signal) => resolve(signal)),
    );
    try {
      const phase = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`file crash boundary ${boundary} missing: ${error}`)),
          15000,
        );
        let output = '';
        child.stdout.on('data', (chunk) => {
          output += chunk.toString();
          const found = /T266_FILE_([A-Z_]+)/.exec(output);
          if (found) {
            clearTimeout(timer);
            resolve(found[1]!);
          }
        });
        child.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        void closed.then(() => {
          clearTimeout(timer);
          reject(new Error(`file crash child exited: ${error}`));
        });
      });
      child.kill('SIGKILL');
      expect(await closed).toBe('SIGKILL');
      return phase;
    } finally {
      child.kill('SIGKILL');
      await closed;
    }
  };
  it.each([
    'forward-create',
    'forward-rewrite',
    'forward-remove',
    'undo-create',
    'undo-rewrite-park',
    'undo-rewrite-publish',
    'undo-remove',
    'undo-restore-link',
  ] as const)(
    'replays actual SIGKILL during %s through the same prepared-image protocol',
    async (kind) => {
      const first = kind === 'forward-create' || kind === 'undo-remove';
      const s = await fixture(first ? null : context());
      const setting = kind === 'forward-remove' || kind === 'undo-create';
      if (setting)
        await db!
          .update(schema.repositories)
          .set({ rtkVersion: '1.0.0' })
          .where(eq(schema.repositories.id, s.repo.id));
      if (!first) await s.write();
      const before = await readStateFiles(s.root);
      const sync = await db!
        .select()
        .from(schema.projectStateSync)
        .where(eq(schema.projectStateSync.repositoryId, s.repo.id));
      if (setting)
        await db!
          .update(schema.repositories)
          .set({ rtkVersion: null })
          .where(eq(schema.repositories.id, s.repo.id));
      const undo = kind.startsWith('undo-');
      if (undo) {
        if (kind === 'undo-create')
          seam.afterRemove = async () => {
            throw new Error('forward remove completed');
          };
        else
          seam.afterWrite = async () => {
            throw new Error('forward image completed');
          };
        await expect(
          writeProjectStateColumn(db!, {
            repositoryId: s.repo.id,
            repoPath: s.root,
            column: {
              ...context(setting ? 'local' : 'file crash target'),
              rtkChoiceRecorded: false,
            } as never,
            keepColumnOnFailure: true,
          }),
        ).rejects.toThrow('completed');
        seam.afterRemove = null;
        seam.afterWrite = null;
      }
      const leaf = setting ? 'rtk-version.json' : first ? 'format.json' : 'render.json';
      const boundary =
        kind === 'forward-remove' || kind === 'undo-remove' || kind === 'undo-rewrite-park'
          ? 'park'
          : kind === 'undo-restore-link'
            ? 'restore'
            : 'publish';
      await killFileOperation(
        s,
        undo ? 'recover' : 'write',
        boundary,
        leaf,
        setting ? 'local' : 'file crash target',
      );
      expect((await s.outbox())!.writeIntent).toBeTruthy();
      await recoverProjectStateWrite(db!, s.repo.id, s.root);
      expect(await readStateFiles(s.root)).toEqual(before);
      expect((await s.outbox())!.writeIntent).toBeNull();
      expect(
        await db!
          .select()
          .from(schema.projectStateSync)
          .where(eq(schema.projectStateSync.repositoryId, s.repo.id)),
      ).toEqual(sync);
      const column = (
        await db!.select().from(schema.repositories).where(eq(schema.repositories.id, s.repo.id))
      )[0]!.renderContext;
      if (first) expect(column).toBeNull();
      else expect(column).toMatchObject(context());
    },
    30000,
  );
  it('a kill during private image preparation publishes no record or intent and retry succeeds', async () => {
    const s = await fixture(null);
    expect(await killFileOperation(s, 'write', 'prepare', 'format.json')).toBe('PREPARE_PARTIAL');
    expect(await readStateFiles(s.root)).toBeNull();
    expect(await s.outbox()).toBeUndefined();
    expect(
      await db!
        .select()
        .from(schema.projectStateSync)
        .where(eq(schema.projectStateSync.repositoryId, s.repo.id)),
    ).toEqual([]);
    execFileSync('git', ['init', '-q'], { cwd: s.root });
    expect(
      execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', '.haive-data'], {
        cwd: s.root,
        encoding: 'utf8',
      }).trim(),
    ).toBe('');
    await s.write();
    expect((await s.render()).projectInfo.name).toBe('local');
    expect((await s.outbox())!.writeIntent).toBeNull();
  }, 30000);

  it('recovers an actual SIGKILL after the foreground render is parked', async () => {
    const s = await fixture();
    await s.write();
    const before = await s.render();
    const sync = await db!
      .select()
      .from(schema.projectStateSync)
      .where(eq(schema.projectStateSync.repositoryId, s.repo.id));
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('./support/project-state-file-crash-child.ts', import.meta.url)),
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
    const closed = new Promise<NodeJS.Signals | null>((resolve) =>
      child.once('close', (_code, signal) => resolve(signal)),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`render park boundary missing: ${error}`)),
          15000,
        );
        let output = '';
        child.stdout.on('data', (chunk) => {
          output += chunk.toString();
          if (output.includes('T266_RENDER_PARKED')) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        void closed.then(() => {
          clearTimeout(timer);
          reject(new Error(`render child exited before park: ${error}`));
        });
      });
      await expect(
        readFile(join(s.root, '.haive-data/state/project/render.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      child.kill('SIGKILL');
      expect(await closed).toBe('SIGKILL');
      expect((await s.outbox())!.writeIntent).toBeTruthy();
      await recoverProjectStateWrite(db!, s.repo.id, s.root);
      expect(await s.render()).toEqual(before);
      expect((await s.outbox())!.writeIntent).toBeNull();
      expect(
        await db!
          .select()
          .from(schema.projectStateSync)
          .where(eq(schema.projectStateSync.repositoryId, s.repo.id)),
      ).toEqual(sync);
    } finally {
      child.kill('SIGKILL');
      await closed;
    }
  }, 30000);
  it('foreground rewrite refuses an 8 MiB editor file before allocating it', async () => {
    const s = await fixture();
    await s.write();
    const editor = Buffer.alloc(8 * PROJECT_STATE_LIMITS.maxFileBytes, 120);
    const path = join(s.root, '.haive-data/state/project/render.json');
    let allocations = 0;
    let spy: { mockRestore(): void } | undefined;
    seam.beforeRewrite = async () => {
      seam.beforeRewrite = null;
      await writeFile(path, editor);
      const original = Buffer.allocUnsafe;
      spy = vi.spyOn(Buffer, 'allocUnsafe').mockImplementation((size: number) => {
        if (size > PROJECT_STATE_LIMITS.maxFileBytes) allocations++;
        return original(size);
      });
    };
    try {
      await expect(s.write('foreground target')).rejects.toThrow('settings changed');
    } finally {
      spy?.mockRestore();
    }
    expect.soft(allocations).toBe(0);
    expect(await readFile(path)).toEqual(editor);
    expect((await s.outbox())!.writeIntent).toBeTruthy();
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
