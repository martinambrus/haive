import { describe, expect, it } from 'vitest';
import {
  renderPlanOrderingConstraint,
  renderSeededNodesForSpec,
  type SeededPlanNodes,
} from './_plan-task-nodes.js';
import type { PlanNodeRecord } from '@haive/shared/plan';

/**
 * How a task's node set reaches the spec writer and the DAG planner.
 *
 * The chain is plan -> 04's prompt -> the spec -> 06b's prompt -> DAG levels, and
 * neither downstream reader can see the plan. Both renderings are prompt text, so
 * what is asserted here is what an agent will actually be told.
 */

const COMMS = '11111111-1111-4111-8111-111111111111';
const UX = '22222222-2222-4222-8222-222222222222';
const ROOT = '00000000-0000-4000-8000-000000000000';

function node(id: string, title: string, over: Partial<PlanNodeRecord> = {}): PlanNodeRecord {
  return {
    id,
    parentId: ROOT,
    path: `/${ROOT}/${id}/`,
    ordinal: 0,
    title,
    kind: 'component',
    status: 'todo',
    taskable: true,
    version: 1,
    createdBy: 'llm',
    sourceTaskId: null,
    lastReviewedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    body: null,
    ...over,
  } as PlanNodeRecord;
}

function seeded(over: Partial<SeededPlanNodes> = {}): SeededPlanNodes {
  return {
    nodes: [node(COMMS, 'External comms layer'), node(UX, 'Notification UX')],
    internalDeps: [{ fromNodeId: UX, toNodeId: COMMS }],
    ancestryById: new Map([
      [COMMS, ['Product']],
      [UX, ['Product']],
    ]),
    ...over,
  };
}

describe('renderSeededNodesForSpec', () => {
  it('names every node with the id the spec must copy', () => {
    const out = renderSeededNodesForSpec(seeded());
    expect(out).toContain(`node:${COMMS}`);
    expect(out).toContain(`node:${UX}`);
  });

  it('carries the ancestry, because a title alone is often meaningless', () => {
    expect(renderSeededNodesForSpec(seeded())).toContain('_In: Product_');
  });

  it('includes the node body when it has one', () => {
    const out = renderSeededNodesForSpec(
      seeded({
        nodes: [node(COMMS, 'External comms layer', { body: 'Talks to the provider API.' })],
        internalDeps: [],
      }),
    );
    expect(out).toContain('Talks to the provider API.');
  });

  it('states the prerequisite on the node that waits, in the right direction', () => {
    const out = renderSeededNodesForSpec(seeded());
    const uxBlock = out.slice(out.indexOf('Notification UX'));
    expect(uxBlock).toContain('Cannot start until these land');
    expect(uxBlock).toContain(COMMS);
    // The comms node waits for nothing, and must not be told it does.
    const commsBlock = out.slice(0, out.indexOf('Notification UX'));
    expect(commsBlock).not.toContain('Cannot start until these land');
  });

  it('renders a node deeper than the plan index cap in full', () => {
    // The reason this exists at all: the index 04 also carries stops at three
    // levels, so a node at level five would otherwise be unnameable.
    const deepId = '33333333-3333-4333-8333-333333333333';
    const deepPath = `/${ROOT}/a/b/c/${deepId}/`;
    const out = renderSeededNodesForSpec({
      nodes: [node(deepId, 'Order form', { path: deepPath })],
      internalDeps: [],
      ancestryById: new Map([[deepId, ['Product', 'Forms', 'Commerce']]]),
    });
    expect(out).toContain(`node:${deepId}`);
    expect(out).toContain('_In: Product › Forms › Commerce_');
  });
});

describe('renderPlanOrderingConstraint', () => {
  it('states the order as prerequisite-first prose', () => {
    expect(renderPlanOrderingConstraint(seeded())).toBe(
      '- "External comms layer" must land before "Notification UX"',
    );
  });

  it('is EMPTY for a set with no order among itself', () => {
    // The parallel case. An empty string drops the whole prompt section, so the
    // planner sees exactly what it always did.
    expect(renderPlanOrderingConstraint(seeded({ internalDeps: [] }))).toBe('');
  });

  it('lists every prerequisite when several nodes wait on one', () => {
    const workflow = '44444444-4444-4444-8444-444444444444';
    const out = renderPlanOrderingConstraint(
      seeded({
        nodes: [
          node(COMMS, 'External comms layer'),
          node(UX, 'Notification UX'),
          node(workflow, 'Approval workflow'),
        ],
        internalDeps: [
          { fromNodeId: UX, toNodeId: COMMS },
          { fromNodeId: workflow, toNodeId: COMMS },
        ],
      }),
    );
    expect(out.split('\n')).toHaveLength(2);
    expect(out).toContain('before "Notification UX"');
    expect(out).toContain('before "Approval workflow"');
  });
});
