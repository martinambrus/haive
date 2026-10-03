import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { globalKbEntries } from '@haive/shared/global-kb';

const SKELETON = '00000000-0000-4000-8000-0000000000a1';
const SAME_NAMESPACE = '00000000-0000-4000-8000-0000000000b1';
const OTHER_NAMESPACE = '00000000-0000-4000-8000-0000000000c1';
const TASK = '00000000-0000-4000-8000-0000000000d1';

const h = vi.hoisted(() => ({ gdb: undefined as unknown, confirm: vi.fn() }));

vi.mock('@haive/shared/global-kb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared/global-kb')>();
  return {
    ...actual,
    resolveGlobalKbSettings: async () => ({
      ollamaUrl: null,
      embedModel: null,
      namespace: 'default',
    }),
    withGlobalKb: async (_db: unknown, fn: (ctx: unknown) => Promise<unknown>) =>
      fn({ db: h.gdb, settings: { namespace: 'default' } }),
  };
});
vi.mock('../src/step-engine/steps/_global-kb-similarity.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/step-engine/steps/_global-kb-similarity.js')>();
  return { ...actual, confirmSupersedeByEmbedding: h.confirm };
});

import { kbAuthorEnrichStep } from '../src/step-engine/steps/kb-author/01-enrich.js';

type Detected = Parameters<typeof kbAuthorEnrichStep.apply>[1]['detected'];

const BODY = '# T\n\n## The wrong way\n\nBad.\n\n## The right way\n\nGood.';

const llm = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ mode: 'new', category: 'best_practice', facets: {}, body: BODY, ...over });

function entry(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    namespace: 'default',
    title: `Entry ${id.slice(-2)}`,
    seedText: null,
    body: `body of ${id}`,
    category: 'best_practice',
    facets: {},
    status: 'active',
    source: 'user',
    description: null,
    updatedAt: new Date(Date.UTC(2026, 9, 3, 12, 0)),
    ...over,
  };
}

function setup(rows: Array<Record<string, unknown>>, task?: Record<string, unknown>) {
  const fake = createFakeDb({ tasks: schema.tasks, globalKbEntries });
  const noLocks = (handle: Record<string, unknown>) => ({ ...handle, execute: async () => {} });
  h.gdb = {
    ...fake.db,
    transaction: (fn: (tx: unknown) => Promise<unknown>) =>
      fake.db.transaction((tx) => fn(noLocks(tx as unknown as Record<string, unknown>))),
  };
  for (const row of rows) fake.insert(globalKbEntries, row);
  if (task) fake.insert(schema.tasks, task);
  const ctx = {
    db: fake.db,
    taskId: TASK,
    repoPath: '/nonexistent',
    logger: { warn() {}, info() {} },
  } as never;
  const stored = (id: string) => fake.rows(globalKbEntries).find((r) => r.id === id)!;
  return { ctx, stored };
}

const detected = (over: Record<string, unknown> = {}): Detected =>
  ({
    entryId: SKELETON,
    namespace: 'default',
    title: 'Never inline SVG',
    seedText: 'notes',
    existing: [],
    hasRepo: false,
    authorFacets: {},
    ...over,
  }) as unknown as Detected;

const skeleton = () =>
  entry(SKELETON, { status: 'enriching', seedText: 'notes', category: 'general' });

