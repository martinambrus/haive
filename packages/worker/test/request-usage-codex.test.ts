import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createCodexAppServerSession } from '../src/cli-executor/codex-app-server.js';

// Generated values, measured 0.154.0 SHAPES from codex-app-server-session.test.ts:
// several requests share turn-1, no request id, total is cumulative and last is request-local.
const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/streams/request-codex-app-server.json', import.meta.url),
    'utf8',
  ),
);
function read(events = structuredClone(fixture), suffix = '') {
  const s = createCodexAppServerSession({ prompt: 'p', model: 'model-a', effort: null });
  s.attach({ writable: true, write: () => true, end: () => {} } as never);
  s.onChunk(events.map((e: unknown) => JSON.stringify(e)).join('\n') + '\n' + suffix);
  s.close();
  return s;
}
describe('Codex request watermarks', () => {
  it('keeps distinct requests in one turn, preserving inclusive input exactly once', () => {
    const s = read();
    expect(s.getRequestUsage()).toMatchObject({
      coverage: 'complete',
      requestCount: 2,
      inputConvention: 'inclusive',
      modelCoverage: 'single',
    });
    expect(s.getRequestUsage().requests).toMatchObject([
      {
        turnId: 'turn-1',
        model: 'model-a',
        inputTokens: 1000,
        cacheReadTokens: 800,
        outputTokens: 50,
      },
      {
        turnId: 'turn-1',
        model: 'model-a',
        inputTokens: 2000,
        cacheReadTokens: 900,
        outputTokens: 60,
      },
    ]);
    expect(new Set(s.getRequestUsage().requests?.map((r) => r.requestId)).size).toBe(2);
    expect(s.getTokenUsage()).toEqual({
      inputTokens: 3000,
      outputTokens: 110,
      totalTokens: 3110,
      cacheReadTokens: 1700,
      peakPromptTokens: 2000,
    });
  });
  it('deduplicates repeated watermarks without claiming exact coverage', () => {
    const events = structuredClone(fixture);
    events.splice(5, 0, structuredClone(events[4]));
    const capture = read(events).getRequestUsage();
    expect(capture.requests).toHaveLength(2);
    expect(capture.coverage).toBe('incomplete');
  });
  it.each([
    'jump',
    'reset',
    'missing-update',
    'missing-last',
    'bad-last',
    'negative',
    'missing-output',
    'bad-total',
    'foreign-turn',
    'malformed',
    'no-completion',
    'no-start',
  ])('marks %s incomplete', (kind) => {
    const events = structuredClone(fixture);
    let suffix = '';
    const u = events[5].params.tokenUsage;
    if (kind === 'jump') u.total.inputTokens++;
    if (kind === 'reset') u.total.inputTokens = 500;
    if (kind === 'missing-last') delete u.last;
    if (kind === 'bad-last') u.last.cachedInputTokens++;
    if (kind === 'negative') u.last.outputTokens = -1;
    if (kind === 'missing-output') delete u.last.outputTokens;
    if (kind === 'bad-total') u.total.totalTokens++;
    if (kind === 'foreign-turn') events[5].params.turnId = 'other';
    if (kind === 'missing-update') events.splice(4, 1);
    if (kind === 'malformed') suffix = '{bad';
    if (kind === 'no-completion') events.pop();
    if (kind === 'no-start') events.splice(3, 1);
    expect(read(events, suffix).getRequestUsage().coverage).toBe('incomplete');
  });
  it('retains request models across rerouting and marks mixed coverage incomplete', () => {
    const events = structuredClone(fixture);
    events.splice(5, 0, {
      method: 'model/rerouted',
      params: { turnId: 'turn-1', toModel: 'model-b' },
    });
    const capture = read(events).getRequestUsage();
    expect(capture.requests?.map((r) => r.model)).toEqual(['model-a', 'model-b']);
    expect(capture.modelCoverage).toBe('mixed');
    expect(capture.coverage).toBe('incomplete');
  });
  it('records observable cache writes without modifying legacy usage', () => {
    const events = structuredClone(fixture);
    events[4].params.tokenUsage.total.cacheWriteInputTokens = 10;
    events[4].params.tokenUsage.last.cacheWriteInputTokens = 10;
    events[5].params.tokenUsage.total.cacheWriteInputTokens = 10;
    events[5].params.tokenUsage.last.cacheWriteInputTokens = 0;
    const s = read(events);
    expect(s.getRequestUsage().requests?.[0]).toMatchObject({
      cacheCreationTokens: 10,
      cacheCreation5mTokens: null,
      cacheCreation1hTokens: null,
    });
    expect(s.getRequestUsage().coverage).toBe('incomplete');
    expect(s.getTokenUsage()).not.toHaveProperty('cacheCreationTokens');
  });
});
