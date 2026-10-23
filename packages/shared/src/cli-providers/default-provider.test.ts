import { describe, expect, it } from 'vitest';
import { orderByDefaultPriority, resolveDefaultCliProvider } from './default-provider.js';

interface P {
  id: string;
  enabled: boolean;
  createdAt: Date;
}

const p = (id: string, iso: string, enabled = true): P => ({
  id,
  enabled,
  createdAt: new Date(iso),
});

const permutations = <T>(items: readonly T[]): T[][] =>
  items.length <= 1
    ? [[...items]]
    : items.flatMap((item, i) =>
        permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
      );

describe('default provider priority', () => {
  const oldest = p('m', '2026-01-01T00:00:00Z');
  const middle = p('z', '2026-02-01T00:00:00Z');
  const newest = p('a', '2026-03-01T00:00:00Z');

  it('puts the oldest provider first for every input order', () => {
    for (const order of permutations([oldest, middle, newest])) {
      expect(orderByDefaultPriority(order).map((x) => x.id)).toEqual(['m', 'z', 'a']);
      expect(resolveDefaultCliProvider(order)?.id).toBe('m');
    }
  });

  it('breaks a createdAt tie by the lowest id, whatever the input order', () => {
    const low = p('aaa', '2026-01-01T00:00:00Z');
    const high = p('bbb', '2026-01-01T00:00:00Z');
    expect(resolveDefaultCliProvider([high, low])?.id).toBe('aaa');
    expect(resolveDefaultCliProvider([low, high])?.id).toBe('aaa');
    expect(orderByDefaultPriority([high, low]).map((x) => x.id)).toEqual(['aaa', 'bbb']);
  });

  it('never picks a disabled provider, even the oldest', () => {
    const off = p('off', '2025-01-01T00:00:00Z', false);
    for (const order of permutations([off, oldest, newest])) {
      expect(resolveDefaultCliProvider(order)?.id).toBe('m');
      expect(orderByDefaultPriority(order).map((x) => x.id)).toEqual(['m', 'a']);
    }
  });

  it('answers null when nothing is enabled or the list is empty', () => {
    expect(resolveDefaultCliProvider([])).toBeNull();
    expect(resolveDefaultCliProvider([p('x', '2026-01-01T00:00:00Z', false)])).toBeNull();
    expect(orderByDefaultPriority([])).toEqual([]);
  });

  it('does not mutate its input and returns the same object references', () => {
    const input = [newest, oldest, middle];
    const snapshot = [...input];
    const ordered = orderByDefaultPriority(input);
    expect(input).toEqual(snapshot);
    expect(input[0]).toBe(newest);
    expect(ordered).not.toBe(input);
    expect(ordered[0]).toBe(oldest);
    expect(ordered[1]).toBe(middle);
    expect(ordered[2]).toBe(newest);
    expect(resolveDefaultCliProvider(input)).toBe(oldest);
  });
});
