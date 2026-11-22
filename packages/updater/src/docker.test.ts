import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile, type ChildProcess } from 'node:child_process';
import {
  buildOwnModules,
  composeUp,
  redactSecrets,
  resolveImageSettings,
  requireNoRunningOneShots,
  restoreVolume,
  runOneShot,
  snapshotVolume,
  withOneShotOwner,
} from './docker.js';
import { UpgradeRefusal } from './refusal.js';

const builderExec = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: builderExec }),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe('one-shot ownership after an updater dies', () => {
  const install = 'haive.install';
  const attempt = 'org.haive.updater.attempt';
  const role = 'org.haive.updater.role';
  const labels = (argv: string[]): Record<string, string> =>
    Object.fromEntries(
      argv.flatMap((arg, i) => {
        if (arg !== '--label') return [];
        const [key, ...value] = argv[i + 1]!.split('=');
        return [[key, value.join('=')]];
      }),
    );

  it.each([
    () => snapshotVolume('pg', '/snapshots', 'pg.tgz'),
    () => restoreVolume('pg', '/snapshots', 'pg.tgz'),
    () => runOneShot('target', ['migrate'], {}),
    () => buildOwnModules('builder', '/modules', {}),
  ])('refuses to launch a one-shot without an ownership scope', async (launch) => {
    builderExec.mockResolvedValue({ stdout: '' });
    await expect(launch()).rejects.toThrow('one-shot ownership scope is missing');
    expect(builderExec.mock.calls.some((call) => call[1][0] === 'run')).toBe(false);
  });

  it('labels snapshots, restores, migrations and builders with one attempt, renewed on recovery', async () => {
    builderExec.mockResolvedValue({ stdout: '' });
    await withOneShotOwner('team_install', async () => {
      await snapshotVolume('pg', '/snapshots', 'pg.tgz');
      await restoreVolume('pg', '/snapshots', 'pg.tgz');
      await runOneShot('target', ['migrate'], {}, 'team_install');
      await buildOwnModules('builder', '/modules', {});
    });
    await withOneShotOwner('team_install', () => runOneShot('target', ['commit'], {}));
    const runs = builderExec.mock.calls
      .map((call) => call[1] as string[])
      .filter((argv) => argv[0] === 'run');
    const owners = runs.map(labels);
    expect(owners.map((owner) => owner[role])).toEqual([
      'snapshot',
      'restore',
      'migration',
      'builder',
      'migration',
    ]);
    expect(owners.every((owner) => owner[install] === 'team_install')).toBe(true);
    expect(owners[0]![attempt]).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(owners.slice(0, 4).map((owner) => owner[attempt])).size).toBe(1);
    expect(owners[4]![attempt]).not.toBe(owners[0]![attempt]);
  });

  it('checks only active labelled children of this install, with bounded Docker I/O', async () => {
    builderExec.mockResolvedValue({ stdout: '' });
    await withOneShotOwner('team_install', requireNoRunningOneShots);
    expect(builderExec).toHaveBeenCalledWith(
      'docker',
      [
        'ps',
        '--filter',
        `label=${install}=team_install`,
        '--filter',
        `label=${attempt}`,
        '--filter',
        `label=${role}`,
        '--format',
        `{{.ID}}\t{{.Label "${attempt}"}}\t{{.Label "${role}"}}`,
      ],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
  });

  it('ignores its own attempt, but refuses a child of an earlier attempt by class and code', async () => {
    builderExec.mockResolvedValue({ stdout: '' });
    await withOneShotOwner('team_install', async () => {
      await snapshotVolume('pg', '/snapshots', 'pg.tgz');
      const own = labels(builderExec.mock.calls[0]![1])[attempt];
      builderExec.mockResolvedValue({ stdout: `abc123\t${own}\tsnapshot\n` });
      await expect(requireNoRunningOneShots()).resolves.toBeUndefined();
      builderExec.mockResolvedValue({
        stdout: `abc123\t${own}\tsnapshot\ndef456\tearlier-attempt\tmigration\n`,
      });
      await expect(requireNoRunningOneShots()).rejects.toMatchObject({
        refusal: 'updater-child-running',
      });
      await expect(requireNoRunningOneShots()).rejects.toBeInstanceOf(UpgradeRefusal);
    });
  });

  it('names every blocking container and role, including an empty attempt value', async () => {
    builderExec.mockResolvedValue({ stdout: 'abc123\tprior\tsnapshot\ndef456\t\tmigration\n' });
    await expect(withOneShotOwner('team_install', requireNoRunningOneShots)).rejects.toThrow(
      /abc123.*snapshot.*def456.*migration/,
    );
    builderExec.mockResolvedValue({ stdout: 'def456\t\tmigration\n' });
    await expect(withOneShotOwner('team_install', requireNoRunningOneShots)).rejects.toMatchObject({
      refusal: 'updater-child-running',
    });
  });

  it.each([
    [Object.assign(new Error('secret stderr'), { code: 'ENOENT' }), 'ENOENT'],
    [new TypeError('secret stderr'), 'TypeError'],
  ])('records a safe Docker failure code or class', async (error, diagnostic) => {
    builderExec.mockRejectedValue(error);
    await expect(withOneShotOwner('team_install', requireNoRunningOneShots)).rejects.toThrow(
      diagnostic,
    );
    await expect(withOneShotOwner('team_install', requireNoRunningOneShots)).rejects.not.toThrow(
      'secret stderr',
    );
  });

  it.each([{ killed: true, signal: 'SIGKILL' }, { code: 'ABORT_ERR' }])(
    'removes only this attempt and role before propagating a cancellation (%j)',
    async (fields) => {
      vi.useFakeTimers();
      const failure = Object.assign(new Error('client stopped -e DATABASE_URL=secret'), fields);
      builderExec
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce({ stdout: 'abc123\ndef456\n' });
      let release: () => void = () => {};
      builderExec.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ stdout: '' });
          }),
      );
      await withOneShotOwner('team_install', async () => {
        let propagated = false;
        const result = runOneShot('target', ['migrate'], { DATABASE_URL: 'secret' }).catch(
          (error: unknown) => {
            propagated = true;
            return error;
          },
        );
        await vi.waitFor(() => expect(builderExec).toHaveBeenCalledTimes(3));
        expect(propagated).toBe(false);
        const runArgs = builderExec.mock.calls[0]![1] as string[];
        const owner = labels(runArgs)[attempt];
        expect(builderExec.mock.calls[1]![1]).toEqual([
          'ps',
          '-aq',
          '--filter',
          'label=haive.install=team_install',
          '--filter',
          `label=${attempt}=${owner}`,
          '--filter',
          `label=${role}=migration`,
        ]);
        expect(builderExec.mock.calls[2]![1]).toEqual(['rm', '-f', 'abc123', 'def456']);
        for (const call of builderExec.mock.calls)
          expect(call[2]).toMatchObject({ killSignal: 'SIGKILL' });
        release();
        const error = await result;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('<redacted>');
        expect((error as Error).message).not.toContain('secret');
      });
    },
  );

  it('does not remove containers for an ordinary nonzero exit', async () => {
    builderExec.mockRejectedValue(Object.assign(new Error('exit 1'), { code: 1 }));
    await expect(
      withOneShotOwner('team_install', () => runOneShot('target', [], {})),
    ).rejects.toThrow('exit 1');
    expect(builderExec).toHaveBeenCalledTimes(1);
  });

  it('refuses cleanup failure with a safe diagnostic', async () => {
    builderExec.mockRejectedValueOnce(Object.assign(new Error('timeout'), { killed: true }));
    builderExec.mockResolvedValueOnce({ stdout: 'abc123\n' });
    builderExec.mockRejectedValueOnce(
      Object.assign(new Error('secret stderr'), { code: 'EACCES' }),
    );
    await expect(
      withOneShotOwner('team_install', () => runOneShot('target', [], {})),
    ).rejects.toMatchObject({
      refusal: 'updater-child-cleanup-failed',
      message: expect.stringContaining('EACCES'),
    });
  });

  it('refuses a Docker read failure without exposing its diagnostics', async () => {
    builderExec.mockRejectedValue(new Error('secret-docker-diagnostic'));
    await expect(withOneShotOwner('team_install', requireNoRunningOneShots)).rejects.toMatchObject({
      refusal: 'updater-child-check-failed',
    });
    await expect(withOneShotOwner('team_install', requireNoRunningOneShots)).rejects.not.toThrow(
      'secret-docker-diagnostic',
    );
  });
});

