import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';

vi.mock('./_impl-changes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_impl-changes.js')>()),
  collectImplementationFiles: async () => ({ files: [], total: 0, truncated: false }),
}));

import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { configService } from '@haive/shared';
import { testManagementStep } from './08b-test-management.js';

const TASK = 'aaaaaaaa-0000-4000-8000-000000000001';
const TITLE = 'Fix the login redirect';
const DESCRIPTION = 'After login the user lands on /home instead of the page they asked for.';

describe('08b: the task brief when there is no spec', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  /** The step's own detect(), for a task row with `task` and spec steps that recorded `outputs`. */
  async function detect(
    task: { title: string; description: string },
    outputs: Record<string, unknown> = {},
  ): Promise<never> {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    const dir = await mkdtemp(path.join(tmpdir(), 'haive-08b-brief-'));
    dirs.push(dir);
    await writeFile(path.join(dir, 'vitest.config.ts'), '');
    const fake = createFakeDb({
      tasks: schema.tasks,
      taskSteps: schema.taskSteps,
      taskDagIssues: schema.taskDagIssues,
    });
    fake.insert(schema.tasks, { id: TASK, ...task });
    const steps = { '01-worktree-setup': { worktreePath: dir }, ...outputs };
    for (const [stepId, output] of Object.entries(steps)) {
      fake.insert(schema.taskSteps, { taskId: TASK, stepId, round: 0, output });
    }
    const ctx = {
      db: fake.db,
      taskId: TASK,
      repoPath: dir,
      workspacePath: dir,
      sandboxWorkdir: '/ws',
      logger: { info: vi.fn(), warn: vi.fn() },
      emitProgress: vi.fn(async () => {}),
    } as never;
    return (await testManagementStep.detect!(ctx)) as never;
  }
  const prompts = (detected: never): string[] => [
    testManagementStep.llm!.buildPrompt({ detected, formValues: {} } as never),
    testManagementStep.loop!.buildIterationPrompt!({
      detected,
      formValues: {},
      iteration: 1,
      previousIterations: [],
    } as never),
  ];

  it('puts the task title and description in the writer and the fix prompt', async () => {
    const detected = await detect({ title: TITLE, description: DESCRIPTION });
    for (const prompt of prompts(detected)) {
      expect(prompt).toContain(TITLE);
      expect(prompt).toContain(DESCRIPTION);
      expect(prompt).not.toContain('(no spec recorded)');
    }
  });

  it('reads a blank spec as none', async () => {
    const detected = await detect(
      { title: TITLE, description: DESCRIPTION },
      { '05a-resolve-spec-warnings': { spec: '   ' } },
    );
    for (const prompt of prompts(detected)) expect(prompt).toContain(DESCRIPTION);
  });

  it('keeps the spec a spec step recorded, and leaves the brief out', async () => {
    const detected = await detect(
      { title: TITLE, description: DESCRIPTION },
      { '04-phase-0b-pre-planning': { spec: 'THE SPEC' } },
    );
    for (const prompt of prompts(detected)) {
      expect(prompt).toContain('THE SPEC');
      expect(prompt).not.toContain(DESCRIPTION);
    }
  });

  it('says no spec was recorded only when the task has no title or description either', async () => {
    const detected = await detect({ title: '  ', description: '' });
    for (const prompt of prompts(detected)) expect(prompt).toContain('(no spec recorded)');
  });
});
