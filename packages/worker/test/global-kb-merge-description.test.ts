import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
const OTHER = '00000000-0000-4000-8000-0000000000f2';
const MERGED = `# Merged\n\n${'A union of both articles, long enough to be trusted. '.repeat(2)}`;

function setup(draftDescription: string | null, existingDescription: string | null) {
  const fake = createFakeDb({ globalKbEntries });
  h.gdb = fake.db;
  let writes = 0;
  fake.hooks.beforeUpdate = () => {
    writes += 1;
  };
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
  const edit = (values: Record<string, unknown>) => fake.patch(globalKbEntries, DRAFT, values);
  return { ctx, fake, draft, edit, writes: () => writes };
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

  describe('a draft that was not merged', () => {
    const agent = `merge:${DRAFT}`;
    const unmerged: Array<[string, Array<Record<string, unknown>>]> = [
      ['has no result at all', []],
      [
        'failed',
        [{ agentId: agent, status: 'failed', rawOutput: null, errorMessage: 'agent died' }],
      ],
      [
        'came back too short to trust',
        [{ agentId: agent, status: 'done', rawOutput: 'too short' }],
      ],
    ];

    async function apply(results: Array<Record<string, unknown>>) {
      const detected = await globalKbMergeStep.detect!(state.ctx);
      return globalKbMergeStep.apply!(state.ctx, {
        detected,
        agentMiningResults: results,
      } as never);
    }

    it.each(unmerged)(
      'inherits the description, and only that, when its merge %s',
      async (_, results) => {
        state = setup(null, 'Escape every interpolated label.');
        const out = await apply(results);

        expect(state.draft()).toMatchObject({
          body: 'draft body',
          embedStatus: null,
          description: 'Escape every interpolated label.',
        });
        expect(out).toMatchObject({ merged: 0, skipped: 1 });
      },
    );

    it('writes nothing to a draft that has a description of its own', async () => {
      state = setup('The draft one-liner.', 'The superseded one-liner.');
      await apply([]);

      expect(state.writes()).toBe(0);
      expect(state.draft().description).toBe('The draft one-liner.');
    });

    it('writes nothing when there is nothing to inherit', async () => {
      state = setup(null, null);
      await apply([{ agentId: agent, status: 'done', rawOutput: 'too short' }]);

      expect(state.writes()).toBe(0);
      expect(state.draft().description).toBeNull();
    });
  });

  describe('a draft that changed while the agents ran', () => {
    async function applyAfter(
      change: Record<string, unknown>,
      results: Array<Record<string, unknown>>,
    ) {
      state = setup(null, 'Escape every interpolated label.');
      const detected = await globalKbMergeStep.detect!(state.ctx);
      state.edit(change);
      return globalKbMergeStep.apply!(state.ctx, {
        detected,
        agentMiningResults: results,
      } as never);
    }

    it('is left as it is by a merge once it is active, and the loss note says why', async () => {
      const out = await applyAfter({ status: 'active' }, merged);

      expect(state.draft()).toMatchObject({
        status: 'active',
        body: 'draft body',
        description: null,
        embedStatus: null,
        updatedAt: null,
      });
      expect(out).toMatchObject({ merged: 0, skipped: 1 });
      expect(out.degradedNote).toContain('no longer a draft');
    });

    it('keeps a body a person edited after detect, and the loss note says so', async () => {
      const out = await applyAfter({ body: 'edited by a person' }, merged);

      expect(state.draft()).toMatchObject({
        status: 'draft',
        body: 'edited by a person',
        embedStatus: null,
      });
      expect(out).toMatchObject({ merged: 0, skipped: 1 });
      expect(out.degradedNote).toContain('edited while the merge ran');
      expect(out.degradedNote).not.toContain('no longer a draft');
    });

    it('counts a draft already holding the merged body as merged, as a replayed apply finds it', async () => {
      const out = await applyAfter({ body: MERGED.trim() }, merged);

      expect(state.draft()).toMatchObject({ status: 'draft', body: MERGED.trim() });
      expect(out).toMatchObject({ merged: 1, skipped: 0 });
      expect(out.degradedNote).toBeUndefined();
    });

    it('merges a draft whose body is still the one detect read', async () => {
      const out = await applyAfter({ description: 'Typed after detect.' }, merged);

      expect(state.draft().body).toBe(MERGED.trim());
      expect(out).toMatchObject({ merged: 1, skipped: 0 });
      expect(out.degradedNote).toBeUndefined();
    });

    it('does not take an inherited description once it is active', async () => {
      await applyAfter({ status: 'active' }, []);

      expect(state.draft()).toMatchObject({ status: 'active', description: null, updatedAt: null });
    });

    it.each<[string, Array<Record<string, unknown>>, string]>([
      ['the merge lands', merged, MERGED.trim()],
      ['nothing merges', [], 'draft body'],
    ])('keeps a description typed after detect when %s', async (_, results, body) => {
      await applyAfter({ description: 'Typed after detect.' }, results);

      expect(state.draft()).toMatchObject({ body, description: 'Typed after detect.' });
    });
  });

  describe('a pair whose bodies already match', () => {
    const twin = '  existing body\n';
    const pair = (draftId: string, draftBody: string, draftTitle = 'Draft') => ({
      draftId,
      draftTitle,
      draftBody,
      existingId: EXISTING,
      existingBody: 'existing body',
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    async function applyToTwin(
      draftDescription: string | null,
      results: Array<Record<string, unknown>> = [],
    ) {
      state = setup(draftDescription, 'Escape every interpolated label.');
      state.edit({ body: twin });
      const detected = await globalKbMergeStep.detect!(state.ctx);
      return globalKbMergeStep.apply!(state.ctx, {
        detected,
        agentMiningResults: results,
      } as never);
    }

    it('gets no merge agent, while a pair that differs still gets one', async () => {
      vi.stubEnv('HAIVE_TEST_BYPASS_LLM', '');
      const detected = { pairs: [pair(DRAFT, twin), pair(OTHER, 'draft body')] };

      const dispatches = await globalKbMergeStep.agentMining!.selectAgents({ detected } as never);

      expect(dispatches.map((d) => d.agentId)).toEqual([`merge:${OTHER}`]);
    });

    it.each<[string, Array<Record<string, unknown>>]>([
      ['no result', []],
      ['a stale merge result', merged],
    ])(
      'counts as merged without a body write, given %s, and the loss note leaves it out',
      async (_, results) => {
        const out = await applyToTwin(null, results);

        expect(state.draft()).toMatchObject({
          body: twin,
          embedStatus: null,
          description: 'Escape every interpolated label.',
        });
        expect(out).toMatchObject({ merged: 1, skipped: 0 });
        expect(out.degradedNote).toBeUndefined();
      },
    );

    it('writes nothing when the draft has a description of its own', async () => {
      const out = await applyToTwin('The draft one-liner.');

      expect(out).toMatchObject({ merged: 1, skipped: 0 });
      expect(state.writes()).toBe(0);
    });

    it('is left out of a loss note that names the pair whose agent failed', async () => {
      state = setup(null, null);
      const detected = {
        pairs: [pair(DRAFT, twin, 'Twin draft'), pair(OTHER, 'draft body', 'Lost draft')],
      };
      const failed = {
        agentId: `merge:${OTHER}`,
        status: 'failed',
        rawOutput: null,
        errorMessage: 'agent died',
      };

      const out = await globalKbMergeStep.apply!(state.ctx, {
        detected,
        agentMiningResults: [failed],
      } as never);

      expect(out).toMatchObject({ merged: 1, skipped: 1 });
      expect(out.degradedNote).toContain('Lost draft');
      expect(out.degradedNote).not.toContain('Twin draft');
    });
  });

  describe('a knowledge base write that throws', () => {
    const SECOND = '00000000-0000-4000-8000-0000000000f3';
    const result = (id: string) => ({
      agentId: `merge:${id}`,
      status: 'done',
      rawOutput: `<<<MERGED\n${MERGED}\nMERGED>>>`,
    });

    async function applyThrowingOn(failingWrite: number | null) {
      state = setup(null, null);
      state.fake.insert(globalKbEntries, {
        namespace: 'default',
        category: 'best_practice',
        facets: {},
        source: 'promoted',
        id: SECOND,
        title: 'Second draft',
        body: 'second body',
        status: 'draft',
        sourceTaskId: TASK,
        supersedesEntryId: EXISTING,
        description: null,
      });
      let writes = 0;
      state.fake.hooks.beforeUpdate = () => {
        writes += 1;
        if (writes === failingWrite) throw new Error('connection reset');
      };
      const detected = await globalKbMergeStep.detect!(state.ctx);
      return globalKbMergeStep.apply!(state.ctx, {
        detected,
        agentMiningResults: [result(DRAFT), result(SECOND)],
      } as never);
    }

    it('labels the pair it threw on and the pair it never reached as a failed write', async () => {
      const out = await applyThrowingOn(1);

      expect(out).toMatchObject({ merged: 0, skipped: 2 });
      expect(out.degradedNote).toContain('the merged article was not written');
      expect(out.degradedNote).not.toContain('no usable merged article');
    });

    it('keeps the label of a pair finished before the throw', async () => {
      const out = await applyThrowingOn(2);

      expect(out).toMatchObject({ merged: 1, skipped: 1 });
      expect(out.degradedNote).toContain('Second draft');
      expect(out.degradedNote).toContain('the merged article was not written');
      expect(out.degradedNote).not.toContain('Draft (');
    });

    it('labels nothing as a failed write when no write throws', async () => {
      const out = await applyThrowingOn(null);

      expect(out).toMatchObject({ merged: 2, skipped: 0 });
      expect(out.degradedNote).toBeUndefined();
    });
  });
});
