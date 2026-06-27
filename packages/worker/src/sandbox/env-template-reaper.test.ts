import { describe, it, expect } from 'vitest';
import { selectOrphanEnvTemplates } from './env-template-reaper.js';

describe('selectOrphanEnvTemplates', () => {
  it('returns only candidates not referenced by a live task', () => {
    const candidates = [
      { id: 'a', imageRef: 'haive-env-task-a:latest' },
      { id: 'b', imageRef: null },
      { id: 'c', imageRef: 'sha256:cc' },
    ];
    const live = new Set(['b']); // b's env-replicate prelude is still mid-build
    const orphans = selectOrphanEnvTemplates(candidates, live);
    expect(orphans.map((o) => o.id)).toEqual(['a', 'c']);
  });

  it('returns all candidates when none is live', () => {
    const candidates = [
      { id: 'a', imageRef: null },
      { id: 'b', imageRef: 'x' },
    ];
    expect(selectOrphanEnvTemplates(candidates, new Set()).map((o) => o.id)).toEqual(['a', 'b']);
  });

  it('returns none when every candidate is live', () => {
    const candidates = [
      { id: 'a', imageRef: null },
      { id: 'b', imageRef: 'x' },
    ];
    expect(selectOrphanEnvTemplates(candidates, new Set(['a', 'b']))).toEqual([]);
  });

  it('preserves imageRef on returned orphans (used for image removal)', () => {
    const orphans = selectOrphanEnvTemplates([{ id: 'a', imageRef: 'sha256:aa' }], new Set());
    expect(orphans).toEqual([{ id: 'a', imageRef: 'sha256:aa' }]);
  });
});
