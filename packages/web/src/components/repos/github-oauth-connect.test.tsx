import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GithubOauthConnect } from './github-oauth-connect';
import { buttons, createRenderer, fire, textOf } from '../../../test/render-tree';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../../../test/render-tree')).reactHooks,
}));
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ api }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const begun = {
  deviceCode: 'handle-1',
  userCode: 'WDJB-MJHT',
  verificationUri: 'https://github.com/login/device',
  expiresIn: 900,
  interval: 5,
};
const credential = { id: 'credential-1', label: 'GitHub OAuth (octocat)', host: 'github.com' };
const approved = { status: 'ok' as const, credential };

beforeEach(() => {
  vi.useFakeTimers();
  api.get.mockResolvedValue({ configured: true });
  api.post.mockReset();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function mount() {
  let visible = true;
  const onConnected = vi.fn();
  const onError = vi.fn();
  const view = createRenderer(() =>
    visible ? <GithubOauthConnect onConnected={onConnected} onError={onError} /> : null,
  );
  const flush = async () => {
    await vi.advanceTimersByTimeAsync(0);
    view.draw();
  };
  await flush();
  const click = async (name: string) => {
    fire.click(buttons(view.tree(), name)[0]!);
    await flush();
  };
  return {
    view,
    flush,
    click,
    onConnected,
    onError,
    unmount: () => {
      visible = false;
      view.draw();
    },
    poll: async () => {
      await vi.advanceTimersByTimeAsync(5000);
      view.draw();
    },
  };
}

describe('GitHub device sign-in attempts', () => {
  it('reports an active successful poll', async () => {
    api.post.mockResolvedValueOnce(begun).mockResolvedValueOnce(approved);
    const t = await mount();
    await t.click('sign in with github');
    await t.poll();
    expect(t.onConnected).toHaveBeenCalledExactlyOnceWith(credential);
    expect(api.post.mock.calls.map(([path]) => path)).toEqual([
      '/github-oauth/device-code',
      '/github-oauth/poll',
    ]);
    t.unmount();
  });

  it('propagates a caller callback error after a successful poll', async () => {
    api.post.mockResolvedValueOnce(begun).mockResolvedValueOnce(approved);
    const t = await mount();
    const failure = new TypeError('Caller callback failed');
    t.onConnected.mockImplementation(() => {
      throw failure;
    });
    const completion = fire.click(buttons(t.view.tree(), 'sign in with github')[0]!);
    const rejected = expect(completion).rejects.toBe(failure);
    await t.flush();
    await t.poll();
    await rejected;
    expect(t.onConnected).toHaveBeenCalledExactlyOnceWith(credential);
    expect(t.onError.mock.calls.filter(([message]) => message !== null)).toEqual([]);
    t.unmount();
  });

  it('keeps the newer code and one poll loop when starts resolve out of order', async () => {
    const first = deferred<typeof begun>();
    const second = deferred<typeof begun>();
    api.post
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValue({ status: 'pending', error: 'authorization_pending' });
    const t = await mount();
    await t.click('sign in with github');
    await t.click('sign in with github');

    second.resolve({ ...begun, deviceCode: 'handle-2', userCode: 'NEW-CODE' });
    await t.flush();
    expect(textOf(t.view.tree())).toContain('NEW-CODE');
    first.resolve(begun);
    await t.flush();
    expect(textOf(t.view.tree())).toContain('NEW-CODE');
    expect(textOf(t.view.tree())).not.toContain(begun.userCode);

    await t.poll();
    await t.poll();
    expect(api.post.mock.calls).toEqual([
      ['/github-oauth/device-code', {}],
      ['/github-oauth/device-code', {}],
      ['/github-oauth/poll', { deviceCode: 'handle-2' }],
      ['/github-oauth/poll', { deviceCode: 'handle-2' }],
    ]);
    expect(t.onConnected).not.toHaveBeenCalled();
    expect(t.onError.mock.calls.filter(([message]) => message !== null)).toEqual([]);
    t.unmount();
  });

  it('does not poll after cancellation during the interval wait', async () => {
    api.post.mockResolvedValueOnce(begun).mockResolvedValue(approved);
    const t = await mount();
    await t.click('sign in with github');
    await vi.advanceTimersByTimeAsync(1000);
    await t.click('cancel');
    await t.poll();
    expect(api.post.mock.calls).toEqual([['/github-oauth/device-code', {}]]);
    expect(t.onConnected).not.toHaveBeenCalled();
    expect(t.onError.mock.calls.filter(([message]) => message !== null)).toEqual([]);
    t.unmount();
  });

  it.each(['cancel', 'restart', 'unmount'] as const)(
    'ignores a successful poll after %s',
    async (action) => {
      const old = deferred<typeof approved>();
      const current = deferred<typeof approved>();
      api.post
        .mockResolvedValueOnce(begun)
        .mockReturnValueOnce(old.promise)
        .mockResolvedValueOnce({ ...begun, deviceCode: 'handle-2', userCode: 'NEW-CODE' })
        .mockReturnValueOnce(current.promise);
      const t = await mount();
      await t.click('sign in with github');
      await t.poll();
      expect(api.post).toHaveBeenCalledTimes(2);
      if (action === 'unmount') t.unmount();
      else {
        await t.click('cancel');
        if (action === 'restart') {
          await t.click('sign in with github');
          await t.poll();
        }
      }
      old.resolve(approved);
      await t.flush();
      expect(t.onConnected).not.toHaveBeenCalled();
      expect(t.onError.mock.calls.filter(([message]) => message !== null)).toEqual([]);
      if (action === 'restart') {
        expect(textOf(t.view.tree())).toContain('NEW-CODE');
        current.resolve(approved);
        await t.flush();
        expect(t.onConnected).toHaveBeenCalledExactlyOnceWith(credential);
      }
      t.unmount();
    },
  );

  it.each(['cancel', 'restart', 'unmount'] as const)(
    'ignores a failed poll after %s',
    async (action) => {
      const old = deferred<typeof approved>();
      api.post
        .mockResolvedValueOnce(begun)
        .mockReturnValueOnce(old.promise)
        .mockResolvedValueOnce({ ...begun, userCode: 'NEW-CODE' });
      const t = await mount();
      await t.click('sign in with github');
      await t.poll();
      if (action === 'unmount') t.unmount();
      else {
        await t.click('cancel');
        if (action === 'restart') await t.click('sign in with github');
      }
      old.reject(new Error('Old attempt refused'));
      await t.flush();
      expect(t.onConnected).not.toHaveBeenCalled();
      expect(t.onError.mock.calls.filter(([message]) => message !== null)).toEqual([]);
      if (action === 'restart') expect(textOf(t.view.tree())).toContain('NEW-CODE');
      t.unmount();
    },
  );

  it.each(['resolve', 'reject'] as const)(
    'ignores a start response after unmount (%s)',
    async (how) => {
      const start = deferred<typeof begun>();
      api.post.mockReturnValueOnce(start.promise);
      const t = await mount();
      await t.click('sign in with github');
      t.unmount();
      if (how === 'resolve') start.resolve(begun);
      else start.reject(new Error('Old start refused'));
      await t.flush();
      await t.poll();
      expect(api.post).toHaveBeenCalledTimes(1);
      expect(t.onConnected).not.toHaveBeenCalled();
      expect(t.onError.mock.calls.filter(([message]) => message !== null)).toEqual([]);
    },
  );
});
