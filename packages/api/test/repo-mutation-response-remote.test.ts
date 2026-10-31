import { beforeEach, describe, expect, it, vi } from 'vitest';

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
import { gitRemoteUrlSchema } from '@haive/shared/schemas';
import { repoRoutes } from '../src/routes/repos.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000c1';
const MARKERS = ['fixture-password', 'fixture-token', 'fixture-query', 'fixture-fragment'];
const CREATE_REMOTE =
  'https://user:fixture-password@example.test/repo.git?fixture-query#fixture-fragment';

// Stored remote, the secret it carries (null when it carries none), the remote a response shows.
const CASES: [string, string | null, string][] = [
  [
    'https://user:fixture-password@example.test/repo.git',
    'fixture-password',
    'https://example.test/repo.git',
  ],
  [
    'http://user:fixture-password@example.test:8080/repo.git?fixture-query#fixture-fragment',
    'fixture-password',
    'http://example.test:8080/repo.git',
  ],
  ['https://fixture-token@example.test/repo.git', 'fixture-token', 'https://example.test/repo.git'],
  // An SSH login is identity, not a secret: it stays by policy.
  [
    'ssh://git:fixture-password@example.test:22/repo.git',
    'fixture-password',
    'ssh://git@example.test:22/repo.git',
  ],
  ['ftp://user:fixture-password@example.test/repo', 'fixture-password', 'ftp://example.test/repo'],
  ['git:fixture-password@example.test:repo', 'fixture-password', 'example.test:repo'],
  ['https://example.test/repo.git', null, 'https://example.test/repo.git'],
];

const app = new Hono<AppEnv>();
app.route('/repos', repoRoutes);
app.onError(errorHandler);

let fake: ReturnType<typeof createFakeDb>;
beforeEach(() => {
  fake = createFakeDb({
    repositories: schema.repositories,
    projectStateOutbox: schema.projectStateOutbox,
  });
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: REPO,
    source: 'local_path',
    fileTree: { files: ['a.ts'] },
    renderContext: { rtkEnabled: true },
    agentRulesOverride: 'Rules that stay out of the repository payloads.\n',
  });
  h.db = fake.db;
});

const send = (path: string, method: string, body: unknown) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const storedRow = (id: string) => fake.rows(schema.repositories).find((r) => r.id === id);
const patchExclusions = () =>
  send(`/repos/${REPO}/exclusions`, 'PATCH', { scopeExcludeGlobs: ['vendor'] });
const readRemote = async (id: string) => {
  const res = await app.request(`/repos/${id}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { repository: { remoteUrl: unknown } }).repository.remoteUrl;
};

describe('PATCH /repos/:id/exclusions response', () => {
  it.each(CASES)(
    'shows the stored remote the way the repository read does: %s',
    async (remote, marker, expected) => {
      fake.patch(schema.repositories, REPO, { remoteUrl: remote });
      if (marker) expect(storedRow(REPO)?.remoteUrl).toContain(marker);

      const res = await patchExclusions();

      expect(res.status).toBe(200);
      const text = await res.text();
      for (const secret of MARKERS) expect(text).not.toContain(secret);
      const { repository } = JSON.parse(text) as { repository: Record<string, unknown> };
      expect(repository.remoteUrl).toBe(expected);
      expect(repository.remoteUrl).toBe(await readRemote(REPO));
      for (const key of ['fileTree', 'renderContext', 'agentRulesOverride'])
        expect(repository).not.toHaveProperty(key);
    },
  );

  it.each(CASES)('stores the remote as it was and the new exclusions: %s', async (remote) => {
    fake.patch(schema.repositories, REPO, { remoteUrl: remote });

    expect((await patchExclusions()).status).toBe(200);

    expect(storedRow(REPO)?.remoteUrl).toBe(remote);
    expect(storedRow(REPO)?.scopeExcludeGlobs).toEqual(['vendor']);
  });

  it('answers null for a repository that has no remote', async () => {
    const res = await patchExclusions();

    expect(res.status).toBe(200);
    const { repository } = (await res.json()) as { repository: { remoteUrl: unknown } };
    expect(repository.remoteUrl).toBeNull();
    expect(storedRow(REPO)?.remoteUrl).toBeNull();
  });
});

describe('POST /repos response', () => {
  const create = () => send('/repos', 'POST', { source: 'git_https', remoteUrl: CREATE_REMOTE });

  it('leaves the query and fragment the stored remote keeps out of the response', async () => {
    const res = await create();

    expect(res.status).toBe(201);
    const text = await res.text();
    for (const secret of MARKERS) expect(text).not.toContain(secret);
    const { repository } = JSON.parse(text) as { repository: { id: string; remoteUrl: unknown } };
    expect(repository.remoteUrl).toBe('https://example.test/repo.git');
    expect(repository.remoteUrl).toBe(await readRemote(repository.id));
  });

  it('stores the remote the request schema produced', async () => {
    const res = await create();

    expect(res.status).toBe(201);
    const { repository } = (await res.json()) as { repository: { id: string } };
    expect(storedRow(repository.id)?.remoteUrl).toBe(gitRemoteUrlSchema.parse(CREATE_REMOTE));
  });
});
