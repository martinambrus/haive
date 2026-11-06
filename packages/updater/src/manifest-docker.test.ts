import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ exec: vi.fn(), spawn: vi.fn() }));
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: h.exec }),
  spawn: h.spawn,
}));
import { readReleaseManifestImage } from './docker.js';

const MAX = 1024 * 1024;
function header(name = 'release.json', size = 21, type = '0') {
  const block = Buffer.alloc(512);
  block.write(name);
  block.write(size.toString(8).padStart(11, '0') + '\0', 124);
  block.write(type, 156);
  block.write('ustar\0', 257);
  checksum(block);
  return block;
}
function checksum(block: Buffer) {
  block.fill(32, 148, 156);
  const sum = block.reduce((sum, byte) => sum + byte, 0);
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
}
function tar(
  body = Buffer.from('{"manifestVersion":1}'),
  block = header('release.json', body.length),
) {
  return Buffer.concat([block, body, Buffer.alloc(((512 - (body.length % 512)) % 512) + 1024)]);
}
let chunks: Iterable<Buffer>;
let cpError: Error | undefined;
let killed: boolean;
let delivered: number;
beforeEach(() => {
  vi.stubEnv('HAIVE_INSTALL_ID', 't534_test');
  chunks = [tar()];
  cpError = undefined;
  killed = false;
  delivered = 0;
  h.exec.mockReset().mockImplementation(async (_command: string, args: string[]) => ({
    stdout: args[0] === 'create' ? 'container-id\n' : '',
  }));
  h.spawn.mockReset().mockImplementation(() => {
    let stopped = false;
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => {
        killed = stopped = true;
        setImmediate(() => child.emit('close', null, 'SIGKILL'));
        return true;
      }),
    });
    const iterator = chunks[Symbol.iterator]();
    const send = () => {
      if (stopped) return;
      if (cpError) {
        child.emit('error', cpError);
        child.emit('close', -1);
        return;
      }
      const next = iterator.next();
      if (next.done) {
        child.stdout.end();
        child.emit('close', 0);
      } else {
        delivered++;
        child.stdout.write(next.value);
        setImmediate(send);
      }
    };
    setImmediate(send);
    return child;
  });
});
afterEach(() => vi.unstubAllEnvs());
it('streams a single regular manifest and removes its scratch-compatible container', async () => {
  expect(await readReleaseManifestImage('private/release:1')).toBe('{"manifestVersion":1}');
  const calls = h.exec.mock.calls.map((c) => c[1] as string[]);
  expect(calls[0]).toEqual(['pull', 'private/release:1']);
  expect(calls[1]).toEqual([
    'create',
    '--name',
    expect.stringMatching(/^t534_test-upgrade-manifest-/),
    'private/release:1',
    '/unused',
  ]);
  expect(h.spawn).toHaveBeenCalledWith(
    'docker',
    ['cp', 'container-id:/release.json', '-'],
    expect.any(Object),
  );
  expect(calls.at(-1)).toEqual(['rm', '-f', 'container-id']);
});
it.each(['create', 'cp'])('temp manifest container is removed on %s failure', async (failure) => {
  if (failure === 'cp') cpError = new Error('fixture cp failure');
  else
    h.exec.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === failure) throw new Error('fixture create failure');
      return { stdout: '' };
    });
  await expect(readReleaseManifestImage('private/release:1')).rejects.toThrow('fixture');
  expect(h.exec.mock.calls.at(-1)![1]).toEqual([
    'rm',
    '-f',
    failure === 'create' ? expect.stringMatching(/^t534_test-upgrade-manifest-/) : 'container-id',
  ]);
});
it('an unpullable manifest cannot create or use a cached image', async () => {
  h.exec.mockImplementation(async (_command: string, args: string[]) => {
    if (args[0] === 'pull') throw new Error('pull denied');
    return { stdout: 'existing-image' };
  });
  await expect(readReleaseManifestImage('private/release:1')).rejects.toThrow('pull denied');
  expect(h.exec.mock.calls.map((call) => call[1])).toEqual([['pull', 'private/release:1']]);
  expect(h.spawn).not.toHaveBeenCalled();
});
it('channel rollback inventory includes digest pins while public inventory stays unchanged', async () => {
  const { localImages } = await import('./docker.js');
  const pin = `private/api@sha256:${'a'.repeat(64)}`;
  const tagged = `private/api:1@sha256:${'a'.repeat(64)}`;
  h.exec.mockResolvedValue({
    stdout: `private/api:1\t${pin}\t${tagged}\nprivate/old:2\tprivate/old@<none>\tprivate/old:2@<none>`,
  });
  expect(await localImages(true)).toEqual(['private/api:1', pin, tagged, 'private/old:2']);
  expect(h.exec.mock.calls[0]![1]).toContain('--digests');
  expect(h.exec.mock.calls[0]![1]).toContain(
    '{{.Repository}}:{{.Tag}}\t{{.Repository}}@{{.Digest}}\t{{.Repository}}:{{.Tag}}@{{.Digest}}',
  );
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

it.each(['1', '2', '5', 'x', 'g', 'L'])('refuses non-regular tar type %s', async (type) => {
  chunks = [tar(Buffer.from('{}'), header('release.json', 2, type))];
  await expect(readReleaseManifestImage('private/release:1')).rejects.toThrow('release manifest');
  expect(h.exec.mock.calls.at(-1)![1]).toEqual(['rm', '-f', 'container-id']);
});
it.each(['../release.json', '/release.json', 'other.json', 'dir/release.json'])(
  'refuses unexpected name %s',
  async (name) => {
    chunks = [tar(Buffer.from('{}'), header(name, 2))];
    await expect(readReleaseManifestImage('private/release:1')).rejects.toThrow('release manifest');
  },
);
it.each(['prefix', 'link', 'checksum', 'size', 'truncated', 'extra', 'missing end'])(
  'refuses malformed tar: %s',
  async (fault) => {
    const block = header('release.json', 2);
    if (fault === 'prefix') block.write('dir', 345);
    if (fault === 'link') block.write('target', 157);
    if (fault === 'size') block.fill(255, 124, 136);
    checksum(block);
    if (fault === 'checksum') block[148] = 0;
    const archive = tar(Buffer.from('{}'), block);
    chunks = [
      fault === 'truncated'
        ? archive.subarray(0, 513)
        : fault === 'missing end'
          ? archive.subarray(0, 1024)
          : fault === 'extra'
            ? Buffer.concat([tar(), tar()])
            : archive,
    ];
    await expect(readReleaseManifestImage('private/release:1')).rejects.toThrow('release manifest');
  },
);
it('accepts a one MiB manifest across split header and payload chunks', async () => {
  const archive = tar(Buffer.alloc(MAX, 'a'));
  chunks = [archive.subarray(0, 100), archive.subarray(100, 513), archive.subarray(513)];
  expect((await readReleaseManifestImage('private/release:1')).length).toBe(MAX);
});
it('kills the copy as soon as the header declares more than one MiB', async () => {
  chunks = (function* () {
    yield header('release.json', MAX + 1);
    for (let i = 0; i < 100; i++) yield Buffer.alloc(MAX);
  })();
  await expect(readReleaseManifestImage('private/release:1')).rejects.toThrow('release manifest');
  expect(killed).toBe(true);
  expect(delivered).toBe(1);
});
it('bounds the tar stream even when a small declared file is followed by unbounded zeros', async () => {
  chunks = (function* () {
    yield tar();
    for (let i = 0; i < 100; i++) yield Buffer.alloc(64 * 1024);
  })();
  await expect(readReleaseManifestImage('private/release:1')).rejects.toThrow('release manifest');
  expect(killed).toBe(true);
  expect(delivered).toBeLessThan(20);
});

it.each(['private/release:1', `private/release@sha256:${'b'.repeat(64)}`])(
  'keeps the pulled release image without probing ownership: %s',
  async (ref) => {
    expect(await readReleaseManifestImage(ref)).toBe('{"manifestVersion":1}');
    const calls = h.exec.mock.calls.map((call) => call[1]);
    expect(calls[0]).toEqual(['pull', ref]);
    expect(calls.filter((args) => args[0] === 'image')).toEqual([]);
    expect(calls.at(-1)).toEqual(['rm', '-f', 'container-id']);
  },
);
it('keeps the pulled release image when the copy fails', async () => {
  cpError = new Error('fixture copy failure');
  await expect(readReleaseManifestImage('private/release:1')).rejects.toThrow(
    'fixture copy failure',
  );
  const calls = h.exec.mock.calls.map((call) => call[1]);
  expect(calls.filter((args) => args[0] === 'image')).toEqual([]);
  expect(calls.at(-1)).toEqual(['rm', '-f', 'container-id']);
});

it.each(['create', 'copy', 'parse'])(
  'preserves the first %s error when container cleanup fails',
  async (failure) => {
    const base = h.exec.getMockImplementation()!;
    h.exec.mockImplementation(async (command: string, args: string[]) => {
      if (args[0] === 'create' && failure === 'create') throw new Error('original create failure');
      if (args[0] === 'rm') throw new Error('container cleanup failed');
      return base(command, args);
    });
    if (failure === 'copy') cpError = new Error('original copy failure');
    if (failure === 'parse') chunks = [tar(Buffer.from('{}'), header('wrong.json', 2))];
    await expect(readReleaseManifestImage('private/release:1')).rejects.toThrow(
      failure === 'parse' ? 'invalid release manifest tar header' : `original ${failure} failure`,
    );
    expect(h.exec.mock.calls.at(-1)![1]).toEqual([
      'rm',
      '-f',
      failure === 'create' ? expect.stringMatching(/^t534_test-upgrade-manifest-/) : 'container-id',
    ]);
  },
);
it('surfaces the container cleanup error after a successful read', async () => {
  const base = h.exec.getMockImplementation()!;
  h.exec.mockImplementation(async (command: string, args: string[]) => {
    if (args[0] === 'rm') throw new Error('container cleanup failed');
    return base(command, args);
  });
  await expect(readReleaseManifestImage('private/release:1')).rejects.toThrow(
    'container cleanup failed',
  );
  expect(h.exec.mock.calls.at(-1)![1]).toEqual(['rm', '-f', 'container-id']);
});
