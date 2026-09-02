import { describe, expect, it } from 'vitest';
import type { PlanNodeSkeleton } from '@haive/shared/plan';
import {
  buildPlanExpansionContext,
  PLAN_EXPANSION_CONTEXT_MAX_CHARS,
} from './_plan-expansion-context.js';
import { buildExpandPrompt, type PlanBuildDetect } from './01-plan-build.js';
import { hasSemanticExpansionResolution } from './_plan-semantic-stop.js';

function node(id: string, title: string, parentId: string | null, path: string): PlanNodeSkeleton {
  return {
    id,
    parentId,
    path,
    ordinal: 0,
    title,
    kind: 'component',
    status: 'todo',
    taskable: false,
    version: 1,
    createdBy: 'llm',
    sourceTaskId: 'task-1',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe('provider-neutral plan expansion context', () => {
  it('omits edge/body-scale detail and keeps a small plan fully visible', () => {
    const root = node('root', 'Product', null, '0001');
    const focus = node('focus', 'Checkout', 'root', '0001.0001');
    const sibling = node('sibling', 'Accounts', 'root', '0001.0002');
    const text = buildPlanExpansionContext([root, focus, sibling], focus);

    expect(text).toContain('Target: Checkout (`node:focus`');
    expect(text).toContain('Sibling: Accounts (`node:sibling`');
    expect(text).toContain('Showing all 3 nodes');
  });

  it('stays under the provider-independent budget as a plan grows', () => {
    const root = node('root', 'Product', null, '0001');
    const children = Array.from({ length: 4000 }, (_, index) =>
      node(
        `node-${index}`,
        `Component ${index} ${'descriptive-title '.repeat(12)}`,
        'root',
        `0001.${String(index + 1).padStart(4, '0')}`,
      ),
    );
    const focus = children[3999]!;
    const text = buildPlanExpansionContext([root, ...children], focus);

    expect(text.length).toBeLessThanOrEqual(PLAN_EXPANSION_CONTEXT_MAX_CHARS);
    expect(text).toContain(`Target: ${'Component 3999'}`);
    expect(text).toContain('evenly sampled');
  });

  it('always preserves the target path and local exact refs when sampling', () => {
    const root = node('root', 'Product', null, '0001');
    const parent = node('parent', 'Commerce', 'root', '0001.0001');
    const focus = node('focus', 'Checkout', 'parent', '0001.0001.0001');
    const sibling = node('sibling', 'Cart', 'parent', '0001.0001.0002');
    const noise = Array.from({ length: 2000 }, (_, index) =>
      node(`noise-${index}`, `Noise ${index}`, 'root', `0001.${index + 2}`),
    );
    const text = buildPlanExpansionContext([root, parent, focus, sibling, ...noise], focus, 8_000);

    expect(text).toContain('Ancestor: Product (`node:root`');
    expect(text).toContain('Ancestor: Commerce (`node:parent`');
    expect(text).toContain('Target: Checkout (`node:focus`');
    expect(text).toContain('Sibling: Cart (`node:sibling`');
  });
});

describe('semantic expansion stopping', () => {
  it('requires an explicit taskable verdict instead of an ambiguous empty patch', () => {
    const focus = node('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Checkout', null, '0001');
    const detected: PlanBuildDetect = {
      mode: 'from_md',
      repositoryId: 'repo-1',
      existingNodeCount: 1,
      hasRoot: true,
      kbFiles: [],
      brief: '',
      repoName: 'Product',
    };
    const prompt = buildExpandPrompt(
      detected,
      { depthBudget: 3, breadthCap: 6 },
      focus,
      buildPlanExpansionContext([focus], focus),
    );

    expect(prompt).toContain('First make a semantic stopping decision');
    expect(prompt).toContain(`"nodeRef": "${focus.id}"`);
    expect(prompt).toContain('"taskable": true');
    expect(prompt).toContain('An empty `ops` array is not a stopping decision');
  });

  it('accepts only a taskable self verdict or a real direct-child decomposition', () => {
    const self = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect(hasSemanticExpansionResolution([], self)).toBe(false);
    expect(
      hasSemanticExpansionResolution(
        [{ op: 'link', fromRef: self, toRef: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }],
        self,
      ),
    ).toBe(false);
    expect(
      hasSemanticExpansionResolution(
        [{ op: 'upsert', nodeRef: self, expectedVersion: 1, taskable: true }],
        self,
      ),
    ).toBe(true);
    expect(
      hasSemanticExpansionResolution(
        [{ op: 'upsert', nodeRef: 'tmp-child', parentRef: 'self', title: 'Child' }],
        self,
      ),
    ).toBe(true);
  });
});
