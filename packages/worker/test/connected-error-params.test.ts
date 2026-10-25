import { DrizzleQueryError } from 'drizzle-orm/errors';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { logger, safeErrorForTransport } from '@haive/shared/logger';

const h = vi.hoisted(() => ({
  error: undefined as unknown,
  persist: vi.fn(),
  credentialSecret: 'fixture-prefix" fixture-suffix',
}));
vi.mock('../src/bundle-parser/index.js', () => ({
  parseBundle: async () => ({ items: [], ambiguous: [], dropped: [] }),
  persistBundleItems: h.persist,
}));
vi.mock('../src/repo/clone.js', async (original) => ({
  ...(await original<object>()),
  extractArchive: async () => ({ note: null, dropped: [] }),
  gitClone: async () => undefined,
  buildAuthenticatedUrl: () => {
    throw new Error('fixture never uses credentials');
  },
}));
vi.mock('../src/repo/git-exec.js', async (original) => ({
  ...(await original<object>()),
  gitRun: async () => ({ code: 0, stdout: 'fixture-head', stderr: '' }),
}));
vi.mock('../src/repo/git-push.js', async (original) => ({
  ...(await original<object>()),
  originGitRun: async () => ({ code: 0, stdout: '', stderr: '' }),
  buildCredentialHelper: async () => ({ argv: [], env: {}, secret: h.credentialSecret }),
}));
vi.mock('../src/secrets/provider-secrets.js', () => ({ resolveProviderSecrets: async () => ({}) }));
vi.mock('../src/sandbox/docker-runner.js', () => ({
  defaultDockerRunner: { inspect: async () => ({ exists: false, imageId: null }) },
}));

import { handleIngestGit, handleIngestZip, handleResyncGit } from '../src/repo/bundle-ingest.js';
import { sweepDirtyProjectStates } from '../src/project-state/refresh.js';
import { handleProbeJob } from '../src/queues/cli-exec/handlers.js';
import { provisionOllamaProvider } from '../src/sandbox/ollama-provision.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const BUNDLE = '00000000-0000-4000-8000-0000000000c1';
const PROVIDER = '00000000-0000-4000-8000-0000000000d1';
const secret = 'CONNECTED_BOUND_SECRET_426';
const ordinary = 'ordinary diagnosis\n  exact whitespace';
const lines: string[] = [];
let root: string;

function failure(bound: boolean) {
  return bound
    ? new DrizzleQueryError('update fixture set value = $1', [secret], new Error(secret))
    : new TypeError(ordinary);
}
const expected = (bound: boolean) => (bound ? 'Database operation failed' : ordinary);
function assertSafe(value: unknown) {
  expect(JSON.stringify(value).includes(secret)).toBe(false);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'haive-connected-errors-'));
  lines.length = 0;
  const key = Object.getOwnPropertySymbols(logger).find(
    (key) => key.description === 'pino.stream',
  )!;
  const stream = (logger as unknown as Record<symbol, { write: (line: string) => void }>)[key]!;
  vi.spyOn(stream, 'write').mockImplementation((line) => {
    lines.push(line);
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

it.each([true, false])('outbox sweep stores a safe refresh failure (bound: %s)', async (bound) => {
  const error = failure(bound);
  const writes: Record<string, unknown>[] = [];
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({ orderBy: () => ({ limit: async () => [{ repositoryId: REPO }] }) }),
        }),
        where: () => ({
          limit: async () => {
            throw error;
          },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => {
        expect(table).toBe(schema.projectStateOutbox);
        writes.push(patch);
        return { where: async () => undefined };
      },
    }),
  } as unknown as Database;
  expect(await sweepDirtyProjectStates(db)).toBe(0);
  expect(writes).toHaveLength(2); // error write, then touch to let other rows progress
  expect(writes[0]!.lastError).toBe(expected(bound));
  expect(writes[1]!.lastError).toBeUndefined();
  assertSafe([writes, lines]);
});

for (const handler of [handleIngestZip, handleIngestGit, handleResyncGit]) {
  it.each([true, false])(
    `${handler.name} stores a safe persistence failure (bound: %s)`,
    async (bound) => {
      const fake = createFakeDb({ customBundles: schema.customBundles });
      fake.insert(schema.customBundles, {
        id: BUNDLE,
        userId: USER,
        repositoryId: REPO,
        name: 'fixture',
        sourceType: 'git',
        status: 'syncing',
        storageRoot: '',
        gitUrl: 'https://example.invalid/fixture.git',
        gitCredentialsId: null,
        archivePath: join(root, USER, BUNDLE, 'source.zip'),
        archiveFormat: 'zip',
      });
      // Resync must take its own catch, rather than falling through to the ingest handler.
      await mkdir(join(root, USER, BUNDLE, 'extracted', '.git'), { recursive: true });
      const error = failure(bound);
      h.persist.mockRejectedValueOnce(error);
      await expect(
        handler({ bundleId: BUNDLE, userId: USER }, fake.db as unknown as Database, root),
      ).rejects.toBe(error);
      expect(h.persist).toHaveBeenCalled();
      const stored = fake.rows(schema.customBundles)[0]!;
      expect(stored.status).toBe('failed');
      expect(stored.lastSyncError).toBe(expected(bound));
      assertSafe([stored.lastSyncError, lines]);
    },
  );
}

