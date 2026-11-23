import { AsyncLocalStorage } from 'node:async_hooks';
import { UpgradeRefusal } from './refusal.js';

// Each main invocation gets its own fence, including preflight and recovery. Read-only checks
// and absent installs retain their existing behavior until a lease has actually been acquired.
const recovering = new AsyncLocalStorage<boolean>();

// Uncertain storage must not turn a recoverable snapshot failure into a stopped database.
// Recovery still reads the record before each mutation and refuses proven takeover.
export function withStackLeaseRecovery<T>(work: () => T): T {
  return recovering.run(true, work);
}

export function isLeaseUnproven(error: unknown): error is UpgradeRefusal {
  return error instanceof UpgradeRefusal && error.refusal === 'stack-lock-unproven';
}

const lease = new AsyncLocalStorage<{ check?: () => Promise<void> }>();

export function withStackLease<T>(work: () => T): T {
  return lease.run({}, work);
}

export function bindStackLease(check: () => Promise<void>): void {
  const scope = lease.getStore();
  if (!scope) throw new Error('stack lease scope is missing');
  scope.check = check;
}

export async function assertStackLease(): Promise<void> {
  try {
    await lease.getStore()?.check?.();
  } catch (error) {
    if (!recovering.getStore() || !isLeaseUnproven(error)) throw error;
  }
}

export function isLeaseLoss(error: unknown): error is UpgradeRefusal {
  return error instanceof UpgradeRefusal && error.refusal === 'stack-lock-lost';
}
