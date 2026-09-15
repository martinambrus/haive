import { describe, expect, it } from 'vitest';
import { survivingPredecessors } from '../src/queues/global-kb-sync-queue.js';

// A retention purge that deletes an intermediate of a supersession chain must hand the rows that
// replaced it the nearest predecessor that survives, or the chain the successor lookup walks
// (A -> B -> C) breaks at the gap and archived A stops warning that C is live.
const purged = (id: string, supersedes: string | null) => ({ id, supersedes_entry_id: supersedes });

describe('survivingPredecessors', () => {
  it("hands a purged intermediate's successors its own predecessor", () => {
    expect(survivingPredecessors([purged('b', 'a')]).get('b')).toBe('a');
  });

  it('follows the chain past predecessors purged in the same sweep', () => {
    const map = survivingPredecessors([purged('b', 'a'), purged('a', 'root')]);
    expect(map.get('b')).toBe('root');
    expect(map.get('a')).toBe('root');
  });

  it('ends the chain when nothing older survives', () => {
    const map = survivingPredecessors([purged('b', 'a'), purged('a', null)]);
    expect(map.get('b')).toBeNull();
    expect(map.get('a')).toBeNull();
  });

  it('terminates on a cycle among purged rows', () => {
    const map = survivingPredecessors([purged('a', 'b'), purged('b', 'a')]);
    expect(map.get('a')).toBeNull();
    expect(map.get('b')).toBeNull();
  });
});
