import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
import { createDatabase } from '@haive/database';
import { handleRefresh } from './repo-preparation.js';

const repositoryId = process.env.T602_REPOSITORY_ID!;
const userId = process.env.T602_USER_ID!;
const url = process.env.T266_DATABASE_URL;
if (
  !url ||
  !/^\/(?:codex|test)_t266_[a-z0-9_]+$/.test(new URL(url).pathname) ||
  ['', '5432', '6379'].includes(new URL(url).port)
)
  throw new Error('Publication crash child requires an exclusive T266 fixture');
const originalRename = fs.rename;
fs.rename = async (from, to) => {
  const publishing = basename(String(to)) === repositoryId;
  if (publishing && process.env.T602_BOUNDARY === 'before') {
    process.stdout.write('T602_PUBLICATION\n');
    await new Promise(() => {});
  }
  await originalRename(from, to);
  if (publishing && process.env.T602_BOUNDARY === 'after') {
    process.stdout.write('T602_PUBLICATION\n');
    await new Promise(() => {});
  }
};
syncBuiltinESMExports();
const db = createDatabase(url);
await handleRefresh(
  {
    repositoryId,
    userId,
    source: 'local_path',
    localPath: process.env.T602_SOURCE!,
    recoverCheckout: true,
  },
  db,
  process.env.T602_STORAGE!,
  async () => () => {},
);
await db.$client.end({ timeout: 5 });
