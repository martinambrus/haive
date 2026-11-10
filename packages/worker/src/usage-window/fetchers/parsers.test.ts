import { afterEach, describe, it, expect, vi } from 'vitest';
import { parseClaudeUsage } from './claude-code.js';
import { parseCodexUsage } from './codex.js';
import { parseZaiUsage } from './zai.js';
import { parseGeminiUsage } from './gemini.js';
import { USAGE_PROVIDERS } from './index.js';
import type { CliProviderName } from '@haive/shared';

describe('parseClaudeUsage', () => {
  it('maps five_hour/seven_day utilization (0-100 used) + ISO resets', () => {
    const w = parseClaudeUsage({
      five_hour: { utilization: 33, resets_at: '2026-04-11T07:00:00.528743+00:00' },
      seven_day: { utilization: 13, resets_at: '2026-04-17T00:59:59.951713+00:00' },
      seven_day_opus: null,
      extra_usage: { is_enabled: false },
    });
    expect(w.fiveHour?.usedPct).toBe(33);
    expect(w.sevenDay?.usedPct).toBe(13);
    expect(w.fiveHour?.resetsAt).toBe('2026-04-11T07:00:00.528Z');
  });

  it('returns empty object on missing/foreign shape', () => {
    expect(parseClaudeUsage({})).toEqual({});
    expect(parseClaudeUsage(null)).toEqual({});
  });
});

describe('parseCodexUsage', () => {
  it('reads used_percent (protocol shape) with unix-seconds reset', () => {
    const w = parseCodexUsage({
      primary: { used_percent: 18, resets_at: 1_781_000_000 },
      secondary: { used_percent: 64 },
    });
    expect(w.fiveHour?.usedPct).toBe(18);
    expect(w.sevenDay?.usedPct).toBe(64);
    expect(w.fiveHour?.resetsAt).toBe(new Date(1_781_000_000 * 1000).toISOString());
  });

  it('inverts percent_left (raw-HTTP shape) nested under rate_limit', () => {
    const w = parseCodexUsage({
      rate_limit: {
        primary_window: { percent_left: 82 },
        secondary_window: { percent_left: 36 },
      },
    });
    expect(w.fiveHour?.usedPct).toBe(18);
    expect(w.sevenDay?.usedPct).toBe(64);
  });

  it('maps a lone window (Plus) to weekly when its reset is far out, not 5h', () => {
    // Plus returns ONE window in the `primary` slot, but it is the WEEKLY limit
    // (reset days out). Slot position would mislabel it "5h"; the horizon must win.
    const now = Date.UTC(2026, 6, 13, 7, 0, 0);
    const w = parseCodexUsage(
      { primary: { used_percent: 5, resets_at: '2026-07-19T19:05:49Z' } },
      now,
    );
    expect(w.sevenDay?.usedPct).toBe(5);
    expect(w.fiveHour).toBeUndefined();
  });

  it('maps a lone window to 5h when it resets within a few hours', () => {
    const now = Date.UTC(2026, 6, 13, 7, 0, 0);
    const w = parseCodexUsage(
      { primary: { used_percent: 20, resets_at: '2026-07-13T10:00:00Z' } },
      now,
    );
    expect(w.fiveHour?.usedPct).toBe(20);
    expect(w.sevenDay).toBeUndefined();
  });

  it('returns empty on unknown shape', () => {
    expect(parseCodexUsage({ foo: 1 })).toEqual({});
  });
});

