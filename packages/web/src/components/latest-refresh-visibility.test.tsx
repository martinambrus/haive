// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LatestRefresh } from './latest-refresh';

const h = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ api: h }));

const show = async (hidden: boolean) => {
  await act(async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(hidden);
    document.dispatchEvent(new Event('visibilitychange'));
  });
};
const mount = async () => {
  const view = render(<LatestRefresh endpoint="/latest" active={false} result={null} />);
  await act(async () => {});
  return view;
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  h.get.mockReset().mockResolvedValue({ run: null });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('pauses a scheduled poll while hidden and reads immediately when shown', async () => {
  await mount();
  expect(h.get).toHaveBeenCalledOnce();
  await show(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(h.get).toHaveBeenCalledOnce();
  await show(false);
  expect(h.get).toHaveBeenCalledTimes(2);
  await show(false);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(h.get).toHaveBeenCalledTimes(3);
});

it('does not read on a hidden mount and removes the visibility listener on unmount', async () => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  const view = await mount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(h.get).not.toHaveBeenCalled();
  await show(false);
  expect(h.get).toHaveBeenCalledOnce();
  view.unmount();
  expect((h.get.mock.calls[0]![1] as AbortSignal).aborted).toBe(true);
  await show(true);
  await show(false);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(h.get).toHaveBeenCalledOnce();
});

it('does not overlap a slow read when visibility changes', async () => {
  let release!: (response: { run: null }) => void;
  h.get.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await mount();
  await show(true);
  await show(false);
  expect(h.get).toHaveBeenCalledOnce();
  await act(async () => {
    release({ run: null });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(h.get).toHaveBeenCalledTimes(2);
});

it('does not schedule another read when an in-flight response arrives while hidden', async () => {
  let release!: (response: { run: null }) => void;
  h.get.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await mount();
  await show(true);
  await act(async () => {
    release({ run: null });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(h.get).toHaveBeenCalledOnce();
  await show(false);
  expect(h.get).toHaveBeenCalledTimes(2);
});
