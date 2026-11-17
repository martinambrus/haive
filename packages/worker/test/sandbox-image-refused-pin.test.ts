import { beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';
import type { BaseCliAdapter } from '../src/cli-adapters/base-adapter.js';

const docker = vi.hoisted(() => ({ inspect: vi.fn(), build: vi.fn(), remove: vi.fn() }));
vi.mock('../src/sandbox/docker-runner.js', async (original) => {
  const actual = await original<typeof import('../src/sandbox/docker-runner.js')>();
  return { ...actual, defaultDockerRunner: { ...actual.defaultDockerRunner, ...docker } };
});
vi.mock('../src/sandbox/sandbox-core-image.js', async (original) => ({
  ...(await original<object>()),
  ensureSandboxCoreImage: async () => {},
}));
vi.mock('../src/sandbox/image-cache.js', async (original) => {
  const actual = await original<typeof import('../src/sandbox/image-cache.js')>();
  return { ...actual, resolveImageTag: vi.fn(actual.resolveImageTag) };
});
import { resolveImageTag } from '../src/sandbox/image-cache.js';
import { handleBuildSandboxImageJob } from '../src/queues/cli-exec/handlers.js';
import { ensureCodexAppServerVerdict } from '../src/cli-adapters/codex-app-server-probe.js';
import { resolveDispatchSandboxToolchain } from '../src/orchestrator/sandbox-toolchain.js';
import {
  markProvidersReady,
  probeCliPath,
  resolveSandboxImageTag,
} from '../src/queues/cli-exec/images.js';

const ID = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';
const REFUSED = '1.2.3\nRUN id\u2028\u009b';
const payload = { providerId: ID, userId: USER, force: true };

function setup(cliVersion: string | null = REFUSED) {
  const fake = createFakeDb({ cliProviders: schema.cliProviders, tasks: schema.tasks });
  fake.insert(schema.cliProviders, {
    id: ID,
    userId: USER,
    name: 'codex',
    label: 'p',
    cliVersion,
    sandboxDockerfileExtra: null,
    sandboxImageTag: 'haive-cli-sandbox:old',
    sandboxImageBuildStatus: 'building',
    sandboxImageBuildError: null,
  });
  const row = () => fake.rows(schema.cliProviders)[0]!;
  const edit = async (patch: Record<string, unknown>) => {
    await fake.db.update(schema.cliProviders).set(patch).where(eq(schema.cliProviders.id, ID));
  };
  const beforeLock = (fn: () => Promise<void>) => {
    const transaction = fake.db.transaction.bind(fake.db);
    vi.spyOn(fake.db, 'transaction').mockImplementationOnce(async (run) => {
      await fn();
      return transaction(run);
    });
  };
  return { db: fake.db as unknown as Database, fake, row, edit, beforeLock };
}

beforeEach(() => {
  vi.clearAllMocks();
  docker.inspect.mockResolvedValue({ exists: false, imageId: null });
  docker.remove.mockResolvedValue({ ok: true });
});

it('records an escaped refusal on a building row without touching Docker or its last image', async () => {
  const { db, row } = setup();
  const result = await handleBuildSandboxImageJob(db, payload);
  expect(result).toMatchObject({
    ok: false,
    error: expect.stringContaining('invalid version token'),
  });
  expect(result.error).toContain('\\nRUN id\\u2028\\u009b');
  expect(result.error).not.toMatch(/[\n\u2028\u009b]/);
  expect(row()).toMatchObject({
    sandboxImageBuildStatus: 'failed',
    sandboxImageBuildError: result.error,
    sandboxImageTag: 'haive-cli-sandbox:old',
    cliVersion: REFUSED,
  });
  expect(docker.inspect).not.toHaveBeenCalled();
  expect(docker.build).not.toHaveBeenCalled();
  expect(docker.remove).not.toHaveBeenCalled();
});

it.each([
  { cliVersion: '1.2.3', sandboxImageBuildStatus: 'ready', sandboxImageBuildError: null },
  { cliVersion: '$(another)', sandboxImageBuildStatus: 'building' },
  { name: 'gemini', sandboxImageBuildStatus: 'building' },
  { sandboxDockerfileExtra: 'RUN echo changed', sandboxImageBuildStatus: 'building' },
])('leaves a refused config changed before its row lock: %j', async (patch) => {
  const { db, row, edit, beforeLock } = setup();
  beforeLock(() => edit(patch));
  await expect(handleBuildSandboxImageJob(db, payload)).resolves.toMatchObject({ ok: false });
  expect(row()).toMatchObject({ ...patch, sandboxImageBuildError: null });
  expect(docker.build).not.toHaveBeenCalled();
});

it('does not start an old valid build after the locked config becomes refused', async () => {
  const { db, row, edit, beforeLock } = setup('1.2.3');
  beforeLock(() =>
    edit({
      cliVersion: REFUSED,
      sandboxImageBuildStatus: 'failed',
      sandboxImageBuildError: 'new refusal',
    }),
  );
  await expect(handleBuildSandboxImageJob(db, payload)).resolves.toMatchObject({ ok: false });
  expect(row()).toMatchObject({
    sandboxImageBuildStatus: 'failed',
    sandboxImageBuildError: 'new refusal',
  });
  expect(docker.build).not.toHaveBeenCalled();
});

it('does not confuse a refused locked config with one wanting no image', async () => {
  const { db, row } = setup();
  // Retained no-install path: all current providers install a CLI, so exercise it at the resolver seam.
  vi.mocked(resolveImageTag).mockReturnValueOnce(null);
  await expect(handleBuildSandboxImageJob(db, payload)).resolves.toMatchObject({ ok: false });
  expect(row()).toMatchObject({
    sandboxImageBuildStatus: 'building',
    sandboxImageTag: 'haive-cli-sandbox:old',
  });
  expect(docker.remove).not.toHaveBeenCalled();
});

it('does not overwrite a newer refused config when an old Docker build fails', async () => {
  const { db, row, edit } = setup('1.2.3');
  docker.build.mockImplementationOnce(async () => {
    await edit({
      cliVersion: REFUSED,
      sandboxImageBuildStatus: 'failed',
      sandboxImageBuildError: 'new refusal',
    });
    throw new Error('old Docker failure');
  });
  await expect(handleBuildSandboxImageJob(db, payload)).resolves.toMatchObject({ ok: false });
  expect(row()).toMatchObject({
    sandboxImageBuildStatus: 'failed',
    sandboxImageBuildError: 'new refusal',
  });
});

it('dispatch resolution refuses immediately, before inspecting or polling a building row', async () => {
  const { db, row } = setup();
  await expect(
    resolveSandboxImageTag(db, null, row() as unknown as CliProviderRecord),
  ).rejects.toThrow('invalid version token');
  expect(docker.inspect).not.toHaveBeenCalled();
});

it('the interactive CLI probe returns a visible refusal without spawning a CLI', async () => {
  const { db, row } = setup();
  const result = await probeCliPath(
    db,
    { defaultExecutable: 'codex' } as BaseCliAdapter,
    row() as unknown as CliProviderRecord,
  );
  expect(result).toMatchObject({
    ok: false,
    error: expect.stringContaining('invalid version token'),
  });
  expect(docker.inspect).not.toHaveBeenCalled();
});

it('readiness ignores a refused self as well as refused siblings', async () => {
  const { db, row } = setup();
  await expect(markProvidersReady(db, 'haive-cli-sandbox:old', ID, true)).resolves.toEqual({
    self: false,
    replaced: [],
  });
  expect(row().sandboxImageBuildStatus).toBe('building');
});

it('the Codex capability probe absorbs a refusal and starts no container', async () => {
  const { db, row } = setup();
  await expect(
    ensureCodexAppServerVerdict(
      db,
      USER,
      row() as unknown as CliProviderRecord,
      {} as BaseCliAdapter,
    ),
  ).resolves.toBeNull();
  expect(resolveImageTag).toHaveBeenCalled();
  expect(docker.inspect).not.toHaveBeenCalled();
});

it('an advisory dispatch peek skips a refused provider and continues its batch', async () => {
  const { db, row } = setup();
  const refused = { ...row(), enabled: true } as unknown as CliProviderRecord;
  const valid = { ...refused, id: 'valid', cliVersion: '1.2.3' };
  const result = await resolveDispatchSandboxToolchain(db, USER, [refused, valid], {
    resolveFacets: async () => ({
      language: ['php'],
      framework: [],
      frameworkMajor: [],
      phpMajor: [],
      nodeMajor: [],
      database: [],
      dbMajor: [],
      packages: [],
      tags: [],
    }),
    cacheLimits: { cacheLimit: 0 },
  });
  expect(resolveImageTag).toHaveBeenCalledTimes(2);
  expect(docker.inspect).toHaveBeenCalledTimes(1);
  expect(result).toEqual({ valid: null });
});
