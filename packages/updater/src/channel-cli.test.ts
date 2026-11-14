import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const h = vi.hoisted(() => ({
  sql: Object.assign(vi.fn(), { end: vi.fn(), options: { parsers: {}, serializers: {} } }),
  initialize: vi.fn(),
}));
vi.mock('postgres', () => ({ default: vi.fn(() => h.sql) }));
import postgres from 'postgres';
vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  configService: { initialize: h.initialize },
}));
vi.mock('./journal.js', () => ({
  ensureJournal: vi.fn(),
  findLiveRun: vi.fn(),
  lastDoneChannel: vi.fn(),
  recordRunError: vi.fn(),
  mergeMetadata: vi.fn(),
  recordAttempt: vi.fn(),
  startRun: vi.fn(),
  tryLock: vi.fn(),
}));
vi.mock('./run.js', async (original) => ({
  ...(await original<typeof import('./run.js')>()),
  readEnvVar: vi.fn(),
  resume: vi.fn(),
  phaseDraining: vi.fn(),
  phaseMaintenance: vi.fn(),
  phaseMigrate: vi.fn(),
  phaseVerify: vi.fn(),
  phaseCommit: vi.fn(),
}));
import { main } from './cli.js';
import * as images from './images.js';
import * as dk from './docker.js';
import * as journal from './journal.js';
import * as run from './run.js';
const pin = (host: string) => `private/haive-acme-${host}@sha256:${'a'.repeat(64)}`;
const refs = { api: pin('api'), worker: pin('worker'), web: pin('web'), builder: pin('builder') };
const settings: images.ImageSettings = {
  HAIVE_API_IMAGE: pin('api'),
  HAIVE_WORKER_IMAGE: pin('worker'),
  HAIVE_WEB_IMAGE: pin('web'),
  HAIVE_CHANNEL: 'acme',
  DOCKER_CONFIG: '/host/install/.docker',
  HAIVE_CHANNEL_REGISTRY: 'private',
  HAIVE_INSTALL_ID: '',
  HAIVE_OWN_MODULES_HOST_DIR: '',
  HAIVE_BUILDER_IMAGE: '',
  HAIVE_OWN_MODULES_REBUILD_WEB: '',
};

