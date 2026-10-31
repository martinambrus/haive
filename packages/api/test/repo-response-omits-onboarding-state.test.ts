import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getRepoQueue: () => ({ add: async () => undefined }) }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));
vi.mock('../src/middleware/maintenance.js', () => ({
  requireNewWorkAllowed: async (_c: unknown, next: () => Promise<void>) => next(),
  admitNewWork: vi.fn(),
  assertNewWorkAllowed: vi.fn(),
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { repoRoutes } from '../src/routes/repos.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

// `repositories.onboarding_tooling` keeps what the tooling step was given: the RAG connection
// string (typed as postgres://user:password@host/db), the Ollama URL and the MCP servers'
// environment values. `onboarding_environment` keeps the confirmed environment. Nothing in the web
// app reads either from a repository response, and the list is polled every 5 seconds, so no
// repository response carries them. Synthetic values only.
const REPO = '00000000-0000-4000-8000-0000000000c1';
const CONNECTION_PASSWORD = 'fixture-connection-password';
const OLLAMA_PASSWORD = 'fixture-ollama-password';
const MCP_VALUE = 'fixture-mcp-env-value';
const ENVIRONMENT_VALUE = 'fixture-environment-value';
const MARKERS = [
  CONNECTION_PASSWORD,
  OLLAMA_PASSWORD,
  MCP_VALUE,
  ENVIRONMENT_VALUE,
  'fixture-user',
  'ragConnectionString',
];
const KEYS = ['onboardingTooling', 'onboardingEnvironment'] as const;

const TOOLING = {
  schemaVersion: 1,
  tooling: {
    ragMode: 'external',
    ragConnectionString: `postgres://fixture-user:${CONNECTION_PASSWORD}@db.example.test:5432/rag`,
    ollamaUrl: `http://fixture-user:${OLLAMA_PASSWORD}@ollama.example.test:11434`,
    mcpSettingsJson: JSON.stringify({
      mcpServers: { a: { command: 'x', env: { API_KEY: MCP_VALUE } } },
    }),
  },
};
const ENVIRONMENT = {
  schemaVersion: 1,
  envDetectData: { project: { name: 'fixture-project' } },
  confirmedValues: { databasePassword: ENVIRONMENT_VALUE },
};

const app = new Hono<AppEnv>();
app.route('/repos', repoRoutes);
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

const newFakeDb = () =>
  createFakeDb({
    repositories: schema.repositories,
    projectStateOutbox: schema.projectStateOutbox,
    repoUploads: schema.repoUploads,
  });

let fake: ReturnType<typeof newFakeDb>;
/** The rows the repository queries fetched, as Postgres would send them for the columns asked. */
let fetched: Record<string, unknown>[];
beforeEach(() => {
  fake = newFakeDb();
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'repo',
    status: 'ready',
    source: 'local_path',
    writable: false,
    remoteUrl: 'https://example.test/repo.git',
    onboardingTooling: TOOLING,
    onboardingEnvironment: ENVIRONMENT,
  });
  fetched = [];
  h.db = {
    ...fake.db,
    query: {
      ...fake.db.query,
      repositories: {
        findMany: async (opts?: Record<string, unknown>) => {
          const rows = await fake.db.query.repositories.findMany(opts);
          fetched.push(...rows);
          return rows;
        },
        findFirst: async (opts?: Record<string, unknown>) => {
          const row = await fake.db.query.repositories.findFirst(opts);
          if (row) fetched.push(row);
          return row;
        },
      },
    },
    select: noRows,
  };
});

const storedRow = (id: string) => fake.rows(schema.repositories).find((r) => r.id === id);
const send = (path: string, method: string, body: unknown) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** The response carries neither key and none of the values they held, and still carries the
 *  fields its callers read. */
function expectOmitted(text: string, repository: Record<string, unknown>) {
  expect(repository).toMatchObject({ source: expect.any(String), status: expect.any(String) });
  expect(typeof repository.id).toBe('string');
  for (const marker of MARKERS) expect(text).not.toContain(marker);
  for (const key of KEYS) expect(repository).not.toHaveProperty(key);
}

function expectStoredAsItWas() {
  expect(storedRow(REPO)?.onboardingTooling).toEqual(TOOLING);
  expect(storedRow(REPO)?.onboardingEnvironment).toEqual(ENVIRONMENT);
}

describe('GET /repos', () => {
  it('answers neither the tooling nor the environment, and does not fetch them', async () => {
    expect(storedRow(REPO)?.onboardingTooling).toEqual(TOOLING);

    const res = await app.request('/repos');

    expect(res.status).toBe(200);
    const text = await res.text();
    const { repositories } = JSON.parse(text) as { repositories: Record<string, unknown>[] };
    expect(repositories).toHaveLength(1);
    expect(repositories[0]).toMatchObject({ id: REPO, remoteUrl: 'https://example.test/repo.git' });
    expectOmitted(text, repositories[0]!);
    expect(fetched).toHaveLength(1);
    for (const key of KEYS) expect(fetched[0]).not.toHaveProperty(key);
    expectStoredAsItWas();
  });
});

describe('GET /repos/:id', () => {
  it('answers neither the tooling nor the environment, and does not fetch them', async () => {
    const res = await app.request(`/repos/${REPO}`);

    expect(res.status).toBe(200);
    const text = await res.text();
    const { repository } = JSON.parse(text) as { repository: Record<string, unknown> };
    expect(repository).toMatchObject({ id: REPO, remoteUrl: 'https://example.test/repo.git' });
    expectOmitted(text, repository);
    expect(fetched).toHaveLength(1);
    for (const key of KEYS) expect(fetched[0]).not.toHaveProperty(key);
    expectStoredAsItWas();
  });
});

describe('PATCH /repos/:id/exclusions', () => {
  it('answers neither the tooling nor the environment, and stores them as they were', async () => {
    const res = await send(`/repos/${REPO}/exclusions`, 'PATCH', { scopeExcludeGlobs: ['vendor'] });

    expect(res.status).toBe(200);
    const text = await res.text();
    const { repository } = JSON.parse(text) as { repository: Record<string, unknown> };
    expect(repository).toMatchObject({ id: REPO, scopeExcludeGlobs: ['vendor'] });
    expectOmitted(text, repository);
    expect(storedRow(REPO)?.scopeExcludeGlobs).toEqual(['vendor']);
    expectStoredAsItWas();
  });
});

describe('POST /repos', () => {
  it('answers neither the tooling nor the environment', async () => {
    const res = await send('/repos', 'POST', {
      source: 'git_https',
      remoteUrl: 'https://example.test/new.git',
    });

    expect(res.status).toBe(201);
    const text = await res.text();
    const { repository } = JSON.parse(text) as { repository: Record<string, unknown> };
    expect(repository).toMatchObject({ remoteUrl: 'https://example.test/new.git' });
    expectOmitted(text, repository);
    expect(repository.id).not.toBe(REPO);
    expectStoredAsItWas();
  });
});

describe('POST /repos/upload', () => {
  let storage: string;
  let previousRoot: string | undefined;
  beforeAll(async () => {
    storage = await mkdtemp(path.join(tmpdir(), 'repo-onboarding-state-'));
    previousRoot = process.env.REPO_STORAGE_ROOT;
    process.env.REPO_STORAGE_ROOT = storage;
  });
  afterAll(async () => {
    if (previousRoot === undefined) delete process.env.REPO_STORAGE_ROOT;
    else process.env.REPO_STORAGE_ROOT = previousRoot;
    await rm(storage, { recursive: true, force: true });
  });

  it('answers neither the tooling nor the environment', async () => {
    const form = new FormData();
    form.set('archive', new File([new Uint8Array([80, 75, 3, 4, 0, 1, 2, 3])], 'source.zip'));

    const res = await app.request('/repos/upload', { method: 'POST', body: form });

    expect(res.status).toBe(201);
    const text = await res.text();
    const { repository } = JSON.parse(text) as { repository: Record<string, unknown> };
    expect(repository).toMatchObject({ source: 'upload', status: 'cloning' });
    expectOmitted(text, repository);
    expect(repository.id).not.toBe(REPO);
    expectStoredAsItWas();
  });
});
