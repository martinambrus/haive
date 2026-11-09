import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { ensureDirNoFollow, removeNoFollow, writeFileNoFollow } from '@haive/shared/fs-safe';
import { afterEach, expect, it, vi } from 'vitest';
import { git } from '../../../../test/support/nested-repo.js';
import type { StepContext } from '../../step-definition.js';
import { postOnboardingStep } from '../onboarding/12-post-onboarding.js';
import { upgradeCommitStep } from '../onboarding-upgrade/03-upgrade-commit.js';

vi.mock('../onboarding/_helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../onboarding/_helpers.js')>()),
  loadPreviousStepOutput: async (_db: unknown, _task: string, step: string) =>
    step === '07-generate-files'
      ? { output: { wroteFiles: ['AGENTS.md'], skippedFiles: [] } }
      : step === '02-upgrade-apply'
        ? { output: { writtenPaths: ['AGENTS.md'] } }
        : null,
}));

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await removeNoFollow(tmpdir(), path.basename(dir), { recursive: true });
});

it.each(['12', '03'])(
  '%s stores its nested-clone warning once and keeps the output warning',
  async (site) => {
    const repo = await mkdtemp(path.join(tmpdir(), 'init-warning-'));
    dirs.push(repo);
    await writeFileNoFollow(repo, 'AGENTS.md', 'rules\n');
    await ensureDirNoFollow(repo, 'nested');
    await git(path.join(repo, 'nested'), ['init', '-q', '-b', 'main']);
    await writeFileNoFollow(repo, 'nested/inner.txt', 'inner\n');
    await git(path.join(repo, 'nested'), ['add', '-A']);
    await git(path.join(repo, 'nested'), ['commit', '-qm', 'nested']);
    const fake = createFakeDb({
      tasks: schema.tasks,
      taskSteps: schema.taskSteps,
      users: schema.users,
      repositories: schema.repositories,
      onboardingArtifacts: schema.onboardingArtifacts,
      cliProviders: schema.cliProviders,
      projectStateSync: schema.projectStateSync,
      projectStateOutbox: schema.projectStateOutbox,
      projectStateConflicts: schema.projectStateConflicts,
    });
    const id = '00000000-0000-4000-8000-000000000001';
    fake.insert(schema.taskSteps, { id, status: 'running' });
    const ctx = {
      db: fake.db,
      repoPath: repo,
      taskId: '00000000-0000-4000-8000-000000000002',
      taskStepId: id,
      userId: '00000000-0000-4000-8000-000000000003',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as StepContext;
    const step = site === '12' ? postOnboardingStep : upgradeCommitStep;
    const out = await step.apply(ctx, {
      detected: { hasGit: false } as never,
      formValues: { commit: true, initBranch: 'main' },
      iteration: 0,
      previousIterations: [],
    });
    expect(out.commitPerformed).toBe(true);
    expect(await git(repo, ['ls-tree', 'HEAD', 'nested'])).toMatch(/^160000 /);
    const warning = out.warnings.find((note) => note.includes('empty in task worktrees'));
    expect(warning).toContain('"nested"');
    const row = await fake.db.query.taskSteps.findFirst();
    expect(row?.warningMessage).toBe(warning);
  },
);
