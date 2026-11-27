import { randomUUID } from 'node:crypto';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/index.js';
import { lockRepositoryTasksKey } from '../src/repository-task-lock.js';
import { withTaskAttachmentsLock, type DbTx } from '../src/task-attachments-lock.js';

const id = randomUUID();
const spellings = [
  ['uppercase', id.toUpperCase()],
  ['unhyphenated', id.replaceAll('-', '').toUpperCase()],
  ['braced', `{${id}}`],
] as const;

function recorder() {
  const keys: string[] = [];
  const tx = {
    execute: async (query: SQL) => {
      const q = new PgDialect().sqlToQuery(query);
      if (/advisory/i.test(q.sql)) keys.push(String(q.params[0]));
      return [];
    },
  } as unknown as DbTx;
  return { keys, tx };
}

const sinks: Array<[string, string, (spelled: string) => Promise<string[]>]> = [
  [
    'lockRepositoryTasksKey',
    'onboarding-upgrade:',
    async (spelled) => {
      const { keys, tx } = recorder();
      await lockRepositoryTasksKey(tx, spelled);
      return keys;
    },
  ],
  [
    'withTaskAttachmentsLock',
    'task-attachments:',
    async (spelled) => {
      const { keys, tx } = recorder();
      const handle = { transaction: (fn: (t: DbTx) => Promise<unknown>) => fn(tx) };
      await withTaskAttachmentsLock(handle as unknown as Database, spelled, async () => undefined);
      return keys;
    },
  ],
];

describe('lock key spelling', () => {
  for (const [name, prefix, run] of sinks) {
    describe(name, () => {
      it('keys a canonical id with the text it always keyed', async () => {
        expect((await run(id)).join(' ')).toBe(`${prefix}${id}`);
      });
      for (const [label, spelled] of spellings) {
        it(`takes one key for the ${label} spelling of one id`, async () => {
          expect((await run(spelled)).join(' ')).toBe((await run(id)).join(' '));
        });
      }
    });
  }
});
