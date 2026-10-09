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

describe('08b: the task brief when a replayed payload has no spec', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  /** detect()'s payload as the runner reads it back; an older detect left a blank spec blank. */
  async function replay(
    task: { title: string; description: string },
    spec: string,
  ): Promise<{ ctx: never; payload: string }> {
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
    fake.insert(schema.taskSteps, {
      taskId: TASK,
      stepId: '01-worktree-setup',
      round: 0,
      output: { worktreePath: dir },
    });
    if (spec.trim()) {
      fake.insert(schema.taskSteps, {
        taskId: TASK,
        stepId: '04-phase-0b-pre-planning',
        round: 0,
        output: { spec },
      });
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
    const detected = (await testManagementStep.detect!(ctx)) as object;
    return { ctx, payload: JSON.stringify(spec.trim() ? detected : { ...detected, spec }) };
  }
  /** Both prompts, each its own dispatch: the payload read back, `prepare`, then the builder. */
  async function prompts(replayed: { ctx: never; payload: string }): Promise<string[]> {
    const dispatch = async (build: (detected: never) => string): Promise<string> => {
      const detected = JSON.parse(replayed.payload) as never;
      await testManagementStep.llm!.prepare?.({
        ctx: replayed.ctx,
        detected,
        formValues: {},
      } as never);
      return build(detected);
    };
    return [
      await dispatch((detected) =>
        testManagementStep.llm!.buildPrompt({ detected, formValues: {} } as never),
      ),
      await dispatch((detected) =>
        testManagementStep.loop!.buildIterationPrompt!({
          detected,
          formValues: {},
          iteration: 1,
          previousIterations: [],
        } as never),
      ),
    ];
  }

  it('puts the task title and description in the writer and the fix prompt', async () => {
    const replayed = await replay({ title: TITLE, description: DESCRIPTION }, '');
    for (const prompt of await prompts(replayed)) {
      expect(prompt).toContain(TITLE);
      expect(prompt).toContain(DESCRIPTION);
      expect(prompt).not.toContain('(no spec recorded)');
    }
  });

  it('reads a blank spec as none', async () => {
    const replayed = await replay({ title: TITLE, description: DESCRIPTION }, '   ');
    for (const prompt of await prompts(replayed)) expect(prompt).toContain(DESCRIPTION);
  });

  it('keeps the spec a spec step recorded, and leaves the brief out', async () => {
    const replayed = await replay({ title: TITLE, description: DESCRIPTION }, 'THE SPEC');
    for (const prompt of await prompts(replayed)) {
      expect(prompt).toContain('THE SPEC');
      expect(prompt).not.toContain(DESCRIPTION);
    }
  });

  it('says no spec was recorded only when the task has no title or description either', async () => {
    const replayed = await replay({ title: '  ', description: '' }, '');
    for (const prompt of await prompts(replayed)) expect(prompt).toContain('(no spec recorded)');
  });
});
