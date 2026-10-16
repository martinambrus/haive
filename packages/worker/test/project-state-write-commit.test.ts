import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { claimFileName } from '@haive/shared/project-state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { postOnboardingStep } from '../src/step-engine/steps/onboarding/12-post-onboarding.js';
import { REFERENCE_CONTEXT } from '../src/step-engine/template-manifest.js';

const generated = vi.hoisted(() => ({ detect: null as unknown }));
vi.mock('../src/step-engine/steps/onboarding/_helpers.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../src/step-engine/steps/onboarding/_helpers.js')>();
  return {
    ...original,
    loadPreviousStepOutput: (...args: Parameters<typeof original.loadPreviousStepOutput>) =>
      args[2] === '07-generate-files'
        ? Promise.resolve({
            detect: generated.detect,
            output: { wroteFiles: [], skippedFiles: [] },
            iterations: [],
          })
        : original.loadPreviousStepOutput(...args),
  };
});

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: dir, env: GIT_ENV });
  return stdout.toString();
}

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';
const OLD = '.claude/agents/zz-old.md';
const KEPT = '.claude/agents/zz-kept.md';
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const artifact = (diskPath: string) => ({
  userId: USER,
  repositoryId: REPO,
  taskId: null,
  diskPath,
  templateId: `agent.${path.basename(diskPath, '.md')}`,
  templateKind: 'agent',
  templateSchemaVersion: 1,
  templateContentHash: 'a'.repeat(64),
  writtenHash: 'b'.repeat(64),
  haiveVersion: '1.0.0',
  sourceStepId: '07-generate-files',
  source: 'onboarding',
  supersededAt: null,
});

describe('12-post-onboarding: a claim file a person deleted by hand', () => {
  it('leaves HEAD when its row was retired, as it does when the writer removed the file itself', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'state-commit-'));
    dirs.push(repo);
    await git(repo, ['init', '-q', '-b', 'main']);
    await git(repo, ['config', 'gc.auto', '0']);
    await writeFile(path.join(repo, 'README.md'), 'r\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', 'seed']);

    generated.detect = { ...(REFERENCE_CONTEXT as unknown as Record<string, unknown>) };
    const fake = createFakeDb({
      repositories: schema.repositories,
      projectStateSync: schema.projectStateSync,
      projectStateOutbox: schema.projectStateOutbox,
      projectStateConflicts: schema.projectStateConflicts,
      onboardingArtifacts: schema.onboardingArtifacts,
      customBundles: schema.customBundles,
      customBundleItems: schema.customBundleItems,
      tasks: schema.tasks,
      taskSteps: schema.taskSteps,
      cliProviders: schema.cliProviders,
      users: schema.users,
      repoCredentials: schema.repoCredentials,
      planMirrorState: schema.planMirrorState,
      planNodes: schema.planNodes,
    });
    fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'acme', source: 'blank' });
    fake.insert(schema.tasks, {
      id: TASK,
      userId: USER,
      repositoryId: REPO,
      type: 'onboarding',
      title: 't',
      status: 'running',
    });
    fake.insert(schema.onboardingArtifacts, artifact(KEPT));
    const old = fake.insert(schema.onboardingArtifacts, artifact(OLD));
    const ctx = {
      repoPath: repo,
      workspacePath: repo,
      userId: USER,
      taskId: TASK,
      taskStepId: 's1',
      logger,
      db: fake.db as unknown as Database,
    } as unknown as StepContext;
    const twelve = () =>
      postOnboardingStep.apply(ctx, {
        detected: { hasGit: true, currentBranch: 'main' } as never,
        formValues: { commit: true, commitMessage: 'chore: onboard' },
        iteration: 0,
        previousIterations: [],
      });
    const tracked = async (): Promise<string[]> =>
      (await git(repo, ['ls-tree', '-r', '--name-only', 'HEAD'])).split('\n').filter(Boolean);
    const oldFile = `.haive-data/state/${claimFileName(OLD)}`;

    const first = await twelve();
    expect(first.recordWrite, first.warnings.join('\n')).toBe('written');
    expect(await tracked()).toContain(oldFile);

    await rm(path.join(repo, oldFile));
    fake.patch(schema.onboardingArtifacts, old.id as string, { supersededAt: new Date() });
    await mkdir(path.join(repo, '.haive-data/state/artifacts'), { recursive: true });

    const second = await twelve();

    expect(await tracked()).not.toContain(oldFile);
    expect(await tracked()).toContain(`.haive-data/state/${claimFileName(KEPT)}`);
    expect(second.commitPerformed).toBe(true);
  });
});
