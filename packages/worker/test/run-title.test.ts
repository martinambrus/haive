import { describe, expect, it, vi } from 'vitest';
import { MAX_RUN_TITLE_CHARS, resolveRunTitle } from '../src/step-engine/run-title.js';

const args = { detected: { part: 3 }, formValues: {} };

describe('run title display metadata', () => {
  it('pins the column bound', () => {
    expect(MAX_RUN_TITLE_CHARS).toBe(256);
  });

  it('bounds Unicode characters without splitting an astral character', () => {
    const logger = { warn: vi.fn() };
    expect(resolveRunTitle({ runTitle: () => '  A😀BC  ' }, args, logger, 2)).toBe('A😀');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('removes controls, format characters and line separators, then trims', () => {
    const logger = { warn: vi.fn() };
    expect(
      resolveRunTitle(
        { runTitle: () => ' \u0000R\n\t\u001b\u007f\u0085\u202e\u2028\u2029eview ' },
        args,
        logger,
      ),
    ).toBe('Review');
  });

  it.each([
    {
      runTitle: () => {
        throw new Error('private callback exception');
      },
      reason: 'threw',
    },
    { runTitle: () => ' \u0000\n\t ', reason: 'empty' },
    { runTitle: () => ({ private: 'invalid title payload' }) as never, reason: 'invalid' },
  ])('warns without payloads for $reason titles', ({ runTitle, reason }) => {
    const logger = { warn: vi.fn() };
    expect(resolveRunTitle({ runTitle }, args, logger)).toBeNull();
    expect(logger.warn.mock.calls).toEqual([[{ reason }, 'ignoring llm run title']]);
  });

  it('treats null and an absent hook as intentional omissions', () => {
    const logger = { warn: vi.fn() };
    expect(resolveRunTitle({}, args, logger)).toBeNull();
    expect(resolveRunTitle({ runTitle: () => null }, args, logger)).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
