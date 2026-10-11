import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  kinds: [] as Array<'embedded' | 'hashed'>,
  inserts: [] as Array<{ sql: string; params: unknown[] }>,
  hasVector: true,
}));

const ENTRY = {
  id: '0000000a-0000-4000-8000-00000000000a',
  namespace: 'house',
  userId: null,
  title: 'House rule',
  status: 'active',
  facets: {},
  body: '# House rule\n\n## First\n\nThe first section has its own prose.\n\n## Second\n\nThe second section has other prose.\n',
};

vi.mock('../src/db.js', () => ({ getDb: () => ({}) }));
vi.mock('../src/step-engine/steps/_rag-embed-health.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveEmbedBatchSize: async () => 1,
  embedBatch: async ({ texts }: { texts: string[] }) => {
    const kind = h.kinds.shift() ?? 'embedded';
    return { kind, embeddings: texts.map(() => [0.1, 0.2]) };
  },
}));
vi.mock('@haive/shared/global-kb', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withGlobalKb: async (_db: unknown, fn: (ctx: unknown) => Promise<void>) => {
    const tx = {
      unsafe: async (sql: string, params: unknown[] = []) => {
        if (sql.includes('SELECT status, title, body, facets')) {
          return [{ status: ENTRY.status, title: ENTRY.title, body: ENTRY.body, facets: {} }];
        }
        if (sql.startsWith('INSERT INTO ai_rag_embeddings')) h.inserts.push({ sql, params });
        return [];
      },
    };
    const pg = {
      unsafe: async (sql: string) =>
        sql.includes('information_schema') ? (h.hasVector ? [{ '?column?': 1 }] : []) : [],
      begin: async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    };
    await fn({
      conn: {
        pg,
        ollamaUrl: 'http://embed.invalid:11434',
        embedModel: 'embed-model',
        embeddingDimensions: 2,
      },
      db: { query: { globalKbEntries: { findFirst: async () => ENTRY } } },
    });
  },
}));

import { syncGlobalKbEntry } from '../src/queues/global-kb-sync-queue.js';

const sync = () =>
  syncGlobalKbEntry({ entryId: ENTRY.id, namespace: ENTRY.namespace, reason: 'upsert' } as never);

beforeEach(() => {
  h.kinds = [];
  h.inserts = [];
  h.hasVector = true;
});

describe('the global KB sync records how each vector was made', () => {
  it.each([
    ['pgvector', true],
    ['jsonb', false],
  ])(
    'writes a per-row kind from a strict-off batch mix, and the model only for a model row, on a %s store',
    async (_label, hasVector) => {
      h.hasVector = hasVector;
      h.kinds = ['embedded', 'hashed'];
      await sync();

      expect(h.inserts).toHaveLength(2);
      for (const insert of h.inserts) {
        expect(insert.sql).toContain('embed_kind, embed_model');
      }
      const provenance = h.inserts.map((i) => i.params.slice(-2));
      expect(provenance).toEqual([
        ['model', 'embed-model'],
        ['hashed', null],
      ]);
    },
  );

  it('records an all-model entry as model', async () => {
    h.kinds = ['embedded', 'embedded'];
    await sync();

    expect(h.inserts.map((i) => i.params.slice(-2))).toEqual([
      ['model', 'embed-model'],
      ['model', 'embed-model'],
    ]);
  });
});
