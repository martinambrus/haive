import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/db.js', () => ({ getDb: () => undefined }));

import { schema } from '@haive/database';
import { activeProviderIds } from '../src/routes/usage-window.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const P1 = '00000000-0000-4000-8000-0000000000c1';
const P2 = '00000000-0000-4000-8000-0000000000c2';
const P3 = '00000000-0000-4000-8000-0000000000c3';
const day = (n: number) => new Date(Date.UTC(2026, 0, n));

type Row = Record<string, unknown>;

/** A builder that accepts any chain and resolves to the canned rows of the table given to from(). */
function stubDb(tables: { running?: Row[]; live?: Row[]; providers?: Row[] }) {
  const rowsFor = (table: unknown): Row[] => {
    if (table === schema.tasks) return tables.running ?? [];
    if (table === schema.cliInvocations) return tables.live ?? [];
    if (table === schema.cliProviders) return tables.providers ?? [];
    return [];
  };
  const builder = (rows: Row[]) => {
    const b: Record<string, unknown> = {};
    for (const m of ['innerJoin', 'leftJoin', 'where', 'orderBy', 'limit']) b[m] = () => b;
    b.then = (resolve: (v: Row[]) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject);
    return b;
  };
  return {
    select: () => ({ from: (table: unknown) => builder(rowsFor(table)) }),
    query: { cliProviders: { findMany: async () => tables.providers ?? [] } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const provider = (id: string, n: number, enabled = true): Row => ({
  id,
  userId: USER,
  enabled,
  createdAt: day(n),
});

describe('activeProviderIds', () => {
  it('counts the default provider for a running task with no CLI of its own', async () => {
    const db = stubDb({
      running: [{ providerId: null }],
      providers: [provider(P2, 2), provider(P1, 1), provider(P3, 3)],
    });
    expect(await activeProviderIds(db, USER)).toContain(P1);
  });

  it("counts a running task's own CLI", async () => {
    const db = stubDb({ running: [{ providerId: P2 }], providers: [provider(P1, 1)] });
    expect(await activeProviderIds(db, USER)).toEqual([P2]);
  });

  it('still unions the provider of a live invocation', async () => {
    const db = stubDb({
      running: [{ providerId: P2 }],
      live: [{ providerId: P3 }],
      providers: [provider(P1, 1)],
    });
    expect((await activeProviderIds(db, USER)).sort()).toEqual([P2, P3]);
  });

  it('adds nothing for a running no-CLI task when no provider is enabled', async () => {
    const db = stubDb({
      running: [{ providerId: null }],
      live: [{ providerId: P3 }],
      providers: [provider(P1, 1, false)],
    });
    expect(await activeProviderIds(db, USER)).toEqual([P3]);
  });

  it('lists each provider once', async () => {
    const db = stubDb({
      running: [{ providerId: P2 }, { providerId: P2 }],
      live: [{ providerId: P2 }],
      providers: [provider(P2, 2)],
    });
    expect(await activeProviderIds(db, USER)).toEqual([P2]);
  });
});
