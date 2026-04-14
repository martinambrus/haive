import { createDatabase } from '@haive/database';

export type Database = ReturnType<typeof createDatabase>;

let dbInstance: Database | null = null;

export function initDatabase(connectionString: string): Database {
  if (dbInstance) return dbInstance;
  dbInstance = createDatabase(connectionString);
  return dbInstance;
}

export function getDb(): Database {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return dbInstance;
}
