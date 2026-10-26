import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  schema,
  lockRepositoryTasksKey,
  REPOSITORY_TASKS_LOCK_TIMEOUT_MS,
  isLockNotAvailable,
  type Database,
} from '@haive/database';
import { emptyProjectState, portableRender, renderProjectState } from '@haive/shared/project-state';
import { markProjectStateDirty } from '@haive/shared/project-state-outbox';
import { seedRepositoryCliTargets } from '../src/project-state/cli-targets-backfill.js';
import { refreshProjectState } from '../src/project-state/refresh.js';
import { syncProjectStateFromCheckout } from '../src/project-state/sync.js';
import {
  buildUpgradePlan,
  upgradePlanStep,
} from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import { upgradeApplyStep } from '../src/step-engine/steps/onboarding-upgrade/02-upgrade-apply.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

// No ambient DATABASE_URL fallback: this control owns users and checkouts only in its scratch DB.
const url = process.env.T118_DATABASE_URL;
if (
  url &&
  (!/^\/(?:codex|test)_t118_[a-z0-9_]+$/.test(new URL(url).pathname) ||
    ['', '5432', '6379'].includes(new URL(url).port))
)
  throw new Error('T118 deferred membership requires its assigned scratch PostgreSQL database');
const db = url ? createDatabase(url) : null;
const users: string[] = [];
const dirs: string[] = [];
const git = (root: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const agentTargets = [{ dir: '.claude/agents', format: 'markdown' as const, supportsLsp: false }];
const legacy = (names: string[] = ['claude-code']) => ({
  projectInfo: { name: 'deferred-legacy' },
  framework: null,
  acceptedAgentIds: [],
  customAgentSpecs: [],
  lspLanguages: [],
  agentTargets,
  enabledCliProviders: names.map((name) => ({
    name,
    rulesFile: name === 'amp' ? 'AGENTS.md' : 'CLAUDE.md',
    rulesFileMode: name === 'amp' ? ('native' as const) : ('import' as const),
  })),
});
type Column = ReturnType<typeof legacy> & {
  rtkChoiceRecorded: boolean;
  cliTargets?: string[];
  legacyAgentFallback?: boolean;
};

afterEach(async () => {
  for (const id of users.splice(0)) await db!.delete(schema.users).where(eq(schema.users.id, id));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
});

async function fixture(column: Column | null = { ...legacy(), rtkChoiceRecorded: false }) {
  const userId = randomUUID();
  users.push(userId);
  const root = await mkdtemp(join(tmpdir(), 't118-deferred-'));
  dirs.push(root);
  await db!.insert(schema.users).values({
    id: userId,
    emailEncrypted: 't118-deferred',
    emailBlindIndex: userId,
    passwordHash: 'fixture',
  });
  const [repo] = await db!
    .insert(schema.repositories)
    .values({
      userId,
      name: 't118-deferred',
      source: 'git_https',
      storagePath: root,
      renderContext: column,
      rtkEnabled: false,
    })
    .returning();
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'T118 fixture');
  git(root, 'config', 'user.email', 't118@example.invalid');
  await writeFile(join(root, 'README.md'), 'fixture\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-qm', 'initial');
  const row = async () =>
    (await db!.select().from(schema.repositories).where(eq(schema.repositories.id, repo!.id)))[0]!;
  const outbox = async () =>
    (
      await db!
        .select()
        .from(schema.projectStateOutbox)
        .where(eq(schema.projectStateOutbox.repositoryId, repo!.id))
    )[0];
  const base = async () =>
    (
      await db!
        .select()
        .from(schema.projectStateSync)
        .where(eq(schema.projectStateSync.repositoryId, repo!.id))
    )[0]?.baseSnapshot;
  const sync = () => syncProjectStateFromCheckout(db!, { repositoryId: repo!.id, repoPath: root });
  const refresh = () => refreshProjectState(db!, repo!.id);
  const cliBytes = (name: string) =>
    readFile(join(root, `.haive-data/state/cli/${name}.json`), 'utf8').catch(() => null);
  return { userId, repo: repo!, root, row, outbox, base, sync, refresh, cliBytes };
}

