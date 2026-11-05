import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@haive/shared';
import {
  PIN_SCRIPT,
  pinModuleTree,
  resolveWorkerImage,
  modulePinError,
} from '../src/modules/source-pin.js';

vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>();
  return {
    ...actual,
    hostname: () => process.env.MODULE_SOURCE_TEST_CONTAINER ?? actual.hostname(),
  };
});

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
      logger.info({ removed: root }, 'T337 pin temp cleanup');
    }),
  );
});
describe('daemon-side atomic pin helper', () => {
  it('resolves only an immutable image id from the worker container and names resolution failures', async () => {
    const inspect = vi.fn().mockResolvedValue('sha256:' + 'a'.repeat(64) + '\n');
    expect(await resolveWorkerImage('worker-container', inspect)).toBe('sha256:' + 'a'.repeat(64));
    expect(inspect).toHaveBeenCalledWith('worker-container');
    for (const value of ['', 'haive-worker:latest', 'sha256:bad']) {
      inspect.mockResolvedValue(value);
      await expect(resolveWorkerImage('worker-container', inspect)).rejects.toThrow(
        'module_source_worker_image_unavailable',
      );
    }
    inspect.mockRejectedValue(new Error('/private/host/path'));
    await expect(resolveWorkerImage('worker-container', inspect)).rejects.toThrow(
      'module_source_worker_image_unavailable',
    );
  });
  it('scrubs the daemon directory before Docker stderr reaches last_error', () => {
    const hostDir = '/srv/private prepared/modules';
    const error = modulePinError(
      {
        stderr: `docker: invalid mount config for type "bind": bind source path does not exist: ${hostDir}\n`,
      },
      hostDir,
    );
    expect(error.message).toContain('bind source path does not exist');
    expect(error.message).not.toContain(hostDir);
    expect(error.message).not.toContain('/srv/');
  });
  it.skipIf(process.env.MODULE_SOURCE_DOCKER_TEST !== 'true')(
    'streams binary data through the actual Docker helper',
    async () => {
      const { input, output } = await prepare();
      const bytes = Buffer.from([0, 1, 128, 254, 255, 10]);
      await writeFile(join(input, 'binary'), bytes);
      await pinModuleTree(input, output, 'alpha');
      expect(await readFile(join(output, 'alpha', 'binary'))).toEqual(bytes);
      await writeFile(join(input, 'value'), 'refreshed');
      await pinModuleTree(input, output, 'alpha');
      expect(await readFile(join(output, 'alpha', 'value'), 'utf8')).toBe('refreshed');
      await rm(join(output, 'alpha', '.haive-source.json'));
      await expect(pinModuleTree(input, output, 'alpha')).rejects.toThrow(
        /unmarked module directory/,
      );
    },
  );
  async function prepare() {
    const root = await mkdtemp(join(tmpdir(), 't337-pin-'));
    roots.push(root);
    const input = join(root, 'input');
    const output = join(root, 'output');
    await mkdir(input);
    await mkdir(output);
    await writeFile(join(input, 'value'), 'new');
    await writeFile(
      join(input, '.haive-source.json'),
      JSON.stringify({ module_id: 'alpha', kind: 'git' }),
    );
    const { stdout: tar } = await exec('tar', ['-cf', '-', '-C', input, '.'], {
      encoding: 'buffer',
    });
    const pin = () =>
      new Promise<void>((resolve, reject) => {
        const child = execFile('python3', ['-c', PIN_SCRIPT, output, 'alpha'], (error) =>
          error ? reject(error) : resolve(),
        );
        child.stdin!.on('error', () => {});
        child.stdin!.end(tar);
      });
    return { root, input, output, pin };
  }
  it('pins a new tree and atomically replaces a marked directory', async () => {
    const { output, pin } = await prepare();
    await pin();
    expect(await readFile(join(output, 'alpha', 'value'), 'utf8')).toBe('new');
    await writeFile(join(output, 'alpha', 'value'), 'old');
    await pin();
    expect(await readFile(join(output, 'alpha', 'value'), 'utf8')).toBe('new');
    expect(await readdir(output)).toEqual(['alpha']);
  });
  it('removes only stale stages for the current module without following links', async () => {
    const { root, output, pin } = await prepare();
    const stale = join(output, '.alpha.tmp-abandoned');
    await mkdir(stale);
    await writeFile(join(stale, 'value'), 'stale');
    await mkdir(join(output, '.beta.tmp-other'));
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'keep'), 'keep');
    await symlink(outside, join(output, '.alpha.tmp-link'));
    await pin();
    expect((await readdir(output)).sort()).toEqual(['.beta.tmp-other', 'alpha']);
    expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('keep');
  });
  it('refuses a hand-placed directory and leaves no staging directory', async () => {
    const { output, pin } = await prepare();
    await mkdir(join(output, 'alpha'));
    await writeFile(join(output, 'alpha', 'value'), 'hand-placed');
    await expect(pin()).rejects.toThrow();
    expect(await readFile(join(output, 'alpha', 'value'), 'utf8')).toBe('hand-placed');
    expect(await readdir(output)).toEqual(['alpha']);
  });
  it('refuses a linked target without modifying its destination', async () => {
    const { output, input, pin } = await prepare();
    await symlink(input, join(output, 'alpha'));
    await expect(pin()).rejects.toThrow();
    expect(await readFile(join(input, 'value'), 'utf8')).toBe('new');
  });
});
