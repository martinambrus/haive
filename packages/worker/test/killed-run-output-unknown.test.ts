import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStreamJsonCollector } from '../src/queues/cli-exec/stream.js';

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'streams');
const ollama = readFileSync(path.join(FIXTURE_DIR, 'ollama.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim());
const isResult = (line: string) => (JSON.parse(line) as { type?: string }).type === 'result';

function usageOf(lines: string[]) {
  const collector = createStreamJsonCollector();
  for (const line of lines) collector.onChunk(line + '\n');
  return collector.getTokenUsage();
}

function feed(events: unknown[]) {
  return usageOf(events.map((e) => JSON.stringify(e)));
}

const assistant = (id: string, usage: Record<string, number>) => ({
  type: 'assistant',
  message: { id, content: [{ type: 'text', text: 'x' }], usage },
});

describe('a run with no result event reports its output as unknown', () => {
  it('killed ollama recording: output null, totals count the known buckets only', () => {
    const usage = usageOf(ollama.filter((line) => !isResult(line)));
    expect(usage?.outputTokens).toBeNull();
    expect(usage?.inputTokens).toBe(1490);
    expect(usage?.totalTokens).toBe(1490);
  });

  it('completed ollama recording keeps the result output exactly', () => {
    const expected = JSON.parse(
      readFileSync(path.join(FIXTURE_DIR, 'ollama.expected.json'), 'utf8'),
    ) as { tokenUsage: { outputTokens: number } };
    const usage = usageOf(ollama);
    expect(usage?.outputTokens).toBe(141);
    expect(usage?.outputTokens).toBe(expected.tokenUsage.outputTokens);
  });

  it('killed run with non-zero placeholders: output null, prompt buckets and peak unchanged', () => {
    const usage = feed([
      assistant('msg_1', {
        input_tokens: 5,
        output_tokens: 100,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 400,
      }),
      assistant('msg_2', {
        input_tokens: 7,
        output_tokens: 200,
        cache_read_input_tokens: 1400,
        cache_creation_input_tokens: 300,
      }),
    ]);
    expect(usage).toEqual({
      inputTokens: 12,
      outputTokens: null,
      totalTokens: 3112,
      cacheReadTokens: 2400,
      cacheCreationTokens: 700,
      peakPromptTokens: 1707,
    });
  });

  it('placeholder-only killed run records no usage at all', () => {
    expect(feed([assistant('msg_1', { input_tokens: 0, output_tokens: 1 })])).toBeNull();
  });

  it('a result event without usage (amp) keeps the per-message sum', () => {
    const usage = feed([
      assistant('msg_1', { input_tokens: 10, output_tokens: 99 }),
      assistant('msg_2', { input_tokens: 20, output_tokens: 1 }),
      { type: 'result', subtype: 'success', result: 'done' },
    ]);
    expect(usage?.outputTokens).toBe(100);
    expect(usage?.totalTokens).toBe(130);
  });
});
