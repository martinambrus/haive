import { describe, expect, it } from 'vitest';
import {
  deliverPrompt,
  PromptTooLargeError,
  PROMPT_ARGV_LIMIT_BYTES,
  MAX_ARG_BYTES,
} from '../src/cli-adapters/prompt-delivery.js';

const small = 'expand this node';
const huge = 'x'.repeat(PROMPT_ARGV_LIMIT_BYTES + 1);

describe('deliverPrompt', () => {
  it('passes an ordinary prompt as an argument, as before', () => {
    const out = deliverPrompt(small, { adapter: 'codex', stdin: true });
    expect(out.argv).toEqual([small]);
    expect(out.stdinPrompt).toBeUndefined();
  });

  it('sends an oversized prompt over stdin when the CLI reads stdin', () => {
    // The measured failure: 26 of 47 Codex agents never started because the
    // prompt exceeded the kernel's per-argument limit.
    const out = deliverPrompt(huge, { adapter: 'codex', stdin: true });
    expect(out.argv).toEqual([]);
    expect(out.stdinPrompt).toBe(huge);
  });

  it('refuses by name when the CLI cannot read stdin', () => {
    // Better than `spawn E2BIG`, which names neither the adapter, the size nor
    // the limit.
    let err: unknown;
    try {
      deliverPrompt(huge, { adapter: 'grok', stdin: false });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PromptTooLargeError);
    expect((err as PromptTooLargeError).adapter).toBe('grok');
    expect((err as Error).message).toContain(String(PROMPT_ARGV_LIMIT_BYTES));
  });

  it('measures BYTES, not characters', () => {
    // The kernel counts bytes; a JS string counts UTF-16 units. An em-dash is
    // one character and three bytes, and these prompts are full of them — using
    // .length would under-report by a third and let the spawn fail anyway.
    const emDashes = '—'.repeat(PROMPT_ARGV_LIMIT_BYTES / 3 + 10);
    expect(emDashes.length).toBeLessThan(PROMPT_ARGV_LIMIT_BYTES);
    expect(deliverPrompt(emDashes, { adapter: 'codex', stdin: true }).stdinPrompt).toBe(emDashes);
  });

  it('keeps argv for a prompt exactly at the limit', () => {
    const exact = 'x'.repeat(PROMPT_ARGV_LIMIT_BYTES);
    expect(deliverPrompt(exact, { adapter: 'codex', stdin: true }).argv).toEqual([exact]);
  });

  it('leaves headroom under the kernel limit', () => {
    // argv also carries every other flag, and the environment is charged
    // against a related budget, so the threshold cannot BE the limit.
    expect(PROMPT_ARGV_LIMIT_BYTES).toBeLessThan(MAX_ARG_BYTES);
  });
});
