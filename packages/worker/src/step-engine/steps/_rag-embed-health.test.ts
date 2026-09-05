import { describe, it, expect, vi, afterEach } from 'vitest';

const resolveEmbedBudget = vi.fn();
const ollamaEmbed = vi.fn();

vi.mock('@haive/shared/rag', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared/rag')>();
  return { ...actual, resolveEmbedBudget, ollamaEmbed };
});

const { embedBatch, composeRagWarning, ragEmbedWarning } = await import('./_rag-embed-health.js');

const BUDGET = {
  embedTimeoutMs: 240_000,
  queryTimeoutMs: 20_000,
  warmupTimeoutMs: 300_000,
  batchSize: 8,
  strict: true,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('embedBatch', () => {
  it('returns model vectors when the embed succeeds', async () => {
    resolveEmbedBudget.mockResolvedValue(BUDGET);
    ollamaEmbed.mockResolvedValue([[0.1, 0.2]]);
    const out = await embedBatch({
      ollamaUrl: 'http://x',
      model: 'm',
      dimensions: 4,
      useOllama: true,
      texts: ['a'],
    });
    expect(out.kind).toBe('embedded');
  });

  it('FAILS rather than hashing when strict and the embed rejects', async () => {
    // The whole point: a hash vector beside real ones is noise nothing can later
    // tell apart, so a failure must stay a failure.
    resolveEmbedBudget.mockResolvedValue(BUDGET);
    ollamaEmbed.mockRejectedValue(new Error('boom'));
    const out = await embedBatch({
      ollamaUrl: 'http://x',
      model: 'm',
      dimensions: 4,
      useOllama: true,
      texts: ['a', 'b'],
    });
    expect(out.kind).toBe('failed');
    if (out.kind === 'failed') expect(out.reason).toContain('boom');
  });

  it('names a timeout as a timeout, with the budget that was exceeded', async () => {
    resolveEmbedBudget.mockResolvedValue(BUDGET);
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    ollamaEmbed.mockRejectedValue(timeout);
    const out = await embedBatch({
      ollamaUrl: 'http://x',
      model: 'm',
      dimensions: 4,
      useOllama: true,
      texts: ['a'],
    });
    expect(out.kind).toBe('failed');
    // The fix differs for a timeout (raise the budget / lower the batch) versus any
    // other error, so the reason has to say which it was.
    if (out.kind === 'failed') expect(out.reason).toContain('240s');
  });

  it('restores the old hash fallback when strict is off', async () => {
    resolveEmbedBudget.mockResolvedValue({ ...BUDGET, strict: false });
    ollamaEmbed.mockRejectedValue(new Error('boom'));
    const out = await embedBatch({
      ollamaUrl: 'http://x',
      model: 'm',
      dimensions: 4,
      useOllama: true,
      texts: ['a'],
    });
    expect(out.kind).toBe('hashed');
    if (out.kind === 'hashed') expect(out.embeddings[0]).toHaveLength(4);
  });

  it('hashes without ever failing when no endpoint is configured', async () => {
    // A repo with no embedding endpoint gets hash vectors for EVERY chunk, which is
    // homogeneous and therefore honest — not the mid-run substitution this guards.
    resolveEmbedBudget.mockResolvedValue(BUDGET);
    const out = await embedBatch({
      ollamaUrl: null,
      model: null,
      dimensions: 3,
      useOllama: false,
      texts: ['a', 'b'],
    });
    expect(out.kind).toBe('hashed');
    expect(ollamaEmbed).not.toHaveBeenCalled();
  });
});

describe('ragEmbedWarning', () => {
  it('says nothing when healthy', () => {
    expect(
      ragEmbedWarning({ degradedAt: null, degradedReason: null, lexicalOnly: false }),
    ).toBeNull();
  });

  it('gates on degradedAt, not on the leftover reason string', () => {
    // The message-column rule: a reason outlives the state it describes, so keying
    // the banner on its presence renders a phantom failure after a repair.
    expect(
      ragEmbedWarning({ degradedAt: null, degradedReason: 'stale text', lexicalOnly: false }),
    ).toBeNull();
  });

  it('warns while degraded, and reports how many chunks were left unindexed', () => {
    const msg = ragEmbedWarning(
      { degradedAt: new Date(), degradedReason: 'model timed out', lexicalOnly: false },
      { skippedChunks: 24 },
    );
    expect(msg).toContain('model timed out');
    expect(msg).toContain('24 chunk');
  });

  it('reports lexical-only ahead of any degradation', () => {
    const msg = ragEmbedWarning({
      degradedAt: new Date(),
      degradedReason: 'model timed out',
      lexicalOnly: true,
    });
    expect(msg).toContain('lexical-only');
  });
});

describe('composeRagWarning', () => {
  it('returns null when there is nothing to say, so a healthy run clears the banner', () => {
    expect(composeRagWarning(null, null)).toBeNull();
  });

  it('joins the parts it does have', () => {
    expect(composeRagWarning('a', null, 'b')).toBe('a\n\nb');
  });
});
