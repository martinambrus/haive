import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { globalKbEntries } from '@haive/shared/global-kb';

const DIMS = 8;
const OLLAMA = 'http://ollama.test';
const TASK = '00000000-0000-4000-8000-0000000000d2';

type Embed = { vector?: number[]; fail?: boolean };
type SearchConfig = { lexicalOnly?: boolean };

const h = vi.hoisted(() => ({
  gdb: undefined as unknown,
  embed: {} as Embed,
  ollamaUrl: null as string | null,
  search: vi.fn(),
}));

vi.mock('@haive/shared/global-kb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared/global-kb')>();
  return {
    ...actual,
    resolveTaskFacets: async () => actual.emptyProjectFacetSet(),
    withGlobalKb: async (_db: unknown, fn: (ctx: unknown) => Promise<unknown>) =>
      fn({
        conn: { pg: { unsafe: async () => [] } },
        db: h.gdb,
        settings: {
          namespace: 'default',
          ollamaUrl: h.ollamaUrl,
          embedModel: 'embed-model',
          embeddingDimensions: DIMS,
        },
      }),
  };
});
vi.mock('@haive/shared/rag', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/rag')>()),
  ragHybridSearch: (...args: unknown[]) => h.search(...args),
}));

import { loadActiveGlobalArticlesForTask } from '../src/step-engine/steps/_global-kb-promote.js';

beforeEach(() => {
  const fake = createFakeDb({ tasks: schema.tasks, globalKbEntries });
  h.gdb = fake.db;
  fake.insert(schema.tasks, { id: TASK, repositoryId: null });
  fake.insert(globalKbEntries, {
    namespace: 'default',
    status: 'active',
    supersededAt: null,
    facets: {},
    category: 'best_practice',
    title: 'Session cookies',
    body: 'Set the cookie httpOnly.',
    description: null,
    updatedAt: new Date(Date.UTC(2026, 9, 3, 12, 0)),
  });
  h.embed = { vector: Array(DIMS).fill(0.2) };
  h.ollamaUrl = OLLAMA;
  h.search.mockReset();
  h.search.mockResolvedValue([]);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (h.embed.fail) throw new Error('connection refused');
      return { ok: true, json: async () => ({ embeddings: [h.embed.vector] }) };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function rank(): Promise<{ vec: number[]; config: SearchConfig; titles: string[] }> {
  const out = await loadActiveGlobalArticlesForTask(
    h.gdb as never,
    TASK,
    'where is the session cookie set',
    15,
  );
  expect(h.search).toHaveBeenCalledTimes(1);
  const [, vec, , config] = h.search.mock.calls[0]!;
  return { vec, config, titles: out.articles.map((a) => a.title) };
}

describe('the global articles offered to a step, ranked by relevance', () => {
  it('ranks with the dense half when the query embeds', async () => {
    const { vec, config } = await rank();

    expect(vec).toEqual(h.embed.vector);
    expect(config.lexicalOnly).toBeFalsy();
  });

  it.each([
    { when: 'the embed fails', embed: { fail: true }, ollamaUrl: OLLAMA },
    {
      when: 'the vector is not the width of the index',
      embed: { vector: [0.1] },
      ollamaUrl: OLLAMA,
    },
    { when: 'no embedding endpoint is configured', embed: {}, ollamaUrl: null },
  ])('ranks on full text alone, never on a hash vector, when $when', async (failure) => {
    h.embed = failure.embed;
    h.ollamaUrl = failure.ollamaUrl;

    const { vec, config, titles } = await rank();

    expect(vec).toEqual([]);
    expect(config.lexicalOnly).toBe(true);
    expect(titles).toEqual(['Session cookies']);
  });
});
