import { describe, it, expect } from 'vitest';
import { validateFormValues } from '@haive/shared';
import type { StepContext } from '../../step-definition.js';
import { gate4PushStep } from './11a-gate-4-push.js';

/** A repo with a worktree and commits but NO origin remote — the exact state that
 *  failed task 153a3437: `repositories.remote_url` null, so form() takes the
 *  "no origin is configured" branch. */
const noOriginDetect = {
  hasGit: true,
  workspacePath: '/haive/workdir',
  branch: 'feature/x',
  hasOrigin: false,
  originUrl: null,
  recentCommits: 'abc1234 feat: something',
  repositoryId: 'repo-1',
  boundCredentialId: null,
  credentials: [],
};

function buildForm(detected: typeof noOriginDetect) {
  // form() is sync and only reads `detected` on this branch.
  return gate4PushStep.form!({} as unknown as StepContext, detected, undefined);
}

describe('11a-gate-4-push — declining the push on a repo with no origin', () => {
  it('gates remoteUrl behind the push checkbox', () => {
    const schema = buildForm(noOriginDetect);
    const remoteUrl = schema.fields.find((f) => f.id === 'remoteUrl');
    expect(remoteUrl).toBeDefined();
    expect(remoteUrl!.visibleWhen).toEqual({ field: 'push', equals: true });
  });

  it('accepts a submission that declines the push', () => {
    // The regression: apply() handles `push: false` ("push skipped"), but the form
    // marked remoteUrl required with no gate, so validation rejected it and the step
    // — and the whole task — went to `failed`.
    const schema = buildForm(noOriginDetect);
    const res = validateFormValues(schema, { push: false });
    expect(res.success).toBe(true);
  });

  it('still demands a remote once the user opts in to pushing', () => {
    const schema = buildForm(noOriginDetect);
    const res = validateFormValues(schema, { push: true });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.issues).toContain('remoteUrl: required');
  });

  it('puts the push checkbox before the fields it reveals', () => {
    const ids = buildForm(noOriginDetect).fields.map((f) => f.id);
    expect(ids.indexOf('push')).toBeLessThan(ids.indexOf('remoteUrl'));
  });

  it('apply() reports a skip rather than pushing when the box is unticked', async () => {
    const out = await gate4PushStep.apply!(
      {} as unknown as StepContext,
      {
        detected: noOriginDetect,
        formValues: { push: false },
        llmOutput: null,
        iteration: 0,
        previousIterations: [],
      } as never,
    );
    expect(out).toMatchObject({ pushed: false, message: 'push skipped' });
  });
});
