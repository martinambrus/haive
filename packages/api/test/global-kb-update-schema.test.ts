import { describe, expect, it } from 'vitest';
import { enrichSchema, scopeChanged, updateSchema } from '../src/routes/global-kb.js';

// The facet schema is `.strict()`, so a dimension missing from it is a 400 on a payload every
// other layer produces and stores happily — and nothing else in the stack catches that. It
// cost the ability to edit an entry's scope at all: `database` and `dbMajor` are written by the
// enrich step, filtered on by `facetsMatchProject` and displayed by the UI, but any PATCH
// carrying one was refused as `invalid update`.
describe('global KB updateSchema facets', () => {
  it('accepts the datastore dimensions that used to be rejected', () => {
    const r = updateSchema.safeParse({ facets: { database: ['postgres'], dbMajor: ['17'] } });
    expect(r.success).toBe(true);
  });

  it('accepts every canonical dimension at once', () => {
    const r = updateSchema.safeParse({
      facets: {
        framework: ['drupal'],
        frameworkMajor: ['11'],
        language: ['php'],
        phpMajor: ['8'],
        nodeMajor: ['22'],
        database: ['mariadb'],
        dbMajor: ['10'],
        packages: ['drupal/paragraphs@8'],
        tags: ['performance'],
      },
    });
    expect(r.success).toBe(true);
  });

  it('still refuses an unknown dimension', () => {
    // Strict is deliberate: a typo'd dimension would be stored and then match nothing.
    const r = updateSchema.safeParse({ facets: { frameWorks: ['drupal'] } });
    expect(r.success).toBe(false);
  });

  it('is partial — a status-only edit needs no facets', () => {
    expect(updateSchema.safeParse({ status: 'active' }).success).toBe(true);
  });

  it('omitting a dimension is how "applies to all" is expressed', () => {
    // facetsMatchProject treats an absent dimension as universal, so an empty object is a
    // legitimate edit meaning "this rule applies everywhere".
    expect(updateSchema.safeParse({ facets: {} }).success).toBe(true);
  });
});

// The repo is where the model can SEE a rule in practice, not the subject of the article — so a
// house standard that applies everywhere must be writable without opening one. It was required,
// which is why entry b15eebfb ended up scoped to the Drupal 7 repo it was written against.
describe('global KB enrichSchema', () => {
  const base = {
    title: 'Never inline SVG',
    seedText: 'bloats the cache',
    cliProviderId: crypto.randomUUID(),
  };

  it('accepts an enrich with no repository at all', () => {
    expect(enrichSchema.safeParse(base).success).toBe(true);
  });

  it('still accepts an anchored enrich', () => {
    const r = enrichSchema.safeParse({ ...base, repositoryId: crypto.randomUUID() });
    expect(r.success).toBe(true);
  });

  it('takes the author scope, so the model is not left to infer it from a codebase', () => {
    const r = enrichSchema.safeParse({ ...base, facets: { framework: ['drupal'] } });
    expect(r.success).toBe(true);
  });

  it('still requires a CLI to run on', () => {
    expect(enrichSchema.safeParse({ title: 't', seedText: 's' }).success).toBe(false);
  });
});

// The entry schema is derived from FACET_DIMENSIONS (what an entry may CARRY), not from
// FACET_FILTER_DIMENSIONS (what RESTRICTS retrieval). The two lists differ by `tags`, so
// deriving from the filter list would start answering 400 for a facet the editor offers.
describe('facets schema vs the filter list', () => {
  it('accepts tags, which an entry may carry but which never filters', () => {
    const parsed = updateSchema.parse({ facets: { tags: ['performance'], framework: ['drupal'] } });
    expect(parsed.facets).toEqual({ tags: ['performance'], framework: ['drupal'] });
  });
});

// A scope edit invalidates a proposed supersession: the link was decided by comparing THIS
// draft's article against the entry it would replace, so re-scoping it to another technology
// and then activating would archive an entry it no longer has anything to do with.
describe('scopeChanged', () => {
  it('sees a real scope change', () => {
    expect(scopeChanged({ framework: ['drupal'] }, { database: ['postgres'] })).toBe(true);
    expect(scopeChanged({ framework: ['drupal'] }, {})).toBe(true);
  });

  it('ignores a tags-only edit, which does not scope retrieval', () => {
    expect(
      scopeChanged(
        { framework: ['drupal'], tags: ['performance'] },
        { framework: ['drupal'], tags: ['performance', 'caching'] },
      ),
    ).toBe(false);
  });

  it('ignores value order', () => {
    expect(scopeChanged({ packages: ['a', 'b'] }, { packages: ['b', 'a'] })).toBe(false);
  });

  it('normalises BOTH sides, so a legacy-cased entry is not seen as re-scoped', () => {
    // The stored side can predate normalisation while the incoming side is always normalised.
    // Compared raw, a no-op save looks like a re-scope and silently drops a valid
    // supersedesEntryId, leaving the predecessor active after activation.
    expect(scopeChanged({ framework: ['Drupal'] }, { framework: ['drupal'] })).toBe(false);
    expect(scopeChanged({ database: [' PostgreSQL '] }, { database: ['postgresql'] })).toBe(false);
  });
});
