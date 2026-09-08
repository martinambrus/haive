import { fileURLToPath } from 'node:url';

/**
 * Where the migration corpus lives.
 *
 * `src/migrate/paths.ts` and `dist/migrate/paths.js` sit at the SAME depth below the package
 * root (`rootDir: ./src`, `outDir: ./dist`), so one relative URL resolves correctly under both
 * `tsx src/…` in dev and `node dist/…` in a built image. That is the whole mechanism, and it is
 * why there is no build step copying `.sql` into `dist`: a second copy would have to stay
 * byte-identical for checksums to hold, and a stale one after a partial build would present as a
 * checksum mismatch with a baffling cause.
 *
 * `HAIVE_MIGRATIONS_DIR` overrides it, for an image with a different layout and for tests that
 * need to point the runner at a fixture directory.
 */
export function migrationsDir(): string {
  const override = process.env.HAIVE_MIGRATIONS_DIR;
  if (override) return override;
  return fileURLToPath(new URL('../../migrations/', import.meta.url));
}

/** The genesis migration's filename. */
export const BASELINE_FILENAME = '0000_baseline.sql';
