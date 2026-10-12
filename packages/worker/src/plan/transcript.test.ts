import { describe, expect, it } from 'vitest';
import { recentTurns } from './transcript.js';

const turns = (n: number, size: number) =>
  Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    body: `${i}:${'z'.repeat(size)}`,
  }));

describe('recentTurns', () => {
  it('keeps the newest whole turns that fit and counts the rest', () => {
    const text = recentTurns(turns(10, 1_000), 3_500);
    expect(text.startsWith('(7 earlier turns of this conversation are not shown)')).toBe(true);
    expect(text).toContain('User: 8:');
    expect(text).not.toContain('6:');
  });

  it('keeps the newest turn even when it alone is over the budget', () => {
    const text = recentTurns(turns(3, 5_000), 1_000);
    expect(text).toContain('User: 2:');
    expect(text).toContain('(2 earlier turns');
  });

  it('shows a short conversation whole', () => {
    expect(recentTurns(turns(2, 10), 1_000)).not.toContain('not shown');
  });
});