it.each([
  [true, 'fixture-prefix" fixture-suffix'],
  [true, 'Database'],
  [false, 'fixture-prefix" fixture-suffix'],
] as const)(
  'credentialed bundle failures keep both error structure and secret scrubbing: case %# (bound: %s)',
  async (bound, credentialSecret) => {
    h.credentialSecret = credentialSecret;
    const fake = createFakeDb({ customBundles: schema.customBundles });
    fake.insert(schema.customBundles, {
      id: BUNDLE,
      userId: USER,
      repositoryId: REPO,
      name: 'fixture',
      sourceType: 'git',
      status: 'syncing',
      storageRoot: '',
      gitUrl: 'https://example.invalid/fixture.git',
      gitCredentialsId: '00000000-0000-4000-8000-0000000000e1',
    });
    const message = `failed https://user:${h.credentialSecret}@example.invalid/r and token=${h.credentialSecret}`;
    const error = bound
      ? new DrizzleQueryError(
          'update fixture set value = $1',
          [h.credentialSecret],
          Object.assign(new Error(h.credentialSecret), { code: '23505' }),
        )
      : new TypeError(message);
    h.persist.mockRejectedValueOnce(error);
    const caught = await handleIngestGit(
      { bundleId: BUNDLE, userId: USER },
      fake.db as unknown as Database,
      root,
    ).catch((err: unknown) => err);
    const safeMessage = bound
      ? 'Database operation failed'
      : 'failed https://example.invalid/r and token=***';
    expect(fake.rows(schema.customBundles)[0]?.lastSyncError === safeMessage).toBe(true);
    if (bound) {
      // Preserve structure until the queue boundary logs class and SQLSTATE.
      expect(caught === error).toBe(true);
      const transported = safeErrorForTransport(caught);
      expect((transported as Error).message).toBe('Database operation failed (23505)');
      expect(
        lines.some((line) => line.includes('DrizzleQueryError') && line.includes('23505')),
      ).toBe(true);
    } else {
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message === safeMessage).toBe(true);
    }
    expect(
      lines.some((line) => line.includes('fixture-prefix') || line.includes('fixture-suffix')),
    ).toBe(false);
  },
);

it.each([true, false])(
  'probe job returns a safe image-ensure failure inside its result (bound: %s)',
  async (bound) => {
    const provider = {
      id: PROVIDER,
      userId: USER,
      name: 'codex',
      cliVersion: '1.0.0',
      sandboxDockerfileExtra: null,
      executablePath: null,
    };
    const error = failure(bound);
    let reads = 0;
    const db = {
      query: {
        cliProviders: {
          findFirst: async () => {
            if (++reads === 1) return provider;
            throw error;
          },
        },
      },
    } as unknown as Database;
    const result = await handleProbeJob(db, {
      providerId: PROVIDER,
      userId: USER,
      targetMode: 'cli',
    });
    expect(reads).toBe(2);
    expect(result).toMatchObject({
      ok: false,
      providerId: PROVIDER,
      targetMode: 'cli',
      cli: { ok: false, error: expected(bound) },
    });
    expect(result.cli?.durationMs).toBeTypeOf('number');
    assertSafe([result, lines]);
  },
);

it.each([true, false])(
  'Ollama provisioning stores and returns a safe ready-write failure (bound: %s)',
  async (bound) => {
    const fake = createFakeDb({ cliProviders: schema.cliProviders });
    fake.insert(schema.cliProviders, {
      id: PROVIDER,
      userId: USER,
      name: 'ollama',
      label: 'fixture',
    });
    const error = failure(bound);
    let writes = 0;
    fake.hooks.beforeUpdate = () => {
      if (++writes === 2) throw error;
    };
    const fetch = vi.fn(async () => Response.json({ models: [{ name: 'fixture-model' }] }));
    vi.stubGlobal('fetch', fetch);
    const result = await provisionOllamaProvider(fake.db as unknown as Database, {
      id: PROVIDER,
      model: 'fixture-model',
      modelfile: null,
      envVars: null,
    });
    expect(writes).toBe(3); // provisioning, failed ready write, failed status
    expect(fetch).toHaveBeenCalledOnce();
    const stored = fake.rows(schema.cliProviders)[0]!;
    expect(stored.modelProvisionStatus).toBe('failed');
    expect(stored.modelProvisionError).toBe(expected(bound));
    expect(result).toEqual({
      ok: false,
      providerId: PROVIDER,
      model: 'fixture-model',
      error: expected(bound),
    });
    assertSafe([stored.modelProvisionError, result, lines]);
  },
);
