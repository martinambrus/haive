import { withSettledTransaction, type Database, type DbTx } from '@haive/database';
import { AsyncLocalStorage } from 'node:async_hooks';
import { assertCheckoutMutationOwner, type CheckoutAccess } from '@haive/shared/checkout-access';

// Carries a real registered handle through nested plan reconciliation (including private restore).
// This is authority only after requireCheckoutAccess verifies it against the live repository row.
const scope = new AsyncLocalStorage<CheckoutAccess>();
export const planCheckoutAccess = (): CheckoutAccess => scope.getStore() ?? { mode: 'projection' };
export const withPlanCheckoutAccess = <T>(
  access: CheckoutAccess,
  run: () => Promise<T>,
): Promise<T> => scope.run(access, run);

/** The lease must remain proven before each Git or projection mutation, including after a long
 * fetch. Preparation keeps its existing non-preemptible semantics. */
export function assertPlanCheckoutOwner(): void {
  const access = scope.getStore();
  if (access?.mode === 'mutation' && access.owner) assertCheckoutMutationOwner(access.owner);
}

// Plan Save/Pull also call the existing project-state projection helpers. Drain their SQL
// callbacks without changing those helpers or the independent Haive-data Save admission.
// postgres.js can reject before a callback's outstanding filesystem/Git await settles.
const settledDatabases = new WeakMap<object, Database>();
export function planCheckoutDatabase(db: Database): Database {
  if (scope.getStore()?.mode !== 'mutation') return db;
  const known = settledDatabases.get(db);
  if (known) return known;
  const wrapped = new Proxy(db, {
    get(target, key) {
      if (key === 'transaction')
        return (
          work: (tx: DbTx) => Promise<unknown>,
          config?: Parameters<Database['transaction']>[1],
        ) =>
          withSettledTransaction(
            target,
            (tx) => work(planCheckoutDatabase(tx as unknown as Database) as unknown as DbTx),
            config,
          );
      const member = Reflect.get(target, key, target);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
  settledDatabases.set(db, wrapped);
  return wrapped;
}