it('removes orphan services only when rollback requests it', async () => {
  builderExec.mockResolvedValue({ stdout: '' });
  const ctx = { dir: '/install', files: ['docker-compose.yml', 'docker-compose.run.yml'] };
  await composeUp(ctx, {});
  await composeUp(ctx, {}, [], { removeOrphans: true });
  const commands = builderExec.mock.calls.map((call) => call[1]);
  expect(commands).toEqual([
    ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.run.yml', 'up', '-d'],
    [
      'compose',
      '-f',
      'docker-compose.yml',
      '-f',
      'docker-compose.run.yml',
      'up',
      '-d',
      '--remove-orphans',
    ],
  ]);
});

describe('redactSecrets', () => {
  // MEASURED: the first real upgrade printed the Postgres password into the log when the commit
  // phase failed, because Node puts the whole command line into a failed exec's message and
  // one-shot containers take their credentials as `-e` arguments.
  it('redacts a database URL passed as a docker -e argument', () => {
    const line =
      'Command failed: docker run --rm -e DATABASE_URL=postgres://haive:hunter2@postgres:5432/haive img';
    const out = redactSecrets(line);
    expect(out).not.toContain('hunter2');
    expect(out).toContain('-e DATABASE_URL=<redacted>');
  });

  it('redacts every credential-shaped variable, not just the first', () => {
    const line =
      '-e DATABASE_URL=postgres://u:p@h/db -e CONFIG_ENCRYPTION_KEY=abc -e JWT_SECRET=xyz';
    const out = redactSecrets(line);
    for (const secret of ['postgres://u:p@h/db', 'abc', 'xyz']) expect(out).not.toContain(secret);
  });

  it('leaves ordinary arguments alone', () => {
    const line = 'docker compose -f docker-compose.yml up -d --remove-orphans';
    expect(redactSecrets(line)).toBe(line);
  });
});

