// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CheckoutSessionBoundary } from './checkout-session-boundary';
const h = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ api: h }));
vi.mock('@/components/markdown/markdown-view', () => ({
  MarkdownView: ({ body }: { body: string }) => <div>{body}</div>,
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('unmounts an old Editor/runtime and requires explicit reopen after a fast replacement', async () => {
  vi.useFakeTimers();
  let state = { status: 'ready', epoch: null as string | null };
  h.get.mockImplementation(async () => state);
  render(
    <CheckoutSessionBoundary path="/repos/repo">
      <iframe title="session" />
    </CheckoutSessionBoundary>,
  );
  await act(async () => {});
  expect(screen.getByTitle('session')).toBeTruthy();
  state = { status: 'ready', epoch: 'replacement' }; // cloning and ready between polls
  await act(() => vi.advanceTimersByTimeAsync(2500));
  expect(screen.queryByTitle('session')).toBeNull();
  expect(screen.getByText(/unsaved buffers were kept/)).toBeTruthy();
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(screen.queryByTitle('session')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Reopen session' }));
  expect(screen.getByTitle('session')).toBeTruthy();
  await act(() => vi.advanceTimersByTimeAsync(2500));
  expect(screen.getByTitle('session')).toBeTruthy();
});

it('holds opening during cloning and offers reopen only when structurally ready', async () => {
  vi.useFakeTimers();
  h.get.mockResolvedValue({ status: 'cloning', epoch: 'replacement' });
  render(
    <CheckoutSessionBoundary path="/tasks/task">
      <iframe title="session" />
    </CheckoutSessionBoundary>,
  );
  await act(async () => {});
  expect(screen.queryByTitle('session')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Reopen session' })).toBeNull();
  h.get.mockResolvedValue({ status: 'ready', epoch: 'replacement' });
  await act(() => vi.advanceTimersByTimeAsync(2500));
  expect(screen.queryByTitle('session')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Reopen session' }));
  expect(screen.getByTitle('session')).toBeTruthy();
});

it('reports poll failures and waits for a fresh status before explicit reopen', async () => {
  vi.useFakeTimers();
  h.get.mockResolvedValue({ status: 'ready', epoch: 'accepted' });
  render(
    <CheckoutSessionBoundary path="/tasks/task">
      <iframe title="session" />
    </CheckoutSessionBoundary>,
  );
  await act(async () => {});
  h.get.mockRejectedValueOnce(new Error('network unavailable'));
  await act(() => vi.advanceTimersByTimeAsync(2500));
  expect(screen.getByText(/Session status could not be checked/)).toBeTruthy();
  expect(screen.queryByTitle('session')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Reopen session' })).toBeNull();
  h.get.mockResolvedValue({ status: 'ready', epoch: 'replacement' });
  await act(() => vi.advanceTimersByTimeAsync(2500));
  expect(screen.queryByTitle('session')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Reopen session' }));
  expect(screen.getByTitle('session')).toBeTruthy();
});
