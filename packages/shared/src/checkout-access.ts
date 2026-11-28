import { eq } from 'drizzle-orm';
import {
  acquireRootClaim,
  isRootClaimLive,
  rootClaimHandleOwns,
  rootClaimHandleConfirmedAt,
  ROOT_CLAIM_STALE_MS,
  readLiveRootClaim,
  rootClaimRefusal,
  schema,
  type Database,
  type RootClaimHandle,
} from '@haive/database';
import { logger } from './logger/index.js';
import { HttpError } from './module-host/index.js';

type Db = Database | Parameters<Parameters<Database['transaction']>[0]>[0];
export type CheckoutAvailability = 'ready' | 'repair';
export type CheckoutAccess =
  | { mode: 'read'; availability?: CheckoutAvailability }
  | { mode: 'mutation'; owner?: RootClaimHandle; availability?: CheckoutAvailability }
  // Short projection sections hold task/domain/repository locks; owed preparation alone does
  // not own the root. Read-only scans can import after ready while their pending marker remains.
  | { mode: 'projection'; owner?: RootClaimHandle }
  | { mode: 'preparation'; owner: RootClaimHandle };

export class CheckoutUnavailableError extends HttpError {
  constructor(
    message = 'This repository checkout is preparing or unavailable. Try again in a moment.',
  ) {
    super(409, message, 'checkout_unavailable');
  }
}

/** Admission only. Reads can finish on a verified old inode. Mutations must retain a renewing
 * claim for their entire lifetime, or call this under task/domain/repository locks that exclude
 * the replacement boundary. Never interpret an unavailable checkout as an empty projection. */
export async function requireCheckoutAccess(db: Db, repositoryId: string, access: CheckoutAccess) {
  const repo = await db.query.repositories.findFirst({
    where: eq(schema.repositories.id, repositoryId),
    columns: {
      id: true,
      status: true,
      rootClaimedAt: true,
      rootClaimOwner: true,
      rootClaimKind: true,
      refreshPending: true,
    },
  });
  if (!repo) throw new CheckoutUnavailableError();
  const own =
    access.mode !== 'read' &&
    access.owner !== undefined &&
    rootClaimHandleOwns(
      access.owner,
      repositoryId,
      repo.rootClaimOwner,
      access.mode === 'preparation' ? ['rebuild', 'refresh'] : undefined,
    );
  if (access.mode === 'preparation') {
    if (
      !own ||
      !['rebuild', 'refresh'].includes(repo.rootClaimKind ?? '') ||
      !isRootClaimLive(repo.rootClaimedAt)
    )
      throw new CheckoutUnavailableError();
    return repo;
  }
  if (
    (repo.status !== 'ready' &&
      !('availability' in access && access.availability === 'repair' && repo.status === 'error')) ||
    (access.mode === 'mutation' && repo.refreshPending && !own) ||
    ((access.mode === 'mutation' || access.mode === 'projection') &&
      isRootClaimLive(repo.rootClaimedAt) &&
      !own)
  )
    throw new CheckoutUnavailableError();
  if (
    (access.mode === 'mutation' || access.mode === 'projection') &&
    access.owner !== undefined &&
    (!own || !isRootClaimLive(repo.rootClaimedAt))
  )
    throw new CheckoutUnavailableError();
  return repo;
}

/** Claim before every task/domain/row lock. No connection is retained across a stream or Git.
 * The checked owner can be passed to a nested repair without acquiring this lease twice. */
export async function withCheckoutMutation<T>(
  db: Database,
  repositoryId: string,
  userId: string,
  run: (owner: RootClaimHandle) => Promise<T>,
  availability: CheckoutAvailability = 'ready',
): Promise<T> {
  const owner = await acquireRootClaim(db, repositoryId, 'mutation', userId);
  if (!owner) {
    const held = await readLiveRootClaim(db, repositoryId);
    throw new CheckoutUnavailableError(held ? rootClaimRefusal(held.kind) : undefined);
  }
  try {
    const admitted = await requireCheckoutAccess(db, repositoryId, {
      mode: 'mutation',
      owner,
      availability,
    });
    if (admitted.refreshPending) throw new CheckoutUnavailableError();
    return await run(owner);
  } finally {
    await owner.release();
    if (owner.lost()) logger.error({ repositoryId }, 'checkout mutation lost its root claim');
  }
}

export const CHECKOUT_MUTATION_SAFETY_MS = 30_000;

/** Check immediately before every physical mutation. Failed renewals/read-backs cannot extend
 * write authority. Leave time before takeover for an in-flight syscall to settle; the lease
 * keeps renewing even while writes are refused. Identity-only upload take-back remains allowed. */
export function assertCheckoutMutationOwner(
  owner: RootClaimHandle,
  now: () => number = Date.now,
): void {
  const confirmedAt = rootClaimHandleConfirmedAt(owner);
  if (
    owner.lost() ||
    confirmedAt === null ||
    now() - confirmedAt.getTime() >= ROOT_CLAIM_STALE_MS - CHECKOUT_MUTATION_SAFETY_MS
  )
    throw new CheckoutUnavailableError();
}

/** Classify a failed acquisition against fresh availability. A rename that interrupted the
 * descriptor walk is preparation, rather than a misleading path-permission or missing-file error.
 * Successful acquisitions are deliberately not rechecked: their old verified inode may finish. */
export async function withCheckoutRead<T>(
  db: Db,
  repositoryId: string,
  open: () => Promise<T>,
  availability: CheckoutAvailability = 'ready',
): Promise<T> {
  await requireCheckoutAccess(db, repositoryId, { mode: 'read', availability });
  try {
    return await open();
  } catch (err) {
    await requireCheckoutAccess(db, repositoryId, { mode: 'read', availability });
    throw err;
  }
}
