import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Database } from '@haive/database';
import type { HouseRulesStamp } from '@haive/shared/global-kb';
import { resolveEmbedBudget } from '@haive/shared/rag';

const h = vi.hoisted(() => ({
  text: 'Add a cart icon\nShow it in the header.',
  embed: vi.fn(async (..._args: unknown[]): Promise<number[][]> => [[0.6, 0.8]]),
  rows: [] as Array<{ id: string; score: number | string }>,
  storeError: null as Error | null,
  storeCalls: [] as Array<{ sql: string; params: unknown[] }>,
  storeOptions: [] as unknown[],
  settings: {
    namespace: 'default',
    ollamaUrl: 'http://embed.invalid:11434',
    embedModel: 'embed-model',
    embeddingDimensions: 2,
  } as Record<string, unknown>,
}));

vi.mock('../src/orchestrator/house-rules-dispatch.js', () => ({
  readTaskText: async () => h.text,
}));
vi.mock('@haive/shared/rag', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ollamaEmbed: h.embed,
}));
vi.mock('@haive/shared/global-kb', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveGlobalKbSettings: async () => h.settings,
  withGlobalKb: async (
    _db: unknown,
    fn: (ctx: { db: unknown }) => Promise<unknown>,
    options: unknown,
  ) => {
    h.storeOptions.push(options);
    if (h.storeError) throw h.storeError;
    const tx = {
      execute: async (query: SQL) => {
        const built = new PgDialect().sqlToQuery(query);
        h.storeCalls.push({ sql: built.sql, params: built.params });
        return built.sql.includes('ai_rag_embeddings') ? h.rows : [];
      },
    };
    return fn({ db: { transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx) } });
  },
}));

import {
  SIMILARITY_QUERY_MAX_CHARS,
  scoreHouseRulesInBackground,
} from '../src/orchestrator/house-rules-similarity.js';

const INV = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const A = '0000000a-0000-4000-8000-00000000000a';
const B = '0000000b-0000-4000-8000-00000000000b';
const C = '0000000c-0000-4000-8000-00000000000c';

const candidate = (id: string, title: string) => ({ id, hash: `hr1:${title}`, title, score: null });
const pendingStamp = (ids: Array<[string, string]> = [[A, 'Alpha']]): HouseRulesStamp => ({
  mode: 'write',
  entries: [],
  omitted: [],
  similarity: { status: 'pending', scores: ids.map(([id, title]) => candidate(id, title)) },
});

const updates: Array<{ sql: string; params: unknown[] }> = [];
let updateFails = false;
const db = {
  execute: async (query: SQL) => {
    const built = new PgDialect().sqlToQuery(query);
    updates.push({ sql: built.sql, params: built.params });
    if (updateFails) throw new Error('database is down');
    return [];
  },
} as unknown as Database;

const recordWritten = async (): Promise<Record<string, unknown>> => {
  await vi.waitFor(() => expect(updates).toHaveLength(1));
  return JSON.parse(updates[0]!.params[0] as string) as Record<string, unknown>;
};

beforeEach(() => {
  updates.length = 0;
  updateFails = false;
  h.text = 'Add a cart icon\nShow it in the header.';
  h.rows = [];
  h.storeError = null;
  h.storeCalls = [];
  h.storeOptions = [];
  h.embed.mockReset();
  h.embed.mockResolvedValue([[0.6, 0.8]]);
});
afterEach(() => vi.restoreAllMocks());

