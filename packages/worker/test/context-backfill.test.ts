import { describe, expect, it } from 'vitest';
import {
  deriveContext,
  replayContext,
  type ContextInvocation,
} from '../src/maintenance/context-backfill.js';

const log = (events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n');
const claude = log([
  { type: 'system', subtype: 'init', model: 'claude-opus-5' },
  {
    type: 'assistant',
    message: {
      id: 'a',
      model: 'claude-opus-5',
      usage: { input_tokens: 10, cache_read_input_tokens: 50000, output_tokens: 1 },
    },
  },
  {
    type: 'assistant',
    message: {
      id: 'b',
      model: 'claude-opus-5',
      usage: { input_tokens: 20, cache_read_input_tokens: 80000, output_tokens: 1 },
    },
  },
  {
    type: 'result',
    subtype: 'success',
    usage: { input_tokens: 30, cache_read_input_tokens: 130000, output_tokens: 2 },
    modelUsage: { 'claude-opus-5': { contextWindow: 1000000 } },
  },
]);
const before = { tokens: 130030, window: 1000000, left: 87 };
const inv = (
  replay = replayContext(claude),
  usage = { inputTokens: 30, cacheReadTokens: 130000 },
): ContextInvocation => ({ id: 'a', usage, replay });

describe('historical context evidence', () => {
  it('replays the live claude collector rather than a run aggregate', () => {
    expect(replayContext(claude)).toMatchObject({ peak: 80020, window: 1000000, state: 'known' });
    expect(deriveContext(before, [inv()])).toMatchObject({
      kind: 'changed',
      after: { tokens: 80020, window: 1000000, left: 92 },
    });
    expect(deriveContext({ ...before, window: 200000 }, [inv()])).toMatchObject({
      after: { window: 1000000 },
    });
    expect(
      deriveContext({ ...before, window: 200000 }, [{ ...inv(), providerName: 'openrouter' }]),
    ).toMatchObject({ kind: 'ambiguous' });
  });
  it('codex last.input includes cache; exec totals prove no request peak', () => {
    const app = replayContext(
      log([
        {
          method: 'thread/tokenUsage/updated',
          params: {
            tokenUsage: {
              last: { inputTokens: 30000 },
              total: { inputTokens: 100000, cachedInputTokens: 20000, outputTokens: 2 },
              modelContextWindow: 258400,
            },
          },
        },
      ]),
    );
    expect(app).toMatchObject({ peak: 30000, window: 258400 });
    const exec = replayContext(
      log([
        { type: 'turn.completed', usage: { input_tokens: 100000, cached_input_tokens: 20000 } },
      ]),
    );
    expect(exec).toMatchObject({ state: 'known', peak: null, format: 'codex-exec' });
    expect(deriveContext(before, [inv(exec)])).toMatchObject({
      after: { tokens: null, window: null, left: null },
    });
  });
  it('keeps modern stamps when logs disappeared and skips unknown legacy evidence', () => {
    expect(deriveContext(before, [inv(replayContext(null))]).kind).toBe('missing');
    const modern = inv(replayContext(null), {
      inputTokens: 30,
      cacheReadTokens: 130000,
      peakPromptTokens: 130030,
    } as never);
    expect(deriveContext(before, [modern]).kind).toBe('unchanged');
    expect(deriveContext(before, [inv(replayContext('{"stats":{}}'))]).kind).toBe('ambiguous');
  });
  it('elided replay is a lower bound; malformed and mixed protocols are ambiguous', () => {
    expect(replayContext('[haive] --- 20 characters elided: x\n' + claude)).toMatchObject({
      state: 'partial',
      peak: 80020,
    });
    expect(
      deriveContext(before, [inv(replayContext('[haive] --- 20 characters elided: x\n' + claude))])
        .kind,
    ).toBe('ambiguous');
    expect(replayContext(claude + '\n{broken')).toMatchObject({ state: 'ambiguous' });
    expect(replayContext(claude + '\n{"type":"turn.completed"}')).toMatchObject({
      state: 'ambiguous',
    });
    const zero = log([
      { type: 'assistant', message: { id: 'a', usage: { input_tokens: 0, output_tokens: 0 } } },
      { type: 'result', usage: { input_tokens: 12345, output_tokens: 1 } },
    ]);
    expect(replayContext(zero)).toMatchObject({ peak: 12345 });
    expect(replayContext('[haive] --- 20 characters elided: x\n' + zero)).toMatchObject({
      state: 'partial',
      peak: null,
    });
  });
  it('uses live weight selection; ties and conflicting modern evidence are disclosed', () => {
    const a = inv();
    const b = {
      ...inv(),
      id: 'b',
      usage: { inputTokens: 900000 },
      replay: { ...replayContext(claude), peak: null },
    };
    expect(deriveContext(before, [a, b])).toMatchObject({
      after: { tokens: null, window: null, left: null },
    });
    expect(deriveContext(before, [a, { ...a, id: 'b' }]).kind).toBe('ambiguous');
    expect(
      deriveContext(before, [
        inv(replayContext(claude), { inputTokens: 30, peakPromptTokens: 7 } as never),
      ]).kind,
    ).toBe('ambiguous');
  });
});
