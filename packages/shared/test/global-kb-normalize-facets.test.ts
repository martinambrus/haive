import { describe, expect, it } from 'vitest';
import { normalizeFacets } from '../src/global-kb/schema.js';

// The two filters compare differently and only the write can reconcile them: facetsMatchProject
// lowercases both sides in JS, buildFacetClause uses jsonb `?|`, which is exact. MEASURED in
// postgres: '{"framework":["Drupal"]}'::jsonb->'framework' ?| array['drupal'] is FALSE, while a
// project's own set is already lowercased by extractProjectFacets — so a capitalised entry is
// advertised by the digest and then filtered out of the rag_search it promises to agree with.
describe('normalizeFacets', () => {
  it('lowercases and trims, so jsonb ?| can match a lowercased project set', () => {
    expect(normalizeFacets({ framework: ['  Drupal '], database: ['PostgreSQL'] })).toEqual({
      framework: ['drupal'],
      database: ['postgresql'],
    });
  });

  it('dedupes values that differed only by case or padding', () => {
    expect(normalizeFacets({ language: ['PHP', 'php', ' Php '] })).toEqual({ language: ['php'] });
  });

  it('drops empties rather than storing a dimension that constrains nothing', () => {
    // An empty array and an absent dimension must stay indistinguishable: a NAMED dimension
    // restricts, so storing [] would be a constraint nothing can satisfy.
    expect(normalizeFacets({ framework: [], language: ['', '   '] })).toEqual({});
  });

  it('ignores unknown dimensions and non-string values', () => {
    const input = { framework: ['drupal'], nonsense: ['x'], tags: [1, 'Perf'] } as never;
    expect(normalizeFacets(input)).toEqual({ framework: ['drupal'], tags: ['perf'] });
  });

  it('is a no-op on null or undefined', () => {
    expect(normalizeFacets(null)).toEqual({});
    expect(normalizeFacets(undefined)).toEqual({});
  });
});
