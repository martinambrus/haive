import { describe, expect, it } from 'vitest';
import { parsePlanPatch } from '../src/step-engine/steps/plan/_plan-prompt.js';

/**
 * An agent that spots a mistake in its own draft corrects it by emitting a
 * SECOND block. Shape taken from a real build, where the first block's
 * hallucinated uuid failed the one-transaction apply and silently took 12
 * legitimate nodes with it.
 */
const SELF_CORRECTED = [
  'Here is the decomposition:',
  '',
  '```json',
  JSON.stringify({
    summary: 'draft',
    ops: [
      { op: 'upsert', nodeRef: 'a', parentRef: 'p', title: 'Format' },
      {
        op: 'link',
        fromRef: 'a',
        toRef: '32315520-fa64-4c11-afeb-7691f7b3b0a1',
        kind: 'depends_on',
      },
    ],
  }),
  '```',
  '',
  "Correction — the accounts node's uuid is `32315520-fa64-4c11-afeb-7961d67c1a5b`;",
  'my draft above contains placeholder link churn that should not be applied.',
  'Use this reply instead:',
  '',
  '```json',
  JSON.stringify({
    summary: 'corrected',
    ops: [
      { op: 'upsert', nodeRef: 'a', parentRef: 'p', title: 'Format' },
      {
        op: 'link',
        fromRef: 'a',
        toRef: '32315520-fa64-4c11-afeb-7961d67c1a5b',
        kind: 'depends_on',
      },
    ],
  }),
  '```',
].join('\n');

describe('parsePlanPatch and a self-correcting agent', () => {
  it('takes the corrected block, not the retracted draft', () => {
    const out = parsePlanPatch(SELF_CORRECTED);
    expect(out?.summary).toBe('corrected');
    const refs = JSON.stringify(out?.ops);
    expect(refs).toContain('7961d67c1a5b');
    expect(refs).not.toContain('7691f7b3b0a1');
  });

  it('still reads an ordinary single-block reply', () => {
    const out = parsePlanPatch('```json\n{"summary":"one","ops":[]}\n```');
    expect(out?.summary).toBe('one');
    expect(out?.ops).toEqual([]);
  });

  it('still reads a reply that spoke without ops', () => {
    // The conversational case: a chat answer that changed nothing.
    const out = parsePlanPatch('```json\n{"reply":"I would split this in two. Shall I?"}\n```');
    expect(out?.reply).toContain('split this in two');
    expect(out?.ops).toEqual([]);
  });

  it('ignores JSON the agent quoted rather than authored', () => {
    // A decoy that is not patch-shaped must not outrank the real answer.
    const raw = [
      'The config I read was:',
      '```json',
      '{"name":"vareska","version":"1.0.0"}',
      '```',
      'and here is my patch:',
      '```json',
      '{"summary":"real","ops":[{"op":"upsert","nodeRef":"x","title":"X"}]}',
      '```',
    ].join('\n');
    expect(parsePlanPatch(raw)?.summary).toBe('real');
  });

  it('still salvages a malformed lone block', () => {
    // The jsonrepair tier is load-bearing and easy to lose in a rewrite.
    const out = parsePlanPatch('```json\n{"summary":"torn","ops":[{"op":"upsert","nodeRef":"a"\n');
    expect(out?.summary).toBe('torn');
  });

  it('is null for a reply carrying no patch at all', () => {
    expect(parsePlanPatch('I could not read the repository.')).toBeNull();
  });
});
