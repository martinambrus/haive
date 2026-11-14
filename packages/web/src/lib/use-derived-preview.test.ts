// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DerivedTaskTypeCreate, DerivedTaskTypeDiagnostics } from './api-client';
import { DERIVED_PREVIEW_DEBOUNCE_MS, useDerivedPreview } from './use-derived-preview';

const preview = vi.hoisted(() => vi.fn());
vi.mock('./api-client', () => ({ previewDerivedTaskType: preview }));
const body: DerivedTaskTypeCreate = {
  slug: 'mine',
  displayName: 'Mine',
  requiresRepository: true,
  runListStrategy: 'derived',
  baseSlug: 'workflow',
  changes: [],
};
const result: DerivedTaskTypeDiagnostics = {
  eligibility: { eligible: true },
  revision: null,
  candidates: [],
  issues: [],
  defaultIssues: [],
  warnings: [],
  catalogFingerprint: 'current',
};
beforeEach(() => {
  vi.useFakeTimers();
  preview.mockReset();
  preview.mockResolvedValue(result);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const advance = async (ms = 10) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe('derived preview requests', () => {
  it('pins the debounce and coalesces edits without wall-clock waits', async () => {
    expect(DERIVED_PREVIEW_DEBOUNCE_MS).toBe(350);
    const hook = renderHook(({ body }) => useDerivedPreview(body, 10), { initialProps: { body } });
    await advance(9);
    expect(preview).not.toHaveBeenCalled();
    hook.rerender({ body: { ...body, changes: [{ remove: 'old' }] } });
    await advance(9);
    expect(preview).not.toHaveBeenCalled();
    await advance(1);
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview.mock.calls[0]![0].changes).toEqual([{ remove: 'old' }]);
  });

  it('aborts obsolete requests and discards their replies even if transport ignores abort', async () => {
    let oldReply!: (value: DerivedTaskTypeDiagnostics) => void;
    preview.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          oldReply = resolve;
        }),
    );
    const hook = renderHook(({ body }) => useDerivedPreview(body, 10), { initialProps: { body } });
    await advance();
    const oldSignal = preview.mock.calls[0]![1] as AbortSignal;
    hook.rerender({ body: { ...body, changes: [{ remove: 'old' }] } });
    expect(oldSignal.aborted).toBe(true);
    await advance();
    await act(async () => {
      oldReply({ ...result, catalogFingerprint: 'obsolete' });
    });
    expect(hook.result.current.diagnostics?.catalogFingerprint).toBe('current');
    hook.unmount();
    expect((preview.mock.calls[1]![1] as AbortSignal).aborted).toBe(true);
  });

  it('retains 400 diagnostics and stops requests after a 403, keeping the refusal visible', async () => {
    preview.mockRejectedValueOnce({
      status: 400,
      body: { ...result, issues: [{ kind: 'replacement-contract-unavailable' }] },
    });
    const hook = renderHook(({ body }) => useDerivedPreview(body, 10), { initialProps: { body } });
    await advance();
    expect(hook.result.current.diagnostics?.issues).toEqual([
      { kind: 'replacement-contract-unavailable' },
    ]);
    preview.mockRejectedValueOnce({ status: 403, message: 'Admin access required' });
    hook.rerender({ body: { ...body, displayName: 'Changed' } });
    await advance();
    expect(hook.result.current.forbidden).toBe(true);
    expect(hook.result.current.error).toBe('Admin access required');
    hook.rerender({ body: { ...body, displayName: 'Changed again' } });
    await advance();
    expect(preview).toHaveBeenCalledTimes(2);
  });
});
