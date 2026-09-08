/**
 * The upgrade sequence, and — the part that matters — what to do when an upgrade is found
 * half-finished.
 *
 * All pure. The updater's riskiest logic is "this run died somewhere; what now", and that must be
 * decidable from a journal row alone, without a daemon, a database schema or a network.
 */

/**
 * Ordered phases. The order IS the safety argument, so it is data rather than control flow:
 *
 * - `preflight`   — nothing has been touched. Pull and verify images, check the jump is legal,
 *                   confirm the CURRENT images are still present locally (an upgrade that cannot
 *                   roll back is not an upgrade), take the lock.
 * - `draining`    — refuse new work, wait for in-flight work with a deadline.
 * - `maintenance` — hold non-admins out.
 * - `snapshot`    — the escape hatch for a release that contracts the schema.
 * - `migrate`     — apply pending migrations, one transaction each.
 * - `verify`      — boot the new containers with queues still held, and gate on what they report.
 * - `commit`      — run the destructive data migrations, release the holds, write the new pin.
 */
export const UPGRADE_PHASES = [
  'preflight',
  'draining',
  'maintenance',
  'snapshot',
  'migrate',
  'verify',
  'commit',
] as const;

export type UpgradePhase = (typeof UPGRADE_PHASES)[number];

export type RunStatus = 'running' | 'done' | 'failed' | 'rolled_back';

/** What a restarted updater should do about a run it found still marked `running`. */
export type ResumeAction =
  /** Nothing durable happened yet, or the phase is safely repeatable. Undo the holds and stop. */
  | 'reverse'
  /** Past the point of no return: the only safe direction is to finish. */
  | 'forward';

export interface ResumeDecision {
  action: ResumeAction;
  /** Why, in words the operator will read in a log line rather than infer. */
  reason: string;
}

/**
 * Decide what to do with an interrupted run.
 *
 * The pivot is `commit`, and it is the only phase where going backwards is worse than going
 * forwards. Everything before it is reversible by construction:
 *
 * - through `snapshot`, nothing has changed but holds, which lift cleanly;
 * - `migrate` is forward-only and ADDITIVE by the project's own rule, so a schema left part-way is
 *   one the OLD images still run against — reversing means restoring the previous tag and lifting
 *   the holds, not undoing the migrations;
 * - `verify` is the gate itself, and a gate that did not finish has not passed.
 *
 * At `commit` the destructive data migrations may already have run. Those delete rows with no
 * tombstone, some of them in a different database that the snapshot never covered, so reversing
 * would restore old images onto data the new version has already removed. Finishing is the only
 * honest option, and re-running the commit phase is safe because every step in it is idempotent.
 */
export function decideResume(phase: UpgradePhase): ResumeDecision {
  switch (phase) {
    case 'preflight':
      return { action: 'reverse', reason: 'nothing had been changed yet' };
    case 'draining':
    case 'maintenance':
      return {
        action: 'reverse',
        reason: 'only holds were applied; lifting them restores service',
      };
    case 'snapshot':
      return { action: 'reverse', reason: 'a snapshot changes nothing it cannot simply discard' };
    case 'migrate':
      return {
        action: 'reverse',
        reason:
          'migrations are forward-only and additive, so the previous images still run against ' +
          'whatever landed; restoring the previous tag is the whole reversal',
      };
    case 'verify':
      return {
        action: 'reverse',
        reason: 'the health gate never passed, so the upgrade never took',
      };
    case 'commit':
      return {
        action: 'forward',
        reason:
          'the destructive data migrations may already have run, and they remove rows the ' +
          'snapshot does not cover; going back would restore old images onto data the new ' +
          'version has already deleted',
      };
  }
}

/** Phases that must be re-run from the start when resuming forward. Only `commit` can be resumed
 *  forward at all, and every step in it is idempotent, so it simply repeats. */
export function isIdempotentOnResume(phase: UpgradePhase): boolean {
  return phase === 'commit';
}

/** The phase after this one, or null at the end. */
export function nextPhase(phase: UpgradePhase): UpgradePhase | null {
  const i = UPGRADE_PHASES.indexOf(phase);
  return i >= 0 && i < UPGRADE_PHASES.length - 1 ? (UPGRADE_PHASES[i + 1] ?? null) : null;
}

/** True once the upgrade has passed the point where reversing costs more than finishing. */
export function isPastPointOfNoReturn(phase: UpgradePhase): boolean {
  return decideResume(phase).action === 'forward';
}
