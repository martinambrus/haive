/**
 * One JSON line per event, on stdout.
 *
 * `console`, not pino, and that is a deliberate exception to the project rule rather than an
 * oversight. `@haive/shared` owns the logger and DEPENDS ON `@haive/database`, so importing it
 * back here is a dependency cycle. This module is also a CLI rather than server code: its output
 * is read by a human tailing `docker compose logs db-migrate`, and parsed by the updater that
 * will drive it. JSON lines serve both.
 */

export type MigrateEvent =
  | 'target'
  | 'classified'
  | 'lock-wait'
  | 'adopted'
  | 'applying'
  | 'applied'
  | 'skipped'
  | 'ahead'
  | 'pg-notice'
  | 'done'
  | 'error';

export function emit(event: MigrateEvent, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ t: new Date().toISOString(), event, ...fields });
  if (event === 'error') console.error(line);
  else console.log(line);
}
