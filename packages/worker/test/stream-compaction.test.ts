import { describe, expect, it } from 'vitest';
import { createStreamJsonCollector } from '../src/queues/cli-exec/stream.js';

const line = (o: unknown): string => JSON.stringify(o) + '\n';

/** Verbatim shape, read out of the shipped claude binary (v2.1.266) rather than from docs:
 *    compact_metadata: c({ trigger: Y(["manual","auto"]), pre_tokens: E().int(),
 *                          post_tokens: E().int().optional(),
 *                          cumulative_dropped_tokens: E().int().optional() }) */
const boundary = (meta: Record<string, unknown>) =>
  line({ type: 'system', subtype: 'compact_boundary', compact_metadata: meta });

/** The event a LIVE `claude -p '/compact' --resume` actually emitted (v2.1.266, manual
 *  compaction of a 7-turn session). Kept verbatim because the binary's own zod schema
 *  understates it: `duration_ms`, `preserved_segment` and `preserved_messages` are all in
 *  the wire payload and none appears in the schema declaration. The two `preserved_*`
 *  objects are the reason this fixture matters — they are nested structures the parser must
 *  walk straight past, and a shape assertion written from the schema alone would never have
 *  covered them. */
const LIVE_EVENT = {
  type: 'system',
  subtype: 'compact_boundary',
  session_id: 'a7d099d3-dc6b-4e60-8924-1b6bc9711971',
  uuid: '9e91a77b-1e6d-49d4-9f96-373b4d47092b',
  compact_metadata: {
    trigger: 'manual',
    pre_tokens: 24647,
    post_tokens: 3516,
    cumulative_dropped_tokens: 21131,
    duration_ms: 46664,
    preserved_segment: {
      head_uuid: '65aec6cd-f8f9-4f23-aa03-deb27a38a3dc',
      anchor_uuid: 'd5e71978-2cca-48da-92ed-791fe74d49da',
      tail_uuid: 'daf195c9-6518-4207-86be-6b65b7e75c30',
    },
    preserved_messages: {
      anchor_uuid: 'd5e71978-2cca-48da-92ed-791fe74d49da',
      uuids: ['65aec6cd-f8f9-4f23-aa03-deb27a38a3dc', 'daf195c9-6518-4207-86be-6b65b7e75c30'],
      all_uuids: ['65aec6cd-f8f9-4f23-aa03-deb27a38a3dc', 'daf195c9-6518-4207-86be-6b65b7e75c30'],
    },
  },
};

