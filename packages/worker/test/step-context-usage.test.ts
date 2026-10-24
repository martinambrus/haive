import { describe, expect, it } from 'vitest';
import type { CliTokenUsage } from '@haive/shared';
import type { Database } from '@haive/database';
import { writeStepContextUsage } from '../src/step-engine/step-context-usage.js';
import { createStreamJsonCollector } from '../src/queues/cli-exec-queue.js';

interface Inv {
  tokenUsage: CliTokenUsage | null;
  cliProviderId: string | null;
}

function fakeDb(invs: Inv[]) {
  const updates: Record<string, unknown>[] = [];
  const db = {
    select: () => ({ from: () => ({ where: async () => invs }) }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => {
          updates.push(patch);
        },
      }),
    }),
    query: {
      cliProviders: { findFirst: async () => ({ name: 'claude-code', model: null }) },
      usageWindowSnapshots: { findFirst: async () => undefined },
    },
  };
  return { db: db as unknown as Database, updates };
}

const usageOf = (i: number, o: number, r: number, w: number) => ({
  input_tokens: i,
  output_tokens: o,
  cache_read_input_tokens: r,
  cache_creation_input_tokens: w,
});

function collectorUsage(): CliTokenUsage {
  const c = createStreamJsonCollector();
  const events = [
    usageOf(10, 100, 50000, 30000),
    usageOf(8, 200, 85000, 15000),
    usageOf(6, 300, 110000, 10000),
  ].map((usage, i) => ({
    type: 'assistant',
    message: { id: `msg_${i}`, content: [{ type: 'text', text: 'x' }], usage },
  }));
  events.push({
    type: 'result',
    subtype: 'success',
    result: 'done',
    usage: usageOf(24, 600, 245000, 55000),
  } as never);
  for (const e of events) c.onChunk(JSON.stringify(e) + '\n');
  return c.getTokenUsage()!;
}

describe('writeStepContextUsage', () => {
  it('uses the collector peak, not the cumulative totals', async () => {
    const { db, updates } = fakeDb([{ tokenUsage: collectorUsage(), cliProviderId: 'p1' }]);
    expect(await writeStepContextUsage(db, 's1')).toBe('p1');
    expect(updates[0]).toMatchObject({
      contextTokens: 120006,
      contextWindowSize: 200000,
      contextLeftPercent: 40,
    });
  });

  it('falls back to the stored totals for a row without a peak', async () => {
    const { db, updates } = fakeDb([
      {
        tokenUsage: {
          inputTokens: 5,
          outputTokens: 1,
          totalTokens: 1006,
          cacheReadTokens: 800,
          cacheCreationTokens: 200,
        },
        cliProviderId: 'p1',
      },
    ]);
    await writeStepContextUsage(db, 's1');
    expect(updates[0]).toMatchObject({ contextTokens: 1005, contextLeftPercent: 99 });
  });

  it('picks the invocation with the largest peak and returns its provider', async () => {
    const { db, updates } = fakeDb([
      {
        tokenUsage: {
          inputTokens: 900000,
          outputTokens: 1,
          totalTokens: 900001,
          peakPromptTokens: 50000,
        },
        cliProviderId: 'A',
      },
      {
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 1,
          totalTokens: 101,
          peakPromptTokens: 90000,
        },
        cliProviderId: 'B',
      },
    ]);
    expect(await writeStepContextUsage(db, 's1')).toBe('B');
    expect(updates[0]).toMatchObject({ contextTokens: 90000 });
  });
});

describe('writeStepContextUsage window order', () => {
  function fakeDbFor(
    invs: Inv[],
    provider: { name: string; model: string | null },
    catalog?: { id: string; contextLength: number }[],
  ) {
    const updates: Record<string, unknown>[] = [];
    const db = {
      select: () => ({ from: () => ({ where: async () => invs }) }),
      update: () => ({
        set: (patch: Record<string, unknown>) => ({
          where: async () => {
            updates.push(patch);
          },
        }),
      }),
      query: {
        cliProviders: { findFirst: async () => provider },
        usageWindowSnapshots: { findFirst: async () => undefined },
        openrouterModelCache: {
          findFirst: async () => (catalog ? { models: catalog } : undefined),
        },
      },
    };
    return { db: db as unknown as Database, updates };
  }

  const recorded = (peak: number, contextWindow?: number | null): CliTokenUsage =>
    ({
      inputTokens: 10,
      outputTokens: 1,
      totalTokens: 11,
      peakPromptTokens: peak,
      ...(contextWindow === undefined ? {} : { contextWindow }),
    }) as CliTokenUsage;
  const claude = { name: 'claude-code', model: null };

  it('uses the window the invocation recorded', async () => {
    const { db, updates } = fakeDbFor(
      [{ tokenUsage: recorded(383759, 1000000), cliProviderId: 'p1' }],
      claude,
    );
    await writeStepContextUsage(db, 's1');
    expect(updates[0]).toMatchObject({
      contextTokens: 383759,
      contextWindowSize: 1000000,
      contextLeftPercent: 62,
    });
  });

  it('falls back to the static table when nothing was recorded', async () => {
    const { db, updates } = fakeDbFor(
      [{ tokenUsage: recorded(383759), cliProviderId: 'p1' }],
      claude,
    );
    await writeStepContextUsage(db, 's1');
    expect(updates[0]).toMatchObject({ contextWindowSize: 200000 });
  });

  it('ignores a recorded window of 0 or -1', async () => {
    for (const bad of [0, -1]) {
      const { db, updates } = fakeDbFor(
        [{ tokenUsage: recorded(1000, bad), cliProviderId: 'p1' }],
        claude,
      );
      await writeStepContextUsage(db, 's1');
      expect(updates[0], String(bad)).toMatchObject({ contextWindowSize: 200000 });
    }
  });

  it('prefers the OpenRouter catalog over a recorded window', async () => {
    const { db, updates } = fakeDbFor(
      [{ tokenUsage: recorded(1000, 1000000), cliProviderId: 'p1' }],
      { name: 'openrouter', model: 'vendor/small' },
      [{ id: 'vendor/small', contextLength: 64000 }],
    );
    await writeStepContextUsage(db, 's1');
    expect(updates[0]).toMatchObject({ contextWindowSize: 64000 });
  });

  it('uses the recorded window when the OpenRouter model is not in the catalog', async () => {
    const { db, updates } = fakeDbFor(
      [{ tokenUsage: recorded(1000, 1000000), cliProviderId: 'p1' }],
      { name: 'openrouter', model: 'vendor/unlisted' },
      [{ id: 'vendor/small', contextLength: 64000 }],
    );
    await writeStepContextUsage(db, 's1');
    expect(updates[0]).toMatchObject({ contextWindowSize: 1000000 });
  });

  it('takes the window of the peak invocation and returns its provider', async () => {
    const { db, updates } = fakeDbFor(
      [
        { tokenUsage: recorded(50000, 200000), cliProviderId: 'A' },
        { tokenUsage: recorded(90000, 1000000), cliProviderId: 'B' },
      ],
      claude,
    );
    expect(await writeStepContextUsage(db, 's1')).toBe('B');
    expect(updates[0]).toMatchObject({ contextTokens: 90000, contextWindowSize: 1000000 });
  });
});
