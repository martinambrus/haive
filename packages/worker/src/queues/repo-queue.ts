import {
  CheckoutSessionsBusyError,
  checkoutSessionCanRetry,
  CHECKOUT_SESSION_RETRY_MS,
} from '../repo/interactive-checkout.js';
import { RootClaimBusyError } from '../repo/root-claim-busy.js';
import path from 'node:path';
import {
  assertRepoJobOwner,
  ObsoleteRepoJobError,
  repoJobPredicate,
  withRepoJobOwner,
} from '../repo/job-owner.js';
import { CheckoutRepairNeededError } from '../repo/repair-needed.js';
import { scrubErrorPaths } from '@haive/shared/logger';
import { safeProcessor } from './safe-processor.js';
import { Worker, DelayedError, UnrecoverableError, type Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  QUEUE_NAMES,
  REPO_JOB_NAMES,
  REPOSITORY_ERROR_CODES,
  logger,
  type RepoJobPayload,
} from '@haive/shared';
import { getDb } from '../db.js';
import { getBullRedis } from '../redis.js';
import {
  completePreparationImports,
  handleClone,
  handleCopyLocal,
  handleExtract,
  handleInit,
  handleScan,
} from '../repo/clone.js';
import { handleRefresh } from '../repo/refresh.js';

export function startRepoWorker(repoStorageRoot: string): Worker {
  const worker = new Worker<RepoJobPayload>(
    QUEUE_NAMES.REPO,
    safeProcessor(async (job: Job<RepoJobPayload>, token) =>
      withRepoJobOwner(job.data.repositoryId, job.id ?? '', async () => {
        const db = getDb();
        const payload = job.data;
        const clearRefreshPending = async () => {
          if (!job.id) return;
          // Every preparation stays pending through its post-ready imports. Only its
          // admission token can retire that obligation, even if an older handler ends later.
          await db
            .update(schema.repositories)
            .set({ refreshPending: false, refreshJobId: null })
            .where(
              and(
                eq(schema.repositories.id, payload.repositoryId),
                eq(schema.repositories.refreshJobId, job.id),
              ),
            );
        };
        try {
          const owned = await assertRepoJobOwner(db, payload.repositoryId);
          const initialOnly = [
            REPO_JOB_NAMES.COPY,
            REPO_JOB_NAMES.INIT,
            REPO_JOB_NAMES.CLONE,
            REPO_JOB_NAMES.EXTRACT,
          ].some((name) => name === job.name);
          // Ready precedes imports. A redelivery must finish that obligation without
          // replacing a checkout that may already carry user work or task worktrees.
          if (initialOnly && owned.status === 'ready') {
            await completePreparationImports(
              db,
              payload.repositoryId,
              owned.storagePath ?? path.join(repoStorageRoot, payload.userId, payload.repositoryId),
            );
          } else if (job.name === REPO_JOB_NAMES.CLONE) {
            await handleClone(payload, db, repoStorageRoot);
          } else if (job.name === REPO_JOB_NAMES.SCAN) {
            await handleScan(payload, db);
          } else if (job.name === REPO_JOB_NAMES.EXTRACT) {
            await handleExtract(payload, db, repoStorageRoot);
          } else if (job.name === REPO_JOB_NAMES.COPY) {
            await handleCopyLocal(payload, db, repoStorageRoot);
          } else if (job.name === REPO_JOB_NAMES.INIT) {
            await handleInit(payload, db, repoStorageRoot);
          } else if (job.name === REPO_JOB_NAMES.REFRESH) {
            await handleRefresh(payload, db, repoStorageRoot);
          } else {
            throw new Error(`Unknown repo job: ${job.name}`);
          }
        } catch (err) {
          if (err instanceof ObsoleteRepoJobError) {
            logger.warn(
              { repositoryId: payload.repositoryId, jobId: job.id, reason: err.reason },
              'Obsolete or ownerless repository job refused',
            );
            return;
          }
          const sessionFailure = err instanceof CheckoutSessionsBusyError;
          if (sessionFailure) {
            logger.warn({ repositoryId: payload.repositoryId, reason: err.reason }, err.message);
            if (checkoutSessionCanRetry(err.reason, job.timestamp ?? 0)) {
              await db
                .update(schema.repositories)
                .set({
                  status: 'cloning',
                  checkoutSessionReason: err.reason,
                  statusMessage: err.message,
                })
                .where(repoJobPredicate(payload.repositoryId));
              await job.moveToDelayed(Date.now() + CHECKOUT_SESSION_RETRY_MS, token);
              throw new DelayedError();
            }
            // Permanent blocks and exhausted transient waits are terminal for this owner.
            // A manual Retry admits a fresh job; no rename has occurred.
          }
          if (err instanceof RootClaimBusyError) {
            logger.info(
              { repositoryId: payload.repositoryId, jobId: job.id, kind: err.kind },
              'Repository preparation waiting for root claim',
            );
            await job.moveToDelayed(Date.now() + 5_000, token);
            throw new DelayedError();
          }
          const message = scrubErrorPaths(err);
          logger.error(
            { repositoryId: payload.repositoryId, jobName: job.name, err },
            'Repo job failed',
          );
          await db
            .update(schema.repositories)
            .set({
              status: 'error',
              checkoutSessionReason: sessionFailure ? err.reason : null,
              // A check-only job runs for a repair code and keeps it whatever failed, so its
              // Retry stays a check and a rebuild still needs the explicit recovery.
              ...(payload.checkCheckoutOnly
                ? {}
                : {
                    errorCode:
                      err instanceof CheckoutRepairNeededError
                        ? err.code
                        : payload.recoverCheckout
                          ? REPOSITORY_ERROR_CODES.CHECKOUT_REPAIR_NEEDED
                          : null,
                  }),
              statusMessage: message,
              updatedAt: new Date(),
            })
            .where(repoJobPredicate(payload.repositoryId));
          // A delayed retry still owes work; only its final failure releases its own marker.
          if (
            (job.attemptsMade ?? 0) + 1 >= (job.opts?.attempts ?? 1) ||
            err instanceof UnrecoverableError ||
            sessionFailure
          )
            await clearRefreshPending();
          throw sessionFailure ? new UnrecoverableError(message) : err;
        }
        // Completion cleanup is separate from handler failure. Keep the ready result
        // if this write fails so an owned retry resumes imports instead of rebuilding
        // a checkout that may already contain user edits or task worktrees.
        await clearRefreshPending();
      }),
    ),
    {
      connection: getBullRedis(),
      concurrency: 5,
      // Default 1 makes the SECOND stall of a job terminal, and terminal here means the deferred
      // failure is raised on the next pickup BEFORE the processor runs — so the catch that writes
      // `status: 'error'` never executes and the repository stays `cloning` until reconciliation. Two
      // restarts inside one clone is ordinary (a crash loop, an OOM cycle, a deploy). The boot
      // and periodic (60s) reconciler in `data-migrations.ts` is the backstop for the strand this still leaves.
      maxStalledCount: 10,
      // `lockDuration` is deliberately LEFT at the 30s default, unlike task-queue and cli-exec.
      // Raising it here makes the common case worse: shutdown force-closes this worker, so an
      // ordinary deploy leaves the job `active` and BullMQ redelivers it only once the lock
      // expires — at 30 min that is half an hour of `cloning` on every restart, and the boot
      // reconciler sees the job in `active` and correctly declines to release the row. The long
      // lock's usual benefit does not apply either: what it buys elsewhere is protection from a
      // second processor running concurrently, and here `withRootClaim` already refuses that.
    },
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, name: job.name }, 'Repo job completed');
  });
  worker.on('failed', (job, err) => {
    logger.warn({ jobId: job?.id, name: job?.name, err }, 'Repo job failed');
  });

  return worker;
}
