import { describe, expect, it } from 'vitest';
import {
  holdsFor,
  haiveDataSaveRequestSchema,
  type HaiveDataRefusal,
  type HaiveDataFacts,
} from '../src/haive-data.js';

const clear: HaiveDataFacts = {
  checkout: 'ready',
  rootClaimLive: false,
  holdingTaskIds: [],
  writeIntent: false,
  gitOperation: false,
  planMergeTaskId: null,
  pendingUnits: [],
  stateDirty: false,
  mirrorDirty: false,
  push: false,
  branch: 'main',
  origin: true,
};

describe('Haive data Save holds', () => {
  it('allows a clean checkout, including pending plan questions', () => {
    expect(holdsFor(clear)).toEqual([]);
    expect(holdsFor({ ...clear, stateDirty: true, mirrorDirty: true })).toEqual([]);
    expect(holdsFor({ ...clear, pendingUnits: ['plan/abc#title'] })).toEqual([]);
  });
  it.each([
    [{ checkout: 'missing' }, { code: 'checkout_missing' }],
    [{ checkout: 'not_git' }, { code: 'not_git_checkout' }],
    [{ rootClaimLive: true }, { code: 'root_claim' }],
    [{ holdingTaskIds: ['task'] }, { code: 'checkout_held', taskIds: ['task'] }],
    [{ writeIntent: true }, { code: 'write_pending' }],
    [{ gitOperation: true }, { code: 'git_operation' }],
    [{ planMergeTaskId: 'merge' }, { code: 'plan_merge', taskId: 'merge' }],
    [
      { pendingUnits: ['project/render.json#framework', 'plan/abc#body'] },
      { code: 'project_state_questions', units: ['project/render.json#framework'] },
    ],
    [{ push: true, branch: null }, { code: 'detached_head' }],
    [{ push: true, origin: false }, { code: 'no_origin' }],
  ] as const)('classifies %j structurally', (change, hold) => {
    expect(holdsFor({ ...clear, ...change })).toEqual([hold]);
  });
  it('allows local saves without a branch or origin and ignores unknown question units', () => {
    expect(
      holdsFor({ ...clear, branch: null, origin: false, pendingUnits: ['future/value'] }),
    ).toEqual([]);
  });
  it('returns all holds in a stable order without mutating facts', () => {
    const facts = {
      ...clear,
      writeIntent: true,
      gitOperation: true,
      pendingUnits: ['settings/agent-rules.md', 'settings/agent-rules.md'],
    };
    expect(holdsFor(facts)).toEqual([
      { code: 'write_pending' },
      { code: 'git_operation' },
      { code: 'project_state_questions', units: ['settings/agent-rules.md'] },
    ]);
    expect(facts.pendingUnits).toHaveLength(2);
  });
});

it('sorts holder IDs without mutating the facts', () => {
  const holdingTaskIds = ['z', 'a'];
  expect(holdsFor({ ...clear, holdingTaskIds })).toEqual([
    { code: 'checkout_held', taskIds: ['a', 'z'] },
  ]);
  expect(holdingTaskIds).toEqual(['z', 'a']);
});
it.each([
  'checkout_unreadable',
  'git_operation_unreadable',
  'branch_unreadable',
  'origin_unreadable',
] as const)('reports structural fact failure %s', (code) => {
  expect(holdsFor({ ...clear, readHolds: [{ code }] })).toEqual([{ code }]);
});

it('validates and trims data Save requests', () => {
  expect(haiveDataSaveRequestSchema.parse({ commitMessage: '  subject  ' })).toEqual({
    push: false,
    commitMessage: 'subject',
  });
  for (const commitMessage of ['', ' ', 'bad\0message', 'x'.repeat(501)])
    expect(haiveDataSaveRequestSchema.safeParse({ push: true, commitMessage }).success).toBe(false);
  expect(haiveDataSaveRequestSchema.safeParse({ push: 'true' }).success).toBe(false);
});

it.each([
  ['checkout_unreadable', { checkout: 'not_git', push: true, branch: null, origin: false }],
  ['branch_unreadable', { push: true, branch: null }],
  ['origin_unreadable', { push: true, origin: false }],
] as const)('suppresses every dependent negative answer after %s', (code, change) => {
  expect(holdsFor({ ...clear, ...change, readHolds: [{ code }] })).toEqual([{ code }]);
});

it.each(['missing', 'not_git'] as const)(
  'says nothing about what a checkout that could not be read is (%s)',
  (checkout) => {
    expect(holdsFor({ ...clear, checkout, readHolds: [{ code: 'checkout_unreadable' }] })).toEqual([
      { code: 'checkout_unreadable' },
    ]);
  },
);

it('narrows each integration-capable hold to one optional file payload', () => {
  const fileFor = (refusal: HaiveDataRefusal) => {
    switch (refusal.code) {
      case 'git_operation':
      case 'git_operation_unreadable':
      case 'write_pending':
        return refusal.file;
      default:
        return undefined;
    }
  };
  for (const code of ['git_operation', 'git_operation_unreadable', 'write_pending'] as const) {
    expect(fileFor({ code })).toBeUndefined();
    expect(fileFor({ code, file: '.haive-data/state/file.json' })).toBe(
      '.haive-data/state/file.json',
    );
  }
});

it.each(['missing', 'not_git'] as const)(
  'does not invent push prerequisites for a %s checkout',
  (checkout) => {
    expect(holdsFor({ ...clear, checkout, push: true, branch: null, origin: false })).toEqual([
      { code: checkout === 'missing' ? 'checkout_missing' : 'not_git_checkout' },
    ]);
  },
);