it('resolves only the selected settings with bounded Compose transport, current-file precedence and one dollar decoding', async () => {
  vi.stubEnv('HAIVE_VERSION', '2.0.0');
  vi.stubEnv('HAIVE_REGISTRY', 'ambient-registry');
  vi.stubEnv('HAIVE_INSTALL_ID', 'ambient');
  vi.stubEnv('DOCKER_HOST', 'unix:///synthetic.sock');
  const stdin = { on: vi.fn(), end: vi.fn() };
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string) => void;
    queueMicrotask(() =>
      callback(
        null,
        JSON.stringify({
          services: {
            settings: {
              environment: {
                HAIVE_INSTALL_ID: 'team_a',
                HAIVE_OWN_MODULES_HOST_DIR: '/literal/$${VAR}/$$$$',
              },
            },
          },
        }),
      ),
    );
    return { stdin } as unknown as ChildProcess;
  });
  expect(
    await resolveImageSettings('/install/.env', ['HAIVE_INSTALL_ID', 'HAIVE_OWN_MODULES_HOST_DIR']),
  ).toEqual({ HAIVE_INSTALL_ID: 'team_a', HAIVE_OWN_MODULES_HOST_DIR: '/literal/${VAR}/$$' });
  const [command, argv, options] = vi.mocked(execFile).mock.calls[0]!;
  expect(command).toBe('docker');
  expect(argv).toEqual([
    'compose',
    '--project-name',
    'updater-settings',
    '--project-directory',
    '/install',
    '--env-file',
    '/install/.env',
    '-f',
    '-',
    'config',
    '--format',
    'json',
  ]);
  expect(options).toEqual(
    expect.objectContaining({
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: expect.objectContaining({ DOCKER_HOST: 'unix:///synthetic.sock' }),
    }),
  );
  const passedEnv = (options as { env: NodeJS.ProcessEnv }).env;
  for (const key of [
    'HAIVE_VERSION',
    'HAIVE_REGISTRY',
    'HAIVE_INSTALL_ID',
    'HAIVE_OWN_MODULES_HOST_DIR',
  ])
    expect(passedEnv[key]).toBeUndefined();
  expect(process.env.HAIVE_VERSION).toBe('2.0.0');
  expect(JSON.parse(stdin.end.mock.calls[0]![0]).services.settings.environment).toEqual({
    HAIVE_INSTALL_ID: '${HAIVE_INSTALL_ID-}',
    HAIVE_OWN_MODULES_HOST_DIR: '${HAIVE_OWN_MODULES_HOST_DIR-}',
  });
});