describe('bundle preflight', () => {
  let dir: string;
  const body = Buffer.from('services: {}\n');
  const hash = `sha256:${createHash('sha256').update(body).digest('hex')}`;
  const files = { 'docker-compose.yml': hash, 'docker-compose.run.yml': hash };
  const manifest = {
    manifestVersion: 1,
    channel: 'public',
    version: '9.9.9',
    builtAt: '2026-11-14',
    migrationHead: '0221',
    bundle: {
      files,
      known: [files],
      env: [
        { key: 'MAILPIT_UI_PASSWORD', generate: 'hex', bytes: 24 },
        { key: 'JWT_SECRET', generate: 'never' },
      ],
    },
  };
  let env: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rbr-cli-'));
    env = `JWT_SECRET=${randomBytes(24).toString('hex')}\n`;
    await writeFile(join(dir, '.env'), env);
    for (const name of Object.keys(files)) await writeFile(join(dir, name), body);
    process.argv = [
      'node',
      'updater',
      '--install-dir',
      dir,
      '--manifest',
      'https://release.test/release.json',
      '--version',
      '9.9.9',
    ];
    vi.mocked(images.readImageSettings).mockResolvedValue({ ...settings, HAIVE_CHANNEL: 'public' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(manifest))),
    );
    vi.mocked(dk.readReleaseManifestImage).mockResolvedValue({
      text: JSON.stringify(manifest),
      bundle: new Map(Object.keys(files).map((name) => [name, body])),
    });
    vi.spyOn(dk, 'validateCompose').mockResolvedValue(undefined);
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));
  it('records bundle-modified with the first file and remedy before any write or hold', async () => {
    await writeFile(join(dir, 'docker-compose.run.yml'), 'edited');
    expect(await main()).toBe(3);
    expect(journal.recordAttempt).toHaveBeenCalledWith(
      h.sql,
      expect.objectContaining({
        status: 'refused',
        metadata: { refusal: 'bundle-modified' },
        error: expect.stringContaining('docker-compose.run.yml'),
      }),
    );
    expect(vi.mocked(journal.recordAttempt).mock.calls[0]![1].error).toContain(
      '--replace-modified-bundle',
    );
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe(env);
    expect(await readdir(dir)).toHaveLength(3);
    expect(journal.startRun).not.toHaveBeenCalled();
    expect(run.phaseDraining).not.toHaveBeenCalled();
  });
  it('records env-key-missing before changing anything', async () => {
    await writeFile(join(dir, '.env'), '');
    expect(await main()).toBe(3);
    expect(journal.recordAttempt).toHaveBeenCalledWith(
      h.sql,
      expect.objectContaining({
        status: 'refused',
        metadata: { refusal: 'env-key-missing' },
        error: expect.stringContaining('JWT_SECRET'),
      }),
    );
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe('');
    expect(await readdir(dir)).toHaveLength(3);
    expect(journal.startRun).not.toHaveBeenCalled();
  });
  it('check validates but writes no env, staging, journal or hold', async () => {
    process.argv.push('--check');
    expect(await main()).toBe(0);
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe(env);
    expect(await readdir(dir)).toHaveLength(3);
    expect(journal.recordAttempt).not.toHaveBeenCalled();
    expect(journal.startRun).not.toHaveBeenCalled();
    expect(images.prepareImages).not.toHaveBeenCalled();
    expect(dk.validateCompose).not.toHaveBeenCalled();
  });
  it('bundle-absent keeps the old path, without a release-image pull or new refusal', async () => {
    const { bundle: _bundle, ...older } = manifest;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(older))),
    );
    await writeFile(join(dir, '.env'), '');
    await writeFile(join(dir, 'docker-compose.run.yml'), 'edited');
    expect(await main()).toBe(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('bundle-absent'));
    expect(dk.readReleaseManifestImage).not.toHaveBeenCalled();
    expect(dk.validateCompose).not.toHaveBeenCalled();
    expect(await readdir(dir)).toHaveLength(3);
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe('');
    expect(images.prepareImages).toHaveBeenCalledWith(
      { dir, files: ['docker-compose.yml', 'docker-compose.run.yml'] },
      join(dir, '.env'),
      '9.9.9',
      expect.any(String),
      expect.any(Object),
      undefined,
    );
  });
  it('override records intent, adds only key names and pulls/validates staged files before holding', async () => {
    await writeFile(join(dir, 'docker-compose.run.yml'), 'edited');
    process.argv.push('--replace-modified-bundle');
    expect(await main()).toBe(0);
    const staged = join(dir, '.haive-upgrade', 'pending', 'new');
    expect(images.prepareImages).toHaveBeenCalledWith(
      { dir, files: [join(staged, 'docker-compose.yml'), join(staged, 'docker-compose.run.yml')] },
      join(dir, '.env'),
      '9.9.9',
      expect.any(String),
      expect.any(Object),
      undefined,
    );
    expect(dk.validateCompose).toHaveBeenCalled();
    expect(vi.mocked(dk.validateCompose).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(journal.startRun).mock.invocationCallOrder[0]!,
    );
    expect(journal.startRun).toHaveBeenCalledWith(
      h.sql,
      expect.objectContaining({
        metadata: expect.objectContaining({
          envAdded: ['MAILPIT_UI_PASSWORD'],
          replaceModifiedBundle: true,
        }),
      }),
    );
    expect(
      await readFile(join(dir, '.haive-upgrade/new-run/previous/docker-compose.run.yml'), 'utf8'),
    ).toBe('edited');
    expect(journal.mergeMetadata).toHaveBeenCalledWith(
      h.sql,
      'new-run',
      expect.objectContaining({
        bundle: expect.objectContaining({ backupDir: '.haive-upgrade/new-run/previous' }),
      }),
    );
    expect(vi.mocked(journal.startRun).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(journal.mergeMetadata).mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(journal.mergeMetadata).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(run.phaseDraining).mock.invocationCallOrder[0]!,
    );
    expect(await readFile(join(dir, 'docker-compose.run.yml'), 'utf8')).toBe('edited');
    const value = (await readFile(join(dir, '.env'), 'utf8')).match(
      /^MAILPIT_UI_PASSWORD=(.+)$/m,
    )![1]!;
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(value);
    expect(JSON.stringify(vi.mocked(journal.startRun).mock.calls)).not.toContain(value);
  });
  it.each(['http', 'https-downgrade'])(
    'bundle refuses an insecure manifest transport even with override: %s',
    async (transport) => {
      if (transport === 'http')
        process.argv[process.argv.indexOf('--manifest') + 1] = 'http://release.test/release.json';
      else {
        const response = new Response(JSON.stringify(manifest));
        Object.defineProperty(response, 'url', { value: 'http://release.test/release.json' });
        vi.mocked(fetch).mockResolvedValue(response);
      }
      process.argv.push('--replace-modified-bundle');
      expect(await main()).toBe(3);
      expect(journal.recordAttempt).toHaveBeenCalledWith(
        h.sql,
        expect.objectContaining({
          metadata: { refusal: 'bundle-manifest-insecure' },
        }),
      );
      expect(dk.readReleaseManifestImage).not.toHaveBeenCalled();
      expect(journal.startRun).not.toHaveBeenCalled();
      expect(await readFile(join(dir, '.env'), 'utf8')).toBe(env);
    },
  );
  it('accepts an operator-controlled local bundle manifest without fetching it', async () => {
    const source = join(dir, 'release.json');
    await writeFile(source, JSON.stringify(manifest));
    process.argv[process.argv.indexOf('--manifest') + 1] = source;
    expect(await main()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(dk.readReleaseManifestImage).toHaveBeenCalled();
    expect(dk.validateCompose).toHaveBeenCalled();
    expect(journal.startRun).toHaveBeenCalled();
  });
  it('records added names after a staged validation refusal, with no generated values', async () => {
    const { UpgradeRefusal } = await import('./refusal.js');
    vi.mocked(dk.validateCompose).mockRejectedValue(
      new UpgradeRefusal('bundle-config-invalid', 'invalid staged compose'),
    );
    expect(await main()).toBe(3);
    expect(journal.recordAttempt).toHaveBeenCalledWith(
      h.sql,
      expect.objectContaining({
        metadata: { refusal: 'bundle-config-invalid', envAdded: ['MAILPIT_UI_PASSWORD'] },
      }),
    );
    expect(journal.startRun).not.toHaveBeenCalled();
    const value = (await readFile(join(dir, '.env'), 'utf8')).match(
      /^MAILPIT_UI_PASSWORD=(.+)$/m,
    )![1]!;
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(value);
    expect(JSON.stringify(vi.mocked(journal.recordAttempt).mock.calls)).not.toContain(value);
  });
});
let argv: string[];
beforeEach(() => {
  vi.mocked(postgres)
    .mockReset()
    .mockReturnValue(h.sql as never);
  argv = process.argv;
  process.argv = [
    'node',
    'updater',
    '--install-dir',
    '/host/install',
    '--channel',
    'acme',
    '--version',
    '9.9.9',
    '--manifest-image',
    'private/haive-acme-release:9.9.9',
    '--check',
  ];
  vi.stubEnv('DATABASE_URL', 'postgres://isolated');
  vi.stubEnv('REDIS_URL', 'redis://isolated');
  vi.stubEnv('DOCKER_CONFIG', '/ambient');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(images, 'readImageSettings').mockResolvedValue({ ...settings });
  vi.mocked(journal.tryLock).mockResolvedValue(true);
  vi.mocked(journal.findLiveRun).mockResolvedValue(null);
  vi.mocked(journal.lastDoneChannel).mockResolvedValue(null);
  vi.mocked(journal.startRun).mockResolvedValue('new-run');
  vi.mocked(run.phaseVerify).mockResolvedValue(true);
  vi.spyOn(images, 'prepareImages').mockResolvedValue(images.emptyOverrides());
  vi.mocked(run.readEnvVar).mockResolvedValue('1.0.0');
  h.sql.end.mockResolvedValue(undefined);
  vi.spyOn(dk, 'localImages').mockResolvedValue([
    settings.HAIVE_API_IMAGE,
    settings.HAIVE_WORKER_IMAGE,
    settings.HAIVE_WEB_IMAGE,
  ]);
  vi.spyOn(dk, 'readReleaseManifestImage').mockResolvedValue({
    text: JSON.stringify({
      manifestVersion: 1,
      channel: 'acme',
      version: '9.9.9',
      builtAt: '2026-11-05',
      migrationHead: '0221',
      images: refs,
    }),
  });
});
afterEach(() => {
  process.argv = argv;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it.each([false, true])(
  'isolates boot codecs from the journal client and closes boot on failure=%s',
  async (fail) => {
    // Real driver codecs, without a connection: Drizzle mutates these when adapting a client.
    const { default: rawPostgres } = await vi.importActual<{ default: typeof postgres }>(
      'postgres',
    );
    const journalSql = rawPostgres('postgres://isolated', { max: 1, max_lifetime: 0 });
    const bootSql = rawPostgres('postgres://isolated', { max: 1, max_lifetime: 0 });
    const jsonSerializer = journalSql.options.serializers['3802'];
    const timestampParser = journalSql.options.parsers['1184'];
    const journalEnd = vi.spyOn(journalSql, 'end');
    const bootEnd = vi.spyOn(bootSql, 'end');
    vi.mocked(postgres).mockReturnValueOnce(journalSql).mockReturnValueOnce(bootSql);
    h.initialize.mockImplementationOnce(async (_url, source) => {
      source();
      if (fail) throw new Error('boot refused');
    });
    try {
      if (fail) await expect(main()).rejects.toThrow('boot refused');
      else expect(await main()).toBe(0);
      expect(journalSql.options.serializers['3802']).toBe(jsonSerializer);
      expect(journalSql.options.parsers['1184']).toBe(timestampParser);
      expect(postgres).toHaveBeenNthCalledWith(2, 'postgres://isolated', {
        max: 1,
        max_lifetime: 0,
      });
      expect(bootEnd).toHaveBeenCalledExactlyOnceWith({ timeout: 5 });
      expect(journalEnd).toHaveBeenCalledExactlyOnceWith({ timeout: 5 });
      if (!fail) {
        expect(bootEnd.mock.invocationCallOrder[0]).toBeLessThan(
          vi.mocked(journal.ensureJournal).mock.invocationCallOrder[0]!,
        );
      }
    } finally {
      await Promise.all([journalSql.end({ timeout: 5 }), bootSql.end({ timeout: 5 })]);
    }
  },
);

it('does not open a boot pool when configuration already has a key', async () => {
  expect(await main()).toBe(0);
  expect(postgres).toHaveBeenCalledTimes(1);
  expect(h.sql.end).toHaveBeenCalledExactlyOnceWith({ timeout: 5 });
});

it('check applies install credentials before manifest IO, emits pins, and starts no run', async () => {
  vi.mocked(dk.readReleaseManifestImage).mockImplementation(async () => {
    expect(process.env.DOCKER_CONFIG).toBe('/host/install/.docker');
    return {
      text: JSON.stringify({
        manifestVersion: 1,
        channel: 'acme',
        version: '9.9.9',
        builtAt: '2026-11-05',
        migrationHead: '0221',
        images: refs,
      }),
    };
  });
  expect(await main()).toBe(0);
  expect(dk.localImages).toHaveBeenCalledWith(true);
  expect(journal.startRun).not.toHaveBeenCalled();
  const plan = vi
    .mocked(console.log)
    .mock.calls.map(([line]) => JSON.parse(String(line)))
    .find((v) => v.event === 'image-plan');
  expect(plan.overrides).toEqual({
    HAIVE_API_IMAGE: refs.api,
    HAIVE_WORKER_IMAGE: refs.worker,
    HAIVE_WEB_IMAGE: refs.web,
  });
});
it('an interrupted channel run resumes before any new manifest pull', async () => {
  // Recovery still receives valid target argv, but must not pull it.

  vi.mocked(journal.findLiveRun).mockResolvedValue({
    id: 'run',
    fromVersion: '1.0.0',
    toVersion: '9.9.9',
    startedAt: new Date(),
    phase: 'migrate',
    metadata: { migrationHead: '0221' },
  } as never);
  vi.mocked(run.resume).mockResolvedValue(undefined);
  expect(await main()).toBe(0);
  expect(run.resume).toHaveBeenCalled();
  expect(process.env.DOCKER_CONFIG).toBe('/host/install/.docker');
  expect(dk.readReleaseManifestImage).not.toHaveBeenCalled();
  expect(journal.lastDoneChannel).not.toHaveBeenCalled();
});
it('a mismatched manifest creates no upgrade run', async () => {
  process.argv[process.argv.indexOf('--version') + 1] = '8.8.8';
  await expect(main()).rejects.toThrow('version');
  expect(journal.startRun).not.toHaveBeenCalled();
  expect(run.resume).not.toHaveBeenCalled();
});

it.each([
  [['--manifest', 'release.json', '--manifest-image', 'private/release:1'], 'mutually exclusive'],
  [['--manifest-image', 'private/release:1'], 'requires --version'],
])('argv refusal returns usage and emits an error: %j', async (args, message) => {
  process.argv = ['node', 'updater', ...args];
  expect(await main()).toBe(2);
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining(message));
  expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0]![0])).event).toBe('error');
  expect(images.readImageSettings).not.toHaveBeenCalled();
  expect(dk.readReleaseManifestImage).not.toHaveBeenCalled();
});

