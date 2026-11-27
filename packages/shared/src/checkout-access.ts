import { eq } from 'drizzle-orm';
import {
  acquireRootClaim,
  isRootClaimLive,
  rootClaimHandleOwns,
  schema,
  type Database,
  type RootClaimHandle,
} from '@haive/database';
import { HttpError } from './module-host/index.js';

type Db = Database | Parameters<Parameters<Database['transaction']>[0]>[0];
export type CheckoutAvailability = 'ready' | 'repair';
export type CheckoutAccess =
  | { mode: 'read' }
  | { mode: 'mutation'; owner?: RootClaimHandle; availability?: CheckoutAvailability }
  | { mode: 'preparation'; owner: RootClaimHandle };

export class CheckoutUnavailableError extends HttpError {
  constructor() {
    super(
      409,
      'This repository checkout is preparing or unavailable. Try again in a moment.',
      'checkout_unavailable',
    );
  }
}

/** Admission only. Reads can finish on a verified old inode. Mutations must retain a renewing
 * claim for their entire lifetime, or call this under task/domain/repository locks that exclude
 * the replacement boundary. Never interpret an unavailable checkout as an empty projection. */
export async function requireCheckoutAccess(db: Db, repositoryId: string, access: CheckoutAccess) {
  const repo = await db.query.repositories.findFirst({
    where: eq(schema.repositories.id, repositoryId),
    columns: { id: true, status: true, rootClaimedAt: true, rootClaimOwner: true },
  });
  if (!repo) throw new CheckoutUnavailableError();
  const own =
    access.mode !== 'read' &&
    access.owner !== undefined &&
    rootClaimHandleOwns(access.owner, repositoryId, repo.rootClaimOwner);
  if (access.mode === 'preparation') {
    if (!own || !isRootClaimLive(repo.rootClaimedAt)) throw new CheckoutUnavailableError();
    return repo;
  }
  if (
    (repo.status !== 'ready' &&
      !(
        access.mode === 'mutation' &&
        access.availability === 'repair' &&
        repo.status === 'error'
      )) ||
    (access.mode === 'mutation' && isRootClaimLive(repo.rootClaimedAt) && !own)
  )
    throw new CheckoutUnavailableError();
  if (
    access.mode === 'mutation' &&
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
  const owner = await acquireRootClaim(db, repositoryId, 'edit', userId);
  if (!owner) throw new CheckoutUnavailableError();
  try {
    await requireCheckoutAccess(db, repositoryId, { mode: 'mutation', owner, availability });
    return await run(owner);
  } finally {
    await owner.release();
  }
}

/** Classify a failed acquisition against fresh availability. A rename that interrupted the
 * descriptor walk is preparation, rather than a misleading path-permission or missing-file error.
 * Successful acquisitions are deliberately not rechecked: their old verified inode may finish. */
export async function withCheckoutRead<T>(
  db: Db,
  repositoryId: string,
  open: () => Promise<T>,
): Promise<T> {
  await requireCheckoutAccess(db, repositoryId, { mode: 'read' });
  try {
    return await open();
  } catch (err) {
    await requireCheckoutAccess(db, repositoryId, { mode: 'read' });
    throw err;
  }
}
