import { afterEach, expect, it, vi } from 'vitest';
import { applyInstallDockerConfig } from './cli.js';

afterEach(() => vi.unstubAllEnvs());
it('channel Docker clients use install credential only, replacing ambient config', () => {
  vi.stubEnv('DOCKER_CONFIG', '/ambient');
  applyInstallDockerConfig(
    { HAIVE_CHANNEL: 'acme', DOCKER_CONFIG: '/host/install/.docker' },
    '/host/install',
    process.env.DOCKER_CONFIG,
  );
  expect(process.env.DOCKER_CONFIG).toBe('/host/install/.docker');
});
it('containerized updater translates host credential path to mounted /install/.docker', () => {
  vi.stubEnv('DOCKER_CONFIG', '/install/.docker');
  vi.stubEnv('HAIVE_INSTALL_DIR_HOST', '/host/install');
  applyInstallDockerConfig(
    { HAIVE_CHANNEL: 'acme', DOCKER_CONFIG: '/host/install/.docker' },
    '/install',
    process.env.DOCKER_CONFIG,
  );
  expect(process.env.DOCKER_CONFIG).toBe('/install/.docker');
});
it('a second call keeps the host-run semantics of an updater whose install dir is /install', () => {
  vi.stubEnv('DOCKER_CONFIG', '/ambient');
  vi.stubEnv('HAIVE_INSTALL_DIR_HOST', '/elsewhere');
  const launch = process.env.DOCKER_CONFIG;
  const local = { HAIVE_CHANNEL: 'acme', DOCKER_CONFIG: '/install/.docker' };
  applyInstallDockerConfig(local, '/install', launch);
  expect(() => applyInstallDockerConfig(local, '/install', launch)).not.toThrow();
  expect(process.env.DOCKER_CONFIG).toBe('/install/.docker');
});
it('a second call keeps host-run semantics when DOCKER_CONFIG was unset at launch', () => {
  vi.stubEnv('DOCKER_CONFIG', undefined);
  vi.stubEnv('HAIVE_INSTALL_DIR_HOST', undefined);
  const launch = process.env.DOCKER_CONFIG;
  const local = { HAIVE_CHANNEL: 'acme', DOCKER_CONFIG: '/install/.docker' };
  applyInstallDockerConfig(local, '/install', launch);
  expect(() => applyInstallDockerConfig(local, '/install', launch)).not.toThrow();
  expect(process.env.DOCKER_CONFIG).toBe('/install/.docker');
});
it('channel refuses missing or relative install config instead of using ambient credential', () => {
  vi.stubEnv('DOCKER_CONFIG', '/ambient');
  for (const config of ['', 'relative'])
    expect(() =>
      applyInstallDockerConfig(
        { HAIVE_CHANNEL: 'acme', DOCKER_CONFIG: config },
        '/install',
        process.env.DOCKER_CONFIG,
      ),
    ).toThrow('DOCKER_CONFIG');
});
it.each(['', 'public'])('public Docker client environment is unchanged: %s', (channel) => {
  vi.stubEnv('DOCKER_CONFIG', '/ambient');
  applyInstallDockerConfig(
    { HAIVE_CHANNEL: channel, DOCKER_CONFIG: '/host/install/.docker' },
    '/install',
    process.env.DOCKER_CONFIG,
  );
  expect(process.env.DOCKER_CONFIG).toBe('/ambient');
});

it.each(['/other/.docker', '/host/install/credentials', '/host/install/.docker/'])(
  'host updater refuses a config outside the exact install credential directory: %s',
  (config) => {
    vi.stubEnv('DOCKER_CONFIG', '/ambient');
    expect(() =>
      applyInstallDockerConfig(
        { HAIVE_CHANNEL: 'acme', DOCKER_CONFIG: config },
        '/host/install',
        process.env.DOCKER_CONFIG,
      ),
    ).toThrow('DOCKER_CONFIG must be');
    expect(process.env.DOCKER_CONFIG).toBe('/ambient');
  },
);
it('mounted updater validates the host path before translating it', () => {
  vi.stubEnv('DOCKER_CONFIG', '/install/.docker');
  vi.stubEnv('HAIVE_INSTALL_DIR_HOST', '/host/install');
  expect(() =>
    applyInstallDockerConfig(
      { HAIVE_CHANNEL: 'acme', DOCKER_CONFIG: '/other/.docker' },
      '/install',
      process.env.DOCKER_CONFIG,
    ),
  ).toThrow('DOCKER_CONFIG must be');
  expect(process.env.DOCKER_CONFIG).toBe('/install/.docker');
});
it('mounted updater refuses when its host install path is unknown', () => {
  vi.stubEnv('DOCKER_CONFIG', '/install/.docker');
  vi.stubEnv('HAIVE_INSTALL_DIR_HOST', '');
  expect(() =>
    applyInstallDockerConfig(
      { HAIVE_CHANNEL: 'acme', DOCKER_CONFIG: '/host/install/.docker' },
      '/install',
      process.env.DOCKER_CONFIG,
    ),
  ).toThrow('HAIVE_INSTALL_DIR_HOST');
});