it('channel argv without a manifest image returns usage with an emitted error', async () => {
  process.argv = [
    'node',
    'updater',
    '--install-dir',
    '/host/install',
    '--manifest',
    'release.json',
  ];
  expect(await main()).toBe(2);
  expect(console.log).toHaveBeenCalledWith(
    expect.stringContaining('channel installs require --manifest-image'),
  );
  expect(dk.readReleaseManifestImage).not.toHaveBeenCalled();
});

it('argv without a target resumes an interrupted run', async () => {
  process.argv = ['node', 'updater', '--install-dir', '/host/install'];
  vi.mocked(journal.findLiveRun).mockResolvedValue({
    id: 'run',
    fromVersion: '1.0.0',
    toVersion: '9.9.9',
    startedAt: new Date(),
    phase: 'migrate',
    metadata: { migrationHead: '0221' },
  } as never);
  vi.mocked(run.resume).mockResolvedValue(undefined);
  expect(await main()).toBe(0);
  expect(run.resume).toHaveBeenCalled();
  expect(process.env.DOCKER_CONFIG).toBe('/host/install/.docker');
});

it('argv without a target and no interrupted run returns usage', async () => {
  process.argv = ['node', 'updater', '--install-dir', '/host/install'];
  expect(await main()).toBe(2);
  expect(console.log).toHaveBeenCalledWith(
    expect.stringContaining('channel installs require --manifest-image'),
  );
  expect(journal.startRun).not.toHaveBeenCalled();
  expect(dk.readReleaseManifestImage).not.toHaveBeenCalled();
});

