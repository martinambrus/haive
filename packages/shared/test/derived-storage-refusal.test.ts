import { expect, it, vi } from 'vitest';
import { taskRunListIds } from '../src/step-engine/run-list.js';
import { resolveTaskTypeAvailability } from '../src/modularity/task-types.js';

it('refuses derived run-list selection before a static or live-list fallback', () => {
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
    ).toThrow('derived task types are not available yet');
  }
  expect(list).not.toHaveBeenCalled();
});

it('refuses derived availability even with enabled switches and an unsynced catalog', () => {
  expect(() =>
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
  ).toThrow('derived task types are not available yet');
});
