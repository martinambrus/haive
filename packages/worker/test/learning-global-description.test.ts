import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';

const h = vi.hoisted(() => ({ promote: vi.fn() }));

vi.mock('../src/step-engine/steps/_global-kb-promote.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/step-engine/steps/_global-kb-promote.js')>();
  return { ...actual, clearTaskPromotedDrafts: async () => 0, promoteToGlobalKbDraft: h.promote };
});

import { phase8LearningStep } from '../src/step-engine/steps/workflow/11-phase-8-learning.js';

const TASK = '00000000-0000-4000-8000-0000000000d1';
const STEP = '00000000-0000-4000-8000-0000000000d2';
const USER = '00000000-0000-4000-8000-0000000000e1';

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), 'haive-learning-'));
  h.promote.mockReset();
  h.promote.mockResolvedValue({ id: 'promoted-1', deduped: false });
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
});

const ctx = () => {
  const fake = createFakeDb({ taskEvents: schema.taskEvents, taskSteps: schema.taskSteps });
  return {
    db: fake.db,
    taskId: TASK,
    taskStepId: STEP,
    userId: USER,
    workspacePath: workspace,
    repoPath: workspace,
    logger: { info() {}, warn() {} },
  } as never;
};

const detected = (over: Record<string, unknown> = {}) =>
  ({
    taskTitle: 'Task',
    taskDescription: '',
    filesTouched: [],
    verifyPassed: true,
    commitSha: null,
    isBugFix: false,
    existingSkills: [],
    repoStack: {
      anchors: {
        framework: null,
        frameworkMajor: null,
        phpMajor: '8',
        database: null,
        dbMajor: null,
        packages: [],
      },
      language: 'php',
      projectName: 'siteray',
    },
    ...over,
  }) as never;

const candidate = (over: Record<string, unknown> = {}) => ({
  title: 'Escape labels',
  category: 'best_practice',
  tech: 'php',
  body: 'portable body',
  evidence: 'src/a.ts:1',
  ...over,
});

const apply = (args: {
  llmOutput: unknown;
  formValues: Record<string, unknown>;
  detected?: never;
}) =>
  phase8LearningStep.apply!(ctx(), {
    detected: args.detected ?? detected(),
    llmOutput: args.llmOutput,
    formValues: { writeFiles: false, ...args.formValues },
  } as never);

describe('step 11 promotions and descriptions', () => {
  it('passes a ticked candidate its description', async () => {
    await apply({
      llmOutput: { globalCandidates: [candidate({ description: '  Escape\nevery label.  ' })] },
      formValues: { acceptGlobalCandidates: ['escape-labels'] },
    });

    expect(h.promote).toHaveBeenCalledTimes(1);
    expect(h.promote.mock.calls[0]![1]).toMatchObject({
      title: 'Escape labels',
      description: 'Escape every label.',
      projectName: 'siteray',
    });
  });

  it('promotes a candidate that came without a description, passing none', async () => {
    await apply({
      llmOutput: { globalCandidates: [candidate({ description: 42 })] },
      formValues: { acceptGlobalCandidates: ['escape-labels'] },
    });

    expect(h.promote).toHaveBeenCalledTimes(1);
    expect(h.promote.mock.calls[0]![1].description).toBeUndefined();
  });

  const investigation = {
    title: 'Null deref',
    symptoms: 'TypeError: x is undefined',
    root_cause: 'missing guard',
    lesson: 'guard inputs',
    scope: 'global',
  };

  // An investigation has no scope that could tell its subject from a project named after it.
  it('promotes a bug investigation with no description and no project name to scrub', async () => {
    await apply({
      llmOutput: { investigation },
      formValues: { writeInvestigation: true },
      detected: detected({ isBugFix: true }),
    });

    expect(h.promote).toHaveBeenCalledTimes(1);
    const promotion = h.promote.mock.calls[0]![1];
    expect(promotion.title).toBe('Null deref');
    expect(promotion.projectName).toBeUndefined();
    expect(promotion).not.toHaveProperty('description');
  });

  it('promotes a bug investigation from a repository that never onboarded', async () => {
    await apply({
      llmOutput: { investigation },
      formValues: { writeInvestigation: true },
      detected: detected({ isBugFix: true, repoStack: null }),
    });

    expect(h.promote).toHaveBeenCalledTimes(1);
    expect(h.promote.mock.calls[0]![1].projectName).toBeUndefined();
  });
});
