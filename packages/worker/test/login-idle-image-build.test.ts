import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';

// Docker and the core image build are controlled; provider rows, the image build single-flight,
// the tag lock and the readiness writes are the real ones.
const docker = vi.hoisted(() => ({
  inspect: vi.fn(),
  build: vi.fn(),
  remove: vi.fn(),
  run: vi.fn(),
}));
const engine = vi.hoisted(() => ({ createContainer: vi.fn() }));
vi.mock('../src/sandbox/docker-runner.js', async (original) => {
  const actual = await original<typeof import('../src/sandbox/docker-runner.js')>();
  return { ...actual, defaultDockerRunner: { ...actual.defaultDockerRunner, ...docker } };
});
vi.mock('../src/sandbox/sandbox-core-image.js', async (original) => ({
  ...(await original<object>()),
  ensureSandboxCoreImage: async () => {},
}));
vi.mock('dockerode', () => ({
  default: class {
    createContainer = engine.createContainer;
  },
}));

import type { CliProviderName } from '@haive/shared';
import { cliAdapterRegistry } from '../src/cli-adapters/registry.js';
import { handleLoginCreateJob } from '../src/queues/cli-exec/handlers.js';
import { probeCliPath } from '../src/queues/cli-exec/images.js';
import { resolveImageTag } from '../src/sandbox/image-cache.js';

const USER = '00000000-0000-4000-8000-000000000002';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

function provider(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    userId: USER,
    name: 'codex',
    label: id,
    authMode: 'subscription',
    isolateAuth: false,
    envVars: {},
    cliVersion: '1.2.3',
    sandboxDockerfileExtra: null,
    wrapperPath: null,
    executablePath: null,
    sandboxImageTag: null,
    sandboxImageBuildStatus: 'idle',
    sandboxImageBuildError: null,
    ...over,
  };
}

/** The tag a provider's config asks for, which is what a build produces for it. */
const tagFor = (name = 'codex', cliVersion = '1.2.3', id = A) =>
  resolveImageTag({
    name: name as CliProviderName,
    cliVersion,
    providerId: id,
    sandboxDockerfileExtra: null,
  })!.tag;

function setup(...rows: Record<string, unknown>[]) {
  const fake = createFakeDb({ cliProviders: schema.cliProviders, containers: schema.containers });
  for (const r of rows) fake.insert(schema.cliProviders, r);
  const row = (id: string) => fake.rows(schema.cliProviders).find((r) => r.id === id)!;
  return { db: fake.db as unknown as Database, row, fake };
}

const login = (db: Database, providerId = A) =>
  handleLoginCreateJob(db, { providerId, userId: USER });
const test = (db: Database, row: object) =>
  probeCliPath(db, cliAdapterRegistry.get('codex'), row as unknown as CliProviderRecord);

/** Tags on the host. A build adds its tag when it ends, after the gate opens. */
let present: Set<string>;
let release: () => void;
const hold = () => {
  const gate = new Promise<void>((resolve) => (release = resolve));
  docker.build.mockImplementation(async ({ tag }: { tag: string }) => {
    await gate;
    present.add(tag);
    return { exitCode: 0, imageTag: tag, imageId: 'sha256:new', durationMs: 1, stderr: '' };
  });
};
const chowns = () => docker.run.mock.calls.filter(([o]) => String(o.cmd).includes('chown'));
const imageOfContainer = () => engine.createContainer.mock.calls[0]?.[0]?.Image;
/** The image the Test's `--version` run used. */
const imageOfProbe = () =>
  docker.run.mock.calls.find(([o]) => String(o.cmd).includes('--version'))?.[0]?.image;
const builtTag = () => docker.build.mock.calls[0]?.[0]?.tag as string;
const settleBuild = () => vi.waitFor(() => expect(docker.build).toHaveBeenCalled());
const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  vi.clearAllMocks();
  present = new Set();
  docker.inspect.mockImplementation(async (tag: string) =>
    present.has(tag)
      ? { exists: true, imageId: `sha256:${tag}`, labels: {} }
      : { exists: false, imageId: null },
  );
  docker.remove.mockResolvedValue({ ok: true, stderr: '' });
  docker.run.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
  engine.createContainer.mockResolvedValue({ id: 'login-container', remove: vi.fn() });
  hold();
  release();
});

