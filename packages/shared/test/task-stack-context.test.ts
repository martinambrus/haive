import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import { resolveTaskStackContext, stackProjectName } from '../src/global-kb/task-context.js';

const REPO_ID = 'c89e5865-bbe1-4235-a147-68437927437c';
const TASK_ID = '681f0f99-2d57-497e-b605-8b467b597d32';

const MIRROR_TOOLING = {
  schemaVersion: 1,
  // Exactly what a committed `.haive-data/tooling.json` carries: the infra keys
  // (ollamaUrl, ragConnectionString) are stripped as machine-specific.
  tooling: {
    ragMode: 'internal',
    ollamaMode: 'internal',
    embeddingModel: 'qwen3-embedding:4b',
  },
};

const MIRROR_ENV = {
  schemaVersion: 1,
  // `envDetectData` IS the raw `.data`, unlike a step row's `{ data }` wrapper.
  envDetectData: { project: { name: 'elmont-rs' }, stack: { framework: 'drupal' } },
  confirmedValues: { phpVersion: '7.4' },
};

/** Minimal relational stub. `steps` is keyed by taskId so the tiers stay distinguishable;
 *  a repo with no onboarding task simply has no entry for one. */
function fakeDb(opts: {
  repositoryId?: string | null;
  repo?: Record<string, unknown> | null;
  steps?: Record<string, Record<string, unknown>>;
  onboardingTaskId?: string | null;
}): Database {
  const stepRow = (taskId: string, stepId: string): unknown =>
    opts.steps?.[taskId]?.[stepId] ?? undefined;

  let tasksCall = 0;
  return {
    query: {
      tasks: {
        findFirst: async () => {
          tasksCall += 1;
          // First read resolves the task's repositoryId; the second looks up the
          // repo's newest onboarding task.
          if (tasksCall === 1) return { repositoryId: opts.repositoryId ?? REPO_ID };
          return opts.onboardingTaskId ? { id: opts.onboardingTaskId } : undefined;
        },
      },
      repositories: { findFirst: async () => opts.repo ?? undefined },
      taskSteps: {
        findFirst: async (args: { where?: unknown }) => {
          // The stub cannot read drizzle's condition tree, so tests pass the step rows
          // pre-keyed and we identify the step from the requested columns instead.
          const cols = (args as { columns?: Record<string, boolean> }).columns ?? {};
          const wantsDetect = Boolean(cols.detectOutput);
          const taskIds = Object.keys(opts.steps ?? {});
          for (const tid of taskIds) {
            const row = wantsDetect
              ? stepRow(tid, '01-env-detect')
              : (stepRow(tid, '04-tooling-infrastructure') ??
                stepRow(tid, '02-detection-confirmation'));
            if (row) return row;
          }
          return undefined;
        },
      },
    },
  } as unknown as Database;
}

describe('resolveTaskStackContext — repository mirror tier', () => {
  it('resolves tooling and project name from the mirror when no onboarding task exists', async () => {
    const db = fakeDb({
      repo: { onboardingTooling: MIRROR_TOOLING, onboardingEnvironment: MIRROR_ENV },
      onboardingTaskId: null,
    });

    const ctx = await resolveTaskStackContext(db, TASK_ID);

    expect(ctx.tooling?.ragMode).toBe('internal');
    // The assertion that actually catches the bug: a wrapper/unwrap mistake here
    // silently yields 'default', which names a REAL (empty) per-project database and
    // reproduces the exact "index not built yet" symptom this fix removes.
    expect(stackProjectName(ctx)).toBe('elmont-rs');
    expect(ctx.confirmed).toEqual({ phpVersion: '7.4' });
  });

  it('carries the mirror env through to a non-empty facet set', async () => {
    const db = fakeDb({
      repo: { onboardingTooling: MIRROR_TOOLING, onboardingEnvironment: MIRROR_ENV },
      onboardingTaskId: null,
    });

    const ctx = await resolveTaskStackContext(db, TASK_ID);

    expect(ctx.envDetectData).toEqual(MIRROR_ENV.envDetectData);
  });

  it('ignores a mirror written at an unknown schema version', async () => {
    const db = fakeDb({
      repo: {
        onboardingTooling: { ...MIRROR_TOOLING, schemaVersion: 99 },
        onboardingEnvironment: { ...MIRROR_ENV, schemaVersion: 99 },
      },
      onboardingTaskId: null,
    });

    const ctx = await resolveTaskStackContext(db, TASK_ID);

    expect(ctx.tooling).toBeNull();
    expect(stackProjectName(ctx)).toBe('default');
  });

  it("prefers the task's own step rows over the mirror", async () => {
    const db = fakeDb({
      repo: { onboardingTooling: MIRROR_TOOLING, onboardingEnvironment: MIRROR_ENV },
      steps: {
        [TASK_ID]: {
          '04-tooling-infrastructure': { output: { tooling: { ragMode: 'ddev' } } },
          '01-env-detect': { detectOutput: { data: { project: { name: 'own-steps' } } } },
        },
      },
      onboardingTaskId: null,
    });

    const ctx = await resolveTaskStackContext(db, TASK_ID);

    expect(ctx.tooling?.ragMode).toBe('ddev');
    expect(stackProjectName(ctx)).toBe('own-steps');
  });

  it('resolves nothing when the repo has neither a mirror nor an onboarding task', async () => {
    const db = fakeDb({ repo: null, onboardingTaskId: null });

    const ctx = await resolveTaskStackContext(db, TASK_ID);

    expect(ctx.tooling).toBeNull();
    expect(ctx.envDetectData).toBeNull();
    expect(stackProjectName(ctx)).toBe('default');
  });
});