describe('kb enrich apply and the description', () => {
  beforeEach(() => {
    h.confirm.mockReset();
    h.confirm.mockResolvedValue(null);
  });

  it('stores the description the model wrote as one capped line', async () => {
    const { ctx, stored } = setup([skeleton()]);
    const out = await kbAuthorEnrichStep.apply!(ctx, {
      detected: detected(),
      llmOutput: llm({ description: '  Escape\nlabels  before markup. ' }),
      isFinalLlmAttempt: true,
    } as never);

    expect(stored(SKELETON).description).toBe('Escape labels before markup.');
    expect(out.scrubbed).toBeUndefined();
  });

  it('stores nothing when the model offered no usable description', async () => {
    for (const description of [undefined, 42, { text: 'x' }, '   ']) {
      const { ctx, stored } = setup([
        { ...skeleton(), description: 'left over from an earlier run' },
      ]);
      await kbAuthorEnrichStep.apply!(ctx, {
        detected: detected(),
        llmOutput: llm({ description }),
        isFinalLlmAttempt: true,
      } as never);
      expect(stored(SKELETON).description).toBeNull();
    }
  });

  it('removes a description that cites a codebase, and lists it with the scrubbed blocks', async () => {
    const { ctx, stored } = setup([skeleton()]);
    const cited = 'See web/modules/custom/acme/acme.module:9 for the hook.';
    const out = await kbAuthorEnrichStep.apply!(ctx, {
      detected: detected(),
      llmOutput: llm({ description: cited }),
      isFinalLlmAttempt: true,
    } as never);

    expect(stored(SKELETON).description).toBeNull();
    expect(out.scrubbed).toEqual([
      { reason: 'web/modules/custom/acme/acme.module:9', excerpt: cited },
    ]);
  });

  it('keeps the description the author stated, whatever the model proposes', async () => {
    const { ctx, stored } = setup([skeleton()]);
    await kbAuthorEnrichStep.apply!(ctx, {
      detected: detected({ authorDescription: 'Never inline SVG; reference a file.' }),
      llmOutput: llm({ description: 'Something the model wrote instead.' }),
      isFinalLlmAttempt: true,
    } as never);

    expect(stored(SKELETON).description).toBe('Never inline SVG; reference a file.');
  });
});

// Activation archives the replaced entry, so its description is lost unless the draft carries it.
describe('kb enrich apply and the description of the entry it replaces', () => {
  const target = (description: string | null) =>
    entry(SAME_NAMESPACE, { title: 'Existing', description });
  const shown = {
    id: SAME_NAMESPACE,
    title: 'Existing',
    category: 'best_practice',
    facets: {},
    excerpt: 'x',
  };
  const update = { mode: 'update', targetId: SAME_NAMESPACE };

  beforeEach(() => {
    h.confirm.mockReset();
    h.confirm.mockResolvedValue(SAME_NAMESPACE);
  });

  it('carries the description of the entry the model updates when the enrichment yields none', async () => {
    const { ctx, stored } = setup([skeleton(), target('Escape every interpolated label.')]);
    await kbAuthorEnrichStep.apply!(ctx, {
      detected: detected({ existing: [shown] }),
      llmOutput: llm(update),
      isFinalLlmAttempt: true,
    } as never);

    expect(stored(SKELETON).supersedesEntryId).toBe(SAME_NAMESPACE);
    expect(stored(SKELETON).description).toBe('Escape every interpolated label.');
  });

  it('carries it from an entry that appeared after detect, which the model never named', async () => {
    const { ctx, stored } = setup([skeleton(), target('Escape every interpolated label.')]);
    await kbAuthorEnrichStep.apply!(ctx, {
      detected: detected(),
      llmOutput: llm(),
      isFinalLlmAttempt: true,
    } as never);

    expect(stored(SKELETON).supersedesEntryId).toBe(SAME_NAMESPACE);
    expect(stored(SKELETON).description).toBe('Escape every interpolated label.');
  });

  it('keeps the description the model wrote over the one it replaces', async () => {
    const { ctx, stored } = setup([skeleton(), target('Escape every interpolated label.')]);
    await kbAuthorEnrichStep.apply!(ctx, {
      detected: detected({ existing: [shown] }),
      llmOutput: llm({ ...update, description: 'The model one-liner.' }),
      isFinalLlmAttempt: true,
    } as never);

    expect(stored(SKELETON).description).toBe('The model one-liner.');
  });

  it('keeps the description the author stated over the one it replaces', async () => {
    const { ctx, stored } = setup([skeleton(), target('Escape every interpolated label.')]);
    await kbAuthorEnrichStep.apply!(ctx, {
      detected: detected({
        existing: [shown],
        authorDescription: 'Never inline SVG; reference a file.',
      }),
      llmOutput: llm(update),
      isFinalLlmAttempt: true,
    } as never);

    expect(stored(SKELETON).description).toBe('Never inline SVG; reference a file.');
  });

  it('takes nothing from an entry it does not replace', async () => {
    h.confirm.mockResolvedValue(null);
    const { ctx, stored } = setup([skeleton(), target('Escape every interpolated label.')]);
    await kbAuthorEnrichStep.apply!(ctx, {
      detected: detected({ existing: [shown] }),
      llmOutput: llm(update),
      isFinalLlmAttempt: true,
    } as never);

    expect(stored(SKELETON).supersedesEntryId).toBeNull();
    expect(stored(SKELETON).description).toBeNull();
  });
});

