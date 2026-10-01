import { describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { repoRoutes } from '../src/routes/repos.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000b1';
const MARKER = 'render-context-marker-4f1c';

const app = new Hono<AppEnv>();
app.route('/', repoRoutes);
app.onError(errorHandler);

/** Every select the list makes (task counts, onboarding facts, artifact dates) finds nothing. */
function noRows(): unknown {
  const query: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'groupBy', 'orderBy', 'limit'])
    query[method] = () => query;
  query.then = (ok: (rows: unknown[]) => unknown, bad: (err: unknown) => unknown) =>
    Promise.resolve([]).then(ok, bad);
  return query;
}

/** One repository holding both large columns. The route's query runs through the fake's own
 *  `findMany`, which returns the columns that query names, as Postgres sends them; `fetched` keeps
 *  those rows, since the route drops from the response what it does not ship. The list's other
 *  queries are the ones the fake has no builder for. */
function setup() {
  const fake = createFakeDb({ repositories: schema.repositories });
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'repo',
    status: 'ready',
    fileTree: ['src/a.ts', 'src/b.ts', 'docs/readme.md'],
    renderContext: {
      projectInfo: { name: MARKER },
      framework: 'drupal',
      acceptedAgentIds: ['code-reviewer'],
      customAgentSpecs: [],
      lspLanguages: [],
      rtkChoiceRecorded: true,
    },
  });
  const fetched: Record<string, unknown>[] = [];
  h.db = {
    ...fake.db,
    query: {
      repositories: {
        findMany: async (opts?: Record<string, unknown>) => {
          const rows = await fake.db.query.repositories.findMany(opts);
          fetched.push(...rows);
          return rows;
        },
      },
    },
    select: noRows,
  };
  return { fake, fetched };
}

describe('listing repositories', () => {
  it('leaves out the render context and the file tree, which the list polls every 5 seconds', async () => {
    const { fake } = setup();
    const stored = fake.rows(schema.repositories)[0]!;
    expect(stored.renderContext).not.toBeNull();
    expect(stored.fileTree).not.toBeNull();

    const res = await app.request('/');

    expect(res.status).toBe(200);
    const text = await res.text();
    const { repositories } = JSON.parse(text) as { repositories: Record<string, unknown>[] };
    expect(repositories).toHaveLength(1);
    const repo = repositories[0]!;
    expect(repo.id).toBe(REPO);
    expect(repo.name).toBe('repo');
    expect(repo).not.toHaveProperty('renderContext');
    expect(repo).not.toHaveProperty('fileTree');
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain('src/a.ts');
  });

  it('does not fetch the render context at all, only the tree the list reads its paths from', async () => {
    const { fetched } = setup();

    expect((await app.request('/')).status).toBe(200);

    expect(fetched).toHaveLength(1);
    expect(fetched[0]).not.toHaveProperty('renderContext');
    expect(fetched[0]).toHaveProperty('fileTree');
  });

  it('still ships the top-level paths the list renders, read from the tree it leaves out', async () => {
    setup();

    const res = await app.request('/');

    const { repositories } = (await res.json()) as { repositories: { topLevelPaths: string[] }[] };
    expect(repositories[0]!.topLevelPaths).toEqual(['docs', 'src']);
  });
});
