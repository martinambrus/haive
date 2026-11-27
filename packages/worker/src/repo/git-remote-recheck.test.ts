import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';

const h = vi.hoisted(() => ({ run: vi.fn(), resolve: vi.fn() }));
vi.mock('./git-exec.js', async (original) => ({
  ...(await original<typeof import('./git-exec.js')>()),
  gitRun: h.run,
}));
vi.mock('@haive/shared/egress', async (original) => ({
  ...(await original<typeof import('@haive/shared/egress')>()),
  resolveGuardedAddress: h.resolve,
}));
import { originGitRun, pushBranch } from './git-push.js';

const PUBLIC = 'https://public.example/repo.git';
const owner = {
  db: { query: { users: { findFirst: async () => ({ role: 'user' }) } } } as unknown as Database,
  userId: 'owner',
};
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const steps: string[] = [];
let resolved: boolean;
let change: string;
let scans: number;

beforeEach(() => {
  steps.length = 0;
  resolved = false;
  change = 'none';
  scans = 0;
  h.resolve.mockReset().mockImplementation(async () => {
    steps.push('resolve');
    resolved = true;
    return ['93.184.216.34'];
  });
  h.run.mockReset().mockImplementation(async (_cwd: string, args: string[]) => {
    if (args.includes('--get-regexp')) {
      steps.push('scan');
      scans++;
      if (resolved && change === 'scan-throws') throw new Error('unreadable config');
      if (resolved && change === 'scan-refuses') return ok('http.https://public.example.proxy=x');
      return { code: 1, stdout: '', stderr: '' };
    }
    if (args.includes('get-url')) {
      const direction = args.includes('--push') ? 'push' : 'fetch';
      steps.push(`url:${direction}`);
      if (resolved) {
        if (change === 'read-throws') throw new Error('unreadable origin');
        if (change === 'unsafe') return ok('file:///private/repo');
        if (change === 'absent') return { code: 2, stdout: '', stderr: '' };
        // get-url applies insteadOf: model a rewrite added while DNS was pending.
        if (change === 'insteadOf') return ok('https://127.0.0.1/repo.git');
        if (change === 'push-url' && direction === 'push')
          return ok(`${PUBLIC}\nhttps://other.example/r`);
      }
      return ok(`${PUBLIC}\n`);
    }
    steps.push('spawn');
    return ok('network operation');
  });
});
afterEach(() => vi.clearAllMocks());

const operations = ['fetch', 'push', 'ls-remote'] as const;
async function run(operation: (typeof operations)[number]) {
  if (operation === 'push') {
    try {
      await pushBranch({ cwd: '/fake/repo', branch: 'main', setUpstream: false, ...owner });
      return ok();
    } catch (error) {
      return { code: 128, stdout: '', stderr: (error as Error).message };
    }
  }
  return originGitRun('/fake/repo', [operation, 'origin'], owner);
}

describe.each(operations)('%s pre-spawn remote recheck', (operation) => {
  it.each([
    'read-throws',
    'unsafe',
    'absent',
    'insteadOf',
    'push-url',
    'scan-throws',
    'scan-refuses',
  ])('fails closed after resolution: %s', async (kind) => {
    change = kind;
    const result = await run(operation);
    expect(result.code).toBe(128);
    expect(result.stderr).toContain('changed while Haive was checking it');
    expect(steps).not.toContain('spawn');
    expect(h.resolve).toHaveBeenCalledExactlyOnceWith('public.example');
    expect(scans).toBe(2);
  });

  it('scans after resolution, reads fetch and push URLs last, then spawns with pins', async () => {
    const result = await run(operation);
    expect(result.code).toBe(0);
    expect(steps).toEqual([
      'url:fetch',
      'url:push',
      'scan',
      'resolve',
      'scan',
      'url:fetch',
      'url:push',
      'spawn',
    ]);
    expect(h.run.mock.calls.at(-1)?.[1]).toEqual(
      expect.arrayContaining([
        'http.curloptResolve=public.example:443:93.184.216.34',
        operation,
        'origin',
      ]),
    );
    expect(h.run.mock.calls.at(-1)?.[3]).toMatchObject({ guardedRemote: {} });
  });
});
