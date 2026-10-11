import { GLOBAL_KB_JOB_NAMES } from '@haive/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Entry = {
  id: string;
  namespace: string;
  status: string;
  superseded: boolean;
  embedStatus: string;
};
type Row = { entryId: string; kind: string | null; model: string | null; width?: number };

const h = vi.hoisted(() => ({
  model: 'model-b',
  entries: [] as Array<{
    id: string;
    namespace: string;
    status: string;
    superseded: boolean;
    embedStatus: string;
  }>,
  rows: [] as Array<{ entryId: string; kind: string | null; model: string | null; width?: number }>,
  pending: [] as Array<{ id: string; namespace: string }>,
  live: [] as Array<{ name: string; data: unknown }>,
  added: [] as Array<{ name: string; data: { entryId: string; reason: string } }>,
  statements: [] as string[],
  columnWidth: 4 as number | null,
  ollamaUp: true,
  probeWidth: 4,
  probe: vi.fn(async (..._args: unknown[]): Promise<number[][]> => []),
  warn: vi.fn(),
}));

vi.mock('../src/db.js', () => ({ getDb: () => ({}) }));
vi.mock('../src/redis.js', () => ({ getBullRedis: () => ({}) }));
vi.mock('../src/global-kb-vector-provenance.js', () => ({
  classifyGlobalKbVectorProvenance: async () => {},
}));
vi.mock('bullmq', () => ({
  Worker: class {},
  Queue: class {
    getJobs = async () => h.live;
    add = async (name: string, data: { entryId: string; reason: string }) => {
      h.added.push({ name, data });
    };
    close = async () => {};
  },
}));
vi.mock('@haive/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared')>();
  return {
    ...actual,
    logger: { child: () => ({ info: () => {}, error: () => {}, debug: () => {}, warn: h.warn }) },
  };
});
vi.mock('@haive/shared/rag', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/rag')>()),
  probeOllama: async () => h.ollamaUp,
  ollamaEmbed: async (...args: unknown[]) => {
    await h.probe(...args);
    return [Array.from({ length: h.probeWidth }, () => 0.1)];
  },
}));
vi.mock('@haive/shared/global-kb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/global-kb')>()),
  retryOwedGlobalIdentifierBackfill: async () => {},
  resolveGlobalKbSettings: async () => ({
    enabled: true,
    ollamaUrl: 'http://ollama.invalid:11434',
    embedModel: h.model,
    namespace: 'house',
    embeddingDimensions: 4,
  }),
  withGlobalKb: async (_db: unknown, fn: (ctx: unknown) => Promise<unknown>) =>
    fn({
      db: { select: () => ({ from: () => ({ where: async () => h.pending }) }) },
      conn: {
        pg: {
          unsafe: async (text: string, params: unknown[] = []) => {
            h.statements.push(text);
            if (text.includes('information_schema')) {
              return h.columnWidth === null ? [] : [{ '?column?': 1 }];
            }
            if (text.includes('pg_attribute')) {
              return h.columnWidth === null ? [] : [{ type: `vector(${h.columnWidth})` }];
            }
            if (text.includes('IS DISTINCT FROM')) {
              return h.entries
                .filter((e: Entry) => e.status === 'active' && !e.superseded)
                .filter((e: Entry) => e.namespace === params[1])
                .filter(
                  (e: Entry) =>
                    e.embedStatus === 'failed' ||
                    h.rows.some(
                      (r: Row) =>
                        r.entryId === e.id &&
                        (r.kind !== 'model' ||
                          r.model !== params[0] ||
                          (params.length > 2 && (r.width ?? 4) !== params[2])),
                    ),
                )
                .sort((a: Entry, b: Entry) => (a.id < b.id ? -1 : 1))
                .map((e: Entry) => ({ id: e.id, namespace: e.namespace }));
            }
            throw new Error(`the sweep issued an unexpected statement: ${text}`);
          },
        },
      },
    }),
}));

const { reconcilePendingGlobalKbSyncs } = await import('../src/queues/global-kb-sync-queue.js');

const entry = (id: string, over: Partial<Entry> = {}): Entry => ({
  id,
  namespace: 'house',
  status: 'active',
  superseded: false,
  embedStatus: 'embedded',
  ...over,
});
const rowOf = (entryId: string, model: string | null, kind: string | null = 'model'): Row => ({
  entryId,
  kind,
  model,
});
const queued = () => h.added.map((a) => a.data.entryId);
const sweep = async () => {
  h.added = [];
  await reconcilePendingGlobalKbSyncs();
  return queued();
};

beforeEach(() => {
  h.model = 'model-b';
  h.entries = [];
  h.rows = [];
  h.pending = [];
  h.live = [];
  h.added = [];
  h.statements = [];
  h.columnWidth = 4;
  h.ollamaUp = true;
  h.probeWidth = 4;
  h.probe.mockClear();
  h.warn.mockClear();
});

