import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb } from '@haive/database/testing';
import { globalKbEntries } from '@haive/shared/global-kb';

const h = vi.hoisted(() => ({ gdb: undefined as unknown }));

vi.mock('@haive/shared/global-kb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared/global-kb')>();
  return {
    ...actual,
    resolveGlobalKbSettings: async () => ({ enabled: true, namespace: 'default' }),
    withGlobalKb: async (_db: unknown, fn: (ctx: unknown) => Promise<unknown>) =>
      fn({ db: h.gdb, settings: { namespace: 'default' } }),
  };
});

import { globalKbMergeStep } from '../src/step-engine/steps/onboarding/09_6_4-global-kb-merge.js';

const TASK = '00000000-0000-4000-8000-0000000000d1';
const EXISTING = '00000000-0000-4000-8000-0000000000e1';
const DRAFT = '00000000-0000-4000-8000-0000000000f1';
const MERGED = `# Merged\n\n${'A union of both articles, long enough to be trusted. '.repeat(2)}`;

function setup(draftDescription: string | null, existingDescription: string | null) {
  const fake = createFakeDb({ globalKbEntries });
  h.gdb = fake.db;
  const base = { namespace: 'default', category: 'best_practice', facets: {}, source: 'promoted' };
  fake.insert(globalKbEntries, {
    ...base,
    id: EXISTING,
    title: 'Existing',
    body: 'existing body',
    status: 'active',
    description: existingDescription,
  });
  fake.insert(globalKbEntries, {
    ...base,
    id: DRAFT,
    title: 'Draft',
    body: 'draft body',
    status: 'draft',
    sourceTaskId: TASK,
    supersedesEntryId: EXISTING,
    description: draftDescription,
  });
  const ctx = { db: fake.db, taskId: TASK, logger: { info() {}, warn() {} } } as never;
  const draft = () => fake.rows(globalKbEntries).find((r) => r.id === DRAFT)!;
  return { ctx, draft };
}

const merged = [
  { agentId: `merge:${DRAFT}`, status: 'done', rawOutput: `<<<MERGED\n${MERGED}\nMERGED>>>` },
];

describe('the merge step and descriptions', () => {
  let state: ReturnType<typeof setup>;

  async function run(draftDescription: string | null, existingDescription: string | null) {
    state = setup(draftDescription, existingDescription);
    const detected = await globalKbMergeStep.detect!(state.ctx);
    await globalKbMergeStep.apply!(state.ctx, { detected, agentMiningResults: merged } as never);
    return state.draft();
  }

  beforeEach(() => {
    h.gdb = undefined;
  });

  it('copies the superseded entry description onto a merged draft that has none', async () => {
    const draft = await run(null, 'Escape every interpolated label.');

    expect(draft.body).toBe(MERGED.trim());
    expect(draft.description).toBe('Escape every interpolated label.');
  });

  it('keeps the description the draft already has', async () => {
    const draft = await run('The draft one-liner.', 'The superseded one-liner.');

    expect(draft.body).toBe(MERGED.trim());
    expect(draft.description).toBe('The draft one-liner.');
  });

  it('leaves it empty when neither entry has one', async () => {
    expect((await run(null, null)).description).toBeNull();
  });

  it('reads a payload persisted before descriptions existed as having nothing to copy', async () => {
    state = setup(null, 'Escape every interpolated label.');
    const detected = {
      pairs: [
        {
          draftId: DRAFT,
          draftTitle: 'Draft',
          draftBody: 'draft body',
          existingId: EXISTING,
          existingBody: 'existing body',
        },
      ],
    };
    await globalKbMergeStep.apply!(state.ctx, { detected, agentMiningResults: merged } as never);

    expect(state.draft().body).toBe(MERGED.trim());
    expect(state.draft().description).toBeNull();
  });

  it('touches nothing of a draft whose merge came back empty', async () => {
    state = setup(null, 'Escape every interpolated label.');
    const detected = await globalKbMergeStep.detect!(state.ctx);
    await globalKbMergeStep.apply!(state.ctx, {
      detected,
      agentMiningResults: [{ agentId: `merge:${DRAFT}`, status: 'done', rawOutput: 'too short' }],
    } as never);

    expect(state.draft().body).toBe('draft body');
    expect(state.draft().description).toBeNull();
  });
});