describe.skipIf(!url)('deferred legacy membership PostgreSQL', () => {
  it('refuses a mixed-provenance legacy 02 before writes, then a real replan and exact retry converge', async () => {
    const original = { ...legacy(), rtkChoiceRecorded: false };
    const s = await fixture(original);
    const [task] = await db!
      .insert(schema.tasks)
      .values({
        userId: s.userId,
        repositoryId: s.repo.id,
        type: 'onboarding_upgrade',
        title: 'mixed legacy provenance',
        status: 'waiting_user',
      })
      .returning();
    const [step] = await db!
      .insert(schema.taskSteps)
      .values({
        taskId: task!.id,
        stepId: '02-upgrade-apply',
        stepIndex: 2,
        title: 'Apply',
        status: 'waiting_form',
      })
      .returning();
    const ctx = {
      db: db!,
      userId: s.userId,
      taskId: task!.id,
      taskStepId: step!.id,
      repoPath: s.root,
      workspacePath: s.root,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      throwIfCancelled() {},
    } as unknown as StepContext;
    const planned = await buildUpgradePlan(ctx);
    const [planStep] = await db!
      .insert(schema.taskSteps)
      .values({
        taskId: task!.id,
        stepId: '01-upgrade-plan',
        stepIndex: 1,
        title: 'Legacy plan',
        status: 'done',
        output: {
          ...planned,
          renderCtxSnapshot: legacy(),
          renderContextColumn: original,
          backfilledRows: 0,
        },
      })
      .returning();
    await db!.insert(schema.onboardingArtifacts).values({
      userId: s.userId,
      repositoryId: s.repo.id,
      taskId: task!.id,
      diskPath: '.codex/agents/code-reviewer.toml',
      templateId: 'agent.code-reviewer',
      templateKind: 'agent',
      templateSchemaVersion: 1,
      templateContentHash: '0'.repeat(64),
      writtenHash: '0'.repeat(64),
      source: 'onboarding',
      sourceStepId: '12-post-onboarding',
      formValuesSnapshot: { ...legacy(), cliTargets: ['codex', 'future-cli'] },
    });
    await seedRepositoryCliTargets(db!);
    expect((await s.row()).renderContext).toEqual(original);
    const persisted = await upgradeApplyStep.detect!(ctx);
    let restoredTimeout = 0;
    let blockedPhase = false;
    const guardedDb = new Proxy(db!, {
      get(target, prop) {
        if (prop !== 'transaction') return Reflect.get(target, prop);
        return (fn: Parameters<Database['transaction']>[0]) =>
          target.transaction(async (tx) => {
            await tx.execute(
              sql`select set_config('lock_timeout', ${blockedPhase ? '0' : '7s'}, true)`,
            );
            if (blockedPhase)
              await tx.execute(
                sql`select set_config('statement_timeout', ${`${REPOSITORY_TASKS_LOCK_TIMEOUT_MS + 10_000}ms`}, true)`,
              );
            try {
              return await fn(tx);
            } catch (err) {
              // A PostgreSQL lock timeout aborts the transaction; an ordinary plan refusal does
              // not. The latter must restore the caller's setting before its remaining work.
              if (!isLockNotAvailable(err)) {
                const [setting] = await tx.execute<{ value: string }>(
                  sql`select current_setting('lock_timeout') as value`,
                );
                expect(setting!.value).toBe('7s');
                restoredTimeout++;
              }
              throw err;
            }
          });
      },
    });
    const apply = () =>
      upgradeApplyStep.apply(
        { ...ctx, db: guardedDb },
        {
          detected: persisted,
          formValues: {},
          iteration: 0,
          previousIterations: [],
        },
      );
    const capture = async () => {
      const files: Record<string, string> = {};
      const walk = async (dir = ''): Promise<void> => {
        for (const entry of await readdir(join(s.root, dir), { withFileTypes: true })) {
          if (entry.name === '.git') continue;
          const rel = dir ? `${dir}/${entry.name}` : entry.name;
          files[rel] = entry.isDirectory()
            ? 'directory'
            : await readFile(join(s.root, rel), 'utf8');
          if (entry.isDirectory()) await walk(rel);
        }
      };
      await walk();
      return {
        files,
        repo: await s.row(),
        base: await s.base(),
        outbox: await s.outbox(),
        ledger: await db!
          .select()
          .from(schema.onboardingArtifacts)
          .where(eq(schema.onboardingArtifacts.repositoryId, s.repo.id)),
        head: git(s.root, 'rev-parse', 'HEAD'),
        index: git(s.root, 'status', '--porcelain'),
      };
    };
    const before = await capture();
    blockedPhase = true;
    await db!.transaction(async (holder) => {
      await lockRepositoryTasksKey(holder, s.repo.id);
      const started = Date.now();
      await expect(apply()).rejects.toMatchObject({ cause: { code: '55P03' } });
      expect(Date.now() - started).toBeGreaterThanOrEqual(REPOSITORY_TASKS_LOCK_TIMEOUT_MS - 100);
      expect(Date.now() - started).toBeLessThan(REPOSITORY_TASKS_LOCK_TIMEOUT_MS + 10_000);
    });
    blockedPhase = false;
    expect(await capture()).toEqual(before);
    await expect(apply()).rejects.toThrow('plan no longer holds');
    expect(restoredTimeout).toBe(1);
    expect(await capture()).toEqual(before);
    const detected = await upgradePlanStep.detect!(ctx);
    const replanned = await upgradePlanStep.apply(ctx, {
      detected,
      formValues: { addCliTargets: [] },
      iteration: 0,
      previousIterations: [],
    });
    expect(replanned.renderCtxSnapshot.cliTargets).toEqual(['codex', 'future-cli']);
    await db!
      .update(schema.taskSteps)
      .set({ output: replanned })
      .where(eq(schema.taskSteps.id, planStep!.id));
    const resolved = await upgradeApplyStep.detect!(ctx);
    const applyNew = () =>
      upgradeApplyStep.apply(ctx, {
        detected: resolved,
        formValues: {},
        iteration: 0,
        previousIterations: [],
      });
    expect((await applyNew()).recordWrite).toBe('written');
    expect((await s.row()).renderContext).toMatchObject({ cliTargets: ['codex', 'future-cli'] });
    expect((await applyNew()).recordWrite).toBe('written');
  }, 60_000);

  it('completes a held persisted legacy 02 plan and carries its recorded member to B without another boot', async () => {
    const original = { ...legacy(), rtkChoiceRecorded: false };
    const s = await fixture(original);
    const [task] = await db!
      .insert(schema.tasks)
      .values({
        userId: s.userId,
        repositoryId: s.repo.id,
        type: 'onboarding_upgrade',
        title: 'persisted before T118',
        status: 'waiting_user',
      })
      .returning();
    const [step] = await db!
      .insert(schema.taskSteps)
      .values({
        taskId: task!.id,
        stepId: '02-upgrade-apply',
        stepIndex: 2,
        title: 'Apply upgrade',
        status: 'waiting_form',
      })
      .returning();
    const ctx = {
      db: db!,
      userId: s.userId,
      taskId: task!.id,
      taskStepId: step!.id,
      repoPath: s.root,
      workspacePath: s.root,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      throwIfCancelled() {},
    } as unknown as StepContext;
    const planned = await buildUpgradePlan(ctx);
    // The persisted pre-release snapshot intentionally lacks both new fields, regardless of what
    // a future 01 produces. This exercises the old caller, not just a new plan's completion.
    await db!.insert(schema.taskSteps).values({
      taskId: task!.id,
      stepId: '01-upgrade-plan',
      stepIndex: 1,
      title: 'Plan upgrade',
      status: 'done',
      output: {
        ...planned,
        renderCtxSnapshot: legacy(),
        renderContextColumn: original,
        backfilledRows: 0,
      },
    });
    const beforeBoot = await s.outbox();
    await seedRepositoryCliTargets(db!);
    expect((await s.row()).renderContext).toEqual(original);
    expect(await s.outbox()).toEqual(beforeBoot);
    const persisted = await upgradeApplyStep.detect!(ctx);
    expect(persisted.renderCtxSnapshot.cliTargets).toBeUndefined();
    const applied = await upgradeApplyStep.apply(ctx, {
      detected: persisted,
      formValues: {},
      iteration: 0,
      previousIterations: [],
    });
    expect(applied.recordWrite).toBe('written');
    expect.soft(applied.writtenPaths).toContain('.haive-data/state/cli/claude-code.json');
    expect.soft(await s.cliBytes('claude-code')).not.toBeNull();
    expect.soft((await s.row()).renderContext).toMatchObject({ cliTargets: ['claude-code'] });
    expect.soft(await s.base()).toMatchObject({ cli: ['claude-code'] });
    // Its exact own-result proof admits an ordinary retry; it never reads a new column into the
    // allowlist, so a later explicit removal below must still invalidate this persisted plan.
    const retry = await upgradeApplyStep.apply(ctx, {
      detected: persisted,
      formValues: {},
      iteration: 0,
      previousIterations: [],
    });
    expect(retry.recordWrite).toBe('written');
    await db!
      .update(schema.tasks)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(schema.tasks.id, task!.id));
    await s.sync();
    await markProjectStateDirty(db!, s.repo.id);
    expect(await s.refresh()).toBe(true);
    expect.soft((await s.row()).renderContext).toMatchObject({ cliTargets: ['claude-code'] });
    expect.soft(await s.cliBytes('claude-code')).not.toBeNull();
    git(s.root, 'add', '.haive-data');
    git(s.root, 'commit', '-qm', 'completed legacy plan');
    const b = await fixture(null);
    await rm(b.root, { recursive: true, force: true });
    git(s.root, 'clone', '-q', '--no-local', s.root, b.root);
    expect((await b.sync()).outcome).toBe('applied');
    expect.soft((await b.row()).renderContext).toMatchObject({ cliTargets: ['claude-code'] });
    expect.soft(await b.base()).toMatchObject({ cli: ['claude-code'] });
    const after = (await s.row()).renderContext as Column;
    await db!
      .update(schema.repositories)
      .set({ renderContext: { ...after, cliTargets: [] } })
      .where(eq(schema.repositories.id, s.repo.id));
    await expect(
      upgradeApplyStep.apply(ctx, {
        detected: persisted,
        formValues: {},
        iteration: 0,
        previousIterations: [],
      }),
    ).rejects.toThrow('plan no longer holds');
  }, 60_000);

  it.each([
    { label: 'Claude', names: ['claude-code'], fallback: false },
    { label: 'Amp', names: ['amp'], fallback: true },
    { label: 'zero providers', names: [], fallback: true },
  ])(
    'sync promotes $label from its non-NULL legacy column, dirties missing units and converges without boot',
    async ({ names, fallback }) => {
      const original = { ...legacy(names), rtkChoiceRecorded: false };
      const s = await fixture(original);
      // No artifacts and no CLI unit or previous CLI base: recorded column metadata is the sole
      // source. Local provider configuration is absent, so it cannot invent these names.
      for (const [rel, bytes] of renderProjectState({
        ...emptyProjectState(),
        render: portableRender(original),
      })) {
        const path = join(s.root, '.haive-data/state', rel);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes);
      }
      await s.sync();
      expect.soft((await s.row()).renderContext).toEqual({
        ...original,
        cliTargets: names,
        ...(fallback ? { legacyAgentFallback: true } : {}),
      });
      expect((await s.row()).rtkEnabled).toBe(false);
      expect((await s.row()).rtkChoiceMadeAt).toBeNull();
      expect
        .soft(((await s.row()).renderContext as Column).legacyAgentFallback === true)
        .toBe(fallback);
      const dirty = await s.outbox();
      if (names.length)
        expect.soft((dirty?.revision ?? 0) > (dirty?.writtenRevision ?? 0)).toBe(true);
      await s.sync();
      expect((await s.outbox())?.revision).toBe(dirty?.revision);
      expect(await s.refresh()).toBe(true);
      expect.soft((await s.row()).renderContext).toMatchObject({ cliTargets: names });
      expect.soft(await s.base()).toMatchObject({ cli: names });
      for (const name of names) expect.soft(await s.cliBytes(name)).not.toBeNull();
      const clean = await s.outbox();
      expect(clean?.writtenRevision).toBe(clean?.revision);
      await s.sync();
      expect((await s.outbox())?.revision).toBe(clean?.revision);
    },
    60_000,
  );
});
