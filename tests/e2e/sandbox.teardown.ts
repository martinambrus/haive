import { readFile } from 'node:fs/promises';
import { test as teardown } from '@playwright/test';
import { cleanupUser, getSql } from './helpers/db.js';
import { warmupRecordPath } from './helpers/warmup.js';

teardown('the warm-up account is removed', async () => {
  let record: string;
  try {
    record = await readFile(warmupRecordPath(teardown.info()), 'utf8');
  } catch (err) {
    // No record: the warm-up stopped before it registered anyone.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const { userId } = JSON.parse(record) as { userId: string };
  const sql = getSql();
  try {
    await cleanupUser(sql, userId);
  } finally {
    await sql.end({ timeout: 5 });
  }
});
