import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';

/**
 * A small plan tree, seeded directly.
 *
 * `path` is materialised, self-inclusive and slash-terminated — `/<root>/<child>/` — so one
 * `LIKE 'prefix%'` selects a subtree. It is built here exactly as `planNodePath` builds it,
 * because a fixture that got the shape wrong would produce a tree whose subtree queries return
 * nothing and a test that fails for a reason having nothing to do with the product.
 *
 * The shape below exists to exercise the roll-up rule, which is the plan's most load-bearing
 * derivation and is computed at READ time rather than stored:
 *
 *   root
 *   ├── done-child          done
 *   ├── blocked-child       blocked_human
 *   └── todo-child          todo
 *
 * `blocked_human` is the one status that propagates upward — it is a verdict a PERSON entered,
 * so no amount of agent progress underneath may paint over it — which makes the root's rolled-up
 * status the assertion worth making.
 */

export interface PlanFixture {
  repoId: string;
  rootId: string;
  doneId: string;
  blockedId: string;
  todoId: string;
}

type PlanStatus = 'todo' | 'in_progress' | 'blocked_human' | 'done' | 'not_applicable';

async function insertNode(
  sql: postgres.Sql,
  row: {
    id: string;
    repoId: string;
    parentId: string | null;
    parentPath: string | null;
    title: string;
    status: PlanStatus;
    ordinal: number;
    taskable?: boolean;
  },
): Promise<string> {
  const path = `${row.parentPath ?? '/'}${row.id}/`;
  await sql`
    insert into plan_nodes (
      id, repository_id, parent_id, path, ordinal, title, kind, status, taskable
    ) values (
      ${row.id}, ${row.repoId}, ${row.parentId}, ${path}, ${row.ordinal},
      ${row.title}, 'component', ${row.status}, ${row.taskable ?? false}
    )
  `;
  return path;
}

export async function seedPlan(
  sql: postgres.Sql,
  repoId: string,
  suffix: string,
): Promise<PlanFixture> {
  const rootId = randomUUID();
  const doneId = randomUUID();
  const blockedId = randomUUID();
  const todoId = randomUUID();

  const rootPath = await insertNode(sql, {
    id: rootId,
    repoId,
    parentId: null,
    parentPath: null,
    title: `e2e plan ${suffix}`,
    status: 'todo',
    ordinal: 0,
  });

  await insertNode(sql, {
    id: doneId,
    repoId,
    parentId: rootId,
    parentPath: rootPath,
    title: 'Shipped component',
    status: 'done',
    ordinal: 0,
    taskable: true,
  });
  await insertNode(sql, {
    id: blockedId,
    repoId,
    parentId: rootId,
    parentPath: rootPath,
    title: 'Waiting on a person',
    status: 'blocked_human',
    ordinal: 1,
    taskable: true,
  });
  await insertNode(sql, {
    id: todoId,
    repoId,
    parentId: rootId,
    parentPath: rootPath,
    title: 'Not started yet',
    status: 'todo',
    ordinal: 2,
    taskable: true,
  });

  return { repoId, rootId, doneId, blockedId, todoId };
}

/** Nodes cascade from the repository, so this is only for a plan outliving its repo fixture. */
export async function cleanupPlan(sql: postgres.Sql, repoId: string): Promise<void> {
  await sql`delete from plan_nodes where repository_id = ${repoId}`;
}
