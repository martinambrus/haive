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

  it('spaces control whitespace and line separators, strips other controls, then trims', () => {
    const logger = { warn: vi.fn() };
    expect(
      resolveRunTitle(
        { runTitle: () => ' \u0000R\n\t\u001b\u007f\u0085\u202e\u2028\u2029eview ' },
        args,
        logger,
      ),
    ).toBe('R eview');
  });

  it.each(['\t', '\n', '\r', '\v', '\f', '\u0085', '\u2028', '\u2029'])(
    'preserves word boundaries across %j',
    (separator) => {
      expect(
        resolveRunTitle({ runTitle: () => `Review${separator}part   3` }, args, { warn: vi.fn() }),
      ).toBe('Review part 3');
    },
  );

  it('keeps ZWNJ in Persian and ZWJ in emoji while stripping other format controls', () => {
    const title = 'می\u200cروم 👩\u200d👩\u200d👧\u200d👦';
    const controls =
      '\u200b\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\ufeff';
    expect(
      resolveRunTitle({ runTitle: () => `${controls}${title}${controls}` }, args, {
        warn: vi.fn(),
      }),
    ).toBe(title);
  });

  it.each(['fulfilled', 'rejected'])(
    'ignores a %s Promise and handles its rejection',
    async (state) => {
      const promise =
        state === 'rejected'
          ? Promise.reject(new Error('private async callback exception'))
          : Promise.resolve('private async title');
      const catchRejection = vi.spyOn(promise, 'catch');
      const logger = { warn: vi.fn() };
      try {
        expect(resolveRunTitle({ runTitle: () => promise as never }, args, logger)).toBeNull();
        expect(logger.warn.mock.calls).toEqual([[{ reason: 'invalid' }, 'ignoring llm run title']]);
        expect(catchRejection).toHaveBeenCalledWith(expect.any(Function));
      } finally {
        await promise.catch(() => {});
      }
    },
  );

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
