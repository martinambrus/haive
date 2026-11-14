import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createStreamJsonCollector } from '../src/queues/cli-exec/stream.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/streams/request-claude.json', import.meta.url), 'utf8'),
);
const read = (events = structuredClone(fixture), suffix = '') => {
  const c = createStreamJsonCollector();
  c.onChunk(events.map((e: unknown) => JSON.stringify(e)).join('\n') + '\n' + suffix);
  return c.getRequestUsage();
};
describe('Claude request coverage', () => {
  const billingCases = JSON.parse(
    readFileSync(
      new URL('./fixtures/streams/request-claude-billing.json', import.meta.url),
      'utf8',
    ),
  );
  it.each(billingCases)('reconciles billed tokens for $name', ({ events, coverage, reasons }) => {
    expect(read(events)).toMatchObject({ coverage, reasons });
  });
  it.each(['inputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'outputTokens'])(
    'refuses contradictory billed %s for an observed model',
    (bucket) => {
      const events = structuredClone(billingCases[2]!.events);
      events[3].modelUsage['claude-sonnet-4-6'][bucket]++;
      expect(read(events)).toMatchObject({
        coverage: 'incomplete',
        reasons: ['model-usage-mismatch'],
      });
    },
  );
  it('still refuses mismatched priced totals with a matching billing alias', () => {
    const events = structuredClone(billingCases[0]!.events);
    events[3].usage.input_tokens++;
    expect(read(events)).toMatchObject({
      coverage: 'incomplete',
      reasons: expect.arrayContaining(['prompt-mismatch']),
    });
  });
  it('keeps zero request output unknown when result output is absent', () => {
    const events = structuredClone(fixture);
    for (const e of events) if (e.message) e.message.usage.output_tokens = 0;
    delete events[3].usage.output_tokens;
    expect(read(events).requests?.map((r) => r.outputTokens)).toEqual([null, null]);
  });
  it('refuses contradictory TTL evidence even when cache writes are zero', () => {
    const events = structuredClone(fixture);
    events[1].message.usage.cache_creation_input_tokens = 0;
    events[3].usage.cache_creation_input_tokens = 20;
    expect(read(events).coverage).toBe('incomplete');
  });
  it('deduplicates content blocks and keeps model, identity and TTL buckets', () => {
    const events = structuredClone(fixture);
    events.splice(2, 0, structuredClone(events[1]));
    const capture = read(events);
    expect(capture.coverage).toBe('complete');
    expect(capture.inputConvention).toBe('exclusive');
    expect(capture.requestCount).toBe(2);
    expect(capture.requests).toMatchObject([
      {
        requestId: 'a',
        model: 'model-a',
        inputTokens: 100,
        outputTokens: 2,
        cacheReadTokens: 30,
        cacheCreationTokens: 10,
        cacheCreation5mTokens: 10,
        cacheCreation1hTokens: 0,
      },
      { requestId: 'b', inputTokens: 200, outputTokens: 3 },
    ]);
  });
  it('leaves message_start output unknown when the result reports more output', () => {
    const events = structuredClone(fixture);
    events[3].usage.output_tokens = 100;
    const capture = read(events);
    expect(capture.coverage).toBe('complete');
    expect(capture.requests?.map((r) => r.outputTokens)).toEqual([null, null]);
  });
  it.each(['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'])(
    'reconciles %s separately, even if the full prompt sum matches',
    (key) => {
      const events = structuredClone(fixture);
      events[3].usage[key]++;
      events[3].usage[key === 'input_tokens' ? 'cache_read_input_tokens' : 'input_tokens']--;
      expect(read(events).coverage).toBe('incomplete');
    },
  );
  it.each([
    'missing-id',
    'missing-model',
    'missing-usage',
    'missing-input',
    'contradiction',
    'unknown-ttl',
    'invalid-billed-usage',
    'truncated',
    'malformed',
  ])('refuses exact coverage for %s', (kind) => {
    const events = structuredClone(fixture);
    let suffix = '';
    if (kind === 'missing-id') delete events[1].message.id;
    if (kind === 'missing-model') delete events[1].message.model;
    if (kind === 'missing-usage') delete events[1].message.usage;
    if (kind === 'missing-input') delete events[1].message.usage.input_tokens;
    if (kind === 'unknown-ttl') delete events[1].message.usage.cache_creation;
    if (kind === 'invalid-billed-usage') events[3].modelUsage = { 'model-a': { inputTokens: -1 } };
    if (kind === 'contradiction') {
      const other = structuredClone(events[1]);
      other.message.usage.input_tokens++;
      events.splice(2, 0, other);
    }
    if (kind === 'truncated') events.pop();
    if (kind === 'malformed') suffix = '{broken';
    expect(read(events, suffix).coverage).toBe('incomplete');
  });
  it('marks mixed models and preserves their individual identities', () => {
    const events = structuredClone(fixture);
    events[2].message.model = 'model-b';
    const capture = read(events);
    expect(capture.modelCoverage).toBe('mixed');
    expect(capture.coverage).toBe('incomplete');
    expect(capture.requests?.map((r) => r.model)).toEqual(['model-a', 'model-b']);
  });
  it('keeps steered coverage incomplete even with reconciled per-turn sums', () => {
    const events = structuredClone(fixture);
    const first = structuredClone(events[3]);
    first.usage = structuredClone(events[1].message.usage);
    events.splice(2, 0, first);
    events[4].usage = structuredClone(events[3].message.usage);
    expect(read(events).coverage).toBe('incomplete');
  });
});
