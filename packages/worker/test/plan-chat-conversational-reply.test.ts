import { describe, expect, it } from 'vitest';
import { conversationalReply } from '../src/step-engine/steps/plan/_plan-prompt.js';

describe('conversationalReply', () => {
  it('keeps a prose answer that carried no patch', () => {
    // The real case: the agent proposed three children and asked before
    // writing them. Recording an error there threw the answer away.
    const raw = 'I would split this into three children. Shall I write them?';
    expect(conversationalReply(raw)).toBe(raw);
  });

  it('keeps the prose that surrounds an unusable block', () => {
    const raw = 'Here is what I would do:\n\n```json\n{ not: valid\n```\n\nShall I?';
    expect(conversationalReply(raw)).toBe('Here is what I would do:\n\nShall I?');
  });

  it('has nothing to say when the reply was only a broken block', () => {
    // Pasting a payload that failed to parse into a conversation helps nobody.
    expect(conversationalReply('```json\n{ not: valid\n```')).toBeNull();
  });

  it('has nothing to say for an empty or non-string reply', () => {
    expect(conversationalReply('')).toBeNull();
    expect(conversationalReply('   \n  ')).toBeNull();
    expect(conversationalReply(null)).toBeNull();
    expect(conversationalReply({ summary: 'x' })).toBeNull();
  });

  it('truncates a reply that ran away, rather than storing a stream', () => {
    const long = 'x'.repeat(9000);
    const out = conversationalReply(long);
    expect(out).toHaveLength(8001);
    expect(out?.endsWith('…')).toBe(true);
  });
});
