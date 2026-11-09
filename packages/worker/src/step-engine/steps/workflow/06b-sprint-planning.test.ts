import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import type { StepContext } from '../../step-definition.js';
import { describe, it, expect, vi } from 'vitest';
import { parseSprintPlan, sprintPlanningStep } from './06b-sprint-planning.js';

it('plans against the original request even when the approved spec widens it', () => {
  const prompt = sprintPlanningStep.llm!.buildPrompt!({
    detected: {
      taskBrief: 'Install admin_toolbar only. Preserve existing permissions.',
      spec: 'Install admin_toolbar and change permissions',
      gateFeedback: '',
      planOrdering: '',
    },
  } as never);
  expect(prompt).toContain('=== Original user request (scope constraints) ===');
  expect(prompt).toContain('Install admin_toolbar only. Preserve existing permissions.');
  expect(prompt).toContain('The user request and its explicit constraints define the work.');
});

describe('06b sprint-planning form (single mode)', () => {
  it('surfaces the single-agent decision + rationale instead of returning null', () => {
    const schema = sprintPlanningStep.form!(undefined as never, undefined as never, {
      mode: 'single',
      rationale: 'change is small and tightly coupled',
      max_parallel: 1,
      issues: [],
      levels: [],
    });
    expect(schema).not.toBeNull();
    // No decision fields (nothing to confirm), but the rationale IS shown so the
    // user isn't left with a bare "Continue".
    expect(schema!.fields).toHaveLength(0);
    expect(schema!.infoSections?.[0]?.body).toContain('tightly coupled');
    // Flows through even in manual mode (nothing to decide).
    expect(schema!.autoSubmit).toBe(true);
  });
});

describe('parseSprintPlan', () => {
  it('parses a fenced single-mode plan ignoring surrounding prose', () => {
    const raw =
      'Here is my decision:\n```json\n{"mode":"single","rationale":"simple","max_parallel":1,"issues":[],"levels":[]}\n```\nthanks';
    const p = parseSprintPlan(raw);
    expect(p.mode).toBe('single');
    expect(p.issues).toEqual([]);
    expect(p.levels).toEqual([]);
  });

  it('parses a fenced dag plan with issues + levels', () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        mode: 'dag',
        rationale: 'complex',
        max_parallel: 2,
        issues: [
          { id: 'ISSUE-001', title: 'A', depends_on: [], level: 0 },
          { id: 'ISSUE-002', title: 'B', depends_on: ['ISSUE-001'], level: 1 },
        ],
        levels: [['ISSUE-001'], ['ISSUE-002']],
      }) +
      '\n```';
    const p = parseSprintPlan(raw);
    expect(p.mode).toBe('dag');
    expect(p.issues).toHaveLength(2);
    expect(p.levels).toEqual([['ISSUE-001'], ['ISSUE-002']]);
    expect(p.issues[0]!.id).toBe('ISSUE-001');
  });

  it('accepts an already-parsed object (bypass stub shape)', () => {
    const p = parseSprintPlan({
      mode: 'single',
      rationale: 'stub',
      max_parallel: 1,
      issues: [],
      levels: [],
    });
    expect(p.mode).toBe('single');
  });

  it('falls back to single-agent on garbled or empty output', () => {
    expect(parseSprintPlan('no json here').mode).toBe('single');
    expect(parseSprintPlan('```json\n{not valid}\n```').mode).toBe('single');
    expect(parseSprintPlan(null).mode).toBe('single');
    expect(parseSprintPlan(undefined).mode).toBe('single');
  });

  it('applies schema defaults for omitted issue fields', () => {
    const raw = '```json\n{"mode":"dag","issues":[{"id":"X","title":"t"}],"levels":[["X"]]}\n```';
    const p = parseSprintPlan(raw);
    expect(p.issues[0]!.depends_on).toEqual([]);
    expect(p.issues[0]!.level).toBe(0);
    expect(p.issues[0]!.spec_sections).toEqual([]);
    expect(p.max_parallel).toBe(1);
  });
});

