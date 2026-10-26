import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { and, eq, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { sha256Hex } from '@haive/shared';
import {
  claimFileName,
  conflictSide,
  emptyProjectState,
  isImportMarker,
  isRenderContextSnapshot,
  recoverCliMembership,
  renderProjectState,
} from '@haive/shared/project-state';
import { resolveProjectStateConflict } from '../src/project-state/resolve.js';
import { loadMarkerContext } from '../src/project-state/import-marker.js';
import { seedRepositoryCliTargets } from '../src/project-state/cli-targets-backfill.js';
import { writeApplicableTemplateIds } from '../src/project-state/sync.js';
import { resolveRenderContext } from '../src/step-engine/_upgrade-render.js';
import { buildUpgradePlan } from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import { upgradeRollbackStep } from '../src/step-engine/steps/onboarding-upgrade/04-upgrade-rollback.js';
import { generateFilesStep } from '../src/step-engine/steps/onboarding/07-generate-files.js';
import { postOnboardingStep } from '../src/step-engine/steps/onboarding/12-post-onboarding.js';
import { resolveTaskSkillTargetDirs } from '../src/step-engine/steps/onboarding/_helpers.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

const portable = {
  projectInfo: { name: 'Historical project' },
  framework: 'drupal',
  acceptedAgentIds: [],
  customAgentSpecs: [],
  lspLanguages: [],
  rtkEnabled: true,
};
const snapshot = (cliTargets: string[]) => ({ ...portable, cliTargets });
const legacy = {
  ...portable,
  rtkChoiceRecorded: true,
  enabledCliProviders: [{ name: 'claude-code', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' }],
  agentTargets: [{ dir: '.claude/agents', format: 'markdown', supportsLsp: false }],
};
const url = process.env.T118_DATABASE_URL;
if (
  url &&
  (new URL(url).port !== '46537' || new URL(url).pathname !== '/codex_t118_cli_union_20261026')
)
  throw new Error('Use only the assigned T118 scratch database');
const pg = url ? createDatabase(url) : null;
const roots: string[] = [],
  users: string[] = [];
afterEach(async () => {
  for (const id of users.splice(0)) await pg!.delete(schema.users).where(eq(schema.users.id, id));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
afterAll(async () => {
  await pg?.$client.end({ timeout: 5 });
});

async function world(column: unknown = null, names = ['claude-code'], real = false) {
  const fake = createFakeDb(
    Object.fromEntries(Object.entries(schema).filter(([, v]) => is(v, PgTable))) as Record<
      string,
      PgTable
    >,
  );
  const db = real ? pg! : (fake.db as unknown as Database);
  const userId = randomUUID(),
    repositoryId = randomUUID(),
    taskId = randomUUID();
  const root = await mkdtemp(join(tmpdir(), 't118-onboarding-membership-'));
  roots.push(root);
  if (real) users.push(userId);
  await db.insert(schema.users).values({
    id: userId,
    emailEncrypted: 'synthetic',
    emailBlindIndex: userId,
    passwordHash: 'fixture',
    status: 'active',
  });
  await db.insert(schema.repositories).values({
    id: repositoryId,
    userId,
    name: 'Current project',
    source: 'upload',
    storagePath: root,
    status: 'ready',
    renderContext: column,
    rtkEnabled: false,
  });
  await db.insert(schema.tasks).values({
    id: taskId,
    repositoryId,
    userId,
    title: 'Onboard',
    type: 'onboarding',
    status: 'running',
  });
  const [provider] = await db
    .insert(schema.cliProviders)
    .values({
      userId,
      name: 'claude-code',
      label: 'Synthetic task CLI',
      enabled: names.includes('claude-code'),
      rulesContent: '',
    })
    .returning();
  await db.insert(schema.taskSteps).values({
    taskId,
    stepId: '06_5-agent-discovery',
    stepIndex: 6,
    title: 'Agents',
    status: 'done',
    output: { accepted: [{ id: 'code-reviewer' }] },
  });
  const noop = () => undefined;
  const ctx = {
    db,
    taskId,
    userId,
    cliProviderId: provider!.id,
    repoPath: root,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
  } as unknown as StepContext;
  const add = async (value: unknown, at = 1, overrides: Record<string, unknown> = {}) => {
    await db.insert(schema.onboardingArtifacts).values({
      userId,
      repositoryId,
      taskId,
      templateId: `agent.historical-${at}`,
      templateKind: 'agent',
      diskPath: `.codex/agents/historical-${at}.toml`,
      templateSchemaVersion: 1,
      templateContentHash: 'a'.repeat(64),
      writtenHash: 'a'.repeat(64),
      source: 'onboarding',
      sourceStepId: '07-generate-files',
      formValuesSnapshot: value as Record<string, unknown>,
      generatedAt: new Date(at),
      ...overrides,
    });
  };
  const detect = () => generateFilesStep.detect!(ctx);
  const pending = async (detected: unknown) => {
    await db.insert(schema.taskSteps).values({
      taskId,
      stepId: '07-generate-files',
      stepIndex: 7,
      title: 'Generate',
      status: 'done',
      detectOutput: detected as Record<string, unknown>,
    });
    return resolveTaskSkillTargetDirs(ctx, ['.claude/skills']);
  };
  return { db, ctx, repositoryId, userId, taskId, root, add, detect, pending };
}

describe('onboarding completes recorded membership before union', () => {
  it.each([null, legacy])(
    'retains strict snapshot names through 07 and pending09 with column %j',
    async (column) => {
      const s = await world(column);
      expect(isRenderContextSnapshot(snapshot(['codex', 'future-cli']))).toBe(true);
      await s.add(snapshot(['codex', 'future-cli']));
      const out = await s.detect();
      expect.soft(out.cliTargets).toEqual(['codex', 'future-cli', 'claude-code']);
      expect.soft(out.agentTargets.map((t) => t.dir)).toEqual(['.codex/agents', '.claude/agents']);
      expect.soft(await s.pending(out)).toEqual(['.agents/skills', '.claude/skills']);
      expect(out.renderContextColumn).toEqual(column);
      expect(out.rtkEnabled).toBe(false);
      expect(out.projectInfo.name).not.toBe('Historical project');
    },
  );

  it('keeps current explicit [] ahead of history, while adding the newly enabled local CLI', async () => {
    const s = await world({ ...legacy, cliTargets: [] });
    await s.add(snapshot(['codex', 'future-cli']));
    const out = await s.detect();
    expect(out.cliTargets).toEqual(['claude-code']);
    expect(out.agentTargets.map((t) => t.dir)).toEqual(['.claude/agents']);
    expect(await s.pending(out)).toEqual(['.claude/skills']);
  });

  it('skips malformed, membership-less, superseded and other-repository snapshots', async () => {
    const s = await world();
    await s.add(snapshot(['codex', 'future-cli']));
    await s.add(portable, 2);
    await s.add({ ...snapshot(['gemini']), futureField: true }, 3);
    await s.add(snapshot(['gemini']), 4, { supersededAt: new Date(5) });
    await s.add(snapshot(['gemini']), 6, { repositoryId: randomUUID() });
    expect((await s.detect()).cliTargets).toEqual(['codex', 'future-cli', 'claude-code']);
  });

  it('stops at historical explicit [] before legacy column metadata', async () => {
    const s = await world(legacy, []);
    await s.add(snapshot(['codex']));
    await s.add(snapshot([]), 2);
    const out = await s.detect();
    expect(out.cliTargets).toEqual([]);
    expect(out.agentTargets).toEqual([]);
    expect(await s.pending(out)).toEqual([]);
  });

  it('preserves actual zero-provider legacy fallback from history on unchanged membership', async () => {
    const s = await world(null, []);
    await s.add({ ...portable, enabledCliProviders: [], agentTargets: legacy.agentTargets });
    const out = await s.detect();
    expect(out.cliTargets).toEqual([]);
    expect(out.legacyAgentFallback).toBe(true);
    expect(out.agentTargets).toEqual(legacy.agentTargets);
    expect(await s.pending(out)).toEqual([]);
  });

  it('clears actual legacy fallback on a real membership addition', async () => {
    const s = await world();
    await s.add({ ...portable, enabledCliProviders: [], agentTargets: legacy.agentTargets });
    const out = await s.detect();
    expect(out.cliTargets).toEqual(['claude-code']);
    expect(out.legacyAgentFallback).toBeUndefined();
  });
});

describe.skipIf(!url)('onboarding recorded membership real07 through12', () => {
  it('persists the full union before new snapshots can hide it, preserving the original NULL fence', async () => {
    const s = await world(null, ['claude-code'], true);
    await s.add(snapshot(['codex', 'future-cli']));
    const detected = await s.detect();
    expect(detected.renderContextColumn).toBe(null);
    const pendingDirs = await s.pending(detected);
    const generated = await generateFilesStep.apply(s.ctx, {
      detected,
      formValues: { overwrite: false },
    } as never);
    await s.db
      .update(schema.taskSteps)
      .set({ output: generated })
      .where(eq(schema.taskSteps.taskId, s.taskId));
    const out = await postOnboardingStep.apply(s.ctx, {
      detected: {
        hasGit: false,
        hasOrigin: false,
        originUrl: null,
        credentials: [],
        boundCredentialId: null,
      },
      formValues: { commit: false },
    } as never);
    expect(out.recordWrite, out.warnings.join('\n')).toBe('written');
    const [repo] = await s.db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, s.repositoryId));
    const rows = await s.db
      .select()
      .from(schema.onboardingArtifacts)
      .where(eq(schema.onboardingArtifacts.repositoryId, s.repositoryId));
    const current = rows.filter((r) => r.diskPath !== '.codex/agents/historical-1.toml');
    expect(current.length).toBeGreaterThan(0);
    expect.soft(pendingDirs).toEqual(['.agents/skills', '.claude/skills']);
    expect
      .soft(repo!.renderContext)
      .toMatchObject({ cliTargets: ['codex', 'future-cli', 'claude-code'], rtkEnabled: false });
    for (const row of current)
      expect
        .soft(row.formValuesSnapshot)
        .toMatchObject({ cliTargets: ['codex', 'future-cli', 'claude-code'] });
    expect.soft(generated.wroteFiles).toContain('.codex/agents/code-reviewer.toml');
    expect
      .soft(
        await readFile(join(s.root, '.haive-data/state/cli/codex.json'), 'utf8')
          .then(JSON.parse)
          .catch(() => null),
      )
      .toEqual({ provider: 'codex' });
  });
});

describe('recorded membership completion siblings', () => {
  async function tree(root: string, rel = ''): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
      const next = join(rel, entry.name);
      if (entry.isDirectory()) Object.assign(result, await tree(root, next));
      else result[next] = (await readFile(join(root, next))).toString('base64');
    }
    return result;
  }
  async function undoOnly(column: unknown, matching = false, unknown = false) {
    const s = await world(column, [], true);
    const priorTask = randomUUID(),
      onboardingTask = randomUUID(),
      diskPath = 'docs/created-by-upgrade.md',
      body = 'owned upgrade file\n';
    await s.db
      .update(schema.tasks)
      .set({ type: 'onboarding_upgrade', metadata: { mode: 'rollback' } })
      .where(eq(schema.tasks.id, s.taskId));
    await s.db.insert(schema.tasks).values({
      id: priorTask,
      userId: s.userId,
      repositoryId: s.repositoryId,
      title: 'Completed upgrade',
      type: 'onboarding_upgrade',
      status: 'completed',
      completedAt: new Date(3),
    });
    await s.db.insert(schema.tasks).values({
      id: onboardingTask,
      userId: s.userId,
      repositoryId: s.repositoryId,
      title: 'Prior onboarding',
      type: 'onboarding',
      status: 'completed',
      completedAt: new Date(0),
    });
    await s.add(
      unknown ? null : snapshot(matching ? ['codex', 'future-cli'] : ['claude-code']),
      1,
      { taskId: onboardingTask },
    );
    await s.add(unknown ? null : snapshot(['codex', 'future-cli']), 2, {
      taskId: priorTask,
      source: 'upgrade',
      sourceStepId: '02-upgrade-apply',
      diskPath,
      writtenHash: sha256Hex(body),
      writtenContent: body,
    });
    await mkdir(join(s.root, 'docs'), { recursive: true });
    await writeFile(join(s.root, diskPath), body);
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: s.root, stdio: 'pipe', encoding: 'utf8' }).trim();
    git('init', '--initial-branch=main');
    git('-c', 'user.name=T118', '-c', 'user.email=t118@test.invalid', 'add', '.');
    git('-c', 'user.name=T118', '-c', 'user.email=t118@test.invalid', 'commit', '-m', 'fixture');
    const state = async () => ({
      repository: await s.db.select().from(schema.repositories),
      ledger: await s.db.select().from(schema.onboardingArtifacts),
      base: await s.db.select().from(schema.projectStateSync),
      outbox: await s.db.select().from(schema.projectStateOutbox),
      files: await tree(s.root),
      head: git('rev-parse', 'HEAD'),
      index: await readFile(join(s.root, '.git/index')),
    });
    const plan = await upgradeRollbackStep.detect!(s.ctx);
    expect(plan.targets).toEqual([]);
    expect(plan.newArtifactsToUndo).toHaveLength(1);
    const apply = (ctx = s.ctx, detected = plan) =>
      upgradeRollbackStep.apply(ctx, { detected, formValues: {} } as never);
    return { ...s, apply, state, diskPath };
  }
  it.skipIf(!url).each([null, legacy])(
    'refuses undo-only rollback before retiring the sole canonical proof, column %j',
    async (column) => {
      const s = await undoOnly(column);
      const before = await s.state();
      await expect(s.apply()).rejects.toThrow(/refresh|plan/i);
      expect(await s.state()).toEqual(before);
      await expect(s.apply()).rejects.toThrow(/refresh|plan/i);
      expect(await s.state()).toEqual(before);
      // The existing convergent backfill is allowed once the old holder ends; then a fresh real
      // rollback plan has durable explicit current authority, without a new foreground protocol.
      await s.db
        .update(schema.tasks)
        .set({ status: 'cancelled' })
        .where(eq(schema.tasks.id, s.taskId));
      await seedRepositoryCliTargets(s.db);
      const taskId = randomUUID();
      await s.db.insert(schema.tasks).values({
        id: taskId,
        userId: s.userId,
        repositoryId: s.repositoryId,
        title: 'Fresh rollback',
        type: 'onboarding_upgrade',
        status: 'running',
        metadata: { mode: 'rollback' },
      });
      const ctx = { ...s.ctx, taskId };
      const detected = await upgradeRollbackStep.detect!(ctx);
      expect((await s.apply(ctx, detected)).recordWrite).toBe('written');
      expect((await s.apply(ctx, detected)).recordWrite).toBe('written');
      const [repo] = await s.db.select().from(schema.repositories);
      expect((repo!.renderContext as Record<string, unknown>).cliTargets).toEqual([
        'codex',
        'future-cli',
      ]);
      expect(await readFile(join(s.root, s.diskPath)).catch(() => null)).toBe(null);
      expect((await s.state()).head).toBe(before.head);
    },
  );
  it.skipIf(!url)(
    'allows undo-only rollback with a matching surviving membership proof',
    async () => {
      const s = await undoOnly(legacy, true);
      expect((await s.apply()).recordWrite).toBe('written');
      expect((await s.apply()).recordWrite).toBe('written');
    },
  );
  it.skipIf(!url)(
    'keeps explicit current[] authority and genuinely unknown undo-only legacy behavior',
    async () => {
      const explicit = await undoOnly({ ...legacy, cliTargets: [] });
      expect((await explicit.apply()).recordWrite).toBe('written');
      expect(
        (await explicit.db.select().from(schema.repositories))[0]!.renderContext,
      ).toMatchObject({ cliTargets: [] });
      const unknown = await undoOnly(null, false, true);
      expect((await unknown.apply()).recordWrite).toBe('skipped');
    },
  );
  async function pausedFenced(recorded: string[]) {
    const s = await world(null);
    await s.add(snapshot(recorded));
    const current = await s.detect();
    const { cliTargets: _decision, legacyAgentFallback: _fallback, ...old } = current;
    const detected = {
      ...old,
      agentTargets: legacy.agentTargets,
      enabledCliProviders: legacy.enabledCliProviders,
      renderContextColumn: null,
    };
    await s.pending(detected);
    const generated = await generateFilesStep.apply(s.ctx, { detected, formValues: {} } as never);
    await s.db
      .update(schema.taskSteps)
      .set({ output: generated })
      .where(
        and(
          eq(schema.taskSteps.taskId, s.taskId),
          eq(schema.taskSteps.stepId, '07-generate-files'),
        ),
      );
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: s.root, stdio: 'pipe', encoding: 'utf8' }).trim();
    git('init', '--initial-branch=main');
    git('-c', 'user.name=T118', '-c', 'user.email=t118@test.invalid', 'add', '.');
    git('-c', 'user.name=T118', '-c', 'user.email=t118@test.invalid', 'commit', '-m', 'fixture');
    const apply = () =>
      postOnboardingStep.apply(s.ctx, {
        detected: {
          hasGit: true,
          hasOrigin: false,
          credentials: [],
          originUrl: null,
          boundCredentialId: null,
        },
        formValues: { commit: false },
      } as never);
    const state = async () => ({
      repository: await s.db.select().from(schema.repositories),
      ledger: await s.db.select().from(schema.onboardingArtifacts),
      base: await s.db.select().from(schema.projectStateSync),
      outbox: await s.db.select().from(schema.projectStateOutbox),
      files: await tree(s.root),
      head: git('rev-parse', 'HEAD'),
      index: await readFile(join(s.root, '.git/index')),
    });
    return { ...s, apply, state };
  }
  it('refuses an old07 rawNULL plan before publication on both attempts, then regenerated07 and12 retry succeed', async () => {
    const s = await pausedFenced(['codex', 'future-cli']);
    const before = await s.state();
    await expect(s.apply()).rejects.toThrow(/Retry generation/);
    expect(await s.state()).toEqual(before);
    await expect(s.apply()).rejects.toThrow(/Retry generation/);
    expect(await s.state()).toEqual(before);
    const detected = await s.detect();
    expect(detected.cliTargets).toEqual(['codex', 'future-cli', 'claude-code']);
    const generated = await generateFilesStep.apply(s.ctx, { detected, formValues: {} } as never);
    await s.db
      .update(schema.taskSteps)
      .set({ detectOutput: detected, output: generated })
      .where(
        and(
          eq(schema.taskSteps.taskId, s.taskId),
          eq(schema.taskSteps.stepId, '07-generate-files'),
        ),
      );
    expect((await s.apply()).recordWrite).toBe('written');
    const [first] = await s.db.select().from(schema.repositories);
    expect((await s.apply()).recordWrite).toBe('written');
    const [again] = await s.db.select().from(schema.repositories);
    expect(again!.renderContext).toEqual(first!.renderContext);
    expect((again!.renderContext as Record<string, unknown>).cliTargets).toEqual([
      'codex',
      'future-cli',
      'claude-code',
    ]);
    expect((await s.state()).head).toBe(before.head);
  });
  it('keeps matching old07 rawNULL retries transparent and refuses later removal or foreign columns', async () => {
    const s = await pausedFenced(['claude-code']);
    expect((await s.apply()).recordWrite).toBe('written');
    expect((await s.apply()).recordWrite).toBe('written');
    const [repo] = await s.db.select().from(schema.repositories);
    for (const foreign of [
      { ...(repo!.renderContext as Record<string, unknown>), cliTargets: [] },
      {
        ...(repo!.renderContext as Record<string, unknown>),
        projectInfo: { name: 'Foreign changed context' },
      },
    ]) {
      await s.db
        .update(schema.repositories)
        .set({ renderContext: foreign })
        .where(eq(schema.repositories.id, s.repositoryId));
      const before = await s.state();
      const refused = await s.apply().catch(() => null);
      if (refused) expect(refused.recordWrite).toBe('failed');
      expect(await s.state()).toEqual(before);
    }
  });

  async function pausedLegacy07(column: unknown, real = false, prior = true) {
    const s = await world(column, ['claude-code'], real);
    if (prior) await s.add(snapshot(['codex', 'future-cli']));
    const current = await s.detect();
    // An actual pre-feature persisted07 payload: no membership decision or raw-column fence was
    // recorded. Its rendered destinations/provider metadata describe this install's old07 output.
    const {
      cliTargets: _decision,
      renderContextColumn: _fence,
      legacyAgentFallback: _fallback,
      ...old
    } = current;
    const detected = {
      ...old,
      agentTargets: legacy.agentTargets,
      enabledCliProviders: legacy.enabledCliProviders,
    };
    await s.pending(detected);
    const generated = await generateFilesStep.apply(s.ctx, {
      detected,
      formValues: { overwrite: false },
    } as never);
    await s.db
      .update(schema.taskSteps)
      .set({ output: generated })
      .where(eq(schema.taskSteps.taskId, s.taskId));
    const out = await postOnboardingStep.apply(s.ctx, {
      detected: {
        hasGit: false,
        hasOrigin: false,
        originUrl: null,
        credentials: [],
        boundCredentialId: null,
      },
      formValues: { commit: false },
    } as never);
    expect(out.recordWrite, out.warnings.join('\n')).toBe('written');
    const [repo] = await s.db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, s.repositoryId));
    const expected = prior ? ['codex', 'future-cli'] : ['claude-code'];
    expect.soft((repo!.renderContext as Record<string, unknown>).cliTargets).toEqual(expected);
    const rows = await s.db
      .select()
      .from(schema.onboardingArtifacts)
      .where(eq(schema.onboardingArtifacts.repositoryId, s.repositoryId));
    const published = rows.filter((row) => row.diskPath !== '.codex/agents/historical-1.toml');
    expect(published.length).toBeGreaterThan(0);
    for (const row of published) {
      if (prior) expect.soft(row.formValuesSnapshot).toMatchObject({ cliTargets: expected });
      else expect(recoverCliMembership([row])?.cliTargets).toEqual(expected);
      expect(row.formValuesSnapshot).toMatchObject({
        projectInfo: detected.projectInfo,
        framework: detected.framework,
        rtkEnabled: detected.rtkEnabled,
      });
    }
    expect(published.map((row) => row.diskPath)).not.toContain('.codex/agents/code-reviewer.toml');
    expect(generated.wroteFiles).toContain('.claude/agents/code-reviewer.md');
    // Step12 does not generate a CLI's missing agent files while completing saved metadata.
    expect(await readFile(join(s.root, '.codex/agents/code-reviewer.toml')).catch(() => null)).toBe(
      null,
    );
  }
  it.each([null, legacy])(
    'preserves recorded membership when actual12 resumes old07 with no decision, column %j',
    async (column) => {
      await pausedLegacy07(column);
    },
  );
  it('retains recorded caller completion only when old07 current/history membership is genuinely unknown', async () => {
    await pausedLegacy07(null, false, false);
  });
  it.skipIf(!url)(
    'preserves recorded membership through realPG actual12 resuming old07 with no membership decision',
    async () => {
      await pausedLegacy07(null, true);
    },
  );

  it.each([
    { column: legacy, recorded: ['codex', 'future-cli'], expected: ['codex', 'future-cli'] },
    { column: null, recorded: ['codex', 'future-cli'], expected: ['codex', 'future-cli'] },
    { column: { ...legacy, cliTargets: [] }, recorded: ['codex', 'future-cli'], expected: [] },
    { column: null, recorded: null, expected: ['claude-code'] },
  ])(
    'captures membership before actual04 restores older snapshots: $column / $recorded',
    async ({ column, recorded, expected }) => {
      const s = await world(column, []);
      await s.db
        .update(schema.tasks)
        .set({ type: 'onboarding_upgrade' })
        .where(eq(schema.tasks.id, s.taskId));
      if (recorded) await s.add(snapshot(recorded));
      const body = 'prior owned guide\n',
        diskPath = 'docs/old-guide.md';
      const oldSnapshot = {
        ...snapshot(['claude-code']),
        agentTargets: legacy.agentTargets,
        enabledCliProviders: legacy.enabledCliProviders,
      };
      const out = await upgradeRollbackStep.apply(s.ctx, {
        detected: {
          repositoryId: s.repositoryId,
          rolledBackFromTaskId: randomUUID(),
          targets: [
            {
              diskPath,
              templateId: 'workflow-config',
              templateKind: 'workflow-config',
              templateSchemaVersion: 1,
              priorArtifactId: randomUUID(),
              upgradeArtifactId: null,
              removed: true,
              priorTemplateContentHash: sha256Hex(body),
              priorWrittenHash: sha256Hex(body),
              priorWrittenContent: body,
              priorFormValuesSnapshot: oldSnapshot,
            },
          ],
          newArtifactsToUndo: [],
          warnings: [],
        },
        formValues: {},
      } as never);
      expect(out.recordWrite, out.warnings.join('\n')).toBe('written');
      expect(await readFile(join(s.root, diskPath), 'utf8')).toBe(body);
      const [repo] = await s.db
        .select()
        .from(schema.repositories)
        .where(eq(schema.repositories.id, s.repositoryId));
      expect.soft((repo!.renderContext as Record<string, unknown>).cliTargets).toEqual(expected);
      const rows = await s.db
        .select()
        .from(schema.onboardingArtifacts)
        .where(eq(schema.onboardingArtifacts.repositoryId, s.repositoryId));
      const restored = rows.filter((row) => row.source === 'rollback');
      expect(restored).toHaveLength(1);
      expect.soft(restored[0]!.formValuesSnapshot).toMatchObject({ cliTargets: expected });
      expect.soft(recoverCliMembership(restored)?.cliTargets).toEqual(expected);
      expect(restored[0]!.formValuesSnapshot).toMatchObject({
        projectInfo: portable.projectInfo,
        framework: portable.framework,
        rtkEnabled: portable.rtkEnabled,
      });
    },
  );

  it('recovers a NULL marker context from the RTK-selected strict snapshot while completing newest membership', async () => {
    const s = await world(null);
    await s.add(snapshot(['claude-code']), 1);
    const { rtkEnabled: _choice, ...newer } = snapshot(['codex', 'future-cli']);
    await s.add({ ...newer, framework: 'generic', projectInfo: { name: 'Membership only' } }, 2);
    const marker = await s.db.transaction((tx) =>
      loadMarkerContext(tx, s.repositoryId, {
        userId: s.userId,
        renderContext: null,
        rtkChoiceMadeAt: null,
      }),
    );
    expect(marker.snapshot).toMatchObject({
      cliTargets: ['codex', 'future-cli'],
      framework: 'drupal',
      projectInfo: portable.projectInfo,
      rtkEnabled: true,
    });
    const [repo] = await s.db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, s.repositoryId));
    expect(repo!.renderContext).toBe(null);
  });

  it.each([null, { projectInfo: {}, cliTargets: ['codex'] }])(
    'keeps NULL marker context unknown without any decoder-valid snapshot, %j',
    async (value) => {
      const s = await world(null);
      if (value) await s.add(value);
      const marker = await s.db.transaction((tx) =>
        loadMarkerContext(tx, s.repositoryId, {
          userId: s.userId,
          renderContext: null,
          rtkChoiceMadeAt: null,
        }),
      );
      expect(marker.snapshot).toBe(null);
    },
  );

  it('preserves unknown membership in a valid recovered marker context without local-provider inference', async () => {
    const s = await world(null);
    await s.add(portable);
    const marker = await s.db.transaction((tx) =>
      loadMarkerContext(tx, s.repositoryId, {
        userId: s.userId,
        renderContext: null,
        rtkChoiceMadeAt: null,
      }),
    );
    expect(marker.snapshot).toEqual(portable);
    expect(marker.snapshot!.cliTargets).toBeUndefined();
    expect(marker.snapshot!.enabledCliProviders).toBeUndefined();
  });

  it.each([[[]], [['codex', 'future-cli']]])(
    'keeps direct history resolver/applicable targets consistent with actual01 for %j',
    async (names) => {
      const s = await world(null, []);
      await s.db
        .update(schema.tasks)
        .set({ status: 'completed', completedAt: new Date() })
        .where(eq(schema.tasks.id, s.taskId));
      await s.pending({
        ...portable,
        cliTargets: names,
        enabledCliProviders: legacy.enabledCliProviders,
        agentTargets: legacy.agentTargets,
      });
      // Applicable-set refresh intentionally needs a live claim; this pre-snapshot row supplies no
      // render context, so both consumers really resolve through the completed07 history.
      await s.add(null);
      const resolved = await resolveRenderContext(s.db, {
        repositoryId: s.repositoryId,
        userId: s.userId,
        liveRows: [],
        logger: s.ctx.logger,
      });
      const planned = await buildUpgradePlan(s.ctx);
      const expectedDirs = names.length ? ['.codex/agents'] : [];
      expect(planned.renderCtxSnapshot.agentTargets).toEqual(
        names.length ? [{ dir: '.codex/agents', format: 'toml', supportsLsp: false }] : [],
      );
      expect.soft(resolved!.renderCtx.agentTargets.map((t) => t.dir)).toEqual(expectedDirs);
      expect
        .soft(resolved!.renderCtx.enabledCliProviders.map((p) => p.name))
        .toEqual(names.length ? ['codex'] : []);
      await s.db.transaction((tx) =>
        writeApplicableTemplateIds(tx, { repositoryId: s.repositoryId, userId: s.userId }),
      );
      const [repo] = await s.db
        .select()
        .from(schema.repositories)
        .where(eq(schema.repositories.id, s.repositoryId));
      const plannedIds = [
        ...new Set(planned.entries.filter((e) => e.newContent !== null).map((e) => e.templateId)),
      ].sort();
      expect(repo!.applicableTemplateIds!.slice().sort()).toEqual(plannedIds);
      expect(repo!.renderContext).toBe(null);
    },
  );

  it('retains the genuinely unknown legacy history fallback without inferring local membership', async () => {
    const s = await world(null, []);
    await s.db
      .update(schema.tasks)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(schema.tasks.id, s.taskId));
    await s.pending(portable);
    const resolved = await resolveRenderContext(s.db, {
      repositoryId: s.repositoryId,
      userId: s.userId,
      liveRows: [],
      logger: s.ctx.logger,
    });
    expect(resolved!.renderCtx.cliTargets).toBeUndefined();
    expect(resolved!.renderCtx.agentTargets).toEqual(legacy.agentTargets);
  });

  it.each([legacy, null])(
    'captures the sole strict membership proof before actual take-theirs retires its row, column %j',
    async (column) => {
      const s = await world(column);
      if (column === null)
        await s.pending({
          ...portable,
          enabledCliProviders: legacy.enabledCliProviders,
          agentTargets: legacy.agentTargets,
        });
      await s.db
        .update(schema.tasks)
        .set({ status: 'completed' })
        .where(eq(schema.tasks.id, s.taskId));
      const diskPath = 'docs/guide.md';
      await s.add(snapshot(['codex', 'future-cli']), 1, {
        diskPath,
        templateId: 'workflow-config',
        templateKind: 'workflow-config',
      });
      const body = 'teammate guide\n';
      const claim = {
        path: diskPath,
        templateId: 'workflow-config',
        kind: 'workflow-config',
        schemaVersion: 1,
        templateHash: 'b'.repeat(64),
        writtenHash: sha256Hex(body),
        haiveVersion: '0.1.0',
      };
      const unit = claimFileName(diskPath),
        id = randomUUID();
      const claimBytes = renderProjectState({ ...emptyProjectState(), claims: [claim] }).get(unit)!;
      for (const [rel, bytes] of [
        [diskPath, body],
        [`.haive-data/state/${unit}`, claimBytes],
      ]) {
        await mkdir(dirname(join(s.root, rel!)), { recursive: true });
        await writeFile(join(s.root, rel!), bytes!);
      }
      await s.db.insert(schema.projectStateConflicts).values({
        id,
        repositoryId: s.repositoryId,
        unit,
        detectedAt: new Date(1),
        base: conflictSide({ ...claim, writtenHash: 'c'.repeat(64) }),
        local: conflictSide({ ...claim, writtenHash: 'a'.repeat(64) }),
        incoming: conflictSide(claim),
      });
      const payload = {
        repositoryId: s.repositoryId,
        userId: s.userId,
        conflictId: id,
        answer: 'take_theirs' as const,
      };
      expect(await resolveProjectStateConflict(s.db, payload)).toMatchObject({
        kind: 'resolved',
        written: [],
      });
      const rows = await s.db
        .select()
        .from(schema.onboardingArtifacts)
        .where(eq(schema.onboardingArtifacts.repositoryId, s.repositoryId));
      expect(rows.filter((r) => r.supersededAt !== null)).toHaveLength(1);
      const live = rows.filter((r) => r.supersededAt === null);
      expect(live).toHaveLength(1);
      expect(isImportMarker(live[0]!)).toBe(true);
      expect
        .soft(live[0]!.formValuesSnapshot)
        .toMatchObject({ cliTargets: ['codex', 'future-cli'] });
      expect.soft(recoverCliMembership(live)?.cliTargets).toEqual(['codex', 'future-cli']);
      const [retained] = await s.db
        .select()
        .from(schema.repositories)
        .where(eq(schema.repositories.id, s.repositoryId));
      expect(retained!.renderContext).toEqual(column);
      expect(await readFile(join(s.root, diskPath), 'utf8')).toBe(body);
      expect(await readFile(join(s.root, `.haive-data/state/${unit}`), 'utf8')).toBe(claimBytes);
      expect(await resolveProjectStateConflict(s.db, payload)).toMatchObject({
        kind: 'resolved',
        written: [],
      });
      expect(
        await s.db
          .select()
          .from(schema.onboardingArtifacts)
          .where(eq(schema.onboardingArtifacts.repositoryId, s.repositoryId)),
      ).toEqual(rows);
    },
  );

  it('writes an import marker snapshot with recovered membership rather than newer local-only metadata', async () => {
    const s = await world(legacy);
    await s.add(snapshot(['gemini', 'future-cli']));
    const marker = await s.db.transaction((tx) =>
      loadMarkerContext(tx, s.repositoryId, {
        userId: s.userId,
        renderContext: legacy,
        rtkChoiceMadeAt: null,
      }),
    );
    expect(marker.snapshot).toMatchObject({
      cliTargets: ['gemini', 'future-cli'],
      framework: 'drupal',
    });
    expect(marker.snapshot!.projectInfo).toEqual(portable.projectInfo);
    // A newly written marker must not replace older strict membership on the next completion.
    await s.add(marker.snapshot, 2);
    const rows = await s.db.select().from(schema.onboardingArtifacts);
    expect(recoverCliMembership(rows)?.cliTargets).toEqual(['gemini', 'future-cli']);
  });

  it('keeps explicit current [] in import markers ahead of strict snapshots', async () => {
    const s = await world({ ...legacy, cliTargets: [] });
    await s.add(snapshot(['gemini']));
    const marker = await s.db.transaction((tx) =>
      loadMarkerContext(tx, s.repositoryId, {
        userId: s.userId,
        renderContext: { ...legacy, cliTargets: [] },
        rtkChoiceMadeAt: null,
      }),
    );
    expect(marker.snapshot).toMatchObject({
      cliTargets: [],
      agentTargets: [],
      enabledCliProviders: [],
    });
  });

  it('boot completion clears stale fallback provenance when a strict explicit [] supersedes it', async () => {
    const column = {
      ...portable,
      enabledCliProviders: [],
      agentTargets: legacy.agentTargets,
      legacyAgentFallback: true,
      rtkChoiceRecorded: true,
    };
    const s = await world(column, []);
    await s.db
      .update(schema.tasks)
      .set({ status: 'completed' })
      .where(eq(schema.tasks.id, s.taskId));
    await s.add(snapshot([]));
    await seedRepositoryCliTargets(s.db);
    const [repo] = await s.db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, s.repositoryId));
    expect(repo!.renderContext).toMatchObject({
      cliTargets: [],
      framework: 'drupal',
      rtkChoiceRecorded: true,
    });
    expect((repo!.renderContext as Record<string, unknown>).legacyAgentFallback).toBeUndefined();
    const before = repo!.renderContext;
    await seedRepositoryCliTargets(s.db);
    const [again] = await s.db
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, s.repositoryId));
    expect(again!.renderContext).toEqual(before);
  });
});
