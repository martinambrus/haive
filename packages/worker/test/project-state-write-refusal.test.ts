import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { renderContextColumnSchema } from '@haive/shared/project-state';
import { writeProjectStateRecord } from '../src/project-state/write.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';

const STATE_DIR = '.haive-data/state';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** The table and columns are found by their SQL names, which the migration fixes, so the test
 *  does not depend on what the schema module calls them. */
function tableNamed(sqlName: string): PgTable {
  const found = (Object.values(schema) as unknown[]).find(
    (v) => is(v, PgTable) && getTableName(v) === sqlName,
  );
  if (!found) throw new Error(`the database schema has no table ${sqlName}`);
  return found as PgTable;
}
function keyOf(table: PgTable, sqlName: string): string {
  const hit = Object.entries(getTableColumns(table)).find(([, col]) => col.name === sqlName);
  if (!hit) throw new Error(`${getTableName(table)} has no column ${sqlName}`);
  return hit[0];
}

async function listFiles(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
    const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await listFiles(root, next)));
    else out.push(next);
  }
  return out.sort();
}

type Context = Record<string, unknown>;

/** A context the column schema accepts: the control every refused one below is a copy of. */
const valid = (): Context => ({
  projectInfo: { name: 'acme', framework: 'drupal' },
  framework: 'drupal',
  acceptedAgentIds: ['security-auditor', 'code-reviewer'],
  customAgentSpecs: [{ id: 'billing-expert', title: 'Billing expert' }],
  agentTargets: [{ dir: '.claude/agents', format: 'markdown', supportsLsp: true }],
  lspLanguages: ['php-extended'],
  rtkEnabled: true,
  enabledCliProviders: [{ name: 'claude-code', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' }],
});

/** A repository, the database that would hold its render context, and the statements it is sent. */
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'project-state-refusal-'));
  dirs.push(root);
  const repositories = schema.repositories;
  const sync = tableNamed('project_state_sync');
  const fake = createFakeDb({ repositories, projectStateSync: sync });
  fake.insert(repositories, { id: REPO, userId: USER, name: 'acme', source: 'blank' });
  const column = keyOf(repositories, 'render_context');

  const statements: string[] = [];
  fake.hooks.beforeLock = () => void statements.push('lock');
  fake.hooks.beforeUpdate = (table) => void statements.push(`update ${getTableName(table)}`);
  fake.hooks.beforeInsert = (table) => void statements.push(`insert ${getTableName(table)}`);
  fake.hooks.beforeDelete = (table) => void statements.push(`delete ${getTableName(table)}`);

  const write = (c: Context): Promise<readonly string[]> =>
    writeProjectStateRecord(fake.db as unknown as Database, {
      repositoryId: REPO,
      repoPath: root,
      context: c as never,
      rtkChoiceRecorded: true,
    });
  return {
    root,
    write,
    statements,
    renderContext: () => fake.rows(repositories).find((r) => r.id === REPO)?.[column] ?? null,
    syncRows: () => fake.rows(sync),
  };
}

describe('writeProjectStateRecord: a context the column schema refuses', () => {
  it('accepts the control, so the refusals below are the context and nothing else', async () => {
    expect(
      renderContextColumnSchema.safeParse({ ...valid(), rtkChoiceRecorded: true }).success,
    ).toBe(true);
    const s = await setup();

    await s.write(valid());

    expect(existsSync(join(s.root, STATE_DIR, 'format.json'))).toBe(true);
    expect(existsSync(join(s.root, STATE_DIR, 'project/render.json'))).toBe(true);
    expect(s.renderContext()).not.toBeNull();
    expect(s.syncRows()).toHaveLength(1);
  });

  it.each([
    [
      'an agent target with a format no agent file has',
      (): Context => ({
        ...valid(),
        agentTargets: [{ dir: '.claude/agents', format: 'json', supportsLsp: true }],
      }),
      /agentTargets/,
    ],
    [
      'a key the context does not define',
      (): Context => ({ ...valid(), someUnknownKey: 'x' }),
      /someUnknownKey/,
    ],
  ] as const)('rejects %s and writes no file and no row', async (_what, bad, reason) => {
    const refused = bad();
    expect(
      renderContextColumnSchema.safeParse({ ...refused, rtkChoiceRecorded: true }).success,
    ).toBe(false);
    const s = await setup();

    await expect(s.write(refused)).rejects.toThrow(reason);

    expect(existsSync(join(s.root, STATE_DIR))).toBe(false);
    expect(await listFiles(s.root)).toEqual([]);
    expect(s.statements).toEqual([]);
    expect(s.renderContext()).toBeNull();
    expect(s.syncRows()).toEqual([]);
  });
});
