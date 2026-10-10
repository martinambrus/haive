import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import { findBranchClaimant } from './worktree-claims.js';

async function capturedWhere(branchName: string): Promise<{ sql: string; params: unknown[] }> {
  let where: SQL | undefined;
  const db = {
    query: {
      tasks: {
        findFirst: async (opts: { where: SQL }) => {
          where = opts.where;
          return undefined;
        },
      },
    },
  } as unknown as Database;
  await findBranchClaimant(db, { repositoryId: 'r1', branchName, taskId: 't1' });
  return new PgDialect().sqlToQuery(where!);
}

describe('findBranchClaimant', () => {
  it('matches the exact branch and any branch that maps to the same worktree directory', async () => {
    const q = await capturedWhere('feature/x');
    expect(q.sql).toContain(`replace("tasks"."worktree_branch", '/', '-') = $`);
    expect(q.params).toContain('feature/x');
    expect(q.params).toContain('feature-x');
  });
});
