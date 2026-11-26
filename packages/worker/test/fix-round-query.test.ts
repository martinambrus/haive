import { expect, it, vi } from 'vitest';
import type { StepContext } from '@haive/shared/step';
import { PgDialect } from 'drizzle-orm/pg-core';
import { isFixRound } from '../src/step-engine/steps/workflow/_fix-loop.js';

it('reads only the round scalar, without fetching diagnosis payloads', async () => {
  const where = vi.fn(async () => [{ round: 2 }]);
  const select = vi.fn((_fields: Record<string, unknown>) => ({ from: () => ({ where }) }));
  const ctx = { db: { select }, taskId: 'task', round: 2 } as unknown as StepContext;
  expect(await isFixRound(ctx)).toBe(true);
  expect(select).toHaveBeenCalledOnce();
  const fields = select.mock.calls[0]![0] as Record<string, unknown>;
  expect(Object.keys(fields)).toEqual(['round']);
  const dialect = new PgDialect();
  expect(dialect.sqlToQuery(fields.round as Parameters<PgDialect['sqlToQuery']>[0]).sql).toBe(
    '"task_events"."payload"->\'round\'',
  );
});
