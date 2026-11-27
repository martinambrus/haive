/** Contention is owed work, not a failed preparation attempt. */
export class RootClaimBusyError extends Error {
  constructor(readonly kind: string | null) {
    super(`Repository root is held (${kind ?? 'unknown'}); preparation will wait`);
    this.name = 'RootClaimBusyError';
  }
}
