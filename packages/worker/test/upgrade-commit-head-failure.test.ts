import { beforeEach, expect, it, vi } from 'vitest';
import { gitRun } from '../src/repo/git-exec.js';
import {
  agentsRulesVerdict,
  headLacksImport,
} from '../src/step-engine/steps/onboarding-upgrade/03-upgrade-commit.js';

vi.mock('../src/repo/git-exec.js', async (original) => ({
  ...(await original<typeof import('../src/repo/git-exec.js')>()),
  gitRun: vi.fn(),
}));
vi.mock('../src/step-engine/steps/onboarding/_rules-files.js', async (original) => ({
  ...(await original<typeof import('../src/step-engine/steps/onboarding/_rules-files.js')>()),
  readAgentsRulesRegion: async () => ({ region: 'existing rules' }),
}));

beforeEach(() => vi.resetAllMocks());

it.each([2, 128, 124, -1])('does not stage rules after HEAD exits %s', async (code) => {
  vi.mocked(gitRun).mockResolvedValue({ code, stdout: '', stderr: 'arbitrary diagnostic' });
  expect.soft(await headLacksImport('/repo', 'CLAUDE.md')).toBe(false);
  expect(await agentsRulesVerdict('/repo')).toEqual({
    verdict: 'unknown',
    reason: expect.any(String),
  });
});

/** Quiet HEAD exits 1 for an unborn branch AND over a broken branch ref; only the
 *  enumeration in `provesUnbornHead` tells them apart. */
function headExitsOne(forEachRef: { code: number; stdout: string; stderr: string }) {
  vi.mocked(gitRun).mockImplementation(async (_cwd: string, args: string[]) => {
    if (args[0] === 'symbolic-ref') return { code: 0, stdout: 'refs/heads/main\n', stderr: '' };
    if (args[0] === 'for-each-ref') return forEachRef;
    return { code: 1, stdout: '', stderr: '' };
  });
}

it('stages rules after HEAD is proven unborn', async () => {
  headExitsOne({ code: 0, stdout: '', stderr: '' });
  expect(await headLacksImport('/repo', 'CLAUDE.md')).toBe(true);
  expect(await agentsRulesVerdict('/repo')).toEqual({ verdict: 'stage' });
});

it('does not stage rules when HEAD exits 1 over a broken branch ref', async () => {
  headExitsOne({ code: 0, stdout: '', stderr: 'warning: ignoring broken ref refs/heads/main\n' });
  expect.soft(await headLacksImport('/repo', 'CLAUDE.md')).toBe(false);
  expect(await agentsRulesVerdict('/repo')).toEqual({
    verdict: 'unknown',
    reason: expect.any(String),
  });
});
