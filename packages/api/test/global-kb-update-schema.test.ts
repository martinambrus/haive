import { readFileSync } from 'node:fs';
import { FACET_DIMENSIONS, FACET_MAJOR_PARENTS } from '@haive/shared/global-kb';
import { describe, expect, it } from 'vitest';
import {
  enrichSchema,
  rescopedTopicKey,
  scopeChanged,
  updateSchema,
} from '../src/routes/global-kb.js';

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

// The editor's dimension list and the schema's are two hand-maintained lists that must agree,
// and nothing forced them to. Drift one way is a missing field in the editor; drift the other
// reproduces the bug this branch opened with — a dimension web can send that `.strict()` rejects
// with a silent 400. Compared as TEXT because web must not import @haive/shared.
describe('the editor offers exactly the dimensions the schema accepts', () => {
  it('matches FACET_DIMENSIONS, in the same set', () => {
    const webSrc = readFileSync(
      new URL('../../web/src/lib/api-client.ts', import.meta.url),
      'utf8',
    );
    const block = webSrc.match(/export const GLOBAL_KB_FACET_DIMENSIONS[\s\S]*?\n\];/)?.[0];
    // An extraction that finds nothing must FAIL, never pass quietly: a reformat that breaks the
    // match would otherwise turn this guard off while still reporting green.
    expect(
      block,
      'could not locate GLOBAL_KB_FACET_DIMENSIONS in web/src/lib/api-client.ts',
    ).toBeTruthy();
    const webKeys = [...block!.matchAll(/key: '([A-Za-z]+)'/g)].map((m) => m[1]);
    expect(webKeys.length).toBeGreaterThan(0);
    expect([...webKeys].sort()).toEqual([...FACET_DIMENSIONS].sort());
  });
});

// The scope editor changes what an entry APPLIES TO, and `topic_key` is derived from exactly
// that. Leaving it stale groups a re-scoped entry with its former stack's promotions in
// `promoteToGlobalKbDraft`'s exact-equality candidate lookup, and hides it from its new one.
describe('rescopedTopicKey', () => {
  const promoted = {
    facets: { framework: ['drupal'], frameworkMajor: ['7'] },
    category: 'best_practice' as const,
    topicKey: 'best_practice:drupal:7',
  };

  it('recomputes when the key-driving facets change', () => {
    expect(rescopedTopicKey(promoted, { facets: { framework: ['laravel'] } })).toBe(
      'best_practice:laravel',
    );
  });

  // A category edit changes nothing the tech half is derived from, so the suffix is carried
  // across rather than re-derived — re-deriving loses what the key holds and the facets do not.
  it('swaps the category prefix and keeps the tech suffix', () => {
    expect(rescopedTopicKey(promoted, { category: 'anti_pattern' })).toBe('anti_pattern:drupal:7');
  });

  // MEASURED on the live store: `quick_reference:postgres:17` sits on facets carrying `database`
  // but no `dbMajor`, so re-deriving on a category edit would silently drop the major.
  it('keeps a major segment the facets can no longer produce', () => {
    const drifted = {
      facets: { database: ['postgres'] },
      category: 'quick_reference' as const,
      topicKey: 'quick_reference:postgres:17',
    };
    expect(rescopedTopicKey(drifted, { category: 'anti_pattern' })).toBe(
      'anti_pattern:postgres:17',
    );
  });

  // The tech came from a promotion's free-form `tech`, which nothing persists. Re-deriving would
  // clear the key on an edit that did not touch the technology at all.
  it('keeps a fallback-derived tech across a category edit', () => {
    const fallback = {
      facets: {},
      category: 'best_practice' as const,
      topicKey: 'best_practice:redis',
    };
    expect(rescopedTopicKey(fallback, { category: 'anti_pattern' })).toBe('anti_pattern:redis');
  });

  // A facet re-scope DOES change the technology, so there the key is re-derived in full.
  it('re-derives rather than preserving when the facets changed too', () => {
    expect(
      rescopedTopicKey(promoted, { category: 'anti_pattern', facets: { framework: ['laravel'] } }),
    ).toBe('anti_pattern:laravel');
  });

  // Enrich derives this same value as an advisory-lock key and deliberately never stores it, so
  // a hand-authored entry has none. Writing one here would opt it into the promote dedup.
  it('leaves an entry that has no key alone', () => {
    expect(
      rescopedTopicKey({ ...promoted, topicKey: null }, { facets: { framework: ['x'] } }),
    ).toBe(undefined);
  });

  // `tags` is not in FACET_FILTER_DIMENSIONS and does not drive the key. The stored key may have
  // come from a promotion's free-form `tech`, which nothing persists — so recomputing on an edit
  // that changed nothing key-driving would silently null a valid key.
  it('leaves the key alone on a tags-only edit', () => {
    const fallbackKeyed = {
      facets: {},
      category: 'best_practice' as const,
      topicKey: 'best_practice:php',
    };
    expect(rescopedTopicKey(fallbackKeyed, { facets: { tags: ['caching'] } })).toBe(undefined);
  });

  it('leaves the key alone when a facet edit is a no-op', () => {
    expect(
      rescopedTopicKey(promoted, { facets: { framework: ['drupal'], frameworkMajor: ['7'] } }),
    ).toBe(undefined);
  });

  // A real re-scope that leaves no derivable tech CLEARS the key rather than keeping a wrong
  // one. Null is what `globalKbTopicKey` already means by "never deduped".
  it('clears the key when the new scope yields no tech', () => {
    expect(rescopedTopicKey(promoted, { facets: { tags: ['caching'] } })).toBeNull();
  });

  // The recompute runs through `normalizeFacets`, so the key and the row it describes agree.
  it('keys on the canonical spelling of an aliased value', () => {
    const pg = {
      facets: { database: ['mysql'] },
      category: 'best_practice' as const,
      topicKey: 'best_practice:mysql',
    };
    expect(rescopedTopicKey(pg, { facets: { database: ['PostgreSQL'] } })).toBe(
      'best_practice:postgres',
    );
  });
});

