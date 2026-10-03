import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { globalKbEntries } from '@haive/shared/global-kb';

const h = vi.hoisted(() => ({ gdb: undefined as unknown }));

vi.mock('@haive/shared/global-kb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared/global-kb')>();
  return {
    ...actual,
    resolveTaskFacets: async () => actual.emptyProjectFacetSet(),
    withGlobalKb: async (_db: unknown, fn: (ctx: unknown) => Promise<unknown>) =>
      fn({
        conn: {},
        db: h.gdb,
        settings: { namespace: 'default', ollamaUrl: null, embedModel: null },
      }),
  };
});

import {
  loadActiveGlobalArticlesForTask,
  promoteToGlobalKbDraft,
} from '../src/step-engine/steps/_global-kb-promote.js';

const log = { warn: vi.fn(), info: vi.fn() };
const TASK = '00000000-0000-4000-8000-0000000000d1';
const USER = '00000000-0000-4000-8000-0000000000e1';

function setup(rows: Array<Record<string, unknown>> = []) {
  const fake = createFakeDb({ tasks: schema.tasks, globalKbEntries });
  h.gdb = fake.db;
  for (const row of rows) fake.insert(globalKbEntries, row);
  fake.insert(schema.tasks, { id: TASK, repositoryId: null });
  return { db: fake.db as never, stored: () => fake.rows(globalKbEntries) };
}

describe('promoteToGlobalKbDraft and the description', () => {
  const promotion = {
    userId: USER,
    taskId: TASK,
    title: 'Vitest Quick Reference',
    body: '# Vitest\n\nuse vi.mock',
    category: 'quick_reference' as const,
    facets: { packages: ['vitest@3'] },
  };

  beforeEach(() => {
    log.warn.mockReset();
    log.info.mockReset();
  });

  it('stores it as one capped line', async () => {
    const { db, stored } = setup();
    await promoteToGlobalKbDraft(
      db,
      { ...promotion, description: ` Mock modules\nat the boundary. ${'word '.repeat(100)}` },
      log,
    );

    const [row] = stored();
    expect(row!.description).toMatch(/^Mock modules at the boundary\. word word/);
    expect((row!.description as string).length).toBeLessThanOrEqual(300);
    expect((row!.description as string).endsWith('…')).toBe(true);
  });

  it('takes the source project name out of it, like the title and the body', async () => {
    const { db, stored } = setup();
    await promoteToGlobalKbDraft(
      db,
      { ...promotion, projectName: 'siteray', description: 'Mock @siteray/database in Vitest.' },
      log,
    );

    expect(stored()[0]!.description).toBe('Mock @example-app/database in Vitest.');
  });

  it('stores null when there is none, or when it is blank', async () => {
    for (const description of [undefined, null, '', ' \n ']) {
      const { db, stored } = setup();
      await promoteToGlobalKbDraft(db, { ...promotion, description }, log);
      expect(stored()[0]!.description).toBeNull();
    }
  });
});

describe('loadActiveGlobalArticlesForTask and descriptions', () => {
  const row = (title: string, minute: number, description: string | null) => ({
    namespace: 'default',
    status: 'active',
    supersededAt: null,
    facets: {},
    category: 'best_practice',
    title,
    body: `body of ${title}`,
    description,
    updatedAt: new Date(Date.UTC(2026, 9, 3, 12, minute)),
  });

  it('lists the other titles with their descriptions, index for index', async () => {
    const { db } = setup([
      row('First', 5, 'Shown in full.'),
      row('Second', 4, 'Escape\nlabels.'),
      row('Third', 3, null),
      row('Fourth', 2, `Long rule. ${'word '.repeat(100)}`),
    ]);

    const out = await loadActiveGlobalArticlesForTask(db, TASK, '', 1);

    expect(out.articles.map((a) => a.title)).toEqual(['First']);
    expect(out.otherTitles).toEqual(['Second', 'Third', 'Fourth']);
    expect(out.otherDescriptions).toHaveLength(3);
    expect(out.otherDescriptions[0]).toBe('Escape labels.');
    expect(out.otherDescriptions[1]).toBeNull();
    expect(out.otherDescriptions[2]!.length).toBeLessThanOrEqual(300);
    expect(out.otherDescriptions[2]!.endsWith('…')).toBe(true);
  });
});
