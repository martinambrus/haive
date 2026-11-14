// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { usePlanActivityRegistry, usePlanPending, usePlanAnswer } from './plan-activity';

afterEach(cleanup);

it('retains pending until all reporters clear, including unmount cleanup', () => {
  const registry = renderHook(() => usePlanActivityRegistry());
  const first = renderHook((pending) => usePlanPending(registry.result.current.report, pending), {
    initialProps: true,
  });
  const second = renderHook((pending) => usePlanPending(registry.result.current.report, pending), {
    initialProps: true,
  });
  expect(registry.result.current.pending).toBe(true);
  first.rerender(false);
  expect(registry.result.current.pending).toBe(true);
  second.unmount();
  expect(registry.result.current.pending).toBe(false);
  first.rerender(true);
  expect(registry.result.current.pending).toBe(true);
  first.unmount();
  expect(registry.result.current.pending).toBe(false);
});

it('moves a live reporter between registries without leaving the old one pending', () => {
  const a = renderHook(() => usePlanActivityRegistry());
  const b = renderHook(() => usePlanActivityRegistry());
  const reporter = renderHook((report) => usePlanPending(report, true), {
    initialProps: a.result.current.report,
  });
  reporter.rerender(b.result.current.report);
  expect(a.result.current.pending).toBe(false);
  expect(b.result.current.pending).toBe(true);
});

it('changes the content key only for a new assistant answer after the transcript loads', () => {
  const registry = renderHook(() => usePlanActivityRegistry());
  const answer = renderHook(() => usePlanAnswer(registry.result.current.answered));
  const key = registry.result.current.contentKey;
  act(() => answer.result.current('repo:node', 'old-answer'));
  expect(registry.result.current.contentKey).toBe(key);
  act(() => answer.result.current('repo:node', 'old-answer'));
  expect(registry.result.current.contentKey).toBe(key);
  act(() => answer.result.current('repo:node', 'new-answer'));
  expect(registry.result.current.contentKey).not.toBe(key);
  const changed = registry.result.current.contentKey;
  act(() => answer.result.current('repo:other', 'other-history'));
  expect(registry.result.current.contentKey).toBe(changed);
  act(() => answer.result.current('repo:other', 'next-answer'));
  expect(registry.result.current.contentKey).not.toBe(changed);
});

it('recognizes the first answer to a previously empty transcript', () => {
  const registry = renderHook(() => usePlanActivityRegistry());
  const answer = renderHook(() => usePlanAnswer(registry.result.current.answered));
  act(() => answer.result.current('repo:node', null));
  const before = registry.result.current.contentKey;
  act(() => answer.result.current('repo:node', 'first-answer'));
  expect(registry.result.current.contentKey).not.toBe(before);
});
