import { writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: h.exec }),
}));
import { readReleaseManifestImage } from './docker.js';
beforeEach(() => {
  vi.stubEnv('HAIVE_INSTALL_ID', 't335b_test');
  h.exec.mockReset().mockImplementation(async (_command: string, args: string[]) => {
    if (args[0] === 'cp') await writeFile(args[2]!, '{"manifestVersion":1}');
    return { stdout: args[0] === 'create' ? 'container-id\n' : '' };
  });
});
afterEach(() => vi.unstubAllEnvs());
it('temp manifest container is removed on success, named by install, and uses a scratch-compatible command', async () => {
  expect(await readReleaseManifestImage('private/release:1')).toBe('{"manifestVersion":1}');
  const calls = h.exec.mock.calls.map((c) => c[1] as string[]);
  expect(calls[0]).toEqual(['pull', 'private/release:1']);
  expect(calls[1]).toEqual([
    'create',
    '--name',
    expect.stringMatching(/^t335b_test-upgrade-manifest-/),
    'private/release:1',
    '/unused',
  ]);
  expect(calls[2]).toEqual(['cp', 'container-id:/release.json', expect.any(String)]);
  expect(calls[3]).toEqual(['rm', '-f', 'container-id']);
});
it.each(['create', 'cp'])('temp manifest container is removed on %s failure', async (failure) => {
  h.exec.mockImplementation(async (_command: string, args: string[]) => {
    if (args[0] === failure) throw new Error('fixture ' + failure + ' failure');
    return { stdout: args[0] === 'create' ? 'container-id' : '' };
  });
  await expect(readReleaseManifestImage('private/release:1')).rejects.toThrow('fixture');
  expect(h.exec.mock.calls.at(-1)![1]).toEqual([
    'rm',
    '-f',
    failure === 'create' ? expect.stringMatching(/^t335b_test-upgrade-manifest-/) : 'container-id',
  ]);
});
it('an unpullable manifest cannot create or use a cached image', async () => {
  h.exec.mockRejectedValue(new Error('pull denied'));
  await expect(readReleaseManifestImage('private/release:1')).rejects.toThrow('pull denied');
  expect(h.exec).toHaveBeenCalledTimes(1);
});

it('channel rollback inventory includes digest pins while public inventory stays unchanged', async () => {
  const { localImages } = await import('./docker.js');
  const pin = `private/api@sha256:${'a'.repeat(64)}`;
  h.exec.mockResolvedValue({ stdout: `private/api:1\t${pin}\nprivate/old:2\tprivate/old@<none>` });
  expect(await localImages(true)).toEqual(['private/api:1', pin, 'private/old:2']);
  expect(h.exec.mock.calls[0]![1]).toContain('--digests');
  h.exec.mockResolvedValue({ stdout: 'public/api:1\npublic/web:1' });
  expect(await localImages()).toEqual(['public/api:1', 'public/web:1']);
  expect(h.exec.mock.calls[1]![1]).toEqual(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}']);
});

it('channel own-module builder receives an install-local credential mount for its Docker client', async () => {
  const { buildOwnModules } = await import('./docker.js');
  await buildOwnModules('private/builder@sha256:abc', '/modules', {}, '/host/install/.docker');
  const args = h.exec.mock.calls[1]![1] as string[];
  expect(args).toContain(
    'type=bind,src=/host/install/.docker,dst=/run/haive-docker-config,readonly',
  );
  expect(args).toContain('DOCKER_CONFIG=/run/haive-docker-config');
  expect(args).toContain('BUILDX_CONFIG=/tmp/buildx');
  h.exec.mockClear();
  await buildOwnModules('public/builder:1', '/modules', {});
  expect((h.exec.mock.calls[1]![1] as string[]).join(' ')).not.toContain('DOCKER_CONFIG');
  expect((h.exec.mock.calls[1]![1] as string[]).join(' ')).not.toContain('BUILDX_CONFIG');
});

it('refuses a copied release.json symlink and still removes the container', async () => {
  const { mkdtemp, symlink, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'manifest-link-test-'));
  try {
    const target = join(dir, 'target');
    await writeFile(target, 'host-only-file');
    h.exec.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === 'cp') await symlink(target, args[2]!);
      return { stdout: args[0] === 'create' ? 'container-id' : '' };
    });
    await expect(readReleaseManifestImage('private/release:1')).rejects.toThrow();
    expect(h.exec.mock.calls.at(-1)![1]).toEqual(['rm', '-f', 'container-id']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
