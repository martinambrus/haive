import { describe, expect, it } from 'vitest';
import { compareJobIds } from '../src/queues/cli-exec/handlers.js';

describe('compareJobIds', () => {
  // BullMQ's own ids are a decimal counter, so lexical order puts job 10 before job 9 and the
  // agent lane would admit out of enqueue order.
  it('orders counter ids numerically', () => {
    expect(['10', '9', '100', '11'].sort(compareJobIds)).toEqual(['9', '10', '11', '100']);
  });

  it('orders custom slug ids lexically', () => {
    expect(['b-job', 'a-job'].sort(compareJobIds)).toEqual(['a-job', 'b-job']);
  });

  it('is a total order on a mixed set', () => {
    const sorted = ['x', '2', 'a', '10'].sort(compareJobIds);
    expect(sorted).toHaveLength(4);
    expect(sorted.indexOf('2')).toBeLessThan(sorted.indexOf('10'));
  });

  it('reports equality for identical ids', () => {
    expect(compareJobIds('7', '7')).toBe(0);
    expect(compareJobIds('a', 'a')).toBe(0);
  });
});
