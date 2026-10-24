import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { is, Param, SQL } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { failGit, type FakeGit } from './support/fake-git.js';

const h = vi.hoisted(() => ({ written: [] as string[] }));
vi.mock('../src/project-state/sync.js', () => ({
  syncProjectStateFromCheckout: vi.fn(async () => ({ outcome: 'unchanged' })),
}));
vi.mock('../src/project-state/write.js', async (original) => ({
  ...(await original<typeof import('../src/project-state/write.js')>()),
  writeProjectStateColumn: vi.fn(async (_db: unknown, args: { repoPath: string }) => {
    h.written.push(args.repoPath);
  }),
}));

const { sweepDirtyProjectStates } = await import('../src/project-state/refresh.js');

const USER = '00000000-0000-4000-8000-0000000000a1';
const FIRST = '00000000-0000-4000-8000-0000000000b1';
const SECOND = '00000000-0000-4000-8000-0000000000b2';

const RENDER_CONTEXT = {
  projectInfo: { name: 'acme', framework: 'drupal' },
  framework: 'drupal',
  acceptedAgentIds: ['security-auditor', 'code-reviewer'],
  customAgentSpecs: [
    { id: 'billing-expert', title: 'Billing expert', description: 'Knows the billing module' },
  ],
  agentTargets: [{ dir: '.claude/agents', format: 'markdown', supportsLsp: true }],
  lspLanguages: ['php-extended'],
  rtkEnabled: true,
  rtkChoiceRecorded: true,
  enabledCliProviders: [{ name: 'claude-code', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' }],
};

const dirs: string[] = [];
let shim: FakeGit | null = null;

beforeEach(() => {
  h.written.length = 0;
});
afterEach(async () => {
  await shim?.restore();
  shim = null;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function checkout(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'state-sweep-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'gc.auto', '0'], { cwd: dir });
  return dir;
}

const paramsIn = (node: unknown): string[] => {
  if (is(node, Param)) return typeof node.value === 'string' ? [node.value] : [];
  if (is(node, SQL)) return node.queryChunks.flatMap(paramsIn);
  return Array.isArray(node) ? node.flatMap(paramsIn) : [];
};

/** The sweep's join and the outbox's `IS DISTINCT FROM` update are not something the fake database
 *  evaluates, so those two statements are answered here. */
function sweepDb(fake: ReturnType<typeof createFakeDb>): Database {
  const dirty = async () => {
    const withContext = new Set(
      fake
        .rows(schema.repositories)
        .filter((r) => r.renderContext != null)
        .map((r) => r.id),
    );
    return fake
      .rows(schema.projectStateOutbox)
      .filter(
        (r) =>
          (r.writtenRevision as number) < (r.revision as number) && withContext.has(r.repositoryId),
      )
      .sort((a, b) => (a.updatedAt as Date).getTime() - (b.updatedAt as Date).getTime())
      .map((r) => ({ repositoryId: r.repositoryId }));
  };
  return new Proxy(fake.db as object, {
    get(target, prop) {
      const value = (target as Record<string | symbol, unknown>)[prop];
      if (prop === 'update') {
        return (table: unknown) => ({
          set: (values: Record<string, unknown>) => ({
            where: async (cond: unknown) => {
              if (table !== schema.projectStateOutbox) {
                return (
                  value as (t: unknown) => {
                    set: (v: unknown) => { where: (c: unknown) => unknown };
                  }
                )(table)
                  .set(values)
                  .where(cond);
              }
              const ids = paramsIn(cond);
              for (const row of fake.rows(schema.projectStateOutbox)) {
                if (ids.includes(row.repositoryId as string)) {
                  fake.patch(schema.projectStateOutbox, row.id as string, values);
                }
              }
            },
          }),
        });
      }
      if (prop !== 'select') return value;
      return (fields: unknown) => {
        const select = (value as (f: unknown) => { from: (t: unknown) => unknown })(fields);
        return {
          from: (table: unknown) =>
            table === schema.projectStateOutbox
              ? {
                  innerJoin: () => ({
                    where: () => ({ orderBy: () => ({ limit: () => dirty() }) }),
                  }),
                }
              : select.from(table),
        };
      };
    },
  }) as unknown as Database;
}

function setup(storagePaths: string[]) {
  const fake = createFakeDb({
    repositories: schema.repositories,
    projectStateOutbox: schema.projectStateOutbox,
  });
  const ids = [FIRST, SECOND];
  storagePaths.forEach((storagePath, i) => {
    fake.insert(schema.repositories, {
      id: ids[i],
      userId: USER,
      name: `repo-${i}`,
      source: 'blank',
      status: 'ready',
      storagePath,
      renderContext: RENDER_CONTEXT,
    });
    fake.insert(schema.projectStateOutbox, {
      repositoryId: ids[i],
      revision: 2,
      writtenRevision: 1,
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
    });
  });
  const outbox = (id: string) =>
    fake.rows(schema.projectStateOutbox).find((row) => row.repositoryId === id)!;
  return { db: sweepDb(fake), outbox };
}

describe('the project-state sweep when git cannot be read', () => {
  it('keeps the unreadable row dirty with git text and still writes the healthy one', async () => {
    const first = await checkout();
    const second = await checkout();
    const { db, outbox } = setup([first, second]);
    shim = await failGit(['rev-parse', '--git-path'], { until: 1 });

    expect(await sweepDirtyProjectStates(db)).toBe(1);

    expect(h.written).toEqual([second]);
    expect(outbox(FIRST).lastError).toMatch(/git rev-parse --git-path MERGE_HEAD failed in /);
    expect(outbox(FIRST).writtenRevision).toBeLessThan(outbox(FIRST).revision as number);
    expect(outbox(SECOND).lastError).toBeNull();
  });

  it('still writes a checkout that has no .git at all', async () => {
    const plain = await mkdtemp(path.join(tmpdir(), 'state-sweep-plain-'));
    dirs.push(plain);
    const { db, outbox } = setup([plain]);

    expect(await sweepDirtyProjectStates(db)).toBe(1);

    expect(h.written).toEqual([plain]);
    expect(outbox(FIRST).lastError).toBeNull();
  });
});
