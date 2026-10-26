/** Actual recovery is SIGKILLed after the old park, or before/after the atomic directory removal. */
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const url = process.env.T266_DATABASE_URL;
const repositoryId = process.env.T266_CRASH_REPOSITORY_ID;
const repoPath = process.env.T266_CRASH_REPO_PATH;
const phase = process.env.T266_DIRECTORY_CRASH_PHASE;
if (
  !url ||
  !repositoryId ||
  !repoPath ||
  !['before', 'after'].includes(phase ?? '') ||
  !/^\/(?:codex|test)_t266_[a-z0-9_]+$/.test(new URL(url).pathname) ||
  ['', '5432', '6379'].includes(new URL(url).port)
)
  throw new Error('Directory crash child requires its exclusive T266 fixture');
const stop = async (boundary: string): Promise<never> => {
  await new Promise<void>((resolve) =>
    process.stdout.write(`T266_DIRECTORY_${boundary}\n`, () => resolve()),
  );
  return new Promise<never>(() => {});
};
const originalRename = fs.rename;
fs.rename = async (...args: Parameters<typeof fs.rename>) => {
  await originalRename(...args);
  if (phase === 'before' && String(args[1]).includes('/.bundles.haive-park-')) await stop('PARKED');
};
const originalRmdir = fs.rmdir;
fs.rmdir = async (...args: Parameters<typeof fs.rmdir>) => {
  const target = String(args[0]);
  const directory = target.endsWith('/bundles') || target.includes('/.bundles.haive-park-');
  if (directory && phase === 'before') await stop('BEFORE_RMDIR');
  await originalRmdir(...args);
  if (directory && phase === 'after') await stop('AFTER_RMDIR');
};
syncBuiltinESMExports();
const { createDatabase } = await import('@haive/database');
const { recoverProjectStateWrite } = await import('../../src/project-state/write.js');
const db = createDatabase(url);
try {
  await recoverProjectStateWrite(db, repositoryId, repoPath);
} finally {
  await db.$client.end({ timeout: 5 });
}
