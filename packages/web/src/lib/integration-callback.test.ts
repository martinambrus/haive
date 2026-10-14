import { describe, expect, it, vi } from 'vitest';
import { finishCallback } from './integration-callback';

const PATH = '/settings/integrations/callback/github';
const connected = { connection: { accountLabel: 'octocat' } };

const run = (
  search: string,
  complete: Parameters<typeof finishCallback>[0]['complete'],
  steps: string[] = [],
) =>
  finishCallback({
    search,
    providerId: 'github',
    pathname: PATH,
    replaceUrl: (pathname) => steps.push(`replace ${pathname}`),
    complete: (body) => {
      steps.push('complete');
      return complete(body);
    },
  });

describe('finishCallback', () => {
  it('takes the query out of the address before it asks the api, and asks exactly once', async () => {
    const steps: string[] = [];
    const complete = vi.fn(async () => connected);

    const outcome = await run('?state=s1&code=c1', complete, steps);

    expect(steps).toEqual([`replace ${PATH}`, 'complete']);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith({ providerId: 'github', state: 's1', code: 'c1' });
    expect(outcome).toEqual({ kind: 'connected', accountLabel: 'octocat' });
  });

  it('shows the refusal, with the address already clean, and does not ask again', async () => {
    const steps: string[] = [];
    const complete = vi.fn(async () => {
      throw new Error('This sign-in link is invalid, expired or already used.');
    });

    const outcome = await run('?state=x&code=y', complete, steps);

    expect(outcome).toEqual({
      kind: 'refused',
      message: 'This sign-in link is invalid, expired or already used.',
    });
    expect(steps).toEqual([`replace ${PATH}`, 'complete']);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('says something even when the failure carries no message', async () => {
    const outcome = await run('?state=s1&code=c1', async () => {
      throw new Error('');
    });
    expect(outcome).toEqual({ kind: 'refused', message: 'The connection could not be completed.' });
  });

  it('passes a refusal from the provider on as its error code', async () => {
    const complete = vi.fn(async () => connected);

    await run('?state=s1&error=access_denied&error_description=No', complete);

    expect(complete).toHaveBeenCalledWith({
      providerId: 'github',
      state: 's1',
      error: 'access_denied',
    });
  });

  it('asks nothing of the api when the visit carries no state, but still cleans the address', async () => {
    const steps: string[] = [];
    const complete = vi.fn(async () => connected);

    expect(await run('', complete, steps)).toEqual({ kind: 'nothing' });
    expect(await run('?code=c1', complete, steps)).toEqual({ kind: 'nothing' });

    expect(complete).not.toHaveBeenCalled();
    expect(steps).toEqual([`replace ${PATH}`, `replace ${PATH}`]);
  });
});
