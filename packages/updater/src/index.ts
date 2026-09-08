/**
 * @haive/updater — drives an upgrade from OUTSIDE the stack it replaces.
 *
 * A process cannot `compose up -d` itself out of existence and survive to verify the result or
 * roll it back, so the updater runs as a one-shot container that is not part of the compose
 * project being swapped.
 *
 * The decisions live in `phases` and `preflight` and are pure; `docker` and `journal` are the thin
 * I/O around them. Nothing here is wired to a caller yet — the CLI and the release image follow.
 */
export * from './phases.js';
export * from './preflight.js';
export * from './journal.js';
export * from './docker.js';
