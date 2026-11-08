import { schema, type DbTx } from '@haive/database';
import type { getDb } from '../db.js';

export async function appendTaskEvent(
  db: ReturnType<typeof getDb> | DbTx,
  taskId: string,
  taskStepId: string | null,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(schema.taskEvents).values({
    taskId,
    taskStepId,
    eventType,
    payload,
  });
}
