import { and, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  IDE_ENSURE_JOB_NAMES,
  repoIdeSessionId,
  type IdeEnsurePayload,
  type IdeEnsureResult,
} from '@haive/shared';
import { getDb } from '../db.js';
import { getIdeEnsureQueue, getIdeEnsureQueueEvents } from '../queues.js';
import { boundedAdd } from './queue-bounded.js';

const IDE_ENSURE_TIMEOUT_MS = 180_000;

export interface IdeTarget {
  sessionId: string;
  prefix: string;
  payload: IdeEnsurePayload;
}

export function ideTarget(id: string, userId: string, repository = false): IdeTarget {
  return {
    sessionId: repository ? repoIdeSessionId(id) : id,
    prefix: repository ? `/ide/repos/${id}` : `/ide/${id}`,
    payload: repository ? { repositoryId: id, userId } : { taskId: id, userId },
  };
}

export async function targetBelongsToUser(target: IdeTarget): Promise<boolean> {
  const db = getDb();
  const { userId, repositoryId, taskId } = target.payload;
  const row = repositoryId
    ? await db.query.repositories.findFirst({
        where: and(
          eq(schema.repositories.id, repositoryId),
          eq(schema.repositories.userId, userId),
        ),
        columns: { id: true },
      })
    : await db.query.tasks.findFirst({
        where: and(eq(schema.tasks.id, taskId!), eq(schema.tasks.userId, userId)),
        columns: { id: true },
      });
  return row != null;
}

export async function ensureIde(target: IdeTarget): Promise<IdeEnsureResult> {
  // Bounded: during a Redis outage the add would otherwise wait forever, and the readiness
  // timeout below starts only once it returns. The job id coalesces a late add.
  const job = await boundedAdd(() =>
    getIdeEnsureQueue().add(IDE_ENSURE_JOB_NAMES.ENSURE, target.payload, {
      jobId: `ensure-ide-${target.sessionId}`,
      removeOnComplete: true,
      removeOnFail: true,
    }),
  );
  return (await job.waitUntilFinished(
    getIdeEnsureQueueEvents(),
    IDE_ENSURE_TIMEOUT_MS,
  )) as IdeEnsureResult;
}
