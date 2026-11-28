import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGlobalKbDb } from '@haive/shared/global-kb';

const url = process.env.GKB_CONSUMED_PROMOTIONS_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/gkb_consumed_promotions_test'))
  throw new Error('Use a dedicated gkb_consumed_promotions_test database');

// Only the store lookup is replaced: the probe's own query runs on a real server, since the
// fake database cannot evaluate a recursive CTE.
const h = vi.hoisted(() => ({ gdb: undefined as unknown }));
vi.mock('@haive/shared/global-kb', async (original) => ({
  ...(await original<object>()),
  resolveGlobalKbSettings: async () => ({ enabled: true }),
  withGlobalKb: async (_db: unknown, fn: (ctx: { db: unknown }) => Promise<unknown>) =>
    fn({ db: h.gdb }),
}));
import { findConsumedTaskPromotions } from '../src/step-engine/steps/_global-kb-promote.js';

const TASK = randomUUID();
const OTHER_TASK = randomUUID();
const log = { warn: vi.fn(), info: vi.fn() };

describe.skipIf(!url)('consumed promotions: the successor chain, on Postgres', () => {
  let kb: ReturnType<typeof postgres>;

  beforeAll(async () => {
    kb = postgres(url!, { max: 1 });
    h.gdb = createGlobalKbDb(kb);
    // The probe reads only these columns. The production store is a separate database, so there
    // is no foreign key from `supersedes_entry_id`: a successor can outlive its predecessor.
    await kb`create table if not exists global_kb_entries (
      id uuid primary key, source_task_id uuid, source text, status text,
      supersedes_entry_id uuid, superseded_at timestamp)`;
  });

  afterAll(async () => {
    await kb?.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await kb`truncate global_kb_entries`;
    log.warn.mockReset();
  });

  type Row = {
    status: string;
    task?: string;
    source?: string;
    replaces?: string | null;
    stamped?: boolean;
  };
  /** `replaces` is the predecessor this row points at; `stamped` is the supersession stamp. */
  const add = async (row: Row, id = randomUUID()) => {
    await kb`insert into global_kb_entries
      (id, source_task_id, source, status, supersedes_entry_id, superseded_at)
      values (${id}, ${row.task ?? TASK}, ${row.source ?? 'promoted'}, ${row.status},
        ${row.replaces ?? null}, case when ${row.stamped ?? false}::boolean then now() end)`;
    return id;
  };
  const consumed = async (...ids: string[]) => [
    ...(await findConsumedTaskPromotions({} as never, TASK, ids, log)),
  ];

  // Negative controls: they pass without the chain walk and must keep passing.
  it('counts an active promotion', async () => {
    const active = await add({ status: 'active' });
    expect(await consumed(active)).toEqual([active]);
  });

  it('counts nothing else of the task: a draft, a hand-archived draft, another task or a person', async () => {
    const draft = await add({ status: 'draft' });
    const rejected = await add({ status: 'archived' });
    const otherTask = await add({ status: 'active', task: OTHER_TASK });
    const written = await add({ status: 'active', source: 'user' });
    expect(await consumed(draft, rejected, otherTask, written, randomUUID())).toEqual([]);
  });

  it('does not count an archived promotion whose replacement is a draft', async () => {
    const original = await add({ status: 'archived', stamped: true });
    await add({ status: 'draft', replaces: original });
    expect(await consumed(original)).toEqual([]);
  });

  it('counts an archived promotion whose replacement is active', async () => {
    const original = await add({ status: 'archived', stamped: true });
    await add({ status: 'active', replaces: original });
    expect(await consumed(original)).toEqual([original]);
  });

  it('follows a chain of replacements to the active one', async () => {
    const original = await add({ status: 'archived', stamped: true });
    const second = await add({ status: 'archived', stamped: true, replaces: original });
    await add({ status: 'active', replaces: second });
    expect(await consumed(original)).toEqual([original]);
  });

  // The review of #1408: a stamp proves a replacement was activated once, not that one is live.
  it('does not count an archived promotion whose replacement was archived', async () => {
    const original = await add({ status: 'archived', stamped: true });
    await add({ status: 'archived', replaces: original });
    expect(await consumed(original)).toEqual([]);
  });

  it('does not count an archived promotion whose replacement was deleted', async () => {
    const original = await add({ status: 'archived', stamped: true });
    expect(await consumed(original)).toEqual([]);
  });

  it('does not count a chain that ends archived', async () => {
    const original = await add({ status: 'archived', stamped: true });
    const second = await add({ status: 'archived', stamped: true, replaces: original });
    await add({ status: 'archived', replaces: second });
    expect(await consumed(original)).toEqual([]);
  });

  it('counts an archived promotion with an active replacement, stamp or no stamp', async () => {
    const unstamped = await add({ status: 'archived' });
    await add({ status: 'active', replaces: unstamped });
    expect(await consumed(unstamped)).toEqual([unstamped]);
  });

  it('decides each promotion on its own chain', async () => {
    const live = await add({ status: 'archived', stamped: true });
    await add({ status: 'active', replaces: live });
    const dead = await add({ status: 'archived', stamped: true });
    await add({ status: 'archived', replaces: dead });
    const active = await add({ status: 'active' });
    expect((await consumed(live, dead, active)).sort()).toEqual([live, active].sort());
  });

  it('ends on a cycle among archived entries', async () => {
    const a = randomUUID();
    const b = randomUUID();
    await add({ status: 'archived', stamped: true, replaces: b }, a);
    await add({ status: 'archived', stamped: true, replaces: a }, b);
    const self = randomUUID();
    await add({ status: 'archived', stamped: true, replaces: self }, self);
    expect(await consumed(a, b, self)).toEqual([]);
  });

  it('counts a promotion whose cycle contains an active entry', async () => {
    const a = randomUUID();
    const b = randomUUID();
    await add({ status: 'archived', stamped: true, replaces: b }, a);
    await add({ status: 'active', replaces: a }, b);
    expect(await consumed(a)).toEqual([a]);
  });

  it('follows at most 20 replacements', async () => {
    const chain = async (hops: number) => {
      const root = await add({ status: 'archived', stamped: true });
      let previous = root;
      for (let i = 1; i < hops; i += 1)
        previous = await add({ status: 'archived', replaces: previous });
      await add({ status: 'active', replaces: previous });
      return root;
    };
    const reachable = await chain(20);
    const beyond = await chain(21);
    expect(await consumed(reachable, beyond)).toEqual([reachable]);
  });
});
