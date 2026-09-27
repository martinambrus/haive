import { beforeEach, describe, expect, it, vi } from 'vitest';

const docker = vi.hoisted(() => ({
  inspect: vi.fn(),
  build: vi.fn(),
  remove: vi.fn(),
}));
const tagOf = vi.hoisted(() =>
  vi.fn((): { tag: string; shared: boolean; dockerfileLines: string[] } | null => ({
    tag: 'haive-cli-claude:1.0.0',
    shared: true,
    dockerfileLines: [],
  })),
);

vi.mock('../src/sandbox/docker-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sandbox/docker-runner.js')>();
  return { ...actual, defaultDockerRunner: { ...actual.defaultDockerRunner, ...docker } };
});
vi.mock('../src/sandbox/image-cache.js', () => ({
  resolveImageTag: tagOf,
  renderDockerfile: () => 'FROM haive-cli-sandbox:latest\n',
}));
vi.mock('../src/sandbox/sandbox-core-image.js', () => ({
  ensureSandboxCoreImage: async () => {},
  SANDBOX_CORE_IMAGE_HEADLINE: 'x',
}));

import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  handleBuildSandboxImageJob,
  handleRemoveSandboxImageJob,
} from '../src/queues/cli-exec/handlers.js';

const TAG = 'haive-cli-claude:1.0.0';
const USER = '00000000-0000-4000-8000-0000000000a1';
const PROVIDER = '00000000-0000-4000-8000-0000000000b2';

beforeEach(() => {
  for (const f of Object.values(docker)) f.mockReset();
  tagOf.mockClear();
});

function withProvider() {
  const fake = createFakeDb({ cliProviders: schema.cliProviders });
  fake.insert(schema.cliProviders, {
    id: PROVIDER,
    userId: USER,
    name: 'zai',
    label: 'zai',
    cliVersion: '1.0.0',
    sandboxImageTag: null,
  });
  return fake;
}

