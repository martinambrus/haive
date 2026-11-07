import { describe, expect, it } from 'vitest';
import { egressFor } from '../src/lib/probe-egress.js';

describe('egressFor', () => {
  it('gives an admin the global fetch and no socket', () => {
    expect(egressFor('admin')).toEqual({ fetchFn: fetch, pgSocket: undefined });
  });

  it.each(['user', undefined])('guards role %s', (role) => {
    const { fetchFn, pgSocket } = egressFor(role);
    expect(fetchFn).not.toBe(fetch);
    expect(typeof pgSocket).toBe('function');
  });
});
