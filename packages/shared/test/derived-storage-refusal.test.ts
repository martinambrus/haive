import { expect, it, vi } from 'vitest';
import { DerivedRunPlanError } from '../src/modularity/derived-task-types.js';
import { taskRunListIds } from '../src/step-engine/run-list.js';
import { resolveTaskTypeAvailability } from '../src/modularity/task-types.js';

it('names a missing derived plan before a static or live-list fallback', () => {
  const list = vi.fn(() => ['fallback-step']);
  for (const runListSnapshot of [null, ['pinned-step']]) {
    expect(() =>
      taskRunListIds(
        {
          workflowType: 'derived-example',
          runListStrategy: 'derived',
          runListSnapshot,
          executionPath: null,
        },
        list,
      ),
    ).toThrow(DerivedRunPlanError);
  }
  expect(list).not.toHaveBeenCalled();
});

it('reports invalid composition for derived availability without admitted candidates', () => {
  expect(
    resolveTaskTypeAvailability({
      definition: {
        source: 'admin',
        enabled: true,
        selectable: true,
        runListStrategy: 'derived',
        stepIds: null,
        requiresRepository: true,
      },
      switches: { customEnabled: true, moduleEnabled: true },
      modules: new Map(),
      catalog: null,
      generic: true,
    }),
  ).toEqual({ available: false, reason: 'invalid-composition' });
});
