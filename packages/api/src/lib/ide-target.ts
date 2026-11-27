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

/** Ready/epoch admission is repeated after long ensures. An old Editor cookie cannot silently
 * reconnect and start writing to a new checkout; a new handshake is an explicit reopen. */
export async function ideCheckoutState(target: IdeTarget) {
  const db = getDb();
  const repositoryId =
    target.payload.repositoryId ??
    (
      await db.query.tasks.findFirst({
        where: eq(schema.tasks.id, target.payload.taskId!),
        columns: { repositoryId: true },
      })
    )?.repositoryId;
  if (!repositoryId) return { repositoryId: null, status: 'ready', epoch: null };
  const repo = await db.query.repositories.findFirst({
    where: eq(schema.repositories.id, repositoryId),
    columns: { status: true },
  });
  const { getRedis } = await import('../redis.js');
  return {
    repositoryId,
    status: repo?.status ?? 'unavailable',
    epoch: await getRedis().get(`repo-interactive-epoch:${repositoryId}`),
  };
}

export async function requireIdeCheckout(target: IdeTarget, expected?: { epoch: string | null }) {
  const state = await ideCheckoutState(target);
  if (state.status !== 'ready') {
    const { CheckoutUnavailableError } = await import('@haive/shared/checkout-access');
    throw new CheckoutUnavailableError();
  }
  if (expected && expected.epoch !== state.epoch) {
    const { HttpError } = await import('../context.js');
    throw new HttpError(
      409,
      'Repository sessions stopped for a checkout rebuild. Reopen the Editor and review retained unsaved buffers before saving.',
      'repository_rebuilt',
    );
  }
  return state;
}