it.each([
  [{ HAIVE_CHANNEL_REGISTRY: 'other' }, 'release repository differs'],
  [{ HAIVE_CHANNEL: 'other' }, 'disagrees with install HAIVE_CHANNEL'],
  [{ DOCKER_CONFIG: '/host/other/.docker' }, 'must be <host install dir>/.docker'],
])('settings changed while waiting for the lock are enforced: %j', async (change, message) => {
  vi.mocked(journal.tryLock).mockImplementation(async () => {
    vi.mocked(images.readImageSettings).mockResolvedValue({ ...settings, ...change });
    return true;
  });
  await expect(main()).rejects.toThrow(message);
  expect(dk.readReleaseManifestImage).not.toHaveBeenCalled();
  expect(journal.startRun).not.toHaveBeenCalled();
});

it('rollback pins use the settings refreshed after taking the lock', async () => {
  const fresh = {
    ...settings,
    HAIVE_API_IMAGE: pin('current-api'),
    HAIVE_WORKER_IMAGE: pin('current-worker'),
    HAIVE_WEB_IMAGE: pin('current-web'),
  };
  vi.mocked(journal.tryLock).mockImplementation(async () => {
    vi.mocked(images.readImageSettings).mockResolvedValue(fresh);
    return true;
  });
  vi.mocked(dk.localImages).mockResolvedValue([
    fresh.HAIVE_API_IMAGE,
    fresh.HAIVE_WORKER_IMAGE,
    fresh.HAIVE_WEB_IMAGE,
  ]);
  expect(await main()).toBe(0);
  expect(images.readImageSettings).toHaveBeenCalledTimes(1);
});

