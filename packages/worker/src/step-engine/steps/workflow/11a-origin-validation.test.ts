import { describe, expect, it, vi, beforeEach } from 'vitest';
const h = vi.hoisted(() => ({ getOriginUrl: vi.fn(), ensureOrigin: vi.fn(), pushBranch: vi.fn() }));
vi.mock('../../../repo/git-push.js', async (original) => ({
  ...(await original<typeof import('../../../repo/git-push.js')>()),
  ...h,
}));
import { gitRemoteUrlSchema } from '@haive/shared/schemas';
import { gate4PushStep } from './11a-gate-4-push.js';
import type { StepContext } from '../../step-definition.js';
const detected = {
  hasGit: true,
  workspacePath: '/workspace',
  branch: 'main',
  hasOrigin: false,
  originUrl: null,
  repositoryId: null,
  boundCredentialId: null,
  credentials: [],
  recentCommits: '',
};
const ctx = { db: {}, userId: 'u', logger: { info: vi.fn() } } as unknown as StepContext;
const apply = (d: typeof detected, values: Record<string, unknown>) =>
  gate4PushStep.apply!(ctx, {
    detected: d,
    formValues: values,
    llmOutput: null,
    iteration: 0,
    previousIterations: [],
  } as never);
beforeEach(() => {
  vi.resetAllMocks();
  h.getOriginUrl.mockResolvedValue(null);
});
describe('11a apply reads the current origin and validates a typed URL', () => {
  it.each(['/tmp/other', 'file:///tmp/other', 'ext::sh'])(
    'rejects %s before writing the remote',
    async (remoteUrl) => {
      const parsed = gitRemoteUrlSchema.safeParse(remoteUrl);
      expect(parsed.success).toBe(false);
      if (parsed.success) throw new Error('expected a refused URL');
      await expect(apply(detected, { push: true, remoteUrl })).rejects.toMatchObject({
        name: 'Error',
        message: parsed.error.issues[0]!.message,
      });
      expect(h.ensureOrigin).not.toHaveBeenCalled();
      expect(h.pushBranch).not.toHaveBeenCalled();
    },
  );
  it('uses an origin added since detect without demanding another URL', async () => {
    h.getOriginUrl.mockResolvedValue('https://example.test/r');
    await apply(detected, { push: true });
    expect(h.getOriginUrl).toHaveBeenCalledWith('/workspace');
    expect(h.ensureOrigin).not.toHaveBeenCalled();
    expect(h.pushBranch).toHaveBeenCalled();
  });
  it('requires a URL if the origin disappeared since detect', async () => {
    await expect(apply({ ...detected, hasOrigin: true }, { push: true })).rejects.toThrow(
      /URL is required/,
    );
    expect(h.pushBranch).not.toHaveBeenCalled();
  });
});
