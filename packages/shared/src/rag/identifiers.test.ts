import { describe, it, expect } from 'vitest';
import {
  IDENTIFIER_TSV_SENTINEL,
  extractIdentifiers,
  identifierTsQuery,
  identifierTsvSql,
} from './identifiers.js';

const sorted = (text: string): string[] => [...extractIdentifiers(text)].sort();

describe('extractIdentifiers', () => {
  it('keeps snake_case, camelCase and dotted names', () => {
    expect(sorted('user_has_monter_role CNotificationEmail d_product.inc')).toEqual([
      'cnotificationemail',
      'd_product',
      'd_product.inc',
      'user_has_monter_role',
    ]);
  });

  it('emits the segments of a dotted token as well as the whole token', () => {
    // The pattern matches greedily, so without this `pdf_generator` is never
    // emitted from `pdf_generator.class.inc` — MEASURED, that alone made the
    // feature miss the case it exists for.
    expect(sorted('require pdf_generator.class.inc;')).toEqual([
      'pdf_generator',
      'pdf_generator.class.inc',
    ]);
  });

  it('drops segments that are not identifiers in their own right', () => {
    // `class` and `inc` carry no underscore, dot or hump — they are prose, and
    // the english half already indexes them.
    expect(extractIdentifiers('pdf_generator.class.inc')).not.toContain('class');
    expect(extractIdentifiers('pdf_generator.class.inc')).not.toContain('inc');
  });

  it('ignores plain prose', () => {
    expect(extractIdentifiers('major functional areas of the module')).toEqual([]);
  });

  it('lowercases and dedupes', () => {
    expect(extractIdentifiers('CProduct cproduct CProduct')).toEqual(['cproduct']);
  });

  it('applies the length bounds', () => {
    expect(extractIdentifiers('a_b')).toEqual(['a_b']);
    expect(extractIdentifiers('a.b')).toEqual(['a.b']);
    expect(extractIdentifiers(`${'x'.repeat(70)}_y`)).toEqual([]);
  });

  it('never emits the backfill sentinel from ordinary text', () => {
    // The backfill predicate depends on this: if a chunk's own content could
    // stamp the sentinel, indexing Haive's own source would mark rows as
    // upgraded when they are not, and a later version bump would skip exactly
    // those rows.
    expect(extractIdentifiers(IDENTIFIER_TSV_SENTINEL)).toEqual([]);
    expect(extractIdentifiers(`const x = '${IDENTIFIER_TSV_SENTINEL}';`)).toEqual([]);
  });
});

describe('identifierTsQuery', () => {
  it('returns null when there is nothing to match', () => {
    expect(identifierTsQuery([])).toBeNull();
  });

  it('ORs the terms as literal lexemes', () => {
    // Literal lexemes, never to_tsquery: the parser would re-split them.
    expect(identifierTsQuery(['pdf_generator', 'd_product.inc'])).toBe(
      "'pdf_generator' | 'd_product.inc'",
    );
  });

  it('escapes a quote in a term', () => {
    expect(identifierTsQuery(["it's"])).toBe("'it''s'");
  });
});

describe('identifierTsvSql', () => {
  it('embeds the pattern with single backslashes', () => {
    // Doubling them makes the Postgres regex read `\\.` as "a literal backslash,
    // then any character", which silently stops dotted tokens matching.
    const sql = identifierTsvSql('content');
    expect(sql).toContain('(?:\\.[A-Za-z0-9_]+)*');
    expect(sql).not.toContain('\\\\.');
  });

  it('interpolates the source expression into both halves of the union', () => {
    const sql = identifierTsvSql("COALESCE(NEW.content, '')");
    expect(sql.match(/COALESCE\(NEW\.content, ''\)/g)).toHaveLength(2);
  });
});
