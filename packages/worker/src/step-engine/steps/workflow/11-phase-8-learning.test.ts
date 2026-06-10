import { describe, it, expect } from 'vitest';
import { parseInvestigation } from './11-phase-8-learning.js';

describe('parseInvestigation', () => {
  it('parses an investigation from a fenced object', () => {
    const raw =
      '```json\n{"entries":[],"investigation":{"title":"Null deref","root_cause":"missing guard","lesson":"guard inputs"}}\n```';
    const inv = parseInvestigation(raw);
    expect(inv).not.toBeNull();
    expect(inv!.title).toBe('Null deref');
    expect(inv!.rootCause).toBe('missing guard');
    expect(inv!.lesson).toBe('guard inputs');
  });

  it('accepts an already-parsed object', () => {
    const inv = parseInvestigation({
      investigation: { title: 'X', root_cause: 'y', lesson: 'z' },
    });
    expect(inv!.title).toBe('X');
  });

  it('returns null when there is no investigation or it lacks a root cause', () => {
    expect(parseInvestigation('```json\n{"entries":[]}\n```')).toBeNull();
    expect(
      parseInvestigation({ investigation: { title: 'X', root_cause: '', lesson: 'z' } }),
    ).toBeNull();
    expect(parseInvestigation('no json')).toBeNull();
    expect(parseInvestigation(null)).toBeNull();
  });
});
