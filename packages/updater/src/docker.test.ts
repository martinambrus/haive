import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile, type ChildProcess } from 'node:child_process';
import { redactSecrets, resolveImageSettings } from './docker.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
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
