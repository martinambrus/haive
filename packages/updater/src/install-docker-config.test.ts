import { afterEach, expect, it, vi } from 'vitest';
import { applyInstallDockerConfig } from './cli.js';

afterEach(() => vi.unstubAllEnvs());
it('channel Docker clients use install credential only, replacing ambient config', () => {
  vi.stubEnv('DOCKER_CONFIG', '/ambient');
  applyInstallDockerConfig(
    { HAIVE_CHANNEL: 'acme', DOCKER_CONFIG: '/host/install/.docker' },
    '/host/install',
  );
  expect(process.env.DOCKER_CONFIG).toBe('/host/install/.docker');
});
it('containerized updater translates host credential path to mounted /install/.docker', () => {
  vi.stubEnv('DOCKER_CONFIG', '/install/.docker');
  applyInstallDockerConfig(
    { HAIVE_CHANNEL: 'acme', DOCKER_CONFIG: '/host/install/.docker' },
    '/install',
  );
  expect(process.env.DOCKER_CONFIG).toBe('/install/.docker');
});
it('channel refuses missing or relative install config instead of using ambient credential', () => {
  vi.stubEnv('DOCKER_CONFIG', '/ambient');
  for (const config of ['', 'relative'])
    expect(() =>
      applyInstallDockerConfig({ HAIVE_CHANNEL: 'acme', DOCKER_CONFIG: config }, '/install'),
    ).toThrow('DOCKER_CONFIG');
});
it.each(['', 'public'])('public Docker client environment is unchanged: %s', (channel) => {
  vi.stubEnv('DOCKER_CONFIG', '/ambient');
  applyInstallDockerConfig(
    { HAIVE_CHANNEL: channel, DOCKER_CONFIG: '/host/install/.docker' },
    '/install',
  );
  expect(process.env.DOCKER_CONFIG).toBe('/ambient');
});
