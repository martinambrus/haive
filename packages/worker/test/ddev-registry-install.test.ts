import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: h.exec }) };
});

beforeEach(() => {
  vi.resetModules();
  h.exec.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
});
afterEach(() => vi.unstubAllEnvs());

it.each(['haive', 'tib_second'])('labels the registry cache for install %s', async (install) => {
  vi.stubEnv('HAIVE_INSTALL_ID', install);
  const { ensureDdevRegistryCache } = await import('../src/sandbox/ddev-runner.js');

  await ensureDdevRegistryCache();

  const args = h.exec.mock.calls
    .map(([, args]) => args as string[])
    .find((args) => args[0] === 'run')!;
  expect(args).toBeDefined();
  const labels = args.flatMap((arg, i) => (arg === '--label' ? [args[i + 1]] : []));
  expect(labels).toContain(`haive.install=${install}`);
  expect(labels).toContain('haive.role=ddev-registry-cache');
  expect(args[args.indexOf('--name') + 1]).toBe(`${install}-ddev-registry`);
});
