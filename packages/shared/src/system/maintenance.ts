import { z } from 'zod';

/**
 * System-wide maintenance state.
 *
 * Three states rather than two, because "stop letting people start things" and "stop letting
 * people in" are different moments of the same window and a drain needs the first without the
 * second:
 *
 * - `normal` — nothing is held.
 * - `draining` — everyone is told, NEW tasks are refused with a reason, in-flight work continues.
 *   This is where a maintenance window spends most of its time.
 * - `maintenance` — non-admin requests are refused. Admins are not, or nobody could lift it, and
 *   neither is the unauthenticated version endpoint, or an upgrade could not verify the swap it
 *   just performed.
 *
 * NOT the same thing as `GLOBAL_PAUSE`, which holds the orchestrator while everyone carries on
 * using the app. That one is about jobs; this one is about people. They compose: a drain sets
 * this AND leaves the pause to the operator.
 */
export const MAINTENANCE_STATES = ['normal', 'draining', 'maintenance'] as const;

export const maintenanceStateSchema = z.enum(MAINTENANCE_STATES);

export type MaintenanceState = (typeof MAINTENANCE_STATES)[number];

/** Parse a stored value, defaulting to `normal`.
 *
 *  Fails OPEN deliberately. An unreadable or unrecognised value must not lock every user out of
 *  their own install — the failure mode of a wrong guess in that direction is a lockout nobody can
 *  clear from the UI, while the other direction is an upgrade running with users still connected,
 *  which the operator can see and fix. */
export function parseMaintenanceState(value: string | null | undefined): MaintenanceState {
  const parsed = maintenanceStateSchema.safeParse(value);
  return parsed.success ? parsed.data : 'normal';
}

/** True when new work must be refused: both of the non-normal states hold task creation. */
export function refusesNewWork(state: MaintenanceState): boolean {
  return state !== 'normal';
}

/** True when non-admin requests are refused outright. */
export function locksOutNonAdmins(state: MaintenanceState): boolean {
  return state === 'maintenance';
}
