import { describe, expect, it } from 'vitest';
import { updateSchema } from '../src/routes/global-kb.js';

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