// A held build must not outlive a failing test: it would keep the tag's turn from every later one.
afterEach(() => release());

describe('Log in on a row whose sandbox image is not built', () => {
  it('builds an idle row once, then creates the login container in the built image', async () => {
    const { db, row } = setup(provider(A));
    const result = await login(db);
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ ok: true, dockerContainerId: 'login-container' });
    expect(docker.build).toHaveBeenCalledTimes(1);
    expect(imageOfContainer()).toBe(builtTag());
    expect(row(A)).toMatchObject({
      sandboxImageBuildStatus: 'ready',
      sandboxImageTag: builtTag(),
      sandboxImageBuildError: null,
    });
    // The auth volume is touched only once the login can go on.
    expect(chowns().length).toBeGreaterThan(0);
    expect(docker.build.mock.invocationCallOrder[0]).toBeLessThan(
      docker.run.mock.invocationCallOrder[0]!,
    );
  });

  it('uses an image already on the host without a build or a write to the row', async () => {
    const tag = tagFor();
    present.add(tag);
    const { db, row } = setup(provider(A));
    await expect(login(db)).resolves.toMatchObject({ ok: true });
    expect(docker.build).not.toHaveBeenCalled();
    expect(imageOfContainer()).toBe(tag);
    expect(row(A)).toMatchObject({ sandboxImageBuildStatus: 'idle', sandboxImageTag: null });
  });

  it('leaves a ready row with its image alone', async () => {
    const tag = tagFor();
    present.add(tag);
    const { db, row } = setup(
      provider(A, { sandboxImageTag: tag, sandboxImageBuildStatus: 'ready' }),
    );
    await expect(login(db)).resolves.toMatchObject({ ok: true });
    expect(docker.build).not.toHaveBeenCalled();
    expect(imageOfContainer()).toBe(tag);
    expect(row(A)).toMatchObject({ sandboxImageBuildStatus: 'ready', sandboxImageTag: tag });
  });

  it('rebuilds a ready row whose image was pruned instead of failing in Docker', async () => {
    const { db, row } = setup(
      provider(A, { sandboxImageTag: tagFor(), sandboxImageBuildStatus: 'ready' }),
    );
    await expect(login(db)).resolves.toMatchObject({ ok: true });
    expect(docker.build).toHaveBeenCalledTimes(1);
    expect(imageOfContainer()).toBe(builtTag());
    expect(row(A).sandboxImageBuildStatus).toBe('ready');
  });
});

describe('concurrent builders of one tag', () => {
  it('Login while Test is building the image starts no second build and is refused as building', async () => {
    hold();
    const { db, row } = setup(provider(A));
    const tested = test(db, row(A));
    await settleBuild();
    const result = await login(db);
    expect(result).toMatchObject({ ok: false, code: 'sandbox_image_building' });
    expect(docker.build).toHaveBeenCalledTimes(1);
    expect(engine.createContainer).not.toHaveBeenCalled();
    expect(chowns()).toHaveLength(0);
    expect(row(A).sandboxImageBuildStatus).toBe('building');
    release();
    await expect(tested).resolves.toMatchObject({ ok: true });
    expect(imageOfProbe()).toBe(builtTag());
    expect(row(A)).toMatchObject({ sandboxImageBuildStatus: 'ready', sandboxImageTag: builtTag() });
    expect(docker.build).toHaveBeenCalledTimes(1);
  });

  it('Test while Login is building the image starts no second build', async () => {
    hold();
    const { db, row } = setup(provider(A));
    const loggingIn = login(db);
    await settleBuild();
    const tested = await test(db, row(A));
    expect(tested).toMatchObject({ ok: false, error: expect.stringContaining('in progress') });
    expect(docker.build).toHaveBeenCalledTimes(1);
    release();
    await expect(loggingIn).resolves.toMatchObject({ ok: true });
    expect(imageOfContainer()).toBe(builtTag());
    expect(row(A).sandboxImageBuildStatus).toBe('ready');
    expect(docker.build).toHaveBeenCalledTimes(1);
  });

  it('Login and Test started together build the tag once and leave the row ready', async () => {
    hold();
    const { db, row } = setup(provider(A));
    const both = Promise.all([login(db), test(db, row(A))]);
    await settleBuild();
    await pause();
    release();
    const [loggedIn] = await both;
    expect(docker.build).toHaveBeenCalledTimes(1);
    expect(row(A)).toMatchObject({ sandboxImageBuildStatus: 'ready', sandboxImageTag: builtTag() });
    // Whichever of the two reached the row first built; the other joined it or was told it builds.
    expect(loggedIn.ok ? 'proceeded' : loggedIn.code).toMatch(
      /^(proceeded|sandbox_image_building)$/,
    );
  });

  it('two logins on providers that share a tag build it once and both proceed in it', async () => {
    hold();
    const rows = [A, B].map((id) => provider(id, { name: 'claude-code', cliVersion: '1.0.0' }));
    const { db, row } = setup(...rows);
    const both = Promise.all([login(db, A), login(db, B)]);
    await settleBuild();
    await pause();
    release();
    const results = await both;
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(docker.build).toHaveBeenCalledTimes(1);
    expect(engine.createContainer.mock.calls.map(([o]) => o.Image)).toEqual([
      builtTag(),
      builtTag(),
    ]);
    expect([row(A), row(B)].map((r) => r.sandboxImageBuildStatus)).toEqual(['ready', 'ready']);
  });
});