// The pairing is spelled twice — `FACET_MAJOR_PARENTS` in shared and a `parent:` field on web's
// mirrored dimension list — because web must not import @haive/shared. Same reason, and same
// failure mode, as the dimension-set parity above: drift means the form stops warning about a
// scope the api still refuses.
describe('web mirrors the major/parent pairing', () => {
  it('declares the same parents as FACET_MAJOR_PARENTS', () => {
    const webSrc = readFileSync(
      new URL('../../web/src/lib/api-client.ts', import.meta.url),
      'utf8',
    );
    const block = webSrc.match(/export const GLOBAL_KB_FACET_DIMENSIONS[\s\S]*?\n\];/)?.[0];
    expect(
      block,
      'could not locate GLOBAL_KB_FACET_DIMENSIONS in web/src/lib/api-client.ts',
    ).toBeTruthy();
    const webPairs = [...block!.matchAll(/key: '([A-Za-z]+)'[^}]*parent: '([A-Za-z]+)'/g)].map(
      (m) => [m[1], m[2]],
    );
    expect(webPairs.length).toBeGreaterThan(0);
    expect(Object.fromEntries(webPairs)).toEqual({ ...FACET_MAJOR_PARENTS });
  });
});

// The relational rule is enforced by the ROUTE (`assertFacetsNameTheirTechnology`), not by zod
// — `.strict()` only knows the dimension set. So this block asserts the schema still ADMITS the
// well-formed shapes; the refusal itself is covered by `orphanFacetMajors` in the shared suite
// and verified end to end against the running api.
describe('the facet schema admits a major beside its technology', () => {
  it('still accepts a major beside its parent', () => {
    expect(
      updateSchema.safeParse({ facets: { framework: ['drupal'], frameworkMajor: ['11'] } }).success,
    ).toBe(true);
  });

  it('accepts phpMajor and nodeMajor standing alone', () => {
    expect(updateSchema.safeParse({ facets: { phpMajor: ['8'], nodeMajor: ['22'] } }).success).toBe(
      true,
    );
  });
});
