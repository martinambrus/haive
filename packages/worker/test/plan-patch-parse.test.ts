import { describe, expect, it } from 'vitest';
import { parsePlanPatch } from '../src/step-engine/steps/plan/_plan-prompt.js';

describe('parsePlanPatch', () => {
  it('reads a patch that changes things', () => {
    const out = parsePlanPatch(
      '```json\n{"summary":"s","ops":[{"op":"delete","nodeRef":"n"}]}\n```',
    );
    expect(out?.ops).toHaveLength(1);
    expect(out?.summary).toBe('s');
  });

  it('reads a reply that omits ops entirely', () => {
    // Measured on a live chat: the agent answered a question with summary +
    // reply and no ops key at all, and the whole answer was discarded.
    const out = parsePlanPatch(
      '```json\n{"summary":"answered; no changes","reply":"Yes — split it into three."}\n```',
    );
    expect(out).not.toBeNull();
    expect(out?.ops).toEqual([]);
    expect(out?.reply).toBe('Yes — split it into three.');
  });

  it('reads an explicit empty ops array', () => {
    const out = parsePlanPatch('{"summary":"nothing to do","ops":[]}');
    expect(out?.ops).toEqual([]);
  });

  it('refuses an object that neither spoke nor carried ops', () => {
    // The build steps read null as "nothing patch-shaped" and re-roll; treating
    // this as an empty pass would record a wave that said nothing.
    expect(parsePlanPatch('{"foo":1}')).toBeNull();
    expect(parsePlanPatch('{}')).toBeNull();
  });

  it('refuses ops of the wrong shape even when it spoke', () => {
    expect(parsePlanPatch('{"summary":"s","ops":"nope"}')).toBeNull();
  });

  it('refuses a reply with no JSON in it at all', () => {
    expect(parsePlanPatch('I would split this into three. Shall I?')).toBeNull();
  });
});
