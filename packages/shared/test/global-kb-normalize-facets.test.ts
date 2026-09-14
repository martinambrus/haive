import { describe, expect, it } from 'vitest';
import { canonicalFacetValueSql, normalizeFacets } from '../src/global-kb/schema.js';
import { extractProjectFacets } from '../src/global-kb/facets.js';

// The two filters compare differently and only the write can reconcile them: facetsMatchProject
// lowercases both sides in JS, buildFacetClause uses jsonb `?|`, which is exact. MEASURED in
// postgres: '{"framework":["Drupal"]}'::jsonb->'framework' ?| array['drupal'] is FALSE, while a
// project's own set is already lowercased by extractProjectFacets — so a capitalised entry is
// advertised by the digest and then filtered out of the rag_search it promises to agree with.
describe('normalizeFacets', () => {
  it('lowercases and trims, so jsonb ?| can match a lowercased project set', () => {
    expect(normalizeFacets({ framework: ['  Drupal '], database: ['PostgreSQL'] })).toEqual({
      framework: ['drupal'],
      // `postgres`, not `postgresql`: lowercasing alone leaves a VOCABULARY mismatch, because
      // `01-env-detect.ts` canonicalises PostgreSQL to `postgres` and a project therefore never
      // reports the longer spelling. An entry stored as `postgresql` overlaps nothing.
      database: ['postgres'],
    });
  });

  it('collapses a vocabulary alias into the token a project actually reports', () => {
    // Both spellings of one technology must not survive as two values.
    expect(normalizeFacets({ database: ['PostgreSQL', 'postgres'] })).toEqual({
      database: ['postgres'],
    });
    // Dimensions with no alias table are untouched.
    expect(normalizeFacets({ framework: ['postgresql'] })).toEqual({ framework: ['postgresql'] });
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

// The other half of the same invariant: entries are normalised on write, so a PROJECT whose
// detected framework or packages carry capitals would match facetsMatchProject (which lowercases
// in JS) and then be filtered out by buildFacetClause (jsonb `?|`, exact).
describe('extractProjectFacets normalisation', () => {
  it('lowercases the dimensions that were pushed verbatim', () => {
    const facets = extractProjectFacets({
      data: {
        project: {
          framework: 'Drupal',
          primaryLanguage: 'PHP',
          packages: ['Drupal/Paragraphs', 'drupal/paragraphs'],
        },
      },
    });
    expect(facets.framework).toEqual(['drupal']);
    expect(facets.language).toEqual(['php']);
    expect(facets.packages).toEqual(['drupal/paragraphs']);
  });

  it('agrees with normalizeFacets, so both sides of a comparison match', () => {
    const project = extractProjectFacets({ data: { project: { framework: 'Drupal' } } });
    const entry = normalizeFacets({ framework: ['Drupal'] });
    expect(entry.framework).toEqual(project.framework);
  });
});

// One definition, two engines — the shape `identifierTsvSql` established. A hand-written SQL
// copy of this rule is exactly what drifted: the backfill lowercased and did neither the trim
// nor the alias, so legacy rows were rewritten into tokens no project reports.
describe('canonicalFacetValueSql', () => {
  it('trims and lowercases before folding an alias, in that order', () => {
    const sql = canonicalFacetValueSql('kv.key', 'v');
    expect(sql).toContain('lower(btrim(v))');
    expect(sql).toContain("WHEN kv.key = 'database' AND lower(btrim(v)) = 'postgresql'");
    expect(sql).toContain("THEN 'postgres'");
  });

  it('agrees with the JS rule on every alias it declares', () => {
    // The SQL is generated from the same table, so the pairing is asserted rather than assumed.
    expect(normalizeFacets({ database: ['  PostgreSQL '] })).toEqual({ database: ['postgres'] });
    expect(canonicalFacetValueSql('k', 'v')).toContain("'postgres'");
  });
});