describe('context compaction', () => {
  it('parses the event a live binary actually emitted', () => {
    // The end-to-end proof: this exact object came off `claude -p '/compact' --resume`.
    // Everything else here is a shape the schema implies; this one is a shape it produced.
    const c = createStreamJsonCollector();
    c.onChunk(line(LIVE_EVENT));
    expect(c.getCompactions()).toEqual([
      {
        trigger: 'manual',
        preTokens: 24_647,
        postTokens: 3_516,
        cumulativeDroppedTokens: 21_131,
        durationMs: 46_664,
      },
    ]);
  });

  it('records a compaction with every field the binary reported', () => {
    const c = createStreamJsonCollector();
    c.onChunk(
      boundary({
        trigger: 'auto',
        pre_tokens: 812_000,
        post_tokens: 94_000,
        cumulative_dropped_tokens: 718_000,
        duration_ms: 31_200,
      }),
    );
    expect(c.getCompactions()).toEqual([
      {
        trigger: 'auto',
        preTokens: 812_000,
        postTokens: 94_000,
        cumulativeDroppedTokens: 718_000,
        durationMs: 31_200,
      },
    ]);
  });

  it('keeps an event whose optional fields are absent', () => {
    // post_tokens and cumulative_dropped_tokens are `.optional()` in the binary's own schema.
    // A compaction that reported only its trigger and pre_tokens is still a compaction — the
    // fact that it HAPPENED is the whole signal, and the token figures are detail.
    const c = createStreamJsonCollector();
    c.onChunk(boundary({ trigger: 'manual', pre_tokens: 500_000 }));
    expect(c.getCompactions()).toEqual([
      {
        trigger: 'manual',
        preTokens: 500_000,
        postTokens: null,
        cumulativeDroppedTokens: null,
        durationMs: null,
      },
    ]);
  });

  it('records one entry per event, in stream order', () => {
    const c = createStreamJsonCollector();
    c.onChunk(boundary({ trigger: 'auto', pre_tokens: 900_000, post_tokens: 100_000 }));
    c.onChunk(line({ type: 'assistant', message: { model: 'claude-opus-5', content: [] } }));
    c.onChunk(boundary({ trigger: 'auto', pre_tokens: 880_000, post_tokens: 120_000 }));
    expect(c.getCompactions().map((e) => e.preTokens)).toEqual([900_000, 880_000]);
  });

  it('keeps a trigger value it has not seen rather than dropping the event', () => {
    // The binary names "manual" and "auto" today. A third value must be RECORDED, not
    // discarded: an unrecognised trigger is exactly the case worth looking at, and this
    // column exists to be read by a human. Stored verbatim, never mapped to a default.
    const c = createStreamJsonCollector();
    c.onChunk(boundary({ trigger: 'microcompact', pre_tokens: 1 }));
    expect(c.getCompactions()[0]?.trigger).toBe('microcompact');
  });

  it('survives an event carrying no compact_metadata at all', () => {
    // Same reasoning as the api_retry branch's field defaulting: the event's PRESENCE is the
    // signal. A reworded or missing payload must not make the compaction itself invisible.
    const c = createStreamJsonCollector();
    c.onChunk(line({ type: 'system', subtype: 'compact_boundary' }));
    expect(c.getCompactions()).toEqual([
      {
        trigger: null,
        preTokens: null,
        postTokens: null,
        cumulativeDroppedTokens: null,
        durationMs: null,
      },
    ]);
  });

  it('ignores a non-numeric token figure instead of storing it', () => {
    const c = createStreamJsonCollector();
    c.onChunk(boundary({ trigger: 'auto', pre_tokens: 'lots', post_tokens: null }));
    expect(c.getCompactions()[0]).toEqual({
      trigger: 'auto',
      preTokens: null,
      postTokens: null,
      cumulativeDroppedTokens: null,
      durationMs: null,
    });
  });

  it('is empty for a run that never compacted', () => {
    // The normal case, and why the column is NULL rather than defaulted: "did not compact"
    // must stay distinguishable from "was never measured".
    const c = createStreamJsonCollector();
    c.onChunk(line({ type: 'system', subtype: 'init', model: 'claude-opus-5' }));
    c.onChunk(line({ type: 'result', subtype: 'success', result: 'done' }));
    expect(c.getCompactions()).toEqual([]);
  });

  it('sees a boundary event that arrives without a trailing newline', () => {
    // The getter flushes the line buffer, as getTokenUsage/getModelIdentity do. A stream cut
    // off mid-line right after a compaction is precisely the run worth recording one for.
    const c = createStreamJsonCollector();
    c.onChunk(JSON.stringify({ type: 'system', subtype: 'compact_boundary' }));
    expect(c.getCompactions()).toHaveLength(1);
  });

  it('does not disturb the retry latch', () => {
    // processLine's `else if (retryPending)` treats any non-retry event as the recovery
    // signal. A compact_boundary is the binary talking, so it must clear a pending retry —
    // the same rule the system/thinking_tokens line follows.
    let resolved = 0;
    const c = createStreamJsonCollector(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => {
        resolved++;
      },
    );
    c.onChunk(line({ type: 'system', subtype: 'api_retry', attempt: 1 }));
    c.onChunk(boundary({ trigger: 'auto', pre_tokens: 10 }));
    expect(resolved).toBe(1);
  });
});
