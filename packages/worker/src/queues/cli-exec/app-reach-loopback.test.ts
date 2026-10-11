import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  loadAppBootOutput: vi.fn(),
  resolveDdevWorkspace: vi.fn(),
  containerIpOnNetwork: vi.fn(),
  appRunnerExec: vi.fn(),
  ddevPrimaryUrl: vi.fn(),
  runnerExec: vi.fn(),
}));

vi.mock('../../step-engine/steps/workflow/_task-meta.js', () => ({
  loadAppBootOutput: stubs.loadAppBootOutput,
  resolveDdevWorkspace: stubs.resolveDdevWorkspace,
}));
vi.mock('../../sandbox/runner-browser-cdp.js', () => ({
  containerIpOnNetwork: stubs.containerIpOnNetwork,
}));
vi.mock('../../sandbox/app-runner.js', () => ({
  appRunnerExec: stubs.appRunnerExec,
  appRunnerHandleForTask: () => ({}),
}));
vi.mock('../../sandbox/ddev-runner.js', () => ({
  ddevCaVolumeName: () => null,
  ddevPrimaryUrl: stubs.ddevPrimaryUrl,
  runnerExec: stubs.runnerExec,
  runnerHandleForTask: () => ({}),
}));

const { resolveAppReach } = await import('./app-reach.js');

const TASK = '0123456789abcdef';
const db = {
  query: {
    tasks: { findFirst: async () => ({ repositoryId: 'r1' }) },
    repositories: { findFirst: async () => ({ storagePath: '/repos/r1', localPath: null }) },
  },
} as never;

const saved = process.env.SANDBOX_NETWORK;
beforeEach(() => {
  process.env.SANDBOX_NETWORK = 'haive-sandbox-net';
  for (const s of Object.values(stubs)) s.mockReset();
  stubs.resolveDdevWorkspace.mockResolvedValue({ repoSubpath: '' });
  stubs.containerIpOnNetwork.mockResolvedValue('172.20.0.5');
});
afterEach(() => {
  if (saved === undefined) delete process.env.SANDBOX_NETWORK;
  else process.env.SANDBOX_NETWORK = saved;
});

const bootedApp = { booted: true, skipped: false, containerized: true, port: 3000 };

describe('loopbackForward', () => {
  it('is set to the runner name and in-container port when the app-runner probe succeeds', async () => {
    stubs.ddevPrimaryUrl.mockResolvedValue(null);
    stubs.loadAppBootOutput.mockResolvedValue(bootedApp);
    stubs.appRunnerExec.mockResolvedValue({ exitCode: 0, output: '200' });
    const reach = await resolveAppReach(db, TASK);
    expect(reach.mode).toBe('sandbox_http');
    expect(reach.loopbackForward).toEqual({
      port: 3000,
      host: reach.url?.replace(/^http:\/\//, '').replace(/:3000$/, ''),
    });
    expect(reach.loopbackForward?.host).toMatch(/^haive-.*app/);
  });

  it('is null when the app-runner probe fails', async () => {
    stubs.loadAppBootOutput.mockResolvedValue(bootedApp);
    stubs.appRunnerExec.mockResolvedValue({ exitCode: 0, output: '000' });
    const reach = await resolveAppReach(db, TASK);
    expect(reach.mode).toBe('browser_only');
    expect(reach.loopbackForward).toBeNull();
  });

  it('is null when the runner has no address on the sandbox network', async () => {
    stubs.loadAppBootOutput.mockResolvedValue(bootedApp);
    stubs.containerIpOnNetwork.mockResolvedValue(null);
    const reach = await resolveAppReach(db, TASK);
    expect(reach.mode).toBe('browser_only');
    expect(reach.loopbackForward).toBeNull();
  });

  it('is null for a reachable DDEV app, which resolves by its own hostname', async () => {
    stubs.ddevPrimaryUrl.mockResolvedValue('https://x.ddev.site');
    stubs.runnerExec.mockResolvedValue({ exitCode: 0, output: '200' });
    const reach = await resolveAppReach(db, TASK);
    expect(reach.mode).toBe('sandbox_http');
    expect(reach.url).toBe('https://x.ddev.site');
    expect(reach.loopbackForward).toBeNull();
  });

  it('is null when no app runs', async () => {
    stubs.ddevPrimaryUrl.mockResolvedValue(null);
    stubs.loadAppBootOutput.mockResolvedValue(null);
    const reach = await resolveAppReach(db, TASK);
    expect(reach.mode).toBe('none');
    expect(reach.loopbackForward).toBeNull();
  });
});