it.each([0, 1, 2, 3, 4, 5, 6])(
  'channel pin mask %i refuses before inventory without naming public refs',
  async (mask) => {
    vi.mocked(images.readImageSettings).mockResolvedValue({
      ...settings,
      HAIVE_API_IMAGE: mask & 1 ? settings.HAIVE_API_IMAGE : '',
      HAIVE_WORKER_IMAGE: mask & 2 ? settings.HAIVE_WORKER_IMAGE : '',
      HAIVE_WEB_IMAGE: mask & 4 ? settings.HAIVE_WEB_IMAGE : '',
    });
    expect(await main()).toBe(3);
    const output = vi.mocked(console.log).mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(output).toContainEqual(
      expect.objectContaining({
        event: 'refused',
        message: 'channel install has no pinned current images',
      }),
    );
    expect(JSON.stringify(output)).not.toContain('ghcr.io/martinambrus/haive-');
    expect(dk.localImages).not.toHaveBeenCalled();
  },
);
it.each([0, 1, 2, 3, 4, 5, 6, 7])(
  'public rollback pin mask %i selects the required inventory',
  async (mask) => {
    process.argv = [
      'node',
      'updater',
      '--install-dir',
      '/host/install',
      '--manifest-image',
      'public/release:9.9.9',
      '--version',
      '9.9.9',
      '--check',
    ];
    vi.mocked(images.readImageSettings).mockResolvedValue({
      ...settings,
      HAIVE_API_IMAGE: mask & 1 ? settings.HAIVE_API_IMAGE : '',
      HAIVE_WORKER_IMAGE: mask & 2 ? settings.HAIVE_WORKER_IMAGE : '',
      HAIVE_WEB_IMAGE: mask & 4 ? settings.HAIVE_WEB_IMAGE : '',
      HAIVE_CHANNEL: 'public',
    });
    vi.mocked(dk.readReleaseManifestImage).mockResolvedValue({
      text: JSON.stringify({
        manifestVersion: 1,
        channel: 'public',
        version: '9.9.9',
        builtAt: '2026-11-05',
        migrationHead: '0221',
      }),
    });
    vi.mocked(dk.localImages).mockImplementation(async (digests) => [
      ...['api', 'worker', 'web'].map((host) => `ghcr.io/martinambrus/haive-${host}:1.0.0`),
      ...(digests
        ? [settings.HAIVE_API_IMAGE, settings.HAIVE_WORKER_IMAGE, settings.HAIVE_WEB_IMAGE]
        : []),
    ]);
    expect(await main()).toBe(0);
    expect(dk.localImages).toHaveBeenCalledWith(mask !== 0);
  },
);