it('does not expose secret-bearing Compose errors', async () => {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string) => void;
    queueMicrotask(() => callback(new Error('secret-from-dotenv-stderr'), ''));
    return { stdin: { on: vi.fn(), end: vi.fn() } } as unknown as ChildProcess;
  });
  await expect(resolveImageSettings('/install/.env', ['HAIVE_INSTALL_ID'])).rejects.toThrow(
    /^could not resolve install image settings with Docker Compose; check .env syntax and Compose availability$/,
  );
});

it('keeps Docker transport --config explicit while clearing new install interpolation keys', async () => {
  const values = {
    HAIVE_CHANNEL: 'acme',
    HAIVE_CHANNEL_REGISTRY: 'private/customer',
    DOCKER_CONFIG: '/install/.docker',
  };
  for (const key of Object.keys(values)) vi.stubEnv(key, 'ambient-' + key);
  vi.stubEnv('DOCKER_CONFIG', '/ambient-credentials');
  const stdin = { on: vi.fn(), end: vi.fn() };
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string) => void;
    queueMicrotask(() =>
      callback(null, JSON.stringify({ services: { settings: { environment: values } } })),
    );
    return { stdin } as unknown as ChildProcess;
  });
  expect(await resolveImageSettings('/install/.env', Object.keys(values))).toEqual(values);
  const [, argv, options] = vi.mocked(execFile).mock.calls[0]!;
  expect(argv?.slice(0, 3)).toEqual(['--config', '/ambient-credentials', 'compose']);
  const env = (options as { env: NodeJS.ProcessEnv }).env;
  for (const key of Object.keys(values)) expect(env).not.toHaveProperty(key);
  expect(process.env.DOCKER_CONFIG).toBe('/ambient-credentials');
});

it('pins the credential-mounted own-module builder to its mounted Docker socket before the image', async () => {
  builderExec.mockResolvedValue({ stdout: '' });
  const image = 'registry.test/haive-builder:9.9.9';
  const plan = { version: '9.9.9' };
  await withOneShotOwner('team_install', () =>
    buildOwnModules(image, '/host/modules', plan, '/host/install/.docker'),
  );
  expect(builderExec.mock.calls[0]?.slice(0, 2)).toEqual(['docker', ['pull', image]]);
  const [command, argv] = builderExec.mock.calls[1]!;
  expect(command).toBe('docker');
  expect(argv).toEqual([
    'run',
    '--rm',
    '--label',
    'haive.install=team_install',
    '--label',
    expect.stringMatching(/^org\.haive\.updater\.attempt=[0-9a-f-]{36}$/),
    '--label',
    'org.haive.updater.role=builder',
    '--mount',
    'type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock',
    '--mount',
    'type=bind,src=/host/modules,dst=/input,readonly',
    '-e',
    `HAIVE_BUILD_PLAN=${JSON.stringify(plan)}`,
    '--mount',
    'type=bind,src=/host/install/.docker,dst=/run/haive-docker-config,readonly',
    '-e',
    'DOCKER_CONFIG=/run/haive-docker-config',
    '-e',
    'BUILDX_CONFIG=/tmp/buildx',
    '-e',
    'DOCKER_HOST=unix:///var/run/docker.sock',
    image,
  ]);
});