describe('sprintPlanningStep preForm retry gate', () => {
  const gate = sprintPlanningStep.llm!.shouldRetryPreForm!;

  it('retries when the planner output is unparseable (non-empty)', () => {
    expect(gate('no json here, just prose')).toBe(true);
  });

  it('does not retry on empty output', () => {
    expect(gate('')).toBe(false);
    expect(gate(null)).toBe(false);
  });

  it('does not retry when a valid dag plan parsed', () => {
    const raw =
      '```json\n{"mode":"dag","rationale":"r","max_parallel":2,"issues":[{"id":"A","title":"a","depends_on":[],"level":0}],"levels":[["A"]]}\n```';
    expect(gate(raw)).toBe(false);
  });
});

it('still overwrites the current estimate and records the unchanged refinement payload', async () => {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
    repositories: schema.repositories,
    taskDagPlans: schema.taskDagPlans,
    taskDagLevels: schema.taskDagLevels,
    taskDagIssues: schema.taskDagIssues,
  });
  fake.insert(schema.tasks, {
    id: '00000000-0000-4000-8000-000000000001',
    repositoryId: '00000000-0000-4000-8000-000000000002',
    aiEstimatedTimeHours: 6.5,
  });
  for (const [id, hours] of [
    ['00000000-0000-4000-8000-000000000004', 2],
    ['00000000-0000-4000-8000-000000000005', 4],
  ] as const) {
    fake.insert(schema.tasks, {
      id,
      repositoryId: '00000000-0000-4000-8000-000000000002',
      type: 'workflow',
      status: 'completed',
      title: id,
      changedPaths: ['src/a.ts'],
      completedAt: new Date(hours * 3_600_000),
      aiEstimatedTimeHours: null,
    });
    fake.insert(schema.taskSteps, {
      taskId: id,
      startedAt: new Date(0),
      endedAt: new Date(hours * 3_600_000),
      idleMs: 0,
      userActiveMs: 0,
      waitingStartedAt: null,
      status: 'done',
    });
  }
  // The fake cannot evaluate PostgreSQL's jsonb ?| operator; supply its overlap rows.
  vi.spyOn(fake.db, 'select').mockReturnValueOnce({
    from: () => ({
      where: async () =>
        fake.rows(schema.tasks).filter((t) => t.id !== '00000000-0000-4000-8000-000000000001'),
    }),
  } as never);
  const warn = vi.fn();
  const ctx = {
    db: fake.db,
    taskId: '00000000-0000-4000-8000-000000000001',
    taskStepId: '00000000-0000-4000-8000-000000000003',
    logger: { info: vi.fn(), warn },
  } as unknown as StepContext;
  await sprintPlanningStep.apply(ctx, {
    detected: {} as never,
    iteration: 0,
    previousIterations: [],
    llmOutput: JSON.stringify({
      mode: 'dag',
      rationale: 'two areas',
      issues: [{ id: 'A', title: 'A', estimated_files: ['src/a.ts'] }],
      levels: [['A']],
    }),
    formValues: {},
  });
  expect(warn).not.toHaveBeenCalled();
  expect(
    fake.rows(schema.tasks).find((t) => t.id === '00000000-0000-4000-8000-000000000001')!
      .aiEstimatedTimeHours,
  ).toBe(3);
  expect(fake.rows(schema.taskEvents)).toMatchObject([
    {
      eventType: 'estimate.refined',
      payload: {
        previous: 6.5,
        refined: 3,
        overlapAnchors: 2,
        matchedFiles: 1,
        predictedFileCount: 1,
      },
    },
  ]);
  expect(Object.keys(fake.rows(schema.taskEvents)[0]!.payload as object).sort()).toEqual(
    ['previous', 'refined', 'overlapAnchors', 'matchedFiles', 'predictedFileCount'].sort(),
  );
});