describe('journal channel pin', () => {
  function publicInstall(installed = '') {
    process.argv = [
      'node',
      'updater',
      '--install-dir',
      '/host/install',
      '--manifest',
      'https://example.invalid/release.json',
    ];
    vi.mocked(images.readImageSettings).mockResolvedValue({
      ...settings,
      HAIVE_CHANNEL: installed,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        text: async () =>
          JSON.stringify({
            manifestVersion: 1,
            channel: 'public',
            version: '9.9.9',
            builtAt: '2026-11-05',
            migrationHead: '0221',
          }),
      }),
    );
  }

  function noTargetIO() {
    expect(dk.readReleaseManifestImage).not.toHaveBeenCalled();
    expect(images.prepareImages).not.toHaveBeenCalled();
    expect(dk.localImages).not.toHaveBeenCalled();
    expect(journal.startRun).not.toHaveBeenCalled();
    expect(run.phaseDraining).not.toHaveBeenCalled();
    if (vi.isMockFunction(globalThis.fetch)) expect(fetch).not.toHaveBeenCalled();
  }

  function expectChannelRefusal(recorded: string, current: string) {
    const output = vi.mocked(console.log).mock.calls.map(([line]) => JSON.parse(String(line)));
    const refused = output.find((v) => v.event === 'refused');
    expect(refused).toMatchObject({ refusal: 'channel-changed' });
    expect(refused.message).toContain(recorded);
    expect(refused.message).toContain(current);
    expect(refused.message).toContain(`--change-channel ${recorded}`);
    noTargetIO();
  }

  it.each(['', 'public'])(
    'recorded acme refuses resolved public from .env %j',
    async (installed) => {
      publicInstall(installed);
      vi.mocked(journal.lastDoneChannel).mockResolvedValue('acme');
      expect(await main()).toBe(3);
      expectChannelRefusal('acme', 'public');
      expect(journal.lastDoneChannel).toHaveBeenCalledWith(h.sql);
      expect(vi.mocked(journal.tryLock).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(journal.lastDoneChannel).mock.invocationCallOrder[0]!,
      );
      expect(images.readImageSettings).toHaveBeenCalledTimes(1);
    },
  );

  it('recorded public refuses resolved acme even with --check', async () => {
    vi.mocked(journal.lastDoneChannel).mockResolvedValue('public');
    expect(await main()).toBe(3);
    expectChannelRefusal('public', 'acme');
  });

  it('channel refusal precedes a missing target', async () => {
    publicInstall();
    process.argv = process.argv.slice(0, 4);
    vi.mocked(journal.lastDoneChannel).mockResolvedValue('acme');
    expect(await main()).toBe(3);
    expectChannelRefusal('acme', 'public');
  });

  it('the exact recorded channel acknowledges a move and starts the new channel', async () => {
    publicInstall();
    process.argv.push('--change-channel', 'acme');
    vi.mocked(journal.lastDoneChannel).mockResolvedValue('acme');
    expect(await main()).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(journal.lastDoneChannel).toHaveBeenCalledWith(h.sql);
    expect(journal.startRun).toHaveBeenCalledWith(
      h.sql,
      expect.objectContaining({ channel: 'public' }),
    );
    expect(run.phaseCommit).toHaveBeenCalled();
  });

  it('acknowledging public allows a move to acme', async () => {
    process.argv = process.argv.filter((v) => v !== '--check');
    process.argv.push('--change-channel', 'public');
    vi.mocked(journal.lastDoneChannel).mockResolvedValue('public');
    expect(await main()).toBe(0);
    expect(journal.lastDoneChannel).toHaveBeenCalledWith(h.sql);
    expect(journal.startRun).toHaveBeenCalledWith(
      h.sql,
      expect.objectContaining({ channel: 'acme' }),
    );
  });

  it('an acknowledgement that disagrees with the record is refused', async () => {
    publicInstall();
    process.argv.push('--change-channel', 'other');
    vi.mocked(journal.lastDoneChannel).mockResolvedValue('acme');
    expect(await main()).toBe(3);
    expectChannelRefusal('acme', 'public');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('journal records'));
  });

  it.each([null, 'public'])(
    'an acknowledgement with record %j is a usage error',
    async (recorded) => {
      publicInstall();
      process.argv.push('--change-channel', recorded ?? 'acme');
      vi.mocked(journal.lastDoneChannel).mockResolvedValue(recorded);
      expect(await main()).toBe(2);
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('--change-channel'));
      noTargetIO();
    },
  );

  it.each([undefined, '', 'Acme', 'bad_name', '-acme', 'acme-', 'a'.repeat(33)])(
    'invalid acknowledgement %j is a usage error',
    async (value) => {
      publicInstall();
      process.argv.push('--change-channel', ...(value === undefined ? [] : [value]));
      vi.mocked(journal.lastDoneChannel).mockResolvedValue('acme');
      expect(await main()).toBe(2);
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('--change-channel'));
      noTargetIO();
    },
  );

  it.each(['a', 'a'.repeat(32), 'acme-2'])(
    'accepts valid recorded channel %j',
    async (recorded) => {
      publicInstall();
      process.argv.push('--change-channel', recorded);
      vi.mocked(journal.lastDoneChannel).mockResolvedValue(recorded);
      expect(await main()).toBe(0);
      expect(journal.lastDoneChannel).toHaveBeenCalledWith(h.sql);
      expect(journal.startRun).toHaveBeenCalled();
    },
  );

  it.each(['no runs', 'only rolled_back', 'only failed'])(
    '%s leaves the channel unpinned',
    async () => {
      // The journal query filters to done rows; all three histories return null.
      vi.mocked(journal.lastDoneChannel).mockResolvedValue(null);
      expect(await main()).toBe(0);
      expect(journal.lastDoneChannel).toHaveBeenCalledWith(h.sql);
      expect(dk.readReleaseManifestImage).toHaveBeenCalled();
    },
  );

  it('an unchanged recorded channel proceeds without acknowledgement', async () => {
    vi.mocked(journal.lastDoneChannel).mockResolvedValue('acme');
    expect(await main()).toBe(0);
    expect(journal.lastDoneChannel).toHaveBeenCalledWith(h.sql);
    expect(dk.readReleaseManifestImage).toHaveBeenCalled();
  });

  it('a live run resumes without consulting the pin or acknowledgement', async () => {
    publicInstall();
    process.argv.push('--change-channel', 'other');
    vi.mocked(journal.lastDoneChannel).mockResolvedValue('acme');
    vi.mocked(journal.findLiveRun).mockResolvedValue({
      id: 'live-run',
      fromVersion: '1.0.0',
      toVersion: '9.9.9',
      channel: 'acme',
      status: 'running',
      error: null,
      startedAt: new Date(),
      phase: 'migrate',
      metadata: { migrationHead: '0221' },
    });
    expect(await main()).toBe(0);
    expect(run.resume).toHaveBeenCalled();
    expect(journal.lastDoneChannel).not.toHaveBeenCalled();
    noTargetIO();
  });

  it('dry-plan reads no journal even when a different channel was recorded', async () => {
    process.argv = process.argv.filter((v) => v !== '--check');
    process.argv.push('--dry-plan');
    vi.mocked(journal.lastDoneChannel).mockResolvedValue('public');
    expect(await main()).toBe(0);
    expect(journal.ensureJournal).not.toHaveBeenCalled();
    expect(journal.lastDoneChannel).not.toHaveBeenCalled();
    expect(dk.readReleaseManifestImage).toHaveBeenCalled();
  });
});

