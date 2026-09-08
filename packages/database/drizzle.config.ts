import type { Config } from 'drizzle-kit';

export default {
  schema: './src/schema/index.ts',
  // Not the migration corpus. `packages/database/migrations/` is applied by our own
  // runner (src/migrate/) and its journal lives in the database, so drizzle-kit must not
  // write a `meta/_journal.json` into it or take over numbering. This directory is
  // gitignored scratch for the interactive `pnpm db:push` diff.
  out: './.drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://haive:haive_dev_password@localhost:5432/haive',
  },
  strict: true,
  verbose: true,
} satisfies Config;
