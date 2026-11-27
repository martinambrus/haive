import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/pg-proxy';
import type { Database } from '@haive/database';
import { enrichStepsWithCliStats } from '../src/routes/tasks/_helpers.js';

// Execute the production count expressions and scope predicates in memory. The
// unrelated token/cost aggregates and RAG read have their own suites.
function setup() {
  const store = new DatabaseSync(':memory:');
  store.exec(`
    create table cli_invocations (id text, task_id text, task_step_id text,
      summary_for_step_id text, cli_provider_id text, mode text, superseded_at text,
      consumed_at text);
    create table cli_providers (id text);
    create table task_events (id text, task_id text, task_step_id text, event_type text);
  `);
  const proxy = drizzle(async (query, params) => {
    const bindings: SQLInputValue[] = [];
    const sqliteQuery = query
      .replace(/::int\b/g, '')
      .replace(/\$(\d+)/g, (_match, index: string) => {
        bindings.push(params[Number(index) - 1] as SQLInputValue);
        return '?';
      });
    const rows = store.prepare(sqliteQuery).all(...bindings);
    return { rows: rows.map((row) => Object.values(row)) };
  });
  const db = {
    select: (fields: Record<string, unknown>) => {
      if ('ragQueryCount' in fields) {
        const chain = {
          from: () => chain,
          innerJoin: () => chain,
          where: () => chain,
          groupBy: async () => [],
        };
        return chain;
      }
      const kept = Object.fromEntries(
        Object.entries(fields).filter(([key]) =>
          ['stepId', 'count', 'attemptCount', 'rejectedReplyCount'].includes(key),
        ),
      );
      return proxy.select(kept as never);
    },
  } as unknown as Database;
  const insert = (
    id: string,
    opts: {
      rejected?: boolean;
      mode?: string;
      superseded?: boolean;
      task?: string;
      step?: string | null;
      consumed?: boolean;
    } = {},
  ) => {
    const task = opts.task ?? 'task';
    const step = opts.step === undefined ? 'step' : opts.step;
    store
      .prepare('insert into cli_invocations values (?, ?, ?, ?, null, ?, ?, ?)')
      .run(
        id,
        task,
        step,
        step === null ? 'step' : null,
        opts.mode ?? 'llm',
        opts.superseded ? '2026-11-27' : null,
        opts.consumed === false ? null : '2026-11-27',
      );
    if (opts.rejected)
      store
        .prepare('insert into task_events values (?, ?, ?, ?)')
        .run(id, task, step, 'step.reply_rejected');
  };
  const stats = () => enrichStepsWithCliStats(db, 'task', [{ id: 'step' }, { id: 'empty' }]);
  return { store, insert, stats };
}

describe('step rejected-reply counts', () => {
  it('keeps planned successful multi-call continuations out of the rejection count', async () => {
    const { store, insert, stats } = setup();
    try {
      for (let i = 0; i < 4; i++) insert(`planned-${i}`);
      expect((await stats())[0]).toMatchObject({ attemptCount: 4, rejectedReplyCount: 0 });
    } finally {
      store.close();
    }
  });

  it('counts rejected replies that were consumed for redispatch, independently of planned calls', async () => {
    const { store, insert, stats } = setup();
    try {
      insert('rejected-1', { rejected: true });
      insert('rejected-2', { rejected: true });
      insert('planned');
      insert('latest', { consumed: false });
      insert('reset', { rejected: true, superseded: true });
      insert('foreign-task', { rejected: true, task: 'other' });
      insert('foreign-step', { rejected: true, step: 'other' });
      insert('mining', { rejected: true, mode: 'agent_mining' });
      insert('dag', { rejected: true, mode: 'dag_parallel' });
      insert('recap', { rejected: true, step: null });
      insert('not-consumed', { rejected: true, consumed: false });
      expect((await stats())[0]).toMatchObject({ attemptCount: 5, rejectedReplyCount: 2 });
      expect((await stats())[1]).toMatchObject({ attemptCount: 0, rejectedReplyCount: 0 });
    } finally {
      store.close();
    }
  });
});
