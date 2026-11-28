import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { createFakeDb } from '@haive/database/testing';
import { GlobalKbDeadlineError, globalKbEntries } from '@haive/shared/global-kb';

const h = vi.hoisted(() => ({ gdb: undefined as unknown, enabled: true, withKb: vi.fn() }));

vi.mock('@haive/shared/global-kb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared/global-kb')>();
  return {
    ...actual,
    resolveGlobalKbSettings: async () => ({ enabled: h.enabled }),
    withGlobalKb: h.withKb,
  };
});

import { findConsumedTaskPromotions } from '../src/step-engine/steps/_global-kb-promote.js';

const TASK = randomUUID();
const OTHER_TASK = randomUUID();
const log = { warn: vi.fn(), info: vi.fn() };

type Over = Partial<{ sourceTaskId: string; source: string; status: string; supersededAt: Date }>;
const row = (over: Over = {}) => ({
  id: randomUUID(),
  sourceTaskId: TASK,
  source: 'promoted',
  status: 'draft',
  supersededAt: null,
  ...over,
});

beforeEach(() => {
  h.enabled = true;
  h.withKb.mockReset();
  h.withKb.mockImplementation(async (_db: unknown, fn: (ctx: unknown) => Promise<unknown>) =>
    fn({ db: h.gdb }),
  );
  log.warn.mockReset();
});

function store(rows: ReturnType<typeof row>[]) {
  const fake = createFakeDb({ globalKbEntries });
  h.gdb = fake.db;
  for (const r of rows) fake.insert(globalKbEntries, r);
}

it('names only this task promotions whose knowledge a live entry holds', async () => {
  const pending = row();
  const active = row({ status: 'active' });
  // Replaced by an active successor: its knowledge is live there.
  const superseded = row({ status: 'archived', supersededAt: new Date() });
  // Archived by hand is a rejection: no live entry holds it, so a Retry restores the file.
  const rejected = row({ status: 'archived' });
  const otherTask = row({ sourceTaskId: OTHER_TASK, status: 'active' });
  const written = row({ source: 'user', status: 'active' });
  const all = [pending, active, superseded, rejected, otherTask, written];
  store(all);
  const got = await findConsumedTaskPromotions(
    {} as never,
    TASK,
    [...all.map((r) => r.id), randomUUID()],
    log,
  );
  expect([...got].sort()).toEqual([active.id, superseded.id].sort());
});

it('does not open the store when no id is given or the global KB is off', async () => {
  store([row({ status: 'active' })]);
  expect((await findConsumedTaskPromotions({} as never, TASK, [], log)).size).toBe(0);
  h.enabled = false;
  expect((await findConsumedTaskPromotions({} as never, TASK, [randomUUID()], log)).size).toBe(0);
  expect(h.withKb).not.toHaveBeenCalled();
});

it('reports nothing durable on an ordinary outage, so a Retry restores as before', async () => {
  store([]);
  h.withKb.mockRejectedValue(new Error('connection refused'));
  const got = await findConsumedTaskPromotions({} as never, TASK, [randomUUID()], log);
  expect(got.size).toBe(0);
  expect(log.warn).toHaveBeenCalledTimes(1);
});

it('propagates a store timeout and an aborted owner', async () => {
  store([]);
  h.withKb.mockRejectedValue(new GlobalKbDeadlineError(12));
  await expect(
    findConsumedTaskPromotions({} as never, TASK, [randomUUID()], log),
  ).rejects.toBeInstanceOf(GlobalKbDeadlineError);
  const owner = new AbortController();
  owner.abort();
  h.withKb.mockRejectedValue(new Error('connection refused'));
  await expect(
    findConsumedTaskPromotions({} as never, TASK, [randomUUID()], log, { signal: owner.signal }),
  ).rejects.toThrow();
});