describe('the reconcile sweep re-embeds entries whose vectors drifted', () => {
  it('queues each entry whose rows were written by another model of the same width', async () => {
    h.entries = [entry('e1'), entry('e2'), entry('e3')];
    h.rows = [rowOf('e1', 'model-a'), rowOf('e2', 'model-a'), rowOf('e3', 'model-b')];

    expect(await sweep()).toEqual(['e1', 'e2']);
    expect(h.added.every((a) => a.data.reason === 'upsert')).toBe(true);
  });

  it('queues an entry holding a hash row, with the embedder up and of the store width', async () => {
    h.entries = [entry('e1')];
    h.rows = [rowOf('e1', null, 'hashed'), rowOf('e1', 'model-b')];

    expect(await sweep()).toEqual(['e1']);
  });

  it('queues a pre-provenance row once, then nothing when its rows carry the model', async () => {
    h.entries = [entry('e1')];
    h.rows = [rowOf('e1', null)];

    expect(await sweep()).toEqual(['e1']);
    h.rows = [rowOf('e1', 'model-b')];
    expect(await sweep()).toEqual([]);
  });

  it('leaves archived, superseded and row-less entries alone', async () => {
    h.entries = [
      entry('archived', { status: 'archived' }),
      entry('superseded', { superseded: true }),
      entry('rowless'),
    ];
    h.rows = [rowOf('archived', 'model-a'), rowOf('superseded', 'model-a')];

    expect(await sweep()).toEqual([]);
    expect(h.probe).not.toHaveBeenCalled();
  });

  it('does not queue an entry whose upsert is already waiting', async () => {
    h.entries = [entry('e1'), entry('e2')];
    h.rows = [rowOf('e1', 'model-a'), rowOf('e2', 'model-a')];
    h.live = [
      {
        name: GLOBAL_KB_JOB_NAMES.SYNC_ENTRY,
        data: { entryId: 'e1', namespace: 'house', reason: 'upsert' },
      },
    ];

    expect(await sweep()).toEqual(['e2']);
  });

  it('queues an entry once when it is both pending and drifted', async () => {
    h.entries = [entry('e1')];
    h.rows = [rowOf('e1', 'model-a')];
    h.pending = [{ id: 'e1', namespace: 'house' }];

    expect(await sweep()).toEqual(['e1']);
  });

  it('queues nothing, and warns, when the embedder does not answer', async () => {
    h.entries = [entry('e1')];
    h.rows = [rowOf('e1', 'model-a')];
    h.ollamaUp = false;

    expect(await sweep()).toEqual([]);
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.probe).not.toHaveBeenCalled();
  });

  it('queues nothing, and warns, when the probe embed is not the width of the column', async () => {
    h.entries = [entry('e1')];
    h.rows = [rowOf('e1', 'model-a')];
    h.probeWidth = 3;

    expect(await sweep()).toEqual([]);
    expect(h.warn).toHaveBeenCalledTimes(1);
  });

  it('reads the width from the column, not from the configured one', async () => {
    h.entries = [entry('e1')];
    h.rows = [rowOf('e1', 'model-a')];
    h.columnWidth = 3;
    h.probeWidth = 4;

    expect(await sweep()).toEqual([]);
  });

  it('queues nothing, and warns, when the probe embed fails', async () => {
    h.entries = [entry('e1')];
    h.rows = [rowOf('e1', 'model-a')];
    h.probe.mockRejectedValueOnce(new Error('Ollama embed failed (500)'));

    expect(await sweep()).toEqual([]);
    expect(h.warn).toHaveBeenCalledTimes(1);
  });

  it('queues at most the per-sweep cap, lowest ids first', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `e${String(i).padStart(2, '0')}`);
    h.entries = ids.map((id) => entry(id));
    h.rows = ids.map((id) => rowOf(id, 'model-a'));

    const first = await sweep();

    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThanOrEqual(20);
    expect(first).toEqual(ids.slice(0, first.length));
  });

  it('queues a failed entry under the same gate, whatever its rows', async () => {
    h.entries = [entry('failed', { embedStatus: 'failed' }), entry('fine')];
    h.rows = [rowOf('failed', 'model-b'), rowOf('fine', 'model-b')];

    expect(await sweep()).toEqual(['failed']);
    h.ollamaUp = false;
    expect(await sweep()).toEqual([]);
    h.ollamaUp = true;
    h.probeWidth = 3;
    expect(await sweep()).toEqual([]);
  });

  it('counts failed entries in the per-sweep cap, and leaves archived and superseded ones', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `f${String(i).padStart(2, '0')}`);
    h.entries = [
      ...ids.map((id) => entry(id, { embedStatus: 'failed' })),
      entry('archived', { status: 'archived', embedStatus: 'failed' }),
      entry('superseded', { superseded: true, embedStatus: 'failed' }),
    ];

    const first = await sweep();

    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThanOrEqual(20);
    expect(first).toEqual(ids.slice(0, first.length));
  });

  it('writes nothing: the sweep issues only reads', async () => {
    h.entries = [entry('e1')];
    h.rows = [rowOf('e1', 'model-a')];
    await sweep();

    expect(h.statements.every((text) => /^\s*SELECT/i.test(text))).toBe(true);
  });

  it('on a jsonb store, queues an entry whose rows are of another width', async () => {
    h.columnWidth = null;
    h.entries = [entry('e1'), entry('e2')];
    h.rows = [
      { entryId: 'e1', kind: 'model', model: 'model-b', width: 3 },
      { entryId: 'e2', kind: 'model', model: 'model-b', width: 4 },
    ];

    expect(await sweep()).toEqual(['e1']);
    const drift = h.statements.find((t) => t.includes('IS DISTINCT FROM'))!;
    expect(drift).toContain('jsonb_array_length(r.embedding_json)');
  });

  it('checks no row width on a pgvector store, whose column fixes it', async () => {
    h.entries = [entry('e1')];
    h.rows = [{ entryId: 'e1', kind: 'model', model: 'model-b', width: 3 }];

    expect(await sweep()).toEqual([]);
    expect(h.statements.find((t) => t.includes('IS DISTINCT FROM'))).not.toContain('jsonb');
  });

  it("leaves another namespace's entries to the install that owns them", async () => {
    h.entries = [entry('e1'), { ...entry('e2'), namespace: 'other' }];
    h.rows = [rowOf('e1', 'model-a'), rowOf('e2', 'model-a')];

    expect(await sweep()).toEqual(['e1']);
    expect(h.statements.find((t) => t.includes('IS DISTINCT FROM'))).toContain('e.namespace = $2');
  });
});