describe("removing a deleted provider's image while another provider asks for its tag", () => {
  it('builds the tag again rather than marking a provider ready on the image being removed', async () => {
    const fake = withProvider();
    let exists = true;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    docker.inspect.mockImplementation(async () =>
      exists ? { exists: true, imageId: 'sha256:old' } : { exists: false },
    );
    docker.remove.mockImplementation(async () => {
      await gate;
      exists = false;
      return { ok: true, stderr: '' };
    });
    docker.build.mockImplementation(async () => {
      exists = true;
      return {
        exitCode: 0,
        imageTag: TAG,
        imageId: 'sha256:new',
        durationMs: 1,
        stderr: '',
        timedOut: false,
      };
    });

    const db = fake.db as unknown as Database;
    const removing = handleRemoveSandboxImageJob(db, { providerId: 'gone', imageTag: TAG });
    await vi.waitFor(() => expect(docker.remove).toHaveBeenCalled());
    const building = handleBuildSandboxImageJob(db, { providerId: PROVIDER, userId: USER });
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await Promise.all([removing, building]);

    expect(docker.build).toHaveBeenCalledTimes(1);
    expect(fake.rows(schema.cliProviders)[0]).toMatchObject({
      sandboxImageTag: TAG,
      sandboxImageBuildStatus: 'ready',
    });
  });

  /** A build of `TAG` for PROVIDER held until `release`, ending in `exitCode`. The provider
   *  names `previousTag` before it; `standing` lists the tags that exist, and a build that
   *  succeeds adds `TAG`. */
  function heldBuild(exitCode: number, previousTag: string | null, standing: Set<string>) {
    const fake = createFakeDb({ cliProviders: schema.cliProviders });
    fake.insert(schema.cliProviders, {
      id: PROVIDER,
      userId: USER,
      name: 'zai',
      label: 'zai',
      cliVersion: '1.0.0',
      sandboxImageTag: previousTag,
    });
    docker.inspect.mockImplementation(async (tag: string) =>
      standing.has(tag) ? { exists: true, imageId: `sha256:${tag}` } : { exists: false },
    );
    docker.remove.mockImplementation(async (tag: string) => {
      standing.delete(tag);
      return { ok: true, stderr: '' };
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    docker.build.mockImplementation(async () => {
      await gate;
      if (exitCode === 0) standing.add(TAG);
      return {
        exitCode,
        imageTag: TAG,
        imageId: `sha256:${TAG}`,
        durationMs: 1,
        stderr: exitCode === 0 ? '' : 'boom',
        timedOut: false,
      };
    });
    const db = fake.db as unknown as Database;
    const building = handleBuildSandboxImageJob(db, {
      providerId: PROVIDER,
      userId: USER,
      force: true,
    });
    return { db, building, release };
  }

  /** Delete the provider while its build is held, queue the removal of the tag its row names, then
   *  let the build end. */
  async function deleteDuringBuild(build: ReturnType<typeof heldBuild>) {
    await vi.waitFor(() => expect(docker.build).toHaveBeenCalled());
    await build.db.delete(schema.cliProviders).where(eq(schema.cliProviders.id, PROVIDER));
    const removing = handleRemoveSandboxImageJob(build.db, { providerId: PROVIDER, imageTag: TAG });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(docker.remove).not.toHaveBeenCalled();
    build.release();
    await Promise.all([build.building, removing]);
  }

  it('removes the image of a provider deleted while it was built, once the build ends', async () => {
    const standing = new Set<string>();
    await deleteDuringBuild(heldBuild(0, null, standing));
    expect(standing.has(TAG)).toBe(false);
  });

  it('removes the image a forced rebuild left when the rebuild fails', async () => {
    const standing = new Set([TAG]);
    await deleteDuringBuild(heldBuild(1, TAG, standing));
    expect(standing.has(TAG)).toBe(false);
  });

  it('removes the image the provider named before when a build of a new tag fails', async () => {
    const older = 'haive-cli-claude:0.9.0';
    const standing = new Set([older]);
    await deleteDuringBuild(heldBuild(1, older, standing));
    expect(standing.has(older)).toBe(false);
  });

  it('removes the image of a provider deleted before its build registered', async () => {
    const fake = withProvider();
    const standing = new Set<string>();
    let releaseInspect!: () => void;
    const inspectGate = new Promise<void>((resolve) => (releaseInspect = resolve));
    let firstInspect = true;
    docker.inspect.mockImplementation(async (tag: string) => {
      if (firstInspect) {
        firstInspect = false;
        await inspectGate;
      }
      return standing.has(tag) ? { exists: true, imageId: `sha256:${tag}` } : { exists: false };
    });
    docker.remove.mockImplementation(async (tag: string) => {
      standing.delete(tag);
      return { ok: true, stderr: '' };
    });
    let removalDone!: () => void;
    const afterRemoval = new Promise<void>((resolve) => (removalDone = resolve));
    docker.build.mockImplementation(async () => {
      await afterRemoval;
      standing.add(TAG);
      return {
        exitCode: 0,
        imageTag: TAG,
        imageId: `sha256:${TAG}`,
        durationMs: 1,
        stderr: '',
        timedOut: false,
      };
    });

    const db = fake.db as unknown as Database;
    const building = handleBuildSandboxImageJob(db, { providerId: PROVIDER, userId: USER });
    await vi.waitFor(() => expect(docker.inspect).toHaveBeenCalled());
    await db.delete(schema.cliProviders).where(eq(schema.cliProviders.id, PROVIDER));
    const removing = handleRemoveSandboxImageJob(db, { providerId: PROVIDER, imageTag: TAG }).then(
      removalDone,
    );
    releaseInspect();
    await Promise.all([building, removing]);

    expect(docker.build).toHaveBeenCalledTimes(1);
    expect(standing.has(TAG)).toBe(false);
  });
});

describe("a provider's row names its image only once the image is built", () => {
  const OLDER = 'haive-cli-claude:0.9.0';

  /** The provider names OLDER, which exists; each build of TAG ends in the next exit code. */
  function onOlder(exitCodes: number[]) {
    const fake = createFakeDb({ cliProviders: schema.cliProviders });
    fake.insert(schema.cliProviders, {
      id: PROVIDER,
      userId: USER,
      name: 'zai',
      label: 'zai',
      cliVersion: '1.0.0',
      sandboxImageTag: OLDER,
      sandboxImageBuildStatus: 'ready',
    });
    const standing = new Set([OLDER]);
    docker.inspect.mockImplementation(async (tag: string) =>
      standing.has(tag) ? { exists: true, imageId: `sha256:${tag}` } : { exists: false },
    );
    docker.remove.mockImplementation(async (tag: string) => {
      standing.delete(tag);
      return { ok: true, stderr: '' };
    });
    docker.build.mockImplementation(async () => {
      const exitCode = exitCodes.shift() ?? 0;
      if (exitCode === 0) standing.add(TAG);
      return {
        exitCode,
        imageTag: TAG,
        imageId: `sha256:${TAG}`,
        durationMs: 1,
        stderr: exitCode === 0 ? '' : 'boom',
        timedOut: false,
      };
    });
    const db = fake.db as unknown as Database;
    const build = () => handleBuildSandboxImageJob(db, { providerId: PROVIDER, userId: USER });
    return { fake, db, standing, build };
  }

  it('keeps naming the image it had when a build of a new tag fails', async () => {
    const { fake, standing, build } = onOlder([1]);
    expect((await build()).ok).toBe(false);
    expect(fake.rows(schema.cliProviders)[0]).toMatchObject({
      sandboxImageTag: OLDER,
      sandboxImageBuildStatus: 'failed',
    });
    expect(standing.has(OLDER)).toBe(true);
  });

  it('removes the image it had once a later build succeeds', async () => {
    const { fake, standing, build } = onOlder([1, 0]);
    await build();
    expect((await build()).ok).toBe(true);
    expect(fake.rows(schema.cliProviders)[0]).toMatchObject({
      sandboxImageTag: TAG,
      sandboxImageBuildStatus: 'ready',
    });
    expect([...standing]).toEqual([TAG]);
  });

  // Its version changed while a build of the old one ran, and the build of the new one ended first.
  it('keeps the image its config asks for when an older build finishes last', async () => {
    const stale = 'haive-cli-claude:1.1.0';
    const { db, standing } = onOlder([]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    docker.build.mockImplementation(async (opts: { tag: string }) => {
      if (opts.tag === stale) await gate;
      standing.add(opts.tag);
      return {
        exitCode: 0,
        imageTag: opts.tag,
        imageId: `sha256:${opts.tag}`,
        durationMs: 1,
        stderr: '',
        timedOut: false,
      };
    });
    tagOf.mockReturnValueOnce({ tag: stale, shared: true, dockerfileLines: [] });
    const forced = () =>
      handleBuildSandboxImageJob(db, { providerId: PROVIDER, userId: USER, force: true });
    const older = forced();
    await vi.waitFor(() => expect(docker.build).toHaveBeenCalled());
    await forced();
    release();
    await older;
    expect(standing.has(TAG)).toBe(true);
    expect(standing.has(OLDER)).toBe(false);
  });

  it('removes the image it had when it no longer needs one', async () => {
    const { fake, standing, build } = onOlder([]);
    tagOf.mockReturnValueOnce(null);
    expect((await build()).ok).toBe(true);
    expect(fake.rows(schema.cliProviders)[0]).toMatchObject({
      sandboxImageTag: null,
      sandboxImageBuildStatus: 'idle',
    });
    expect(standing.has(OLDER)).toBe(false);
  });
});
