import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { globalKbEntries } from '@haive/shared/global-kb';

const h = vi.hoisted(() => ({ gdb: undefined as unknown }));

vi.mock('@haive/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared')>();
  return { ...actual, configService: { ...actual.configService, getBoolean: async () => true } };
});
vi.mock('@haive/shared/global-kb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared/global-kb')>();
  return {
    ...actual,
    resolveTaskFacets: async () => actual.emptyProjectFacetSet(),
    withGlobalKb: async (_db: unknown, fn: (ctx: unknown) => Promise<unknown>) =>
      fn({ db: h.gdb, settings: { namespace: 'default' } }),
  };
});

import { resolveGlobalKbContext } from '../src/orchestrator/global-kb-context.js';

const at = (minute: number): Date => new Date(Date.UTC(2026, 9, 3, 12, minute));

function seed(rows: Array<Record<string, unknown>>): void {
  const fake = createFakeDb({ globalKbEntries });
  for (const row of rows) {
    fake.insert(globalKbEntries, {
      namespace: 'default',
      status: 'active',
      supersededAt: null,
      facets: {},
      category: 'best_practice',
      description: null,
      ...row,
    });
  }
  h.gdb = fake.db;
}

describe('resolveGlobalKbContext and descriptions', () => {
  beforeEach(() => {
    seed([
      { title: 'Alpha', updatedAt: at(5), description: 'Escape\nevery label.' },
      { title: 'Bravo', updatedAt: at(4) },
      { title: 'Charlie', updatedAt: at(3), status: 'archived', description: 'Not advertised.' },
      { title: 'Delta', updatedAt: at(2), namespace: 'other', description: 'Not advertised.' },
      { title: 'Echo', updatedAt: at(1), description: `Long rule. ${'word '.repeat(100)}` },
    ]);
  });

  it('advertises the description of each live entry, normalised, and nothing else of the rest', async () => {
    const { digest } = await resolveGlobalKbContext({} as Database, 'task-1', {
      houseRules: false,
    });

    expect(digest.entries.map((e) => e.title)).toEqual(['Alpha', 'Bravo', 'Echo']);
    expect(digest.entries[0]).toEqual({
      title: 'Alpha',
      category: 'best_practice',
      description: 'Escape every label.',
    });
    expect(Object.keys(digest.entries[1]!)).toEqual(['title', 'category']);
    const capped = digest.entries[2]!.description!;
    expect(capped.length).toBeLessThanOrEqual(300);
    expect(capped.endsWith('…')).toBe(true);
  });
});
