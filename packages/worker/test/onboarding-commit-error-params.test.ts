import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { boundQueryError, logger, safeErrorForTransport } from '@haive/shared/logger';
import type { StepContext, StepDefinition } from '../src/step-engine/step-definition.js';
import { advanceStep } from '../src/step-engine/step-runner.js';
import { postOnboardingStep } from '../src/step-engine/steps/onboarding/12-post-onboarding.js';
import { upgradeCommitStep } from '../src/step-engine/steps/onboarding-upgrade/03-upgrade-commit.js';

const run = promisify(execFile);
const USER = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000b1';
const STEP = '00000000-0000-4000-8000-0000000000c1';
// Identity SELECTs bind IDs, not passwords. This synthetic value proves the boundary
// suppresses arbitrary bound values without claiming a credential leak was observed.
const boundValue = 'IDENTITY_BOUND_VALUE_340';
const query = 'select git_name, git_email from users where id = $1';
const lines: string[] = [];
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'haive-onboarding-commit-error-'));
  await run('git', ['-C', root, 'init', '-q']);
  await run('git', ['-C', root, 'config', 'user.name', 'Fixture']);
  await run('git', ['-C', root, 'config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(root, 'README.md'), 'seed\n');
  await run('git', ['-C', root, 'add', 'README.md']);
  await run('git', ['-C', root, 'commit', '-qm', 'seed']);
  await writeFile(join(root, 'AGENTS.md'), '# Generated rules\n');
  lines.length = 0;
  const key = Object.getOwnPropertySymbols(logger).find(
    (key) => key.description === 'pino.stream',
  )!;
  const stream = (logger as unknown as Record<symbol, { write: (line: string) => void }>)[key]!;
  vi.spyOn(stream, 'write').mockImplementation((line) => {
    lines.push(line);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

const cases = [
  [postOnboardingStep, 'Staging or committing the generated files failed: '],
  [upgradeCommitStep, 'Staging or committing the upgrade changes failed: '],
] as const;

function setup(step: StepDefinition) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    users: schema.users,
    repositories: schema.repositories,
    onboardingArtifacts: schema.onboardingArtifacts,
    cliProviders: schema.cliProviders,
    taskEvents: schema.taskEvents,
  });
  fake.insert(schema.taskSteps, {
    taskId: TASK,
    stepId: '02-upgrade-apply',
    stepIndex: 2,
    title: 'Apply',
    status: 'done',
    round: 0,
    output: { writtenPaths: ['AGENTS.md'] },
  });
  fake.insert(schema.taskSteps, {
    id: STEP,
    taskId: TASK,
    stepId: step.metadata.id,
    stepIndex: step.metadata.index,
    title: step.metadata.title,
    status: 'running',
    round: 0,
    runSeq: 0,
    detectOutput: { hasGit: true },
    formSchema: { title: 'Commit', fields: [] },
    formValues: { commit: true },
  });
  const ctx = {
    db: fake.db,
    repoPath: root,
    taskId: TASK,
    userId: USER,
    taskStepId: STEP,
    logger: logger.child({ module: 'onboarding-commit-control' }),
    throwIfCancelled: () => {},
  } as unknown as StepContext;
  return { fake, ctx };
}

for (const [step, prefix] of cases) {
  it(`${step.metadata.id} forwards safe identity failure with its original cause`, async () => {
    const { fake, ctx } = setup(step);
    const error = new DrizzleQueryError(
      query,
      [boundValue],
      Object.assign(new Error(boundValue), { code: '08006' }),
    );
    // Real resolveGitEnv reaches the narrow user SELECT after the task lookup.
    const lookup = vi.spyOn(fake.db.query.users, 'findFirst').mockRejectedValue(error);
    const caught: unknown = await step
      .apply(ctx, { detected: { hasGit: true }, formValues: { commit: true } } as never)
      .catch((err: unknown) => err);
    expect(lookup).toHaveBeenCalledOnce();
    expect
      .soft(caught)
      .toMatchObject({ message: `${prefix}Database operation failed`, cause: error });
    expect.soft(boundQueryError(caught)).toBe(error);
    const transported = safeErrorForTransport(caught, { name: 'advance-step', id: TASK });
    expect.soft(transported).toMatchObject({ message: 'Database operation failed (08006)' });
    const transportLog = lines
      .map((line) => JSON.parse(line))
      .find((line) => line.msg === 'database job failed');
    expect.soft(transportLog?.err).toMatchObject({ type: 'Error', code: '08006', query });
    expect.soft(JSON.stringify([lines, transported])).not.toContain(boundValue);
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('# Generated rules\n');
    expect((await run('git', ['-C', root, 'log', '--format=%s'])).stdout.trim()).toBe('seed');
  });

  it.each([true, false])(
    `${step.metadata.id} runner persists safe failure and retains diagnostics (bound: %s)`,
    async (bound) => {
      const { fake } = setup(step);
      if (bound) {
        vi.spyOn(fake.db.query.users, 'findFirst').mockRejectedValue(
          new DrizzleQueryError(
            query,
            [boundValue],
            Object.assign(new Error(boundValue), { code: '08006' }),
          ),
        );
      } else {
        // An actual Git failure after successful identity resolution: an open merge
        // is refused by the real private-index committer, with exact diagnostic text.
        await writeFile(
          join(root, '.git', 'MERGE_HEAD'),
          (await run('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout,
        );
      }
      const result = await advanceStep({
        db: fake.db as unknown as Database,
        taskId: TASK,
        userId: USER,
        repoPath: root,
        workspacePath: root,
        cliProviderId: null,
        providers: [],
        stepDef: step,
        runSeq: 0,
        moduleDeactivation: null,
      });
      expect(result.status).toBe('failed');
      const row = fake.rows(schema.taskSteps).find((row) => row.id === STEP)!;
      expect(row.status).toBe('failed');
      const runnerLog = lines
        .map((line) => JSON.parse(line))
        .find((line) => line.msg === 'step runner failed');
      if (bound) {
        expect.soft(row.errorMessage).toBe('Database operation failed');
        expect.soft(runnerLog?.err).toMatchObject({ type: 'Error', code: '08006', query });
        expect.soft(JSON.stringify([result, lines, row])).not.toContain(boundValue);
      } else {
        expect(row.errorMessage).toBe(`${prefix}cannot do a partial commit during a merge`);
      }
    },
  );
}
