import { describe, expect, it } from 'vitest';
import { computeFrontier, withMinedStatus } from './01-plan-build.js';
import { rollUpStatus, type PlanNodeStatus } from '@haive/shared';
import type { PlanNodeSkeleton } from '@haive/shared/plan';

function node(over: Partial<PlanNodeSkeleton> & { id: string; path: string }): PlanNodeSkeleton {
  return {
    parentId: null,
    ordinal: 0,
    title: over.id,
    kind: 'component',
    status: 'todo',
    taskable: false,
    version: 1,
    createdBy: 'llm',
    sourceTaskId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as PlanNodeSkeleton;
}

describe('withMinedStatus', () => {
  it('records a mined component as done', () => {
    // A plan built FROM a repository describes code that already exists.
    // Measured before this: a real build produced 644 nodes, every one todo.
    const [op] = withMinedStatus([{ op: 'upsert', nodeRef: 'a', title: 'API' }], 'from_repo') as [
      Record<string, unknown>,
    ];
    expect(op.status).toBe('done');
  });

  it('never overrides a status the agent stated', () => {
    // This is how a component the prompt asked it to include, but which is NOT
    // built yet, stays visible as outstanding work.
    const [op] = withMinedStatus(
      [{ op: 'upsert', nodeRef: 'a', title: 'Billing', status: 'todo' }],
      'from_repo',
    ) as [Record<string, unknown>];
    expect(op.status).toBe('todo');
  });

  it('leaves a greenfield build alone', () => {
    // A document or a brief describes a project that does not exist; todo is
    // already the truth there.
    const ops = [{ op: 'upsert', nodeRef: 'a', title: 'API' }];
    expect(withMinedStatus(ops, 'from_md')).toEqual(ops);
  });

  it('touches only upserts', () => {
    const ops = [
      { op: 'link', fromRef: 'a', toRef: 'b', kind: 'depends_on' },
      { op: 'delete', nodeRef: 'c' },
    ];
    expect(withMinedStatus(ops, 'from_repo')).toEqual(ops);
  });

  it('passes through anything it does not recognise', () => {
    // Ops are unknown here — zod validates them downstream — so this must not
    // reshape input it does not understand.
    const ops = [null, 'nonsense', 42, { no: 'op' }];
    expect(withMinedStatus(ops, 'from_repo')).toEqual(ops);
  });
});

describe('computeFrontier with mined-done nodes', () => {
  const root = node({ id: 'root', path: 'root/' });

  it('still expands a done node THIS build created', () => {
    // The regression that would silently halve the feature: from_repo now
    // creates nodes done, and without the exemption the frontier empties after
    // level 1 and the plan never decomposes.
    const mine = node({
      id: 'a',
      path: 'root/a/',
      parentId: 'root',
      status: 'done',
      sourceTaskId: 'task-1',
    });
    expect(computeFrontier([root, mine], 5, 'task-1').map((n) => n.id)).toContain('a');
  });

  it('still skips a done node from an earlier build', () => {
    // The case the filter exists for: a merge must not re-expand finished work.
    const older = node({
      id: 'b',
      path: 'root/b/',
      parentId: 'root',
      status: 'done',
      sourceTaskId: 'task-0',
    });
    expect(computeFrontier([root, older], 5, 'task-1').map((n) => n.id)).not.toContain('b');
  });

  it('skips a done node when no build is named', () => {
    const older = node({
      id: 'b',
      path: 'root/b/',
      parentId: 'root',
      status: 'done',
      sourceTaskId: 'task-0',
    });
    expect(computeFrontier([root, older], 5).map((n) => n.id)).not.toContain('b');
  });

  it('does not exempt not_applicable, which is a human verdict', () => {
    const mine = node({
      id: 'c',
      path: 'root/c/',
      parentId: 'root',
      status: 'not_applicable',
      sourceTaskId: 'task-1',
    });
    expect(computeFrontier([root, mine], 5, 'task-1').map((n) => n.id)).not.toContain('c');
  });
});

describe('what a mined plan renders as', () => {
  it('greens a parent whose mined children are all done', () => {
    expect(rollUpStatus('done', ['done', 'done'] as PlanNodeStatus[])).toBe('done');
  });

  it('shows the one unbuilt component against the green', () => {
    // The whole point: an explicit todo leaf makes its ancestors amber, so
    // outstanding work stands out instead of drowning in 644 todos.
    expect(rollUpStatus('done', ['done', 'todo', 'done'] as PlanNodeStatus[])).toBe('in_progress');
  });
});
