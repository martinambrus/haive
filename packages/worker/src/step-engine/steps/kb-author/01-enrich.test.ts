import { describe, expect, it } from 'vitest';
import { parseEnrichment, normCategory, cleanFacets, resolveWriteTarget } from './01-enrich.js';

describe('parseEnrichment', () => {
  it('parses a fenced json block out of CLI text', () => {
    const text =
      'sure, here you go:\n```json\n{"mode":"new","title":"T","category":"tech_pattern","body":"# T"}\n```\nthanks';
    const r = parseEnrichment(text);
    expect(r?.mode).toBe('new');
    expect(r?.title).toBe('T');
    expect(r?.body).toBe('# T');
  });

  it('accepts an already-structured object (the bypass stub)', () => {
    const r = parseEnrichment({
      mode: 'new',
      title: 'X',
      category: 'general',
      facets: {},
      body: '# X',
    });
    expect(r?.body).toBe('# X');
  });

  it('returns null for unparseable input', () => {
    expect(parseEnrichment('no json here')).toBeNull();
    expect(parseEnrichment(42)).toBeNull();
  });
});

describe('normCategory', () => {
  it('keeps a valid category', () => {
    expect(normCategory('anti_pattern')).toBe('anti_pattern');
  });

  it('falls back to general for unknown or missing', () => {
    expect(normCategory('made_up')).toBe('general');
    expect(normCategory(undefined)).toBe('general');
  });
});

describe('cleanFacets', () => {
  it('keeps known dimensions, dedupes and drops empties', () => {
    const out = cleanFacets({ framework: ['drupal', 'drupal', ''], frameworkMajor: ['11'] });
    expect(out.framework).toEqual(['drupal']);
    expect(out.frameworkMajor).toEqual(['11']);
  });

  it('returns {} for empty or undefined', () => {
    expect(cleanFacets(undefined)).toEqual({});
    expect(cleanFacets({ framework: [] })).toEqual({});
  });
});

describe('resolveWriteTarget', () => {
  const ids = new Set(['a', 'b']);

  it('updates when the model returns a known targetId', () => {
    expect(resolveWriteTarget({ mode: 'update', targetId: 'b' }, 'skel', ids)).toEqual({
      isUpdate: true,
      targetId: 'b',
    });
  });

  it('falls back to inserting the skeleton when targetId is unknown', () => {
    expect(resolveWriteTarget({ mode: 'update', targetId: 'zzz' }, 'skel', ids)).toEqual({
      isUpdate: false,
      targetId: 'skel',
    });
  });

  it('inserts on mode new', () => {
    expect(resolveWriteTarget({ mode: 'new' }, 'skel', ids)).toEqual({
      isUpdate: false,
      targetId: 'skel',
    });
  });

  it('inserts when there is no parsed output', () => {
    expect(resolveWriteTarget(null, 'skel', ids)).toEqual({ isUpdate: false, targetId: 'skel' });
  });
});