it('public dry-plan emits a usage error without reading a target or journal', async () => {
  process.argv = ['node', 'updater', '--install-dir', '/host/install', '--dry-plan'];
  vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('REDIS_URL', '');
  vi.mocked(images.readImageSettings).mockResolvedValue({
    ...settings,
    HAIVE_CHANNEL: 'public',
  });
  expect(await main()).toBe(2);
  expect(vi.mocked(console.log).mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
    expect.objectContaining({ event: 'error', message: '--dry-plan requires a channel install' }),
  ]);
  expect(journal.ensureJournal).not.toHaveBeenCalled();
  expect(h.initialize).not.toHaveBeenCalled();
  expect(dk.readReleaseManifestImage).not.toHaveBeenCalled();
  expect(dk.localImages).not.toHaveBeenCalled();
});

describe('terminal attempts before a run exists', () => {
  beforeEach(() => {
    process.argv = process.argv.filter((v) => v !== '--check');
    vi.mocked(journal.recordAttempt).mockResolvedValue(undefined);
  });
  const attempts = () => vi.mocked(journal.recordAttempt);
  const expectAttempt = (status: string, refusal?: string) => {
    expect(attempts()).toHaveBeenCalledTimes(1);
    const event = vi
      .mocked(console.log)
      .mock.calls.map(([line]) => JSON.parse(String(line)))
      .find((e) => e.event === (status === 'refused' ? 'refused' : 'error'));
    expect(attempts()).toHaveBeenCalledWith(h.sql, {
      status,
      fromVersion: '1.0.0',
      toVersion: '9.9.9',
      channel: 'acme',
      error: event.message,
      metadata: refusal ? { refusal } : {},
    });
  };
  it.each([
    'dev-build',
    'same-version',
    'downgrade',
    'illegal-jump',
    'rollback-images-missing',
    'insufficient-disk',
  ])('records exactly one %s preflight refusal', async (refusal) => {
    if (refusal === 'dev-build') vi.mocked(run.readEnvVar).mockResolvedValue('0.0.0-dev');
    if (refusal === 'same-version') vi.mocked(run.readEnvVar).mockResolvedValue('9.9.9');
    if (refusal === 'downgrade') vi.mocked(run.readEnvVar).mockResolvedValue('10.0.0');
    if (refusal === 'illegal-jump')
      vi.mocked(dk.readReleaseManifestImage).mockResolvedValue({
        text: JSON.stringify({
          manifestVersion: 1,
          channel: 'acme',
          version: '9.9.9',
          builtAt: '2026-11-05',
          migrationHead: '0221',
          minFrom: '5.0.0',
          images: refs,
        }),
      });
    if (refusal === 'rollback-images-missing') vi.mocked(dk.localImages).mockResolvedValue([]);
    if (refusal === 'insufficient-disk')
      process.argv.push('--free-bytes', '1', '--snapshot-bytes', '2');
    expect(await main()).toBe(3);
    expect(attempts()).toHaveBeenCalledTimes(1);
    expect(attempts()).toHaveBeenCalledWith(
      h.sql,
      expect.objectContaining({
        status: 'refused',
        toVersion: '9.9.9',
        channel: 'acme',
        metadata: { refusal },
        fromVersion:
          refusal === 'dev-build'
            ? '0.0.0-dev'
            : refusal === 'same-version'
              ? '9.9.9'
              : refusal === 'downgrade'
                ? '10.0.0'
                : '1.0.0',
      }),
    );
    const event = vi
      .mocked(console.log)
      .mock.calls.map(([line]) => JSON.parse(String(line)))
      .find((e) => e.event === 'refused');
    expect(attempts().mock.calls[0]![1].error).toBe(event.message);
  });
  it('records the channel change and its CLI remedy', async () => {
    vi.mocked(journal.lastDoneChannel).mockResolvedValue('public');
    expect(await main()).toBe(3);
    expectAttempt('refused', 'channel-changed');
    expect(attempts().mock.calls[0]![1].error).toContain('--change-channel public');
  });
  it('records missing channel rollback pins', async () => {
    vi.mocked(images.readImageSettings).mockResolvedValue({ ...settings, HAIVE_API_IMAGE: '' });
    expect(await main()).toBe(3);
    expectAttempt('refused', 'rollback-images-missing');
  });
  it('records a thrown manifest read failure', async () => {
    vi.mocked(dk.readReleaseManifestImage).mockRejectedValue(new Error('manifest pull failed'));
    await expect(main()).rejects.toThrow('manifest pull failed');
    expect(attempts()).toHaveBeenCalledTimes(1);
    expect(attempts()).toHaveBeenCalledWith(h.sql, {
      status: 'failed',
      fromVersion: '1.0.0',
      toVersion: '9.9.9',
      channel: 'acme',
      error: 'manifest pull failed',
      metadata: {},
    });
  });
  it('records usage after the journal is ensured', async () => {
    process.argv.push('--change-channel', 'BAD');
    expect(await main()).toBe(2);
    expectAttempt('failed');
  });
  it('records channel validation failures after acquiring the lock', async () => {
    process.argv[process.argv.indexOf('--channel') + 1] = 'other';
    await expect(main()).rejects.toThrow('disagrees');
    expect(attempts()).toHaveBeenCalledWith(
      h.sql,
      expect.objectContaining({ status: 'failed', channel: 'acme' }),
    );
  });
  it('uses unknown when the installed version is absent', async () => {
    vi.mocked(run.readEnvVar).mockResolvedValue(null);
    vi.mocked(journal.lastDoneChannel).mockResolvedValue('public');
    expect(await main()).toBe(3);
    expect(attempts()).toHaveBeenCalledWith(
      h.sql,
      expect.objectContaining({ fromVersion: 'unknown' }),
    );
  });
  it.each(['busy', 'check', 'dry-plan', 'completed', 'resumed'])(
    'writes no attempt for %s',
    async (mode) => {
      if (mode === 'busy') vi.mocked(journal.tryLock).mockResolvedValue(false);
      if (mode === 'check') {
        process.argv.push('--check');
        vi.mocked(journal.lastDoneChannel).mockResolvedValue('public');
      }
      if (mode === 'dry-plan') process.argv.push('--dry-plan');
      if (mode === 'resumed')
        vi.mocked(journal.findLiveRun).mockResolvedValue({
          id: 'live',
          fromVersion: '1.0.0',
          toVersion: '9.9.9',
          startedAt: new Date(),
          phase: 'migrate',
          metadata: { migrationHead: '0221' },
        } as never);
      await main();
      expect(attempts()).not.toHaveBeenCalled();
    },
  );
  it('keeps a refusal exit when recording fails, and emits the write error', async () => {
    vi.mocked(journal.lastDoneChannel).mockResolvedValue('public');
    attempts().mockRejectedValue(new Error('journal write failed'));
    expect(await main()).toBe(3);
    expect(attempts()).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('attempt-record-failed'));
  });
});

