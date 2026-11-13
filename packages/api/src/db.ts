import { createDatabase } from '@haive/database';

export type Database = ReturnType<typeof createDatabase>;

let dbInstance: Database | null = null;
let databaseUrl: string | undefined;

export function initDatabase(connectionString: string): Database {
  if (dbInstance) return dbInstance;
  databaseUrl = connectionString;
  dbInstance = createDatabase(connectionString);
  return dbInstance;
}

export function getDb(): Database {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return dbInstance;
}

/** Recovery must not reuse a connection whose COMMIT acknowledgement was lost. */
export async function withFreshDatabase<T>(run: (db: Database) => Promise<T>): Promise<T> {
  if (!databaseUrl) throw new Error('Database not initialized');
  const fresh = createDatabase(databaseUrl);
  try {
    return await run(fresh);
  } finally {
    await fresh.$client.end({ timeout: 5 });
  }
}
