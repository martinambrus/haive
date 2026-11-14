import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ exec: vi.fn(), spawn: vi.fn() }));
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: h.exec }),
  spawn: h.spawn,
}));
import { readReleaseManifestImage, streamSingleFile, MANIFEST_MAX } from './docker.js';
import { loadManifest } from './cli.js';
import { createHash, randomBytes } from 'node:crypto';

const MAX = 8;
const manifestText = JSON.stringify({
  manifestVersion: 1,
  version: '1.2.0',
  builtAt: '2026-11-14',
  migrationHead: '0221',
});
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
function tar(body = Buffer.from(manifestText), block = header('release.json', body.length)) {
  return Buffer.concat([block, body, Buffer.alloc(((512 - (body.length % 512)) % 512) + 1024)]);
}
let chunks: Iterable<Buffer>;
let cpError: Error | undefined;
let killed: boolean;
let delivered: number;
let archives: Buffer[][] | undefined;
beforeEach(() => {
  vi.stubEnv('HAIVE_INSTALL_ID', 't534_test');
  chunks = [tar()];
  cpError = undefined;
  killed = false;
  delivered = 0;
  archives = undefined;
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
    const iterator = (archives?.shift() ?? chunks)[Symbol.iterator]();
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

const bundleBody = Buffer.from('services: {}\n');
const bundleHash = `sha256:${createHash('sha256').update(bundleBody).digest('hex')}`;
const bundledManifest = {
  manifestVersion: 1,
  version: '1.2.0',
  builtAt: '2026-11-14',
  migrationHead: '0221',
  bundle: {
    files: { 'docker-compose.yml': bundleHash, 'docker-compose.run.yml': bundleHash },
    env: [],
    known: [],
  },
};
it.each(['wrong-name', 'symlink', 'oversize', 'hash-mismatch', 'missing'])(
  'refuses invalid bundle file: %s',
  async (fault) => {
    const { readReleaseManifestImage } = await import('./docker.js');
    const body = fault === 'hash-mismatch' ? Buffer.from('different') : bundleBody;
    const block = header(
      fault === 'wrong-name' ? '../docker-compose.yml' : 'docker-compose.yml',
      fault === 'oversize' ? 9 : body.length,
      fault === 'symlink' ? '2' : '0',
    );
    archives = [
      [tar(Buffer.from(JSON.stringify(bundledManifest)))],
      [fault === 'missing' ? Buffer.alloc(1024) : tar(body, block)],
    ];
    await expect(
      readReleaseManifestImage('private/release:1', undefined, {
        maxBundleBytes: fault === 'oversize' ? 8 : undefined,
      }),
    ).rejects.toThrow();
    expect(h.exec.mock.calls.at(-1)![1]).toEqual(['rm', '-f', 'container-id']);
  },
);

it('reads each bundle file separately from one manifest container and pins the production cap', async () => {
  const { BUNDLE_FILE_MAX } = await import('./docker.js');
  expect(BUNDLE_FILE_MAX).toBe(256 * 1024);
  archives = [
    [tar(Buffer.from(JSON.stringify(bundledManifest)))],
    [tar(bundleBody, header('docker-compose.yml', bundleBody.length))],
    [tar(bundleBody, header('docker-compose.run.yml', bundleBody.length))],
  ];
  const result = await readReleaseManifestImage('private/release:1');
  expect(result.bundle?.get('docker-compose.yml')).toEqual(bundleBody);
  expect(h.exec.mock.calls.filter((call) => call[1][0] === 'create')).toHaveLength(1);
  expect(h.spawn.mock.calls.map((call) => call[1])).toEqual([
    ['cp', 'container-id:/release.json', '-'],
    ['cp', 'container-id:/bundle/docker-compose.yml', '-'],
    ['cp', 'container-id:/bundle/docker-compose.run.yml', '-'],
  ]);
});

it.each([undefined, 'mirror.test/haive-release:1.2.0'])(
  'uses public URL hashes as the trust anchor, release image override=%s',
  async (releaseImage) => {
    const urlManifest = { ...bundledManifest, channel: 'public' };
    const imageManifest = {
      ...bundledManifest,
      bundle: {
        ...bundledManifest.bundle,
        files: {
          'docker-compose.yml': `sha256:${'0'.repeat(64)}`,
          'docker-compose.run.yml': `sha256:${'0'.repeat(64)}`,
        },
      },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(urlManifest)));
    archives = [
      [tar(Buffer.from(JSON.stringify(imageManifest)))],
      [tar(bundleBody, header('docker-compose.yml', bundleBody.length))],
      [tar(bundleBody, header('docker-compose.run.yml', bundleBody.length))],
    ];
    const onBundle = vi.fn();
    const target = await loadManifest({
      manifest: 'https://release.test/release.json',
      channel: 'public',
      registry: 'registry.test',
      releaseImage,
      onBundle,
    });
    expect(target.bundle?.files).toEqual(urlManifest.bundle.files);
    expect(onBundle).toHaveBeenCalledWith(
      new Map(Object.keys(urlManifest.bundle.files).map((name) => [name, bundleBody])),
    );
    expect(h.exec.mock.calls[0]![1]).toEqual([
      'pull',
      releaseImage ?? 'registry.test/haive-release:1.2.0',
    ]);
    expect(h.exec.mock.calls.filter((call) => call[1][0] === 'create')).toHaveLength(1);
  },
);

it.each(['pullImages', 'composeUp', 'composeStop'] as const)(
  'preserves Compose failure diagnostics from %s',
  async (operation) => {
    const dk = await import('./docker.js');
    const failure = Object.assign(new Error('Docker Compose process failed'), {
      code: 1,
      signal: 'SIGTERM',
      killed: true,
      stderr: 'dependency failed to start',
    });
    h.exec.mockRejectedValue(failure);
    await expect(
      dk[operation]({ dir: '/install', files: ['docker-compose.yml'] }, {}, []),
    ).rejects.toBe(failure);
  },
);

it('discards config -q output and errors', async () => {
  const { validateCompose } = await import('./docker.js');
  const value = randomBytes(24).toString('hex');
  const ctx = {
    dir: '/install',
    files: ['/install/.haive-upgrade/pending/new/docker-compose.yml'],
  };
  h.exec.mockResolvedValue({ stdout: value, stderr: value });
  expect(await validateCompose(ctx, {})).toBeUndefined();
  h.exec.mockRejectedValue(new Error(`Compose stderr: ${value}`));
  const failure = await validateCompose(ctx, {}).catch((error: unknown) => error);
  expect(failure).toMatchObject({ refusal: 'bundle-config-invalid' });
  expect(JSON.stringify(failure)).not.toContain(value);
  expect((failure as Error).message).not.toContain(value);
  expect(h.exec.mock.calls[0]![1]).toContain('--project-directory');
  expect(h.exec.mock.calls[0]![1]).toEqual([
    'compose',
    '-f',
    ctx.files[0],
    '--project-directory',
    '/install',
    'config',
    '-q',
  ]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
it('streams a single regular manifest and removes its scratch-compatible container', async () => {
  expect(await readReleaseManifestImage('private/release:1')).toEqual({ text: manifestText });
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
it('accepts a the injected cap manifest across split header and payload chunks', async () => {
  const archive = tar(Buffer.alloc(MAX, 'a'));
  chunks = [archive.subarray(0, 100), archive.subarray(100, 513), archive.subarray(513)];
  expect(MANIFEST_MAX).toBe(1024 * 1024);
  expect(
    (await streamSingleFile('container-id', '/release.json', 'release.json', MAX)).length,
  ).toBe(MAX);
});
it('kills the copy as soon as the header declares more than the injected cap', async () => {
  chunks = (function* () {
    yield header('release.json', MAX + 1);
    for (let i = 0; i < 100; i++) yield Buffer.alloc(MAX);
  })();
  await expect(
    streamSingleFile('container-id', '/release.json', 'release.json', MAX),
  ).rejects.toThrow('release manifest');
  expect(killed).toBe(true);
  expect(delivered).toBe(1);
});
it('bounds the tar stream even when a small declared file is followed by unbounded zeros', async () => {
  chunks = (function* () {
    yield tar(Buffer.from('{}'));
    for (let i = 0; i < 100; i++) yield Buffer.alloc(512);
  })();
  await expect(
    streamSingleFile('container-id', '/release.json', 'release.json', MAX),
  ).rejects.toThrow('release manifest');
  expect(killed).toBe(true);
  expect(delivered).toBe(2);
});

it.each(['private/release:1', `private/release@sha256:${'b'.repeat(64)}`])(
  'keeps the pulled release image without probing ownership: %s',
  async (ref) => {
    expect(await readReleaseManifestImage(ref)).toEqual({ text: manifestText });
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

it.each(['create', 'copy', 'parse'])(
  'warns once through the CLI when %s and container cleanup both fail',
  async (failure) => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const base = h.exec.getMockImplementation()!;
    h.exec.mockImplementation(async (command: string, args: string[]) => {
      if (args[0] === 'create' && failure === 'create') throw new Error('original create failure');
      if (args[0] === 'rm') throw new Error('container cleanup failed');
      return base(command, args);
    });
    if (failure === 'copy') cpError = new Error('original copy failure');
    if (failure === 'parse') chunks = [tar(Buffer.from('{}'), header('wrong.json', 2))];
    await expect(
      loadManifest({ manifestImage: 'private/release:1', channel: 'public', version: '1' }),
    ).rejects.toThrow(
      failure === 'parse' ? 'invalid release manifest tar header' : `original ${failure} failure`,
    );
    const container = h.exec.mock.calls.at(-1)![1][2] as string;
    expect(logs).toHaveBeenCalledTimes(1);
    const event = JSON.parse(logs.mock.calls[0]![0] as string);
    expect(event).toMatchObject({ event: 'warning', container });
    expect(event.message).toContain(container);
    expect(event.message).toContain('container cleanup failed');
  },
);