// Neither the candidate query nor the proposed-target fetch filtered by namespace, so on a store that
// hosts several a draft could be recorded as superseding another namespace's entry, and activating it
// then archives that entry by id.
describe('kb enrich and namespaces', () => {
  beforeEach(() => {
    h.confirm.mockReset();
  });

  const existing = (id: string) => ({
    id,
    title: 'Existing',
    category: 'best_practice',
    facets: {},
    excerpt: 'x',
  });

  it('never offers another namespace entry as the update target', async () => {
    h.confirm.mockResolvedValue(OTHER_NAMESPACE);
    const { ctx, stored } = setup([skeleton(), entry(OTHER_NAMESPACE, { namespace: 'other' })]);
    const out = await kbAuthorEnrichStep.apply!(ctx, {
      detected: detected({ existing: [existing(OTHER_NAMESPACE)] }),
      llmOutput: llm({ mode: 'update', targetId: OTHER_NAMESPACE }),
      isFinalLlmAttempt: true,
    } as never);

    expect(h.confirm).not.toHaveBeenCalled();
    expect(stored(SKELETON).supersedesEntryId).toBeNull();
    expect(out.mode).toBe('new');
  });

  it('still offers a same-namespace entry, which is what the control above lacks', async () => {
    h.confirm.mockResolvedValue(SAME_NAMESPACE);
    const { ctx, stored } = setup([skeleton(), entry(SAME_NAMESPACE)]);
    const out = await kbAuthorEnrichStep.apply!(ctx, {
      detected: detected({ existing: [existing(SAME_NAMESPACE)] }),
      llmOutput: llm({ mode: 'update', targetId: SAME_NAMESPACE }),
      isFinalLlmAttempt: true,
    } as never);

    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.confirm.mock.calls[0]![2].map((c: { id: string }) => c.id)).toEqual([SAME_NAMESPACE]);
    expect(stored(SKELETON).supersedesEntryId).toBe(SAME_NAMESPACE);
    expect(out.mode).toBe('update');
  });

  it('shows the model only the entries of the namespace it writes into', async () => {
    const { ctx } = setup(
      [
        skeleton(),
        entry(SAME_NAMESPACE, { title: 'Same namespace' }),
        entry(OTHER_NAMESPACE, { namespace: 'other', title: 'Other namespace' }),
      ],
      {
        id: TASK,
        metadata: {
          globalKbEntryId: SKELETON,
          authorFacets: {},
          authorDescription: 'Never inline SVG.',
        },
        repositoryId: null,
      },
    );
    const out = await kbAuthorEnrichStep.detect!(ctx);

    expect(out.existing.map((e) => e.title)).toEqual(['Same namespace']);
    expect(out.authorDescription).toBe('Never inline SVG.');
  });

  it('reports no author description for a task that never recorded one', async () => {
    const { ctx } = setup([skeleton()], {
      id: TASK,
      metadata: { globalKbEntryId: SKELETON, authorFacets: {} },
      repositoryId: null,
    });

    expect((await kbAuthorEnrichStep.detect!(ctx)).authorDescription).toBeNull();
  });
});