describe('existing runs do not gain terminal attempt rows', () => {
  beforeEach(() => {
    process.argv = process.argv.filter((v) => v !== '--check');
  });
  it('does not create a second row when commit throws', async () => {
    vi.mocked(run.phaseCommit).mockRejectedValueOnce(new Error('commit failed'));
    expect(await main()).toBe(1);
    expect(journal.startRun).toHaveBeenCalledTimes(1);
    expect(journal.recordAttempt).not.toHaveBeenCalled();
  });
  it('does not create a row when recovery throws', async () => {
    vi.mocked(journal.findLiveRun).mockResolvedValueOnce({
      id: 'live',
      fromVersion: '1.0.0',
      toVersion: '9.9.9',
      startedAt: new Date(),
      phase: 'commit',
      metadata: { migrationHead: '0221' },
    } as never);
    vi.mocked(run.resume).mockRejectedValueOnce(new Error('recovery failed'));
    await expect(main()).rejects.toThrow('recovery failed');
    expect(journal.recordAttempt).not.toHaveBeenCalled();
  });
  it('keeps a thrown error when writing its attempt fails', async () => {
    vi.mocked(dk.readReleaseManifestImage).mockRejectedValueOnce(
      new Error('original manifest error'),
    );
    vi.mocked(journal.recordAttempt).mockRejectedValueOnce(new Error('write failed'));
    await expect(main()).rejects.toThrow('original manifest error');
    expect(journal.recordAttempt).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('attempt-record-failed'));
  });
  it('uses unknown when a usage error has no requested target', async () => {
    process.argv = ['node', 'updater', '--install-dir', '/host/install'];
    expect(await main()).toBe(2);
    expect(journal.recordAttempt).toHaveBeenCalledWith(
      h.sql,
      expect.objectContaining({ toVersion: 'unknown', status: 'failed' }),
    );
  });
});

it('sanitizes bound query diagnostics before recording an attempt', async () => {
  process.argv = process.argv.filter((v) => v !== '--check');
  vi.mocked(dk.readReleaseManifestImage).mockRejectedValueOnce(
    Object.assign(new Error('secret value'), {
      params: ['secret value'],
      query: 'SELECT $1',
    }),
  );
  await expect(main()).rejects.toThrow('secret value');
  expect(journal.recordAttempt).toHaveBeenCalledWith(
    h.sql,
    expect.objectContaining({ error: 'Database operation failed' }),
  );
});
it('scrubs filesystem paths before recording an attempt', async () => {
  process.argv = process.argv.filter((v) => v !== '--check');
  vi.mocked(dk.readReleaseManifestImage).mockRejectedValueOnce(
    new Error('cannot read /private/install/release.json'),
  );
  await expect(main()).rejects.toThrow('cannot read');
  expect(journal.recordAttempt).toHaveBeenCalledWith(
    h.sql,
    expect.objectContaining({ error: 'cannot read [path]' }),
  );
});

it('never records the raw invalid install channel', async () => {
  process.argv = process.argv.filter((v) => v !== '--check');
  vi.mocked(images.readImageSettings).mockResolvedValue({
    ...settings,
    HAIVE_CHANNEL: 'INVALID/channel',
  });
  await expect(main()).rejects.toThrow('invalid install channel');
  expect(journal.recordAttempt).toHaveBeenCalledWith(
    h.sql,
    expect.objectContaining({ channel: 'public' }),
  );
});

it('validates the requested version before an early manifest failure is recorded', async () => {
  process.argv = process.argv.filter((v) => v !== '--check');
  process.argv[process.argv.indexOf('--version') + 1] = 'bad/version';
  vi.mocked(dk.readReleaseManifestImage).mockRejectedValueOnce(new Error('manifest unavailable'));
  await expect(main()).rejects.toThrow('manifest unavailable');
  expect(journal.recordAttempt).toHaveBeenCalledWith(
    h.sql,
    expect.objectContaining({ toVersion: 'unknown' }),
  );
});
