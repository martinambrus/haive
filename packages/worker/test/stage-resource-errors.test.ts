import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ error: null as Error | null, calls: [] as string[][] }));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  open: async () => {
    throw h.error;
  },
}));
vi.mock('../src/repo/git-exec.js', async (original) => ({
  ...(await original<typeof import('../src/repo/git-exec.js')>()),
  gitRun: async (_cwd: string, args: string[]) => ({
    code: args.at(-1) === 'HEAD^{commit}' ? 0 : 1,
    stdout: args.at(-1) === 'HEAD^{commit}' ? 'a'.repeat(40) : '',
    stderr: '',
  }),
  gitExec: async (args: string[]) => {
    h.calls.push(args);
    return { stdout: args[0] === 'ls-files' || args[0] === 'diff' ? 'keep.md\0' : '', stderr: '' };
  },
}));
import { stageNamed, commitRecorded } from '../src/step-engine/steps/onboarding/_stage-paths.js';
beforeEach(() => {
  h.calls = [];
});
afterEach(() => {
  h.error = null;
});

it.each(['EMFILE', 'ENFILE'])('does not silently drop an addition after %s', async (code) => {
  h.error = Object.assign(new Error('injected'), { code });
  await expect(stageNamed('/repo', ['keep.md'], [])).rejects.toBe(h.error);
  expect(h.calls).toEqual([]);
});

it.each(['EMFILE', 'ENFILE'])(
  'does not commit a recreated file as a deletion after %s',
  async (code) => {
    h.error = Object.assign(new Error('injected'), { code });
    await expect(
      commitRecorded('/repo', { add: [], remove: ['keep.md'] }, 'test', {}),
    ).rejects.toBe(h.error);
    expect(h.calls.some((args) => args[0] === 'commit-tree' || args[0] === 'update-ref')).toBe(
      false,
    );
  },
);
