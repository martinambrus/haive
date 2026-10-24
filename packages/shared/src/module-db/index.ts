import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { isDuplicateDatabase, type Database } from '@haive/database';
import { logger } from '../logger/index.js';
import { databaseName } from '../naming/index.js';

const log = logger.child({ module: 'module-db' });

// pg.end() cannot cancel a waiter or a running statement; the server drops them once it sees the closed socket.
const CONNECTION_CHECK_MS = 500;

export type ModuleSchemaContext = {
  moduleId: string;
  sql: postgres.Sql;
  withSchemaLock<T>(run: (tx: postgres.TransactionSql) => Promise<T>): Promise<T>;
};

export type ModuleDatabase = Omit<ModuleSchemaContext, 'moduleId'> & {
  close(): Promise<void>;
};

export type ModuleTeardownContext = {
  moduleId: string;
  logger: ReturnType<typeof logger.child>;
  /** The teardown job closes every database it opened, so the hook need not. */
  openDatabase(): Promise<ModuleDatabase>;
};

export const moduleDatabaseName = (moduleId: string): string =>
  databaseName('module', moduleId.replaceAll('-', '_'));

/** Opens the module's own database on the main server, creating it when absent. */
export async function openModuleDatabase(
  haiveDb: Database,
  moduleId: string,
): Promise<ModuleDatabase> {
  const dbName = moduleDatabaseName(moduleId);
  try {
    const rows = (await haiveDb.execute(
      sql`SELECT 1 FROM pg_database WHERE datname = ${dbName}`,
    )) as unknown[];
    if (!Array.isArray(rows) || rows.length === 0) {
      await haiveDb.execute(sql.raw(`CREATE DATABASE "${dbName}"`));
      log.info({ dbName, moduleId }, 'created module database');
    }
  } catch (err) {
    if (!isDuplicateDatabase(err)) throw err;
  }

  const haiveUrl = process.env.DATABASE_URL;
  if (!haiveUrl) throw new Error('DATABASE_URL not set');
  const url = new URL(haiveUrl);
  url.pathname = `/${dbName}`;

  const pg = postgres(url.toString(), {
    max: 2,
    connection: { client_connection_check_interval: CONNECTION_CHECK_MS },
    onnotice: (notice) =>
      log.debug({ code: notice.code, message: notice.message, moduleId }, 'postgres notice'),
  });
  const lockKey = `haive:module-schema:${moduleId}`;
  return {
    sql: pg,
    withSchemaLock: <T>(run: (tx: postgres.TransactionSql) => Promise<T>) =>
      pg.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
        return run(tx) as Promise<T>;
      }) as Promise<T>,
    close: () => pg.end({ timeout: 5 }),
  };
}
