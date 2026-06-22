import { describe, expect, it } from 'vitest';
import {
  createCodexJsonlCollector,
  extractCodexJsonlOutput,
} from '../src/queues/cli-exec-queue.js';

function feed(c: ReturnType<typeof createCodexJsonlCollector>, events: unknown[]): void {
  for (const e of events) c.onChunk(JSON.stringify(e) + '\n');
}

const DOCUMENTED_RUN = [
  { type: 'thread.started', thread_id: 't1' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { type: 'reasoning', text: 'thinking…' } },
  { type: 'item.completed', item: { type: 'agent_message', text: 'First answer' } },
  {
    type: 'turn.completed',
    usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 },
  },
];

describe('createCodexJsonlCollector', () => {
  it('extracts the agent message and turn usage from a documented run', () => {
    const c = createCodexJsonlCollector();
    feed(c, DOCUMENTED_RUN);
    expect(c.isJsonl()).toBe(true);
    expect(c.getResult()).toBe('First answer');
    expect(c.getTokenUsage()).toEqual({
      inputTokens: 1000,
      outputTokens: 50,
      totalTokens: 1050,
      cacheReadTokens: 800,
    });
    expect(c.getNoResultReason()).toBeNull();
  });

  it('sums usage across turns and keeps the LAST agent message', () => {
    const c = createCodexJsonlCollector();
    feed(c, [
      ...DOCUMENTED_RUN,
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Second answer' } },
      { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    expect(c.getResult()).toBe('Second answer');
    expect(c.getTokenUsage()).toEqual({
      inputTokens: 1010,
      outputTokens: 55,
      totalTokens: 1065,
      cacheReadTokens: 800,
    });
  });

  it('surfaces turn.failed as the no-result reason', () => {
    const c = createCodexJsonlCollector();
    feed(c, [{ type: 'thread.started' }, { type: 'turn.failed', error: { message: 'boom' } }]);
    expect(c.getResult()).toBeNull();
    expect(c.getNoResultReason()).toMatch(/boom/);
  });

  it('treats plain text output as not-JSONL', () => {
    const c = createCodexJsonlCollector();
    c.onChunk('Plain answer with no events\n');
    expect(c.isJsonl()).toBe(false);
    expect(c.getResult()).toBeNull();
    expect(c.getTokenUsage()).toBeNull();
    expect(c.getNoResultReason()).toBeNull();
  });

  it('handles chunks split mid-line', () => {
    const c = createCodexJsonlCollector();
    const line = JSON.stringify(DOCUMENTED_RUN[3]) + '\n';
    c.onChunk(line.slice(0, 20));
    c.onChunk(line.slice(20));
    expect(c.getResult()).toBe('First answer');
  });
});

describe('extractCodexJsonlOutput', () => {
  it('extracts text and usage from a full buffer', () => {
    const stdout = DOCUMENTED_RUN.map((e) => JSON.stringify(e)).join('\n') + '\n';
    const out = extractCodexJsonlOutput(stdout);
    expect(out.text).toBe('First answer');
    expect(out.tokenUsage?.totalTokens).toBe(1050);
    expect(out.eventCount).toBeGreaterThan(0);
  });

  it('flags non-JSONL stdout for raw fallback', () => {
    const out = extractCodexJsonlOutput('Plain answer');
    expect(out.eventCount).toBe(0);
    expect(out.text).toBeNull();
    expect(out.tokenUsage).toBeNull();
  });
});

describe('createCodexJsonlCollector onText (Clean-tab prose stream)', () => {
  it('fires onText for each agent_message, excluding reasoning', () => {
    const prose: string[] = [];
    const c = createCodexJsonlCollector((t) => prose.push(t));
    feed(c, [
      ...DOCUMENTED_RUN,
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Second answer' } },
      { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    // DOCUMENTED_RUN carries a 'reasoning' item that must NOT be emitted as prose.
    expect(prose).toEqual(['First answer', 'Second answer']);
  });
});
