import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { schema, type Database } from '@haive/database';
import {
  emptyProjectState,
  renderProjectState,
  type ProjectStateRecord,
} from '@haive/shared/project-state';
import { gitRun } from '../../src/repo/git-exec.js';
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export async function git(root: string, args: string[], input?: Buffer) {
  const res = await gitRun(
    root,
    args,
    {
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
    },
    { input, encoding: 'latin1' },
  );
  if (res.code) throw new Error(res.stderr);
  return res.stdout;
}
export function fixtureDb(record: ProjectStateRecord): Database {
  const db = {
    execute: async () => [],
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const rows =
            table === schema.projectStateSync
              ? [{ baseSnapshot: record }]
              : table === schema.planNodes
                ? [{ id: 'plan' }]
                : table === schema.planMirrorState
                  ? [{ syncedHash: hash('{"pending":true}\n') }]
                  : [];
          return Object.assign(Promise.resolve(rows), {
            limit: async () => rows,
            orderBy: async () => rows,
          });
        },
      }),
    }),
    insert: () => ({ values: () => ({ onConflictDoUpdate: async () => [] }) }),
    transaction: async (fn: (tx: Database) => Promise<unknown>) => fn(db as unknown as Database),
  };
  return db as unknown as Database;
}
export async function writeRecord(root: string, record: ProjectStateRecord) {
  for (const [p, s] of renderProjectState(record)) {
    const file = join(root, '.haive-data/state', p);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, s);
  }
}
export async function buildProjectionFixture(root: string) {
  await git(root, ['init', '-q', '-b', 'main']);
  const base = emptyProjectState();
  for (let i = 0; i < 4; i++)
    base.claims.push({
      path: `generated/f${i}.txt`,
      templateId: `fixture.${i}`,
      kind: 'agent',
      schemaVersion: 1,
      templateHash: hash('old'),
      writtenHash: hash('old'),
      haiveVersion: '0.1.0',
    });
  await writeRecord(root, base);
  await writeFile(join(root, '.haive-data/plan.json'), '{}\n');
  await writeFile(join(root, '.haive-data/plan.md'), 'baseline\n');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-qm', 'synthetic baseline']);
  return base;
}
