import { describe, expect, it } from 'vitest';
import { planBuildBody } from './plan-build-request';

const clis = { plannerCliProviderId: 'claude', questionerCliProviderId: 'codex' };

describe('planBuildBody', () => {
  it('names both CLIs when questions are asked', () => {
    expect(planBuildBody('greenfield', { ...clis, clarify: true, description: 'Clubs' })).toEqual({
      mode: 'greenfield',
      clarify: true,
      description: 'Clubs',
      cliProviderId: 'claude',
      questionerCliProviderId: 'codex',
    });
  });

  it('leaves the questioner out when no questions are asked', () => {
    expect(planBuildBody('from_repo', { ...clis, clarify: false })).toEqual({
      mode: 'from_repo',
      clarify: false,
      cliProviderId: 'claude',
    });
  });

  it('lets the server pick when no CLI was loaded', () => {
    expect(
      planBuildBody('greenfield', {
        clarify: true,
        deferStart: true,
        plannerCliProviderId: '',
        questionerCliProviderId: '',
      }),
    ).toEqual({ mode: 'greenfield', clarify: true, deferStart: true });
  });
});
