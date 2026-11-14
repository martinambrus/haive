import { randomUUID } from 'node:crypto';
import { logger } from '@haive/shared';
import {
  ensureDirNoFollow,
  writeFileNoFollow,
  removeNoFollow,
  readdirNoFollow,
} from '@haive/shared/fs-safe';
import type { ChatPlanRead } from '../step-engine/steps/plan/_plan-chat-context.js';

export interface PlanChatSnapshot extends ChatPlanRead {
  schemaVersion: 1;
  userId: string;
  repositoryId: string;
  taskId: string;
  invocationId: string;
}
const ROOT = 'plan-chat-snapshots';
const log = logger.child({ module: 'plan-chat-snapshot' });
export const snapshotWorkerRoot = () =>
  process.env.SANDBOX_WRAPPER_WORKER_PATH ?? '/var/lib/haive/wrappers';

export function assertSnapshotOwner(
  snapshot: PlanChatSnapshot,
  owner: { userId: string; repositoryId: string | null; taskId: string; invocationId: string },
): void {
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.userId !== owner.userId ||
    snapshot.repositoryId !== owner.repositoryId ||
    snapshot.taskId !== owner.taskId ||
    snapshot.invocationId !== owner.invocationId
  )
    throw new Error('Plan snapshot does not belong to this owned dispatch.');
}

/** Only this one randomly named file is mounted, outside the repository. No
 * supplied path is opened, and no other dispatch's directory is ever mounted. */
export async function createPlanChatSnapshot(
  anchor: string,
  snapshot: PlanChatSnapshot,
): Promise<{ subpath: string; remove: () => Promise<void> }> {
  const rel = `${ROOT}/${randomUUID()}`;
  await ensureDirNoFollow(anchor, rel, { mode: 0o700 });
  try {
    await writeFileNoFollow(anchor, `${rel}/plan.json`, JSON.stringify(snapshot), {
      mode: 'create-exclusive',
      fileMode: 0o644,
    });
  } catch (err) {
    await removeNoFollow(anchor, rel, { recursive: true });
    throw err;
  }
  return {
    subpath: `${rel}/plan.json`,
    remove: async () => {
      await removeNoFollow(anchor, rel, { recursive: true });
    },
  };
}

/** Called only after boot has reaped the previous worker's CLI containers. */
export async function reapPlanChatSnapshots(anchor = snapshotWorkerRoot()): Promise<void> {
  const entries = await readdirNoFollow(anchor, ROOT, { strict: true });
  for (const entry of entries ?? []) {
    try {
      await removeNoFollow(anchor, `${ROOT}/${entry.name}`, { recursive: true });
    } catch (err) {
      log.error({ err, entry: entry.name }, 'failed to reap plan chat snapshot');
    }
  }
}
