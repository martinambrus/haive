import { randomUUID } from 'node:crypto';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { lockPlanMerge } from '../src/plan/merge-lock.js';
import { lockPlanPatch, tryLockPlanPatch } from '../src/plan/patch-lock.js';
import { lockTaskIntegrations, tryLockTaskIntegrations } from '../src/integrations/task-lock.js';

const id = randomUUID();
const spellings = [
  ['uppercase', id.toUpperCase()],
  ['unhyphenated', id.replaceAll('-', '').toUpperCase()],
  ['braced', `{${id}}`],
] as const;

function recorder(rows: unknown[]) {
  const keys: string[] = [];
  const tx = {
    execute: async (query: SQL) => {
      const q = new PgDialect().sqlToQuery(query);
      if (/advisory/i.test(q.sql)) keys.push(String(q.params[0]));
      return rows;
    },
  };
  return { keys, tx };
}

const sinks: Array<[string, string, unknown[], (tx: never, spelled: string) => Promise<unknown>]> =
  [
    ['lockPlanMerge', 'plan-merge:', [], (tx, s) => lockPlanMerge(tx, s)],
    ['lockPlanPatch', 'plan-patch:', [], (tx, s) => lockPlanPatch(tx, s)],
    ['tryLockPlanPatch', 'plan-patch:', [], (tx, s) => tryLockPlanPatch(tx, s)],
    ['lockTaskIntegrations', 'task-integrations:', [], (tx, s) => lockTaskIntegrations(tx, s)],
    [
      'tryLockTaskIntegrations',
      'task-integrations:',
      [{ locked: true }],
      (tx, s) => tryLockTaskIntegrations(tx, s),
    ],
  ];

describe('lock key spelling', () => {
  for (const [name, prefix, rows, call] of sinks) {
    const keysFor = async (spelled: string) => {
      const { keys, tx } = recorder(rows);
      await call(tx as never, spelled);
      return keys;
    };
    describe(name, () => {
      it('keys a canonical id with the text it always keyed', async () => {
        expect((await keysFor(id)).join(' ')).toBe(`${prefix}${id}`);
      });
      for (const [label, spelled] of spellings) {
        it(`takes one key for the ${label} spelling of one id`, async () => {
          expect((await keysFor(spelled)).join(' ')).toBe((await keysFor(id)).join(' '));
        });
      }
    });
  }
});
