import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: h.exec }),
}));
import { readReleaseManifestImage } from './docker.js';
const dirs: string[] = [];
beforeEach(() => {
  vi.stubEnv('HAIVE_INSTALL_ID', 't335b_test');
  h.exec.mockReset().mockImplementation(async (_command: string, args: string[]) => {
    if (args[0] === 'cp') await writeFile(args[2]!, '{"manifestVersion":1}');
    return { stdout: args[0] === 'create' ? 'container-id\n' : '' };
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
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
