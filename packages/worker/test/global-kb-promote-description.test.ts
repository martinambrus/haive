import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb, type FakeDbHandle } from '@haive/database/testing';
import { globalKbEntries } from '@haive/shared/global-kb';

const h = vi.hoisted(() => ({ gdb: undefined as unknown, confirm: vi.fn() }));

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
vi.mock('../src/step-engine/steps/_global-kb-similarity.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/step-engine/steps/_global-kb-similarity.js')>();
  return { ...actual, confirmSupersedeByEmbedding: h.confirm };
});

import {
  identicalPromotionTarget,
  inheritDescription,
  loadActiveGlobalArticlesForTask,
  promoteToGlobalKbDraft,
  resolveIdenticalPromotion,
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

type Query = ReturnType<ReturnType<FakeDbHandle['select']>['from']>;

// The fake db runs neither the candidates' `case when` order nor the advisory lock: insert in order.
function setupLinkable(rows: Array<Record<string, unknown>>) {
  const state = setup(rows);
  const base = h.gdb as FakeDbHandle;
  const unordered = (query: Query): Query => ({
    where: (cond) => unordered(query.where(cond)),
    orderBy: () => unordered(query),
    limit: (n) => unordered(query.limit(n)),
    for: () => unordered(query),
    then: (ok, bad) => query.then(ok, bad),
  });
  h.gdb = {
    ...base,
    transaction: (fn) =>
      base.transaction((tx) =>
        fn({
          ...tx,
          execute: async () => {},
          select: (fields) => ({ from: (table) => unordered(tx.select(fields).from(table)) }),
        }),
      ),
  } as FakeDbHandle;
  return state;
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

  it('keeps a project name that is a value the draft is scoped to', async () => {
    const { db, stored } = setup();
    await promoteToGlobalKbDraft(
      db,
      {
        ...promotion,
        title: 'Elmont routing',
        body: '# Elmont\n\nuse the elmont router',
        description: 'How Elmont routes.',
        facets: { framework: ['elmont'] },
        projectName: 'elmont',
      },
      log,
    );

    expect(stored()[0]).toMatchObject({
      title: 'Elmont routing',
      body: '# Elmont\n\nuse the elmont router\n',
      description: 'How Elmont routes.',
    });
  });

  describe('an identical body under the same topic', () => {
    const entry = (description: string | null) => ({
      id: 'e1',
      body: `${promotion.body}\n`,
      description,
    });

    it('is new when it brings a description the entry lacks', () => {
      expect(
        identicalPromotionTarget([entry(null)], promotion.body, 'Mock at the boundary.'),
      ).toBeUndefined();
    });

    it('is a duplicate when the entry already has a description, whatever the new one says', () => {
      expect(identicalPromotionTarget([entry('Mock it.')], promotion.body, 'Reworded.')?.id).toBe(
        'e1',
      );
    });

    it('is a duplicate when the promotion carries no description', () => {
      expect(identicalPromotionTarget([entry(null)], promotion.body, null)?.id).toBe('e1');
    });

    it('is new when the body differs', () => {
      expect(identicalPromotionTarget([entry('Mock it.')], '# Other', null)).toBeUndefined();
    });
  });

  describe('an identical body under the same topic, settled before any embedding is asked', () => {
    const entry = (id: string, description: string | null) => ({
      id,
      body: `${promotion.body}\n`,
      description,
    });
    const unrelated = { id: 'unrelated', body: '# Other', description: null };

    it('links a promotion that brings a description to the first identical entry lacking one', () => {
      const first = entry('first', null);

      expect(
        resolveIdenticalPromotion(
          [unrelated, first, entry('second', null)],
          promotion.body,
          'Mock at the boundary.',
        ),
      ).toEqual({ kind: 'link', target: first });
    });

    it('is a duplicate when the identical entry already has a description', () => {
      expect(
        resolveIdenticalPromotion([entry('e1', 'Mock it.')], promotion.body, 'Reworded.'),
      ).toMatchObject({ kind: 'duplicate', target: { id: 'e1' } });
    });

    it('is a duplicate when the promotion brings no description', () => {
      expect(resolveIdenticalPromotion([entry('e1', null)], promotion.body, null)).toMatchObject({
        kind: 'duplicate',
        target: { id: 'e1' },
      });
    });

    it('settles nothing when no body is identical', () => {
      expect(
        resolveIdenticalPromotion([unrelated, entry('e1', null)], '# Other topic', 'Mock it.'),
      ).toBeNull();
    });
  });

  describe('a draft that replaces an entry, and the description', () => {
    it('keeps its own, whatever the entry says', () => {
      expect(inheritDescription('Own one-liner.', 'Entry one-liner.')).toBe('Own one-liner.');
    });

    it("takes the entry's, as one line, when it has none", () => {
      for (const own of [undefined, null, '', ' \n ']) {
        expect(inheritDescription(own, ' Entry\none-liner. ')).toBe('Entry one-liner.');
      }
    });

    it('has none when neither does', () => {
      expect(inheritDescription(null, null)).toBeNull();
      expect(inheritDescription('', undefined)).toBeNull();
    });
  });

  describe('linking a same-topic entry', () => {
    const TOPIC = 'quick_reference:vitest';
    const ENTRY = '00000000-0000-4000-8000-0000000000a1';
    const live = (over: Record<string, unknown> = {}) => ({
      id: ENTRY,
      namespace: 'default',
      topicKey: TOPIC,
      status: 'active',
      category: 'quick_reference',
      facets: {},
      title: promotion.title,
      body: promotion.body,
      description: null,
      ...over,
    });
    const draftOf = (rows: Array<Record<string, unknown>>) => rows.find((r) => r.id !== ENTRY);

    beforeEach(() => {
      h.confirm.mockReset();
      h.confirm.mockResolvedValue(null);
    });

    it('links an identical body that only adds a description, without asking an embedding', async () => {
      const { db, stored } = setupLinkable([live()]);

      const out = await promoteToGlobalKbDraft(
        db,
        { ...promotion, topicKey: TOPIC, description: 'Mock at the boundary.' },
        log,
      );

      expect(out).toMatchObject({ deduped: false, supersedesEntryId: ENTRY });
      expect(h.confirm).not.toHaveBeenCalled();
      expect(draftOf(stored())).toMatchObject({
        status: 'draft',
        supersedesEntryId: ENTRY,
        description: 'Mock at the boundary.',
      });
    });

    it('still skips an identical body whose entry already has a description', async () => {
      const { db, stored } = setupLinkable([live({ description: 'Entry one-liner.' })]);

      const out = await promoteToGlobalKbDraft(
        db,
        { ...promotion, topicKey: TOPIC, description: 'Mock at the boundary.' },
        log,
      );

      expect(out).toEqual({ id: ENTRY, deduped: true, supersedesEntryId: null });
      expect(stored()).toHaveLength(1);
    });

    it('carries the description of the entry an embedding match replaces', async () => {
      h.confirm.mockResolvedValue(ENTRY);
      const { db, stored } = setupLinkable([
        live({ body: '# Vitest\n\nuse vi.mock and vi.hoisted', description: 'Entry one-liner.' }),
      ]);

      await promoteToGlobalKbDraft(db, { ...promotion, topicKey: TOPIC }, log);

      expect(draftOf(stored())).toMatchObject({
        supersedesEntryId: ENTRY,
        description: 'Entry one-liner.',
      });
    });

    it('takes nothing from an entry it does not replace', async () => {
      const { db, stored } = setupLinkable([
        live({ body: '# Vitest\n\nuse vi.mock and vi.hoisted', description: 'Entry one-liner.' }),
      ]);

      await promoteToGlobalKbDraft(db, { ...promotion, topicKey: TOPIC }, log);

      expect(draftOf(stored())).toMatchObject({ supersedesEntryId: null, description: null });
    });
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
