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

it('stages rules after HEAD positively answers unborn with exit 1', async () => {
  vi.mocked(gitRun).mockResolvedValue({ code: 1, stdout: '', stderr: '' });
  expect(await headLacksImport('/repo', 'CLAUDE.md')).toBe(true);
  expect(await agentsRulesVerdict('/repo')).toEqual({ verdict: 'stage' });
});
