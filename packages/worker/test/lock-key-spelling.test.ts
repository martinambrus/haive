import { randomUUID } from 'node:crypto';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { lockProjectState } from '../src/project-state/write.js';
import { lockPlanMirror } from '../src/plan/mirror.js';
import { supersedeTaskRuns } from '../src/sandbox/cli-sandbox-fence.js';
import { runModuleSourceFetch } from '../src/modules/source-jobs.js';

const id = randomUUID();
const spellings = [
  ['uppercase', id.toUpperCase()],
  ['unhyphenated', id.replaceAll('-', '').toUpperCase()],
  ['braced', `{${id}}`],
] as const;

/** An execute that records each advisory key drizzle would bind and answers with `rows`. */
function recorder(rows: unknown[]) {
  const keys: string[] = [];
  const execute = async (query: SQL) => {
    const q = new PgDialect().sqlToQuery(query);
    if (/advisory/i.test(q.sql)) keys.push(String(q.params[0]));
    return rows;
  };
  // A no-op update chain: every call returns the chain, awaiting it resolves.
  const chain: unknown = new Proxy(() => chain, {
    get: (_t, prop) => (prop === 'then' ? (ok: (v: unknown) => void) => ok(undefined) : chain),
    apply: () => chain,
  });
  const tx = { execute, update: () => chain };
  return { keys, tx, db: { transaction: async (fn: (t: unknown) => unknown) => fn(tx) } };
}

const sinks: Array<[string, string, (spelled: string) => Promise<string[]>]> = [
  [
    'lockProjectState',
    'project-state:',
    async (spelled) => {
      const { keys, tx } = recorder([]);
      await lockProjectState(tx as never, spelled);
      return keys;
    },
  ],
  [
    'lockPlanMirror',
    '',
    async (spelled) => {
      const { keys, tx } = recorder([]);
      await lockPlanMirror(tx as never, spelled);
      return keys;
    },
  ],
  [
    'supersedeTaskRuns',
    'cli-sandbox:',
    async (spelled) => {
      const { keys, db } = recorder([{ ok: true }]);
      await supersedeTaskRuns(db as never, spelled);
      return keys;
    },
  ],
  [
    'runModuleSourceFetch',
    'module-source:',
    async (spelled) => {
      const { keys, db } = recorder([{ held: false }]);
      await runModuleSourceFetch(db as never, spelled);
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
