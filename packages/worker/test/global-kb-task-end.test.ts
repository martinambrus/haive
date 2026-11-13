import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { globalKbEntries, type GlobalKbStatus } from '@haive/shared/global-kb';

const h = vi.hoisted(() => ({ gdb: undefined as unknown, enabled: true }));
vi.mock('@haive/shared/global-kb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/global-kb')>()),
  resolveGlobalKbSettings: async () => ({ enabled: h.enabled }),
  withGlobalKb: async (_db: unknown, fn: (ctx: unknown) => Promise<unknown>) => fn({ db: h.gdb }),
}));

import { reconcileKbAuthorEntryOnTaskEnd } from '../src/step-engine/steps/_global-kb-promote.js';

const log = { warn: vi.fn(), info: vi.fn() };

function setup(status: GlobalKbStatus, type = 'kb_author') {
  const fake = createFakeDb({ tasks: schema.tasks, globalKbEntries });
  h.gdb = fake.db;
  const taskId = randomUUID();
  const userId = randomUUID();
  const entry = {
    id: randomUUID(),
    sourceTaskId: taskId,
    userId,
    status,
    enforcedHash: null,
  };
  fake.insert(schema.tasks, { id: taskId, userId, type });
  fake.insert(globalKbEntries, entry);
  return {
    entry,
    stored: () => fake.rows(globalKbEntries),
    insert: (row: Record<string, unknown>) => fake.insert(globalKbEntries, row),
    reconcile: (outcome: 'failed' | 'cancelled') =>
      reconcileKbAuthorEntryOnTaskEnd(fake.db as never, taskId, outcome, log),
  };
}

beforeEach(() => {
  h.enabled = true;
  log.warn.mockReset();
  log.info.mockReset();
});

describe('kb_author entry reconciliation on task end', () => {
  it('keeps the entry failed after Stop settlement, then deletes it on Cancel', async () => {
    const state = setup('enriching');

    // Stop's settle-stopped-task job calls the same failed settlement as the worker.
    await state.reconcile('failed');
    expect(state.stored()).toMatchObject([{ id: state.entry.id, status: 'failed' }]);

    await state.reconcile('cancelled');
    expect(state.stored()).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('deletes an entry left failed by a prior worker failure when Cancel arrives', async () => {
    const state = setup('failed');
    await state.reconcile('cancelled');
    expect(state.stored()).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each(['skeleton', 'enriching'] as const)(
    'still deletes its own %s entry on Cancel',
    async (status) => {
      const state = setup(status);
      await state.reconcile('cancelled');
      expect(state.stored()).toEqual([]);
      expect(log.warn).not.toHaveBeenCalled();
    },
  );

  it.each(['draft', 'active', 'archived'] as const)(
    'keeps a %s article on Cancel',
    async (status) => {
      const state = setup(status);
      await state.reconcile('cancelled');
      expect(state.stored()).toMatchObject([state.entry]);
      expect(log.warn).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['another task', { sourceTaskId: randomUUID() }],
    ['another user', { userId: randomUUID() }],
    ['no owner', { userId: null }],
    ['an approval', { enforcedHash: 'approved-content-hash' }],
  ])('keeps an unfinished entry with %s', async (_name, changes) => {
    const state = setup('enriching');
    const protectedEntry = { ...state.entry, id: randomUUID(), ...changes };
    state.insert(protectedEntry);
    await state.reconcile('cancelled');
    expect(state.stored()).toMatchObject([protectedEntry]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('keeps foreign and approved failed entries while deleting its own failed entry', async () => {
    const state = setup('failed');
    const protectedEntries = [
      { ...state.entry, id: randomUUID(), sourceTaskId: randomUUID() },
      { ...state.entry, id: randomUUID(), userId: randomUUID() },
      { ...state.entry, id: randomUUID(), enforcedHash: 'approved-content-hash' },
    ];
    for (const entry of protectedEntries) state.insert(entry);
    await state.reconcile('cancelled');
    expect(state.stored()).toMatchObject(protectedEntries);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('does nothing for another task type', async () => {
    const state = setup('enriching', 'workflow');
    await state.reconcile('cancelled');
    expect(state.stored()).toMatchObject([state.entry]);
  });

  it('does nothing while the global KB is disabled', async () => {
    const state = setup('enriching');
    h.enabled = false;
    await state.reconcile('cancelled');
    expect(state.stored()).toMatchObject([state.entry]);
  });
});