describe('scoring the unmatched files rules of a write dispatch', () => {
  it('amends the pending record with the best cosine per rule, null for a rule with no vector', async () => {
    h.rows = [
      { id: A, score: '0.8123456' },
      { id: C, score: 0.25 },
    ];
    scoreHouseRulesInBackground(
      db,
      INV,
      TASK,
      pendingStamp([
        [A, 'Alpha'],
        [B, 'Beta'],
        [C, 'Gamma'],
      ]),
    );
    const record = await recordWritten();

    expect(Object.keys(record).sort()).toEqual(['model', 'ms', 'queryHash', 'scores', 'status']);
    expect(record).toMatchObject({
      status: 'ok',
      model: 'embed-model',
      queryHash: createHash('sha256').update(h.text).digest('hex'),
    });
    expect(typeof record.ms).toBe('number');
    expect(record.scores).toEqual([
      { ...candidate(A, 'Alpha'), score: 0.8123456 },
      candidate(B, 'Beta'),
      { ...candidate(C, 'Gamma'), score: 0.25 },
    ]);
  });

  it('embeds the task text once, on the default budget, and binds the ids as a text literal', async () => {
    scoreHouseRulesInBackground(
      db,
      INV,
      TASK,
      pendingStamp([
        [A, 'Alpha'],
        [B, 'Beta'],
      ]),
    );
    await recordWritten();

    expect(h.embed).toHaveBeenCalledExactlyOnceWith('http://embed.invalid:11434', 'embed-model', [
      h.text,
    ]);
    const read = h.storeCalls.find((call) => call.sql.includes('ai_rag_embeddings'))!;
    expect(read.params).toContain(`{${A},${B}}`);
    expect(read.sql).toContain('embed_status');
    expect(h.storeCalls[0]!.sql).toContain('statement_timeout');
    expect(h.storeOptions[0]).toMatchObject({ deadlineMs: 6_000, settings: h.settings });
  });

  it('scores through a cold embedder load that outlasts the old 30 s budget', async () => {
    const coldLoadMs = 42_800;
    const { embedTimeoutMs } = await resolveEmbedBudget();
    h.embed.mockImplementation(async (...args: unknown[]) => {
      const budget = (args[3] as { timeoutMs?: number } | undefined)?.timeoutMs ?? embedTimeoutMs;
      if (coldLoadMs > budget) throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
      return [[0.6, 0.8]];
    });
    h.rows = [{ id: A, score: 0.5 }];
    scoreHouseRulesInBackground(db, INV, TASK, pendingStamp());
    const record = await recordWritten();

    expect(record.status).toBe('ok');
  });

  it('embeds a bounded query, cut between characters', async () => {
    h.text = `${'a'.repeat(SIMILARITY_QUERY_MAX_CHARS - 1)}\u{1f600}tail`;
    scoreHouseRulesInBackground(db, INV, TASK, pendingStamp());
    const record = await recordWritten();

    const embedded = (h.embed.mock.calls[0]![2] as string[])[0]!;
    expect(embedded).toBe('a'.repeat(SIMILARITY_QUERY_MAX_CHARS - 1));
    expect(record.queryHash).toBe(createHash('sha256').update(embedded).digest('hex'));
  });

  it('amends only a row whose record is still pending, and writes nothing else', async () => {
    scoreHouseRulesInBackground(db, INV, TASK, pendingStamp());
    await recordWritten();

    const { sql: text, params } = updates[0]!;
    expect(text).toContain('jsonb_set(house_rules');
    expect(text).toContain("house_rules->'similarity'->>'status' = 'pending'");
    expect(params).toContain(INV);
  });

  it.each([
    [
      'an embedder that times out',
      () => h.embed.mockRejectedValue(Object.assign(new Error('x'), { name: 'TimeoutError' })),
      'timeout',
    ],
    [
      'an embedder that refuses the connection',
      () =>
        h.embed.mockRejectedValue(
          Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
        ),
      'refused',
    ],
    [
      'an embedder that answers 500',
      () => h.embed.mockRejectedValue(new Error('Ollama embed failed (500): host embed.invalid')),
      'other',
    ],
    [
      'a vector of another width than the index',
      () => h.embed.mockResolvedValue([[0.1, 0.2, 0.3]]),
      'other',
    ],
    ['an embedder that returns nothing', () => h.embed.mockResolvedValue([]), 'other'],
    [
      'a store that outlives its deadline',
      () => {
        h.storeError = Object.assign(new Error('global KB call exceeded 6000 ms'), {
          code: 'GLOBAL_KB_DEADLINE',
        });
      },
      'timeout',
    ],
    [
      'a store that refuses a login',
      () => {
        h.storeError = Object.assign(new Error('password for kb.internal.example'), {
          code: '28P01',
        });
      },
      'auth',
    ],
  ])(
    'records failed and the class, and nothing of the error, for %s',
    async (_label, arm, errorClass) => {
      arm();
      scoreHouseRulesInBackground(db, INV, TASK, pendingStamp());
      const record = await recordWritten();

      expect(record).toStrictEqual({ status: 'failed', errorClass });
    },
  );

  it('records failed for a task with no text to compare, without embedding', async () => {
    h.text = ' \n \n';
    scoreHouseRulesInBackground(db, INV, TASK, pendingStamp());

    expect(await recordWritten()).toStrictEqual({ status: 'failed', errorClass: 'other' });
    expect(h.embed).not.toHaveBeenCalled();
  });

  it('never throws, nor leaves a rejection, when the amendment itself cannot be written', async () => {
    updateFails = true;
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    scoreHouseRulesInBackground(db, INV, TASK, pendingStamp());
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off('unhandledRejection', unhandled);

    expect(unhandled).not.toHaveBeenCalled();
  });

  it('does nothing for a stamp that is absent, has no record, or holds one that is not pending', async () => {
    const base: HouseRulesStamp = { mode: 'write', entries: [], omitted: [] };
    const stamps: Array<HouseRulesStamp | null> = [
      null,
      base,
      { ...base, similarity: { status: 'pending', scores: [] } },
      { ...base, similarity: { status: 'ok', scores: [candidate(A, 'Alpha')] } },
      { ...base, similarity: { status: 'failed', errorClass: 'timeout' } },
    ];
    for (const stamp of stamps) scoreHouseRulesInBackground(db, INV, TASK, stamp);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(h.embed).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(h.storeOptions).toEqual([]);
  });
});