describe('Log in on a row whose image cannot be used', () => {
  it('refuses a building row with the building code and writes nothing', async () => {
    const { db, row } = setup(provider(A, { sandboxImageBuildStatus: 'building' }));
    const result = await login(db);
    expect(result).toMatchObject({ ok: false, code: 'sandbox_image_building' });
    expect(docker.build).not.toHaveBeenCalled();
    expect(engine.createContainer).not.toHaveBeenCalled();
    expect(chowns()).toHaveLength(0);
    expect(row(A).sandboxImageBuildStatus).toBe('building');
  });

  it('leaves a failed inline build as failed with its error and refuses with the failed code', async () => {
    docker.build.mockResolvedValueOnce({
      exitCode: 1,
      imageTag: 'x',
      imageId: null,
      durationMs: 1,
      stderr: 'step 4 failed: synthetic',
    });
    const { db, row } = setup(provider(A));
    const result = await login(db);
    expect(result).toMatchObject({ ok: false, code: 'sandbox_image_failed' });
    expect(row(A)).toMatchObject({
      sandboxImageBuildStatus: 'failed',
      sandboxImageBuildError: expect.stringContaining('step 4 failed: synthetic'),
    });
    expect(engine.createContainer).not.toHaveBeenCalled();
    expect(chowns()).toHaveLength(0);
  });

  it('records a build that throws as failed, never as building', async () => {
    docker.build.mockRejectedValueOnce(new Error('docker daemon went away'));
    const { db, row } = setup(provider(A));
    const result = await login(db);
    expect(result).toMatchObject({ ok: false, code: 'sandbox_image_failed' });
    expect(row(A).sandboxImageBuildStatus).toBe('failed');
    expect(row(A).sandboxImageBuildError).toContain('docker daemon went away');
  });

  it('builds again on the next Log in after a failure and proceeds', async () => {
    docker.build.mockRejectedValueOnce(new Error('registry unreachable'));
    const { db, row } = setup(provider(A));
    await expect(login(db)).resolves.toMatchObject({ ok: false, code: 'sandbox_image_failed' });
    hold();
    release();
    await expect(login(db)).resolves.toMatchObject({ ok: true });
    expect(docker.build).toHaveBeenCalledTimes(2);
    expect(row(A)).toMatchObject({
      sandboxImageBuildStatus: 'ready',
      sandboxImageBuildError: null,
    });
  });

  it('gives an unrelated failure no code', async () => {
    const { db } = setup(provider(A));
    const result = await handleLoginCreateJob(db, { providerId: B, userId: USER });
    expect(result).toEqual({ ok: false, error: 'provider not found' });
  });
});
