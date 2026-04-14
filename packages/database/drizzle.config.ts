import type { Config } from 'drizzle-kit';

export default {
  schema: './src/schema/index.ts',
  out: './src/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://haive:haive_dev_password@localhost:5432/haive',
  },
  strict: true,
  verbose: true,
} satisfies Config;
