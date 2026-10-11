import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashEmbed } from '@haive/shared/rag';

type Row = { id: number; content: string; vec: number[]; kind: string | null };

const h = vi.hoisted(() => ({
  rows: [] as Row[],
  updates: [] as Array<{ sql: string; params: unknown[] }>,
  hasVector: true,
  enabled: true,
  storeError: null as Error | null,
  connected: 0,
}));

vi.mock('@haive/shared/global-kb', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveGlobalKbEnabled: async () => h.enabled,
  withGlobalKb: async (_db: unknown, fn: (ctx: unknown) => Promise<void>) => {
    h.connected += 1;
    if (h.storeError) throw h.storeError;
    const pg = {
      unsafe: async (sql: string, params: unknown[] = []) => {
        if (sql.includes('information_schema')) return h.hasVector ? [{ '?column?': 1 }] : [];
        if (sql.trimStart().startsWith('SELECT')) {
          const after = params[0] as number;
          const limit = params[1] as number;
          return h.rows
            .filter((r) => r.kind === null && r.id > after)
            .sort((a, b) => a.id - b.id)
            .slice(0, limit)
            .map((r) => ({
              id: r.id,
              content: r.content,
              v: h.hasVector ? `[${r.vec.join(',')}]` : r.vec,
            }));
        }
        h.updates.push({ sql, params });
        const ids = (params[1] as string).slice(1, -1).split(',').map(Number);
        for (const r of h.rows) {
          if (ids.includes(r.id) && r.kind === null) r.kind = params[0] as string;
        }
        return [];
      },
    };
    await fn({ conn: { pg, embeddingDimensions: 8 }, settings: { namespace: 'house' } });
  },
}));

import { classifyGlobalKbVectorProvenance } from '../src/global-kb-vector-provenance.js';

const randomUnit = (seed: number): number[] => {
  const v = Array.from({ length: 8 }, (_, i) => Math.sin(seed * 12.9898 + i * 78.233));
  const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
  return v.map((x) => x / n);
};
const row = (id: number, content: string, vec: number[], kind: string | null = null): Row => ({
  id,
  content,
  vec,
  kind,
});
const kinds = () => Object.fromEntries(h.rows.map((r) => [r.id, r.kind]));

beforeEach(() => {
  h.rows = [];
  h.updates = [];
  h.hasVector = true;
  h.enabled = true;
  h.storeError = null;
  h.connected = 0;
});

describe.each([
  ['pgvector', true],
  ['jsonb', false],
])(
  'classifying global KB vectors written before provenance, on a %s store',
  (_label, hasVector) => {
    beforeEach(() => {
      h.hasVector = hasVector;
    });

    it('marks a vector that is the hash of its own text hashed, and any other one model', async () => {
      h.rows = [
        row(
          1,
          'a chunk written with no embedder',
          hashEmbed('a chunk written with no embedder', 8),
        ),
        row(2, 'a chunk the model embedded', randomUnit(2)),
      ];
      await classifyGlobalKbVectorProvenance({} as never);

      expect(kinds()).toEqual({ 1: 'hashed', 2: 'model' });
    });

    it('writes nothing for a row that is already classified, and nothing on a second run', async () => {
      h.rows = [
        row(1, 'classified', hashEmbed('classified', 8), 'model'),
        row(2, 'legacy', randomUnit(3)),
      ];
      await classifyGlobalKbVectorProvenance({} as never);
      const first = h.updates.length;
      await classifyGlobalKbVectorProvenance({} as never);

      expect(kinds()).toEqual({ 1: 'model', 2: 'model' });
      expect(first).toBe(1);
      expect(h.updates).toHaveLength(first);
      for (const update of h.updates) expect(update.sql).toContain('embed_kind IS NULL');
    });

    it('classifies across several batches and never deletes', async () => {
      h.rows = Array.from({ length: 450 }, (_, i) =>
        i % 3 === 0
          ? row(i + 1, `text ${i}`, hashEmbed(`text ${i}`, 8))
          : row(i + 1, `text ${i}`, randomUnit(i + 10)),
      );
      await classifyGlobalKbVectorProvenance({} as never);

      expect(h.rows.every((r) => r.kind === ((r.id - 1) % 3 === 0 ? 'hashed' : 'model'))).toBe(
        true,
      );
      for (const update of h.updates) expect(update.sql).not.toMatch(/DELETE/i);
    });

    it('leaves a row whose vector cannot be read unclassified, and still finishes', async () => {
      h.rows = [row(1, 'broken', [] as number[]), row(2, 'fine', randomUnit(5))];
      await classifyGlobalKbVectorProvenance({} as never);

      expect(kinds()).toEqual({ 1: null, 2: 'model' });
    });
  },
);

describe('classifying global KB vectors when the store is not there', () => {
  it('does not connect to a disabled global KB', async () => {
    h.enabled = false;
    await classifyGlobalKbVectorProvenance({} as never);

    expect(h.connected).toBe(0);
  });

  it('logs and returns when the store is unreachable', async () => {
    h.storeError = new Error('connect ECONNREFUSED');

    await expect(classifyGlobalKbVectorProvenance({} as never)).resolves.toBeUndefined();
  });
});