describe('parseZaiUsage', () => {
  it('picks TOKENS_LIMIT percentage as the 5-hour window, ignores TIME_LIMIT', () => {
    const w = parseZaiUsage([
      { type: 'TIME_LIMIT', percentage: 10 },
      { type: 'TOKENS_LIMIT', percentage: 45 },
    ]);
    expect(w.fiveHour?.usedPct).toBe(45);
    expect(w.sevenDay).toBeUndefined();
    expect(w.daily).toBeUndefined();
  });

  it('accepts a {data:[...]} envelope', () => {
    const w = parseZaiUsage({ data: [{ type: 'TOKENS_LIMIT', percentage: 7 }] });
    expect(w.fiveHour?.usedPct).toBe(7);
  });

  it('reads the {data:{limits:[...]}} envelope and splits both token windows', () => {
    // Verbatim from a live api.z.ai response. The array moved under `data.limits`, which
    // emptied the old parse and reported `unexpected response shape` on an HTTP 200.
    // Period comes from nextResetTime, NOT the undocumented unit/number pair.
    const now = 1_785_659_648_000;
    const w = parseZaiUsage(
      {
        code: 200,
        data: {
          limits: [
            { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 0 },
            {
              type: 'TOKENS_LIMIT',
              unit: 6,
              number: 1,
              percentage: 1,
              nextResetTime: 1_786_185_900_997,
            },
            {
              type: 'TIME_LIMIT',
              unit: 5,
              number: 1,
              percentage: 0,
              nextResetTime: 1_787_654_700_995,
            },
          ],
          level: 'pro',
        },
        success: true,
      },
      now,
    );
    expect(w.fiveHour?.usedPct).toBe(0);
    expect(w.fiveHour?.resetsAt).toBeNull();
    expect(w.sevenDay?.usedPct).toBe(1);
    expect(w.sevenDay?.resetsAt).toBe(new Date(1_786_185_900_997).toISOString());
    // TIME_LIMIT resets ~23d out but must never occupy the weekly slot.
    expect(w.daily).toBeUndefined();
  });

  it('keeps the first item per period so a repeated window cannot flip the reading', () => {
    const now = 1_785_659_648_000;
    const w = parseZaiUsage(
      {
        data: {
          limits: [
            { type: 'TOKENS_LIMIT', percentage: 12 },
            { type: 'TOKENS_LIMIT', percentage: 90 },
          ],
        },
      },
      now,
    );
    expect(w.fiveHour?.usedPct).toBe(12);
    expect(w.sevenDay).toBeUndefined();
  });

  it('returns empty on an unknown envelope rather than drawing a zero', () => {
    expect(parseZaiUsage({ foo: 1 })).toEqual({});
    expect(parseZaiUsage({ data: { notLimits: [] } })).toEqual({});
  });
});

describe('parseGeminiUsage', () => {
  it('inverts remainingFraction to a daily used-% and reads resetTime', () => {
    const w = parseGeminiUsage({
      buckets: [
        { tokenType: 'REQUESTS', remainingFraction: 0.76175, resetTime: '2025-12-10T22:19:52Z' },
      ],
    });
    // (1 - 0.76175) * 100 = 23.825 -> 24
    expect(w.daily?.usedPct).toBe(24);
    expect(w.daily?.resetsAt).toBe('2025-12-10T22:19:52.000Z');
    expect(w.fiveHour).toBeUndefined();
  });

  it('returns empty when no bucket carries a remainingFraction', () => {
    expect(parseGeminiUsage({ buckets: [{ tokenType: 'REQUESTS' }] })).toEqual({});
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe.each(Object.entries(USAGE_PROVIDERS))('%s usage HTTP deadline', (name, cfg) => {
  it.each(['request', 'body'])(
    'aborts a stalled %s and allows a later successful fetch',
    async (phase) => {
      vi.useFakeTimers();
      const deadline = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException('Usage deadline', 'TimeoutError')), ms);
        return controller.signal;
      });
      const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const signal = init?.signal;
        if (!signal) throw new Error('missing deadline signal');
        const stalled = () =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        if (phase === 'request') return stalled();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              signal.addEventListener('abort', () => controller.error(signal.reason), {
                once: true,
              });
            },
          }),
        );
      });
      vi.stubGlobal('fetch', fetchMock);
      const ctx = { providerName: name as CliProviderName };
      const pending = cfg.fetch('fixture-token', ctx);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await pending).toEqual({ ok: false, rateLimited: false, error: 'Usage deadline' });
      expect(deadline).toHaveBeenCalledWith(15_000);
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                five_hour: { utilization: 12 },
                primary: { used_percent: 12 },
                data: [{ type: 'TOKENS_LIMIT', percentage: 12 }],
                buckets: [{ tokenType: 'REQUESTS', remainingFraction: 0.88 }],
              }),
            ),
        ),
      );
      expect((await cfg.fetch('fixture-token', ctx)).ok).toBe(true);
    },
  );

  it.each([401, 403, 429, 503])('preserves HTTP %i classification', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status })),
    );
    const result = await cfg.fetch('fixture-token', { providerName: name as CliProviderName });
    expect(result).toMatchObject({
      ok: false,
      rateLimited: status === 429,
      error: `http ${status}`,
    });
    if (status !== 429)
      expect(result).toHaveProperty('authExpired', status === 401 || status === 403);
  });
});
